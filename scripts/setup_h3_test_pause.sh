#!/usr/bin/env bash
set -euo pipefail

# ComfyUI's two GPU services use the same custom_nodes directory.
site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
comfyui_root="${COMFYUI_ROOT:-/opt/ai/ComfyUI}"
node_source="${site_root}/comfyui_nodes/aivideosite_test_pause.py"
node_target="${comfyui_root}/custom_nodes/aivideosite_test_pause.py"
audio_plugin_root="${comfyui_root}/custom_nodes/ComfyUI-MiniMaxH3-AudioPreview"

if [[ ! -d "${comfyui_root}/custom_nodes" || ! -f "${node_source}" ]]; then
  echo "ComfyUI custom_nodes or the site pause node was not found." >&2
  exit 1
fi
if [[ -e "${node_target}" && ! -f "${node_target}" ]]; then
  echo "The pause node target is not a regular file: ${node_target}" >&2
  exit 1
fi

install -m 644 "${node_source}" "${node_target}"
if [[ ! -d "${audio_plugin_root}/.git" ]]; then
  if [[ -e "${audio_plugin_root}" ]]; then
    echo "Existing audio preview directory must be reviewed: ${audio_plugin_root}" >&2
    exit 1
  fi
  git clone --depth 1 https://github.com/Brioch/ComfyUI-MiniMaxH3-Preview.git "${audio_plugin_root}"
else
  echo "H3 audio preview plugin already installed; version unchanged."
fi
echo "Test pause node installed: ${node_target}"
echo "When both GPU queues are idle, restart ComfyUI services and aivideosite.service."
