from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")


def _path(name: str, default: str | Path) -> Path:
    return Path(os.getenv(name, str(default))).expanduser().resolve()


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    data_dir: Path
    upload_dir: Path
    library_dir: Path
    temp_dir: Path
    db_path: Path

    site_password: str
    session_secret: str
    host: str
    port: int

    comfyui_url: str
    comfyui_output_dir: Path

    latentsync_dir: Path
    latentsync_python: Path

    ffmpeg_bin: Path
    ffprobe_bin: Path

    h3_fl2va_model: str
    h3_ref2va_model: str
    h3_text_encoder: str
    h3_video_vae: str
    h3_audio_vae: str
    h3_turbo_lora: str
    h3_attention_backend: str

    max_image_upload_bytes: int
    max_audio_upload_bytes: int


_data_dir = _path("DATA_DIR", ROOT_DIR / "data")

settings = Settings(
    root_dir=ROOT_DIR,
    data_dir=_data_dir,
    upload_dir=_data_dir / "uploads",
    library_dir=_data_dir / "library",
    temp_dir=_data_dir / "tmp",
    db_path=_data_dir / "aivideosite.db",
    site_password=os.getenv("SITE_PASSWORD", "11332244"),
    session_secret=os.getenv("SESSION_SECRET", "change-this-local-session-secret"),
    host=os.getenv("HOST", "0.0.0.0"),
    port=int(os.getenv("PORT", "8000")),
    comfyui_url=os.getenv("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/"),
    comfyui_output_dir=_path("COMFYUI_OUTPUT_DIR", "/opt/ai/ComfyUI/output"),
    latentsync_dir=_path("LATENTSYNC_DIR", "/opt/ai/LatentSync"),
    latentsync_python=_path(
        "LATENTSYNC_PYTHON",
        "/home/openfun/miniconda3/envs/latentsync/bin/python",
    ),
    ffmpeg_bin=_path("FFMPEG_BIN", "/usr/bin/ffmpeg"),
    ffprobe_bin=_path("FFPROBE_BIN", "/usr/bin/ffprobe"),
    h3_fl2va_model=os.getenv(
        "H3_FL2VA_MODEL",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    ),
    h3_ref2va_model=os.getenv("H3_REF2VA_MODEL", "none"),
    h3_text_encoder=os.getenv(
        "H3_TEXT_ENCODER",
        "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    ),
    h3_video_vae=os.getenv(
        "H3_VIDEO_VAE",
        "minimax_h3_video_vae_fp16.safetensors",
    ),
    h3_audio_vae=os.getenv(
        "H3_AUDIO_VAE",
        "minimax_h3_audio_vae_fp32.safetensors",
    ),
    h3_turbo_lora=os.getenv(
        "H3_TURBO_LORA",
        "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    ),
    h3_attention_backend=os.getenv(
        "H3_ATTENTION_BACKEND",
        "comfy kitchen attention",
    ),
    max_image_upload_bytes=int(os.getenv("MAX_IMAGE_UPLOAD_MB", "40")) * 1024 * 1024,
    max_audio_upload_bytes=int(os.getenv("MAX_AUDIO_UPLOAD_MB", "300")) * 1024 * 1024,
)

for directory in (
    settings.data_dir,
    settings.upload_dir,
    settings.library_dir,
    settings.temp_dir,
):
    directory.mkdir(parents=True, exist_ok=True)
