from __future__ import annotations

import hmac
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
async def api_state(_: None = Depends(require_auth)):
    return {
        "jobs": db.list_jobs(80),
        "media": db.list_media(120),
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
    if seconds < 0.2 or seconds > 30:
        raise HTTPException(400, "Длительность должна быть от 0.2 до 30 секунд.")
    if fps < 1 or fps > 60:
        raise HTTPException(400, "FPS вне допустимого диапазона.")
    if profile not in {"fast", "quality"}:
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
            "images": image_paths,
        },
    )
    return {"ok": True, "job_id": job_id}


@app.post("/api/media/{media_id}/lipsync")
async def api_lipsync(
    media_id: str,
    audio: UploadFile = File(...),
    audio_start: Annotated[float, Form()] = 0.0,
    steps: Annotated[int, Form()] = 20,
    guidance: Annotated[float, Form()] = 1.5,
    _: None = Depends(require_auth),
):
    _ensure_media(media_id)
    if steps < 10 or steps > 60:
        raise HTTPException(400, "Steps должны быть от 10 до 60.")
    if guidance < 1.0 or guidance > 3.0:
        raise HTTPException(400, "Guidance должен быть от 1.0 до 3.0.")

    audio_path = await save_upload(
        audio,
        kind="audio",
        max_bytes=settings.max_audio_upload_bytes,
    )
    job_id = uuid.uuid4().hex
    db.enqueue_job(
        job_id,
        "lipsync",
        {
            "media_id": media_id,
            "audio_path": str(audio_path),
            "audio_start": max(0.0, audio_start),
            "steps": steps,
            "guidance": guidance,
        },
    )
    return {"ok": True, "job_id": job_id}


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


@app.delete("/api/media/{media_id}")
async def api_delete_media(
    media_id: str,
    _: None = Depends(require_auth),
):
    media = _ensure_media(media_id)
    for job in db.list_jobs(200):
        if job["status"] not in {"queued", "running"}:
            continue
        if (job.get("payload") or {}).get("media_id") == media_id:
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
