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
        staged_guides: list[dict[str, Any]] = []
        staged_control: dict[str, Any] = {}
        staging_dir: Path | None = None
        generation_mode = str(payload.get("generation_mode") or "frames")
        guides = [item for item in (payload.get("guides") or []) if isinstance(item, dict)]
        control = payload.get("control") if isinstance(payload.get("control"), dict) else {}
        control_enabled = str(control.get("mode") or "none") != "none"

        if generation_mode == "frames":
            for index, local_path in enumerate(payload.get("images") or [], start=1):
                if should_cancel and should_cancel():
                    raise ComfyUICancelled("Generation cancelled.")
                progress(3 + index * 2, f"Загрузка кадра {index} в ComfyUI")
                uploaded_images.append(self.upload_image(Path(local_path)))

        needs_staging = generation_mode != "frames" or bool(guides) or control_enabled
        if needs_staging:
            staging_dir = settings.comfyui_input_dir / "aivideosite" / job_id
            staging_dir.mkdir(parents=True, exist_ok=True)

            def stage_file(local_path: str | Path, prefix: str) -> str:
                source = Path(local_path)
                if not source.is_file():
                    raise ComfyUIError(f"Reference file not found: {source}")
                suffix = source.suffix.lower()
                destination = staging_dir / f"{prefix}_{uuid.uuid4().hex}{suffix}"
                shutil.copy2(source, destination)
                return destination.relative_to(settings.comfyui_input_dir).as_posix()

            try:
                if generation_mode != "frames":
                    references = payload.get("references") or []
                    for index, item in enumerate(references, start=1):
                        if should_cancel and should_cancel():
                            raise ComfyUICancelled("Generation cancelled.")
                        if not isinstance(item, dict):
                            continue
                        media_type = str(item.get("type") or "").strip().lower()
                        if media_type not in {"image", "video", "audio"}:
                            raise ComfyUIError(f"Unsupported reference media type: {media_type!r}")
                        staged_references.append(
                            {
                                "type": media_type,
                                "name": stage_file(str(item.get("path") or ""), f"ref_{index:02d}"),
                            }
                        )
                        progress(3 + min(index, 10), f"Подготовка reference media {index}")

                for index, item in enumerate(guides, start=1):
                    if should_cancel and should_cancel():
                        raise ComfyUICancelled("Generation cancelled.")
                    staged_guides.append(
                        {
                            "name": stage_file(str(item.get("path") or ""), f"guide_{index:02d}"),
                            "time_seconds": float(item.get("time_seconds") or 0.0),
                            "source_name": str(item.get("source_name") or f"Guide {index}"),
                        }
                    )

                if control_enabled:
                    staged_control = {
                        key: value
                        for key, value in control.items()
                        if key not in {"control_video_path", "source_video_path", "mask_video_path"}
                    }
                    for payload_key, staged_key in (
                        ("control_video_path", "control_video"),
                        ("source_video_path", "source_video"),
                        ("mask_video_path", "mask_video"),
                    ):
                        path_value = control.get(payload_key)
                        if path_value:
                            staged_control[staged_key] = stage_file(
                                str(path_value),
                                f"control_{staged_key}",
                            )
            except Exception:
                shutil.rmtree(staging_dir, ignore_errors=True)
                raise

        try:
            client_id = uuid.uuid4().hex
            workflow = self._build_h3_workflow(
                job_id=job_id,
                payload=payload,
                uploaded_images=uploaded_images,
                staged_references=staged_references,
                staged_guides=staged_guides,
                staged_control=staged_control,
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
        finally:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)

    def generate_h3_image(
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

        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise ComfyUIError("Image prompt is empty.")

        width = int(payload.get("width") or 2688)
        height = int(payload.get("height") or 1536)
        if width < 256 or height < 256 or width > 4096 or height > 4096:
            raise ComfyUIError("Unsupported H3 Image resolution.")

        seed = int(payload.get("seed", -1))
        if seed < 0:
            seed = secrets.randbelow(2**32)
            payload["seed"] = seed
        seed %= 2**32

        reference_paths = [
            Path(str(value))
            for value in (payload.get("reference_paths") or [])
            if str(value or "").strip()
        ]
        if len(reference_paths) > 16:
            raise ComfyUIError("MiniMax H3 Image supports at most 16 reference images.")

        uploaded: list[str] = []
        for index, path in enumerate(reference_paths, start=1):
            if should_cancel and should_cancel():
                raise ComfyUICancelled("Generation cancelled.")
            progress(3 + min(index, 12), f"H3 Image: загрузка reference {index}")
            uploaded.append(self.upload_image(path))

        workflow: dict[str, Any] = {
            "1": {
                "class_type": "UnetLoaderGGUF",
                "inputs": {
                    "unet_name": settings.h3_image_model,
                },
            },
            "2": {
                "class_type": "CLIPLoader",
                "inputs": {
                    "clip_name": settings.h3_text_encoder,
                    "type": "minimax",
                    "device": "default",
                },
            },
            "3": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": settings.h3_image_vae,
                },
            },
            "4": {
                "class_type": "MiniMaxH3ImageConditioning",
                "inputs": {
                    "clip": ["2", 0],
                    "vae": ["3", 0],
                    "prompt": prompt,
                    "width": width,
                    "height": height,
                },
            },
            "5": {
                "class_type": "ConditioningZeroOut",
                "inputs": {
                    "conditioning": ["4", 0],
                },
            },
            "6": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["1", 0],
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "latent_image": ["4", 1],
                    "seed": seed,
                    "steps": 6,
                    "cfg": 1.0,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1.0,
                },
            },
            "7": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["6", 0],
                    "vae": ["3", 0],
                },
            },
            "8": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["7", 0],
                    "filename_prefix": f"aivideosite/images/{job_id}",
                },
            },
        }

        for index, image_name in enumerate(uploaded):
            node_id = str(100 + index)
            workflow[node_id] = {
                "class_type": "LoadImage",
                "inputs": {"image": image_name},
            }
            # ComfyUI's MiniMaxH3ImageConditioning autogrow input is zero-based
            # in the API graph; the model labels it as <Picture 1>, <Picture 2>, ...
            workflow["4"]["inputs"][f"images.image_{index}"] = [node_id, 0]

        client_id = uuid.uuid4().hex
        progress(18, "H3 Image: передача задачи в ComfyUI")
        ws = None
        try:
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
                raise ComfyUIError(
                    f"ComfyUI rejected H3 Image workflow ({response.status_code}): "
                    f"{response.text[-3000:]}"
                )

            body = response.json()
            prompt_id = str(body.get("prompt_id") or "")
            if not prompt_id:
                raise ComfyUIError(f"ComfyUI did not return prompt_id: {body!r}")
            if on_prompt_id is not None:
                on_prompt_id(prompt_id)

            if should_cancel and should_cancel():
                self.cancel_prompt(prompt_id)
                raise ComfyUICancelled("Generation cancelled.")

            progress(22, "H3 Image: подготовка модели")
            if ws is not None:
                try:
                    self._wait_websocket(ws, prompt_id, progress, should_cancel)
                except ComfyUICancelled:
                    raise
                except Exception:
                    pass
                finally:
                    try:
                        ws.close()
                    except Exception:
                        pass
                    ws = None

            history = self._wait_history(
                prompt_id,
                progress,
                timeout_seconds=7200,
                should_cancel=should_cancel,
            )
            output = self._find_image_output(history)
            if output is None:
                raise ComfyUIError(
                    "ComfyUI finished H3 Image but no saved image was found in history."
                )

            progress(94, "H3 Image: сохранение результата")
            self._download_output(output, destination)
            progress(98, "H3 Image: готово")
            return {
                "prompt_id": prompt_id,
                "comfy_output": output,
                "seed": seed,
            }
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

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
        staged_guides: list[dict[str, Any]] | None = None,
        staged_control: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        direct_steps = payload.get("steps")
        profile_config: dict[str, Any] | None = None
        if direct_steps is not None:
            steps = int(direct_steps)
            if steps < 6 or steps > 24 or steps % 2:
                raise ComfyUIError("Steps must be an even value from 6 to 24.")
        else:
            # Compatibility for jobs created before the free steps slider.
            profile = str(payload.get("profile") or "steps8").lower()
            profiles = {
                "steps4": {"steps": 4, "turbo": True},
                "steps8": {"steps": 8, "turbo": True},
                "steps12": {"steps": 12, "turbo": False},
                "steps16": {"steps": 16, "turbo": False},
                "steps20": {"steps": 20, "turbo": False},
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
            "multiframe": "reference",
            "digital_human": "digital_human",
        }.get(generation_mode, "image")
        turbo_lora = (
            settings.h3_turbo_lora
            if easy_mode == "image"
            else settings.h3_ref_turbo_lora
        )
        turbo_available = str(turbo_lora).strip().lower() not in {"", "none"}
        if direct_steps is not None:
            # New slider: only use a LoRA at the step count it was trained for.
            # FL2VA has an 8-step LoRA; Ref2VA's installed LoRA is 4-step and
            # therefore intentionally stays off for the 6..24 slider.
            use_turbo = bool(turbo_available and easy_mode == "image" and steps == 8)
        else:
            use_turbo = (
                bool(profile_config and profile_config["turbo"])
                and turbo_available
                and (easy_mode == "image" or steps == 4)
            )
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
        staged_guides = staged_guides or []
        staged_control = staged_control or {}
        control_mode = str(staged_control.get("mode") or "none")
        if easy_mode == "image" and len(uploaded_images) > 2:
            raise ComfyUIError("FL2VA image mode supports at most two keyframes.")
        if easy_mode != "image" and len(staged_references) > 15:
            raise ComfyUIError("Ref2VA supports at most 15 media resources.")

        aspect = _aspect_ratio(width, height)

        workflow: dict[str, Any] = {
            "1": {
                "class_type": "MiniMaxH3EasyLoader",
                "inputs": {
                    "fl2va_model": settings.h3_fl2va_model if easy_mode == "image" else "none",
                    "ref2va_model": settings.h3_ref2va_model if easy_mode != "image" else "none",
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
                    "ref_image_size": (
                        "original"
                        if easy_mode == "image"
                        else str(payload.get("ref_image_size") or "match")
                    ),
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
                    "model": ["2", 0],
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

        model_source: list[Any] = ["24", 0] if use_turbo else ["2", 0]

        if staged_guides or control_mode != "none":
            # Official native MiniMax H3 multiframe/control workflows use
            # res_multistep. Keep the legacy Easy path on euler.
            workflow["7"]["inputs"]["sampler_name"] = "res_multistep"

        if control_mode != "none":
            if str(settings.h3_controlnet_model_patch).strip().lower() in {"", "none"}:
                raise ComfyUIError(
                    "H3 ControlNet is not configured. Set H3_CONTROLNET_MODEL_PATCH."
                )

            workflow["306"] = {
                "class_type": "ModelPatchLoader",
                "inputs": {"name": settings.h3_controlnet_model_patch},
            }

            control_image_ref: list[Any] | None = None
            source_image_ref: list[Any] | None = None
            mask_ref: list[Any] | None = None

            control_video_name = staged_control.get("control_video")
            if control_video_name:
                workflow["300"] = {
                    "class_type": "LoadVideo",
                    "inputs": {"file": control_video_name},
                }
                workflow["301"] = {
                    "class_type": "GetVideoComponents",
                    "inputs": {"video": ["300", 0]},
                }
                control_image_ref = ["301", 0]
                if control_mode == "canny_auto":
                    workflow["302"] = {
                        "class_type": "Canny",
                        "inputs": {
                            "image": control_image_ref,
                            "low_threshold": float(staged_control.get("canny_low") or 0.4),
                            "high_threshold": float(staged_control.get("canny_high") or 0.8),
                        },
                    }
                    control_image_ref = ["302", 0]

            source_video_name = staged_control.get("source_video")
            if source_video_name:
                workflow["310"] = {
                    "class_type": "LoadVideo",
                    "inputs": {"file": source_video_name},
                }
                workflow["311"] = {
                    "class_type": "GetVideoComponents",
                    "inputs": {"video": ["310", 0]},
                }
                source_image_ref = ["311", 0]

            mask_video_name = staged_control.get("mask_video")
            if mask_video_name:
                workflow["312"] = {
                    "class_type": "LoadVideo",
                    "inputs": {"file": mask_video_name},
                }
                workflow["313"] = {
                    "class_type": "GetVideoComponents",
                    "inputs": {"video": ["312", 0]},
                }
                workflow["314"] = {
                    "class_type": "ImageToMask",
                    "inputs": {
                        "image": ["313", 0],
                        "channel": "red",
                    },
                }
                mask_ref = ["314", 0]

            apply_inputs: dict[str, Any] = {
                "model": model_source,
                "model_patch": ["306", 0],
                "vae": ["13", 2],
                "strength": float(staged_control.get("strength") or 1.0),
                "start_percent": float(staged_control.get("start_percent") or 0.0),
                "end_percent": float(staged_control.get("end_percent") or 1.0),
            }
            if control_image_ref is not None:
                apply_inputs["control_video"] = control_image_ref
            if mask_ref is not None:
                apply_inputs["mask"] = mask_ref
            if source_image_ref is not None:
                apply_inputs["source_video"] = source_image_ref

            workflow["307"] = {
                "class_type": "MiniMaxH3FunControlNetApply",
                "inputs": apply_inputs,
            }
            model_source = ["307", 0]

        workflow["34"]["inputs"]["model"] = model_source

        if staged_guides:
            positive_ref: list[Any] = ["13", 0]
            for index, guide in enumerate(staged_guides, start=1):
                load_id = str(400 + index)
                guide_id = str(500 + index)
                workflow[load_id] = {
                    "class_type": "LoadImage",
                    "inputs": {"image": guide["name"]},
                }
                workflow[guide_id] = {
                    "class_type": "MiniMaxH3AddGuide",
                    "inputs": {
                        "positive": positive_ref,
                        "latent": ["13", 1],
                        "vae": ["13", 2],
                        "audio_vae": ["13", 3],
                        "image": [load_id, 0],
                        "frame_idx": int(round(float(guide.get("time_seconds") or 0.0) * fps)),
                    },
                }
                positive_ref = [guide_id, 0]

            workflow["31"] = {
                "class_type": "RandomNoise",
                "inputs": {"noise_seed": seed},
            }
            workflow["32"] = {
                "class_type": "BasicGuider",
                "inputs": {
                    "model": ["34", 0],
                    "conditioning": positive_ref,
                },
            }
            workflow["30"] = {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {
                    "noise": ["31", 0],
                    "guider": ["32", 0],
                    "sampler": ["7", 0],
                    "sigmas": ["5", 0],
                    "latent_image": ["13", 1],
                },
            }

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

    def _find_image_output(self, history: dict[str, Any]) -> dict[str, str] | None:
        outputs = history.get("outputs") or {}
        candidates: list[dict[str, str]] = []

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                filename = value.get("filename")
                if isinstance(filename, str) and filename.lower().endswith(
                    (".png", ".jpg", ".jpeg", ".webp")
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
