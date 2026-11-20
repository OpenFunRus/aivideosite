# AI Video Site V2 — product / UX / implementation plan

> Status: design approved; Stage 2 V2 shell implementation started.
>
> Repository: `OpenFunRus/aivideosite`
>
> Branch: `main`
>
> V1 remains intact at `/`. V2 is developed alongside it and will live under `/v2`.
>
> Core principle: V2 is task-first, not model-first. The user chooses what they want to do; MiniMax H3 complexity stays behind the interface.

---

## 1. Product goals

V2 must solve the main problem of V1: too many model-specific controls are visible at once and the user has to understand H3 internals before making a video.

Goals:

- keep the existing V1 working while V2 is built independently;
- make the common generation flow understandable without reading a guide;
- replace sliders with explicit button choices wherever the set of useful values is small;
- separate fundamentally different tasks into dedicated workspaces/tabs;
- keep uploaded/selected media visible as large visual cards instead of tiny file inputs;
- make reusable Characters available wherever they are relevant;
- keep the local AI assistant useful without letting it take over the whole interface;
- use one-click AI prompt improvement instead of automatic form control;
- keep queue, library, editor, system status and chat as separate first-class sections;
- support an arbitrary number of configured users;
- preserve the current dual-GPU generation backend and worker architecture unless a later stage proves a change is necessary.

---

## 2. V2 navigation / information architecture

Primary desktop navigation:

1. **Создать** — ordinary prompt / first frame / last frame generation.
2. **Продолжить** — continue an existing generated/uploaded video.
3. **По аудио** — generate a clip driven by a song/audio track.
4. **Продолжить клип** — continue an audio-driven/music-video sequence while preserving track continuity.
5. **Библиотека** — generated videos and their generation metadata.
6. **Очередь** — current/past jobs, user and GPU assignment.
7. **Монтаж** — modern timeline video editor.
8. **Чат** — standalone local AI chat.
9. **Система** — GPUs, VRAM, services, disk, queue/runtime information.
10. **Инструкция** — обучение по V2 и MiniMax H3, плюс одна кнопка copy-paste полного контекста для ChatGPT.

The first implementation may combine **По аудио** + **Продолжить клип** into one workspace with two obvious modes if that produces a cleaner design. This must be decided during mockup approval, not buried as a technical choice.

Mobile navigation should use a compact bottom bar for the most common sections plus a More drawer.

### Instruction workspace

The V2 Instruction page combines:

- simple human-readable training for every V2 section;
- practical MiniMax H3 prompting rules without exposing unnecessary backend complexity;
- explanation of the magic-wand workflow;
- a **Copy full instruction for ChatGPT** action.

The ChatGPT copy action must concatenate the V2 site operating guide with the current `app/static/h3-prompting-guide-ai.txt` at copy time. Do not maintain a second duplicate H3 guide.

---

## 3. Global design principles

### 3.1 Visual direction

Target:

- modern dark creative tool;
- quiet neutral background, high contrast content surfaces;
- one restrained accent color;
- large readable typography;
- generous spacing;
- soft card separation, not dozens of nested bordered boxes;
- media-first layouts;
- controls grouped by task, not by backend implementation;
- no dashboard clutter on the generation screen;
- icons only where they improve scanning;
- important controls visible without scrolling on a normal desktop screen where practical.

Avoid:

- many simultaneous panels;
- tiny labels;
- dense property inspectors;
- rainbow status colors;
- sliders for finite options;
- duplicated advanced settings;
- technical sampler/model cards;
- showing H3 schema terms unless the user actually needs them.

### 3.2 Interaction rules

- upload areas are large drag/drop cards with preview;
- selected images/videos remain visible;
- all finite settings use segmented buttons/chips;
- dangerous/destructive actions require confirmation;
- changing tabs does not lose a draft;
- each generation workspace owns its own draft state;
- all generation actions end at a single obvious primary button;
- queue state is globally visible in the shell but details live on the Queue page.

---

## 4. Shared generation controls

These are the only ordinary model controls visible in generation workspaces unless a particular workflow genuinely needs something else.

### Resolution

Buttons:

- **480p**
- **720p**
- **1080p**

### Aspect ratio

Buttons:

- **1:1** — square
- **16:9** — YouTube / landscape
- **9:16** — Shorts / vertical

No other ratios in V2.

The backend maps the chosen quality + ratio to the closest valid H3 dimensions. The UI displays only the simple labels above.

### Duration

Buttons:

- **5 sec**
- **10 sec**
- **15 sec**

No duration slider.

### Steps

Buttons:

- **8**
- **12**
- **16**

No other values in V2 UI.

### Seed

Numeric text field.

- empty UI value means automatic;
- request/backend resolves empty to `-1`;
- user may enter an explicit seed.

### Audio

Single checkbox/toggle:

