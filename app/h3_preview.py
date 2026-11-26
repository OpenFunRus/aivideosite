"""Short-lived, owner-protected previews for running MiniMax H3 jobs."""

from __future__ import annotations

import os
import logging
import re
import subprocess
import uuid
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from . import db
from .config import settings


PREVIEW_MIME_EXTENSIONS = {
    "video/mp4": ".mp4",
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
}
PREVIEW_ROOT = settings.temp_dir / "h3_previews"
MAX_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_POSTER_BYTES = 2 * 1024 * 1024
_JOB_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
logger = logging.getLogger(__name__)


def _valid_step(step: int) -> bool:
    return isinstance(step, int) and 2 <= step <= 24 and step % 2 == 0


def preview_path(job_id: str, mime: str, step: int) -> Path | None:
    extension = PREVIEW_MIME_EXTENSIONS.get(mime)
    if not extension or not _JOB_ID_RE.fullmatch(job_id) or not _valid_step(step):
        return None
    return PREVIEW_ROOT / f"{job_id}.step{step}{extension}"


def preview_poster_path(job_id: str, step: int) -> Path | None:
    if not _JOB_ID_RE.fullmatch(job_id) or not _valid_step(step):
        return None
    return PREVIEW_ROOT / f"{job_id}.step{step}.poster.jpg"


def find_job_preview(job_id: str, step: int) -> tuple[Path, str] | None:
    for mime in PREVIEW_MIME_EXTENSIONS:
        path = preview_path(job_id, mime, step)
        if path is not None and path.is_file():
            return path, mime
    return None


def list_job_previews(job_id: str, latest_step: int) -> list[dict[str, str | int]]:
    result: list[dict[str, str | int]] = []
    for step in range(2, min(max(0, int(latest_step)), 24) + 1, 2):
        item = find_job_preview(job_id, step)
        if item is not None:
            result.append({"step": step, "mime": item[1]})
    return result


def _valid_content(mime: str, content: bytes) -> bool:
    if not content or len(content) > MAX_PREVIEW_BYTES:
        return False
    if mime == "video/mp4":
        return len(content) >= 12 and content[4:8] == b"ftyp"
    if mime == "image/webp":
        return len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    if mime == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    return False


def _make_preview_poster(mime: str, content: bytes) -> bytes | None:
    """Extract the first image frame (Pillow for WebP, FFmpeg for MP4)."""
    if mime in {"image/webp", "image/jpeg"}:
        try:
            with Image.open(BytesIO(content)) as source:
                source.seek(0)
                first = source.convert("RGB")
                first.thumbnail((640, 640), Image.Resampling.LANCZOS)
                output = BytesIO()
                first.save(output, format="JPEG", quality=84)
                poster = output.getvalue()
                return poster if len(poster) <= MAX_POSTER_BYTES else None
        except (UnidentifiedImageError, ValueError, OSError) as exc:
            logger.warning("H3 preview image poster unavailable: %s", exc)
            return None
    try:
        completed = subprocess.run(
            [
                str(settings.ffmpeg_bin), "-hide_banner", "-loglevel", "error",
                "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe",
                "-vcodec", "mjpeg", "-q:v", "4", "pipe:1",
            ],
            input=content, capture_output=True, timeout=8, check=False,
        )
        if (completed.returncode == 0 and completed.stdout.startswith(b"\xff\xd8\xff")
                and len(completed.stdout) <= MAX_POSTER_BYTES):
            return completed.stdout
        logger.warning("H3 preview poster failed for %s: %s", mime, completed.stderr[-400:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("H3 preview poster unavailable: %s", exc)
    return None


def save_job_preview(job_id: str, step: int, mime: str, content: bytes) -> bool:
    """Store separate immutable even-step previews; never publish cancelled work."""
    target = preview_path(job_id, mime, step)
    poster_target = preview_poster_path(job_id, step)
    if target is None or poster_target is None or not _valid_content(mime, content):
        return False
    if target.is_file():
        # Already have this immutable step. In particular, do not delete it
        # when duplicate WebSocket events arrive after a newer step.
        return False
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    temporary = PREVIEW_ROOT / f".{job_id}.{uuid.uuid4().hex}.tmp"
    poster_temporary = PREVIEW_ROOT / f".{job_id}.{uuid.uuid4().hex}.poster.tmp"
    try:
        temporary.write_bytes(content)
        poster = _make_preview_poster(mime, content)
        if poster:
            poster_temporary.write_bytes(poster)
        os.replace(temporary, target)
        if poster:
            os.replace(poster_temporary, poster_target)
        if not db.set_job_preview(job_id, step, mime):
            state = db.get_job(job_id)
            if (
                state is not None and state["status"] == "running"
                and not state["cancel_requested"]
                and int(state.get("preview_step") or 0) >= step
            ):
                # A late but valid older step remains available for comparison.
                return True
            target.unlink(missing_ok=True)
            poster_target.unlink(missing_ok=True)
            return False
        return True
    finally:
        temporary.unlink(missing_ok=True)
        poster_temporary.unlink(missing_ok=True)


def cleanup_job_preview(job_id: str) -> None:
    for step in range(2, 25, 2):
        for mime in PREVIEW_MIME_EXTENSIONS:
            path = preview_path(job_id, mime, step)
            if path is not None:
                path.unlink(missing_ok=True)
        poster = preview_poster_path(job_id, step)
        if poster is not None:
            poster.unlink(missing_ok=True)


def cleanup_stale_previews() -> None:
    """Previews cannot survive service restarts (running jobs are requeued)."""
    if not PREVIEW_ROOT.is_dir():
        return
    for path in PREVIEW_ROOT.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
