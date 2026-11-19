# MiniMax H3 GPU benchmarks

Этот файл хранит воспроизводимые локальные benchmark-тесты MiniMax H3 на текущей dual-GPU машине. Использовать те же prompt, seed и настройки при сравнении драйверов, attention backend и других оптимизаций H3.

## Baseline — 2026-11-19

### Prompt

```text
A cinematic medium shot of a woman standing in a modern apartment near a large window. She slowly turns her head toward the camera, takes two steps forward, raises one hand and brushes her hair back, then looks directly into the lens with a subtle smile. Natural body motion, realistic cloth movement, detailed face, stable identity, soft daylight, slight handheld camera movement, realistic shadows, cinematic depth of field.
```

### Settings

```text
Seed: 184735920
Resolution: 1344x768
Duration: 5 sec
FPS: 24
Profile: Fast
Steps: 8 / Turbo
H3 Audio: OFF
First frame: none
Last frame: none
```

### Results

| GPU | Exact generation time | Rounded user result | Relative |
| --- | ---: | ---: | ---: |
| RTX 3090 24 GB | 00:03:36 | ~3 min | 1.00x |
| RTX 2080 Ti mod 22 GB | 00:06:15 | ~6 min | 1.74x slower |

Observed from the site Queue after both completed. The same prompt/settings were used for the comparison.

### Notes

- Keep this exact prompt, seed and settings for future performance comparisons.
- Runtime/visual tests are performed manually on the Ubuntu VM.
