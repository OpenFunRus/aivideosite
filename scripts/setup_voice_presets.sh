#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VOICE_PRESET_VENV:-$ROOT/data/qwen-tts-venv}"
HF_HOME="${HF_HOME:-$ROOT/data/huggingface}"
GPU="${VOICE_PRESET_GPU:-0}"
OUT="$ROOT/data/voice_presets"

mkdir -p "$ROOT/data" "$HF_HOME" "$OUT"

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install -U pip wheel
"$VENV/bin/python" -m pip install   "qwen-tts==0.1.1"   "transformers==4.57.3"   "accelerate>=1.0"   "soundfile>=0.13"   "numpy>=1.26"

echo "Generating Qwen3-TTS voice presets on physical GPU $GPU..."
CUDA_VISIBLE_DEVICES="$GPU" HF_HOME="$HF_HOME"   "$VENV/bin/python" "$ROOT/scripts/generate_voice_presets.py"   --output-dir "$OUT"   --device cuda:0

echo
echo "Generated presets:"
ls -lh "$OUT"/*.wav
echo
echo "Restart aivideosite.service after generation if the Character modal is already open."
