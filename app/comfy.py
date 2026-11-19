from __future__ import annotations

import json
import secrets
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlparse, urlunparse

import requests
import websocket

from .config import settings


ProgressCallback = Callable[[float, str], None]
PromptIdCallback = Callable[[str], None]
CancelCallback = Callable[[], bool]


class ComfyUIError(RuntimeError):
    pass


class ComfyUICancelled(ComfyUIError):
    pass


class ComfyUIClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or settings.comfyui_url).rstrip("/")
        self.session = requests.Session()

    def health(self) -> bool:
        try:
            response = self.session.get(f"{self.base_url}/system_stats", timeout=3)
            return response.ok
        except requests.RequestException:
            return False

    def generate_h3(
        self,
        *,
        job_id: str,
        payload: dict[str, Any],
        destination: Path,
        progress: ProgressCallback,
        on_prompt_id: PromptIdCallback | None = None,
        should_cancel: CancelCallback | None = None,
    ) -> dict[str, Any]:
        if should_cancel and should_cancel():
            raise ComfyUICancelled("Generation cancelled.")

        uploaded_images: list[str] = []
        staged_references: list[dict[str, str]] = []
        staging_dir: Path | None = None
        generation_mode = str(payload.get("generation_mode") or "frames")

        if generation_mode == "frames":
            for index, local_path in enumerate(payload.get("images") or [], start=1):
                if should_cancel and should_cancel():
                    raise ComfyUICancelled("Generation cancelled.")
                progress(3 + index * 2, f"Загрузка кадра {index} в ComfyUI")
                uploaded_images.append(self.upload_image(Path(local_path)))
        else:
            staging_dir = settings.comfyui_input_dir / "aivideosite" / job_id
            staging_dir.mkdir(parents=True, exist_ok=True)
            references = payload.get("references") or []
            for index, item in enumerate(references, start=1):
                if should_cancel and should_cancel():
                    raise ComfyUICancelled("Generation cancelled.")
                if not isinstance(item, dict):
                    continue
                media_type = str(item.get("type") or "").strip().lower()
                if media_type not in {"image", "video", "audio"}:
                    raise ComfyUIError(f"Unsupported reference media type: {media_type!r}")
                source = Path(str(item.get("path") or ""))
                if not source.is_file():
                    raise ComfyUIError(f"Reference file not found: {source}")
                suffix = source.suffix.lower()
                destination = staging_dir / f"{index:02d}_{uuid.uuid4().hex}{suffix}"
                shutil.copy2(source, destination)
                relative = destination.relative_to(settings.comfyui_input_dir).as_posix()
                staged_references.append({"type": media_type, "name": relative})
                progress(3 + min(index, 10), f"Подготовка reference media {index}")

        client_id = uuid.uuid4().hex
        workflow = self._build_h3_workflow(
            job_id=job_id,
            payload=payload,
            uploaded_images=uploaded_images,
            staged_references=staged_references,
        )

        progress(8, "Передача H3-задачи в ComfyUI")
        ws = None
        prompt_id: str | None = None

        try:
            ws = websocket.create_connection(
                self._websocket_url(client_id),
                timeout=8,
            )
        except Exception:
            ws = None

        response = self.session.post(
            f"{self.base_url}/prompt",
            json={"prompt": workflow, "client_id": client_id},
            timeout=30,
        )
        if not response.ok:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)
            raise ComfyUIError(
                f"ComfyUI rejected workflow ({response.status_code}): "
                f"{response.text[-3000:]}"
            )

        body = response.json()
        prompt_id = body.get("prompt_id")
        if not prompt_id:
            raise ComfyUIError(f"ComfyUI did not return prompt_id: {body!r}")
        if on_prompt_id is not None:
            on_prompt_id(str(prompt_id))
        if should_cancel and should_cancel():
            self.cancel_prompt(str(prompt_id))
            raise ComfyUICancelled("Generation cancelled.")

        progress(10, "H3: подготовка модели")
        if ws is not None:
            try:
                self._wait_websocket(ws, prompt_id, progress, should_cancel)
            except ComfyUICancelled:
                raise
            except Exception:
                # WebSocket is only for responsive progress. History polling
                # remains the source of truth and keeps jobs robust.
                pass
            finally:
                try:
                    ws.close()
                except Exception:
                    pass

        history = self._wait_history(prompt_id, progress, should_cancel=should_cancel)
        output = self._find_video_output(history)
        if output is None:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)
            raise ComfyUIError(
                "ComfyUI finished the task but no saved video was found in history."
            )

        progress(92, "Копирование видео в библиотеку")
        self._download_output(output, destination)
        progress(97, "Видео сохранено")

        result = {
            "prompt_id": prompt_id,
            "comfy_output": output,
            "seed": int(payload.get("seed", 0)),
        }
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
        return result

    def free_memory(self) -> bool:
        """Ask ComfyUI to unload all models and release cached GPU memory."""
        try:
            response = self.session.post(
                f"{self.base_url}/free",
                json={"unload_models": True, "free_memory": True},
                timeout=15,
            )
            return response.ok
        except requests.RequestException:
            return False

    def cancel_prompt(self, prompt_id: str) -> bool:
        try:
            response = self.session.post(
                f"{self.base_url}/api/jobs/{prompt_id}/cancel",
                timeout=10,
            )
            if response.ok:
                data = response.json()
                return bool(data.get("cancelled"))
        except Exception:
            pass

        # Compatibility fallbacks for older ComfyUI builds.
        for endpoint in ("/api/interrupt", "/interrupt"):
            try:
                response = self.session.post(
                    f"{self.base_url}{endpoint}",
                    timeout=10,
                )
                if response.ok:
                    return True
            except Exception:
                continue
        return False

    def upload_image(self, path: Path) -> str:
        if not path.is_file():
            raise ComfyUIError(f"Reference image not found: {path}")

        with path.open("rb") as handle:
            response = self.session.post(
                f"{self.base_url}/upload/image",
                files={"image": (path.name, handle)},
                data={"type": "input", "overwrite": "true"},
                timeout=120,
            )
        if not response.ok:
            raise ComfyUIError(
                f"Image upload failed ({response.status_code}): {response.text[-2000:]}"
            )

        data = response.json()
        name = data.get("name")
        subfolder = data.get("subfolder") or ""
        if not name:
            raise ComfyUIError(f"Unexpected image upload response: {data!r}")
        return f"{subfolder}/{name}".lstrip("/") if subfolder else name

    def _build_h3_workflow(
        self,
        *,
        job_id: str,
        payload: dict[str, Any],
        uploaded_images: list[str],
        staged_references: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        profile = str(payload.get("profile") or "steps8").lower()
        profiles = {
            "steps4": {"steps": 4, "turbo": True},
            "steps8": {"steps": 8, "turbo": True},
            "steps12": {"steps": 12, "turbo": False},
            "steps16": {"steps": 16, "turbo": False},
            "steps20": {"steps": 20, "turbo": False},
            # Legacy aliases keep old queued/retried jobs working, but 30-step
            # generation is intentionally retired.
            "fast": {"steps": 8, "turbo": True},
            "quality": {"steps": 20, "turbo": False},
            "max": {"steps": 20, "turbo": False},
        }
        profile_config = profiles.get(profile, profiles["steps8"])
        steps = int(profile_config["steps"])
        generation_mode = str(payload.get("generation_mode") or "frames")
        easy_mode = {
            "frames": "image",
            "reference": "reference",
            "digital_human": "digital_human",
        }.get(generation_mode, "image")
        turbo_lora = (
            settings.h3_turbo_lora
            if easy_mode == "image"
            else settings.h3_ref_turbo_lora
        )
        use_turbo = bool(profile_config["turbo"]) and str(turbo_lora).strip().lower() not in {"", "none"}
        if easy_mode != "image" and str(settings.h3_ref2va_model).strip().lower() in {"", "none"}:
            raise ComfyUIError(
                "Ref2VA mode is not configured. Set H3_REF2VA_MODEL to a Ref2VA checkpoint."
            )
        seed = int(payload.get("seed", -1))
        if seed < 0:
            seed = secrets.randbelow(2**32)
            payload["seed"] = seed
        seed %= 2**32

        width = int(payload.get("width") or 1344)
        height = int(payload.get("height") or 768)
        seconds = float(payload.get("seconds") or 5.0)
        fps = float(payload.get("fps") or 24.0)
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise ComfyUIError("Prompt is empty.")

        staged_references = staged_references or []
        if easy_mode == "image" and len(uploaded_images) > 2:
            raise ComfyUIError("FL2VA image mode supports at most two keyframes.")
        if easy_mode != "image" and len(staged_references) > 15:
            raise ComfyUIError("Ref2VA supports at most 15 media resources.")

        aspect = _aspect_ratio(width, height)

        workflow: dict[str, Any] = {
            "1": {
                "class_type": "MiniMaxH3EasyLoader",
                "inputs": {
                    "fl2va_model": settings.h3_fl2va_model,
                    "ref2va_model": settings.h3_ref2va_model,
                    "text_encoder": settings.h3_text_encoder,
                    "video_vae": settings.h3_video_vae,
                    "audio_vae": settings.h3_audio_vae,
                },
            },
            "2": {
                "class_type": "MiniMaxH3Easy",
                "inputs": {
                    "h3_bundle": ["1", 0],
                    "mode": easy_mode,
                    "prompt": prompt,
                    "resolution": "custom",
                    "aspect_ratio": aspect,
                    "width": width,
                    "height": height,
                    "seconds": seconds,
                    "advanced": True,
                    "fps": fps,
                    "keyframe_role": str(payload.get("keyframe_role") or "first"),
                    "ref_image_size": str(payload.get("ref_image_size") or ("original" if easy_mode == "image" else "match")),
                    "reference_mention_mode": "index",
                    "prompt_optimizer_settings": False,
                    "prompt_optimizer_scene_guide": "none",
                },
            },
            "13": {
                "class_type": "MiniMaxH3EasyOutput",
                "inputs": {"h3_context": ["2", 1]},
            },
            "34": {
                "class_type": "ModelAttentionBackend",
                "inputs": {
                    "model": ["24", 0] if use_turbo else ["2", 0],
                    "attention": settings.h3_attention_backend,
                },
            },
            "5": {
                "class_type": "BasicScheduler",
                "inputs": {
                    "model": ["34", 0],
                    "scheduler": "simple",
                    "steps": steps,
                    "denoise": 1.0,
                },
            },
            "7": {
                "class_type": "KSamplerSelect",
                "inputs": {"sampler_name": "euler"},
            },
            "30": {
                "class_type": "MiniMaxH3EasySampler",
                "inputs": {
                    "h3_context": ["2", 1],
                    "model": ["34", 0],
                    "sampler": ["7", 0],
                    "sigmas": ["5", 0],
                    "seed": seed,
                },
            },
            "9": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["30", 0],
                    "vae": ["13", 2],
                },
            },
            "11": {
                "class_type": "CreateVideo",
                "inputs": {
                    "images": ["9", 0],
                    "fps": ["13", 4],
                },
            },
            "12": {
                "class_type": "SaveVideo",
                "inputs": {
                    "video": ["11", 0],
                    "filename_prefix": f"aivideosite/{job_id}",
                    "format": "mp4",
                    "codec": {"codec": "h264"},
                },
            },
        }

        if bool(payload.get("generate_audio", False)):
            workflow["10"] = {
                "class_type": "VAEDecodeAudio",
                "inputs": {
                    "samples": ["30", 0],
                    "vae": ["13", 3],
                },
            }
            workflow["11"]["inputs"]["audio"] = ["10", 0]

        if use_turbo:
            workflow["24"] = {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": ["2", 0],
                    "lora_name": turbo_lora,
                    "strength_model": 1.0,
                },
            }

        if easy_mode == "image":
            for index, image_name in enumerate(uploaded_images, start=1):
                node_id = str(100 + index)
                workflow[node_id] = {
                    "class_type": "LoadImage",
                    "inputs": {"image": image_name},
                }
                workflow["2"]["inputs"][f"media_{index}"] = [node_id, 0]
                workflow["2"]["inputs"][f"media_type_{index}"] = "image"
        else:
            loader_types = {
                "image": ("LoadImage", "image"),
                "video": ("LoadVideo", "file"),
                "audio": ("LoadAudio", "audio"),
            }
            for index, item in enumerate(staged_references, start=1):
                media_type = str(item.get("type") or "")
                if media_type not in loader_types:
                    raise ComfyUIError(f"Unsupported reference media type: {media_type!r}")
                class_type, input_name = loader_types[media_type]
                node_id = str(100 + index)
                workflow[node_id] = {
                    "class_type": class_type,
                    "inputs": {input_name: item["name"]},
                }
                workflow["2"]["inputs"][f"media_{index}"] = [node_id, 0]
                workflow["2"]["inputs"][f"media_type_{index}"] = media_type

        return workflow

    def _wait_websocket(
        self,
        ws: websocket.WebSocket,
        prompt_id: str,
        progress: ProgressCallback,
        should_cancel: CancelCallback | None = None,
    ) -> None:
        ws.settimeout(2)
        while True:
            if should_cancel and should_cancel():
                self.cancel_prompt(prompt_id)
                raise ComfyUICancelled("Generation cancelled.")
            try:
                message = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue

            if isinstance(message, bytes):
                continue

            data = json.loads(message)
            data_prompt_id = (data.get("data") or {}).get("prompt_id")
            if data_prompt_id and data_prompt_id != prompt_id:
                continue

            event_type = data.get("type")
            event_data = data.get("data") or {}

            if event_type == "progress":
                value = float(event_data.get("value") or 0)
                maximum = float(event_data.get("max") or 1)
                fraction = 0 if maximum <= 0 else value / maximum
                progress(15 + min(1.0, fraction) * 70, "H3: генерация кадров")
            elif event_type == "executing":
                node = event_data.get("node")
                if node is None and data_prompt_id == prompt_id:
                    return
                progress(12, "H3: выполнение workflow")
            elif event_type == "execution_error":
                error = event_data.get("exception_message") or event_data
                raise ComfyUIError(f"ComfyUI execution error: {error}")
            elif event_type == "execution_success":
                return

    def _wait_history(
        self,
        prompt_id: str,
        progress: ProgressCallback,
        timeout_seconds: int = 7200,
        should_cancel: CancelCallback | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if should_cancel and should_cancel():
                self.cancel_prompt(prompt_id)
                raise ComfyUICancelled("Generation cancelled.")
            response = self.session.get(
                f"{self.base_url}/history/{prompt_id}",
                timeout=30,
            )
            if response.ok:
                data = response.json()
                if prompt_id in data:
                    progress(88, "H3: декодирование и сохранение")
                    return data[prompt_id]
            time.sleep(2)
        raise ComfyUIError("Timed out waiting for ComfyUI history.")

    def _find_video_output(self, history: dict[str, Any]) -> dict[str, str] | None:
        outputs = history.get("outputs") or {}
        candidates: list[dict[str, str]] = []

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                filename = value.get("filename")
                if isinstance(filename, str) and filename.lower().endswith(
                    (".mp4", ".webm", ".mkv", ".mov")
                ):
                    candidates.append(
                        {
                            "filename": filename,
                            "subfolder": str(value.get("subfolder") or ""),
                            "type": str(value.get("type") or "output"),
                        }
                    )
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(outputs)
        return candidates[-1] if candidates else None

    def _download_output(self, output: dict[str, str], destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)

        # ComfyUI and the site normally run on the same VM. Move the local
        # output instead of copying the entire MP4 through loopback HTTP.
        if output.get("type", "output") == "output":
            root = settings.comfyui_output_dir.resolve()
            local_source = (
                root
                / str(output.get("subfolder") or "")
                / output["filename"]
            ).resolve()
            try:
                local_source.relative_to(root)
            except ValueError:
                local_source = Path()
            if local_source.is_file():
                shutil.move(str(local_source), str(destination))
                return

        params = urlencode(
            {
                "filename": output["filename"],
                "subfolder": output.get("subfolder", ""),
                "type": output.get("type", "output"),
            }
        )
        response = self.session.get(
            f"{self.base_url}/view?{params}",
            stream=True,
            timeout=120,
        )
        if not response.ok:
            raise ComfyUIError(
                f"Failed to download ComfyUI output ({response.status_code})."
            )

        with destination.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    handle.write(chunk)

    def _websocket_url(self, client_id: str) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse(
            (
                scheme,
                parsed.netloc,
                "/ws",
                "",
                urlencode({"clientId": client_id}),
                "",
            )
        )


def _aspect_ratio(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "16:9"

    ratio = width / height
    known = {
        "1:1": 1.0,
        "2:3": 2 / 3,
        "3:2": 3 / 2,
        "3:4": 3 / 4,
        "4:3": 4 / 3,
        "9:16": 9 / 16,
        "16:9": 16 / 9,
        "21:9": 21 / 9,
    }
    return min(known, key=lambda key: abs(known[key] - ratio))
