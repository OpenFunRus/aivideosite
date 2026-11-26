from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import mimetypes
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    Query,
)
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.middleware.sessions import SessionMiddleware

from . import db
from .config import settings
from . import assistant as local_assistant
from .comfy import ComfyUIClient
from .h3_references import build_reference_prompt, validate_reference_items
from .h3_preview import (
    cleanup_job_preview, cleanup_stale_previews, find_job_preview,
    list_job_previews, preview_poster_path,
)
from .worker import JobWorker, probe_duration


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    cleanup_stale_previews()
    db.recover_interrupted_jobs()
    try:
        await asyncio.to_thread(local_assistant.sync_video_reservations, db.active_gpu_reservations())
    except local_assistant.AssistantUnavailable:
        pass
    worker = JobWorker()
    worker.start()
    app.state.worker = worker
    try:
        yield
    finally:
        worker.stop()
        worker.join(timeout=5)


app = FastAPI(
    title="AI Video Site",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    session_cookie="aivideosite",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=False,
)

app.mount(
    "/static",
    StaticFiles(directory=settings.root_dir / "app" / "static"),
    name="static",
)
templates = Jinja2Templates(directory=settings.root_dir / "app" / "templates")

MISC_PRESET_CATEGORIES = {
    "prop": "Предмет",
    "clothing_gear": "Одежда и экипировка",
    "weapon": "Оружие",
    "vehicle": "Транспорт",
    "creature": "Животное / существо",
    "environment_feature": "Элемент окружения",
    "visual_trait": "Визуальная особенность",
    "pose_action": "Поза / действие",
    "style_look": "Стиль / оформление",
    "other": "Другое",
}
MISC_CATEGORY_H3_ROLE = {
    "prop": ("object", "fully_preserved"),
    "clothing_gear": ("object", "fully_preserved"),
    "weapon": ("object", "fully_preserved"),
    "vehicle": ("object", "fully_preserved"),
    "creature": ("character", "fully_preserved"),
    "environment_feature": ("setting", "fully_preserved"),
    "visual_trait": ("style", "attribute_transfer"),
    "pose_action": ("motion", "partially_preserved"),
    "style_look": ("style", "attribute_transfer"),
    "other": ("object", "fully_preserved"),
}


def _current_user(request: Request):
    if request.session.get("authenticated") is not True:
        return None
    user_id = str(request.session.get("user_id") or "")
    return next((user for user in settings.site_users if user.id == user_id), None)


def _is_authenticated(request: Request) -> bool:
    return _current_user(request) is not None


def require_user(request: Request) -> str:
    user = _current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user.id


def _user_label(user_id: str) -> str:
    user = next((user for user in settings.site_users if user.id == user_id), None)
    return user.label if user is not None else user_id


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if _is_authenticated(request):
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"error": None},
    )


@app.post("/login", response_class=HTMLResponse)
async def login(request: Request, password: Annotated[str, Form()]):
    matched_user = None
    for user in settings.site_users:
        if hmac.compare_digest(password, user.password):
            matched_user = user
            break

    if matched_user is not None:
        request.session.clear()
        request.session["authenticated"] = True
        request.session["user_id"] = matched_user.id
        return RedirectResponse("/", status_code=303)

    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"error": "Неверный пароль"},
        status_code=401,
    )


@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/", response_class=HTMLResponse)
@app.get("/v2", response_class=HTMLResponse)
@app.get("/v2/", response_class=HTMLResponse)
async def dashboard(request: Request):
    if not _is_authenticated(request):
        return RedirectResponse("/login", status_code=303)
    user = _current_user(request)
    return templates.TemplateResponse(
        request=request,
        name="v2.html",
        context={"current_user": user},
    )


@app.get("/api/v2/status")
async def api_v2_status(user_id: str = Depends(require_user)):
    del user_id
    return {"system": get_system_status()}

@app.get("/api/v2/gpu-slots")
async def api_v2_gpu_slots(user_id: str = Depends(require_user)):
    del user_id
    try:
        return await asyncio.to_thread(local_assistant.gpu_slots)
    except local_assistant.AssistantUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/api/assistant/status")
async def api_assistant_status(user_id: str = Depends(require_user)):
    del user_id
    return await asyncio.to_thread(local_assistant.status)


