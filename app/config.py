from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")


def _path(name: str, default: str | Path) -> Path:
    return Path(os.getenv(name, str(default))).expanduser().resolve()


@dataclass(frozen=True)
class SiteUser:
    id: str
    label: str
    password: str


@dataclass(frozen=True)
class Settings:
    root_dir: Path
    data_dir: Path
    upload_dir: Path
    library_dir: Path
    character_dir: Path
    temp_dir: Path
    db_path: Path

    site_users: tuple[SiteUser, ...]
    session_secret: str
    host: str
    port: int

    comfyui_url: str
    comfyui_secondary_url: str
    comfyui_output_dir: Path
    comfyui_input_dir: Path

    ffmpeg_bin: Path
    ffprobe_bin: Path

    h3_fl2va_model: str
    h3_ref2va_model: str
    h3_text_encoder: str
    h3_video_vae: str
    h3_audio_vae: str
    h3_turbo_lora: str
    h3_ref_turbo_lora: str
    h3_attention_backend: str

    max_image_upload_bytes: int
    max_video_upload_bytes: int
    max_audio_upload_bytes: int


_data_dir = _path("DATA_DIR", ROOT_DIR / "data")
_data_dir.mkdir(parents=True, exist_ok=True)


def _site_users() -> tuple[SiteUser, ...]:
    labels = (
        os.getenv("SITE_USER1_NAME", "Пользователь 1").strip() or "Пользователь 1",
        os.getenv("SITE_USER2_NAME", "Пользователь 2").strip() or "Пользователь 2",
        os.getenv("SITE_USER3_NAME", "Пользователь 3").strip() or "Пользователь 3",
    )
    configured = tuple(
        os.getenv(f"SITE_USER{index}_PASSWORD", "").strip()
        for index in range(1, 4)
    )

    if all(configured) and len(set(configured)) == 3:
        return tuple(
            SiteUser(id=f"user{index}", label=labels[index - 1], password=password)
            for index, password in enumerate(configured, start=1)
        )

    users_file = _data_dir / ".site_users.json"
    try:
        payload = json.loads(users_file.read_text(encoding="utf-8"))
        passwords = tuple(str(payload[f"user{index}"]["password"]) for index in range(1, 4))
        if all(passwords) and len(set(passwords)) == 3:
            return tuple(
                SiteUser(
                    id=f"user{index}",
                    label=str(payload[f"user{index}"].get("label") or labels[index - 1]),
                    password=passwords[index - 1],
                )
                for index in range(1, 4)
            )
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass

    passwords: list[str] = []
    while len(passwords) < 3:
        password = str(100000 + secrets.randbelow(900000))
        if password not in passwords:
            passwords.append(password)

    payload = {
        f"user{index}": {
            "label": labels[index - 1],
            "password": passwords[index - 1],
        }
        for index in range(1, 4)
    }
    users_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    try:
        users_file.chmod(0o600)
    except OSError:
        pass

    return tuple(
        SiteUser(
            id=f"user{index}",
            label=labels[index - 1],
            password=passwords[index - 1],
        )
        for index in range(1, 4)
    )


def _session_secret() -> str:
    configured = os.getenv("SESSION_SECRET", "").strip()
    if configured and configured != "auto":
        return configured

    secret_file = _data_dir / ".session_secret"
    try:
        value = secret_file.read_text(encoding="utf-8").strip()
        if value:
            return value
    except FileNotFoundError:
        pass

    value = secrets.token_urlsafe(48)
    secret_file.write_text(value, encoding="utf-8")
    try:
        secret_file.chmod(0o600)
    except OSError:
        pass
    return value


settings = Settings(
    root_dir=ROOT_DIR,
    data_dir=_data_dir,
    upload_dir=_data_dir / "uploads",
    library_dir=_data_dir / "library",
    character_dir=_data_dir / "characters",
    temp_dir=_data_dir / "tmp",
    db_path=_data_dir / "aivideosite.db",
    site_users=_site_users(),
    session_secret=_session_secret(),
    host=os.getenv("HOST", "0.0.0.0"),
    port=int(os.getenv("PORT", "8000")),
    comfyui_url=os.getenv("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/"),
    comfyui_secondary_url=os.getenv("COMFYUI_SECONDARY_URL", "http://127.0.0.1:8189").rstrip("/"),
    comfyui_output_dir=_path("COMFYUI_OUTPUT_DIR", "/opt/ai/ComfyUI/output"),
    comfyui_input_dir=_path("COMFYUI_INPUT_DIR", "/opt/ai/ComfyUI/input"),
    ffmpeg_bin=_path("FFMPEG_BIN", "/usr/bin/ffmpeg"),
    ffprobe_bin=_path("FFPROBE_BIN", "/usr/bin/ffprobe"),
    h3_fl2va_model=os.getenv(
        "H3_FL2VA_MODEL",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    ),
    h3_ref2va_model=os.getenv(
        "H3_REF2VA_MODEL",
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    ),
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
    h3_ref_turbo_lora=os.getenv("H3_REF_TURBO_LORA", "none"),
    h3_attention_backend=os.getenv(
        "H3_ATTENTION_BACKEND",
        "comfy kitchen attention",
    ),
    max_image_upload_bytes=int(os.getenv("MAX_IMAGE_UPLOAD_MB", "40")) * 1024 * 1024,
    max_video_upload_bytes=int(os.getenv("MAX_VIDEO_UPLOAD_MB", "500")) * 1024 * 1024,
    max_audio_upload_bytes=int(os.getenv("MAX_AUDIO_UPLOAD_MB", "300")) * 1024 * 1024,
)

for directory in (
    settings.data_dir,
    settings.upload_dir,
    settings.library_dir,
    settings.character_dir,
    settings.temp_dir,
    settings.comfyui_input_dir,
):
    directory.mkdir(parents=True, exist_ok=True)
