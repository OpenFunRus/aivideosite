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
        if kind == "editor_export":
            return self._editor_export(job)
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
            db.update_job(
                job_id,
                progress=16,
                stage="LatentSync: освобождение VRAM от H3",
            )
            self._prepare_gpu_for_latentsync(job_id)

            self._check_cancel(job_id)
            db.update_job(job_id, progress=17, stage="LatentSync: проверка лица")
            latentsync_video, restore_info = self._prepare_face_safe_video(
                prepared_video,
                workdir,
                job_id,
                should_cancel,
            )
            raw_output_path = (
                workdir / "latentsync_raw.mp4"
                if restore_info is not None
                else output_path
            )

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
                str(latentsync_video),
                "--audio_path",
                str(prepared_audio),
                "--video_out_path",
                str(raw_output_path),
            ]
            run_command(
                command,
                cwd=settings.latentsync_dir,
                timeout=7200,
                should_cancel=should_cancel,
                env_overrides={
                    "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
                },
            )
            self._check_cancel(job_id)

            if restore_info is not None:
                db.update_job(
                    job_id,
                    progress=93,
                    stage="LipSync: восстановление исходного кадра",
                )
                self._restore_face_safe_video(
                    raw_output_path,
                    output_path,
                    restore_info,
                    should_cancel,
                )

            db.update_job(job_id, progress=95, stage="LipSync: сохранение")

            if not output_path.is_file():
                raise RuntimeError("LatentSync finished without producing output video.")

            metadata = {
                **_generation_context(source),
                "operation": "lipsync",
                "audio_start": start,
                "steps": steps,
                "guidance": guidance,
                "face_safe_scale": (
                    restore_info.get("scale") if restore_info is not None else 1.0
                ),
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

    def _prepare_gpu_for_latentsync(self, job_id: str) -> None:
        """Unload ComfyUI models and wait until enough VRAM is actually free."""
        self._check_cancel(job_id)

        if self._comfy.health():
            if not self._comfy.free_memory():
                raise RuntimeError(
                    "ComfyUI did not accept the VRAM release request."
                )

        deadline = time.monotonic() + 90
        last_free_mb: int | None = None
        last_total_mb: int | None = None

        while time.monotonic() < deadline:
            self._check_cancel(job_id)
            free_mb, total_mb = _gpu_memory_mb()
            if free_mb is None or total_mb is None:
                # If nvidia-smi is unexpectedly unavailable, do not block
                # forever. ComfyUI's /free request is still authoritative.
                time.sleep(2)
                return

            last_free_mb = free_mb
            last_total_mb = total_mb
            db.update_job(
                job_id,
                progress=17,
                stage=(
                    "LatentSync: ожидание VRAM "
                    f"({free_mb / 1024:.1f} / {total_mb / 1024:.1f} ГБ свободно)"
                ),
            )

            # LatentSync 1.6 needs roughly 18 GiB. Keep a little headroom.
            if free_mb >= 19000:
                return
            time.sleep(1)

        used_text = "неизвестно"
        if last_free_mb is not None and last_total_mb is not None:
            used_mb = max(0, last_total_mb - last_free_mb)
            used_text = (
                f"свободно {last_free_mb / 1024:.1f} ГБ из "
                f"{last_total_mb / 1024:.1f} ГБ; занято {used_mb / 1024:.1f} ГБ"
            )
        processes = _gpu_processes_summary()
        extra = f" GPU-процессы: {processes}" if processes else ""
        raise RuntimeError(
            "Не удалось освободить достаточно VRAM для LatentSync: "
            f"{used_text}.{extra}"
        )

    def _prepare_face_safe_video(
        self,
        prepared_video: Path,
        workdir: Path,
        job_id: str,
        should_cancel: Callable[[], bool],
    ) -> tuple[Path, dict[str, Any] | None]:
        """
        Verify every frame with LatentSync's own InsightFace detector.
        For extreme close-ups, progressively shrink the temporary frame and
        add disposable margins until the detector can see the whole face.
        """
        initial = self._latentsync_face_preflight(prepared_video, should_cancel)
        if initial.get("ok"):
            return prepared_video, None

        size = probe_video_size(prepared_video)
        if size is None:
            raise RuntimeError("Could not determine video dimensions for LipSync.")
        width, height = size
        failed_frame = initial.get("failed_frame")

        for scale in (0.85, 0.75, 0.65):
            self._check_cancel(job_id)
            safe_w = max(2, int(width * scale) // 2 * 2)
            safe_h = max(2, int(height * scale) // 2 * 2)
            x = (width - safe_w) // 2
            y = (height - safe_h) // 2
            safe_path = workdir / f"video_face_safe_{int(scale * 100)}.mp4"

            db.update_job(
                job_id,
                progress=17,
                stage=(
                    "LatentSync: лицо слишком крупно"
                    + (
                        f" (кадр {int(failed_frame) + 1})"
                        if failed_frame is not None
                        else ""
                    )
                    + f", пробую масштаб {int(scale * 100)}%"
                ),
            )

            run_command(
                [
                    str(settings.ffmpeg_bin),
                    "-y",
                    "-i",
                    str(prepared_video),
                    "-vf",
                    (
                        f"scale={safe_w}:{safe_h}:flags=lanczos,"
                        f"pad={width}:{height}:{x}:{y}:color=black"
                    ),
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "15",
                    "-pix_fmt",
                    "yuv420p",
                    str(safe_path),
                ],
                should_cancel=should_cancel,
            )

            check = self._latentsync_face_preflight(safe_path, should_cancel)
            if check.get("ok"):
                return safe_path, {
                    "scale": scale,
                    "safe_width": safe_w,
                    "safe_height": safe_h,
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                }
            failed_frame = check.get("failed_frame")

        frame_text = (
            f" на кадре {int(failed_frame) + 1}"
            if failed_frame is not None
            else ""
        )
        raise RuntimeError(
            "LatentSync не смог стабильно определить лицо"
            f"{frame_text} даже после автоматического уменьшения. "
            "Нужен кадр, где лицо целиком помещается в изображение и не закрыто."
        )

    def _latentsync_face_preflight(
        self,
        video_path: Path,
        should_cancel: Callable[[], bool],
    ) -> dict[str, Any]:
        checker = settings.root_dir / "app" / "latentsync_face_check.py"
        result = run_command(
            [
                str(settings.latentsync_python),
                str(checker),
                "--video",
                str(video_path),
                "--latentsync-dir",
                str(settings.latentsync_dir),
            ],
            cwd=settings.latentsync_dir,
            timeout=600,
            should_cancel=should_cancel,
            env_overrides={
                "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
            },
        )

        for line in reversed(result.stdout.splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and "ok" in data:
                return data

        raise RuntimeError(
            "LatentSync face preflight finished without a readable result."
        )

    def _restore_face_safe_video(
        self,
        raw_output_path: Path,
        output_path: Path,
        info: dict[str, Any],
        should_cancel: Callable[[], bool],
    ) -> None:
        if not raw_output_path.is_file():
            raise RuntimeError("LatentSync did not produce an intermediate video.")

        safe_w = int(info["safe_width"])
        safe_h = int(info["safe_height"])
        x = int(info["x"])
        y = int(info["y"])
        width = int(info["width"])
        height = int(info["height"])

        run_command(
            [
                str(settings.ffmpeg_bin),
                "-y",
                "-i",
                str(raw_output_path),
                "-vf",
                (
                    f"crop={safe_w}:{safe_h}:{x}:{y},"
                    f"scale={width}:{height}:flags=lanczos"
                ),
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "15",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "copy",
                str(output_path),
            ],
            should_cancel=should_cancel,
        )

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
                metadata={
                    **_generation_context(source),
                    "operation": "audio_replace",
                    "audio_start": start,
                },
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
                metadata={
                    **_generation_context(source),
                    "operation": "audio_remove",
                },
                size_bytes=output_path.stat().st_size,
                duration=probe_duration(output_path),
            )
            return media_id
        except JobCancelled:
            output_path.unlink(missing_ok=True)
            raise

    def _editor_export(self, job: dict[str, Any]) -> str:
        payload = job["payload"]
        job_id = job["id"]
        clip_specs = payload.get("clips") or []
        if not clip_specs:
            raise RuntimeError("Timeline is empty.")

        sources: list[dict[str, Any]] = []
        total_duration = 0.0
        for spec in clip_specs:
            source = _require_media(str(spec["media_id"]))
            source_path = settings.library_dir / source["filename"]
            duration = probe_duration(source_path)
            if not duration or duration <= 0:
                raise RuntimeError(
                    f"Could not determine duration for '{source['title']}'."
                )
            volume = max(0.0, min(2.0, float(spec.get("volume", 1.0))))
            sources.append(
                {
                    "media": source,
                    "path": source_path,
                    "duration": float(duration),
                    "volume": volume,
                    "has_audio": probe_has_audio(source_path),
                }
            )
            total_duration += float(duration)

        output_size = probe_video_size(sources[0]["path"])
        if output_size is None:
            raise RuntimeError("Could not determine output video dimensions.")
        width, height = output_size
        width -= width % 2
        height -= height % 2
        if width < 2 or height < 2:
            raise RuntimeError("Invalid output video dimensions.")

        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_edit.mp4"
        audio_path_value = payload.get("audio_path")
        audio_path = Path(audio_path_value) if audio_path_value else None
        audio_settings = payload.get("audio") or {}
        use_audio_track = bool(audio_settings.get("enabled")) and audio_path is not None
        if use_audio_track and not audio_path.is_file():
            raise RuntimeError("Editor audio track file is missing.")

        should_cancel = lambda: db.is_cancel_requested(job_id)
        command = [str(settings.ffmpeg_bin), "-y"]
        for source in sources:
            command.extend(["-i", str(source["path"])])
        if use_audio_track:
            command.extend(["-i", str(audio_path)])

        filters: list[str] = []
        concat_parts: list[str] = []
        for index, source in enumerate(sources):
            duration = source["duration"]
            filters.append(
                f"[{index}:v:0]"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                "setsar=1,setpts=PTS-STARTPTS,fps=24,format=yuv420p"
                f"[v{index}]"
            )
            if source["has_audio"] and source["volume"] > 0:
                filters.append(
                    f"[{index}:a:0]"
                    "aresample=48000,"
                    "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"volume={source['volume']:.4f},"
                    f"apad,atrim=duration={duration:.6f},asetpts=PTS-STARTPTS"
                    f"[a{index}]"
                )
            else:
                filters.append(
                    "anullsrc=r=48000:cl=stereo,"
                    f"atrim=duration={duration:.6f},asetpts=PTS-STARTPTS"
                    f"[a{index}]"
                )
            concat_parts.append(f"[v{index}][a{index}]")

        filters.append(
            "".join(concat_parts)
            + f"concat=n={len(sources)}:v=1:a=1[vcat][acat]"
        )

        if use_audio_track:
            audio_input = len(sources)
            offset = max(0.0, float(audio_settings.get("offset") or 0.0))
            trim_start = max(0.0, float(audio_settings.get("trim_start") or 0.0))
            trim_duration = max(
                0.0,
                float(audio_settings.get("trim_duration") or 0.0),
            )
            track_volume = max(
                0.0,
                min(2.0, float(audio_settings.get("volume", 1.0))),
            )
            trim_filter = f"atrim=start={trim_start:.6f}"
            if trim_duration > 0:
                trim_filter += f":duration={trim_duration:.6f}"
            delay_ms = int(round(offset * 1000))
            filters.append(
                f"[{audio_input}:a:0]"
                "aresample=48000,"
                "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"{trim_filter},asetpts=PTS-STARTPTS,"
                f"volume={track_volume:.4f},"
                f"adelay={delay_ms}:all=1,"
                f"apad,atrim=duration={total_duration:.6f}"
                "[track]"
            )
            filters.append(
                "[acat][track]"
                "amix=inputs=2:duration=first:dropout_transition=0:normalize=0"
                "[aout]"
            )
        else:
            filters.append("[acat]anull[aout]")

        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[vcat]",
                "-map",
                "[aout]",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "24",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
        )

        try:
            self._check_cancel(job_id)
            db.update_job(job_id, progress=8, stage="Монтаж: подготовка клипов")
            db.update_job(job_id, progress=18, stage="FFmpeg: склейка таймлайна")
            run_command(
                command,
                timeout=7200,
                should_cancel=should_cancel,
            )
            self._check_cancel(job_id)
            db.update_job(job_id, progress=95, stage="Монтаж: сохранение")

            if not output_path.is_file():
                raise RuntimeError("FFmpeg finished without producing the edited video.")

            title = str(payload.get("title") or "Монтаж").strip() or "Монтаж"
            db.insert_media(
                media_id=media_id,
                filename=output_path.name,
                kind="edited",
                title=title,
                parent_id=None,
                metadata={
                    "operation": "editor_export",
                    "clip_count": len(sources),
                    "source_media_ids": [
                        source["media"]["id"] for source in sources
                    ],
                    "clip_volumes": [source["volume"] for source in sources],
                    "audio_track": use_audio_track,
                    "audio_offset": (
                        float(audio_settings.get("offset") or 0.0)
                        if use_audio_track
                        else None
                    ),
                    "audio_trim_start": (
                        float(audio_settings.get("trim_start") or 0.0)
                        if use_audio_track
                        else None
                    ),
                    "audio_trim_duration": (
                        float(audio_settings.get("trim_duration") or 0.0)
                        if use_audio_track
                        else None
                    ),
                    "audio_volume": (
                        float(audio_settings.get("volume", 1.0))
                        if use_audio_track
                        else None
                    ),
                    "width": width,
                    "height": height,
                    "fps": 24,
                },
                size_bytes=output_path.stat().st_size,
                duration=probe_duration(output_path),
            )
            if audio_path is not None:
                _remove_uploads([audio_path])
            return media_id
        except Exception:
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


def _generation_context(source: dict[str, Any]) -> dict[str, Any]:
    meta = source.get("meta") or {}
    keys = (
        "prompt",
        "width",
        "height",
        "seconds",
        "fps",
        "profile",
        "seed",
        "generate_audio",
        "reference_count",
        "comfy_prompt_id",
    )
    return {key: meta.get(key) for key in keys if key in meta}


def _prompt_title(prompt: str) -> str:
    compact = " ".join(prompt.split())
    if len(compact) <= 64:
        return compact or "MiniMax H3"
    return compact[:61].rstrip() + "..."


def probe_video_size(path: Path) -> tuple[int, int] | None:
    try:
        result = subprocess.run(
            [
                str(settings.ffprobe_bin),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
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
        stream = (payload.get("streams") or [])[0]
        width = int(stream["width"])
        height = int(stream["height"])
        if width <= 0 or height <= 0:
            return None
        return width, height
    except Exception:
        return None


def probe_has_audio(path: Path) -> bool:
    try:
        result = subprocess.run(
            [
                str(settings.ffprobe_bin),
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return bool(result.stdout.strip())
    except Exception:
        return False


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
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    child_env = os.environ.copy()
    if env_overrides:
        child_env.update(env_overrides)

    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            cwd=str(cwd) if cwd else None,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            env=child_env,
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


def _gpu_memory_mb() -> tuple[int | None, int | None]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free,memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        line = result.stdout.strip().splitlines()[0]
        free_text, total_text = [part.strip() for part in line.split(",")[:2]]
        return int(free_text), int(total_text)
    except Exception:
        return None, None


def _gpu_processes_summary() -> str:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_gpu_memory",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return "; ".join(lines[:8])
    except Exception:
        return ""


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
