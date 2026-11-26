(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, qsa, escapeHtml, fetchJson, showToast } = api;
  const root = qs("#v2-repair");
  const player = qs("#v2-repair-preview");
  if (!root || !player) return;

  const modes = {
    fragment: { action: "AI-перегенерация", help: "MiniMax H3 заново создаст выделенный участок с опорными начальным и конечным кадрами. Вне выделения исходное видео сохранится.", placeholder: "Опишите, что H3 должен изменить в этом фрагменте…" },
    object: { action: "Заменить объект через H3", help: "Белой кистью закрасьте объект на кадре. MiniMax H3 Fun ControlNet перегенерирует эту область на выбранном временном участке. Маска одинаковая для всего отрезка.", placeholder: "Что должно появиться вместо закрашенного объекта?" },
    sound: { action: "Перегенерировать звук H3", help: "MiniMax H3 создаст новую звуковую дорожку по промпту. Изображение исходника останется прежним. Точные слова и тембр голоса не гарантируются.", placeholder: "Укажите точные новые слова в кавычках, говорящего и особенности голоса…" },
    splice: { action: "Сгенерировать склейку", help: "H3 получает последние 0,5 секунды видео A и первые 0,5 секунды видео B с движением и звуком. Генерирует между ними новый секундный переход. Оригинальные ролики сохраняются.", placeholder: "Опишите естественный переход между видео…" },
  };
  const defaultSplicePrompt = [
    "integrated_multimodal_description: [Shot 1] Create one seamless, cinematic transition between two supplied video takes, using the anchored motion clips as exact visual and temporal references. The first guided clip is the end of video A; continue its real subject motion, camera trajectory, perspective and lighting. The second guided clip is the beginning of video B; naturally reach its initial composition, subjects and camera trajectory. During the one-second unanchored interval, independently choose the most convincing transition for these specific scenes: a continuous camera move, match on action, natural foreground occlusion or a motivated whip pan when appropriate. Preserve character identity, clothing, proportions, object continuity, spatial geometry, exposure, textures and motion direction. Invent only the minimum needed to connect the existing scenes. Avoid a hard cut, fade to black, unrelated subjects, sudden camera jumps or synthetic distortions. The bridge must flow smoothly into the start of B.",
    "overall_soundscape: Continue existing environmental sound naturally through the transition. Smoothly connect the ambience, motion sound and room tone of the anchored audio clips, without sudden volume jumps or newly invented dialogue.",
    "non_diegetic_music: N/A",
  ].join("\n\n");
  const splicePromptKey = "aivideosite.repair.splice.prompt.v1";
  const FPS = 24;
  const state = { mode: "fragment", a: null, b: null, pickerSlot: "a", start: 0, end: 0, previewSlot: "a", dragging: null, uploading: false, submitting: false, maskDrawn: false, splice: { quality: "480", ratio: "auto", steps: "8" } };
  const mask = qs("#v2-repair-mask");
  const gpuDialog = qs("#v2-repair-gpu-dialog");
  const gpuButtons = Array.from(gpuDialog.querySelectorAll("[data-repair-gpu]"));
  let gpuTimer = null;
  const sourceUrl = (item) => "/media/" + encodeURIComponent(item.id);
  const thumbnailUrl = (item) => "/api/media/" + encodeURIComponent(item.id) + "/frame/start";
  const duration = (item) => Math.max(0, Number(item?.duration || item?.meta?.seconds) || 0);
  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));
  const fmt = (seconds) => {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const rest = Math.floor(value % 60);
    return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0") + "." + String(Math.floor((value % 1) * 1000)).padStart(3, "0");
  };
  const roundFrame = (time) => Math.round(time * FPS) / FPS;
  const isSplice = () => state.mode === "splice";
  const currentPrompt = () => (isSplice() ? qs("#v2-repair-splice-prompt") : qs("#v2-repair-prompt")).value.trim();
  const spliceSize = () => {
    const mediaSize = W.mediaResolution(state.a || {}) || "";
    const match = mediaSize.match(/(\d+)\s*[x×]\s*(\d+)/i);
    const w = Number(state.a?.meta?.width || match?.[1] || 16);
    const h = Number(state.a?.meta?.height || match?.[2] || 9);
    const ratio = { "1:1": 1, "16:9": 16 / 9, "9:16": 9 / 16 }[state.splice.ratio] || w / Math.max(h, 1);
    const short = { "480": 480, "720": 736, "1080": 1088 }[state.splice.quality];
    const grid = (n) => Math.ceil(n / 32) * 32;
    return [grid(short * Math.max(1, ratio)), grid(short * Math.max(1, 1 / ratio))];
  };
  function renderSpliceResolution() {
    const [width, height] = spliceSize();
    qs("#v2-repair-splice-resolution").textContent = width + " × " + height + " · " + (state.splice.ratio === "auto" ? "формат A" : state.splice.ratio);
  }
  const total = () => isSplice() && state.a && state.b
    ? Math.max(.01, duration(state.a) + duration(state.b) + 1)
    : Math.max(.01, duration(state.a));
  const currentTimelineTime = () => state.previewSlot === "b" && isSplice() && state.a
    ? Math.max(0, duration(state.a) + 1) + (player.currentTime || 0)
    : player.currentTime || 0;

  function clearMask() {
    mask.getContext("2d").clearRect(0, 0, mask.width, mask.height);
    state.maskDrawn = false;
    renderControls();
  }

  function layoutMask() {
    if (!state.a || state.mode !== "object" || state.previewSlot !== "a") {
      mask.hidden = true;
      return;
    }
    const monitor = player.parentElement.getBoundingClientRect();
    const videoWidth = player.videoWidth || Number(state.a?.meta?.width) || 16;
    const videoHeight = player.videoHeight || Number(state.a?.meta?.height) || 9;
    const scale = Math.min(monitor.width / videoWidth, monitor.height / videoHeight);
    const width = Math.max(1, videoWidth * scale), height = Math.max(1, videoHeight * scale);
    const canvasWidth = Math.min(videoWidth, 1024);
    const canvasHeight = Math.max(1, Math.round(canvasWidth * videoHeight / videoWidth));
    if (mask.width !== canvasWidth || mask.height !== canvasHeight) {
      // Changing the source or its aspect ratio invalidates a painted mask.
      mask.width = canvasWidth;
      mask.height = canvasHeight;
      state.maskDrawn = false;
      renderControls();
    }
    mask.style.left = (monitor.width - width) / 2 + "px";
    mask.style.top = (monitor.height - height) / 2 + "px";
    mask.style.width = width + "px";
    mask.style.height = height + "px";
    mask.hidden = false;
  }

  function exportMask() {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(mask, 0, 0);
    return canvas.toDataURL("image/png");
  }

  let painting = false;
  function paint(event) {
    const bounds = mask.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * mask.width;
    const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1) * mask.height;
    const context = mask.getContext("2d");
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#fff";
    context.lineWidth = Number(qs("#v2-repair-brush").value) * mask.width / Math.max(bounds.width, 1);
    if (event.type === "pointerdown") {
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + .01, y + .01);
    } else context.lineTo(x, y);
    context.stroke();
    state.maskDrawn = true;
    renderControls();
  }
  mask.addEventListener("pointerdown", (event) => {
    if (state.mode !== "object") return;
    player.pause();
    painting = true;
    mask.setPointerCapture(event.pointerId);
    paint(event);
    event.preventDefault();
  });
  mask.addEventListener("pointermove", (event) => { if (painting) paint(event); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) =>
    mask.addEventListener(name, () => { painting = false; }));
  qs("#v2-repair-mask-clear").addEventListener("click", clearMask);
  window.addEventListener("resize", layoutMask);

  function renderSource(slot) {
    const item = state[slot];
    const name = qs("#v2-repair-name-" + slot);
    const length = qs("#v2-repair-duration-" + slot);
    const thumb = qs("#v2-repair-thumb-" + slot);
    const empty = qs("#v2-repair-empty-" + slot);
    name.textContent = item?.title || "Не выбрано";
    length.textContent = item ? fmt(duration(item)) + " · " + (W.mediaResolution(item) || "—") : slot === "a" ? "Начальный ролик" : "Второй ролик";
    thumb.hidden = !item;
    empty.hidden = !!item;
    if (item) thumb.src = thumbnailUrl(item);
    else thumb.removeAttribute("src");
    if (slot === "a") renderSpliceResolution();
  }

  function setPreview(slot, seconds = 0) {
    const item = state[slot];
    if (!item) return;
    const different = state.previewSlot !== slot || player.dataset.mediaId !== String(item.id);
    state.previewSlot = slot;
    if (different) {
      player.pause();
      player.src = sourceUrl(item);
      player.dataset.mediaId = String(item.id);
      player.load();
    }
    if (state.mode === "object") layoutMask();
    const seek = () => {
      if (!Number.isFinite(player.duration) || player.duration <= 0) return;
      player.currentTime = clamp(seconds, 0, Math.max(0, player.duration - .001));
      updateTime();
    };
    if (player.readyState >= 1) seek();
    else player.addEventListener("loadedmetadata", seek, { once: true });
  }

  function setSource(slot, item) {
    state[slot] = item;
    renderSource(slot);
    if (slot === "a") {
      const length = duration(item);
      state.start = 0;
      state.end = Math.min(length, Math.max(.1, roundFrame(Math.min(2, length / 2))));
      clearMask();
      setPreview("a", 0);
    } else if (isSplice()) {
      setPreview("b", 0);
    }
    renderTimeline();
    renderControls();
  }

  W.prepareRepairMedia = (item) => {
    if (!item) return;
    setSource("a", item);
    setMode("fragment");
    api.setView("repair");
  };

  function setMode(mode) {
    if (!modes[mode]) return;
    state.mode = mode;
    qsa("[data-repair-mode]", root).forEach((button) => {
      const active = button.dataset.repairMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    qs("#v2-repair-source-b").hidden = !isSplice();
    qs("#v2-repair-splice-settings").hidden = !isSplice();
    qs("#v2-repair-sound-settings").hidden = mode !== "sound";
    qs("#v2-repair-generic-config").hidden = isSplice();
    qs("#v2-repair-splice-config").hidden = !isSplice();
    qs("#v2-repair-prompt").placeholder = modes[mode].placeholder;
    qs("#v2-repair-mask-tools").hidden = mode !== "object";
    mask.hidden = mode !== "object" || !state.a;
    qs("#v2-repair-range-row").hidden = isSplice();
    qs("#v2-repair-mark-start").hidden = isSplice();
    qs("#v2-repair-mark-end").hidden = isSplice();
    qs("#v2-repair-timeline-help").textContent = isSplice()
      ? "Фиолетовый участок между двумя видео — переход длительностью 1 сек"
      : "Перетащите границы или поставьте начало и конец на текущем кадре";
    const context = qs("#v2-repair-context");
    context.textContent = modes[mode].help;
    context.classList.toggle("warning", mode === "object");
    if (state.previewSlot === "b" && !isSplice()) setPreview("a", 0);
    layoutMask();
    renderTimeline();
    renderControls();
  }

  function renderControls() {
    const action = qs("#v2-repair-submit");
    action.textContent = modes[state.mode].action;
    action.disabled = state.submitting || state.uploading || !state.a || !currentPrompt() ||
      (state.mode === "object" && !state.maskDrawn) ||
      (isSplice() ? (!state.b || duration(state.a) <= 1.05 || duration(state.b) <= 1.05)
        : !(state.end >= state.start + .2 && state.end - state.start <= 15 && state.end <= duration(state.a) + .001));
    qs("#v2-repair-note").textContent = isSplice()
      ? "H3 изучит движение и звук по 0,5 сек с обеих сторон и создаст новую секунду. Результат будет готовым роликом в Библиотеке."
      : "MiniMax H3 создаст новую версию только выбранного участка. Оригинальный ролик сохраняется.";
    qs("#v2-repair-start").value = state.start.toFixed(3);
    qs("#v2-repair-end").value = state.end.toFixed(3);
    qs("#v2-repair-selected-length").textContent = fmt(state.end - state.start);
    qs("#v2-repair-monitor-empty").hidden = !!state.a;
  }

  function renderTimeline() {
    const ruler = qs("#v2-repair-ruler");
    const filmstrip = qs("#v2-repair-filmstrip");
    const selection = qs("#v2-repair-selection");
    if (!state.a || !duration(state.a)) {
      ruler.innerHTML = "";
      filmstrip.innerHTML = '<div class="v2-repair-film-empty">Выберите ролик для отображения дорожки</div>';
      selection.hidden = true;
      qs("#v2-repair-playhead").hidden = true;
      return;
    }
    const whole = total();
    const secondsStep = Math.max(1, Math.ceil(whole / 12));
    let tickHtml = "";
    for (let t = 0; t <= whole + .001; t += secondsStep) {
      tickHtml += '<div class="v2-repair-tick" style="left:' + (t / whole * 100) + '%"><span>' + W.formatSeconds(t) + '</span></div>';
    }
    ruler.innerHTML = tickHtml;
    const strip = (item, slot, width) => '<div class="v2-repair-strip" data-source-slot="' + slot + '" style="flex:0 0 ' + width.toFixed(4) + '%">' +
      Array.from({ length: 5 }, () => '<img alt="" loading="lazy" src="' + escapeHtml(thumbnailUrl(item)) + '">').join("") +
      '<strong>Видео ' + slot.toUpperCase() + '</strong></div>';
    if (isSplice() && state.b && duration(state.a) > 1 && duration(state.b) > 1) {
      const start = duration(state.a);
      filmstrip.innerHTML = strip(state.a, "a", duration(state.a) / whole * 100) +
        '<div class="v2-repair-gap" style="flex:0 0 ' + (1 / whole * 100) + '%"></div>' +
        strip(state.b, "b", duration(state.b) / whole * 100);
      filmstrip.insertAdjacentHTML("beforeend", '<div class="v2-repair-bridge" style="left:' + (start / whole * 100) + '%;width:' + (1 / whole * 100) + '%" title="Переход 1 сек">1 сек</div>');
    } else filmstrip.innerHTML = strip(state.a, "a", 100);
    selection.hidden = isSplice();
    if (!isSplice()) {
      selection.style.left = (state.start / whole * 100) + "%";
      selection.style.width = ((state.end - state.start) / whole * 100) + "%";
    }
    qs("#v2-repair-playhead").hidden = false;
    updateTime();
  }

  function updateTime() {
    const current = currentTimelineTime();
    const totalSeconds = total();
    qs("#v2-repair-time").textContent = fmt(current) + " / " + fmt(totalSeconds);
    const playhead = qs("#v2-repair-playhead");
    playhead.style.left = (clamp(current / totalSeconds, 0, 1) * 100) + "%";
    qs("#v2-repair-play").querySelector("span").textContent = player.paused ? "Пуск" : "Пауза";
  }

  function updateRange(edge, value) {
    const length = duration(state.a);
    if (!length) return;
    const minGap = Math.min(1 / FPS, length / 4);
    if (edge === "start") {
      state.start = clamp(roundFrame(value), 0, length - minGap);
      if (state.end <= state.start + minGap) state.end = clamp(state.start + minGap, minGap, length);
    } else {
      state.end = clamp(roundFrame(value), minGap, length);
      if (state.start >= state.end - minGap) state.start = clamp(state.end - minGap, 0, length - minGap);
    }
    renderTimeline();
    renderControls();
  }

  function timelineSeek(time) {
    const position = clamp(roundFrame(time), 0, total());
    if (isSplice() && state.b && position >= duration(state.a) + .5) {
      setPreview("b", Math.max(0, position - duration(state.a) - 1));
    } else setPreview("a", position);
  }

  function openPicker(slot) {
    state.pickerSlot = slot;
    qs("#v2-repair-picker-search").value = "";
    renderPicker();
    qs("#v2-repair-picker").showModal();
    W.refreshState({ silent: true, includeMedia: true }).then(renderPicker);
  }

  function renderPicker() {
    const grid = qs("#v2-repair-picker-grid");
    const query = qs("#v2-repair-picker-search").value.toLocaleLowerCase("ru-RU").trim();
    const items = W.allMedia.filter((item) => !query || String(item.title || "").toLocaleLowerCase("ru-RU").includes(query));
    grid.innerHTML = items.length ? items.map((item) =>
      '<button type="button" data-repair-media-id="' + escapeHtml(item.id) + '"><img loading="lazy" alt="" src="' + escapeHtml(thumbnailUrl(item)) + '"><strong>' + escapeHtml(item.title || "Видео") + '</strong><small>' + fmt(duration(item)) + '</small></button>'
    ).join("") : '<div class="v2-repair-picker-empty">Ролики не найдены</div>';
  }

  async function uploadFile(slot, file) {
    if (!file) return;
    state.uploading = true;
    renderControls();
    try {
      const form = new FormData();
      form.append("video", file);
      const response = await fetchJson("/api/repair/upload", { method: "POST", body: form });
      await W.refreshState({ silent: true, includeMedia: true });
      setSource(slot, response.media);
      showToast("Видео загружено в Библиотеку.");
    } catch (error) {
      showToast("Ошибка загрузки: " + error.message, "error");
    } finally {
      state.uploading = false;
      renderControls();
      qs("#v2-repair-file-" + slot).value = "";
    }
  }

  function renderGpuSlots(slots) {
    const targets = new Map((slots || []).map((item) => [String(item.target), item]));
    gpuButtons.forEach((button) => {
      const slot = targets.get(button.dataset.repairGpu);
      const available = !!slot?.available && !state.submitting;
      button.disabled = !available;
      button.classList.toggle("available", available);
      button.classList.toggle("busy", !available);
      button.querySelector("[data-repair-gpu-state]").textContent = slot
        ? String(slot.busy_label || (slot.available ? "Свободна" : "Занята")) : "Нет данных";
    });
  }

  async function refreshGpuSlots() {
    if (!gpuDialog.open) return;
    try {
      const result = await fetchJson("/api/v2/gpu-slots");
      renderGpuSlots(result?.slots || []);
    } catch { renderGpuSlots([]); }
  }

  function stopGpuPolling() {
    if (gpuTimer) clearInterval(gpuTimer);
    gpuTimer = null;
  }

  function closeGpuDialog() {
    stopGpuPolling();
    if (gpuDialog.open) gpuDialog.close();
  }

  async function submit(gpuTarget) {
    if (state.submitting || !state.a) return;
    state.submitting = true;
    renderControls();
    renderGpuSlots([]);
    try {
      await fetchJson("/api/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: state.mode, media_id: state.a.id, second_media_id: state.b?.id || null,
          start: state.start, end: state.end,
          prompt: currentPrompt(),
          steps: Number(isSplice() ? state.splice.steps : qs("#v2-repair-steps").value),
          seed: isSplice() ? qs("#v2-repair-splice-seed").value : qs("#v2-repair-seed").value,
          quality: state.splice.quality,
          ratio: state.splice.ratio,
          generate_audio: qs("#v2-repair-splice-audio").checked,
          sound_type: qs("#v2-repair-sound-type").value,
          gpu_target: gpuTarget,
          mask_png: state.mode === "object" ? exportMask() : "",
        }),
      });
      closeGpuDialog();
      await W.refreshState({ silent: true, includeMedia: true });
      api.setView("library");
      showToast("AI-исправление запущено на " + (gpuTarget === "rtx2080" ? "RTX2080" : "RTX3090") + ". Смотрите статус в Библиотеке.");
    } catch (error) {
      showToast("Не удалось запустить: " + error.message, "error");
    } finally {
      state.submitting = false;
      renderControls();
      if (gpuDialog.open) refreshGpuSlots();
    }
  }

  qsa("[data-repair-mode]", root).forEach((button) => button.addEventListener("click", () => setMode(button.dataset.repairMode)));
  qsa("[data-repair-select]", root).forEach((button) => button.addEventListener("click", () => openPicker(button.dataset.repairSelect)));
  qsa("[data-repair-upload]", root).forEach((button) => button.addEventListener("click", () => qs("#v2-repair-file-" + button.dataset.repairUpload).click()));
  ["a", "b"].forEach((slot) => qs("#v2-repair-file-" + slot).addEventListener("change", (event) => uploadFile(slot, event.target.files?.[0])));
  qs("#v2-repair-picker-close").addEventListener("click", () => qs("#v2-repair-picker").close());
  qs("#v2-repair-picker-search").addEventListener("input", renderPicker);
  qs("#v2-repair-picker-grid").addEventListener("click", (event) => {
    const card = event.target.closest("[data-repair-media-id]");
    const item = card && W.mediaById(card.dataset.repairMediaId);
    if (!item) return;
    setSource(state.pickerSlot, item);
    qs("#v2-repair-picker").close();
  });
  player.addEventListener("timeupdate", updateTime);
  player.addEventListener("play", updateTime);
  player.addEventListener("pause", updateTime);
  player.addEventListener("loadedmetadata", () => {
    if (state.previewSlot === "a" && state.a && !duration(state.a) && player.duration) {
      state.a.duration = player.duration;
      state.end = Math.min(2, player.duration);
      renderTimeline();
    }
    layoutMask();
    updateTime();
  });
  qs("#v2-repair-play").addEventListener("click", () => {
    if (!state.a) return;
    if (player.paused) player.play().catch(() => showToast("Не удалось воспроизвести видео.", "error"));
    else player.pause();
  });
  const step = (delta) => {
    if (!state.a) return;
    player.pause();
    timelineSeek(currentTimelineTime() + delta / FPS);
  };
  qs("#v2-repair-back").addEventListener("click", () => step(-1));
  qs("#v2-repair-forward").addEventListener("click", () => step(1));
  qs("#v2-repair-mark-start").addEventListener("click", () => updateRange("start", player.currentTime));
  qs("#v2-repair-mark-end").addEventListener("click", () => updateRange("end", player.currentTime));
  ["start", "end"].forEach((edge) => qs("#v2-repair-" + edge).addEventListener("change", (event) => updateRange(edge, Number(event.target.value))));

  const timeline = qs("#v2-repair-timeline");
  const percentOfPointer = (event) => {
    const bounds = timeline.getBoundingClientRect();
    return clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  };
  timeline.addEventListener("pointerdown", (event) => {
    if (!state.a || !duration(state.a)) return;
    const handle = event.target.closest("[data-repair-handle]");
    if (handle && !isSplice()) {
      state.dragging = handle.dataset.repairHandle;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    } else timelineSeek(percentOfPointer(event) * total());
  });
  timeline.addEventListener("pointermove", (event) => {
    if (state.dragging) updateRange(state.dragging, percentOfPointer(event) * duration(state.a));
  });
  timeline.addEventListener("pointerup", () => { state.dragging = null; });
  timeline.addEventListener("pointercancel", () => { state.dragging = null; });
  window.addEventListener("keydown", (event) => {
    if (api.state.view !== "repair" || !state.a || event.target.closest("input,textarea,select,button,[contenteditable]")) return;
    if (["Space", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
    if (event.code === "Space") qs("#v2-repair-play").click();
    if (event.code === "ArrowLeft") step(-1);
    if (event.code === "ArrowRight") step(1);
  });
  qs("#v2-repair-prompt").addEventListener("input", renderControls);
  try { qs("#v2-repair-splice-prompt").value = localStorage.getItem(splicePromptKey) || defaultSplicePrompt; }
  catch { qs("#v2-repair-splice-prompt").value = defaultSplicePrompt; }
  qs("#v2-repair-splice-prompt").addEventListener("input", () => {
    try { localStorage.setItem(splicePromptKey, qs("#v2-repair-splice-prompt").value); } catch { /* storage can be blocked */ }
    renderControls();
  });
  qs("#v2-repair-splice-prompt-reset").addEventListener("click", () => {
    qs("#v2-repair-splice-prompt").value = defaultSplicePrompt;
    try { localStorage.removeItem(splicePromptKey); } catch { /* storage can be blocked */ }
    renderControls();
  });
  qsa("[data-repair-splice-setting] button", root).forEach((button) => button.addEventListener("click", () => {
    const group = button.closest("[data-repair-splice-setting]");
    state.splice[group.dataset.repairSpliceSetting] = button.dataset.value;
    qsa("button", group).forEach((option) => {
      const active = option === button;
      option.classList.toggle("active", active);
      option.setAttribute("aria-pressed", String(active));
    });
    renderSpliceResolution();
  }));
  qs("#v2-repair-submit").addEventListener("click", async () => {
    if (qs("#v2-repair-submit").disabled) return;
    renderGpuSlots([]);
    gpuDialog.showModal();
    await refreshGpuSlots();
    stopGpuPolling();
    gpuTimer = setInterval(refreshGpuSlots, 1000);
  });
  gpuButtons.forEach((button) => button.addEventListener("click", () => {
    if (!button.disabled) submit(button.dataset.repairGpu);
  }));
  qs("#v2-repair-gpu-close").addEventListener("click", closeGpuDialog);
  gpuDialog.addEventListener("close", stopGpuPolling);
  gpuDialog.addEventListener("cancel", stopGpuPolling);
  window.addEventListener("v2:datarefresh", () => {
    if (qs("#v2-repair-picker").open) renderPicker();
  });
  setMode("fragment");
})();
