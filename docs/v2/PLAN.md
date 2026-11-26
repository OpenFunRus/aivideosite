# AI Video Site — current V2 product / implementation plan

> Repository: `OpenFunRus/aivideosite`
>
> Branch: `main`
>
> Status: V2 is the primary and only supported frontend. `/` renders V2; `/v2` and `/v2/` are compatibility aliases. Legacy V1 frontend assets are removed.
>
> Runtime and visual verification is performed manually on the Ubuntu host.

## 1. Product principle

The site is task-first. The user describes the desired video; MiniMax H3 mode selection stays behind the interface.

Do not reintroduce a model-debug dashboard into the main generation screen. Low-level H3 capabilities may remain in backend code when needed by the current workflow, but the visible UI should expose only controls that are actually useful.

## 2. Primary navigation

Desktop/mobile navigation contains:

1. **Видео** — all new H3 generation, including optional master track.
2. **Библиотека** — finished videos and reusable extracted frames.
3. **Очередь** — latest jobs, cancel/retry/result and dual-GPU occupancy.
4. **Монтаж** — sequential FFmpeg timeline editor.
5. **Чат с ИИ** — local Gemma conversation and copy-ready prompt/code blocks.
6. **Система** — GPUs, Gemma, ComfyUI, RAM/CPU/disk and charts.
7. **Инструкция** — current site/H3 guide and external ChatGPT context copy.

The persistent Presets rail contains:
- Characters;
- Locations;
- Misc.

## 3. Video form contract

Visible generation settings are intentionally constrained:

- quality: 480 / 720 / 1080;
- ratio: 1:1 / 16:9 / 9:16;
- duration: 5 / 10 / 15 sec;
- steps: 1 / 2 / 4 / 8 / 12 / 16;
- FPS: fixed 24;
- seed: Auto (-1) or 0..4294967295;
- H3 generated sound on/off.

Inputs:
- prompt;
- optional First Frame;
- optional Last Frame;
- optional selected Character/Location/Misc presets;
- optional master track.

## 4. Automatic H3 routing

### No master track

- no semantic presets, no frames -> Frames/text-to-video path;
- First and/or Last only -> Frames/FL2VA endpoint conditioning;
- semantic presets only -> Ref2VA;
- semantic presets + First/Last -> Ref2VA semantic references + native exact Timeline Guides.

Character voice references are included unless that selected Character is muted.

### Master track enabled

- no visual input -> ordinary Frames/video generation; selected track is not H3 driving audio and may be muxed into the final MP4;
- First/Last or a semantic visual preset -> Digital Human; selected track fragment is the authoritative driving audio;
- First/Last in Digital Human mode are native exact `MiniMaxH3AddGuide` anchors;
- master track must not be regenerated as `non_diegetic_music`.

## 5. Magic Wand / local AI

Magic Wand is a prompt-rewrite tool, not an autonomous form operator.

It receives exact current generation settings and only metadata for presets currently checked in the right rail.

Canonical output for the Video prompt:
1. `integrated_multimodal_description`
2. `overall_soundscape`
3. `non_diegetic_music`

Rules:
- production instructions are English;
- exact dialogue/lyrics/on-screen text keep the requested language;
- explicit dialogue/lyrics use stable `(Sx)` + `<d>[Language] ...</d>`;
- no control/status footer is allowed in the prompt;
- cleanup/validation/repair is a safety net, not the primary prompting method;
- FORMAT LOCK few-shot examples live in the assistant preload.

## 6. Chat with AI

Chat is conversational and does not mutate generation controls.

- streaming Gemma response;
- Thinking toggle;
- 128k context meter;
- per-user localStorage history;
- persistent **Промт пользователя** shared with Magic Wand;
- copy-ready artifacts are fenced blocks rendered as separate cards with Copy;
- unchecked Character/Location/Misc presets are absent from LLM context.

## 7. Persistent browser state

Persist recoverable state per user:

- generation prompt/settings;
- selected saved master track + waveform start;
- track mux / scene-sound toggles;
- selected presets + muted voices;
- active preset tab;
- chat history/user prompt;
- editor project;
- library UI state;
- system auto-refresh settings.

Browser `File` objects cannot survive reload. First/Last and a locally selected unsaved audio file must be chosen again.

## 8. Queue / temporary media lifecycle

- generation runs after browser close because jobs live in SQLite;
- failed generation keeps required temporary inputs so Retry can work;
- Retry validates every required source, including `final_audio.path`;
- successful generation cleans temporary frames/references/guides/control/final-audio segment;
- job delete/prune cleanup also removes temporary final-audio segments;
- partial failed output MP4 must not remain orphaned in Library.

Retired V1 job kinds are purged on startup.

## 9. Library

Library supports:
- open/play;
- download;
- delete;
- copy saved prompt;
- extract start PNG;
- extract final PNG;
- search + persisted page/search state.

The media dialog is a shared empty shell populated by `workspaces/library.js`; do not delete it as “empty HTML”.

## 10. Editor

Current editor model:
- one sequential Video lane;
- optional one Music track;
- drag reorder;
- trim / split / delete;
- per-clip volume;
- fade in/out;
- snap / zoom / playhead / timecode;
- undo/redo;
- JSON project save/open;
- FFmpeg export to Library.

Do not claim arbitrary multi-layer compositing.

## 11. Frontend structure

`app/templates/v2.html` is the assembler.

Templates:
- `v2/layout/*`
- `v2/components/*`
- `v2/views/*`

JavaScript:
- `v2/js/core.js`
- `navigation.js`
- `characters.js`
- `locations.js`
- `misc.js`
- `status.js`
- `create.js`
- `instruction.js`
- `v2/js/workspaces/*`
- `bootstrap.js`

CSS:
- shell/create/characters/instruction/responsive;
- workspace-specific CSS under `v2/css/workspaces/`.

Do not merge the frontend back into a monolith.

## 12. Backend boundaries

Primary current endpoints:
- `POST /api/v2/generate`;
- `POST /api/v2/audio`;
- `GET /api/v2/state`;
- `GET /api/v2/status`;
- assistant endpoints;
- Character/Location/Misc CRUD;
- queue/job endpoints;
- Library/media endpoints;
- editor export endpoints.

The retired generic V1 `POST /api/generate`, V1 state API and V1 audio-replace/remove endpoints are intentionally removed.

## 13. Definition of done for future stages

Before calling a V2 stage complete:

1. inspect current `main`;
2. trace all relevant call sites;
3. fix the root cause rather than adding compatibility hacks;
4. keep per-user isolation;
5. preserve Retry/temporary-file lifecycle;
6. run only checks that are actually available;
7. do not add GitHub Actions/CI unless explicitly requested;
8. provide a concrete manual runtime/visual checklist to the user.
