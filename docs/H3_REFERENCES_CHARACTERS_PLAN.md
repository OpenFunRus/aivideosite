# MiniMax H3 full controls expansion plan

Date: 2026-11-19  
Repository: `OpenFunRus/aivideosite`  
Branch: `main`

## Goal

Expand the existing MiniMax H3 site without breaking the proven FL2VA path.

The finished architecture has four generation modes plus an optional structural-control layer:

1. **Frames / FL2VA**
   - T2V;
   - exact First frame;
   - exact Last frame;
   - exact First + Last interpolation.

2. **References / Ref2VA**
   - reusable Characters;
   - up to 9 Pictures;
   - up to 3 reference Videos;
   - up to 3 standalone Audio refs;
   - up to 15 semantic reference media total;
   - roles + retention;
   - reference generation / semantic storyboard completion / video editing / video continuation / audio reuse / audio reference.

3. **Timeline / native multiframe guides**
   - 1–16 guide images;
   - each guide has an exact time;
   - site converts time to `frame_idx = round(time_seconds * FPS)`;
   - native `MiniMaxH3AddGuide` conditioning;
   - semantic Ref2VA references can be combined with exact timeline guides.

4. **Digital Human**
   - visual reference(s);
   - exactly one standalone driving Audio.

Optional layer on top of the H3 generation:
- **H3 Fun ControlNet Union**
  - Canny Auto from raw video;
  - prepared Canny;
  - prepared Pose;
  - prepared Depth;
  - prepared HED;
  - prepared MLSD;
  - video inpainting with source + mask.

The implementation must remain compatible with the existing dual-GPU dispatcher, SQLite queue/history, per-user isolation, library and FFmpeg editor.

## Important distinction

There are three different concepts which must not be mixed:

- FL2VA First/Last: exact endpoint anchors.
- Ordinary Ref2VA Picture with role `storyboard`: semantic visual reference only.
- Timeline mode: exact arbitrary-time native guide via `MiniMaxH3AddGuide`.

The human guide and AI guide must preserve this distinction.

## Stage 1 — model/config support

Status: **implemented; runtime verification pending**.

- `H3_FL2VA_MODEL` remains isolated to FL2VA jobs.
- `H3_REF2VA_MODEL=minimax_h3_ref2va_pruned_int8_convrot.safetensors`.
- `H3_TURBO_LORA` remains FL2VA-only.
- `H3_REF_TURBO_LORA=minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`.
- `H3_CONTROLNET_MODEL_PATCH=minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors`.
- `COMFYUI_INPUT_DIR=/opt/ai/ComfyUI/input` is used only when a job actually needs staged media.
- Ref2VA model names are never passed to FL2VA workflows, so missing new model files do not make old FL2VA jobs invalid.

Step rules:
- New UI/API: 6–24 steps in increments of 2.
- FL2VA: exactly 8 steps use the installed FL Turbo LoRA; other new values use Base.
- Ref2VA / Timeline / Digital Human: new 6–24 values use Base because the installed Ref Turbo LoRA targets 4 steps.
- Legacy queued payloads keep their old profile routing for retry compatibility.

## Stage 2 — Ref2VA API

Status: **implemented; runtime verification pending**.

Fields:
- `generation_mode`;
- `reference_task`;
- `ref_image_size`;
- Character IDs;
- direct reference images/videos/audio;
- reference role/retention manifest.

Validation:
- max 9 Pictures;
- max 3 Videos;
- max 3 standalone Audio;
- max 15 semantic reference resources;
- Ref2VA needs at least one visual reference;
- Digital Human needs at least one visual reference and exactly one standalone driving Audio;
- Character files count toward the same limits;
- owner isolation enforced server-side.

## Stage 3 — reusable Characters

Status: **implemented; runtime verification pending**.

Per-user SQLite `characters` table.

Persistent files:
```text
data/characters/<owner_id>/<character_id>/
```

Each Character supports:
- name;
- immutable visual description;
- 1–4 appearance images;
- optional saved voice.

Safety:
- every list/get/update/delete/preview operation checks owner;
- active queued/running jobs protect their selected Character from deletion.

## Stage 4 — deterministic reference mapping

Status: **implemented**.

The server orders semantic media as:
1. Pictures;
2. Videos;
3. standalone Audio.

Character appearance images are inserted before direct Pictures.

Reference-video soundtrack receives an Audio ordinal when H3 processes that Video.

The server builds:
- `<Picture N>`;
- `<Video N>`;
- `<Audio N>`;
- logical `<Subject N>`.

Simple prompts are wrapped into:
- `subject_definitions`;
- `summary`;
- `retention_analysis`;
- `detailed_description`;
- `overall_soundscape`;
- `non_diegetic_music`.

Already-structured six-field prompts are preserved.

## Stage 5 — roles and retention

Status: **implemented**.

Visual roles:
- character;
- object;
- setting;
- style;
- composition;
- storyboard;
- motion;
- camera_motion.

Audio roles:
- voice;
- audio.

Visual retention:
- `fully_preserved`;
- `partially_preserved`;
- `attribute_transfer`;
- `weak_reference`.

Audio retention:
- `fully_copy`;
- `partially_copy`;
- `reference`;
- `weak_reference`.

## Stage 6 — exact Timeline Guides

Status: **implemented in code; runtime verification pending**.

Dedicated `multiframe` mode:
- 1–16 guide images;
- each guide gets a time in seconds;
- exact frame index calculated from selected output FPS;
- native `MiniMaxH3AddGuide` nodes chained into positive conditioning;
- sampler switches to the native H3 multiframe recipe using `RandomNoise`, `BasicGuider`, `SamplerCustomAdvanced` and `res_multistep`;
- semantic Ref2VA media can be used together with exact guides.

