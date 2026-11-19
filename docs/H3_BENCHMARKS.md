# MiniMax H3 GPU benchmarks

Этот файл хранит воспроизводимые локальные benchmark-тесты MiniMax H3 на текущей dual-GPU машине. Использовать те же prompt, seed и настройки при сравнении оптимизаций, драйверов, attention backend и GPU unlock.

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

- This is the baseline before any planned GPU unlock / tensor-core unlock experiments.
- Keep this exact prompt, seed and settings for before/after comparisons.
- Runtime/visual tests are performed manually on the Ubuntu VM.


## RTX 3090 GPU unlock — 2026-11-19

Same exact benchmark prompt, seed and settings as the baseline.

| GPU | State | Generation time | Change vs baseline |
| --- | --- | ---: | ---: |
| RTX 3090 24 GB | stock | 00:03:36 | baseline |
| RTX 3090 24 GB | gpu-unlock enabled | 00:03:04 | 32 sec faster |

Measured H3 improvement:

- wall-clock reduction: 32 seconds;
- time reduction: about 14.8%;
- throughput speedup: about 1.17x, or ~17.4% faster;
- kernel log confirmed `gpu_unlock: unlocked` for PCI `0000:01:00.0`;
- RTX 2080 Ti was not unlocked in this test.

This is the real application-level gain for the current H3 Fast / Turbo 8 workflow. Synthetic FP16/BF16 matrix benchmarks can show much larger gains, but they should not be treated as equivalent to end-to-end H3 generation speed.