- **Генерировать звук**

### Removed from ordinary V2 generation UI

- sampler selector;
- sampler information card;
- arbitrary FPS control;
- arbitrary step control;
- arbitrary duration slider;
- arbitrary resolution list;
- model-specific settings that do not materially help the everyday workflow.

FPS can remain an internal per-workflow default unless later testing establishes a real user need.

---

## 5. Universal prompt composer

Every generation workspace contains the same prompt composer concept.

Elements:

- large multiline prompt field;
- **magic wand** action;
- optional Character selector;
- clear visible state of attached references;
- Generate button.

### Magic wand behavior

The AI does **not** continuously control the form.

User writes an ordinary request in Russian or English and presses the magic wand.

The local AI then:

1. reads only the context relevant to the active workspace;
2. understands the currently attached/selected media and Characters;
3. rewrites the request into a production-ready MiniMax H3 prompt;
4. translates the H3 instructions to English when needed;
5. preserves exact spoken dialogue, lyrics and required visible text in their intended language;
6. returns the improved prompt into the prompt field;
7. does not silently change generation settings unless a future explicitly approved UX adds an optional suggestion.

The original user prompt should remain recoverable with Undo / Restore original.

No separate permanent “Управление” chat mode is required in V2.

---

## 6. Workspace: Создать

Purpose: create a new clip from text, optionally constrained by first/last frames and reusable Characters.

Layout:

- large prompt composer;
- Character selector;
- media row:
  - **Начальный кадр**;
  - **Конечный кадр**;
- each media card supports drag/drop, click-to-select, preview, replace and remove;
- empty state clearly explains that frames are optional;
- shared resolution / ratio / duration / steps / seed / audio controls;
- primary **Сгенерировать** button.

Behavior:

- prompt only -> T2V/FL2VA path as appropriate;
- first frame -> first-frame generation;
- first + last -> first/last generation;
- last-only support can be retained only if backend behavior is reliable and the design remains understandable;
- Characters are semantic reusable identity references.

No Ref2VA role/retention matrix in the ordinary interface.

---

## 7. Workspace: Продолжить

Purpose: continue an existing clip.

Source selection:

- pick a clip from Library;
- upload a video file;
- selected source video is shown in a real video preview card.

Automatic source inspection:

- aspect ratio;
- dimensions;
- duration;
- frame rate where useful.

V2 should automatically preserve the source format rather than asking the user to configure it again.

User controls:

- prompt;
- magic wand;
- Characters;
- target continuation duration: 5 / 10 / 15 sec;
- steps: 8 / 12 / 16;
- sound toggle;
- optional seed;
- **Продолжить видео**.

Resolution/aspect buttons should be hidden when continuation must inherit them from source. If the backend requires a derived target dimension, it is computed automatically.

Prompt improvement must explicitly instruct H3 to preserve momentum, camera direction, subject state and scene continuity from the source ending.

---

## 8. Workspace: По аудио

Purpose: music video / dancing / performance / lip-sync-like audio-driven generation using H3's supported audio-driven workflow.

Inputs:

- audio track upload or future selection from a media library;
- waveform or at minimum a proper audio player with duration;
- visual reference:
  - Character(s);
  - image(s);
  - source/start video where the supported workflow requires it.

Prompt:

- what the subject does to the track;
- dancing/performance/body motion;
- singing/mouth behavior when requested;
- camera and visual concept;
- magic wand produces the correct H3 audio-driven prompt.

Controls:

- output ratio: 1:1 / 16:9 / 9:16;
- quality: 480p / 720p / 1080p;
- segment duration: values supported by the actual H3 audio workflow, presented simply;
- steps: 8 / 12 / 16 where technically valid;
- seed if relevant;
- native audio/output behavior made obvious rather than technical.

The design must make audio the visual center of this workspace, not just another tiny upload field.

---

## 9. Workspace: Продолжить клип

Purpose: make the next segment of a music/audio-driven sequence without manually reconstructing previous context.

Inputs/context:

- previous generated video segment;
- original audio track;
- current position/time range in the track;
- Characters/references reused from the sequence.

The application should know which part of the soundtrack has already been used and prepare the next time range.

Goals:

- visual continuity from previous segment;
- music/time continuity;
- consistent Characters;
- prompt only describes the next action/shot.

This feature should be designed together with the future project/timeline data model, not implemented as isolated ad-hoc uploads.

---

## 10. Library

Purpose: browse results, inspect generation data, reuse media.

V2 Library is intentionally simpler than V1.

Cards/grid should provide:

- large video preview / poster;
- created date;
- duration;
- quality/ratio;
- generation type;
- user/owner where appropriate;
- actions:
  - play/open;
  - download;
  - view prompt/settings;
  - use as continuation source;
  - send to editor;
  - delete.

Do **not** include:

- replace audio;
- remove audio;
- miscellaneous processing actions that make the gallery feel like a tool drawer.

Detail view:

- full video;
- original prompt;
- generation settings;
- seed;
- source/reference relations where available;
- copy prompt;
- reuse/remix actions.

---

## 11. Queue

Queue must answer two questions immediately:

1. What is generating now?
2. Which user occupies which GPU?

Top live GPU strip:

- **RTX3090** — Free / User X / current job;
- **RTX2080** — Free / User Y / current job;
- LLM placement can be shown compactly if useful, especially when it has moved to CPU.

Job list:

- owner/user;
- generation type;
- thumbnail/source;
- queued/running/done/failed/canceled;
- queue wait;
- live generation time;
- GPU assignment;
- Cancel;
- Retry where valid;
- open result.

Avoid fake progress percentages unless the backend has reliable progress data.

---

## 12. Modern video editor

This is a separate substantial stage, not a few controls inside Library.

Initial target:

- preview monitor;
- timeline with playhead;
- multiple video tracks where practical;
- dedicated audio/music tracks;
- drag/drop clips from Library;
- trim start/end;
- split clip;
- move/reorder clips;
- delete;
- mute clip audio;
- clip volume;
- audio track volume;
- basic fade in/out;
- timeline zoom;
- snapping;
- playback position/timecode;
- export.

Later optional features:

- transitions;
- text/title overlays;
- simple crop/reframe;
- project save/versioning;
- proxy/previews if necessary for performance.

FFmpeg remains the export engine unless a better local approach is justified.

Editor implementation starts only after generator UX is approved and stable.

---

## 13. Standalone AI chat

V2 gets a dedicated **Чат** page instead of forcing the floating assistant to be the main interaction model.

Goals:

- normal local Qwen conversation;
- streaming replies;
- Thinking toggle can remain;
- per-user conversation state;
- clear/new chat;
- future multiple conversations can be added later.

### Context accounting

The application must explicitly account for the model context budget.

The exact tokenizer strategy should be chosen during implementation after checking what llama.cpp exposes for the installed Qwen model.

Required behavior:

1. system prompt budget is known;
2. history token usage is calculated/estimated with the correct tokenizer where available;
3. reserve output budget;
4. before each request, drop the oldest complete user+assistant turns until the request fits;
5. never cut the newest user request;
6. show a small context usage indicator such as `18k / 32k`;
7. history may remain stored in the UI/database even when old turns are no longer sent to the model.

Do not rely only on a fixed “20 messages” rule in V2.

---

## 14. Users

V2 must support an arbitrary configured number of users.

Replace the hard-coded three-profile concept with config-driven users.

Target config concept:

```text
users:
  - id
  - display_name
  - password/password_hash
  - optional enabled flag
```

Exact storage format will be chosen after reviewing the current authentication code during that implementation stage.

Requirements:

- no fixed user1/user2/user3 assumptions in V2;
- personal Library;
- personal queue/history visibility as currently intended;
- personal AI chat history;
- shared physical GPU resources;
- admin/config changes can add more users without frontend code changes.

Security must not be weakened while simplifying UX.

---

## 15. System page

One clean operational page.

Sections:

- GPU cards:
  - model;
  - VRAM used/total;
  - utilization;
  - temperature where available;
  - current H3 user/job;
- local LLM:
  - GPU/CPU target;
  - loaded/starting/offline;
  - context size;
- ComfyUI primary/secondary:
  - online/offline;
  - queue state;
- site worker;
- disk free/used;
- RAM;
- optional CPU load;
- versions where useful.

This page replaces scattered technical status information in generation UI.

---

## 16. Data/model changes likely required

Do not implement these until the matching stage is reached.

Likely additions:

- generic users configuration;
- V2 draft preferences per user/workspace;
- richer source/derived-media relationship metadata;
- editor projects/timelines;
- audio-track/project segment state for music-video continuation;
- persistent chat conversations/messages or a lightweight equivalent;
- token/context metadata;
- clearer job type labels;
- reliable GPU/user assignment surfaced by API.

Migrations must preserve V1 data.

---

## 17. Route and code isolation

Target route:

```text
/v2
```

Principles:

- V1 `/` remains functional;
- initially reuse stable backend/service primitives;
- V2 gets separate templates/static entry points so redesign work does not destabilize V1;
- shared backend logic should be extracted only when duplication is real and the extraction is safe;
- no rewrite of Comfy/H3 generation architecture merely for visual redesign;
- no second GPU worker system;
- no separate database unless there is a concrete technical need.

A likely structure will be decided after the design is approved and before implementation, based on the current FastAPI/Jinja layout.

---

## 18. Delivery stages

### Stage 0 — product plan
**Status: current.**

- freeze V2 scope;
- keep V1 untouched;
- document navigation, workflows and simplified controls.