Compatibility target:
- ComfyUI 0.34+ for native H3 Add Guide.

## Stage 7 — H3 Fun ControlNet Union

Status: **implemented in code; runtime verification pending**.

Native nodes:
- `ModelPatchLoader`;
- `MiniMaxH3FunControlNetApply`.

Modes:
- `canny_auto`: site converts raw video through built-in ComfyUI `Canny`;
- `canny`: prepared control video;
- `pose`: prepared Pose control video;
- `depth`: prepared Depth control video;
- `hed`: prepared HED/soft-edge control video;
- `mlsd`: prepared MLSD/line control video;
- `inpaint`: source video + mask video, optional extra control video.

Inpaint:
- source and mask required;
- red channel of the mask video is converted with `ImageToMask`;
- white area means regenerate.

Important boundary:
- this site automatically preprocesses only Canny;
- Pose/Depth/HED/MLSD require an already-preprocessed control video;
- no fake RGB-to-Pose/Depth conversion is claimed.

Control parameters:
- strength;
- start_percent;
- end_percent;
- Canny low/high thresholds.

Native H3 guide/control workflows use `res_multistep`; legacy FL2VA/Ref2VA Easy jobs keep their existing `euler` sampler.

Compatibility target:
- ComfyUI 0.35+ for Fun ControlNet Union v1;
- Union 2.0 is intentionally not made the default until the runtime is upgraded/verified for the newer path.

## Stage 8 — generator UI and aspect ratios

Status: **implemented; visual test pending**.

Generation modes:
- Кадры;
- Референсы;
- Таймлайн;
- Digital Human.

ControlNet can be enabled independently.

Aspect ratios:
- 1:1;
- 2:3;
- 3:2;
- 3:4;
- 4:3;
- 9:16;
- 16:9;
- 21:9.

Resolution classes:
- 360p;
- 480p;
- 720p;
- 1080p;
- 256×256 extra test for 1:1.

All dimensions are rounded upward to the H3 ×32 grid. Backend accepts sides up to 3072 so 21:9 1080-class is not rejected.

## Stage 9 — metadata / retry / cleanup

Status: **implemented**.

Media metadata stores:
- actual prompt;
- user prompt;
- generation mode;
- reference task;
- ref image size;
- reference map;
- sanitized timeline-guide metadata;
- sanitized ControlNet settings;
- GPU backend.

Retry validates:
- frame uploads;
- semantic references;
- timeline guides;
- ControlNet source/control/mask media.

Success cleanup removes:
- temporary direct references;
- timeline-guide uploads;
- ControlNet uploads;
- staged ComfyUI input copies.

Persistent Character files remain.

## Stage 10 — guides

Status: **implemented**.

Human full-screen guide covers:
- FL2VA;
- Ref2VA;
- Characters;
- roles/retention;
- exact Timeline Guides;
- ControlNet Union;
- video editing/continuation;
- Digital Human;
- shots/camera;
- dialogue/audio;
- concrete exclusions;
- examples.

Machine-readable guide:
```text
/static/h3-prompting-guide-ai.txt
```

It teaches an AI assistant the same mode distinctions and explicitly differentiates semantic storyboard references from exact native timeline guides.

## Stage 11 — documentation/deployment

Status: **in repository; runtime deployment pending**.

Update and keep synchronized:
- `.env.example`;
- `README.md`;
- `docs/HANDOFF_AI_VIDEO_SITE.md`;
- this plan.

Do not auto-download multi-GB H3 model files from application code.

## Stage 12 — checks

Checks available in the assistant environment:
- inspect actual current GitHub source;
- JavaScript syntax parse;
- HTML ID/copy-target/nav/view integrity checks;
- static API/owner-isolation/workflow inspection.

Unavailable here:
- Python `compileall` from a local checkout because this tool environment cannot materialize/clone the repo through its external network path;
- ComfyUI object-info/runtime execution on the user's Ubuntu VM;
- GPU/VRAM/visual quality tests.

## Required user runtime test matrix

After installing the new model files and updating ComfyUI:

1. FL2VA regression:
   - T2V;
   - First;
   - Last-only;
   - First+Last.

2. Ref2VA:
   - Character Picture identity;
   - multiple Pictures;
   - reference Video;
   - Video with soundtrack;
   - standalone Audio;
   - video editing;
   - video continuation;
   - Ref Turbo 4-step;
   - Base 8/12/16/20.

3. Characters:
   - create/edit/delete;
   - preview;
   - voice;
   - isolation between all 3 site users;
   - deletion protection while a job is active.

4. Timeline:
   - two guides at 0s/end;
   - 3+ guides including a midpoint;
   - semantic Character + exact guide combination;
   - verify the visible image lands on the requested internal time.

5. Digital Human:
   - one Character/reference + exactly one driving Audio;
   - reject two standalone Audio sources.

6. ControlNet:
   - Canny Auto from raw video;
   - prepared Canny;
   - prepared Pose;
   - prepared Depth;
   - prepared HED;
   - prepared MLSD;
   - inpaint source + mask;
   - ControlNet together with Ref2VA;
   - ControlNet together with Timeline Guides.

7. Dispatcher:
   - first job on RTX3090;
   - second concurrent job on RTX2080;
   - Cancel on each backend;
   - correct GPU metadata.

8. Stress:
   - 1080p;
   - 21:9 1080-class;
   - long reference video;
   - long 30-second H3 generation;
   - VRAM and performance on both GPUs.
