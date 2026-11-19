# H3 References / Characters expansion plan

Date: 2026-11-19  
Repository: `OpenFunRus/aivideosite`  
Branch: `main`

## Goal

Expand the current MiniMax H3 FL2VA-only site into a safe dual-path workflow:

- keep the existing FL2VA path intact for T2V / first frame / last frame / first+last frame;
- add Ref2VA for multimodal references;
- add per-user reusable Characters with appearance references and optional voice;
- expose reference roles, retention strength, reference task type, and local H3 reference sizing;
- update the human guide and the machine-readable AI guide so prompts match the real local workflow.

The implementation must remain compatible with the existing two-GPU dispatcher, queue, SQLite history, per-user isolation, library and editor.

## Verified local capabilities

The installed `ComfyUI-MiniMaxH3-Easy` API supports:

- `mode=image`: zero images = T2V, one image = first or last frame, two images = first+last;
- `mode=reference`: up to 9 images, 3 videos and 3 standalone audio clips, 15 media resources total;
- reference video soundtrack is paired automatically;
- `mode=digital_human`: visual references plus exactly one driving audio track;
- image reference sizing: `match`, `1k`, `1.5k`, `2k`, `original`;
- local aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9;
- direct API/headless media inputs through hidden `media_N` + `media_type_N` inputs.

## Important boundary

FL2VA first/last frames are exact keyframe anchors.

Ref2VA images can be assigned prompt roles such as character, object, setting, style, storyboard/keyframe, composition or motion reference, but they are not exact latent keyframes at arbitrary timestamps. The UI and guides must not claim otherwise.

## Stage 1 — backend model/config support

1. Add `H3_REF2VA_MODEL` with a real default filename:
   `minimax_h3_ref2va_pruned_int8_convrot.safetensors`.
2. Add optional `H3_REF_TURBO_LORA`; default `none`.
3. Add `COMFYUI_INPUT_DIR` for staging image/video/audio inputs on the same VM.
4. Keep FL2VA Turbo LoRA separate from Ref2VA acceleration so an FL-only LoRA is never applied to Ref2VA by mistake.
5. Generalize the Comfy workflow builder:
   - image mode: `LoadImage`;
   - reference mode: `LoadImage`, `LoadVideo`, `LoadAudio`;
   - digital human mode: same multimodal transport;
   - pass the matching `media_type_N`.
6. Preserve the old payload shape for queued legacy jobs.

## Stage 2 — reference generation API

Add generator fields:

- `generation_mode`: frames / reference / digital_human;
- `keyframe_role`: first / last for one-frame FL2VA;
- `reference_task`: reference generation, keyframe/storyboard completion, video editing, video continuation, audio reuse, audio reference;
- `ref_image_size`;
- repeated reference images/videos/audio;
- selected Character IDs;
- JSON reference manifest containing role + retention information.

Validation:

- FL2VA accepts max 2 images and no video/audio refs;
- Ref2VA accepts max 9 images, 3 videos, 3 standalone audio and 15 total;
- Digital Human accepts visual refs and exactly one driving audio;
- selected Character assets count toward the same limits;
- no cross-user Character access;
- upload size and extension validation remains enforced.

## Stage 3 — reusable Characters

Add a per-user SQLite `characters` table and private runtime assets under `data/characters/`.

Character fields:

- id;
- owner_id;
- name;
- description / immutable visual notes;
- one or more reference images;
- optional voice reference;
- created/updated timestamps.

UI:

- dedicated `Персонажи` view;
- create Character;
- show image/voice counts;
- delete Character;
- select Characters from the generation view.

When selected for Ref2VA, Character appearance references are inserted before direct image references in deterministic order. Character voices are inserted as standalone audio references after video soundtracks.

## Stage 4 — prompt/reference mapping

For Ref2VA, the site builds a deterministic mapping:

