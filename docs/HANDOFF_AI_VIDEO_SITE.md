# AI Video Site — current handoff

Актуальный проект:

```text
Repository: OpenFunRus/aivideosite
Branch: main
Primary UI: /
Compatibility aliases: /v2, /v2/
```

Legacy V1 frontend удалён. Не восстанавливать `index.html`, `app.js`, `app.css`, `assistant.js` или старый generic `/api/generate` без прямого запроса пользователя.

## 1. Правила работы

Перед любыми изменениями:
1. прочитать актуальный `main`;
2. изучить реальные связанные файлы и call sites;
3. не придумывать архитектуру;
4. исправлять root cause;
5. работать в `main`;
6. не создавать GitHub Actions / CI;
7. утверждать только реально выполненные проверки;
8. runtime/GPU/visual тест выполняет пользователь.

После законченного этапа сообщать:
- changed files;
- что сделано;
- реально выполненные checks;
- что не проверено;
- manual checklist;
- known limitations;
- полный SHA.

## 2. Runtime

Основной host ожидается:

```text
/opt/ai/aivideosite
```

Services:
- `aivideosite.service`;
- `llm-assistant.service`;
- `comfyui.service` — primary H3, RTX3090;
- `comfyui-secondary.service` — secondary H3, RTX2080.

ComfyUI URLs:
- primary: `127.0.0.1:8188`;
- secondary: `127.0.0.1:8189`.

LLM:
- llama.cpp: `127.0.0.1:8090`;
- placement manager: `127.0.0.1:8091`;
- Gemma4 26B A4B Heretic Q4_K_M;
- 128k context.

## 3. Primary frontend

Assembler:

```text
app/templates/v2.html
```

Layout/components/views:

```text
app/templates/v2/layout/
app/templates/v2/components/
app/templates/v2/views/
```

JS:

```text
app/static/v2/js/core.js
app/static/v2/js/navigation.js
app/static/v2/js/characters.js
app/static/v2/js/locations.js
app/static/v2/js/misc.js
app/static/v2/js/status.js
app/static/v2/js/create.js
app/static/v2/js/instruction.js
app/static/v2/js/workspaces/
app/static/v2/js/bootstrap.js
```

CSS:

```text
app/static/v2/css/
app/static/v2/css/workspaces/
```

Login uses the small standalone `app/static/login.css`.

Do not merge V2 back into a giant JS/CSS monolith.

## 4. Main workspaces

### Видео

One generator page for all current H3 generation.

Visible controls:
- prompt;
- First Frame;
- Last Frame;
- Character / Location / Misc presets;
- quality 480/720/1080;
- ratio 1:1/16:9/9:16;
- 5/10/15 sec;
- 8/12/16 steps;
- 24 FPS fixed;
- Seed;
- H3 Audio;
- optional master track.

Routing without master track:
- no refs -> Frames;
- First/Last only -> FL2VA endpoints;
- semantic presets -> Ref2VA;
- presets + First/Last -> Ref2VA + native Timeline Guides.

Routing with master track:
- no visual input -> ordinary Frames/video + optional final track mux;
- any First/Last or semantic visual preset -> Digital Human driving audio;
- First/Last are exact native Timeline Guides in Digital Human mode.

### Библиотека

- Open;
- Download;
- Start Frame PNG;
- Final Frame PNG;
- Copy prompt;
- Delete;
- search/pagination UI state persisted in localStorage.

### Очередь

- latest personal jobs;
- Cancel;
- Retry when valid;
- Result;
- two GPU lanes.

Retry must verify every required temporary source before cloning a failed job.

### Монтаж

Sequential editor:
- one Video lane;
- optional one Music track;
- reorder / trim / split / delete;
- clip volume;
- fades;
- snap / zoom / playhead;
- undo/redo;
- JSON project;
- FFmpeg export.

### Чат с ИИ

- streaming Gemma;
- Thinking;
- 128k context meter;
- user prompt modal;
- copyable fenced artifact blocks;
- selected-only Preset visibility.

### Система

- both GPUs;
- Gemma;
- both ComfyUI;
- RAM/CPU/disk;
- queue counts;
- history charts.

## 5. Presets

Right rail tabs:
- Characters;
- Locations;
- Misc.

Characters:
- 1–4 images;
- description;
- optional custom or built-in voice;
- selected voice can be muted per generation.

