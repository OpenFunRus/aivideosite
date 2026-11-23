#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/opt/ai/models/llm}"
MODEL_NAME="gemma-4-26B-A4B-it-uncensored-heretic-Q4_K_M.gguf"
MODEL_PATH="$MODEL_DIR/$MODEL_NAME"
MODEL_URL="https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/main/$MODEL_NAME?download=true"
PART="$MODEL_PATH.part"

sudo install -d -o openfun -g openfun "$MODEL_DIR"

if [[ -f "$MODEL_PATH" ]] && [[ "$(stat -c%s "$MODEL_PATH")" -gt 16000000000 ]]; then
  echo "Gemma model already exists: $MODEL_PATH"
else
  rm -f "$PART"
  echo "Downloading Gemma4 26B A4B Heretic Q4_K_M (~16.8 GB)..."
  sudo -u openfun curl -L --fail --retry 8 --retry-delay 5 "$MODEL_URL" -o "$PART"
  sudo -u openfun mv "$PART" "$MODEL_PATH"
fi

echo
ls -lh "$MODEL_PATH"
echo
echo "Model ready. Install/reload systemd/llm-assistant.service and restart the service."
