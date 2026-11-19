from __future__ import annotations

import hmac
import json
import math
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
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from . import db
from .comfy import ComfyUIClient
from .config import settings
from .h3_references import (
    REFERENCE_TASKS,
    build_reference_prompt,
    parse_reference_manifest,
    validate_reference_items,
)
from .worker import JobWorker, probe_has_audio


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    db.recover_interrupted_jobs()
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
async def dashboard(request: Request):
    if not _is_authenticated(request):
        return RedirectResponse("/login", status_code=303)
    user = _current_user(request)
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"current_user": user},
    )


@app.get("/api/state")
async def api_state(
    media_page: int = Query(1, ge=1),
    jobs_page: int = Query(1, ge=1),
    user_id: str = Depends(require_user),
):
    media_data = db.list_media_page(media_page, 20, owner_id=user_id)
    jobs_data = db.list_jobs_page(jobs_page, 20, owner_id=user_id)
    return {
        "server_now": time.time(),
        "jobs": jobs_data["items"],
        "media": media_data["items"],
        "jobs_pagination": {
            key: jobs_data[key] for key in ("page", "page_size", "total", "pages")
        },
        "media_pagination": {
            key: media_data[key] for key in ("page", "page_size", "total", "pages")
        },
        "counts": db.state_counts(user_id),
        "global_counts": db.state_counts(),
        "user": {"id": user_id, "label": _user_label(user_id)},
        "system": get_system_status(),
    }


@app.get("/api/characters")
async def api_characters(user_id: str = Depends(require_user)):
    return {"characters": [_character_public(item) for item in db.list_characters(user_id)]}


@app.post("/api/characters")
async def api_create_character(
    name: Annotated[str, Form()],
    description: Annotated[str, Form()] = "",
    images: list[UploadFile] | None = File(None),
    voice: UploadFile | None = File(None),
    user_id: str = Depends(require_user),
):
    name = name.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Имя персонажа должно содержать 1–80 символов.")
    if len(description) > 2000:
        raise HTTPException(400, "Описание персонажа слишком длинное.")

    uploads = [item for item in (images or []) if item.filename]
    if not uploads:
        raise HTTPException(400, "Добавьте хотя бы одно изображение персонажа.")
    if len(uploads) > 4:
        raise HTTPException(400, "Для одного персонажа можно сохранить до 4 изображений.")

    character_id = uuid.uuid4().hex
    target_dir = settings.character_dir / user_id / character_id
    target_dir.mkdir(parents=True, exist_ok=False)
    image_files: list[str] = []
    voice_file: str | None = None
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

        if voice is not None and voice.filename:
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

        db.insert_character(
            character_id=character_id,
            owner_id=user_id,
            name=name,
            description=description,
            images=image_files,
            voice_file=voice_file,
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
    user_id: str = Depends(require_user),
):
    name = name.strip()
    description = description.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Имя персонажа должно содержать 1–80 символов.")
    if len(description) > 2000:
        raise HTTPException(400, "Описание персонажа слишком длинное.")
    character = db.update_character(
        character_id,
        user_id,
        name=name,
        description=description,
    )
    if character is None:
        raise HTTPException(404, "Персонаж не найден.")
    return {"ok": True, "character": _character_public(character)}


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