Locations:
- 1–4 environment images;
- prompt/description.

Misc categories:
- prop;
- clothing_gear;
- weapon;
- vehicle;
- creature;
- environment_feature;
- visual_trait;
- pose_action;
- style_look;
- other.

Assistant visibility rule:
- only checked presets are loaded into LLM context;
- unchecked presets are completely invisible to Gemma;
- selected preset pixels go to H3, not to Gemma.

## 6. Magic Wand / assistant preload

Assistant backend:

```text
app/assistant.py
app/llm_assistant_manager.py
```

Local preload:

```text
app/static/assistant_context/01_minimax_h3_master_guide_en.txt
app/static/assistant_context/02_minimax_h3_practical_playbook_en.txt
app/static/assistant_context/03_aivideosite_v2_operator_map_en.txt
```

Public external guides:
- `app/static/h3-prompting-guide-ai.txt`;
- `app/static/v2-chatgpt-site-guide.txt`.

Magic Wand canonical prompt:
1. integrated_multimodal_description
2. overall_soundscape
3. non_diegetic_music

Explicit dialogue/lyrics:
- stable `(S1)/(S2)`;
- exact `<d>[Language] ...</d>`;
- no duplicate literal outside the tag.

Wand pipeline:
- draft;
- cleanup;
- deterministic validation;
- repair;
- one-speaker deterministic normalization for common quote formatting.

## 7. Persistent browser state

Per-user localStorage includes:
- Video settings;
- selected presets/muted voices;
- saved master track + waveform start;
- track output toggles;
- active preset tab;
- chat history;
- «Промт пользователя»;
- editor project;
- library UI;
- system auto-refresh.

Local browser `File` objects cannot be restored after reload.

## 8. Backend generation

Current public generation endpoints:

```text
POST /api/v2/generate
POST /api/v2/audio
```

Do not reintroduce the retired generic V1 generator endpoint.

Useful helpers in `app/main.py`:
- `_v2_resolution`;
- `_v2_seed`;
- selected ID parsers;
- Character/Location/Misc reference builders;
- `_v2_enqueue_reference_job`;
- master-track storage/segment helpers.

`app/h3_references.py`:
- validates H3 reference budgets;
- builds real Ref2VA reference mapping;
- promotes canonical prompt to backend schema.

`app/comfy.py`:
- builds real ComfyUI workflows.

`app/worker.py`:
- dual GPU dispatch;
- H3 generation;
- final master-track mux/mix;
- temporary media cleanup;
- editor export.

## 9. Temporary file / Retry contract

Important invariants:
- persistent Character/Location/Misc files are never worker temporary files;
- direct First/Last/guide/master-track segment files are temporary;
- failed jobs keep sources required for Retry;
- Retry validates those sources before clone;
- success removes temporary inputs;
- job delete/prune removes remaining temporary uploads;
- temporary `final_audio.path` participates in both Retry validation and cleanup;
- partial failed generated MP4 must be deleted from Library directory.

## 10. Database

SQLite stores:
- jobs;
- generated media;
- Characters;
- Locations;
- Misc presets.

Startup:
- interrupted running jobs are recovered;
- retired V1 job kinds are purged;
- old still-image table/storage migration remains only as cleanup compatibility.

## 11. Current removed legacy pieces

Intentionally removed:
- V1 dashboard/template;
- V1 app JS/CSS;
- V1 assistant panel JS;
- old `/api/state`;
- old generic `/api/generate`;
- V1 audio replace/remove endpoints and worker jobs;
- retired direct reference-manifest parser;
- retired jobs pagination helper;
- stale recent-character browser state.

Do not recreate these as “compatibility” unless the product requirement changes.

## 12. Manual smoke test after deployment

After `git pull` + service restart + Ctrl+F5:

1. `/` opens the main UI; `/v2` still opens the same UI.
2. Login/logout.
3. Text-only Video generation.
4. First-only, Last-only, First+Last.
5. Character/Location/Misc reference generation.
6. preset + First/Last.
7. master track without visual input.
8. master track + First/Last singing/lip-sync.
9. Cancel + failed Retry.
10. Library open/download/frame extraction/delete.
11. Editor export.
12. Chat streaming/Thinking/user prompt/copy blocks.
13. selected-only preset visibility in a new chat.
14. System metrics for both GPUs/Gemma/ComfyUI.
15. reload persistence of all recoverable settings.
