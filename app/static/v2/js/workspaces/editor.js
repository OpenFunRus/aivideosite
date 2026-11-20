(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, qsa, showToast, escapeHtml } = api;

  const EDITOR_KEY = "aivideosite-" + api.userId + "-v2-editor";
  const DEFAULT_STATE = {
    title: "Монтаж V2",
    clips: [],
    zoom: 14,
    snap: true,
    audio: {
      offset: 0,
      trim_start: 0,
      trim_duration: 0,
      volume: 1,
      file_name: "",
      source_duration: 0,
    },
  };

  let state = W.loadJson(EDITOR_KEY, DEFAULT_STATE);
  if (!state || typeof state !== "object") state = structuredCloneSafe(DEFAULT_STATE);
  if (!Array.isArray(state.clips)) state.clips = [];
  if (!state.audio || typeof state.audio !== "object") state.audio = { ...DEFAULT_STATE.audio };

  let selected = -1;
  let librarySelectedId = "";
  let clipDrag = null;
  let audioFile = null;
  let projectTime = 0;
  let pendingSeek = null;
  let pendingAutoplay = false;
  let advancing = false;
  const undoStack = [];
  const redoStack = [];

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const save = () => W.saveJson(EDITOR_KEY, state);
  const pushUndo = () => {
    undoStack.push(structuredCloneSafe(state));
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
    renderHistoryButtons();
  };
  const restoreState = (next) => {
    state = structuredCloneSafe(next);
    if (!Array.isArray(state.clips)) state.clips = [];
    if (!state.audio || typeof state.audio !== "object") state.audio = { ...DEFAULT_STATE.audio };
    selected = Math.min(selected, state.clips.length - 1);
    if (selected < 0 && state.clips.length) selected = 0;
    normalize();
    renderAll();
  };
  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(structuredCloneSafe(state));
    restoreState(undoStack.pop());
    renderHistoryButtons();
  };
  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(structuredCloneSafe(state));
    restoreState(redoStack.pop());
    renderHistoryButtons();
  };
  const renderHistoryButtons = () => {
    const undoButton = qs("#v2-editor-undo");
    const redoButton = qs("#v2-editor-redo");
    const removeButton = qs("#v2-editor-remove");
    const splitButton = qs("#v2-editor-toolbar-split");
    const hasSelection = Boolean(state.clips[selected]);
    if (undoButton) undoButton.disabled = !undoStack.length;
    if (redoButton) redoButton.disabled = !redoStack.length;
    if (removeButton) removeButton.disabled = !hasSelection;
    if (splitButton) splitButton.disabled = !hasSelection;
  };

  const normalize = () => {
    if (W.allMedia.length) {
      const valid = new Set(W.allMedia.map((item) => String(item.id)));
      state.clips = state.clips.filter((clip) => valid.has(String(clip.media_id)));
    }
    state.title = String(state.title || "Монтаж V2").slice(0, 120);
    state.zoom = Math.max(8, Math.min(32, Number(state.zoom) || 14));
    state.snap = state.snap !== false;
    state.audio = {
      offset: Math.max(0, Number(state.audio?.offset) || 0),
      trim_start: Math.max(0, Number(state.audio?.trim_start) || 0),
      trim_duration: Math.max(0, Number(state.audio?.trim_duration) || 0),
      volume: Math.max(0, Math.min(2, Number(state.audio?.volume) || 1)),
      file_name: String(state.audio?.file_name || ""),
      source_duration: Math.max(0, Number(state.audio?.source_duration) || 0),
    };

    const snap = qs("#v2-editor-snap");
    if (snap) snap.checked = state.snap;
    const zoomLabel = qs("#v2-editor-zoom-label");
    if (zoomLabel) zoomLabel.textContent = state.zoom + " px/s";
    const zoomRange = qs("#v2-editor-zoom-range");
    if (zoomRange) zoomRange.value = String(state.zoom);

    const title = qs("#v2-editor-title");
    if (title && document.activeElement !== title) title.value = state.title;

    const audioFields = {
      "#v2-editor-audio-offset": state.audio.offset,
      "#v2-editor-audio-trim": state.audio.trim_start,
      "#v2-editor-audio-length": state.audio.trim_duration,
      "#v2-editor-audio-volume": state.audio.volume,
    };
    Object.entries(audioFields).forEach(([selector, value]) => {
      const input = qs(selector);
      if (input && document.activeElement !== input) input.value = String(value);
    });
    updateAudioName();
    save();
  };

  const snapTime = (value) => {
    const number = Math.max(0, Number(value) || 0);
    return state.snap ? Math.round(number * 2) / 2 : number;
  };

  const sourceDuration = (clip) => {
    const item = W.mediaById(clip?.media_id);
    return Math.max(0, Number(item?.duration || item?.meta?.seconds || 0));
  };

  const effectiveDuration = (clip) => {
    const source = sourceDuration(clip);
    const start = Math.max(0, Number(clip?.trim_start) || 0);
    const requested = Math.max(0, Number(clip?.trim_duration) || 0);
    return requested > 0
      ? Math.min(requested, Math.max(0, source - start))
      : Math.max(0, source - start);
  };

  const clipProjectStart = (index) =>
    state.clips.slice(0, Math.max(0, index)).reduce((sum, clip) => sum + effectiveDuration(clip), 0);

  const projectDuration = () =>
    state.clips.reduce((sum, clip) => sum + effectiveDuration(clip), 0);

  const musicDuration = () => {
    const available = Math.max(0, state.audio.source_duration - state.audio.trim_start);
    const fallback = Math.max(0, projectDuration() - state.audio.offset);
    return state.audio.trim_duration > 0
      ? Math.min(state.audio.trim_duration, available || state.audio.trim_duration)
      : (available || fallback);
  };

  const timelineSpan = () =>
    Math.max(projectDuration(), state.audio.offset + musicDuration());

  const formatTime = (value) => {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    const hundredths = Math.floor((seconds - Math.floor(seconds)) * 100);
    return String(minutes).padStart(2, "0") + ":" +
      String(rest).padStart(2, "0") + "." +
      String(hundredths).padStart(2, "0");
  };

  const renderLibrary = () => {
    const root = qs("#v2-editor-media");
    const count = qs("#v2-editor-library-count");
    if (!root) return;
    const query = String(qs("#v2-editor-search")?.value || "").trim().toLowerCase();
    const filtered = W.allMedia.filter((item) => {
      if (!query) return true;
      return String(item.title || item.filename || "").toLowerCase().includes(query);
    });
    if (count) count.textContent = filtered.length + " роликов";

    const visible = filtered.slice(0, 100);
    root.innerHTML = visible.map((item) => {
      const selectedClass = String(item.id) === String(librarySelectedId) ? " selected" : "";
      const duration = W.formatSeconds(item.duration || item.meta?.seconds || 0);
      const resolution = W.mediaResolution(item);
      return '<button class="v2-editor-library-item' + selectedClass + '" type="button" data-editor-media="' +
        escapeHtml(item.id) + '">' +
        '<video src="/media/' + encodeURIComponent(item.id) + '#t=0.05" muted playsinline preload="metadata" tabindex="-1"></video>' +
        '<span class="v2-editor-library-meta"><strong>' + escapeHtml(item.title || "Видео") +
        '</strong><small>' + escapeHtml(resolution + " · " + duration) + '</small></span></button>';
    }).join("");

    if (!visible.length) {
      root.innerHTML = '<div class="v2-editor-no-selection">Ничего не найдено</div>';
    }
    const add = qs("#v2-editor-add-selected");
    if (add) add.disabled = !W.mediaById(librarySelectedId);
  };

  const addClip = (item) => {
    if (!item) return;
    pushUndo();
    state.clips.push({
      media_id: item.id,
      volume: 1,
      trim_start: 0,
      trim_duration: 0,
      fade_in: 0,
      fade_out: 0,
    });
    selected = state.clips.length - 1;
    projectTime = clipProjectStart(selected);
    save();
    renderAll();
    selectClip(selected, 0, false);
    showToast("Клип добавлен на таймлайн.");
  };

  const timelineWidth = () => Math.max(900, Math.ceil(timelineSpan() * state.zoom) + 80);

  const renderRuler = () => {
    const ruler = qs("#v2-editor-ruler");
    const canvas = qs("#v2-editor-timeline-canvas");
    if (!ruler || !canvas) return;
    const duration = Math.max(timelineSpan(), 15);
    const width = timelineWidth();
    canvas.style.width = (72 + width) + "px";
    const step = state.zoom >= 24 ? 1 : state.zoom >= 14 ? 2 : 5;
    let html = "";
    for (let time = 0; time <= duration + 0.001; time += step) {
      const left = Math.min(width, time * state.zoom);
      html += '<span class="v2-editor-ruler-mark major" style="left:' + left + 'px"><span>' +
        formatTime(time).slice(0, 5) + '</span></span>';
      if (step > 1) {
        for (let sub = 1; sub < step; sub += 1) {
          const subTime = time + sub;
          if (subTime >= duration) break;
          html += '<span class="v2-editor-ruler-mark" style="left:' + (subTime * state.zoom) + 'px"></span>';
        }
      }
    }
    ruler.innerHTML = html;
  };

  const renderTimeline = () => {
    const root = qs("#v2-editor-timeline");
    if (!root) return;
    let cursor = 0;
    root.style.width = timelineWidth() + "px";
    root.innerHTML = state.clips.map((clip, index) => {
      const item = W.mediaById(clip.media_id);
      const duration = effectiveDuration(clip);
      const left = cursor * state.zoom;
      const width = Math.max(48, duration * state.zoom);
      cursor += duration;
      return '<div class="v2-timeline-clip' + (index === selected ? " selected" : "") +
        '" data-editor-index="' + index + '" tabindex="0" style="left:' + left + 'px;width:' + width + 'px">' +
        '<video class="v2-timeline-thumb" src="/media/' + encodeURIComponent(clip.media_id) +
        '#t=' + encodeURIComponent(Math.max(0.05, Number(clip.trim_start) || 0.05)) +
        '" muted playsinline preload="metadata" tabindex="-1" draggable="false"></video>' +
        '<button class="v2-timeline-delete" type="button" data-editor-delete-index="' + index +
        '" title="Удалить клип" aria-label="Удалить клип">' +
        '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-trash"></use></svg></button>' +
        '<div class="v2-timeline-clip-copy"><strong>' + escapeHtml(item?.title || "Клип") +
        '</strong><small>' + escapeHtml(formatTime(duration)) + ' · ' +
        Math.round((Number(clip.volume) || 0) * 100) + '%</small></div></div>';
    }).join("");

    const total = projectDuration();
    const durationLabel = qs("#v2-editor-duration");
    const clipCount = qs("#v2-editor-clip-count");
    if (durationLabel) durationLabel.textContent = formatTime(total);
    if (clipCount) clipCount.textContent = String(state.clips.length);
    renderRuler();
    renderMusicLane();
    updateTransport();
  };

  const updateAudioName = () => {
    const label = qs("#v2-editor-audio-name");
    if (!label) return;
    if (audioFile) label.textContent = audioFile.name;
    else if (state.audio.file_name) label.textContent = state.audio.file_name + " · выбрать файл заново";
    else label.textContent = "Выбрать аудио";
  };

  const renderMusicLane = () => {
    const root = qs("#v2-editor-music-lane");
    const count = qs("#v2-editor-audio-count");
    if (!root) return;
    root.style.width = timelineWidth() + "px";
    const hasAudio = Boolean(audioFile || state.audio.file_name);
    if (count) count.textContent = hasAudio ? "1 дорожка" : "0";
    if (!hasAudio) {
      root.innerHTML = "";
      return;
    }
    const duration = musicDuration();
    const left = state.audio.offset * state.zoom;
    const width = Math.max(70, duration * state.zoom);
    root.innerHTML = '<div class="v2-editor-music-block" style="left:' + left + 'px;width:' + width +
      'px"><span>♫ ' + escapeHtml(audioFile?.name || state.audio.file_name || "Музыка") + '</span></div>';
  };

  const renderInfo = () => {
    const root = qs("#v2-editor-info");
    if (!root) return;
    const clip = state.clips[selected];
    const item = clip ? W.mediaById(clip.media_id) : null;
    const rows = [
      ["Клип", item?.title || "—"],
      ["Разрешение", item ? W.mediaResolution(item) : "—"],
      ["Источник", item?.filename || item?.id || "—"],
      ["Длина", clip ? formatTime(effectiveDuration(clip)) : "—"],
    ];
    root.innerHTML = rows.map(([label, value]) =>
      '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>'
    ).join("");
  };

  const setPreviewSource = (item, clip) => {
    const preview = qs("#v2-editor-preview");
    const empty = qs("#v2-editor-monitor-empty");
    if (!preview) return;
    if (!item || !clip) {
      preview.pause?.();
      preview.removeAttribute("src");
      preview.removeAttribute("data-media-id");
      preview.load?.();
      if (empty) empty.hidden = false;
      return;
    }
    const mediaId = String(item.id);
    const start = Math.max(0, Number(clip.trim_start) || 0);
    if (preview.dataset.mediaId !== mediaId) {
      preview.pause?.();
      preview.dataset.mediaId = mediaId;
      preview.src = "/media/" + encodeURIComponent(mediaId);
      preview.load?.();
      if (pendingSeek === null) pendingSeek = 0;
    }
    if (empty) empty.hidden = true;
    if (preview.readyState >= 1 && pendingSeek !== null) {
      const seek = Math.max(0, Math.min(effectiveDuration(clip), pendingSeek));
      preview.currentTime = start + seek;
      pendingSeek = null;
      if (pendingAutoplay) {
        pendingAutoplay = false;
        preview.play().catch(() => {});
      }
    }
  };

  const renderInspector = () => {
    const controls = qs("#v2-editor-controls");
    const empty = qs("#v2-editor-no-selection");
    const clip = state.clips[selected];
    if (!controls || !empty) return;
    controls.hidden = !clip;
    empty.hidden = Boolean(clip);

    if (!clip) {
      setPreviewSource(null, null);
      renderInfo();
      return;
    }
    const item = W.mediaById(clip.media_id);
    qs("#v2-editor-clip-name").textContent = item?.title || "Клип";
    qs("#v2-editor-trim-start").value = clip.trim_start ?? 0;
    qs("#v2-editor-trim-duration").value = clip.trim_duration ?? 0;
    qs("#v2-editor-volume").value = clip.volume ?? 1;
    qs("#v2-editor-fade-in").value = clip.fade_in ?? 0;
    qs("#v2-editor-fade-out").value = clip.fade_out ?? 0;
    const splitInput = qs("#v2-editor-split-at");
    if (splitInput && document.activeElement !== splitInput) {
      splitInput.value = Math.max(.1, effectiveDuration(clip) / 2).toFixed(1);
    }
    setPreviewSource(item, clip);
    renderInfo();
  };

  const updateTransport = () => {
    const total = projectDuration();
    projectTime = Math.max(0, Math.min(total, projectTime));
    const time = qs("#v2-editor-timecode");
    const viewTime = qs("#v2-editor-view-time");
    const scrub = qs("#v2-editor-project-scrub");
    const playhead = qs("#v2-editor-playhead");
    if (time) time.textContent = formatTime(projectTime);
    if (viewTime) viewTime.textContent = formatTime(projectTime) + " / " + formatTime(total);
    if (scrub) scrub.value = total > 0 ? String(Math.round(projectTime / total * 1000)) : "0";
    if (playhead) playhead.style.left = (72 + projectTime * state.zoom) + "px";
    const play = qs("#v2-editor-play");
    const preview = qs("#v2-editor-preview");
    if (play) play.textContent = preview && !preview.paused ? "❚❚" : "▶";
  };

  const renderAll = () => {
    normalize();
    if (selected >= state.clips.length) selected = state.clips.length - 1;
    renderLibrary();
    renderTimeline();
    renderInspector();
    renderHistoryButtons();
  };

  const seekPreviewWithin = (within, autoplay = false) => {
    const clip = state.clips[selected];
    const preview = qs("#v2-editor-preview");
    if (!clip || !preview) return;
    pendingSeek = Math.max(0, Math.min(effectiveDuration(clip), Number(within) || 0));
    pendingAutoplay = autoplay;
    const item = W.mediaById(clip.media_id);
    setPreviewSource(item, clip);
  };

  const selectClip = (index, within = 0, autoplay = false) => {
    if (!state.clips[index]) return;
    selected = index;
    projectTime = clipProjectStart(index) + Math.max(0, Number(within) || 0);
    pendingSeek = Math.max(0, Number(within) || 0);
    pendingAutoplay = autoplay;
    renderTimeline();
    renderInspector();
    renderHistoryButtons();
    updateTransport();
  };

  const seekProjectTime = (time, autoplay = false) => {
    const total = projectDuration();
    const wanted = Math.max(0, Math.min(total, Number(time) || 0));
    if (!state.clips.length) {
      projectTime = 0;
      return updateTransport();
    }
    let cursor = 0;
    let index = state.clips.length - 1;
    let within = effectiveDuration(state.clips[index]);
    for (let i = 0; i < state.clips.length; i += 1) {
      const duration = effectiveDuration(state.clips[i]);
      if (wanted <= cursor + duration || i === state.clips.length - 1) {
        index = i;
        within = Math.max(0, wanted - cursor);
        break;
      }
      cursor += duration;
    }
    selectClip(index, within, autoplay);
  };

  const removeClipAt = (index) => {
    const targetIndex = Number(index);
    if (!Number.isInteger(targetIndex) || !state.clips[targetIndex]) return;
    pushUndo();
    const start = clipProjectStart(targetIndex);
    state.clips.splice(targetIndex, 1);
    if (!state.clips.length) {
      selected = -1;
      projectTime = 0;
    } else {
      selected = Math.min(targetIndex, state.clips.length - 1);
      projectTime = Math.min(start, projectDuration());
    }
    save();
    renderAll();
    if (selected >= 0) selectClip(selected, 0, false);
    showToast("Клип удалён с таймлайна.");
  };

  const removeSelected = () => removeClipAt(selected);

  const splitSelected = (value) => {
    const clip = state.clips[selected];
    if (!clip) return;
    const duration = effectiveDuration(clip);
    const split = snapTime(value);
    if (split <= 0.05 || split >= duration - 0.05) {
      return showToast("Точка разреза должна находиться внутри клипа.", "error");
    }
    pushUndo();
    const originalStart = Number(clip.trim_start) || 0;
    const right = { ...clip };
    clip.trim_duration = split;
    right.trim_start = originalStart + split;
    right.trim_duration = duration - split;
    state.clips.splice(selected + 1, 0, right);
    save();
    renderAll();
    selectClip(selected, Math.min(split, .01), false);
  };

  qs("#v2-editor-media")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-editor-media]");
    if (!button) return;
    librarySelectedId = String(button.dataset.editorMedia || "");
    renderLibrary();
  });
  qs("#v2-editor-media")?.addEventListener("dblclick", (event) => {
    const button = event.target.closest("[data-editor-media]");
    if (button) addClip(W.mediaById(button.dataset.editorMedia));
  });
  qs("#v2-editor-add-selected")?.addEventListener("click", () => addClip(W.mediaById(librarySelectedId)));
  qs("#v2-editor-search")?.addEventListener("input", renderLibrary);

  window.addEventListener("v2:add-editor", (event) => {
    const item = W.mediaById(event.detail?.mediaId);
    if (item) {
      librarySelectedId = String(item.id);
      addClip(item);
    }
  });

  const timeline = qs("#v2-editor-timeline");

  timeline?.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-editor-delete-index]");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      removeClipAt(Number(deleteButton.dataset.editorDeleteIndex));
      return;
    }
    if (clipDrag?.moved) return;
    const clip = event.target.closest("[data-editor-index]");
    if (!clip) return;
    selectClip(Number(clip.dataset.editorIndex), 0, false);
  });

  timeline?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("[data-editor-delete-index]")) return;
    const clip = event.target.closest("[data-editor-index]");
    if (!clip) return;

    const sourceIndex = Number(clip.dataset.editorIndex);
    if (!Number.isInteger(sourceIndex) || !state.clips[sourceIndex]) return;

    selected = sourceIndex;
    renderTimeline();
    renderInspector();

    const activeClip = timeline.querySelector('[data-editor-index="' + sourceIndex + '"]');
    if (!activeClip) return;

    clipDrag = {
      pointerId: event.pointerId,
      sourceIndex,
      element: activeClip,
      startX: event.clientX,
      lastX: event.clientX,
      moved: false,
    };
    activeClip.setPointerCapture?.(event.pointerId);
    activeClip.classList.add("dragging");
    event.preventDefault();
  });

  timeline?.addEventListener("pointermove", (event) => {
    if (!clipDrag || event.pointerId !== clipDrag.pointerId) return;
    const delta = event.clientX - clipDrag.startX;
    clipDrag.lastX = event.clientX;
    if (Math.abs(delta) >= 4) clipDrag.moved = true;
    if (!clipDrag.moved) return;
    clipDrag.element.style.transform = "translateX(" + delta + "px)";
    event.preventDefault();
  });

  const finishClipDrag = (event, canceled = false) => {
    if (!clipDrag || event.pointerId !== clipDrag.pointerId) return;
    const drag = clipDrag;
    clipDrag = null;

    drag.element.releasePointerCapture?.(event.pointerId);
    drag.element.classList.remove("dragging");
    drag.element.style.transform = "";

    if (canceled || !drag.moved || !state.clips[drag.sourceIndex]) {
      renderTimeline();
      return;
    }

    const rect = timeline.getBoundingClientRect();
    const pointerX = Math.max(0, drag.lastX - rect.left);
    pushUndo();
    const [moved] = state.clips.splice(drag.sourceIndex, 1);

    let cursor = 0;
    let insertIndex = state.clips.length;
    for (let i = 0; i < state.clips.length; i += 1) {
      const width = Math.max(48, effectiveDuration(state.clips[i]) * state.zoom);
      if (pointerX < cursor + width / 2) {
        insertIndex = i;
        break;
      }
      cursor += width;
    }

    state.clips.splice(insertIndex, 0, moved);
    selected = insertIndex;
    projectTime = clipProjectStart(selected);
    save();
    renderAll();
    selectClip(selected, 0, false);
  };

  timeline?.addEventListener("pointerup", (event) => finishClipDrag(event, false));
  timeline?.addEventListener("pointercancel", (event) => finishClipDrag(event, true));

  qs("#v2-editor-ruler")?.addEventListener("click", (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    seekProjectTime((event.clientX - rect.left) / state.zoom, false);
  });

  const fields = {
    "#v2-editor-trim-start": ["trim_start", 0, Infinity],
    "#v2-editor-trim-duration": ["trim_duration", 0, Infinity],
    "#v2-editor-volume": ["volume", 0, 2],
    "#v2-editor-fade-in": ["fade_in", 0, 10],
    "#v2-editor-fade-out": ["fade_out", 0, 10],
  };
  Object.entries(fields).forEach(([selector, spec]) => {
    qs(selector)?.addEventListener("change", (event) => {
      const clip = state.clips[selected];
      if (!clip) return;
      const [key, min, max] = spec;
      pushUndo();
      let value = Number(event.target.value) || 0;
      value = Math.max(min, Math.min(max, value));
      if (key === "trim_start" || key === "trim_duration") value = snapTime(value);
      clip[key] = value;
      event.target.value = String(value);
      save();
      projectTime = clipProjectStart(selected);
      pendingSeek = 0;
      renderAll();
    });
  });

  qs("#v2-editor-title")?.addEventListener("input", (event) => {
    state.title = String(event.target.value || "").slice(0, 120);
    save();
  });

  qs("#v2-editor-split")?.addEventListener("click", () => {
    splitSelected(qs("#v2-editor-split-at")?.value);
  });
  qs("#v2-editor-toolbar-split")?.addEventListener("click", () => {
    const relative = projectTime - clipProjectStart(selected);
    splitSelected(relative > .05 ? relative : qs("#v2-editor-split-at")?.value);
  });
  qs("#v2-editor-remove")?.addEventListener("click", removeSelected);
  qs("#v2-editor-undo")?.addEventListener("click", undo);
  qs("#v2-editor-redo")?.addEventListener("click", redo);

  qs("#v2-editor-snap")?.addEventListener("change", (event) => {
    state.snap = Boolean(event.target.checked);
    save();
  });

  const setZoom = (value) => {
    state.zoom = Math.max(8, Math.min(32, Number(value) || 14));
    save();
    renderTimeline();
    const range = qs("#v2-editor-zoom-range");
    if (range) range.value = String(state.zoom);
  };
  qs("#v2-editor-zoom-out")?.addEventListener("click", () => setZoom(state.zoom - 2));
  qs("#v2-editor-zoom-in")?.addEventListener("click", () => setZoom(state.zoom + 2));
  qs("#v2-editor-zoom-range")?.addEventListener("input", (event) => setZoom(event.target.value));

  qsa("[data-editor-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      qsa("[data-editor-tab]").forEach((item) => item.classList.toggle("active", item === button));
      qsa("[data-editor-pane]").forEach((pane) => {
        pane.classList.toggle("active", pane.dataset.editorPane === button.dataset.editorTab);
      });
    });
  });

  const preview = qs("#v2-editor-preview");
  preview?.addEventListener("loadedmetadata", () => {
    if (pendingSeek !== null && state.clips[selected]) seekPreviewWithin(pendingSeek, pendingAutoplay);
    updateTransport();
  });
  preview?.addEventListener("play", updateTransport);
  preview?.addEventListener("pause", updateTransport);
  preview?.addEventListener("timeupdate", () => {
    if (advancing) return;
    const clip = state.clips[selected];
    if (!clip || !preview) return;
    const start = Math.max(0, Number(clip.trim_start) || 0);
    const duration = effectiveDuration(clip);
    const within = Math.max(0, preview.currentTime - start);
    projectTime = clipProjectStart(selected) + Math.min(duration, within);
    updateTransport();
    if (!preview.paused && duration > 0 && within >= duration - .04) {
      advancing = true;
      const next = selected + 1;
      if (state.clips[next]) {
        selectClip(next, 0, true);
      } else {
        preview.pause();
        projectTime = projectDuration();
        updateTransport();
      }
      setTimeout(() => { advancing = false; }, 60);
    }
  });

  qs("#v2-editor-play")?.addEventListener("click", () => {
    if (!preview || !state.clips[selected]) return;
    if (preview.paused) preview.play().catch(() => {});
    else preview.pause();
  });
  qs("#v2-editor-prev")?.addEventListener("click", () => {
    if (!state.clips.length) return;
    selectClip(Math.max(0, selected - 1), 0, false);
  });
  qs("#v2-editor-next")?.addEventListener("click", () => {
    if (!state.clips.length) return;
    selectClip(Math.min(state.clips.length - 1, selected + 1), 0, false);
  });
  qs("#v2-editor-back")?.addEventListener("click", () => seekProjectTime(projectTime - 1, false));
  qs("#v2-editor-forward")?.addEventListener("click", () => seekProjectTime(projectTime + 1, false));
  qs("#v2-editor-project-scrub")?.addEventListener("input", (event) => {
    const total = projectDuration();
    seekProjectTime(total * (Number(event.target.value) || 0) / 1000, false);
  });
  qs("#v2-editor-preview-volume")?.addEventListener("input", (event) => {
    if (preview) preview.volume = Math.max(0, Math.min(1, Number(event.target.value) || 0));
  });

  const audioFields = {
    "#v2-editor-audio-offset": "offset",
    "#v2-editor-audio-trim": "trim_start",
    "#v2-editor-audio-length": "trim_duration",
    "#v2-editor-audio-volume": "volume",
  };
  Object.entries(audioFields).forEach(([selector, key]) => {
    qs(selector)?.addEventListener("change", (event) => {
      pushUndo();
      let value = Math.max(0, Number(event.target.value) || 0);
      if (key === "volume") value = Math.min(2, value);
      else value = snapTime(value);
      state.audio[key] = value;
      event.target.value = String(value);
      save();
      renderMusicLane();
    });
  });

  qs("#v2-editor-audio")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    audioFile = file;
    state.audio.file_name = file.name;
    state.audio.source_duration = 0;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      state.audio.source_duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      URL.revokeObjectURL(url);
      save();
      renderMusicLane();
    }, { once: true });
    audio.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
    audio.src = url;
    save();
    updateAudioName();
    renderMusicLane();
    showToast("Аудиодорожка выбрана: " + file.name);
  });

  qs("#v2-editor-save")?.addEventListener("click", () => {
    state.title = qs("#v2-editor-title")?.value.trim() || "Монтаж V2";
    save();
    const payload = JSON.stringify({
      version: 1,
      app: "AI Video Site V2",
      saved_at: new Date().toISOString(),
      state,
      note: state.audio.file_name
        ? "Аудиофайл не встраивается в JSON. После открытия выберите его заново."
        : "",
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (state.title || "montage-v2").replace(/[^a-zA-Z0-9а-яА-Я_-]+/g, "_") + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Проект сохранён в JSON.");
  });

  qs("#v2-editor-open")?.addEventListener("click", () => qs("#v2-editor-open-file")?.click());
  qs("#v2-editor-open-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const incoming = raw?.state && typeof raw.state === "object" ? raw.state : raw;
      if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.clips)) {
        throw new Error("В файле нет корректного проекта.");
      }
      pushUndo();
      state = {
        ...structuredCloneSafe(DEFAULT_STATE),
        ...incoming,
        clips: incoming.clips,
        audio: { ...DEFAULT_STATE.audio, ...(incoming.audio || {}) },
      };
      audioFile = null;
      selected = state.clips.length ? 0 : -1;
      projectTime = 0;
      normalize();
      renderAll();
      if (state.audio.file_name) {
        showToast("Проект открыт. Музыкальный файл нужно выбрать заново.");
      } else {
        showToast("Проект открыт.");
      }
    } catch (error) {
      showToast("Не удалось открыть проект: " + error.message, "error");
    }
  });

  qs("#v2-editor-export")?.addEventListener("click", async (event) => {
    if (!state.clips.length) {
      return showToast("Добавьте хотя бы один ролик на таймлайн.", "error");
    }
    if (state.audio.file_name && !audioFile) {
      return showToast("Выберите музыкальный файл заново перед экспортом.", "error");
    }
    state.title = qs("#v2-editor-title")?.value.trim() || "Монтаж V2";
    save();
    const button = event.currentTarget;
    const data = new FormData();
    data.set("project", JSON.stringify({
      title: state.title,
      clips: state.clips,
      audio: {
        enabled: Boolean(audioFile),
        offset: state.audio.offset,
        trim_start: state.audio.trim_start,
        trim_duration: state.audio.trim_duration,
        volume: state.audio.volume,
      },
    }));
    if (audioFile) data.set("audio", audioFile);
    await W.submitForm("/api/editor/export", data, button);
  });

  document.addEventListener("keydown", (event) => {
    if (api.state.view !== "editor") return;
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (["input", "textarea", "select", "button"].includes(tag)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.code === "Space" && preview?.src) {
      event.preventDefault();
      preview.paused ? preview.play().catch(() => {}) : preview.pause();
    } else if ((event.key === "Delete" || event.key === "Backspace") && state.clips[selected]) {
      event.preventDefault();
      removeSelected();
    }
  });

  window.addEventListener("v2:datarefresh", renderAll);
  window.addEventListener("v2:viewchange", (event) => {
    if (event.detail?.view === "editor") renderAll();
  });

  normalize();
  renderAll();
})();
