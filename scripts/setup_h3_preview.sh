#!/usr/bin/env bash
set -euo pipefail

# Install the optional MiniMax H3 preview node without modifying the site's
# Python environment or interrupting a running video-generation service.
comfyui_root="${COMFYUI_ROOT:-/opt/ai/ComfyUI}"
plugin_root="${comfyui_root}/custom_nodes/ComfyUI-MiniMaxH3-PreviewOverride"
decoder_source="${plugin_root}/minivae/taeh3_decoder.safetensors"
decoder_directory="${comfyui_root}/models/vae_approx"
decoder_target="${decoder_directory}/taeh3_decoder.safetensors"
site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nonce_source="${site_root}/comfyui_nodes/aivideosite_run_nonce.py"
nonce_target="${comfyui_root}/custom_nodes/aivideosite_run_nonce.py"

if [[ ! -d "${comfyui_root}/custom_nodes" ]]; then
  echo "ComfyUI not found: ${comfyui_root}" >&2
  exit 1
fi

if [[ ! -d "${plugin_root}/.git" ]]; then
  if [[ -e "${plugin_root}" ]]; then
    echo "Existing non-git directory must be reviewed: ${plugin_root}" >&2
    exit 1
  fi
  git clone --depth 1 https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride.git "${plugin_root}"
else
  echo "Preview node is already installed; leaving its version unchanged."
fi

if [[ ! -f "${decoder_source}" ]] || (( $(stat -c '%s' "${decoder_source}") < 1000000 )); then
  echo "Tiny VAE decoder missing or incomplete: ${decoder_source}" >&2
  exit 1
fi

mkdir -p "${decoder_directory}"
if [[ ! -e "${decoder_target}" ]]; then
  cp "${decoder_source}" "${decoder_target}"
fi

if (( $(stat -c '%s' "${decoder_target}") < 1000000 )); then
  echo "Installed Tiny VAE looks incomplete: ${decoder_target}" >&2
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

echo "H3 preview, Tiny VAE and per-generation cache-bypass node are ready."
echo "When both GPUs are idle, restart ComfyUI:"
echo "  sudo systemctl restart comfyui.service comfyui-secondary.service"
echo "After pulling updated site code, also restart aivideosite.service when jobs are idle."
