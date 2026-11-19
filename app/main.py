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
from .worker import JobWorker


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


def _is_authenticated(request: Request) -> bool:
    return request.session.get("authenticated") is True


def require_auth(request: Request) -> None:
    if not _is_authenticated(request):
        raise HTTPException(status_code=401, detail="Authentication required")


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
    if hmac.compare_digest(password, settings.site_password):
        request.session.clear()
        request.session["authenticated"] = True
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
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={},
    )


@app.get("/api/state")
async def api_state(
    media_page: int = Query(1, ge=1),
    jobs_page: int = Query(1, ge=1),
    _: None = Depends(require_auth),
):
    media_data = db.list_media_page(media_page, 20)
    jobs_data = db.list_jobs_page(jobs_page, 20)
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
        "counts": db.state_counts(),
        "system": get_system_status(),
    }


@app.post("/api/generate")
async def api_generate(
    request: Request,
    prompt: Annotated[str, Form()],
    width: Annotated[int, Form()] = 1344,
    height: Annotated[int, Form()] = 768,
    seconds: Annotated[float, Form()] = 5.0,
    fps: Annotated[float, Form()] = 24.0,
    profile: Annotated[str, Form()] = "fast",
    seed: Annotated[int, Form()] = -1,
    generate_audio: Annotated[bool, Form()] = False,
    first_frame: UploadFile | None = File(None),
    last_frame: UploadFile | None = File(None),
    _: None = Depends(require_auth),
):
    del request

    prompt = " ".join(prompt.split()) if "\n" not in prompt else prompt.strip()
    if not prompt:
        raise HTTPException(400, "Введите prompt.")
    if len(prompt) > 12000:
        raise HTTPException(400, "Prompt слишком длинный.")

    if width < 256 or width > 2048 or height < 256 or height > 2048:
        raise HTTPException(400, "Размер должен быть от 256 до 2048.")
    if width % 32 or height % 32:
        raise HTTPException(400, "Ширина и высота должны делиться на 32.")
    if seconds < 1 or seconds > 30:
        raise HTTPException(400, "Длительность должна быть от 1 до 30 секунд.")
    allowed_fps = {12.0, 16.0, 20.0, 24.0, 25.0, 30.0}
    if float(fps) not in allowed_fps:
        raise HTTPException(400, "Поддерживаются FPS: 12, 16, 20, 24, 25, 30.")
    if profile not in {"fast", "quality", "max"}:
        raise HTTPException(400, "Неизвестный профиль.")

    image_paths: list[str] = []
    for upload in (first_frame, last_frame):
        if upload is not None and upload.filename:
            path = await save_upload(
                upload,
                kind="image",
                max_bytes=settings.max_image_upload_bytes,
            )
            image_paths.append(str(path))

    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "generate",
        {
            "prompt": prompt,
            "width": width,
            "height": height,
            "seconds": seconds,
            "fps": fps,
            "profile": profile,
            "seed": seed,
            "generate_audio": bool(generate_audio),
            "images": image_paths,
        },
    )
    return {"ok": True, "job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel_job(
    job_id: str,
    _: None = Depends(require_auth),
):
    job = db.request_cancel(job_id)
    if job is None:
        raise HTTPException(404, "Задача не найдена.")

    if job["status"] == "running" and job["kind"] == "generate":
        prompt_id = job.get("external_id")
        if prompt_id:
            ComfyUIClient().cancel_prompt(str(prompt_id))

    return {"ok": True, "status": job["status"]}


@app.post("/api/jobs/{job_id}/retry")
async def api_retry_job(
    job_id: str,
    _: None = Depends(require_auth),
):
    source = db.get_job(job_id)
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
    audio_path = payload.get("audio_path")
    if audio_path and not Path(audio_path).is_file():
        missing.append(str(audio_path))
    for clip in payload.get("clips") or []:
        if not isinstance(clip, dict) or not clip.get("media_id"):
            continue
        media = db.get_media(str(clip["media_id"]))
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
    _: None = Depends(require_auth),
):
    try:
        job = db.delete_terminal_job(job_id)
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
    _: None = Depends(require_auth),
):
    jobs = db.clear_nonrunning_jobs()
    for job in jobs:
        _cleanup_job_uploads(job)
    counts = db.state_counts()
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
    _: None = Depends(require_auth),
):
    _ensure_media(media_id)
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
    )
    return {"ok": True, "job_id": job_id}


@app.post("/api/media/{media_id}/remove-audio")
async def api_remove_audio(
    media_id: str,
    _: None = Depends(require_auth),
):
    _ensure_media(media_id)
    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "audio_remove",
        {"media_id": media_id},
    )
    return {"ok": True, "job_id": job_id}


@app.get("/api/editor/media")
async def api_editor_media(
    _: None = Depends(require_auth),
):
    return {"items": db.list_media(500)}


@app.post("/api/editor/export")
async def api_editor_export(
    project: Annotated[str, Form()],
    audio: UploadFile | None = File(None),
    _: None = Depends(require_auth),
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
        _ensure_media(media_id)
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
    )
    return {"ok": True, "job_id": job_id}


@app.delete("/api/media")
async def api_clear_media(
    _: None = Depends(require_auth),
):
    protected_ids = db.active_media_ids()
    media_items = db.clear_media_except(protected_ids)
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
    _: None = Depends(require_auth),
):
    media = _ensure_media(media_id)
    if media_id in db.active_media_ids():
        raise HTTPException(409, "Этот ролик используется активной задачей.")

    path = settings.library_dir / media["filename"]
    path.unlink(missing_ok=True)
    db.delete_media_row(media_id)
    return {"ok": True}


@app.get("/media/{media_id}")
async def media_file(
    media_id: str,
    request: Request,
    _: None = Depends(require_auth),
):
    media = _ensure_media(media_id)
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


def _ensure_media(media_id: str) -> dict:
    media = db.get_media(media_id)
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
            "gpu": None,
            "disk_free": disk.free,
            "disk_total": disk.total,
        }

        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=3,
            )
            first = result.stdout.strip().splitlines()[0]
            parts = [part.strip() for part in first.split(",")]
            if len(parts) >= 5:
                status["gpu"] = {
                    "name": parts[0],
                    "memory_used_mb": int(parts[1]),
                    "memory_total_mb": int(parts[2]),
                    "utilization": int(parts[3]),
                    "temperature": int(parts[4]),
                }
        except Exception:
            pass

        _system_cache = status
        _system_cache_at = now
        return dict(status)
