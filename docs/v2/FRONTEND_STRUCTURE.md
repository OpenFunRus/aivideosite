# Frontend structure

The V2 architecture is the primary supported frontend and is served at `/` (`/v2` remains a compatibility alias). It intentionally uses small focused files. Do not merge it back into one HTML/JS/CSS monolith.

## Templates

`app/templates/v2.html` is the page assembler.

### Layout
- `layout/mobile_bar.html` — mobile top bar/backdrop.
- `layout/sidebar.html` — navigation.
- `layout/topbar.html` — single page title + GPU pills.

### Shared components
- `components/character_rail.html`
- `components/toast.html`
- `components/media_dialog.html`

### Current views
- `views/create.html` — the single **Видео** generator, including optional driving-audio block.
- `views/library.html`
- `views/queue.html`
- `views/editor.html`
- `views/chat.html`
- `views/system.html`
- `views/instruction.html`

There is no separate V2 `views/audio.html`.

## JavaScript

### Shell
- `js/core.js` — global state/storage/fetch/toast.
- `js/navigation.js` — navigation/title/mobile drawers.
- `js/characters.js`, `locations.js`, `misc.js` — Presets rail.
- `js/status.js` — topbar GPU pills.
- `js/create.js` — unified Video prompt, First/Last, Magic Wand and conditional submit.
- `js/instruction.js` — guide copy.
- `js/bootstrap.js` — startup/polling/draft restore.

### Workspaces
- `js/workspaces/core.js` — shared media/state refresh and helpers.
- `js/workspaces/audio.js` — integrated Video audio-track controller: saved/uploaded track, waveform, fragment start, preview, mux/scene-audio toggles. It does **not** own a separate form or route/page.
- `js/workspaces/library.js`
- `js/workspaces/queue.js`
- `js/workspaces/chat.js`
- `js/workspaces/system.js`
- `js/workspaces/editor.js`

The retired `js/workspaces/generators.js` is not part of current V2.

## CSS

### Shell/common
- `css/base.css`
- `css/shell.css`
- `css/create.css`
- `css/characters.css`
- `css/instruction.css`
- `css/responsive.css`

### Workspaces
- `css/workspaces/common.css`
- `css/workspaces/audio.css` — waveform + integrated driving-audio block.
- `css/workspaces/generator-design.css` — shared generator visual rules.
- `css/workspaces/library.css`
- `css/workspaces/queue.css`
- `css/workspaces/chat.css`
- `css/workspaces/system.css`
- `css/workspaces/editor.css`
- `css/workspaces/responsive.css`

## Unified Video rule

The page stays the same whether a master track is enabled or not.

- normal mode -> `POST /api/v2/generate`;
- driving-audio mode -> internal `POST /api/v2/audio`;
- First/Last fields are the same DOM inputs in both modes;
- audio mode converts those endpoint images into native exact `MiniMaxH3AddGuide` anchors;
- no arbitrary visual-reference upload exists in audio mode.

## Editing rule

When changing Video, first inspect:
1. `views/create.html`;
2. `js/create.js`;
3. `js/workspaces/audio.js`;
4. `css/create.css` / `css/workspaces/audio.css`;
5. `app/main.py` and `app/comfy.py` when conditioning changes.

### Монтаж V2
- Layout: Library → Viewer → Inspector; Toolbar + Timeline below.
- Project model: sequential `clips[]` plus one optional Music file.
- `editor.js` owns preview/transport, reorder, trim/split/delete, history, snap/zoom, JSON open/save and `/api/editor/export`.
