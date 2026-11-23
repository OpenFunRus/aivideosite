#!/usr/bin/env bash
set -euo pipefail

echo "Removing retired MiniMax H3 Image weights..."
if [[ -d /opt/ai/ComfyUI/models ]]; then
  find /opt/ai/ComfyUI/models -type f \( \
    -name 'MiniMax-H3-Image-AD-Q4_K.gguf' -o \
    -name 'minimax_h3_image_vae_fp16.safetensors' \
  \) -print -delete
fi

echo "Removing retired Qwen3-8B assistant GGUF files..."
if [[ -d /opt/ai ]]; then
  find /opt/ai -type f \( \
    -iname '*qwen3-8b*.gguf' -o \
    -iname '*qwen3_8b*.gguf' -o \
    -iname '*qwen3-8b*.gguf.part' -o \
    -iname '*qwen3_8b*.gguf.part' \
  \) -print -delete
fi

if [[ -f /opt/ai/aivideosite/.env ]]; then
  sed -i '/^H3_IMAGE_MODEL=/d;/^H3_IMAGE_VAE=/d' /opt/ai/aivideosite/.env
fi

echo "Removing retired generated-image storage..."
rm -rf /opt/ai/aivideosite/data/images

echo "Cleanup complete."
echo "Kept intentionally: qwen3vl_32b MiniMax H3 text encoder, Qwen3-TTS voice tooling/presets, and Gemma4 GGUF."
