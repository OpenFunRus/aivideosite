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
    h3_controlnet_model_patch: str
    h3_attention_backend: str

    max_image_upload_bytes: int
    max_video_upload_bytes: int
    max_audio_upload_bytes: int


_data_dir = _path("DATA_DIR", ROOT_DIR / "data")
_data_dir.mkdir(parents=True, exist_ok=True)


def _valid_site_users(payload: object) -> tuple[SiteUser, ...]:
    entries: list[tuple[str, object]] = []
    if isinstance(payload, dict):
        entries = [(str(key), value) for key, value in payload.items()]
    elif isinstance(payload, list):
        entries = [
            (str(item.get("id") or f"user{index}"), item)
            for index, item in enumerate(payload, start=1)
            if isinstance(item, dict)
        ]

    users: list[SiteUser] = []
    seen_ids: set[str] = set()
    seen_passwords: set[str] = set()
    for fallback_id, raw in entries:
        if not isinstance(raw, dict):
            continue
        user_id = str(raw.get("id") or fallback_id).strip()
        label = str(raw.get("label") or raw.get("name") or user_id).strip()
        password = str(raw.get("password") or "").strip()
        enabled = raw.get("enabled", True)
        if enabled is False:
            continue
        if (
            not user_id
            or len(user_id) > 64
            or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for ch in user_id)
            or not label
            or len(label) > 80
            or not password
            or user_id in seen_ids
            or password in seen_passwords
        ):
            continue
        seen_ids.add(user_id)
        seen_passwords.add(password)
        users.append(SiteUser(id=user_id, label=label, password=password))
    return tuple(users)


def _site_users() -> tuple[SiteUser, ...]:
    configured_json = os.getenv("SITE_USERS_JSON", "").strip()
    if configured_json:
        try:
            users = _valid_site_users(json.loads(configured_json))
        except json.JSONDecodeError:
            users = ()
        if users:
            return users

    # Backward-compatible numbered env config. Adding SITE_USER4_PASSWORD,
    # SITE_USER5_PASSWORD, ... now requires no source-code changes.
    numbered_payload: dict[str, dict[str, str]] = {}
    for index in range(1, 101):
        password = os.getenv(f"SITE_USER{index}_PASSWORD", "").strip()
        if not password:
            continue
        user_id = os.getenv(f"SITE_USER{index}_ID", f"user{index}").strip() or f"user{index}"
        label = (
            os.getenv(f"SITE_USER{index}_NAME", f"Пользователь {index}").strip()
            or f"Пользователь {index}"
        )
        numbered_payload[user_id] = {
            "id": user_id,
            "label": label,
            "password": password,
        }
    users = _valid_site_users(numbered_payload)
    if users:
        return users

    users_file = _data_dir / ".site_users.json"
    try:
        users = _valid_site_users(json.loads(users_file.read_text(encoding="utf-8")))
        if users:
            return users
    except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError):
        pass

    # First-run compatibility: create the same three local profiles as before,
    # but store them in the new arbitrary-user format.
    passwords: list[str] = []
    while len(passwords) < 3:
        password = str(100000 + secrets.randbelow(900000))
        if password not in passwords:
            passwords.append(password)

    payload = {
        f"user{index}": {
            "id": f"user{index}",
            "label": f"Пользователь {index}",
            "password": passwords[index - 1],
            "enabled": True,
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

    return _valid_site_users(payload)


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
    h3_ref_turbo_lora=os.getenv(
        "H3_REF_TURBO_LORA",
        "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    ),
    h3_controlnet_model_patch=os.getenv(
        "H3_CONTROLNET_MODEL_PATCH",
        "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors",
    ),
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
):
    directory.mkdir(parents=True, exist_ok=True)