@app.post("/api/assistant/chat")
async def api_assistant_chat(
    request: Request,
    user_id: str = Depends(require_user),
):
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(400, "Некорректный запрос чата.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "Некорректный запрос чата.")

    try:
        await asyncio.to_thread(local_assistant.ensure_available)
    except local_assistant.AssistantUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc

    runtime_settings, _characters, _locations, _misc = _assistant_runtime_context(
        user_id,
        payload.get("settings"),
    )
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(
        local_assistant.stream_chat(
            payload.get("messages"),
            settings=runtime_settings,
            thinking=bool(payload.get("thinking")),
        ),
        media_type="text/plain; charset=utf-8",
        headers=headers,
    )


@app.post("/api/assistant/control")
async def api_assistant_control(
    request: Request,
    user_id: str = Depends(require_user),
):
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(400, "Некорректный запрос управления.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "Некорректный запрос управления.")

    runtime_settings, characters, locations, misc = _assistant_runtime_context(
        user_id,
        payload.get("settings"),
    )
    try:
        return await asyncio.to_thread(
            local_assistant.control,
            payload.get("messages"),
            settings=runtime_settings,
            characters=characters,
            locations=locations,
            misc=misc,
            thinking=bool(payload.get("thinking")),
        )
    except local_assistant.AssistantUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/voice-presets")
async def api_voice_presets(user_id: str = Depends(require_user)):
    presets = _voice_presets_public()
    return {
        "available": any(item["available"] for item in presets),
        "presets": presets,
        "sample_text": "Привет, это мой голос.",
    }


@app.get("/voice-presets/{preset_id}.wav")
async def voice_preset_preview(
    preset_id: str,
    user_id: str = Depends(require_user),
):
    if preset_id not in VOICE_PRESETS:
        raise HTTPException(404, "Голосовой пресет не найден.")
    path = _voice_preset_path(preset_id)
    if not path.is_file():
        raise HTTPException(
            503,
            "Голосовой пресет ещё не подготовлен. Запустите scripts/setup_voice_presets.sh.",
        )
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/characters")
async def api_characters(user_id: str = Depends(require_user)):
    return {"characters": [_character_public(item) for item in db.list_characters(user_id)]}


@app.post("/api/characters")
async def api_create_character(
    name: Annotated[str, Form()],
    description: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    voice: UploadFile | None = File(None),
    voice_preset: Annotated[str, Form()] = "",
    user_id: str = Depends(require_user),
):
    name = name.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Имя персонажа должно содержать 1–80 символов.")
    if len(description) > 2000:
        raise HTTPException(400, "Описание персонажа слишком длинное.")

    voice_preset = voice_preset.strip()
    has_custom_voice = voice is not None and bool(voice.filename)
    if has_custom_voice and voice_preset:
        raise HTTPException(400, "Выберите либо встроенный голос, либо свой аудиофайл.")
    if voice_preset and voice_preset not in VOICE_PRESETS:
        raise HTTPException(400, "Неизвестный голосовой пресет.")

    uploads = [item for item in (images or []) if item.filename]
    if not uploads:
        raise HTTPException(400, "Добавьте хотя бы одно изображение персонажа.")
    if len(uploads) > 4:
        raise HTTPException(400, "Для одного персонажа можно сохранить до 4 изображений.")

    character_id = uuid.uuid4().hex
    target_dir = settings.character_dir / user_id / character_id
    target_dir.mkdir(parents=True, exist_ok=False)
    image_files: list[str] = []
    image_names: list[str] = []
    voice_file: str | None = None
    voice_name: str | None = None
    temp_paths: list[Path] = []
    try:
        for index, upload in enumerate(uploads, start=1):
            path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"image_{index}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            image_files.append(str(destination))
            image_names.append(_uploaded_reference_name(upload))

        if has_custom_voice:
            path = await save_upload(
                voice,
                kind="audio",
                max_bytes=settings.max_audio_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"voice{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            voice_file = str(destination)
            voice_name = _uploaded_reference_name(voice)
        elif voice_preset:
            preset_path = _voice_preset_path(voice_preset)
            if not preset_path.is_file():
                raise HTTPException(
                    503,
                    "Выбранный голосовой пресет ещё не подготовлен на сервере.",
                )
            destination = target_dir / "voice.wav"
            shutil.copy2(preset_path, destination)
            voice_file = str(destination)

        db.insert_character(
            character_id=character_id,
            owner_id=user_id,
            name=name,
            description=description,
            images=image_files,
            image_names=image_names,
            voice_file=voice_file,
            voice_preset_id=voice_preset or None,
            voice_name=voice_name,
        )
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        shutil.rmtree(target_dir, ignore_errors=True)
        raise

    character = db.get_character(character_id, user_id)
    return {"ok": True, "character": _character_public(character)}


@app.post("/api/characters/{character_id}")
async def api_update_character(
    character_id: str,
    name: Annotated[str, Form()],
    description: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    keep_image_indices: Annotated[str, Form()] = "",
    voice: UploadFile | None = File(None),
    voice_preset: Annotated[str, Form()] = "",
    remove_voice: Annotated[bool, Form()] = False,
    user_id: str = Depends(require_user),
):
    name = name.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Имя персонажа должно содержать 1–80 символов.")
    if len(description) > 2000:
        raise HTTPException(400, "Описание персонажа слишком длинное.")

    character = db.get_character(character_id, user_id)
    if character is None:
        raise HTTPException(404, "Персонаж не найден.")

    existing_images = list(character.get("images") or [])
    existing_image_names = list(character.get("image_names") or [])
    uploads = [item for item in (images or []) if item.filename]
    raw_keep_indices = keep_image_indices.strip()
    if raw_keep_indices:
        try:
            parsed_keep_indices = json.loads(raw_keep_indices)
        except (json.JSONDecodeError, TypeError) as exc:
            raise HTTPException(400, "Некорректный список сохранённых изображений.") from exc
        if not isinstance(parsed_keep_indices, list):
            raise HTTPException(400, "Некорректный список сохранённых изображений.")
        keep_indices: list[int] = []
        seen_indices: set[int] = set()
        for value in parsed_keep_indices:
            if type(value) is not int or value < 0 or value >= len(existing_images):
                raise HTTPException(400, "Некорректный индекс изображения персонажа.")
            if value not in seen_indices:
                seen_indices.add(value)
                keep_indices.append(value)
        keep_indices.sort()
    elif uploads:
        # New appearance uploads replace the previous reference set unless the
        # client explicitly sends keep_image_indices.
        keep_indices = []
    else:
        keep_indices = list(range(len(existing_images)))

    if len(keep_indices) + len(uploads) < 1:
        raise HTTPException(400, "У персонажа должно остаться хотя бы одно изображение.")
    if len(keep_indices) + len(uploads) > 4:
        raise HTTPException(400, "Для одного персонажа можно сохранить до 4 изображений.")

    voice_preset = voice_preset.strip()
    has_custom_voice = voice is not None and bool(voice.filename)
    if has_custom_voice and voice_preset:
        raise HTTPException(400, "Выберите либо встроенный голос, либо свой аудиофайл.")
    if remove_voice and (has_custom_voice or voice_preset):
        raise HTTPException(400, "Нельзя одновременно удалить и заменить голос.")
    if voice_preset and voice_preset not in VOICE_PRESETS:
        raise HTTPException(400, "Неизвестный голосовой пресет.")

    media_changed = (
        keep_indices != list(range(len(existing_images)))
        or bool(uploads)
        or has_custom_voice
        or bool(voice_preset)
        or remove_voice
    )
    if media_changed and character_id in db.active_character_ids(user_id):
        raise HTTPException(
            409,
            "Персонаж используется активной задачей. Референсы и голос можно менять после её завершения.",
        )

    target_dir = settings.character_dir / user_id / character_id
    target_dir.mkdir(parents=True, exist_ok=True)
    next_images = [existing_images[index] for index in keep_indices]
    next_image_names = [existing_image_names[index] for index in keep_indices]
    old_voice_file = character.get("voice_file")
    old_voice_preset_id = _character_voice_preset_id(character)
    next_voice_file = old_voice_file
    next_voice_preset_id = old_voice_preset_id
    next_voice_name = character.get("voice_name")
    created_paths: list[Path] = []
    temp_paths: list[Path] = []

    try:
        for upload in uploads:
            path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"image_{uuid.uuid4().hex[:12]}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            created_paths.append(destination)
            next_images.append(str(destination))
            next_image_names.append(_uploaded_reference_name(upload))

        if remove_voice:
            next_voice_file = None
            next_voice_preset_id = None
            next_voice_name = None
        elif has_custom_voice:
            path = await save_upload(
                voice,
                kind="audio",
                max_bytes=settings.max_audio_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"voice_{uuid.uuid4().hex[:12]}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            created_paths.append(destination)
            next_voice_file = str(destination)
            next_voice_preset_id = None
            next_voice_name = _uploaded_reference_name(voice)
        elif voice_preset:
            preset_path = _voice_preset_path(voice_preset)
            if not preset_path.is_file():
                raise HTTPException(
                    503,
                    "Выбранный голосовой пресет ещё не подготовлен на сервере.",
                )
            destination = target_dir / f"voice_{uuid.uuid4().hex[:12]}.wav"
            shutil.copy2(preset_path, destination)
            created_paths.append(destination)
            next_voice_file = str(destination)
            next_voice_preset_id = voice_preset
            next_voice_name = None

        updated = db.update_character(
            character_id,
            user_id,
            name=name,
            description=description,
            images=next_images,
            image_names=next_image_names,
            voice_file=next_voice_file,
            voice_preset_id=next_voice_preset_id,
            voice_name=next_voice_name,
        )
        if updated is None:
            raise HTTPException(404, "Персонаж не найден.")
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    kept_paths = set(next_images)
    obsolete_paths = [
        Path(old_path)
        for old_path in existing_images
        if old_path not in kept_paths
    ]
    if old_voice_file and old_voice_file != next_voice_file:
        obsolete_paths.append(Path(old_voice_file))
    for obsolete_path in obsolete_paths:
        try:
            obsolete_path.unlink(missing_ok=True)
        except OSError:
            pass

    return {"ok": True, "character": _character_public(updated)}


@app.delete("/api/characters/{character_id}")
async def api_delete_character(
    character_id: str,
    user_id: str = Depends(require_user),
):
    if character_id in db.active_character_ids(user_id):
        raise HTTPException(
            409,
            "Персонаж используется активной задачей. Дождитесь завершения или отмените задачу.",
        )
    character = db.delete_character(character_id, user_id)
    if character is None:
        raise HTTPException(404, "Персонаж не найден.")
    target_dir = settings.character_dir / user_id / character_id
    shutil.rmtree(target_dir, ignore_errors=True)
    return {"ok": True}


@app.get("/characters/{character_id}/image/{image_index}")
async def character_image(
    character_id: str,
    image_index: int,
    user_id: str = Depends(require_user),
):
    character = db.get_character(character_id, user_id)
    if character is None:
        raise HTTPException(404, "Персонаж не найден.")
    images = character.get("images") or []
    if image_index < 0 or image_index >= len(images):
        raise HTTPException(404, "Изображение не найдено.")
    path = Path(images[image_index])
    if not path.is_file():
        raise HTTPException(404, "Файл изображения не найден.")
    return FileResponse(path)


@app.get("/api/locations")
async def api_locations(user_id: str = Depends(require_user)):
    return {"locations": [_location_public(item) for item in db.list_locations(user_id)]}


@app.post("/api/locations")
async def api_create_location(
    name: Annotated[str, Form()],
    prompt: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    user_id: str = Depends(require_user),
):
    name = name.strip()
    prompt = prompt.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Название локации должно содержать 1–80 символов.")
    if len(prompt) > 4000:
        raise HTTPException(400, "Промпт локации слишком длинный.")
    uploads = [item for item in (images or []) if item.filename]
    if not uploads:
        raise HTTPException(400, "Добавьте хотя бы одно изображение локации.")
    if len(uploads) > 4:
        raise HTTPException(400, "Для одной локации можно сохранить до 4 изображений.")

    location_id = uuid.uuid4().hex
    target_dir = settings.location_dir / user_id / location_id
    target_dir.mkdir(parents=True, exist_ok=False)
    image_files: list[str] = []
    image_names: list[str] = []
    temp_paths: list[Path] = []
    try:
        for index, upload in enumerate(uploads, start=1):
            path = await save_upload(upload, kind="image", max_bytes=settings.max_image_upload_bytes)
            temp_paths.append(path)
            destination = target_dir / f"image_{index}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            image_files.append(str(destination))
            image_names.append(_uploaded_reference_name(upload))
        db.insert_location(
            location_id=location_id,
            owner_id=user_id,
            name=name,
            prompt=prompt,
            images=image_files,
            image_names=image_names,
        )
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    return {"ok": True, "location": _location_public(db.get_location(location_id, user_id))}


@app.post("/api/locations/{location_id}")
async def api_update_location(
    location_id: str,
    name: Annotated[str, Form()],
    prompt: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    keep_image_indices: Annotated[str, Form()] = "",
    user_id: str = Depends(require_user),
):
    name = name.strip()
    prompt = prompt.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Название локации должно содержать 1–80 символов.")
    if len(prompt) > 4000:
        raise HTTPException(400, "Промпт локации слишком длинный.")
    location = db.get_location(location_id, user_id)
    if location is None:
        raise HTTPException(404, "Локация не найдена.")

    existing_images = list(location.get("images") or [])
    existing_image_names = list(location.get("image_names") or [])
    raw_keep_indices = keep_image_indices.strip()
    if raw_keep_indices:
        try:
            parsed_keep_indices = json.loads(raw_keep_indices)
        except (json.JSONDecodeError, TypeError) as exc:
            raise HTTPException(400, "Некорректный список сохранённых изображений.") from exc
        if not isinstance(parsed_keep_indices, list):
            raise HTTPException(400, "Некорректный список сохранённых изображений.")
        keep_indices: list[int] = []
        seen_indices: set[int] = set()
        for value in parsed_keep_indices:
            if type(value) is not int or value < 0 or value >= len(existing_images):
                raise HTTPException(400, "Некорректный индекс изображения локации.")
            if value not in seen_indices:
                seen_indices.add(value)
                keep_indices.append(value)
        keep_indices.sort()
    else:
        keep_indices = list(range(len(existing_images)))

    uploads = [item for item in (images or []) if item.filename]
    if len(keep_indices) + len(uploads) < 1:
        raise HTTPException(400, "У локации должно остаться хотя бы одно изображение.")
    if len(keep_indices) + len(uploads) > 4:
        raise HTTPException(400, "Для одной локации можно сохранить до 4 изображений.")
    media_changed = keep_indices != list(range(len(existing_images))) or bool(uploads)
    if media_changed and location_id in db.active_location_ids(user_id):
        raise HTTPException(
            409,
            "Локация используется активной задачей. Референсы можно менять после её завершения.",
        )

    target_dir = settings.location_dir / user_id / location_id
    target_dir.mkdir(parents=True, exist_ok=True)
    next_images = [existing_images[index] for index in keep_indices]
    next_image_names = [existing_image_names[index] for index in keep_indices]
    created_paths: list[Path] = []
    temp_paths: list[Path] = []
    try:
        for upload in uploads:
            path = await save_upload(upload, kind="image", max_bytes=settings.max_image_upload_bytes)
            temp_paths.append(path)
            destination = target_dir / f"image_{uuid.uuid4().hex[:12]}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            created_paths.append(destination)
            next_images.append(str(destination))
            next_image_names.append(_uploaded_reference_name(upload))
        updated = db.update_location(
            location_id,
            user_id,
            name=name,
            prompt=prompt,
            images=next_images,
            image_names=next_image_names,
        )
        if updated is None:
            raise HTTPException(404, "Локация не найдена.")
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    kept_paths = set(next_images)
    for old_path in existing_images:
        if old_path in kept_paths:
            continue
        try:
            Path(old_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True, "location": _location_public(updated)}


@app.delete("/api/locations/{location_id}")
async def api_delete_location(location_id: str, user_id: str = Depends(require_user)):
    if location_id in db.active_location_ids(user_id):
        raise HTTPException(
            409,
            "Локация используется активной задачей. Дождитесь завершения или отмените задачу.",
        )
    location = db.delete_location(location_id, user_id)
    if location is None:
        raise HTTPException(404, "Локация не найдена.")
    shutil.rmtree(settings.location_dir / user_id / location_id, ignore_errors=True)
    return {"ok": True}


@app.get("/locations/{location_id}/image/{image_index}")
async def location_image(
    location_id: str,
    image_index: int,
    user_id: str = Depends(require_user),
):
    location = db.get_location(location_id, user_id)
    if location is None:
        raise HTTPException(404, "Локация не найдена.")
    images = location.get("images") or []
    if image_index < 0 or image_index >= len(images):
        raise HTTPException(404, "Изображение не найдено.")
    path = Path(images[image_index])
    if not path.is_file():
        raise HTTPException(404, "Файл изображения не найден.")
    return FileResponse(path)



@app.get("/api/misc")
async def api_misc(user_id: str = Depends(require_user)):
    return {
        "misc": [_misc_public(item) for item in db.list_misc_presets(user_id)],
        "categories": [
            {"id": category_id, "name": label}
            for category_id, label in MISC_PRESET_CATEGORIES.items()
        ],
    }


@app.post("/api/misc")
async def api_create_misc(
    name: Annotated[str, Form()],
    category: Annotated[str, Form()],
    description: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    user_id: str = Depends(require_user),
):
    name = name.strip()
    category = category.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Название пресета должно содержать 1–80 символов.")
    if category not in MISC_PRESET_CATEGORIES:
        raise HTTPException(400, "Неизвестная категория пресета.")
    if len(description) > 4000:
        raise HTTPException(400, "Описание пресета слишком длинное.")

    uploads = [item for item in (images or []) if item.filename]
    if not uploads:
        raise HTTPException(400, "Добавьте хотя бы одно изображение пресета.")
    if len(uploads) > 4:
        raise HTTPException(400, "Для одного пресета можно сохранить до 4 изображений.")

    misc_id = uuid.uuid4().hex
    target_dir = settings.misc_dir / user_id / misc_id
    target_dir.mkdir(parents=True, exist_ok=False)
    image_files: list[str] = []
    image_names: list[str] = []
    temp_paths: list[Path] = []
    try:
        for index, upload in enumerate(uploads, start=1):
            path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"image_{index}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            image_files.append(str(destination))
            image_names.append(_uploaded_reference_name(upload))
        db.insert_misc_preset(
            misc_id=misc_id,
            owner_id=user_id,
            name=name,
            category=category,
            description=description,
            images=image_files,
            image_names=image_names,
        )
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    return {"ok": True, "misc": _misc_public(db.get_misc_preset(misc_id, user_id))}


@app.post("/api/misc/{misc_id}")
async def api_update_misc(
    misc_id: str,
    name: Annotated[str, Form()],
    category: Annotated[str, Form()],
    description: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    keep_image_indices: Annotated[str, Form()] = "",
    user_id: str = Depends(require_user),
):
    name = name.strip()
    category = category.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Название пресета должно содержать 1–80 символов.")
    if category not in MISC_PRESET_CATEGORIES:
        raise HTTPException(400, "Неизвестная категория пресета.")
    if len(description) > 4000:
        raise HTTPException(400, "Описание пресета слишком длинное.")

    preset = db.get_misc_preset(misc_id, user_id)
    if preset is None:
        raise HTTPException(404, "Пресет не найден.")

    existing_images = list(preset.get("images") or [])
    existing_image_names = list(preset.get("image_names") or [])
    raw_keep_indices = keep_image_indices.strip()
    if raw_keep_indices:
        try:
            parsed_keep_indices = json.loads(raw_keep_indices)
        except (json.JSONDecodeError, TypeError) as exc:
            raise HTTPException(400, "Некорректный список сохранённых изображений.") from exc
        if not isinstance(parsed_keep_indices, list):
            raise HTTPException(400, "Некорректный список сохранённых изображений.")
        keep_indices: list[int] = []
        seen_indices: set[int] = set()
        for value in parsed_keep_indices:
            if type(value) is not int or value < 0 or value >= len(existing_images):
                raise HTTPException(400, "Некорректный индекс изображения пресета.")
            if value not in seen_indices:
                seen_indices.add(value)
                keep_indices.append(value)
        keep_indices.sort()
    else:
        keep_indices = list(range(len(existing_images)))

    uploads = [item for item in (images or []) if item.filename]
    if len(keep_indices) + len(uploads) < 1:
        raise HTTPException(400, "У пресета должно остаться хотя бы одно изображение.")
    if len(keep_indices) + len(uploads) > 4:
        raise HTTPException(400, "Для одного пресета можно сохранить до 4 изображений.")

    media_changed = keep_indices != list(range(len(existing_images))) or bool(uploads)
    if media_changed and misc_id in db.active_misc_ids(user_id):
        raise HTTPException(
            409,
            "Пресет используется активной задачей. Референсы можно менять после её завершения.",
        )

    target_dir = settings.misc_dir / user_id / misc_id
    target_dir.mkdir(parents=True, exist_ok=True)
    next_images = [existing_images[index] for index in keep_indices]
    next_image_names = [existing_image_names[index] for index in keep_indices]
    created_paths: list[Path] = []
    temp_paths: list[Path] = []
    try:
        for upload in uploads:
            path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            temp_paths.append(path)
            destination = target_dir / f"image_{uuid.uuid4().hex[:12]}{path.suffix.lower()}"
            shutil.move(str(path), str(destination))
            temp_paths.remove(path)
            created_paths.append(destination)
            next_images.append(str(destination))
            next_image_names.append(_uploaded_reference_name(upload))

        updated = db.update_misc_preset(
            misc_id,
            user_id,
            name=name,
            category=category,
            description=description,
            images=next_images,
            image_names=next_image_names,
        )
        if updated is None:
            raise HTTPException(404, "Пресет не найден.")
    except Exception:
        for path in temp_paths:
            path.unlink(missing_ok=True)
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    kept_paths = set(next_images)
    for old_path in existing_images:
        if old_path in kept_paths:
            continue
        try:
            Path(old_path).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True, "misc": _misc_public(updated)}


@app.delete("/api/misc/{misc_id}")
async def api_delete_misc(misc_id: str, user_id: str = Depends(require_user)):
    if misc_id in db.active_misc_ids(user_id):
        raise HTTPException(
            409,
            "Пресет используется активной задачей. Дождитесь завершения или отмените задачу.",
        )
    preset = db.delete_misc_preset(misc_id, user_id)
    if preset is None:
        raise HTTPException(404, "Пресет не найден.")
    shutil.rmtree(settings.misc_dir / user_id / misc_id, ignore_errors=True)
    return {"ok": True}


@app.get("/misc/{misc_id}/image/{image_index}")
async def misc_image(
    misc_id: str,
    image_index: int,
    user_id: str = Depends(require_user),
):
    preset = db.get_misc_preset(misc_id, user_id)
    if preset is None:
        raise HTTPException(404, "Пресет не найден.")
    images = preset.get("images") or []
    if image_index < 0 or image_index >= len(images):
        raise HTTPException(404, "Изображение не найдено.")
    path = Path(images[image_index])
    if not path.is_file():
        raise HTTPException(404, "Файл изображения не найден.")
    return FileResponse(path)


V2_RESOLUTION_SHORT_SIDE = {
    "480": 480,
    "720": 736,
    "1080": 1088,
}
V2_ASPECT_RATIOS = {
    "1:1": (1, 1),
    "16:9": (16, 9),
    "9:16": (9, 16),
}
V2_DURATIONS = {5, 10, 15}
V2_STEPS = {8, 12, 16}
V2_GPU_TARGETS = {"rtx3090", "rtx2080"}

def _v2_gpu_target(raw: object) -> str:
    target=str(raw or "").strip().lower()
    if target not in V2_GPU_TARGETS:raise HTTPException(400,"Выберите RTX3090 или RTX2080.")
    return target

def _v2_reserve_gpu(target:str,job_id:str)->None:
    try:local_assistant.reserve_video_gpu(target,job_id)
    except local_assistant.GPUUnavailable as exc:raise HTTPException(409,str(exc)) from exc
    except local_assistant.AssistantUnavailable as exc:raise HTTPException(503,str(exc)) from exc

def _v2_release_gpu(target:object,job_id:str)->None:
    local_assistant.release_video_gpu(target,job_id)


def _v2_resolution(quality: str, ratio: str) -> tuple[int, int]:
    short_side = V2_RESOLUTION_SHORT_SIDE.get(str(quality).strip())
    ratio_pair = V2_ASPECT_RATIOS.get(str(ratio).strip())
    if short_side is None:
        raise HTTPException(400, "V2 поддерживает только 480p, 720p и 1080p.")
    if ratio_pair is None:
        raise HTTPException(400, "V2 поддерживает только форматы 1:1, 16:9 и 9:16.")

    ratio_width, ratio_height = ratio_pair
    if ratio_width == ratio_height:
        return short_side, short_side

    def grid_up(value: float) -> int:
        return int(math.ceil(value / 32.0) * 32)

    if ratio_width > ratio_height:
        height = short_side
        width = grid_up(short_side * ratio_width / ratio_height)
    else:
        width = short_side
        height = grid_up(short_side * ratio_height / ratio_width)
    return width, height


def _v2_character_ids(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Некорректный список персонажей.") from exc
    if not isinstance(value, list):
        raise HTTPException(400, "Некорректный список персонажей.")

    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        character_id = str(item).strip()
        if not character_id or character_id in seen:
            continue
        seen.add(character_id)
        result.append(character_id)
    return result


def _v2_location_ids(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Некорректный список локаций.") from exc
    if not isinstance(value, list):
        raise HTTPException(400, "Некорректный список локаций.")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        location_id = str(item).strip()
        if not location_id or location_id in seen:
            continue
        seen.add(location_id)
        result.append(location_id)
    return result



def _v2_misc_ids(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Некорректный список пресетов «Прочее».") from exc
    if not isinstance(value, list):
        raise HTTPException(400, "Некорректный список пресетов «Прочее».")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        misc_id = str(item).strip()
        if not misc_id or misc_id in seen:
            continue
        seen.add(misc_id)
        result.append(misc_id)
    return result


@app.post("/api/v2/generate")
async def api_v2_generate(
    prompt: Annotated[str, Form()],
    quality: Annotated[str, Form()] = "720",
    ratio: Annotated[str, Form()] = "16:9",
    seconds: Annotated[int, Form()] = 10,
    steps: Annotated[int, Form()] = 12,
    seed: Annotated[str, Form()] = "",
    gpu_target: Annotated[str, Form()] = "",
    generate_audio: Annotated[bool, Form()] = True,
    character_ids: Annotated[str, Form()] = "[]",
    location_ids: Annotated[str, Form()] = "[]",
    misc_ids: Annotated[str, Form()] = "[]",
    muted_character_ids: Annotated[str, Form()] = "[]",
    first_frame: UploadFile | None = File(None),
    last_frame: UploadFile | None = File(None),
    user_id: str = Depends(require_user),
):
    _v2_validate_simple_settings(seconds, steps)

    compact_prompt = " ".join(prompt.split()) if "\n" not in prompt else prompt.strip()
    if not compact_prompt:
        raise HTTPException(400, "Введите prompt.")
    if len(compact_prompt) > 16000:
        raise HTTPException(400, "Prompt слишком длинный.")

    width, height = _v2_resolution(quality, ratio)
    seed_value = _v2_seed(seed)
    selected_characters = _v2_character_ids(character_ids)
    selected_locations = _v2_location_ids(location_ids)
    selected_misc = _v2_misc_ids(misc_ids)
    muted_characters = set(_v2_character_ids(muted_character_ids))
    gpu_target=_v2_gpu_target(gpu_target)
    job_id=uuid.uuid4().hex

    has_first = first_frame is not None and bool(first_frame.filename)
    has_last = last_frame is not None and bool(last_frame.filename)
    has_exact_frames = has_first or has_last
    has_semantic_references = bool(
        selected_characters or selected_locations or selected_misc
    )

    if has_semantic_references and has_exact_frames:
        generation_mode = "multiframe"
    elif has_semantic_references:
        generation_mode = "reference"
    else:
        generation_mode = "frames"

    v2_context = {
        "workspace": "create",
        "quality": str(quality),
        "ratio": str(ratio),
        "seconds": int(seconds),
        "steps": int(steps),
        "has_first_frame": bool(has_first),
        "has_last_frame": bool(has_last),
        "generation_mode": generation_mode,
        "audio_mode": False,
    }

    temporary_paths: list[Path] = []
    _v2_reserve_gpu(gpu_target,job_id)
    try:
        if has_semantic_references:
            items = _v2_character_references(
                selected_characters,
                user_id,
                include_voice=True,
                muted_character_ids=muted_characters,
                identity_only=has_exact_frames,
            )
            items.extend(_v2_location_references(selected_locations, user_id))
            items.extend(_v2_misc_references(selected_misc, user_id))

            guides: list[dict] = []
            if generation_mode == "multiframe":
                for upload, time_seconds, frame_idx, note in (
                    (first_frame, 0.0, 0, "Exact opening frame anchor."),
                    (last_frame, float(seconds), -1, "Exact ending frame anchor."),
                ):
                    if upload is None or not upload.filename:
                        continue
                    path = await save_upload(
                        upload,
                        kind="image",
                        max_bytes=settings.max_image_upload_bytes,
                    )
                    temporary_paths.append(path)
                    guides.append(
                        {
                            "path": str(path),
                            "temporary": True,
                            "source_name": Path(upload.filename or path.name).name,
                            "time_seconds": time_seconds,
                            "frame_idx": frame_idx,
                            "note": note,
                        }
                    )

            job_id = _v2_enqueue_reference_job(
                job_id=job_id,
                gpu_target=gpu_target,
                user_id=user_id,
                prompt=compact_prompt,
                width=width,
                height=height,
                seconds=seconds,
                steps=steps,
                seed=seed_value,
                generate_audio=generate_audio,
                generation_mode=generation_mode,
                reference_task=(
                    "timeline_guides"
                    if generation_mode == "multiframe"
                    else "reference_generation"
                ),
                items=items,
                guides=guides,
                v2_context=v2_context,
            )
        else:
            frame_paths: list[str] = []
            for upload in (first_frame, last_frame):
                if upload is None or not upload.filename:
                    continue
                path = await save_upload(
                    upload,
                    kind="image",
                    max_bytes=settings.max_image_upload_bytes,
                )
                temporary_paths.append(path)
                frame_paths.append(str(path))

            keyframe_role = "last" if has_last and not has_first else "first"
            db.enqueue_job(
                job_id,
                "generate",
                {
                    "prompt": compact_prompt,
                    "user_prompt": compact_prompt,
                    "width": int(width),
                    "height": int(height),
                    "seconds": float(seconds),
                    "fps": 24,
                    "steps": int(steps),
                    "seed": int(seed_value),
                    "generate_audio": bool(generate_audio),
                    "generation_mode": "frames",
                    "keyframe_role": keyframe_role,
                    "reference_task": "reference_generation",
                    "ref_image_size": "match",
                    "images": frame_paths,
                    "references": [],
                    "reference_map": [],
                    "guides": [],
                    "control": {"mode": "none"},
                    "v2_context": v2_context,
                    "final_audio": {},
                },
                owner_id=user_id,
                gpu_target=gpu_target,
            )

        return {
            "ok": True,
            "job_id": job_id,
            "width": width,
            "height": height,
            "v2": {
                "quality": str(quality),
                "ratio": str(ratio),
                "width": width,
                "height": height,
                "seconds": seconds,
                "steps": steps,
                "generation_mode": generation_mode,
                "uses_timeline_guides": generation_mode == "multiframe",
                "has_first_frame": has_first,
                "has_last_frame": has_last,
                "gpu_target": gpu_target,
            },
        }
    except Exception:
        for path in temporary_paths:
            path.unlink(missing_ok=True)
        _v2_release_gpu(gpu_target,job_id)
        raise


def _v2_seed(raw: object) -> int:
    text = str(raw or "").strip()
    if not text:
        return -1
    try:
        value = int(text)
    except ValueError as exc:
        raise HTTPException(
            400,
            "Seed должен быть целым числом или пустым для Auto (-1).",
        ) from exc
    if value < -1 or value > 4294967295:
        raise HTTPException(400, "Seed должен быть от -1 до 4294967295.")
    return value


def _v2_validate_simple_settings(seconds: int, steps: int) -> None:
    if seconds not in V2_DURATIONS:
        raise HTTPException(400, "V2 поддерживает длительность только 5, 10 или 15 секунд.")
    if steps not in V2_STEPS:
        raise HTTPException(400, "V2 поддерживает только 8, 12 или 16 шагов.")


def _v2_character_references(
    character_ids: list[str],
    user_id: str,
    *,
    include_voice: bool,
    muted_character_ids: set[str] | None = None,
    identity_only: bool = False,
) -> list[dict]:
    items: list[dict] = []
    muted = muted_character_ids or set()
    for character_id in character_ids:
        character = db.get_character(character_id, user_id)
        if character is None:
            raise HTTPException(404, "Один из выбранных персонажей не найден.")
        for path_value in character.get("images") or []:
            path = Path(path_value)
            if not path.is_file():
                raise HTTPException(
                    409,
                    f"У персонажа «{character['name']}» отсутствует файл изображения.",
                )
            items.append(
                {
                    "type": "image",
                    "path": str(path),
                    "temporary": False,
                    "source_name": path.name,
                    "role": "character",
                    "retention": (
                        "partially_preserved" if identity_only else "fully_preserved"
                    ),
                    "character_id": character_id,
                    "character_name": character["name"],
                    "character_description": (
                        "" if identity_only else character.get("description") or ""
                    ),
                    "identity_only": bool(identity_only),
                    "note": (
                        "Identity reference only. Preserve recognizable identity, face and "
                        "stable body traits. Exact First/Last timeline guides are authoritative "
                        "for current clothing, accessories, carried props, hairstyle details "
                        "and visible condition; never restore conflicting appearance from this "
                        "saved character picture."
                        if identity_only
                        else ""
                    ),
                }
            )
        if include_voice and character_id not in muted and character.get("voice_file"):
            path = Path(str(character["voice_file"]))
            if not path.is_file():
                raise HTTPException(
                    409,
                    f"У персонажа «{character['name']}» отсутствует файл голоса.",
                )
            items.append(
                {
                    "type": "audio",
                    "path": str(path),
                    "temporary": False,
                    "source_name": path.name,
                    "role": "voice",
                    "retention": "reference",
                    "character_id": character_id,
                    "character_name": character["name"],
                    "character_description": character.get("description") or "",
                }
            )
    return items


def _v2_location_references(location_ids: list[str], user_id: str) -> list[dict]:
    items: list[dict] = []
    for location_id in location_ids:
        location = db.get_location(location_id, user_id)
        if location is None:
            raise HTTPException(404, "Одна из выбранных локаций не найдена.")
        for path_value in location.get("images") or []:
            path = Path(path_value)
            if not path.is_file():
                raise HTTPException(409, f"У локации «{location['name']}» отсутствует файл изображения.")
            items.append(
                {
                    "type": "image",
                    "path": str(path),
                    "temporary": False,
                    "source_name": path.name,
                    "role": "setting",
                    "retention": "fully_preserved",
                    "location_id": location_id,
                    "location_name": location["name"],
                    "location_prompt": location.get("prompt") or "",
                    "note": (
                        "Reusable location reference. Use it as the scene environment/background "
                        "and keep spatial continuity stable."
                    ),
                }
            )
    return items



def _v2_misc_references(misc_ids: list[str], user_id: str) -> list[dict]:
    items: list[dict] = []
    for misc_id in misc_ids:
        preset = db.get_misc_preset(misc_id, user_id)
        if preset is None:
            raise HTTPException(404, "Один из выбранных пресетов «Прочее» не найден.")
        category = str(preset.get("category") or "other")
        role, retention = MISC_CATEGORY_H3_ROLE.get(
            category,
            MISC_CATEGORY_H3_ROLE["other"],
        )
        category_label = MISC_PRESET_CATEGORIES.get(category, MISC_PRESET_CATEGORIES["other"])
        for path_value in preset.get("images") or []:
            path = Path(path_value)
            if not path.is_file():
                raise HTTPException(
                    409,
                    f"У пресета «{preset['name']}» отсутствует файл изображения.",
                )
            items.append(
                {
                    "type": "image",
                    "path": str(path),
                    "temporary": False,
                    "source_name": path.name,
                    "role": role,
                    "retention": retention,
                    "misc_id": misc_id,
                    "misc_name": preset["name"],
                    "misc_category": category,
                    "misc_category_label": category_label,
                    "misc_description": preset.get("description") or "",
                    "note": (
                        "Reusable Misc semantic reference. Apply only the saved "
                        "object/trait/action/style role described by this preset and "
                        "preserve it consistently when it is visible."
                    ),
                }
            )
    return items


def _v2_enqueue_reference_job(
    *,
    job_id: str | None = None,
    gpu_target: str | None = None,
    user_id: str,
    prompt: str,
    width: int,
    height: int,
    seconds: int,
    steps: int,
    seed: int,
    generate_audio: bool,
    generation_mode: str,
    reference_task: str,
    items: list[dict],
    guides: list[dict] | None = None,
    v2_context: dict | None = None,
    final_audio: dict | None = None,
) -> str:
    compact_prompt = " ".join(prompt.split()) if "\n" not in prompt else prompt.strip()
    if not compact_prompt:
        raise HTTPException(400, "Введите prompt.")
    if len(compact_prompt) > 16000:
        raise HTTPException(400, "Prompt слишком длинный.")

    media_order = {"image": 0, "video": 1, "audio": 2}
    items.sort(key=lambda item: media_order.get(str(item.get("type") or ""), 99))
    try:
        validate_reference_items(
            items,
            digital_human=generation_mode == "digital_human",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    actual_prompt, reference_map = build_reference_prompt(
        compact_prompt,
        task=reference_task,
        items=items,
    )
    job_id = job_id or uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "generate",
        {
            "prompt": actual_prompt,
            "user_prompt": compact_prompt,
            "width": int(width),
            "height": int(height),
            "seconds": float(seconds),
            "fps": 24,
            "steps": int(steps),
            "seed": int(seed),
            "generate_audio": bool(generate_audio),
            "generation_mode": generation_mode,
            "keyframe_role": "first",
            "reference_task": reference_task,
            "ref_image_size": "match",
            "images": [],
            "references": items,
            "reference_map": reference_map,
            "guides": guides or [],
            "control": {"mode": "none"},
            "v2_context": v2_context or {},
            "final_audio": final_audio or {},
        },
        owner_id=user_id,
        gpu_target=gpu_target,
    )
    return job_id


def _v2_track_root(user_id: str) -> Path:
    root = settings.data_dir / "audio_tracks" / user_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def _v2_track_id(value: object) -> str:
    track_id = str(value or "").strip().lower()
    if len(track_id) != 32 or any(ch not in "0123456789abcdef" for ch in track_id):
        raise HTTPException(400, "Некорректный ID master track.")
    return track_id


def _v2_track_info(track_id: str, user_id: str) -> dict:
    normalized = _v2_track_id(track_id)
    meta_path = _v2_track_root(user_id) / f"{normalized}.json"
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(404, "Master track не найден.") from exc
    if not isinstance(data, dict):
        raise HTTPException(404, "Master track не найден.")
    stored_filename = str(data.get("stored_filename") or "")
    audio_path = (_v2_track_root(user_id) / stored_filename).resolve()
    try:
        audio_path.relative_to(_v2_track_root(user_id).resolve())
    except ValueError as exc:
        raise HTTPException(404, "Master track не найден.") from exc
    if not audio_path.is_file():
        raise HTTPException(404, "Файл master track отсутствует.")
    data["path"] = str(audio_path)
    return data


def _v2_list_tracks(user_id: str) -> list[dict]:
    root = _v2_track_root(user_id)
    result: list[dict] = []
    for meta_path in root.glob("*.json"):
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue
            track_id = _v2_track_id(data.get("id"))
            stored_filename = str(data.get("stored_filename") or "")
            audio_path = (root / stored_filename).resolve()
            audio_path.relative_to(root.resolve())
            if not audio_path.is_file():
                continue
            size_bytes = audio_path.stat().st_size
            duration = data.get("duration")
            bitrate_kbps = None
            if duration:
                try:
                    bitrate_kbps = round(size_bytes * 8 / float(duration) / 1000)
                except (TypeError, ValueError, ZeroDivisionError):
                    bitrate_kbps = None
            result.append(
                {
                    "id": track_id,
                    "title": str(data.get("title") or stored_filename),
                    "duration": duration,
                    "size_bytes": size_bytes,
                    "bitrate_kbps": bitrate_kbps,
                    "extension": audio_path.suffix.lower().lstrip("."),
                    "created_at": data.get("created_at"),
                }
            )
        except Exception:
            continue
    result.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return result


async def _v2_store_master_track(upload: UploadFile, user_id: str) -> dict:
    original_name = Path(upload.filename or "track").name
    temporary = await save_upload(
        upload,
        kind="audio",
        max_bytes=settings.max_audio_upload_bytes,
    )
    track_id = uuid.uuid4().hex
    root = _v2_track_root(user_id)
    destination = root / f"{track_id}{temporary.suffix.lower()}"
    try:
        shutil.move(str(temporary), str(destination))
        duration = probe_duration(destination)
        data = {
            "id": track_id,
            "title": original_name,
            "stored_filename": destination.name,
            "duration": duration,
            "size_bytes": destination.stat().st_size,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (root / f"{track_id}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        data["path"] = str(destination)
        return data
    except Exception:
        temporary.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        (root / f"{track_id}.json").unlink(missing_ok=True)
        raise


def _v2_delete_track_files(track_id: str, user_id: str) -> None:
    try:
        data = _v2_track_info(track_id, user_id)
    except HTTPException:
        return
    Path(str(data["path"])).unlink(missing_ok=True)
    (_v2_track_root(user_id) / f"{track_id}.json").unlink(missing_ok=True)


async def _v2_audio_segment(
    source: Path,
    *,
    start_seconds: float,
    duration: float,
) -> Path:
    destination = settings.upload_dir / f"{uuid.uuid4().hex}_segment.wav"

    def extract() -> None:
        subprocess.run(
            [
                str(settings.ffmpeg_bin),
                "-y",
                "-ss",
                f"{max(0.0, start_seconds):.6f}",
                "-i",
                str(source),
                "-t",
                f"{max(0.1, duration):.6f}",
                "-vn",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-c:a",
                "pcm_s16le",
                str(destination),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )

    try:
        await asyncio.to_thread(extract)
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(400, "Не удалось подготовить сегмент аудиотрека.") from exc

    if not destination.is_file():
        raise HTTPException(400, "Не удалось подготовить сегмент аудиотрека.")
    return destination


@app.get("/api/v2/tracks/{track_id}/audio")
async def api_v2_track_audio(
    track_id: str,
    user_id: str = Depends(require_user),
):
    track = _v2_track_info(track_id, user_id)
    path = Path(str(track["path"]))
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@app.get("/api/v2/state")
async def api_v2_state(
    media_page: int = Query(1, ge=1),
    user_id: str = Depends(require_user),
):
    media_data = db.list_media_page(media_page, 40, owner_id=user_id)
    for old_job in db.prune_job_history(user_id, keep=20):
        _cleanup_job_uploads(old_job)
        cleanup_job_preview(str(old_job["id"]))
    jobs = db.list_jobs(20, owner_id=user_id)
    library_jobs = []
    for job in db.list_active_generation_jobs(user_id):
        payload = job.get("payload") or {}
        library_jobs.append({
            "id": job["id"],
            "title": str(payload.get("title") or payload.get("user_prompt") or payload.get("prompt") or "MiniMax H3")[:140],
            "status": job["status"],
            "progress": job["progress"],
            "stage": job["stage"],
            "gpu_target": job.get("gpu_target"),
            "created_at": job["created_at"],
            "steps": payload.get("steps") or 8,
            "seconds": payload.get("seconds") or 5,
            "preview_step": job.get("preview_step") or 0,
            "preview_mime": job.get("preview_mime"),
            "preview_enabled": bool(job.get("preview_enabled")),
            "preview_steps": list_job_previews(str(job["id"]), int(job.get("preview_step") or 0)),
        })
    active_global = []
    for job in db.list_jobs(200):
        if job.get("status") not in {"queued", "running"}:
            continue
        payload = job.get("payload") or {}
        active_global.append(
            {
                "id": job.get("id"),
                "owner_id": job.get("owner_id"),
                "user_label": _user_label(str(job.get("owner_id") or "")),
                "kind": job.get("kind"),
                "gpu_target": job.get("gpu_target"),
                "status": job.get("status"),
                "progress": job.get("progress"),
                "stage": job.get("stage"),
                "created_at": job.get("created_at"),
                "started_at": job.get("started_at"),
                "prompt": str(payload.get("user_prompt") or payload.get("prompt") or "")[:180],
            }
        )

    return {
        "server_now": time.time(),
        "user": {"id": user_id, "label": _user_label(user_id)},
        "users": [
            {"id": item.id, "label": item.label}
            for item in settings.site_users
        ],
        "media": media_data["items"],
        "media_pagination": {
            key: media_data[key] for key in ("page", "page_size", "total", "pages")
        },
        "jobs": jobs,
        "library_jobs": library_jobs,
        "active_global": active_global,
        "counts": db.state_counts(user_id),
        "global_counts": db.state_counts(),
        "system": get_system_status(),
        "assistant": await asyncio.to_thread(local_assistant.status),
        "tracks": _v2_list_tracks(user_id),
    }


@app.post("/api/assistant/context")
async def api_assistant_context(
    request: Request,
    user_id: str = Depends(require_user),
):
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(400, "Некорректный запрос контекста.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "Некорректный запрос контекста.")
    runtime_settings, _characters, _locations, _misc = _assistant_runtime_context(
        user_id,
        payload.get("settings"),
    )
    return await asyncio.to_thread(
        local_assistant.context_usage,
        payload.get("messages"),
        settings=runtime_settings,
        thinking=bool(payload.get("thinking")),
    )


@app.post("/api/v2/audio")
async def api_v2_audio(
    prompt: Annotated[str, Form()],
    quality: Annotated[str, Form()] = "720",
    ratio: Annotated[str, Form()] = "16:9",
    seconds: Annotated[int, Form()] = 10,
    steps: Annotated[int, Form()] = 12,
    seed: Annotated[str, Form()] = "",
    gpu_target: Annotated[str, Form()] = "",
    character_ids: Annotated[str, Form()] = "[]",
    location_ids: Annotated[str, Form()] = "[]",
    misc_ids: Annotated[str, Form()] = "[]",
    track_id: Annotated[str, Form()] = "",
    audio_start: Annotated[float, Form()] = 0.0,
    embed_track: Annotated[bool, Form()] = True,
    generate_scene_audio: Annotated[bool, Form()] = False,
    audio: UploadFile | None = File(None),
    first_frame: UploadFile | None = File(None),
    last_frame: UploadFile | None = File(None),
    user_id: str = Depends(require_user),
):
    _v2_validate_simple_settings(seconds, steps)
    if not math.isfinite(audio_start) or audio_start < 0 or audio_start > 86400:
        raise HTTPException(400, "Начало аудиофрагмента должно быть неотрицательным.")

    compact_prompt = " ".join(prompt.split()) if "\n" not in prompt else prompt.strip()
    if not compact_prompt:
        raise HTTPException(400, "Введите prompt.")
    if len(compact_prompt) > 16000:
        raise HTTPException(400, "Prompt слишком длинный.")

    width, height = _v2_resolution(quality, ratio)
    selected = _v2_character_ids(character_ids)
    selected_locations = _v2_location_ids(location_ids)
    selected_misc = _v2_misc_ids(misc_ids)
    has_upload = audio is not None and bool(audio.filename)
    if bool(track_id.strip()) == bool(has_upload):
        raise HTTPException(
            400,
            "Выберите ровно один master track: сохранённый или новый файл.",
        )

    gpu_target=_v2_gpu_target(gpu_target)
    job_id=uuid.uuid4().hex
    temporary_paths: list[Path] = []
    created_track_id: str | None = None
    _v2_reserve_gpu(gpu_target,job_id)
    try:
        has_first = first_frame is not None and bool(first_frame.filename)
        has_last = last_frame is not None and bool(last_frame.filename)
        items = _v2_character_references(
            selected,
            user_id,
            include_voice=False,
            identity_only=has_first or has_last,
        )
        items.extend(_v2_location_references(selected_locations, user_id))
        items.extend(_v2_misc_references(selected_misc, user_id))
        has_semantic_visual = any(
            item.get("type") in {"image", "video"} for item in items
        )

        frame_paths: list[str] = []
        guides: list[dict] = []

        for upload, time_seconds, frame_idx, label in (
            (first_frame, 0.0, 0, "Начальный кадр"),
            (last_frame, float(seconds), -1, "Конечный кадр"),
        ):
            if upload is None or not upload.filename:
                continue
            frame_path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            temporary_paths.append(frame_path)
            source_name = Path(upload.filename).name
            frame_paths.append(str(frame_path))
            guides.append(
                {
                    "path": str(frame_path),
                    "temporary": True,
                    "source_name": source_name,
                    "time_seconds": time_seconds,
                    "frame_idx": frame_idx,
                    "note": f"Exact {label.lower()} for audio-enabled generation.",
                }
            )

        if has_upload:
            assert audio is not None
            track = await _v2_store_master_track(audio, user_id)
            created_track_id = str(track["id"])
        else:
            track = _v2_track_info(track_id, user_id)

        track_duration = track.get("duration")
        if track_duration is not None and audio_start >= float(track_duration):
            raise HTTPException(
                400,
                "Начальная позиция находится за пределами master track.",
            )

        # H3 sometimes returns a few tenths longer than the requested video.
        # Keep one extra second of source audio so the final mux never ends early.
        audio_reserve = 1.0
        requested_audio_duration = float(seconds) + audio_reserve
        segment_end = audio_start + requested_audio_duration
        if track_duration is not None:
            segment_end = min(float(track_duration), segment_end)

        segment = await _v2_audio_segment(
            Path(str(track["path"])),
            start_seconds=audio_start,
            duration=requested_audio_duration,
        )
        temporary_paths.append(segment)

        audio_item = {
            "type": "audio",
            "path": str(segment),
            "temporary": True,
            "source_name": (
                f"{track['title']} [{audio_start:g}-{segment_end:g}s]"
            ),
            "role": "audio",
            "retention": "reference",
            "note": (
                "Driving performance audio. Synchronize mouth/body motion and rhythm "
                "to this clip. The original track is muxed separately when requested."
            ),
        }

        # Digital Human needs at least one visual reference. Saved semantic presets
        # satisfy that requirement directly; otherwise reuse the first available
        # endpoint image (First preferred, otherwise Last) as the semantic visual anchor.
        # The same endpoint image remains an exact native MiniMaxH3AddGuide below.
        use_driving_audio = has_semantic_visual or bool(frame_paths)
        if use_driving_audio and not has_semantic_visual:
            anchor_guide = guides[0]
            items.append(
                {
                    "type": "image",
                    "path": frame_paths[0],
                    "temporary": True,
                    "source_name": anchor_guide["source_name"],
                    "role": "composition",
                    "retention": "partially_preserved",
                    "note": (
                        "Endpoint image also used as the required Digital Human visual "
                        "reference. Exact endpoint anchoring is applied separately through "
                        "MiniMaxH3AddGuide."
                    ),
                }
            )
        if use_driving_audio:
            items.append(audio_item)

        # The extra second is only a technical source-audio reserve for H3/mux.
        # It must NOT advance the logical music-video timeline, otherwise the next
        # 10-second clip would start at 11s and silently skip one second of the song.
        timeline_audio_end = audio_start + float(seconds)
        if track_duration is not None:
            timeline_audio_end = min(float(track_duration), timeline_audio_end)

        h3_prompt = compact_prompt
        if use_driving_audio:
            h3_prompt = (
                "Driving-audio performance constraint: the supplied audio is the authoritative "
                "performance track. Synchronize visible mouth/lip articulation, facial performance, "
                "gestures and body motion to it. If the supplied audio contains singing, the visible "
                "subject must visibly sing in sync with the vocals; if it contains speech, the visible "
                "subject must visibly speak in sync. Do not invent, rewrite or replace lyrics or spoken "
                "words.\n\n"
                + h3_prompt.lstrip()
            )
        if generate_scene_audio and embed_track:
            h3_prompt = (
                "Audio constraint: generate only diegetic environmental and foley sounds "
                "for the visible scene. Do not reproduce, sing, hum, or recreate the selected "
                "master track; the original track will be mixed separately.\n\n"
                + h3_prompt.lstrip()
            )

        generation_mode = "digital_human" if use_driving_audio else "frames"
        v2_context = {
            "workspace": "create",
            "audio_mode": True,
            "has_driving_audio": bool(use_driving_audio),
            "track_id": track["id"],
            "audio_start": float(audio_start),
            "audio_end": float(timeline_audio_end),
            "audio_source_end": float(segment_end),
            "audio_reserve": audio_reserve,
            "embed_track": bool(embed_track),
            "generate_scene_audio": bool(generate_scene_audio),
            "has_first_frame": bool(has_first),
            "has_last_frame": bool(has_last),
            "generation_mode": generation_mode,
        }
        final_audio = {
            "path": str(segment),
            "temporary": True,
            "embed_track": bool(embed_track),
            "mix_scene_audio": bool(generate_scene_audio),
            "track_volume": 1.0,
            "scene_volume": 0.45,
        }

        if use_driving_audio:
            job_id = _v2_enqueue_reference_job(
                job_id=job_id,
                gpu_target=gpu_target,
                user_id=user_id,
                prompt=h3_prompt,
                width=width,
                height=height,
                seconds=seconds,
                steps=steps,
                seed=_v2_seed(seed),
                generate_audio=generate_scene_audio,
                generation_mode="digital_human",
                reference_task="audio_reference",
                items=items,
                guides=guides,
                v2_context=v2_context,
                final_audio=final_audio,
            )
        else:
            keyframe_role = "last" if has_last and not has_first else "first"
            db.enqueue_job(
                job_id,
                "generate",
                {
                    "prompt": h3_prompt,
                    "user_prompt": compact_prompt,
                    "width": int(width),
                    "height": int(height),
                    "seconds": float(seconds),
                    "fps": 24,
                    "steps": int(steps),
                    "seed": int(_v2_seed(seed)),
                    "generate_audio": bool(generate_scene_audio),
                    "generation_mode": "frames",
                    "keyframe_role": keyframe_role,
                    "reference_task": "reference_generation",
                    "ref_image_size": "match",
                    "images": frame_paths,
                    "references": [],
                    "reference_map": [],
                    "guides": [],
                    "control": {"mode": "none"},
                    "v2_context": v2_context,
                    "final_audio": final_audio,
                },
                owner_id=user_id,
                gpu_target=gpu_target,
            )

        return {
            "ok": True,
            "job_id": job_id,
            "width": width,
            "height": height,
            "track_id": track["id"],
            "audio_start": float(audio_start),
            "audio_end": float(timeline_audio_end),
            "audio_source_end": float(segment_end),
            "audio_reserve": audio_reserve,
            "embed_track": bool(embed_track),
            "generate_scene_audio": bool(generate_scene_audio),
            "generation_mode": generation_mode,
            "has_driving_audio": bool(use_driving_audio),
            "has_first_frame": bool(has_first),
            "has_last_frame": bool(has_last),
            "uses_timeline_guides": bool(use_driving_audio and guides),
            "gpu_target": gpu_target,
        }
    except Exception:
        for path in temporary_paths:
            path.unlink(missing_ok=True)
        if created_track_id:
            _v2_delete_track_files(created_track_id, user_id)
        _v2_release_gpu(gpu_target,job_id)
        raise


@app.delete("/api/v2/tracks/{track_id}")
async def api_v2_delete_track(
    track_id: str,
    user_id: str = Depends(require_user),
):
    _v2_track_info(track_id, user_id)
    _v2_delete_track_files(track_id, user_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel_job(
    job_id: str,
    request: Request,
    user_id: str = Depends(require_user),
):
    source=db.get_job(job_id,user_id)
    if source is None:raise HTTPException(404,"Задача не найдена.")
    job = db.request_cancel(job_id, user_id)
    if job is None:raise HTTPException(404,"Задача не найдена.")
    if source["kind"] == "generate":
        cleanup_job_preview(job_id)
    if job["status"]=="canceled" and source.get("gpu_target") and source["kind"]=="generate":
        _v2_release_gpu(source["gpu_target"],job_id)

    if job["status"] == "running" and job["kind"] == "generate":
        request.app.state.worker.cancel_job(
            job_id,
            str(job.get("external_id")) if job.get("external_id") else None,
        )

    return {"ok": True, "status": job["status"]}


@app.get("/api/jobs/{job_id}/preview")
async def api_job_preview(
    job_id: str,
    step: int | None = None,
    poster: bool = False,
    user_id: str = Depends(require_user),
):
    job = db.get_job(job_id, user_id)
    if (
        job is None or job["kind"] != "generate"
        or job["status"] != "running" or job["cancel_requested"]
        or int(job.get("preview_step") or 0) < 2
    ):
        raise HTTPException(404, "Предпросмотр недоступен.")
    current_step = int(job.get("preview_step") or 0)
    target_step = current_step if step is None else step
    if target_step < 2 or target_step > current_step or target_step % 2:
        raise HTTPException(404, "Этот шаг предпросмотра недоступен.")
    if poster:
        path = preview_poster_path(job_id, target_step)
        mime = "image/jpeg"
        if path is None or not path.is_file():
            raise HTTPException(404, "Кадр предпросмотра ещё не готов.")
    else:
        result = find_job_preview(job_id, target_step)
        if result is None:
            raise HTTPException(404, "Предпросмотр ещё не готов.")
        path, mime = result
    return FileResponse(
        path,
        media_type=mime,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.post("/api/jobs/{job_id}/retry")
async def api_retry_job(
    job_id: str,
    user_id: str = Depends(require_user),
):
    source = db.get_job(job_id, user_id)
    if source is None:
        raise HTTPException(404, "Задача не найдена.")
    if source["status"] != "failed":
        raise HTTPException(409, "Повторить можно только задачу с ошибкой.")
    if source["kind"] not in {"generate", "editor_export"}:
        raise HTTPException(409, "Этот тип задачи больше не поддерживается.")

    payload = source.get("payload") or {}
    missing = []
    for path in payload.get("images") or []:
        if not Path(path).is_file():
            missing.append(str(path))
    for item in payload.get("references") or []:
        if isinstance(item, dict) and item.get("path") and not Path(str(item["path"])).is_file():
            missing.append(str(item["path"]))
    for item in payload.get("guides") or []:
        if isinstance(item, dict) and item.get("path") and not Path(str(item["path"])).is_file():
            missing.append(str(item["path"]))
    control = payload.get("control") if isinstance(payload.get("control"), dict) else {}
    for key in ("control_video_path", "source_video_path", "mask_video_path"):
        value = control.get(key)
        if value and not Path(str(value)).is_file():
            missing.append(str(value))
    audio_path = payload.get("audio_path")
    if audio_path and not Path(audio_path).is_file():
        missing.append(str(audio_path))
    final_audio = payload.get("final_audio") if isinstance(payload.get("final_audio"), dict) else {}
    final_audio_path = final_audio.get("path")
    if final_audio_path and not Path(str(final_audio_path)).is_file():
        missing.append(str(final_audio_path))
    for clip in payload.get("clips") or []:
        if not isinstance(clip, dict) or not clip.get("media_id"):
            continue
        media = db.get_media(str(clip["media_id"]), user_id)
        if media is None or not (settings.library_dir / media["filename"]).is_file():
            missing.append(f"media:{clip['media_id']}")
    if missing:
        raise HTTPException(
            409,
            "Исходные файлы уже отсутствуют. Создайте задачу заново.",
        )

    new_job_id=uuid.uuid4().hex
    if source["kind"] == "generate":
        gpu_target=str(source.get("gpu_target") or "rtx3090")
        _v2_reserve_gpu(gpu_target,new_job_id)
        try:
            db.clone_failed_job(job_id,new_job_id)
        except Exception:
            _v2_release_gpu(gpu_target,new_job_id)
            raise
        return {"ok":True,"job_id":new_job_id,"gpu_target":gpu_target}

    db.clone_failed_job(job_id,new_job_id)
    return {"ok":True,"job_id":new_job_id}


@app.delete("/api/jobs/{job_id}")
async def api_delete_job(
    job_id: str,
    user_id: str = Depends(require_user),
):
    try:
        job = db.delete_terminal_job(job_id, user_id)
    except ValueError:
        raise HTTPException(
            409,
            "Работающую или ожидающую задачу сначала нужно остановить.",
        )
    if job is None:
        raise HTTPException(404, "Задача не найдена.")
    _cleanup_job_uploads(job)
    return {"ok": True}


@app.delete("/api/jobs")
async def api_clear_jobs(
    user_id: str = Depends(require_user),
):
    jobs = db.clear_nonrunning_jobs(user_id)
    for job in jobs:
        if job.get("status")=="queued" and job.get("kind")=="generate" and job.get("gpu_target"):
            _v2_release_gpu(job["gpu_target"],str(job["id"]))
        _cleanup_job_uploads(job)
    counts = db.state_counts(user_id)
    return {
        "ok": True,
        "deleted": len(jobs),
        "running_kept": counts["running"],
    }


@app.get("/api/editor/media")
async def api_editor_media(
    user_id: str = Depends(require_user),
):
    return {"items": db.list_media(500, owner_id=user_id)}


@app.post("/api/editor/export")
async def api_editor_export(
    project: Annotated[str, Form()],
    audio: UploadFile | None = File(None),
    user_id: str = Depends(require_user),
):
    try:
        data = json.loads(project)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Некорректный проект монтажа.") from exc
    if not isinstance(data, dict):
        raise HTTPException(400, "Некорректный проект монтажа.")

    clips = data.get("clips")
    if not isinstance(clips, list) or not clips:
        raise HTTPException(400, "Добавьте хотя бы один ролик на таймлайн.")
    if len(clips) > 50:
        raise HTTPException(400, "На один экспорт можно добавить не более 50 роликов.")

    normalized_clips: list[dict] = []
    for index, clip in enumerate(clips, start=1):
        if not isinstance(clip, dict):
            raise HTTPException(400, f"Некорректный клип #{index}.")
        media_id = str(clip.get("media_id") or "").strip()
        if not media_id:
            raise HTTPException(400, f"Не указан ролик для клипа #{index}.")
        _ensure_media(media_id, user_id)
        volume = _editor_float(
            clip.get("volume", 1.0),
            f"Громкость клипа #{index}",
            0.0,
            2.0,
        )
        trim_start = _editor_float(
            clip.get("trim_start", 0.0),
            f"Начало клипа #{index}",
            0.0,
            86400.0,
        )
        trim_duration = _editor_float(
            clip.get("trim_duration", 0.0),
            f"Длина клипа #{index}",
            0.0,
            86400.0,
        )
        fade_in = _editor_float(
            clip.get("fade_in", 0.0),
            f"Fade in клипа #{index}",
            0.0,
            60.0,
        )
        fade_out = _editor_float(
            clip.get("fade_out", 0.0),
            f"Fade out клипа #{index}",
            0.0,
            60.0,
        )
        normalized_clips.append(
            {
                "media_id": media_id,
                "volume": volume,
                "trim_start": trim_start,
                "trim_duration": trim_duration,
                "fade_in": fade_in,
                "fade_out": fade_out,
            }
        )

    audio_settings = data.get("audio")
    if audio_settings is None:
        audio_settings = {}
    if not isinstance(audio_settings, dict):
        raise HTTPException(400, "Некорректные настройки аудиодорожки.")

    audio_enabled = bool(audio_settings.get("enabled", False))
    audio_offset = _editor_float(
        audio_settings.get("offset", 0.0),
        "Позиция аудиодорожки",
        0.0,
        86400.0,
    )
    audio_trim_start = _editor_float(
        audio_settings.get("trim_start", 0.0),
        "Начало обрезки аудио",
        0.0,
        86400.0,
    )
    audio_trim_duration = _editor_float(
        audio_settings.get("trim_duration", 0.0),
        "Длина аудиодорожки",
        0.0,
        86400.0,
    )
    audio_volume = _editor_float(
        audio_settings.get("volume", 1.0),
        "Громкость аудиодорожки",
        0.0,
        2.0,
    )

    audio_path: Path | None = None
    if audio is not None and audio.filename:
        audio_path = await save_upload(
            audio,
            kind="audio",
            max_bytes=settings.max_audio_upload_bytes,
        )
        audio_enabled = True
    elif audio_enabled:
        raise HTTPException(400, "Выберите аудиофайл для дорожки.")

    title = " ".join(str(data.get("title") or "Монтаж").split())[:120] or "Монтаж"
    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "editor_export",
        {
            "title": title,
            "clips": normalized_clips,
            "audio_path": str(audio_path) if audio_path else None,
            "audio": {
                "enabled": audio_enabled,
                "offset": audio_offset,
                "trim_start": audio_trim_start,
                "trim_duration": audio_trim_duration,
                "volume": audio_volume,
            },
        },
        owner_id=user_id,
    )
    return {"ok": True, "job_id": job_id}


@app.delete("/api/media")
async def api_clear_media(
    user_id: str = Depends(require_user),
):
    protected_ids = db.active_media_ids(user_id)
    media_items = db.clear_media_except(protected_ids, owner_id=user_id)
    deleted_files = 0
    for media in media_items:
        path = settings.library_dir / media["filename"]
        try:
            path.unlink(missing_ok=True)
            deleted_files += 1
        except OSError:
            pass
    return {
        "ok": True,
        "deleted": len(media_items),
        "files_deleted": deleted_files,
        "protected": len(protected_ids),
    }


@app.delete("/api/media/{media_id}")
async def api_delete_media(
    media_id: str,
    user_id: str = Depends(require_user),
):
    media = _ensure_media(media_id, user_id)
    if media_id in db.active_media_ids(user_id):
        raise HTTPException(409, "Этот ролик используется активной задачей.")

    path = settings.library_dir / media["filename"]
    path.unlink(missing_ok=True)
    db.delete_media_row(media_id, user_id)
    return {"ok": True}


@app.get("/media/{media_id}")
async def media_file(
    media_id: str,
    request: Request,
    user_id: str = Depends(require_user),
):
    media = _ensure_media(media_id, user_id)
    path = settings.library_dir / media["filename"]
    if not path.is_file():
        raise HTTPException(404, "Файл не найден.")

    download = request.query_params.get("download") == "1"
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=path.name if download else None,
        content_disposition_type="attachment" if download else "inline",
    )



def _last_video_frame_timestamp(path: Path) -> float:
    command = [
        str(settings.ffprobe_bin),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        str(path),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(500, f"Не удалось прочитать кадры видео: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip()[-800:]
        raise HTTPException(500, "FFprobe не смог прочитать видео." + (f" {detail}" if detail else ""))

    timestamps: list[float] = []
    for raw_line in result.stdout.splitlines():
        value = raw_line.strip().split(",", 1)[0]
        try:
            timestamp = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(timestamp) and timestamp >= 0:
            timestamps.append(timestamp)
    if not timestamps:
        raise HTTPException(422, "В видео не найдено ни одного кадра.")
    return max(timestamps)


@app.get("/api/media/{media_id}/frame/{position}")
async def api_extract_media_frame(
    media_id: str,
    position: str,
    user_id: str = Depends(require_user),
):
    position = position.strip().lower()
    if position not in {"start", "final"}:
        raise HTTPException(400, "Позиция кадра должна быть start или final.")

    media = _ensure_media(media_id, user_id)
    source = settings.library_dir / media["filename"]
    if not source.is_file():
        raise HTTPException(404, "Файл видео не найден.")

    output = settings.temp_dir / f"frame_{media_id}_{uuid.uuid4().hex[:10]}.png"
    command = [
        str(settings.ffmpeg_bin),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
    ]
    if position == "final":
        # Seek just before the last real frame PTS so the next decoded frame is
        # the actual final frame, not an approximate duration-based sample.
        last_timestamp = _last_video_frame_timestamp(source)
        command.extend(["-ss", f"{max(0.0, last_timestamp - 0.001):.6f}"])

    command.extend([
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        str(output),
    ])

    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        output.unlink(missing_ok=True)
        raise HTTPException(500, f"Не удалось извлечь кадр: {exc}") from exc

    if result.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
        output.unlink(missing_ok=True)
        detail = (result.stderr or "").strip()[-800:]
        raise HTTPException(500, "FFmpeg не смог извлечь кадр." + (f" {detail}" if detail else ""))

    suffix = "start" if position == "start" else "final"
    download_name = f"{media_id}_{suffix}.png"
    return FileResponse(
        output,
        media_type="image/png",
        filename=download_name,
        content_disposition_type="attachment",
        background=BackgroundTask(output.unlink, missing_ok=True),
    )


async def save_upload(
    upload: UploadFile,
    *,
    kind: str,
    max_bytes: int,
) -> Path:
    original = Path(upload.filename or "")
    extension = original.suffix.lower()

    allowed = {
        "image": {".png", ".jpg", ".jpeg", ".webp"},
        "video": {".mp4", ".mov", ".mkv", ".webm", ".m4v"},
        "audio": {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus"},
    }
    if extension not in allowed[kind]:
        raise HTTPException(
            400,
            f"Неподдерживаемый {kind} формат: {extension or 'без расширения'}",
        )

    destination = settings.upload_dir / f"{uuid.uuid4().hex}{extension}"
    size = 0
    try:
        with destination.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, "Файл превышает допустимый размер.")
                handle.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()

    return destination


def _cleanup_job_uploads(job: dict) -> None:
    payload = job.get("payload") or {}
    paths = list(payload.get("images") or [])
    for item in payload.get("references") or []:
        if isinstance(item, dict) and item.get("temporary") and item.get("path"):
            paths.append(item["path"])
    for item in payload.get("guides") or []:
        if isinstance(item, dict) and item.get("temporary") and item.get("path"):
            paths.append(item["path"])
    control = payload.get("control") if isinstance(payload.get("control"), dict) else {}
    for key in ("control_video_path", "source_video_path", "mask_video_path"):
        if control.get(key):
            paths.append(control[key])
    if payload.get("audio_path"):
        paths.append(payload["audio_path"])
    final_audio = payload.get("final_audio") if isinstance(payload.get("final_audio"), dict) else {}
    if final_audio.get("temporary") and final_audio.get("path"):
        paths.append(final_audio["path"])

    upload_root = settings.upload_dir.resolve()
    for value in paths:
        try:
            path = Path(value).resolve()
            if path.parent == upload_root:
                path.unlink(missing_ok=True)
        except OSError:
            pass


VOICE_PRESETS = {
    "ryan": {"name": "Ryan", "tone": "энергичный · ритмичный", "gender": "male", "speaker": "Ryan"},
    "aiden": {"name": "Aiden", "tone": "тёплый · ясный", "gender": "male", "speaker": "Aiden"},
    "uncle_fu": {"name": "Uncle Fu", "tone": "низкий · зрелый", "gender": "male", "speaker": "Uncle_Fu"},
    "dylan": {"name": "Dylan", "tone": "молодой · естественный", "gender": "male", "speaker": "Dylan"},
    "eric": {"name": "Eric", "tone": "живой · слегка хриплый", "gender": "male", "speaker": "Eric"},
    "viktor": {"name": "Viktor", "tone": "глубокий · кинематографичный", "gender": "male", "speaker": "VoiceDesign"},
    "max": {"name": "Max", "tone": "молодой · энергичный", "gender": "male", "speaker": "VoiceDesign"},
    "anton": {"name": "Anton", "tone": "хриплый · суровый", "gender": "male", "speaker": "VoiceDesign"},

    "vivian": {"name": "Vivian", "tone": "яркий · уверенный", "gender": "female", "speaker": "Vivian"},
    "serena": {"name": "Serena", "tone": "мягкий · тёплый", "gender": "female", "speaker": "Serena"},
    "ono_anna": {"name": "Anna", "tone": "лёгкий · игривый", "gender": "female", "speaker": "Ono_Anna"},
    "sohee": {"name": "Sohee", "tone": "тёплый · эмоциональный", "gender": "female", "speaker": "Sohee"},
    "elena": {"name": "Elena", "tone": "зрелый · тёплый", "gender": "female", "speaker": "VoiceDesign"},
    "mira": {"name": "Mira", "tone": "молодой · мягкий", "gender": "female", "speaker": "VoiceDesign"},
    "vera": {"name": "Vera", "tone": "низкий · уверенный", "gender": "female", "speaker": "VoiceDesign"},
    "alisa": {"name": "Alisa", "tone": "яркий · энергичный", "gender": "female", "speaker": "VoiceDesign"},
}


def _voice_preset_path(preset_id: str) -> Path:
    preset = VOICE_PRESETS.get(preset_id)
    if preset is None:
        raise ValueError("Неизвестный пресет голоса.")
    return settings.data_dir / "voice_presets" / f"{preset_id}.wav"


def _file_sha256(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _uploaded_reference_name(upload: UploadFile) -> str:
    # Preserve the user's own reference label, not the server's generated filename.
    # Ignore path prefixes and control characters supplied by upload clients.
    filename = str(upload.filename or "").replace("\\", "/").split("/")[-1]
    return "".join(char for char in filename if char.isprintable()).strip()[:180]


def _character_voice_preset_id(character: dict) -> str | None:
    stored = str(character.get("voice_preset_id") or "").strip()
    if stored in VOICE_PRESETS:
        return stored

    voice_value = character.get("voice_file")
    if not voice_value:
        return None
    voice_path = Path(str(voice_value))
    try:
        if not voice_path.is_file():
            return None
        voice_size = voice_path.stat().st_size
        voice_digest: bytes | None = None
        for preset_id in VOICE_PRESETS:
            preset_path = _voice_preset_path(preset_id)
            if not preset_path.is_file() or preset_path.stat().st_size != voice_size:
                continue
            if voice_digest is None:
                voice_digest = _file_sha256(voice_path)
            if _file_sha256(preset_path) == voice_digest:
                return preset_id
    except OSError:
        return None
    return None


def _voice_presets_public() -> list[dict]:
    result: list[dict] = []
    for preset_id, preset in VOICE_PRESETS.items():
        path = _voice_preset_path(preset_id)
        available = path.is_file() and path.stat().st_size > 1024
        result.append(
            {
                "id": preset_id,
                "name": str(preset["name"]),
                "tone": str(preset["tone"]),
                "gender": str(preset["gender"]),
                "available": available,
                "preview_url": f"/voice-presets/{preset_id}.wav" if available else None,
            }
        )
    return result

def _character_public(character: dict | None) -> dict:
    if not character:
        return {}
    images = character.get("images") or []
    version = str(character.get("updated_at") or "")
    image_urls = [
        f"/characters/{character['id']}/image/{index}?v={version}"
        for index in range(len(images))
    ]
    preset_id = _character_voice_preset_id(character)
    return {
        "id": character["id"],
        "name": character["name"],
        "description": character.get("description") or "",
        "image_count": len(images),
        "image_urls": image_urls,
        "image_names": character.get("image_names") or [None] * len(images),
        "voice": bool(character.get("voice_file")),
        "voice_preset_id": preset_id,
        "voice_preset_name": str(VOICE_PRESETS[preset_id]["name"]) if preset_id else "",
        "voice_name": character.get("voice_name") or "",
        "preview_url": image_urls[0] if image_urls else None,
        "created_at": character.get("created_at"),
        "updated_at": character.get("updated_at"),
    }


def _location_public(location: dict | None) -> dict:
    if not location:
        return {}
    images = location.get("images") or []
    version = str(location.get("updated_at") or "")
    image_urls = [
        f"/locations/{location['id']}/image/{index}?v={version}"
        for index in range(len(images))
    ]
    return {
        "id": location["id"],
        "name": location["name"],
        "prompt": location.get("prompt") or "",
        "image_count": len(images),
        "image_urls": image_urls,
        "image_names": location.get("image_names") or [None] * len(images),
        "preview_url": image_urls[0] if image_urls else None,
        "created_at": location.get("created_at"),
        "updated_at": location.get("updated_at"),
    }




def _misc_public(preset: dict | None) -> dict:
    if not preset:
        return {}
    images = preset.get("images") or []
    version = str(preset.get("updated_at") or "")
    image_urls = [
        f"/misc/{preset['id']}/image/{index}?v={version}"
        for index in range(len(images))
    ]
    category = str(preset.get("category") or "other")
    return {
        "id": preset["id"],
        "name": preset["name"],
        "category": category,
        "category_label": MISC_PRESET_CATEGORIES.get(
            category,
            MISC_PRESET_CATEGORIES["other"],
        ),
        "description": preset.get("description") or "",
        "image_count": len(images),
        "image_urls": image_urls,
        "image_names": preset.get("image_names") or [None] * len(images),
        "preview_url": image_urls[0] if image_urls else None,
        "created_at": preset.get("created_at"),
        "updated_at": preset.get("updated_at"),
    }


def _assistant_selected_ids(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {
        str(item)
        for item in value
        if isinstance(item, (str, int)) and str(item).strip()
    }


def _assistant_runtime_context(
    user_id: str,
    supplied_settings: object,
) -> tuple[dict, list[dict], list[dict], list[dict]]:
    context = dict(supplied_settings) if isinstance(supplied_settings, dict) else {}
    selected_character_ids = _assistant_selected_ids(context.get("selected_character_ids"))
    selected_location_ids = _assistant_selected_ids(context.get("selected_location_ids"))
    selected_misc_ids = _assistant_selected_ids(context.get("selected_misc_ids"))
    muted_character_ids = _assistant_selected_ids(context.get("muted_character_ids"))

    # Privacy/visibility gate for the local assistant: only presets explicitly
    # checked in the right rail are loaded into LLM context. Unchecked presets must
    # remain completely invisible to Chat and Magic Wand.
    characters: list[dict] = []
    for raw in db.list_characters(user_id):
        public = _character_public(raw)
        character_id = str(public.get("id") or "")
        if character_id not in selected_character_ids:
            continue
        preset_id = str(public.get("voice_preset_id") or "")
        preset = VOICE_PRESETS.get(preset_id) if preset_id else None
        has_voice = bool(public.get("voice"))
        characters.append(
            {
                "id": character_id,
                "name": str(public.get("name") or ""),
                "description": str(public.get("description") or ""),
                "image_count": int(public.get("image_count") or 0),
                "voice": has_voice,
                "voice_source": "preset" if preset_id else ("custom" if has_voice else "none"),
                "voice_preset_id": preset_id,
                "voice_preset_name": str((preset or {}).get("name") or ""),
                "selected": character_id in selected_character_ids,
                "voice_muted": character_id in muted_character_ids,
                "speech_policy": (
                    "silent"
                    if (not has_voice or character_id in muted_character_ids)
                    else "explicit_dialogue_only"
                ),
            }
        )

    locations: list[dict] = []
    for raw in db.list_locations(user_id):
        public = _location_public(raw)
        location_id = str(public.get("id") or "")
        if location_id not in selected_location_ids:
            continue
        locations.append(
            {
                "id": location_id,
                "name": str(public.get("name") or ""),
                "prompt": str(public.get("prompt") or ""),
                "image_count": int(public.get("image_count") or 0),
                "selected": location_id in selected_location_ids,
            }
        )

    misc: list[dict] = []
    for raw in db.list_misc_presets(user_id):
        public = _misc_public(raw)
        misc_id = str(public.get("id") or "")
        if misc_id not in selected_misc_ids:
            continue
        misc.append(
            {
                "id": misc_id,
                "name": str(public.get("name") or ""),
                "category": str(public.get("category") or "other"),
                "category_label": str(public.get("category_label") or "Другое"),
                "description": str(public.get("description") or ""),
                "image_count": int(public.get("image_count") or 0),
                "selected": misc_id in selected_misc_ids,
            }
        )

    selected_characters = [
        {
            "name": item["name"],
            "description": item["description"],
            "image_count": item["image_count"],
            "voice": item["voice"],
            "voice_source": item["voice_source"],
            "voice_preset_id": item["voice_preset_id"],
            "voice_preset_name": item["voice_preset_name"],
            "voice_muted": item["voice_muted"],
            "speech_policy": item["speech_policy"],
            "voice_label": (
                f"Preset: {item['voice_preset_name']}"
                if item["voice_source"] == "preset" and item["voice_preset_name"]
                else (
                    "Custom voice"
                    if item["voice_source"] == "custom"
                    else "No voice"
                )
            ),
        }
        for item in characters
        if item["selected"]
    ]
    selected_locations = [
        {
            "name": item["name"],
            "prompt": item["prompt"],
            "image_count": item["image_count"],
        }
        for item in locations
        if item["selected"]
    ]

    selected_misc = [
        {
            "name": item["name"],
            "category": item["category"],
            "category_label": item["category_label"],
            "description": item["description"],
            "image_count": item["image_count"],
        }
        for item in misc
        if item["selected"]
    ]

    context["available_characters"] = characters
    context["available_locations"] = locations
    context["available_misc"] = misc
    context["selected_characters"] = selected_characters
    context["selected_locations"] = selected_locations
    context["selected_misc"] = selected_misc

    # Only IDs that resolved to checked presets survive into assistant context.
    visible_character_ids = {str(item["id"]) for item in characters}
    visible_location_ids = {str(item["id"]) for item in locations}
    visible_misc_ids = {str(item["id"]) for item in misc}
    context["selected_character_ids"] = sorted(visible_character_ids)
    context["selected_location_ids"] = sorted(visible_location_ids)
    context["selected_misc_ids"] = sorted(visible_misc_ids)
    context["muted_character_ids"] = sorted(muted_character_ids & visible_character_ids)
    return context, characters, locations, misc


def _editor_float(
    value: object,
    label: str,
    minimum: float,
    maximum: float,
) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, f"{label}: некорректное значение.") from exc
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise HTTPException(
            400,
            f"{label}: допустимый диапазон {minimum:g}–{maximum:g}.",
        )
    return number


def _ensure_media(media_id: str, owner_id: str) -> dict:
    media = db.get_media(media_id, owner_id)
    if media is None:
        raise HTTPException(404, "Ролик не найден.")
    return media


_system_cache_lock = threading.Lock()
_system_cache_at = 0.0
_system_cache: dict = {}
_cpu_prev_total: int | None = None
_cpu_prev_idle: int | None = None


def get_system_status() -> dict:
    global _system_cache_at, _system_cache, _cpu_prev_total, _cpu_prev_idle
    now = time.monotonic()

    with _system_cache_lock:
        if now - _system_cache_at < 4:
            return dict(_system_cache)

        disk = shutil.disk_usage(settings.data_dir)
        status = {
            "comfyui": ComfyUIClient().health(),
            "comfyui_secondary": ComfyUIClient(settings.comfyui_secondary_url).health(),
            "gpu": None,
            "secondary_gpu": None,
            "gpus": [],
            "disk_free": disk.free,
            "disk_total": disk.total,
            "ram_total": None,
            "ram_available": None,
            "cpu_load_1m": None,
            "cpu_load_5m": None,
            "cpu_load_15m": None,
            "cpu_count": __import__("os").cpu_count(),
            "cpu_utilization": None,
        }

        try:
            meminfo: dict[str, int] = {}
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                parts = value.strip().split()
                if parts and parts[0].isdigit():
                    meminfo[key] = int(parts[0]) * 1024
            status["ram_total"] = meminfo.get("MemTotal")
            status["ram_available"] = meminfo.get("MemAvailable")
        except Exception:
            pass

        try:
            load_1m, load_5m, load_15m = __import__("os").getloadavg()
            status["cpu_load_1m"] = round(float(load_1m), 2)
            status["cpu_load_5m"] = round(float(load_5m), 2)
            status["cpu_load_15m"] = round(float(load_15m), 2)
        except Exception:
            pass

        try:
            cpu_line = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0]
            cpu_parts = [int(value) for value in cpu_line.split()[1:]]
            cpu_total = sum(cpu_parts)
            cpu_idle = cpu_parts[3] + (cpu_parts[4] if len(cpu_parts) > 4 else 0)
            if _cpu_prev_total is not None and _cpu_prev_idle is not None:
                total_delta = cpu_total - _cpu_prev_total
                idle_delta = cpu_idle - _cpu_prev_idle
                if total_delta > 0:
                    utilization = 100.0 * (total_delta - idle_delta) / total_delta
                    status["cpu_utilization"] = round(
                        max(0.0, min(100.0, utilization)),
                        1,
                    )
            _cpu_prev_total = cpu_total
            _cpu_prev_idle = cpu_idle
        except Exception:
            pass

        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=3,
            )
            gpus = []
            for line in result.stdout.strip().splitlines():
                parts = [part.strip() for part in line.split(",")]
                if len(parts) < 6:
                    continue
                gpus.append(
                    {
                        "index": int(parts[0]),
                        "name": parts[1],
                        "memory_used_mb": int(parts[2]),
                        "memory_total_mb": int(parts[3]),
                        "utilization": int(parts[4]),
                        "temperature": int(parts[5]),
                    }
                )
            status["gpus"] = gpus
            status["gpu"] = next(
                (gpu for gpu in gpus if gpu["index"] == 0),
                gpus[0] if gpus else None,
            )
            status["secondary_gpu"] = next(
                (gpu for gpu in gpus if gpu["index"] == 1),
                gpus[1] if len(gpus) > 1 else None,
            )
        except Exception:
            pass

        _system_cache = status
        _system_cache_at = now
        return dict(status)
