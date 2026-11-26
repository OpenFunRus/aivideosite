#!/usr/bin/env bash
set -euo pipefail

# Install the optional MiniMax H3 preview node without modifying the site's
# Python environment or interrupting a running video-generation service.
comfyui_root="${COMFYUI_ROOT:-/opt/ai/ComfyUI}"
plugin_root="${comfyui_root}/custom_nodes/ComfyUI-MiniMaxH3-PreviewOverride"
decoder_source="${plugin_root}/minivae/taeh3_decoder.safetensors"
decoder_directory="${comfyui_root}/models/vae_approx"
decoder_target="${decoder_directory}/taeh3_decoder.safetensors"

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

echo "H3 live preview node and Tiny VAE are ready."
echo "When both GPUs are idle, restart ComfyUI:"
echo "  sudo systemctl restart comfyui.service comfyui-secondary.service"
echo "The website itself does not need to be restarted after installing the node."
