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
        "clear articulation in both Russian and English, not an announcer voice."
    ),
    "max": (
        "Male, around 24 years old, youthful light baritone to tenor, energetic and friendly, "
        "modern natural speech, clear bright articulation, lively without sounding cartoonish, "
        "comfortable in both Russian and English."
    ),
    "anton": (
        "Male, around 35 years old, low-mid register, rugged slightly raspy timbre, restrained and serious, "
        "natural conversational rhythm, dry mature texture, clear Russian and English pronunciation."
    ),
    "elena": (
        "Female, around 40 years old, warm mature contralto, calm and trustworthy, "
        "softly authoritative, natural conversational delivery, rich low resonance, "
        "clear articulation in Russian and English."
    ),
    "mira": (
        "Female, around 22 years old, soft clear mezzo-soprano, gentle and intimate, "
        "young natural voice, smooth breathy warmth without whispering, "
        "clear Russian and English pronunciation."
    ),
    "vera": (
        "Female, around 32 years old, low mezzo to contralto, confident and composed, "
        "slightly smoky timbre, modern natural speech, restrained emotion, "
        "clear articulation in both Russian and English."
    ),
    "alisa": (
        "Female, around 26 years old, bright expressive mezzo-soprano, energetic and playful, "
        "crisp modern delivery, friendly confident presence, lively but natural, "
        "clear Russian and English pronunciation."
    ),
}

RU_TEXT = "Привет, это мой голос."
EN_TEXT = "Hello, this is my voice."
BILINGUAL_TEXT = f"{RU_TEXT} {EN_TEXT}"


def _mono(wav: object) -> np.ndarray:
    array = np.asarray(wav, dtype=np.float32)
    if array.ndim == 2:
        array = array.mean(axis=-1)
    return np.ascontiguousarray(array.reshape(-1), dtype=np.float32)


def _write_wav(target: Path, wav: object, sample_rate: int) -> None:
    audio = _mono(wav)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio = audio * (0.98 / peak)
    sf.write(target, audio, int(sample_rate), subtype="PCM_16")
    print(f"[{target.stem}] wrote {target} ({audio.size / int(sample_rate):.2f}s)")


def _write_bilingual_pair(
    target: Path,
    ru_wav: object,
    en_wav: object,
    sample_rate: int,
    pause_ms: int,
) -> None:
    ru = _mono(ru_wav)
    en = _mono(en_wav)
    silence = np.zeros(max(1, int(int(sample_rate) * pause_ms / 1000)), dtype=np.float32)
    _write_wav(target, np.concatenate([ru, silence, en]), sample_rate)


def _missing(output_dir: Path, ids: list[str], force: bool) -> list[str]:
    if force:
        return ids
    return [
        preset_id
        for preset_id in ids
        if not (output_dir / f"{preset_id}.wav").is_file()
        or (output_dir / f"{preset_id}.wav").stat().st_size <= 1024
    ]


def _release(model: object | None) -> None:
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate bilingual Qwen3-TTS Character voice presets.")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--custom-model", default=CUSTOM_MODEL_ID)
    parser.add_argument("--design-model", default=DESIGN_MODEL_ID)
    parser.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--pause-ms", type=int, default=280)
    parser.add_argument("--force", action="store_true", help="Regenerate presets that already exist.")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    use_cuda = str(args.device).startswith("cuda") and torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda else torch.float32

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
                ru_wavs, ru_sr = custom_model.generate_custom_voice(
                    text=RU_TEXT,
                    language="Russian",
                    speaker=speaker,
                    instruct="Speak naturally, clearly, and neutrally.",
                )
                print(f"[{preset_id}] {speaker}: English...")
                en_wavs, en_sr = custom_model.generate_custom_voice(
                    text=EN_TEXT,
                    language="English",
                    speaker=speaker,
                    instruct="Speak naturally, clearly, and neutrally.",
                )
                if int(ru_sr) != int(en_sr):
                    raise RuntimeError(f"Sample-rate mismatch for {speaker}: {ru_sr} vs {en_sr}")
                _write_bilingual_pair(
                    target,
                    ru_wavs[0],
                    en_wavs[0],
                    int(ru_sr),
                    args.pause_ms,
                )
        finally:
            _release(custom_model)
    else:
        print("CustomVoice presets already exist; skipping the 0.6B model.")

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
                print(f"[{preset_id}] VoiceDesign...")
                wavs, sr = design_model.generate_voice_design(
                    text=BILINGUAL_TEXT,
                    language="Auto",
                    instruct=instruct,
                )
                _write_wav(target, wavs[0], int(sr))
        finally:
            _release(design_model)
    else:
        print("VoiceDesign presets already exist; skipping the 1.7B model.")

    print("Done. Voice presets:", args.output_dir)


if __name__ == "__main__":
    main()
