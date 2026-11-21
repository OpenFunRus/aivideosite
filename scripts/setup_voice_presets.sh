#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VOICE_PRESET_VENV:-$ROOT/data/qwen-tts-venv}"
HF_HOME="${HF_HOME:-$ROOT/data/huggingface}"
GPU_REQUEST="${VOICE_PRESET_GPU:-auto}"
MIN_FREE_MB="${VOICE_PRESET_MIN_FREE_MB:-7000}"
OUT="$ROOT/data/voice_presets"

mkdir -p "$ROOT/data" "$HF_HOME" "$OUT"

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install -U pip wheel
"$VENV/bin/python" -m pip install \
  "qwen-tts==0.1.1" \
  "transformers==4.57.3" \
  "accelerate>=1.0" \
  "soundfile>=0.13" \
  "numpy>=1.26"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: nvidia-smi not found; Qwen3-TTS preset generation requires an NVIDIA GPU." >&2
  exit 2
fi

mapfile -t GPU_ROWS < <(
  nvidia-smi --query-gpu=index,name,memory.free,memory.total \
    --format=csv,noheader,nounits
)

if [[ "${#GPU_ROWS[@]}" -eq 0 ]]; then
  echo "ERROR: no NVIDIA GPUs reported by nvidia-smi." >&2
  exit 2
fi

echo "GPU memory before preset generation:"
printf '  %s\n' "${GPU_ROWS[@]}"

if [[ "$GPU_REQUEST" == "auto" ]]; then
  BEST_INDEX=""
  BEST_FREE=-1
  BEST_NAME=""
  for row in "${GPU_ROWS[@]}"; do
    IFS=',' read -r raw_index raw_name raw_free raw_total <<< "$row"
    index="$(echo "$raw_index" | xargs)"
    name="$(echo "$raw_name" | xargs)"
    free="$(echo "$raw_free" | xargs)"
    if [[ "$free" =~ ^[0-9]+$ ]] && (( free > BEST_FREE )); then
      BEST_INDEX="$index"
      BEST_FREE="$free"
      BEST_NAME="$name"
    fi
  done

  if [[ -z "$BEST_INDEX" ]]; then
    echo "ERROR: failed to parse free GPU memory." >&2
    exit 2
  fi
  GPU="$BEST_INDEX"
  FREE_MB="$BEST_FREE"
  GPU_NAME="$BEST_NAME"
else
  GPU="$GPU_REQUEST"
  MATCH="$(printf '%s\n' "${GPU_ROWS[@]}" | awk -F',' -v gpu="$GPU" '{gsub(/ /,"",$1); if ($1==gpu) print $0;}' | head -n1)"
  if [[ -z "$MATCH" ]]; then
    echo "ERROR: requested VOICE_PRESET_GPU=$GPU does not exist." >&2
    exit 2
  fi
  IFS=',' read -r _ raw_name raw_free _ <<< "$MATCH"
  GPU_NAME="$(echo "$raw_name" | xargs)"
  FREE_MB="$(echo "$raw_free" | xargs)"
fi

if ! [[ "$FREE_MB" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not determine free VRAM for GPU $GPU." >&2
  exit 2
fi

if (( FREE_MB < MIN_FREE_MB )); then
  echo "ERROR: not enough free VRAM for Qwen3-TTS VoiceDesign." >&2
  echo "Selected GPU $GPU ($GPU_NAME) has only ${FREE_MB} MiB free; require at least ${MIN_FREE_MB} MiB." >&2
  echo "Stop/wait for H3/ComfyUI generation or choose another GPU with VOICE_PRESET_GPU=<index>." >&2
  exit 3
fi

echo "Selected physical GPU $GPU: $GPU_NAME (${FREE_MB} MiB free)."
echo "Generating Russian-only Qwen3-TTS voice presets."
echo "Old bilingual WAV files are automatically regenerated once; current Russian WAVs are kept."
echo

export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

CUDA_VISIBLE_DEVICES="$GPU" HF_HOME="$HF_HOME" \
  "$VENV/bin/python" "$ROOT/scripts/generate_voice_presets.py" \
  --output-dir "$OUT" \
  --device cuda:0

echo
echo "Available presets (target: 16 = 8 male + 8 female):"
find "$OUT" -maxdepth 1 -type f -name '*.wav' -printf '%f\n' | sort
echo
echo "Restart aivideosite.service if the Character modal is already open."
