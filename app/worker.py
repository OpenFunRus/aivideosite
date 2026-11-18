from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import db
from .comfy import ComfyUIClient, ComfyUICancelled
from .config import settings


class JobCancelled(RuntimeError):
    pass


class JobWorker(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="aivideosite-gpu-worker", daemon=True)
        self._stop_event = threading.Event()
        self._comfy = ComfyUIClient()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            job = db.claim_next_job()
            if job is None:
                self._stop_event.wait(1.0)
                continue

            try:
                media_id = self._process(job)
                if db.is_cancel_requested(job["id"]):
                    db.mark_cancelled(job["id"])
                else:
                    db.complete_job(job["id"], media_id)
            except (JobCancelled, ComfyUICancelled):
                db.mark_cancelled(job["id"])
            except Exception as exc:
                if db.is_cancel_requested(job["id"]):
                    db.mark_cancelled(job["id"])
                else:
                    db.fail_job(job["id"], _format_error(exc))

    def _process(self, job: dict[str, Any]) -> str | None:
        self._check_cancel(job["id"])
        kind = job["kind"]
        if kind == "generate":
            return self._generate(job)
        if kind == "lipsync":
            return self._lipsync(job)
        if kind == "audio_replace":
            return self._replace_audio(job)
        if kind == "audio_remove":
            return self._remove_audio(job)
        raise RuntimeError(f"Unknown job type: {kind}")

    @staticmethod
    def _check_cancel(job_id: str) -> None:
        if db.is_cancel_requested(job_id):
            raise JobCancelled("Task cancelled by user.")

    def _generate(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        job_id = job["id"]
        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}.mp4"

        if not self._comfy.health():
            raise RuntimeError(
                "ComfyUI is not reachable at "
                f"{settings.comfyui_url}. Check comfyui.service."
            )

        def should_cancel() -> bool:
            return db.is_cancel_requested(job_id)

        def progress(value: float, stage: str) -> None:
            self._check_cancel(job_id)
            db.update_job(job_id, progress=value, stage=stage)

        try:
            result = self._comfy.generate_h3(
                job_id=job_id,
                payload=payload,
                destination=output_path,
                progress=progress,
                on_prompt_id=lambda prompt_id: db.update_job(
                    job_id, external_id=prompt_id
                ),
                should_cancel=should_cancel,
            )
            self._check_cancel(job_id)

            duration = probe_duration(output_path)
            title = _prompt_title(payload.get("prompt") or "H3 video")
            metadata = {
                "operation": "generate",
                "prompt": payload.get("prompt", ""),
                "width": payload.get("width"),
                "height": payload.get("height"),
                "seconds": payload.get("seconds"),
                "fps": payload.get("fps"),
                "profile": payload.get("profile"),
                "seed": result.get("seed"),
                "generate_audio": bool(payload.get("generate_audio", False)),
                "reference_count": len(payload.get("images") or []),
                "comfy_prompt_id": result.get("prompt_id"),
            }

            db.insert_media(
                media_id=media_id,
                filename=output_path.name,
                kind="generated",
                title=title,
                parent_id=None,
                metadata=metadata,
                size_bytes=output_path.stat().st_size,
                duration=duration,
            )
            _remove_uploads(payload.get("images") or [])
            return media_id
        except (JobCancelled, ComfyUICancelled):
            output_path.unlink(missing_ok=True)
            raise

    def _lipsync(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        job_id = job["id"]
        source = _require_media(payload["media_id"])
        source_path = settings.library_dir / source["filename"]
        audio_path = Path(payload["audio_path"])
        if not audio_path.is_file():
            raise RuntimeError("Lip-sync audio file is missing.")

        duration = probe_duration(source_path)
        if not duration or duration <= 0:
            raise RuntimeError("Could not determine source video duration.")

        workdir = settings.temp_dir / job_id
        if workdir.exists():
            shutil.rmtree(workdir, ignore_errors=True)
        workdir.mkdir(parents=True, exist_ok=True)

        prepared_video = workdir / "video_25fps.mp4"
        prepared_audio = workdir / "vocal_16k.wav"
        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_lipsync.mp4"
        should_cancel = lambda: db.is_cancel_requested(job_id)

        try:
            self._check_cancel(job_id)
            db.update_job(job_id, progress=5, stage="LipSync: подготовка видео")
            run_command(
                [
                    str(settings.ffmpeg_bin),
                    "-y",
                    "-i",
                    str(source_path),
                    "-vf",
                    "fps=25",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "15",
                    "-pix_fmt",
                    "yuv420p",
                    str(prepared_video),
                ],
                should_cancel=should_cancel,
            )

            self._check_cancel(job_id)
            db.update_job(job_id, progress=12, stage="LipSync: подготовка вокала")
            start = max(0.0, float(payload.get("audio_start") or 0))
            run_command(
                [
                    str(settings.ffmpeg_bin),
                    "-y",
                    "-ss",
                    f"{start:.3f}",
                    "-i",
                    str(audio_path),
                    "-t",
                    f"{duration:.3f}",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(prepared_audio),
                ],
                should_cancel=should_cancel,
            )

            steps = int(payload.get("steps") or 20)
            guidance = float(payload.get("guidance") or 1.5)

            self._check_cancel(job_id)
            db.update_job(job_id, progress=18, stage="LatentSync: синхронизация губ")
            command = [
                str(settings.latentsync_python),
                "-m",
                "scripts.inference",
                "--unet_config_path",
                "configs/unet/stage2_512.yaml",
                "--inference_ckpt_path",
                "checkpoints/latentsync_unet.pt",
                "--inference_steps",
                str(steps),
                "--guidance_scale",
                str(guidance),
                "--enable_deepcache",
                "--video_path",
                str(prepared_video),
                "--audio_path",
                str(prepared_audio),
                "--video_out_path",
                str(output_path),
            ]
            run_command(
                command,
                cwd=settings.latentsync_dir,
                timeout=7200,
                should_cancel=should_cancel,
            )
            self._check_cancel(job_id)
            db.update_job(job_id, progress=95, stage="LipSync: сохранение")

            if not output_path.is_file():
                raise RuntimeError("LatentSync finished without producing output video.")

            metadata = {
                "operation": "lipsync",
                "audio_start": start,
                "steps": steps,
                "guidance": guidance,
            }
            db.insert_media(
                media_id=media_id,
                filename=output_path.name,
                kind="lipsync",
                title=f"{source['title']} · LipSync",
                parent_id=source["id"],
                metadata=metadata,
                size_bytes=output_path.stat().st_size,
                duration=probe_duration(output_path),
            )
            _remove_uploads([audio_path])
            return media_id
        except JobCancelled:
            output_path.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _replace_audio(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        job_id = job["id"]
        source = _require_media(payload["media_id"])
        source_path = settings.library_dir / source["filename"]
        audio_path = Path(payload["audio_path"])
        if not audio_path.is_file():
            raise RuntimeError("Audio file is missing.")

        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_audio.mp4"
        start = max(0.0, float(payload.get("audio_start") or 0))
        should_cancel = lambda: db.is_cancel_requested(job_id)

        try:
            db.update_job(job_id, progress=15, stage="FFmpeg: наложение аудио")
            run_command(
                [
                    str(settings.ffmpeg_bin),
                    "-y",
                    "-i",
                    str(source_path),
                    "-ss",
                    f"{start:.3f}",
                    "-i",
                    str(audio_path),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-shortest",
                    str(output_path),
                ],
                should_cancel=should_cancel,
            )
            self._check_cancel(job_id)
            db.update_job(job_id, progress=95, stage="FFmpeg: сохранение")

            db.insert_media(
                media_id=media_id,
                filename=output_path.name,
                kind="audio",
                title=f"{source['title']} · Audio",
                parent_id=source["id"],
                metadata={"operation": "audio_replace", "audio_start": start},
                size_bytes=output_path.stat().st_size,
                duration=probe_duration(output_path),
            )
            _remove_uploads([audio_path])
            return media_id
        except JobCancelled:
            output_path.unlink(missing_ok=True)
            raise

    def _remove_audio(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        job_id = job["id"]
        source = _require_media(payload["media_id"])
        source_path = settings.library_dir / source["filename"]

        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_silent.mp4"

        try:
            db.update_job(job_id, progress=20, stage="FFmpeg: удаление аудио")
            run_command(
                [
                    str(settings.ffmpeg_bin),
                    "-y",
                    "-i",
                    str(source_path),
                    "-map",
                    "0:v:0",
                    "-c:v",
                    "copy",
                    "-an",
                    str(output_path),
                ],
                should_cancel=lambda: db.is_cancel_requested(job_id),
            )
            self._check_cancel(job_id)

            db.insert_media(
                media_id=media_id,
                filename=output_path.name,
                kind="silent",
                title=f"{source['title']} · Без звука",
                parent_id=source["id"],
                metadata={"operation": "audio_remove"},
                size_bytes=output_path.stat().st_size,
                duration=probe_duration(output_path),
            )
            return media_id
        except JobCancelled:
            output_path.unlink(missing_ok=True)
            raise


def _require_media(media_id: str) -> dict[str, Any]:
    media = db.get_media(media_id)
    if media is None:
        raise RuntimeError("Video no longer exists in the library.")
    path = settings.library_dir / media["filename"]
    if not path.is_file():
        raise RuntimeError("Video file is missing from the library.")
    return media


def _prompt_title(prompt: str) -> str:
    compact = " ".join(prompt.split())
    if len(compact) <= 64:
        return compact or "MiniMax H3"
    return compact[:61].rstrip() + "..."


def probe_duration(path: Path) -> float | None:
    try:
        result = subprocess.run(
            [
                str(settings.ffprobe_bin),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        payload = json.loads(result.stdout)
        return round(float(payload["format"]["duration"]), 3)
    except Exception:
        return None


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 3600,
    should_cancel: Callable[[], bool] | None = None,
) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            cwd=str(cwd) if cwd else None,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            env=os.environ.copy(),
            start_new_session=True,
        )

        while True:
            return_code = process.poll()
            if return_code is not None:
                break

            if should_cancel and should_cancel():
                _terminate_process_group(process)
                raise JobCancelled("Task cancelled by user.")

            if time.monotonic() - started > timeout:
                _terminate_process_group(process)
                raise TimeoutError(
                    f"Command timed out after {timeout}s: {' '.join(command[:5])}"
                )
            time.sleep(0.35)

        log.flush()
        log.seek(0)
        output = log.read()

    if return_code != 0:
        raise RuntimeError(
            f"Command failed ({return_code}): {' '.join(command[:5])}\n"
            f"{output[-6000:]}"
        )

    return subprocess.CompletedProcess(command, return_code, output, "")


def _terminate_process_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def _remove_uploads(paths: list[Any]) -> None:
    for value in paths:
        try:
            path = Path(value)
            if path.parent.resolve() == settings.upload_dir.resolve():
                path.unlink(missing_ok=True)
        except Exception:
            pass


def _format_error(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return f"{exc.__class__.__name__}: {text}"
