# Built-in Character voice presets

The V2 Character modal uses sixteen preset timbres generated with official Qwen3-TTS models.

## Source model

- CustomVoice model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- VoiceDesign model: `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`
- Upstream: https://github.com/QwenLM/Qwen3-TTS
- Model cards: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice and https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
- License declared by the model cards: Apache-2.0
- Both model families support Russian and English.

Preset voices used by the site:

- built-in male: Ryan, Aiden, Uncle_Fu, Dylan, Eric;
- designed male: Viktor, Max, Anton;
- built-in female: Vivian, Serena, Ono_Anna, Sohee;
- designed female: Elena, Mira, Vera, Alisa.

The built-in speakers come from CustomVoice. The seven additional voices are synthesized once with VoiceDesign from explicit age/timbre/style descriptions. The site keeps existing WAV files and generates only missing presets.

Every sample contains both:
- Russian: `Привет, это мой голос.`
- English: `Hello, this is my voice.`

CustomVoice samples are generated as Russian + English segments from the same built-in speaker. VoiceDesign samples use the combined bilingual sentence in one generation so both languages share the same designed timbre.

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
