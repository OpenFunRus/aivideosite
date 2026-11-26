#!/usr/bin/env bash
set -euo pipefail

# Install only the optional cache-bypass node. No preview or pause plugins.
comfyui_root="${COMFYUI_ROOT:-/opt/ai/ComfyUI}"
site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nonce_source="${site_root}/comfyui_nodes/aivideosite_run_nonce.py"
nonce_target="${comfyui_root}/custom_nodes/aivideosite_run_nonce.py"

if [[ ! -d "${comfyui_root}/custom_nodes" ]]; then
  echo "ComfyUI not found: ${comfyui_root}" >&2
  exit 1
fi
if [[ ! -f "${nonce_source}" ]]; then
  echo "AI Video run nonce source is missing: ${nonce_source}" >&2
  exit 1
fi
if [[ -e "${nonce_target}" && ! -f "${nonce_target}" ]]; then
  echo "AI Video run nonce target is not a file: ${nonce_target}" >&2
  exit 1
fi

install -m 644 "${nonce_source}" "${nonce_target}"
echo "AIVideoRunNonce is installed. Restart ComfyUI when GPUs are idle:"
echo "  sudo systemctl restart comfyui.service comfyui-secondary.service"
