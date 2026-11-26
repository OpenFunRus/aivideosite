from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import db
from .comfy import ComfyUIClient, ComfyUICancelled
from .ai_repair import assembly_command
from .config import settings


class JobCancelled(RuntimeError):
    pass


LLM_MANAGER_URL = os.getenv("LLM_MANAGER_URL", "http://127.0.0.1:8091")


def _generation_elapsed_from_submission(job: dict[str, Any], completed_at: datetime) -> tuple[str, float]:
    """Count the whole job from queue submission through video/audio finalization."""
    started_at = str(job.get("created_at") or job.get("started_at") or "")
    try:
        elapsed = max(0.0, (completed_at - datetime.fromisoformat(started_at.replace("Z", "+00:00"))).total_seconds())
    except (TypeError, ValueError):
        elapsed = 0.0
    return started_at, round(elapsed, 1)


def _release_video_reservation(gpu_index:int,reservation_id:str)->None:
    payload=json.dumps({"gpu":int(gpu_index),"reservation_id":str(reservation_id)}).encode("utf-8")
    req=urllib.request.Request(f"{LLM_MANAGER_URL}/video/release",data=payload,headers={"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=10) as response:response.read()
    except (urllib.error.URLError,TimeoutError,OSError):pass


class JobWorker(threading.Thread):
    VIDEO_GENERATION_KINDS = {"generate"}
    CPU_KINDS = {"editor_export", "repair_export"}

    def __init__(self) -> None:
        super().__init__(name="aivideosite-dispatcher", daemon=True)
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._gpu_lanes: list[dict[str, Any]] = [
            {
                "key": "primary",
                "label": "RTX3090",
                "gpu_index": 0,
                "target": "rtx3090",
                "client": ComfyUIClient(settings.comfyui_url),
                "busy": False,
                "job_id": None,
            },
            {
                "key": "secondary",
                "label": "RTX2080",
                "gpu_index": 1,
                "target": "rtx2080",
                "client": ComfyUIClient(settings.comfyui_secondary_url),
                "busy": False,
                "job_id": None,
            },
        ]
        self._cpu_busy = False
        self._job_clients: dict[str, ComfyUIClient] = {}
        self._active_threads: set[threading.Thread] = set()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            dispatched = False

            primary = self._available_gpu_lane("primary")
            if primary is not None:
                job = db.claim_next_job(self.VIDEO_GENERATION_KINDS, gpu_target=str(primary["target"]), allow_unassigned=True)
                if job is not None:
                    self._start_gpu_job(primary, job)
                    dispatched = True

            secondary = self._available_gpu_lane("secondary")
            if secondary is not None:
                job = db.claim_next_job(self.VIDEO_GENERATION_KINDS, gpu_target=str(secondary["target"]))
                if job is not None:
                    self._start_gpu_job(secondary, job)
                    dispatched = True

            if self._cpu_lane_available():
                job = db.claim_next_job(self.CPU_KINDS)
                if job is not None:
                    self._start_cpu_job(job)
                    dispatched = True

            if not dispatched:
                self._stop_event.wait(0.35)

    def cancel_job(self, job_id: str, prompt_id: str | None) -> bool:
        with self._lock:
            client = self._job_clients.get(job_id)
        if client is None:
            return False
        return client.cancel_prompt(prompt_id) if prompt_id else True

    def _available_gpu_lane(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            for lane in self._gpu_lanes:
                if lane["key"] == key and not lane["busy"]:
                    return lane
        return None

    def _cpu_lane_available(self) -> bool:
        with self._lock:
            return not self._cpu_busy

    def _start_gpu_job(self, lane: dict[str, Any], job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        client = lane["client"]
        with self._lock:
            lane["busy"] = True
            lane["job_id"] = job_id
            self._job_clients[job_id] = client

        thread = threading.Thread(
            target=self._run_claimed_job,
            args=(job, client, str(lane["label"]), lane),
            name=f"aivideosite-{lane['key']}-{job_id[:8]}",
            daemon=True,
        )
        with self._lock:
            self._active_threads.add(thread)
        thread.start()

    def _start_cpu_job(self, job: dict[str, Any]) -> None:
        with self._lock:
            self._cpu_busy = True

        thread = threading.Thread(
            target=self._run_claimed_job,
            args=(job, None, None, None),
            name=f"aivideosite-cpu-{str(job['id'])[:8]}",
            daemon=True,
        )
        with self._lock:
            self._active_threads.add(thread)
        thread.start()

    def _run_claimed_job(
        self,
        job: dict[str, Any],
        comfy: ComfyUIClient | None,
        gpu_label: str | None,
        lane: dict[str, Any] | None,
    ) -> None:
        try:
            if gpu_label:
                db.update_job(
                    job["id"],
                    stage=f"H3 · {gpu_label}: запуск",
                )
            media_id = self._process(job, comfy=comfy, gpu_label=gpu_label)
            if db.is_cancel_requested(job["id"]) or not db.complete_job(job["id"], media_id):
                if media_id:
                    _discard_cancelled_result(str(media_id), str(job.get("owner_id") or "user1"))
                db.mark_cancelled(job["id"])
        except (JobCancelled, ComfyUICancelled):
            db.mark_cancelled(job["id"])
        except Exception as exc:
            if db.is_cancel_requested(job["id"]):
                db.mark_cancelled(job["id"])
            else:
                db.fail_job(job["id"], _format_error(exc))
        finally:
            current = threading.current_thread()
            with self._lock:
                self._active_threads.discard(current)
                if lane is not None:
                    lane["busy"] = False
                    lane["job_id"] = None
                    self._job_clients.pop(str(job["id"]), None)
                else:
                    self._cpu_busy = False
            if lane is not None:
                _release_video_reservation(int(lane["gpu_index"]), str(job["id"]))

    def _process(
        self,
        job: dict[str, Any],
        *,
        comfy: ComfyUIClient | None = None,
        gpu_label: str | None = None,
    ) -> str | None:
        self._check_cancel(job["id"])
        kind = job["kind"]
        if kind == "generate":
            if comfy is None or not gpu_label:
                raise RuntimeError("H3 generation was dispatched without a GPU backend.")
            return self._generate(job, comfy, gpu_label)
        if kind == "editor_export":
            return self._editor_export(job)
        if kind == "repair_export":
            return self._repair_export(job)
        raise RuntimeError(f"Unknown job type: {kind}")

    @staticmethod
    def _check_cancel(job_id: str) -> None:
        if db.is_cancel_requested(job_id):
            raise JobCancelled("Task cancelled by user.")

    def _generate(
        self,
        job: dict[str, Any],
        comfy: ComfyUIClient,
        gpu_label: str,
    ) -> str:
        payload = job["payload"]
        job_id = job["id"]
        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}.mp4"

        if not comfy.health():
            raise RuntimeError(
                f"H3 backend for {gpu_label} is not reachable at {comfy.base_url}."
            )

        def should_cancel() -> bool:
            return db.is_cancel_requested(job_id)

        def progress(value: float, stage: str) -> None:
            self._check_cancel(job_id)
            db.update_job(
                job_id,
                progress=value,
                stage=f"H3 · {gpu_label}: {stage}",
            )

        try:
            result = comfy.generate_h3(
                job_id=job_id,
                payload=payload,
                destination=output_path,
                progress=progress,
                on_sampling_start=lambda: db.mark_sampling_started(job_id),
                on_prompt_id=lambda prompt_id: db.update_job(
                    job_id, external_id=prompt_id
                ),
                should_cancel=should_cancel,
            )
            self._check_cancel(job_id)

            repair = payload.get("repair") if isinstance(payload.get("repair"), dict) else None
            if repair:
                source = _require_media(str(repair["media_id"]), owner_id=str(job.get("owner_id") or "user1"))
                source_path = settings.library_dir / source["filename"]
                second_path = None
                second_duration = 0.0
                second_audio = False
                if repair.get("second_media_id"):
                    second = _require_media(str(repair["second_media_id"]), owner_id=str(job.get("owner_id") or "user1"))
                    second_path = settings.library_dir / second["filename"]
                    second_duration = probe_duration(second_path) or 0.0
                    second_audio = probe_has_audio(second_path)
                generated_path = output_path.with_name(f"{media_id}_h3_raw.mp4")
                os.replace(output_path, generated_path)
                try:
                    if repair.get("mode") == "sound" and not probe_has_audio(generated_path):
                        raise RuntimeError("H3 не создал звуковую дорожку для замены.")
                    original_size = probe_video_size(source_path)
                    original_duration = probe_duration(source_path)
                    generated_duration = probe_duration(generated_path)
                    if original_size is None or not original_duration or not generated_duration:
                        raise RuntimeError("Не удалось прочитать видео для сборки AI-исправления.")
                    output_size = ((int(payload["width"]), int(payload["height"]))
                                   if repair.get("mode") == "splice" else original_size)
                    db.update_job(job_id, progress=98, stage="AI-исправление: сохраняем оригинальные участки")
                    command = assembly_command(
                        mode=str(repair["mode"]), source=source_path,
                        generated=generated_path, destination=output_path,
                        start=float(repair.get("start") or 0),
                        end=float(repair.get("end") or 0),
                        source_duration=original_duration,
                        size=output_size, generated_duration=generated_duration,
                        source_has_audio=probe_has_audio(source_path),
                        generated_has_audio=probe_has_audio(generated_path),
                        second=second_path, second_duration=second_duration,
                        second_has_audio=second_audio,
                    )
                    run_command(command, timeout=7200, should_cancel=should_cancel)
                    self._check_cancel(job_id)
                finally:
                    generated_path.unlink(missing_ok=True)

            final_audio = (
                payload.get("final_audio")
                if isinstance(payload.get("final_audio"), dict)
                else {}
            )
            if bool(final_audio.get("embed_track")):
                track_path = Path(str(final_audio.get("path") or ""))
                if not track_path.is_file():
                    raise RuntimeError("Selected V2 audio fragment is missing.")

                mixed_path = output_path.with_name(f"{media_id}_audio_mix.mp4")
                has_scene_audio = (
                    bool(final_audio.get("mix_scene_audio"))
                    and probe_has_audio(output_path)
                )
                db.update_job(
                    job_id,
                    progress=96,
                    stage=(
                        "FFmpeg: сведение трека и звуков сцены"
                        if has_scene_audio
                        else "FFmpeg: вклеивание выбранного трека"
                    ),
                )

                if has_scene_audio:
                    scene_volume = max(
                        0.0,
                        min(2.0, float(final_audio.get("scene_volume") or 0.45)),
                    )
                    track_volume = max(
                        0.0,
                        min(2.0, float(final_audio.get("track_volume") or 1.0)),
                    )
                    command = [
                        str(settings.ffmpeg_bin),
                        "-y",
                        "-i",
                        str(output_path),
                        "-i",
                        str(track_path),
                        "-filter_complex",
                        (
                            f"[0:a:0]volume={scene_volume:.4f}[scene];"
                            f"[1:a:0]volume={track_volume:.4f}[track];"
                            "[scene][track]amix=inputs=2:duration=longest:"
                            "dropout_transition=0:normalize=0[aout]"
                        ),
                        "-map",
                        "0:v:0",
                        "-map",
                        "[aout]",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "192k",
                        "-shortest",
                        str(mixed_path),
                    ]
                else:
                    command = [
                        str(settings.ffmpeg_bin),
                        "-y",
                        "-i",
                        str(output_path),
                        "-i",
                        str(track_path),
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
                        str(mixed_path),
                    ]

                try:
                    run_command(
                        command,
                        should_cancel=should_cancel,
                        timeout=600,
                    )
                    os.replace(mixed_path, output_path)
                finally:
                    mixed_path.unlink(missing_ok=True)

            duration = probe_duration(output_path)
            timing_job = db.get_job(job_id)
            # Include queue wait, model loading, sampling, VAE decode and audio mixing.
            # `created_at` is captured when the API enqueues the GPU job.
            completed_at = datetime.now(timezone.utc)
            started_at, elapsed = _generation_elapsed_from_submission(timing_job or job, completed_at)
            title = str(payload.get("title") or "").strip()[:120] if repair else _prompt_title(
                payload.get("user_prompt") or payload.get("prompt") or "H3 video"
            )
            metadata = {
                "operation": "ai_repair" if repair else "generate",
                "prompt": payload.get("prompt", ""),
                "width": payload.get("width"),
                "height": payload.get("height"),
                "seconds": payload.get("seconds"),
                "fps": payload.get("fps"),
                "steps": payload.get("steps"),
                "profile": payload.get("profile"),
                "seed": result.get("seed"),
                "generate_audio": bool(payload.get("generate_audio", False)),
                "generation_mode": payload.get("generation_mode", "frames"),
                "keyframe_role": payload.get("keyframe_role", "first"),
                "reference_task": payload.get("reference_task"),
                "ref_image_size": payload.get("ref_image_size"),
                "reference_count": (
                    len(payload.get("images") or [])
                    + len(payload.get("references") or [])
                ),
                "reference_map": payload.get("reference_map") or [],
                "timeline_guides": [
                    {
                        "source_name": item.get("source_name"),
                        "time_seconds": item.get("time_seconds"),
                        "note": item.get("note") or "",
                    }
                    for item in (payload.get("guides") or [])
                    if isinstance(item, dict)
                ],
                "control": {
                    key: value
                    for key, value in (
                        payload.get("control")
                        if isinstance(payload.get("control"), dict)
                        else {}
                    ).items()
                    if key not in {"control_video_path", "source_video_path", "mask_video_path"}
                },
                "user_prompt": payload.get("user_prompt", payload.get("prompt", "")),
                "comfy_prompt_id": result.get("prompt_id"),
                "gpu_backend": gpu_label,
                "generation_started_at": started_at,
                "generation_finished_at": completed_at.isoformat(timespec="seconds"),
                "generation_seconds": elapsed,
                "v2_context": payload.get("v2_context") or {},
                "final_audio": {
                    "embed_track": bool(final_audio.get("embed_track")),
                    "mix_scene_audio": bool(final_audio.get("mix_scene_audio")),
                    "track_volume": final_audio.get("track_volume"),
                    "scene_volume": final_audio.get("scene_volume"),
                },
            }
            if repair:
                metadata["repair"] = repair

            db.insert_media(
                media_id=media_id,
                owner_id=str(job.get("owner_id") or "user1"),
                filename=output_path.name,
                kind="edited" if repair else "generated",
                title=title,
                parent_id=str(repair["media_id"]) if repair else None,
                metadata=metadata,
                size_bytes=output_path.stat().st_size,
                duration=duration,
            )
            cleanup_paths = list(payload.get("images") or [])
            cleanup_paths.extend(
                str(item["path"])
                for item in (payload.get("references") or [])
                if isinstance(item, dict) and item.get("temporary") and item.get("path")
            )
            cleanup_paths.extend(
                str(item["path"])
                for item in (payload.get("guides") or [])
                if isinstance(item, dict) and item.get("temporary") and item.get("path")
            )
            control = payload.get("control") if isinstance(payload.get("control"), dict) else {}
            cleanup_paths.extend(
                str(control[key])
                for key in ("control_video_path", "source_video_path", "mask_video_path")
                if control.get(key)
            )
            final_audio_path = str(final_audio.get("path") or "")
            if final_audio.get("temporary") and final_audio_path and final_audio_path not in cleanup_paths:
                cleanup_paths.append(final_audio_path)
            _remove_uploads(cleanup_paths)
            return media_id
        except (JobCancelled, ComfyUICancelled):
            output_path.unlink(missing_ok=True)
            raise
        except Exception:
            # Preserve temporary inputs for failed-job Retry, but never leave a
            # partial generated MP4 orphaned in the Library directory.
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
            source = _require_media(
                str(spec["media_id"]),
                owner_id=str(job.get("owner_id") or "user1"),
            )
            source_path = settings.library_dir / source["filename"]
            duration = probe_duration(source_path)
            if not duration or duration <= 0:
                raise RuntimeError(
                    f"Could not determine duration for '{source['title']}'."
                )
            volume = max(0.0, min(2.0, float(spec.get("volume", 1.0))))
            trim_start = max(0.0, min(float(duration) - 0.05, float(spec.get("trim_start") or 0.0)))
            requested_duration = max(0.0, float(spec.get("trim_duration") or 0.0))
            clip_duration = (
                min(requested_duration, float(duration) - trim_start)
                if requested_duration > 0
                else float(duration) - trim_start
            )
            clip_duration = max(0.05, clip_duration)
            fade_in = max(0.0, min(float(spec.get("fade_in") or 0.0), clip_duration / 2.0))
            fade_out = max(0.0, min(float(spec.get("fade_out") or 0.0), clip_duration / 2.0))
            sources.append(
                {
                    "media": source,
                    "path": source_path,
                    "source_duration": float(duration),
                    "duration": clip_duration,
                    "trim_start": trim_start,
                    "fade_in": fade_in,
                    "fade_out": fade_out,
                    "volume": volume,
                    "has_audio": probe_has_audio(source_path),
                }
            )
            total_duration += clip_duration

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
            trim_start = source["trim_start"]
            fade_in = source["fade_in"]
            fade_out = source["fade_out"]
            video_filters = [
                f"trim=start={trim_start:.6f}:duration={duration:.6f}",
                "setpts=PTS-STARTPTS",
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
                "setsar=1",
                "fps=24",
                "format=yuv420p",
            ]
            if fade_in > 0:
                video_filters.append(f"fade=t=in:st=0:d={fade_in:.6f}")
            if fade_out > 0:
                video_filters.append(
                    f"fade=t=out:st={max(0.0, duration - fade_out):.6f}:d={fade_out:.6f}"
                )
            filters.append(
                f"[{index}:v:0]" + ",".join(video_filters) + f"[v{index}]"
            )
            if source["has_audio"] and source["volume"] > 0:
                audio_filters = [
                    f"atrim=start={trim_start:.6f}:duration={duration:.6f}",
                    "asetpts=PTS-STARTPTS",
                    "aresample=48000",
                    "aformat=sample_fmts=fltp:channel_layouts=stereo",
                    f"volume={source['volume']:.4f}",
                ]
                if fade_in > 0:
                    audio_filters.append(f"afade=t=in:st=0:d={fade_in:.6f}")
                if fade_out > 0:
                    audio_filters.append(
                        f"afade=t=out:st={max(0.0, duration - fade_out):.6f}:d={fade_out:.6f}"
                    )
                audio_filters.extend(
                    ["apad", f"atrim=duration={duration:.6f}"]
                )
                filters.append(
                    f"[{index}:a:0]" + ",".join(audio_filters) + f"[a{index}]"
                )
            else:
                filters.append(
                    "anullsrc=r=48000:cl=stereo,"
                    "aformat=sample_fmts=fltp:channel_layouts=stereo,"
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
                f"adelay=delays={delay_ms}:all=1,"
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
                owner_id=str(job.get("owner_id") or "user1"),
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
                    "clip_trim_starts": [source["trim_start"] for source in sources],
                    "clip_durations": [source["duration"] for source in sources],
                    "clip_fade_ins": [source["fade_in"] for source in sources],
                    "clip_fade_outs": [source["fade_out"] for source in sources],
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

    def _repair_export(self, job: dict[str, Any]) -> str:
        """Keep source MP4 untouched and export a deterministic montage result.

        Fragment removal and transitions re-encode output; this is not AI inpainting.
        """
        payload = job["payload"]
        mode = str(payload.get("mode") or "")
        job_id = str(job["id"])
        owner_id = str(job.get("owner_id") or "user1")
        source = _require_media(str(payload["media_id"]), owner_id=owner_id)
        source_path = settings.library_dir / source["filename"]
        first_length = probe_duration(source_path)
        if not first_length:
            raise RuntimeError("Source video duration cannot be determined.")

        output_size = probe_video_size(source_path)
        if output_size is None:
            raise RuntimeError("Source video dimensions cannot be determined.")
        width, height = (max(2, dimension - dimension % 2) for dimension in output_size)
        media_id = uuid.uuid4().hex
        output_path = settings.library_dir / f"{media_id}_repair.mp4"
        command = [str(settings.ffmpeg_bin), "-y"]
        filters: list[str] = []
        metadata = {"operation": "repair", "repair_mode": mode, "source_media_id": source["id"]}

        def video_chain(index: int, length: float, start: float = 0) -> None:
            filters.append(
                f"[{index}:v:0]trim=start={start:.6f}:duration={length:.6f},"
                "setpts=PTS-STARTPTS,"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                "setsar=1,fps=24,settb=AVTB,format=yuv420p"
                f"[v{index}]"
            )

        def audio_chain(index: int, path: Path, length: float, start: float = 0) -> None:
            if probe_has_audio(path):
                filters.append(
                    f"[{index}:a:0]atrim=start={start:.6f}:duration={length:.6f},"
                    "asetpts=PTS-STARTPTS,aresample=48000,"
                    "aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"apad,atrim=duration={length:.6f}[a{index}]"
                )
            else:
                filters.append(
                    "anullsrc=r=48000:cl=stereo,"
                    f"atrim=duration={length:.6f},asetpts=PTS-STARTPTS[a{index}]"
                )

        if mode == "fragment":
            start, end = float(payload["start"]), float(payload["end"])
            segments = [(0.0, start), (end, first_length - end)]
            segments = [(offset, length) for offset, length in segments if length > .04]
            if not segments:
                raise RuntimeError("Nothing remains after the selected segment is removed.")
            for index, (offset, length) in enumerate(segments):
                command.extend(["-i", str(source_path)])
                video_chain(index, length, offset)
                audio_chain(index, source_path, length, offset)
            filters.append(
                "".join(f"[v{i}][a{i}]" for i in range(len(segments)))
                + f"concat=n={len(segments)}:v=1:a=1[vout][aout]"
            )
            metadata.update(start=start, end=end, removed_seconds=end - start)
        elif mode == "sound":
            if not probe_has_audio(source_path):
                raise RuntimeError("Source video does not have an audio track.")
            start, end, volume = float(payload["start"]), float(payload["end"]), float(payload["volume"])
            command.extend(["-i", str(source_path)])
            # FFmpeg's enable expression gates the volume filter to this interval.
            expression = f"between(t\\,{start:.6f}\\,{end:.6f})"
            filters.append(f"[0:a:0]volume={volume:.4f}:enable='{expression}'[aout]")
            metadata.update(start=start, end=end, volume=volume)
        elif mode == "splice":
            second = _require_media(str(payload["second_media_id"]), owner_id=owner_id)
            second_path = settings.library_dir / second["filename"]
            second_length = probe_duration(second_path)
            if not second_length or first_length <= 1.05 or second_length <= 1.05:
                raise RuntimeError("Both clips must exceed the 1-second transition.")
            command.extend(["-i", str(source_path), "-i", str(second_path)])
            video_chain(0, first_length)
            video_chain(1, second_length)
            audio_chain(0, source_path, first_length)
            audio_chain(1, second_path, second_length)
            transition = str(payload["transition"])
            filters.append(
                f"[v0][v1]xfade=transition={transition}:duration=1:offset={first_length - 1:.6f}[vout]"
            )
            filters.append("[a0][a1]acrossfade=d=1:c1=tri:c2=tri[aout]")
            metadata.update(second_media_id=second["id"], transition=transition, transition_seconds=1)
        else:
            raise RuntimeError("Unsupported repair mode.")

        command.extend(["-filter_complex", ";".join(filters)])
        if mode == "sound":
            command.extend(["-map", "0:v:0", "-map", "[aout]", "-c:v", "copy"])
        else:
            command.extend(["-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24"])
        command.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output_path)])
        try:
            self._check_cancel(job_id)
            db.update_job(job_id, progress=10, stage="Исправление: подготовка видео")
            db.update_job(job_id, progress=20, stage="FFmpeg: обработка фрагмента")
            run_command(command, timeout=7200, should_cancel=lambda: db.is_cancel_requested(job_id))
            self._check_cancel(job_id)
            if not output_path.is_file():
                raise RuntimeError("FFmpeg did not save the repaired video.")
            db.update_job(job_id, progress=95, stage="Исправление: сохранение")
            db.insert_media(
                media_id=media_id, owner_id=owner_id, filename=output_path.name,
                kind="edited", title=str(payload.get("title") or "Исправленное видео"),
                parent_id=str(source["id"]),
                metadata={**metadata, "width": width, "height": height},
                size_bytes=output_path.stat().st_size, duration=probe_duration(output_path),
            )
            return media_id
        except Exception:
            output_path.unlink(missing_ok=True)
            raise


def _discard_cancelled_result(media_id: str, owner_id: str) -> None:
    """A cancellation arriving during final save must not leave a Library item."""
    media = db.get_media(media_id, owner_id)
    if media is None:
        return
    db.delete_media_row(media_id, owner_id)
    root = settings.library_dir.resolve()
    path = (root / str(media["filename"])).resolve()
    if path.parent == root:
        path.unlink(missing_ok=True)


def _require_media(
    media_id: str,
    owner_id: str | None = None,
) -> dict[str, Any]:
    media = db.get_media(media_id, owner_id)
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
        streams = payload.get("streams") or []
        if not streams:
            return None
        width = int(streams[0].get("width") or 0)
        height = int(streams[0].get("height") or 0)
        if width < 2 or height < 2:
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
