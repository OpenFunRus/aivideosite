from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import db
from .comfy import ComfyUIClient
from .config import settings


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
                db.complete_job(job["id"], media_id)
            except Exception as exc:
                db.fail_job(job["id"], _format_error(exc))

    def _process(self, job: dict[str, Any]) -> str | None:
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

        def progress(value: float, stage: str) -> None:
            db.update_job(job_id, progress=value, stage=stage)

        result = self._comfy.generate_h3(
            job_id=job_id,
            payload=payload,
            destination=output_path,
            progress=progress,
        )

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

        try:
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
                ]
            )

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
                ]
            )

            steps = int(payload.get("steps") or 20)
            guidance = float(payload.get("guidance") or 1.5)

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
            run_command(command, cwd=settings.latentsync_dir, timeout=7200)
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
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _replace_audio(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        source = _require_media(payload["media_id"])
        source_path = settings.library_dir / source["filename"]
        audio_path = Path(payload["audio_path"])
        if not audio_path.is_file():
            raise RuntimeError("Audio file is missing.")

        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_audio.mp4"
        start = max(0.0, float(payload.get("audio_start") or 0))

        db.update_job(job["id"], progress=15, stage="FFmpeg: наложение аудио")
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
            ]
        )
        db.update_job(job["id"], progress=95, stage="FFmpeg: сохранение")

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

    def _remove_audio(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        source = _require_media(payload["media_id"])
        source_path = settings.library_dir / source["filename"]

        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_silent.mp4"

        db.update_job(job["id"], progress=20, stage="FFmpeg: удаление аудио")
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
            ]
        )

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
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        combined = "\n".join(
            part for part in (result.stdout, result.stderr) if part
        )
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(command[:5])}\n"
            f"{combined[-6000:]}"
        )
    return result


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
