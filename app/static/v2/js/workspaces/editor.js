(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, showToast, escapeHtml } = api;

  const EDITOR_KEY = "aivideosite-" + api.userId + "-v2-editor";
  let state = W.loadJson(EDITOR_KEY, { title: "Монтаж V2", clips: [], zoom: 14, snap: true });
  if (!state || typeof state !== "object") state = { title: "Монтаж V2", clips: [], zoom: 14, snap: true };
  if (!Array.isArray(state.clips)) state.clips = [];
  let selected = -1;
  let dragIndex = -1;
  let audioFile = null;

  const save = () => W.saveJson(EDITOR_KEY, state);

  const normalize = () => {
    const valid = new Set(W.allMedia.map((item) => String(item.id)));
    state.clips = state.clips.filter((clip) => valid.has(String(clip.media_id)));
    state.title = String(state.title || "Монтаж V2");
    state.zoom = Math.max(8, Math.min(32, Number(state.zoom) || 14));
    state.snap = state.snap !== false;

    const snap = qs("#v2-editor-snap");
    if (snap) snap.checked = state.snap;
    const zoomLabel = qs("#v2-editor-zoom-label");
    if (zoomLabel) zoomLabel.textContent = state.zoom + " px/s";
    save();
  };

  const snapTime = (value) => {
    const number = Math.max(0, Number(value) || 0);
    return state.snap ? Math.round(number * 2) / 2 : number;
  };

  const effectiveDuration = (clip) => {
    const item = W.mediaById(clip.media_id);
    const source = Number(item?.duration || item?.meta?.seconds || 0);
    const start = Math.max(0, Number(clip.trim_start) || 0);
    const requested = Math.max(0, Number(clip.trim_duration) || 0);
    return requested > 0
      ? Math.min(requested, Math.max(0, source - start))
      : Math.max(0, source - start);
  };

  const renderLibrary = () => {
    const root = qs("#v2-editor-media");
    if (!root) return;
    root.innerHTML = W.allMedia.map((item) =>
      '<button class="v2-editor-library-item" type="button" data-editor-add="' + escapeHtml(item.id) + '">' +
      '<span class="v2-editor-thumb"><svg class="icon"><use href="/static/icons.svg#icon-video"></use></svg></span>' +
      '<span><strong>' + escapeHtml(item.title || "Видео") + '</strong><small>' +
      escapeHtml(W.formatSeconds(item.duration || item.meta?.seconds || 0)) +
      "</small></span></button>"
    ).join("");
  };

  const addClip = (item) => {
    if (!item) return;
    state.clips.push({
      media_id: item.id,
      volume: 1,
      trim_start: 0,
      trim_duration: 0,
      fade_in: 0,
      fade_out: 0,
    });
    selected = state.clips.length - 1;
    save();
    renderTimeline();
    renderInspector();
    showToast("Клип добавлен на таймлайн.");
  };

  const renderTimeline = () => {
    const root = qs("#v2-editor-timeline");
    if (!root) return;

    root.innerHTML = state.clips.map((clip, index) => {
      const item = W.mediaById(clip.media_id);
      const duration = effectiveDuration(clip);
      return (
        '<div class="v2-timeline-clip' + (index === selected ? " selected" : "") +
        '" draggable="true" data-editor-index="' + index +
        '" style="flex-basis:' + Math.max(90, duration * state.zoom) + 'px">' +
        "<strong>" + escapeHtml(item?.title || "Клип") + "</strong>" +
        "<small>" + escapeHtml(W.formatSeconds(duration)) + " · " +
        Math.round((Number(clip.volume) || 0) * 100) + "%</small></div>"
      );
    }).join("");

    const duration = state.clips.reduce((sum, clip) => sum + effectiveDuration(clip), 0);
    const label = qs("#v2-editor-duration");
    if (label) label.textContent = W.formatSeconds(duration);
  };

  const renderInspector = () => {
    const controls = qs("#v2-editor-controls");
    const empty = qs("#v2-editor-no-selection");
    const clip = state.clips[selected];
    if (!controls || !empty) return;

    controls.hidden = !clip;
    empty.hidden = Boolean(clip);

    const preview = qs("#v2-editor-preview");
    const monitorEmpty = qs("#v2-editor-monitor-empty");

    if (!clip) {
      if (preview) {
        preview.pause?.();
        preview.removeAttribute("src");
        preview.load?.();
      }
      if (monitorEmpty) monitorEmpty.hidden = false;
      return;
    }

    const item = W.mediaById(clip.media_id);
    qs("#v2-editor-clip-name").textContent = item?.title || "Клип";
    qs("#v2-editor-trim-start").value = clip.trim_start ?? 0;
    qs("#v2-editor-trim-duration").value = clip.trim_duration ?? 0;
    qs("#v2-editor-volume").value = clip.volume ?? 1;
    qs("#v2-editor-fade-in").value = clip.fade_in ?? 0;
    qs("#v2-editor-fade-out").value = clip.fade_out ?? 0;

    if (preview && item) {
      const wanted = "/media/" + encodeURIComponent(item.id);
      if (!preview.src.endsWith(wanted)) preview.src = wanted;
    }
    if (monitorEmpty) monitorEmpty.hidden = true;
  };

  const reconcile = () => {
    normalize();
    if (selected >= state.clips.length) selected = state.clips.length - 1;
    const title = qs("#v2-editor-title");
    if (title && document.activeElement !== title) title.value = state.title;
    renderLibrary();
    renderTimeline();
    renderInspector();
  };

  qs("#v2-editor-media")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-editor-add]");
    if (button) addClip(W.mediaById(button.dataset.editorAdd));
  });

  window.addEventListener("v2:add-editor", (event) => {
    addClip(W.mediaById(event.detail?.mediaId));
  });

  qs("#v2-editor-timeline")?.addEventListener("click", (event) => {
    const clip = event.target.closest("[data-editor-index]");
    if (!clip) return;
    selected = Number(clip.dataset.editorIndex);
    renderTimeline();
    renderInspector();
  });

  qs("#v2-editor-timeline")?.addEventListener("dragstart", (event) => {
    const clip = event.target.closest("[data-editor-index]");
    dragIndex = clip ? Number(clip.dataset.editorIndex) : -1;
  });
  qs("#v2-editor-timeline")?.addEventListener("dragover", (event) => event.preventDefault());
  qs("#v2-editor-timeline")?.addEventListener("drop", (event) => {
    event.preventDefault();
    const target = event.target.closest("[data-editor-index]");
    const targetIndex = target ? Number(target.dataset.editorIndex) : state.clips.length - 1;
    if (dragIndex < 0 || targetIndex < 0 || dragIndex === targetIndex) return;

    const [moved] = state.clips.splice(dragIndex, 1);
    state.clips.splice(targetIndex, 0, moved);
    selected = targetIndex;
    dragIndex = -1;
    save();
    renderTimeline();
    renderInspector();
  });

  const fields = {
    "#v2-editor-trim-start": "trim_start",
    "#v2-editor-trim-duration": "trim_duration",
    "#v2-editor-volume": "volume",
    "#v2-editor-fade-in": "fade_in",
    "#v2-editor-fade-out": "fade_out",
  };

  Object.entries(fields).forEach(([selector, key]) => {
    const input = qs(selector);
    input?.addEventListener("input", (event) => {
      const clip = state.clips[selected];
      if (!clip) return;
      clip[key] = Math.max(0, Number(event.target.value) || 0);
      if (key === "volume") clip[key] = Math.min(2, clip[key]);
      save();
      renderTimeline();
    });
    input?.addEventListener("change", (event) => {
      if (!["trim_start", "trim_duration"].includes(key)) return;
      const clip = state.clips[selected];
      if (!clip) return;
      clip[key] = snapTime(event.target.value);
      event.target.value = clip[key];
      save();
      renderTimeline();
      renderInspector();
    });
  });

  qs("#v2-editor-title")?.addEventListener("input", (event) => {
    state.title = event.target.value;
    save();
  });

  const removeSelected = () => {
    if (!state.clips[selected]) return;
    state.clips.splice(selected, 1);
    selected = Math.min(selected, state.clips.length - 1);
    save();
    renderTimeline();
    renderInspector();
  };

  qs("#v2-editor-remove")?.addEventListener("click", removeSelected);

  qs("#v2-editor-split")?.addEventListener("click", () => {
    const clip = state.clips[selected];
    if (!clip) return;

    const duration = effectiveDuration(clip);
    const splitInput = qs("#v2-editor-split-at");
    const split = snapTime(splitInput?.value);
    if (splitInput) splitInput.value = split;

    if (split <= 0.05 || split >= duration - 0.05) {
      return showToast("Точка разреза должна находиться внутри клипа.", "error");
    }

    const originalStart = Number(clip.trim_start) || 0;
    const right = { ...clip };
    clip.trim_duration = split;
    right.trim_start = originalStart + split;
    right.trim_duration = duration - split;
    state.clips.splice(selected + 1, 0, right);
    save();
    renderTimeline();
    renderInspector();
  });

  qs("#v2-editor-snap")?.addEventListener("change", (event) => {
    state.snap = Boolean(event.target.checked);
    save();
  });

  const setZoom = (nextZoom) => {
    state.zoom = Math.max(8, Math.min(32, Number(nextZoom) || 14));
    const label = qs("#v2-editor-zoom-label");
    if (label) label.textContent = state.zoom + " px/s";
    save();
    renderTimeline();
  };

  qs("#v2-editor-zoom-out")?.addEventListener("click", () => setZoom(state.zoom - 2));
  qs("#v2-editor-zoom-in")?.addEventListener("click", () => setZoom(state.zoom + 2));

  const preview = qs("#v2-editor-preview");
  const updateTimecode = () => {
    const label = qs("#v2-editor-timecode");
    if (!label || !preview) return;
    label.textContent =
      W.formatSeconds(preview.currentTime || 0) +
      " / " +
      W.formatSeconds(preview.duration || 0);
  };

  preview?.addEventListener("timeupdate", updateTimecode);
  preview?.addEventListener("loadedmetadata", updateTimecode);
  preview?.addEventListener("durationchange", updateTimecode);

  document.addEventListener("keydown", (event) => {
    if (api.state.view !== "editor") return;
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (["input", "textarea", "select", "button"].includes(tag)) return;

    if (event.code === "Space" && preview?.src) {
      event.preventDefault();
      preview.paused ? preview.play() : preview.pause();
    } else if ((event.key === "Delete" || event.key === "Backspace") && state.clips[selected]) {
      event.preventDefault();
      removeSelected();
    }
  });

  qs("#v2-editor-audio")?.addEventListener("change", (event) => {
    audioFile = event.target.files?.[0] || null;
    if (audioFile) showToast("Аудиодорожка выбрана: " + audioFile.name);
  });

  qs("#v2-editor-export")?.addEventListener("click", async (event) => {
    if (!state.clips.length) {
      return showToast("Добавьте хотя бы один ролик на таймлайн.", "error");
    }
    const button = event.currentTarget;
    const data = new FormData();
    data.set("project", JSON.stringify({
      title: qs("#v2-editor-title")?.value.trim() || "Монтаж V2",
      clips: state.clips,
      audio: {
        enabled: Boolean(audioFile),
        offset: Number(qs("#v2-editor-audio-offset")?.value) || 0,
        trim_start: Number(qs("#v2-editor-audio-trim")?.value) || 0,
        trim_duration: Number(qs("#v2-editor-audio-length")?.value) || 0,
        volume: Number(qs("#v2-editor-audio-volume")?.value) || 1,
      },
    }));
    if (audioFile) data.set("audio", audioFile);
    await W.submitForm("/api/editor/export", data, button);
  });

  window.addEventListener("v2:datarefresh", reconcile);
  window.addEventListener("v2:viewchange", (event) => {
    if (event.detail?.view === "editor") reconcile();
  });
})();