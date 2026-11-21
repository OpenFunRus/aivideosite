#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
SPEAKERS = {
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

RU_TEXT = "Привет, это мой голос."
EN_TEXT = "Hello, this is my voice."


def _mono(wav: object) -> np.ndarray:
    array = np.asarray(wav, dtype=np.float32)
    if array.ndim == 2:
        array = array.mean(axis=-1)
    return np.ascontiguousarray(array.reshape(-1), dtype=np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate bilingual Qwen3-TTS Character voice presets.")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--pause-ms", type=int, default=280)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    use_cuda = str(args.device).startswith("cuda") and torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda else torch.float32
    print(f"Loading {args.model} on {args.device} ({dtype})...")

    model = Qwen3TTSModel.from_pretrained(
        args.model,
        device_map=args.device,
        dtype=dtype,
    )

    for preset_id, speaker in SPEAKERS.items():
        target = args.output_dir / f"{preset_id}.wav"
        print(f"[{preset_id}] {speaker}: Russian...")
        ru_wavs, ru_sr = model.generate_custom_voice(
            text=RU_TEXT,
            language="Russian",
            speaker=speaker,
            instruct="Speak naturally, clearly, and neutrally.",
        )
        print(f"[{preset_id}] {speaker}: English...")
        en_wavs, en_sr = model.generate_custom_voice(
            text=EN_TEXT,
            language="English",
            speaker=speaker,
            instruct="Speak naturally, clearly, and neutrally.",
        )
        if int(ru_sr) != int(en_sr):
            raise RuntimeError(f"Sample-rate mismatch for {speaker}: {ru_sr} vs {en_sr}")

        ru = _mono(ru_wavs[0])
        en = _mono(en_wavs[0])
        silence = np.zeros(max(1, int(int(ru_sr) * args.pause_ms / 1000)), dtype=np.float32)
        combined = np.concatenate([ru, silence, en])

        peak = float(np.max(np.abs(combined))) if combined.size else 0.0
        if peak > 0.98:
            combined = combined * (0.98 / peak)

        sf.write(target, combined, int(ru_sr), subtype="PCM_16")
        print(f"[{preset_id}] wrote {target} ({combined.size / int(ru_sr):.2f}s)")

    print("Done. Voice presets:", args.output_dir)


if __name__ == "__main__":
    main()
