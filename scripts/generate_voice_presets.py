#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


CUSTOM_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
DESIGN_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
PRESET_VERSION = "ru-only-v1"
RU_TEXT = "Привет, это мой голос."

CUSTOM_SPEAKERS = {
    "ryan": "Ryan",
    "aiden": "Aiden",
    "uncle_fu": "Uncle_Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "vivian": "Vivian",
    "serena": "Serena",
    "ono_anna": "Ono_Anna",
    "sohee": "Sohee",
}

DESIGNED_VOICES = {
    "viktor": (
        "Male, around 45 years old, deep baritone, grounded and cinematic, "
        "slightly rough texture, calm confident presence, natural conversational delivery, "
        "clear native-like Russian articulation, not an announcer voice."
    ),
    "max": (
        "Male, around 24 years old, youthful light baritone to tenor, energetic and friendly, "
        "modern natural speech, clear bright articulation, lively without sounding cartoonish, "
        "natural Russian pronunciation."
    ),
    "anton": (
        "Male, around 35 years old, low-mid register, rugged slightly raspy timbre, restrained and serious, "
        "natural conversational rhythm, dry mature texture, clear Russian pronunciation."
    ),
    "elena": (
        "Female, around 40 years old, warm mature contralto, calm and trustworthy, "
        "softly authoritative, natural conversational delivery, rich low resonance, "
        "clear Russian articulation."
    ),
    "mira": (
        "Female, around 22 years old, soft clear mezzo-soprano, gentle and intimate, "
        "young natural voice, smooth breathy warmth without whispering, "
        "clear natural Russian pronunciation."
    ),
    "vera": (
        "Female, around 32 years old, low mezzo to contralto, confident and composed, "
        "slightly smoky timbre, modern natural speech, restrained emotion, "
        "clear Russian articulation."
    ),
    "alisa": (
        "Female, around 26 years old, bright expressive mezzo-soprano, energetic and playful, "
        "crisp modern delivery, friendly confident presence, lively but natural, "
        "clear Russian pronunciation."
    ),
}


def _mono(wav: object) -> np.ndarray:
    array = np.asarray(wav, dtype=np.float32)
    if array.ndim == 2:
        array = array.mean(axis=-1)
    return np.ascontiguousarray(array.reshape(-1), dtype=np.float32)


def _version_path(target: Path) -> Path:
    return target.with_suffix(target.suffix + ".version")


def _is_current(target: Path) -> bool:
    version_path = _version_path(target)
    if not target.is_file() or target.stat().st_size <= 1024 or not version_path.is_file():
        return False
    try:
        return version_path.read_text(encoding="utf-8").strip() == PRESET_VERSION
    except OSError:
        return False


def _write_wav(target: Path, wav: object, sample_rate: int) -> None:
    audio = _mono(wav)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio = audio * (0.98 / peak)

    temporary = target.with_suffix(".tmp.wav")
    version_tmp = _version_path(target).with_suffix(".version.tmp")
    sf.write(temporary, audio, int(sample_rate), subtype="PCM_16")
    version_tmp.write_text(PRESET_VERSION + "\n", encoding="utf-8")
    temporary.replace(target)
    version_tmp.replace(_version_path(target))
    print(f"[{target.stem}] wrote {target} ({audio.size / int(sample_rate):.2f}s)")


def _missing(output_dir: Path, ids: list[str], force: bool) -> list[str]:
    if force:
        return ids
    return [
        preset_id
        for preset_id in ids
        if not _is_current(output_dir / f"{preset_id}.wav")
    ]


def _release_cuda_cache() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _cuda_dtype(device: str) -> torch.dtype:
    if not str(device).startswith("cuda") or not torch.cuda.is_available():
        return torch.float32
    return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Russian-only Qwen3-TTS Character voice presets.")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--custom-model", default=CUSTOM_MODEL_ID)
    parser.add_argument("--design-model", default=DESIGN_MODEL_ID)
    parser.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--force", action="store_true", help="Regenerate presets even if their version is current.")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    dtype = _cuda_dtype(args.device)
    print(f"Preset format: {PRESET_VERSION}; sample: {RU_TEXT}")

    custom_missing = _missing(args.output_dir, list(CUSTOM_SPEAKERS), args.force)
    design_missing = _missing(args.output_dir, list(DESIGNED_VOICES), args.force)

    if custom_missing:
        print(f"Loading {args.custom_model} on {args.device} ({dtype})...")
        custom_model = Qwen3TTSModel.from_pretrained(
            args.custom_model,
            device_map=args.device,
            dtype=dtype,
        )
        try:
            for preset_id in custom_missing:
                speaker = CUSTOM_SPEAKERS[preset_id]
                target = args.output_dir / f"{preset_id}.wav"
                print(f"[{preset_id}] {speaker}: Russian...")
                wavs, sr = custom_model.generate_custom_voice(
                    text=RU_TEXT,
                    language="Russian",
                    speaker=speaker,
                    instruct="Говори естественно, спокойно и чётко по-русски.",
                )
                _write_wav(target, wavs[0], int(sr))
        finally:
            del custom_model
            _release_cuda_cache()
    else:
        print("CustomVoice Russian presets are current; skipping the 0.6B model.")

    if design_missing:
        print(f"Loading {args.design_model} on {args.device} ({dtype})...")
        design_model = Qwen3TTSModel.from_pretrained(
            args.design_model,
            device_map=args.device,
            dtype=dtype,
        )
        try:
            for preset_id in design_missing:
                target = args.output_dir / f"{preset_id}.wav"
                instruct = DESIGNED_VOICES[preset_id]
                print(f"[{preset_id}] VoiceDesign Russian...")
                wavs, sr = design_model.generate_voice_design(
                    text=RU_TEXT,
                    language="Russian",
                    instruct=instruct,
                )
                _write_wav(target, wavs[0], int(sr))
        finally:
            del design_model
            _release_cuda_cache()
    else:
        print("VoiceDesign Russian presets are current; skipping the 1.7B model.")

    print("Done. Voice presets:", args.output_dir)


if __name__ == "__main__":
    main()