@app.post("/api/generate")
async def api_generate(
    request: Request,
    prompt: Annotated[str, Form()],
    width: Annotated[int, Form()] = 1312,
    height: Annotated[int, Form()] = 736,
    seconds: Annotated[float, Form()] = 5.0,
    fps: Annotated[float, Form()] = 24.0,
    profile: Annotated[str, Form()] = "steps8",
    seed: Annotated[int, Form()] = -1,
    generate_audio: Annotated[bool, Form()] = False,
    generation_mode: Annotated[str, Form()] = "frames",
    keyframe_role: Annotated[str, Form()] = "first",
    reference_task: Annotated[str, Form()] = "reference_generation",
    ref_image_size: Annotated[str, Form()] = "match",
    character_ids: Annotated[str, Form()] = "[]",
    reference_manifest: Annotated[str, Form()] = "{}",
    first_frame: UploadFile | None = File(None),
    last_frame: UploadFile | None = File(None),
    reference_images: list[UploadFile] | None = File(None),
    reference_videos: list[UploadFile] | None = File(None),
    reference_audios: list[UploadFile] | None = File(None),
    user_id: str = Depends(require_user),
):
    del request

    prompt = " ".join(prompt.split()) if "\n" not in prompt else prompt.strip()
    if not prompt:
        raise HTTPException(400, "Введите prompt.")
    if len(prompt) > 16000:
        raise HTTPException(400, "Prompt слишком длинный.")

    if width < 256 or width > 3072 or height < 256 or height > 3072:
        raise HTTPException(400, "Размер должен быть от 256 до 3072.")
    if width % 32 or height % 32:
        raise HTTPException(400, "Ширина и высота должны делиться на 32.")
    if seconds < 1 or seconds > 30:
        raise HTTPException(400, "Длительность должна быть от 1 до 30 секунд.")
    allowed_fps = {12.0, 16.0, 20.0, 24.0, 25.0, 30.0}
    if float(fps) not in allowed_fps:
        raise HTTPException(400, "Поддерживаются FPS: 12, 16, 20, 24, 25, 30.")
    profile = {
        "fast": "steps8",
        "quality": "steps20",
        "max": "steps20",
    }.get(profile, profile)
    if profile not in {"steps4", "steps8", "steps12", "steps16", "steps20"}:
        raise HTTPException(400, "Неизвестный профиль шагов.")

    generation_mode = generation_mode.strip().lower()
    if generation_mode not in {"frames", "reference", "digital_human"}:
        raise HTTPException(400, "Неизвестный режим H3.")
    keyframe_role = "last" if keyframe_role == "last" else "first"
    if reference_task not in REFERENCE_TASKS:
        reference_task = "reference_generation"
    if ref_image_size not in {"match", "1k", "1.5k", "2k", "original"}:
        ref_image_size = "match"

    temporary_paths: list[Path] = []
    image_paths: list[str] = []
    reference_items: list[dict] = []
    reference_map: list[dict] = []
    original_prompt = prompt

    try:
        if generation_mode == "frames":
            has_first = first_frame is not None and bool(first_frame.filename)
            has_last = last_frame is not None and bool(last_frame.filename)
            if has_last and not has_first:
                keyframe_role = "last"
            elif has_first:
                keyframe_role = "first"
            for upload in (first_frame, last_frame):
                if upload is not None and upload.filename:
                    path = await save_upload(
                        upload,
                        kind="image",
                        max_bytes=settings.max_image_upload_bytes,
                    )
                    temporary_paths.append(path)
                    image_paths.append(str(path))
            if len(image_paths) > 2:
                raise HTTPException(400, "FL2VA принимает максимум два кадра.")
        else:
            try:
                raw_character_ids = json.loads(character_ids or "[]")
            except json.JSONDecodeError as exc:
                raise HTTPException(400, "Некорректный список персонажей.") from exc
            if not isinstance(raw_character_ids, list):
                raise HTTPException(400, "Некорректный список персонажей.")

            seen_characters: set[str] = set()
            for value in raw_character_ids:
                character_id = str(value).strip()
                if not character_id or character_id in seen_characters:
                    continue
                seen_characters.add(character_id)
                character = db.get_character(character_id, user_id)
                if character is None:
                    raise HTTPException(404, "Один из выбранных персонажей не найден.")
                for path_value in character.get("images") or []:
                    path = Path(path_value)
                    if not path.is_file():
                        raise HTTPException(409, f"У персонажа «{character['name']}» отсутствует файл изображения.")
                    reference_items.append(
                        {
                            "type": "image",
                            "path": str(path),
                            "temporary": False,
                            "source_name": path.name,
                            "role": "character",
                            "retention": "fully_preserved",
                            "character_id": character_id,
                            "character_name": character["name"],
                            "character_description": character.get("description") or "",
                        }
                    )
                voice_path = character.get("voice_file")
                if voice_path:
                    path = Path(voice_path)
                    if not path.is_file():
                        raise HTTPException(409, f"У персонажа «{character['name']}» отсутствует файл голоса.")
                    reference_items.append(
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

            manifest = parse_reference_manifest(reference_manifest)

            async def append_uploads(
                uploads: list[UploadFile] | None,
                media_type: str,
                manifest_key: str,
                kind: str,
                max_bytes: int,
            ) -> None:
                active = [item for item in (uploads or []) if item.filename]
                for index, upload in enumerate(active):
                    path = await save_upload(upload, kind=kind, max_bytes=max_bytes)
                    temporary_paths.append(path)
                    spec = manifest.get(manifest_key, [])
                    meta = spec[index] if index < len(spec) else {}
                    item = {
                        "type": media_type,
                        "path": str(path),
                        "temporary": True,
                        "source_name": Path(upload.filename or path.name).name,
                        "role": meta.get("role") or (
                            "audio"
                            if media_type == "audio"
                            else "motion"
                            if media_type == "video"
                            else "character"
                        ),
                        "retention": meta.get("retention") or (
                            "reference"
                            if media_type == "audio"
                            else "partially_preserved"
                            if media_type == "video"
                            else "fully_preserved"
                        ),
                        "note": meta.get("note") or "",
                    }
                    if media_type == "video":
                        item["has_audio"] = probe_has_audio(path)
                        item["audio_retention"] = "reference"
                    reference_items.append(item)

            await append_uploads(
                reference_images, "image", "images", "image",
                settings.max_image_upload_bytes,
            )
            await append_uploads(
                reference_videos, "video", "videos", "video",
                settings.max_video_upload_bytes,
            )
            await append_uploads(
                reference_audios, "audio", "audios", "audio",
                settings.max_audio_upload_bytes,
            )

            try:
                validate_reference_items(
                    reference_items,
                    digital_human=generation_mode == "digital_human",
                )
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc

            prompt, reference_map = build_reference_prompt(
                prompt,
                task=reference_task,
                items=reference_items,
            )

        job_id = uuid.uuid4().hex
        db.enqueue_job(
            job_id,
            "generate",
            {
                "prompt": prompt,
                "user_prompt": original_prompt,
                "width": width,
                "height": height,
                "seconds": seconds,
                "fps": fps,
                "profile": profile,
                "seed": seed,
                "generate_audio": bool(generate_audio),
                "generation_mode": generation_mode,
                "keyframe_role": keyframe_role,
                "reference_task": reference_task,
                "ref_image_size": ref_image_size,
                "images": image_paths,
                "references": reference_items,
                "reference_map": reference_map,
            },
            owner_id=user_id,
        )
    except Exception:
        for path in temporary_paths:
            path.unlink(missing_ok=True)
        raise

    return {"ok": True, "job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel_job(
    job_id: str,
    request: Request,
    user_id: str = Depends(require_user),
):
    job = db.request_cancel(job_id, user_id)
    if job is None:
        raise HTTPException(404, "Задача не найдена.")

    if job["status"] == "running" and job["kind"] == "generate":
        request.app.state.worker.cancel_job(
            job_id,
            str(job.get("external_id")) if job.get("external_id") else None,
        )

    return {"ok": True, "status": job["status"]}


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
    if source["kind"] not in {"generate", "audio_replace", "audio_remove", "editor_export"}:
        raise HTTPException(409, "Этот тип задачи больше не поддерживается.")

    payload = source.get("payload") or {}
    missing = []
    for path in payload.get("images") or []:
        if not Path(path).is_file():
            missing.append(str(path))
    for item in payload.get("references") or []:
        if isinstance(item, dict) and item.get("path") and not Path(str(item["path"])).is_file():
            missing.append(str(item["path"]))
    audio_path = payload.get("audio_path")
    if audio_path and not Path(audio_path).is_file():
        missing.append(str(audio_path))
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

    new_job_id = uuid.uuid4().hex
    db.clone_failed_job(job_id, new_job_id)
    return {"ok": True, "job_id": new_job_id}


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
        _cleanup_job_uploads(job)
    counts = db.state_counts(user_id)
    return {
        "ok": True,
        "deleted": len(jobs),
        "running_kept": counts["running"],
    }


@app.post("/api/media/{media_id}/audio")
async def api_replace_audio(
    media_id: str,
    audio: UploadFile = File(...),
    audio_start: Annotated[float, Form()] = 0.0,
    user_id: str = Depends(require_user),
):
    _ensure_media(media_id, user_id)
    audio_path = await save_upload(
        audio,
        kind="audio",
        max_bytes=settings.max_audio_upload_bytes,
    )
    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "audio_replace",
        {
            "media_id": media_id,
            "audio_path": str(audio_path),
            "audio_start": max(0.0, audio_start),
        },
        owner_id=user_id,
    )
    return {"ok": True, "job_id": job_id}


@app.post("/api/media/{media_id}/remove-audio")
async def api_remove_audio(
    media_id: str,
    user_id: str = Depends(require_user),
):
    _ensure_media(media_id, user_id)
    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "audio_remove",
        {"media_id": media_id},
        owner_id=user_id,
    )
    return {"ok": True, "job_id": job_id}


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
        normalized_clips.append({"media_id": media_id, "volume": volume})

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
    if payload.get("audio_path"):
        paths.append(payload["audio_path"])

    upload_root = settings.upload_dir.resolve()
    for value in paths:
        try:
            path = Path(value).resolve()
            if path.parent == upload_root:
                path.unlink(missing_ok=True)
        except OSError:
            pass


def _character_public(character: dict | None) -> dict:
    if not character:
        return {}
    images = character.get("images") or []
    return {
        "id": character["id"],
        "name": character["name"],
        "description": character.get("description") or "",
        "image_count": len(images),
        "voice": bool(character.get("voice_file")),
        "preview_url": f"/characters/{character['id']}/image/0" if images else None,
        "created_at": character.get("created_at"),
        "updated_at": character.get("updated_at"),
    }


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


def get_system_status() -> dict:
    global _system_cache_at, _system_cache
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
        }

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
