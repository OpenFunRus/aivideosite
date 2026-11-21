# Built-in Character voice presets

The V2 Character modal uses nine preset timbres generated with the official Qwen3-TTS CustomVoice model.

## Source model

- Model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- Upstream: https://github.com/QwenLM/Qwen3-TTS
- Model card: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
- License declared by the model card: Apache-2.0
- Supported languages include Russian and English.

Preset speakers used by the site:

- male: Ryan, Aiden, Uncle_Fu, Dylan, Eric;
- female: Vivian, Serena, Ono_Anna, Sohee.

The model documentation states that every built-in speaker can speak any supported language. The site generates two short segments for every preset and joins them into one reference WAV:

- Russian: `Привет, это мой голос.`
- English: `Hello, this is my voice.`

## Project behaviour

- `scripts/setup_voice_presets.sh` creates an isolated runtime under `data/qwen-tts-venv/`.
- Hugging Face model cache is stored under `data/huggingface/`.
- Generated WAV files are stored under `data/voice_presets/`.
- The normal web app does not load Qwen3-TTS and does not consume TTS VRAM during ordinary use.
- Saving a Character with a preset copies the selected WAV into the Character directory as `voice.wav`.
- H3 then treats it through the existing Character `voice_file` reference pipeline.
- The web UI intentionally does not display licensing text on the voice cards.

## User-uploaded voices

This note only documents the built-in preset source. It does not grant rights to third-party recordings or voice clones uploaded by users. Users are responsible for having the necessary rights/permissions for their own audio.

This file records the project's technical/licensing basis and is not legal advice.
