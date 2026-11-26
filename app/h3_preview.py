"""Short-lived, owner-protected previews for running MiniMax H3 jobs."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from . import db
from .config import settings


PREVIEW_MIME_EXTENSIONS = {
    "video/mp4": ".mp4",
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
}
PREVIEW_ROOT = settings.temp_dir / "h3_previews"
MAX_PREVIEW_BYTES = 8 * 1024 * 1024
_JOB_ID_RE = re.compile(r"[0-9a-f]{32}\Z")


def preview_path(job_id: str, mime: str) -> Path | None:
    extension = PREVIEW_MIME_EXTENSIONS.get(mime)
    if not extension or not _JOB_ID_RE.fullmatch(job_id):
        return None
    return PREVIEW_ROOT / f"{job_id}{extension}"


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


def save_job_preview(job_id: str, step: int, mime: str, content: bytes) -> bool:
    """Atomically replace the current even-step preview; never publish cancelled work."""
    target = preview_path(job_id, mime)
    if target is None or step < 2 or step % 2 != 0 or not _valid_content(mime, content):
        return False
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    temporary = PREVIEW_ROOT / f".{job_id}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_bytes(content)
        os.replace(temporary, target)
        if not db.set_job_preview(job_id, step, mime):
            target.unlink(missing_ok=True)
            return False
        for other_mime in PREVIEW_MIME_EXTENSIONS:
            if other_mime != mime:
                other = preview_path(job_id, other_mime)
                if other is not None:
                    other.unlink(missing_ok=True)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def cleanup_job_preview(job_id: str) -> None:
    for mime in PREVIEW_MIME_EXTENSIONS:
        path = preview_path(job_id, mime)
        if path is not None:
            path.unlink(missing_ok=True)


def cleanup_stale_previews() -> None:
    """Previews cannot survive service restarts (running jobs are requeued)."""
    if not PREVIEW_ROOT.is_dir():
        return
    for path in PREVIEW_ROOT.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
