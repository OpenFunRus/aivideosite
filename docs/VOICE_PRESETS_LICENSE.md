# Built-in Character voice presets

The V2 Character modal offers built-in synthetic voice-reference presets.

## Source

The current preset implementation uses FFmpeg's `flite` audio source with CMU voices:

- `rms` — male;
- `awb` — male;
- `slt` — female.

Additional UI presets are pitch/speed variants of those same source voices. The repository does **not** bundle the original CMU voice databases; the site's installed FFmpeg/libflite provides them at runtime.

References:

- CMU ARCTIC project: http://www.festvox.org/cmu_arctic/
- FFmpeg flite filter: https://ffmpeg.org/ffmpeg-filters.html#flite

## Commercial use

The CMU ARCTIC voice licence states that the voice is free for use for any purpose, commercial or otherwise, subject to its copyright/notice/modification conditions.

Keep this document with the project so the origin and licence basis of the built-in pack remain traceable.

## Application behaviour

- The backend lazily synthesizes a short preview/reference WAV and caches it under `data/voice_presets/`.
- Saving a Character with a preset copies that WAV into the Character directory as `voice.wav`.
- From that point onward it is handled by the existing H3 `voice_file` reference pipeline.
- If the server FFmpeg build has no `flite` filter, built-in presets are reported unavailable and custom voice upload remains available.
- The English preview sentence is only a timbre/reference sample; the generated character can still speak another language when the H3 prompt requests it.

## User-uploaded voices

This licence note covers only the built-in CMU/Flite preset source. It does not grant any rights to voices or audio uploaded by users. Users must have the necessary rights/permissions for their own recordings, voice clones, performances and resulting publications.

This file records the project's technical/licensing basis and is not legal advice.
