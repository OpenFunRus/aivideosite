# V2 frontend structure

V2 intentionally uses many small files. Do not merge it back into a single HTML/JS/CSS monolith.

## Templates

`app/templates/v2.html` is only the page assembler.

### Layout

- `app/templates/v2/layout/mobile_bar.html` — mobile top bar and backdrop.
- `app/templates/v2/layout/sidebar.html` — desktop/mobile navigation drawer.
- `app/templates/v2/layout/topbar.html` — the single page title + GPU pills.

The topbar is the **only page-level title**. Workspace templates must not repeat the current page title with another kicker + h2.

### Shared components

- `app/templates/v2/components/character_rail.html`
- `app/templates/v2/components/toast.html`
- `app/templates/v2/components/media_dialog.html`

### Views

One template per navigation item:

- `views/create.html`
- `views/continue.html`
- `views/audio.html`
- `views/clip.html`
- `views/library.html`
- `views/queue.html`
- `views/editor.html`
- `views/chat.html`
- `views/system.html`
- `views/instruction.html`

## JavaScript

### Shell

- `js/core.js` — global V2 state, storage, fetch/copy/toast helpers.
- `js/navigation.js` — navigation, page title, mobile drawers.
- `js/characters.js` — Character loading/filtering/selection.
- `js/status.js` — topbar GPU pills.
- `js/create.js` — Create form, uploads, wand, submit.
- `js/instruction.js` — ChatGPT/H3 guide copy.
- `js/bootstrap.js` — startup and polling.

### Workspaces

- `js/workspaces/core.js` — shared workspace runtime, media/state refresh and common helpers.
- `js/workspaces/generators.js` — Continue / Continue Clip shared generator flows.
- `js/workspaces/audio.js` — dedicated Audio workspace: track source selection, waveform decoding/drawing, draggable fragment, preview playback, visual reference and submit.
- `js/workspaces/library.js`
- `js/workspaces/queue.js`
- `js/workspaces/chat.js`
- `js/workspaces/system.js`
- `js/workspaces/editor.js`

Cross-workspace actions use small browser events such as `v2:datarefresh`, `v2:use-continue`, `v2:use-clip`, and `v2:add-editor` instead of one giant shared closure.

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
- `css/workspaces/continue.css` — Continue-specific reference layout
- `css/workspaces/audio.css` — Audio waveform/timeline and audio-output controls
- `css/workspaces/generator-design.css` — canonical shared visual components for Create / Continue / Audio; see `docs/v2/DESIGN_SYSTEM.md`
- `css/workspaces/clip.css` — Continue Clip-specific media and track layout, built on the generator design system
- `css/workspaces/library.css`
- `css/workspaces/queue.css`
- `css/workspaces/chat.css`
- `css/workspaces/system.css`
- `css/workspaces/editor.css`
- `css/workspaces/responsive.css`

## Editing rule

When changing one V2 section, edit its view + its JS module + its CSS module first. Put only truly shared behavior into the corresponding core/common file.