- images -> `<Picture N>`;
- reference videos -> `<Video N>`;
- reference-video soundtrack -> corresponding `<Audio N>`;
- Character/direct standalone audio -> subsequent `<Audio N>`;
- reusable logical subjects -> `<Subject N>`.

If the user already supplies the six-field Ref2VA format, preserve it.

If the user enters a simple prompt, wrap it into:

- `subject_definitions`;
- `summary`;
- `retention_analysis`;
- `detailed_description`;
- `overall_soundscape`;
- `non_diegetic_music`.

Do not overwrite an explicitly structured prompt.

Retention choices:

- visual: `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`;
- audio: `fully_copy`, `partially_copy`, `reference`, `weak_reference`.

Reference roles:

- character;
- object;
- setting;
- style;
- composition;
- storyboard/keyframe;
- motion;
- camera motion;
- voice/audio.

## Stage 5 — generation UI

Add a mode switch:

1. **Кадры / FL2VA**
   - no frame = T2V;
   - first frame;
   - last frame;
   - first+last.

2. **Референсы / Ref2VA**
   - multi-image;
   - multi-video;
   - multi-audio;
   - Character selection;
   - task type;
   - role + retention editor;
   - ref image size.

3. **Digital Human**
   - visual references;
   - exactly one driving audio.

Add reference counters and clear validation messages before submit.

## Stage 6 — aspect ratios

Expand the resolution selector to the ratios supported by the local Easy node:

- 1:1;
- 2:3;
- 3:2;
- 3:4;
- 4:3;
- 9:16;
- 16:9;
- 21:9.

Keep dimensions on the H3-valid ×32 grid and never make a selected resolution class smaller than its advertised class.

## Stage 7 — metadata / retry / cleanup

Generation media metadata must store:

- generation mode;
- reference task;
- reference mapping;
- Character IDs/names;
- image/video/audio counts;
- keyframe role;
- ref image size;
- GPU backend;
- actual prompt sent to H3.

Retry must validate all temporary reference files and persistent Character files.

Only temporary uploads are deleted after a successful generation. Character assets remain.

## Stage 8 — guides

Rewrite both guides.

### Human full-screen guide

Cover:

- FL2VA vs Ref2VA vs Digital Human;
- first / last / first+last;
- six-field Ref2VA prompt format;
- `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>`;
- Characters and saved voices;
- deterministic numbering in this site;
- roles and retention;
- reference generation;
- video editing;
- video continuation;
- audio reuse / audio reference;
- storyboard/keyframe references and the exact-keyframe limitation;
- dialogue and native H3 audio;
- examples.

### Machine-readable AI guide

Teach an AI assistant to:

- infer the selected local mode;
- never use Ref2VA syntax in FL2VA;
- never claim arbitrary exact keyframes in Ref2VA;
- generate the three-field FL2VA format;
- generate the six-field Ref2VA format;
- use the visible reference map from the site;
- preserve exact user dialogue;
- respect selected retention and roles;
- produce editing/continuation prompts when a reference video is present;
- account for native-audio checkbox behavior.

## Stage 9 — documentation / deployment

Update:

- `.env.example`;
- `README.md`;
- `docs/HANDOFF_AI_VIDEO_SITE.md`.

Document the required Ref2VA checkpoint and optional Ref2VA acceleration model. Do not auto-download multi-GB models from the web.

## Stage 10 — checks

Checks that can be performed without the user's Ubuntu runtime:

- Python syntax/compile checks;
- static inspection of API payload limits and owner isolation;
- JavaScript syntax check if a JS runtime is available;
- ensure old FL2VA payloads still build;
- inspect final Git diff/commit.

User runtime checks:

- download/configure Ref2VA model;
- restart both ComfyUI services and site;
- FL2VA regression: T2V, first, last, first+last;
- Ref2VA: image, video, video soundtrack, standalone audio;
- Characters: isolation between all 3 users;
- Digital Human;
- dual-GPU dispatch;
- 1080p / long reference VRAM behavior;
- visual quality and identity/voice retention.