Acceptance:
- this document approved as the working V2 direction.

### Stage 1 — design research and mockups
**Status: approved.**


- inspect current high-quality AI video/image creative tools for UX patterns;
- identify patterns worth borrowing, not copying;
- create a desktop generator mockup;
- iterate until visual style and navigation are approved;
- create responsive/mobile direction after desktop is approved;
- define reusable visual tokens/components.

Acceptance:
- approved generator mockup;
- approved navigation;
- approved component language;
- no implementation before the key generator screen is approved.

### Stage 2 — V2 shell
**Status: in progress.**


- add authenticated `/v2` route;
- separate V2 template/CSS/JS;
- navigation shell;
- responsive layout;
- placeholder pages for agreed sections;
- no disruption to V1.

Acceptance:
- both `/` and `/v2` work;
- user can navigate V2;
- visual shell matches approved mockup.

### Stage 3 — simplified Create workspace

- prompt composer;
- magic wand API/UI;
- first/last frame visual upload cards;
- Characters;
- 480/720/1080;
- 1:1 / 16:9 / 9:16;
- 5/10/15 sec;
- 8/12/16 steps;
- seed;
- sound;
- generate;
- mapping from simple UI to existing H3 backend.

Acceptance:
- common prompt/first/last generation works from V2 without exposing V1 complexity.

### Stage 4 — Library V2

- clean gallery;
- detail view;
- prompts/settings;
- reuse as source;
- delete/download;
- send to editor placeholder/action.

Acceptance:
- normal result browsing no longer requires V1.

### Stage 5 — Queue V2

- jobs;
- live timers;
- cancel/retry;
- explicit user + GPU occupancy;
- two-GPU status strip.

Acceptance:
- current hardware allocation is obvious at a glance.

### Stage 6 — Continue workspace

- Library picker/upload;
- video preview;
- automatic source metadata;
- continuation-specific prompt improvement;
- inherited format;
- generation.

Acceptance:
- continuing a clip requires no manual recreation of its resolution/aspect settings.

### Stage 7 — Audio-driven workspace

- modern audio uploader/player;
- Character/reference selection;
- H3 audio-driven generation;
- magic-wand prompt improvement;
- simple relevant settings only.

Acceptance:
- user can create the first music/performance clip without understanding Digital Human/Ref2VA internals.

### Stage 8 — Music-video continuation

- previous clip + master audio relationship;
- track position/next segment model;
- continuation workflow;
- visual/audio continuity.

Acceptance:
- next clip segment can be created without manually slicing/reconstructing all context.

### Stage 9 — Config-driven unlimited users

- replace fixed-three assumptions;
- migration/compatibility;
- per-user V2 drafts/library/queue/chat;
- shared GPU scheduling remains intact.

Acceptance:
- adding another configured user does not require source-code UI changes.

### Stage 10 — Standalone Chat V2

- dedicated page;
- streaming;
- Thinking;
- context/token accounting;
- automatic oldest-turn eviction;
- context meter;
- per-user chat persistence as selected.

Acceptance:
- 32k context is managed intentionally, not by a fixed message-count approximation.

### Stage 11 — System page

- GPU/VRAM/utilization;
- current user/job;
- LLM target;
- services;
- RAM/disk/CPU.

Acceptance:
- operational status can be understood without shell access for common checks.

### Stage 12 — Video editor

- project model;
- preview;
- timeline;
- tracks;
- trim/split/move;
- clip audio controls;
- music track;
- fades;
- export via FFmpeg;
- Library integration.

Acceptance:
- a simple multi-clip music video can be assembled and exported entirely in V2.

### Stage 13 — polish / migration decision

- responsive pass;
- keyboard/accessibility basics;
- empty/error/loading states;
- performance cleanup;
- documentation;
- decide whether V2 becomes default `/` later.

V1 is not removed automatically.

---

## 19. Non-goals for early V2

Do not add during the first generator implementation:

- every H3 expert mode in one screen;
- arbitrary aspect ratios;
- arbitrary FPS;
- arbitrary duration;
- arbitrary step count;
- sampler UI;
- hidden “advanced” drawer full of V1 controls;
- AI auto-changing the whole form while the user types;
- editor features inside the Library;
- a rewrite of working dual-GPU infrastructure;
- removal of V1.

If a genuinely necessary capability appears later, add it to the workflow where it belongs instead of rebuilding a universal settings wall.

---

## 20. Design approval workflow

Before implementation of V2 UI:

1. research strong current creative/video-generation interfaces;
2. collect concrete UX patterns;
3. generate/draw the first desktop V2 mockup;
4. user reviews it;
5. revise until approved;
6. only then implement Stage 2 and Stage 3.

The mockup should focus first on the **Создать** workspace because it defines the shared visual language for the rest of V2.
