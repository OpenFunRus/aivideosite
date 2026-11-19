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

## Experiment — disable Comfy compiler

A/B test on RTX 3090 with the exact saved benchmark:

- baseline: `00:03:36`;
- with `--disable-comfy-compiler`: `00:03:33`;
- difference: 3 seconds (~1.4%), treated as measurement noise / no practical gain.

Result: reverted. Do not keep this flag solely for H3 performance on the current stack.

## Experiment — DynamicVRAM headroom 2 GB

Both H3 ComfyUI services are launched with:

```text
--vram-headroom 2
```

Purpose: keep 2 GB of additional VRAM free so DynamicVRAM does not run the H3 sampler/VAE at the memory-pressure edge. This does not change model weights, prompt, sampler, seed, steps, resolution or attention math.

Benchmark rule: do not repeat an identical workflow+seed in the same ComfyUI process, because ComfyUI execution cache can return cached node outputs in a few seconds. For A/B runs either restart ComfyUI between identical-seed tests or use a fresh seed and record it.
