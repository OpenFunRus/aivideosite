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
    splice: { action: "Сгенерировать склейку", help: "Выберите конец сохраняемой части A и начало сохраняемой части B. H3 увидит до 0,5 сек движения и звука с каждой стороны и создаст переход нужной длины без речи.", placeholder: "Опишите естественный переход между видео…" },
  };
  const defaultSplicePrompt = [
    "integrated_multimodal_description: [Shot 1] Generate one continuous cinematic transition between the two anchored motion clips. The opening guide is the actual movement immediately before the user-selected cut of video A. The closing guide is the actual movement immediately after the user-selected entry point in video B. Use both guides as strong temporal and visual anchors. Independently choose the most natural way to move between their positions, compositions and actions within the available middle interval: a physically plausible camera move, matched subject motion, natural foreground occlusion, or a motivated whip pan when truly appropriate. Keep the same characters, clothing, objects, proportions, location geometry, lighting, exposure and camera trajectories whenever plausible. Smoothly arrive at the opening frame of B. Do not invent unrelated characters or props. Absolutely NO speaking, NO lip movements suggesting speech, NO dialogue, NO vocals, NO narration, NO singing, NO whispers, NO words, NO muttering, and NO intelligible voice sounds anywhere in the generated transition. All characters remain silent. Avoid cuts to black, artificial wipe graphics, hard cuts, jitter, melting textures and abrupt camera changes.",
    "overall_soundscape: Only natural non-vocal environmental ambience and diegetic sound effects; maintain a smooth acoustic transition from the first guide to the second. NO speech, NO human or animal voices, NO singing, NO whispers, NO chants, NO breathing or vocalized grunts; silence is preferable to any invented voice. No sudden volume changes.",
    "non_diegetic_music: N/A",
    "speech_policy: silent",
  ].join("\n\n");
  const splicePromptKey = "aivideosite.repair.splice.prompt.v2";
  const FPS = 24;
  const state = { mode: "fragment", a: null, b: null, pickerSlot: "a", start: 0, end: 0, cutA: 0, cutB: 0, previewSlot: "a", dragging: null, uploading: false, submitting: false, maskDrawn: false, splice: { quality: "480", ratio: "auto", steps: "8", seconds: 1 } };
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
  const bridgeSeconds = () => Number(state.splice.seconds) || 1;
  const spliceOutputDuration = () => Math.max(0, state.cutA) + bridgeSeconds() + Math.max(0, duration(state.b) - state.cutB);
  const h3SpliceSeconds = () => {
    const frames = Math.max(2, Math.round(bridgeSeconds() * FPS));
    return (5 + 17 * Math.ceil((Math.max(124, 44 + frames) - 5) / 17)) / FPS;
  };
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
    ? Math.max(.01, duration(state.a) + duration(state.b) + bridgeSeconds())
    : Math.max(.01, duration(state.a));
  const currentTimelineTime = () => state.previewSlot === "b" && isSplice() && state.a
    ? Math.max(0, duration(state.a) + bridgeSeconds()) + (player.currentTime || 0)
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
      state.cutA = length;
      clearMask();
      setPreview("a", 0);
    } else {
      state.cutB = 0;
      if (isSplice()) setPreview("b", 0);
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
    qs("#v2-repair-splice-range-row").hidden = !isSplice();
    qs("#v2-repair-mark-start").textContent = isSplice() ? "Начало перехода · A" : "Начало";
    qs("#v2-repair-mark-end").textContent = isSplice() ? "Конец перехода · B" : "Конец";
    qs("#v2-repair-timeline-help").textContent = isSplice()
      ? "Перетащите фиолетовые границы: конец A и начало B. Серое будет отрезано."
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
    const cutValid = state.a && state.b && state.cutA >= .1 && state.cutA <= duration(state.a) + .001 &&
      state.cutB >= 0 && state.cutB <= duration(state.b) - .1 + .001;
    action.disabled = state.submitting || state.uploading || !state.a || !currentPrompt() ||
      (state.mode === "object" && !state.maskDrawn) ||
      (isSplice() ? (!cutValid || !Number.isFinite(state.splice.seconds) || state.splice.seconds < .1 || state.splice.seconds > 15)
        : !(state.end >= state.start + .2 && state.end - state.start <= 15 && state.end <= duration(state.a) + .001));
    qs("#v2-repair-note").textContent = isSplice()
      ? "Останутся A до " + fmt(state.cutA) + " и B после " + fmt(state.cutB) + ". Между ними H3 создаст переход " + bridgeSeconds().toFixed(1) + " сек без речи."
      : "MiniMax H3 создаст новую версию только выбранного участка. Оригинальный ролик сохраняется.";
    qs("#v2-repair-start").value = state.start.toFixed(3);
    qs("#v2-repair-end").value = state.end.toFixed(3);
    qs("#v2-repair-selected-length").textContent = fmt(state.end - state.start);
    qs("#v2-repair-splice-cut-a").value = state.cutA.toFixed(3);
    qs("#v2-repair-splice-cut-b").value = state.cutB.toFixed(3);
    qs("#v2-repair-splice-cut-a-label").textContent = fmt(state.cutA);
    qs("#v2-repair-splice-cut-b-label").textContent = fmt(state.cutB);
    qs("#v2-repair-splice-output-duration").textContent = state.a && state.b ? "Итог: " + fmt(spliceOutputDuration()) : "Итог: —";
    qs("#v2-repair-bridge-duration-label").textContent = "MiniMax H3 · " + bridgeSeconds().toFixed(1) + " сек";
    qs("#v2-repair-h3-duration").textContent = "H3 просчитает ~" + h3SpliceSeconds().toFixed(2) + " сек на 24 FPS";
    qs("#v2-repair-splice-caution").textContent = h3SpliceSeconds() > 15
      ? "Внимание: H3 потребуется ~" + h3SpliceSeconds().toFixed(1) + " сек с опорными клипами — больше обученного диапазона 15 сек. Возможны нехватка VRAM и ухудшение качества; начните с 480p."
      : "Рекомендуем 480p / 8 шагов для проверки. Переход округляется до ближайшего кадра при 24 FPS. Длительные сцены и 1080p требуют значительно больше VRAM.";
    qs("#v2-repair-mark-start").disabled = isSplice() && (!state.a || state.previewSlot !== "a");
    qs("#v2-repair-mark-end").disabled = isSplice() && (!state.b || state.previewSlot !== "b");
    qs("#v2-repair-monitor-empty").hidden = !!state.a;
  }

  function renderTimeline() {
    const ruler = qs("#v2-repair-ruler");
    const filmstrip = qs("#v2-repair-filmstrip");
    const selection = qs("#v2-repair-selection");
    qsa(".v2-repair-bridge,.v2-repair-trimmed,.v2-repair-cut-handle", qs("#v2-repair-timeline")).forEach((node) => node.remove());
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
    if (isSplice() && state.b && duration(state.a) >= .1 && duration(state.b) >= .1) {
      const lengthA = duration(state.a), lengthB = duration(state.b), bridge = bridgeSeconds();
      const pct = (seconds) => (seconds / whole * 100).toFixed(5) + "%";
      filmstrip.innerHTML = strip(state.a, "a", lengthA / whole * 100) +
        '<div class="v2-repair-gap" style="flex:0 0 ' + pct(bridge) + '"></div>' +
        strip(state.b, "b", lengthB / whole * 100);
      let overlay = '<div class="v2-repair-bridge" style="left:' + pct(lengthA) + ';width:' + pct(bridge) + '" title="Нейросетевой переход">' + bridge.toFixed(1) + ' сек</div>';
      if (lengthA - state.cutA > .015) overlay += '<div class="v2-repair-trimmed" style="left:' + pct(state.cutA) + ';width:' + pct(lengthA - state.cutA) + '"><span>Будет удалено</span></div>';
      if (state.cutB > .015) overlay += '<div class="v2-repair-trimmed" style="left:' + pct(lengthA + bridge) + ';width:' + pct(state.cutB) + '"><span>Будет удалено</span></div>';
      overlay += '<button class="v2-repair-cut-handle" type="button" data-repair-cut-edge="a" style="left:' + pct(state.cutA) + '" title="Тянуть: начало перехода / конец A" aria-label="Граница конца видео A"></button>' +
        '<button class="v2-repair-cut-handle" type="button" data-repair-cut-edge="b" style="left:' + pct(lengthA + bridge + state.cutB) + '" title="Тянуть: конец перехода / начало B" aria-label="Граница начала видео B"></button>';
      filmstrip.insertAdjacentHTML("afterend", overlay);
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
    if (isSplice()) {
      qs("#v2-repair-mark-start").disabled = !state.a || state.previewSlot !== "a";
      qs("#v2-repair-mark-end").disabled = !state.b || state.previewSlot !== "b";
    }
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
    if (isSplice() && state.b && position >= duration(state.a) + bridgeSeconds() / 2) {
      setPreview("b", Math.max(0, position - duration(state.a) - bridgeSeconds()));
    } else setPreview("a", position);
  }

  function updateSpliceCut(edge, rawValue) {
    if (!state.a || (edge === "b" && !state.b) || !Number.isFinite(rawValue)) return;
    const value = roundFrame(rawValue);
    if (edge === "a") state.cutA = clamp(value, .1, duration(state.a));
    else state.cutB = clamp(value, 0, Math.max(0, duration(state.b) - .1));
    renderTimeline();
    renderControls();
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
          start: isSplice() ? state.cutA : state.start,
          end: isSplice() ? state.cutB : state.end,
          transition_seconds: bridgeSeconds(),
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
  qsa("[data-repair-preview]", root).forEach((button) => button.addEventListener("click", () => {
    const slot = button.dataset.repairPreview;
    if (!state[slot]) return;
    setPreview(slot, slot === "a" ? state.cutA : state.cutB);
    renderControls();
  }));
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
  qs("#v2-repair-mark-start").addEventListener("click", () => {
    if (isSplice()) updateSpliceCut("a", player.currentTime);
    else updateRange("start", player.currentTime);
  });
  qs("#v2-repair-mark-end").addEventListener("click", () => {
    if (isSplice()) updateSpliceCut("b", player.currentTime);
    else updateRange("end", player.currentTime);
  });
  ["start", "end"].forEach((edge) => qs("#v2-repair-" + edge).addEventListener("change", (event) => updateRange(edge, Number(event.target.value))));
  [["a", "cut-a"], ["b", "cut-b"]].forEach(([edge, id]) => {
    qs("#v2-repair-splice-" + id).addEventListener("change", (event) => updateSpliceCut(edge, Number(event.target.value)));
  });
  qs("#v2-repair-transition-seconds").addEventListener("change", (event) => {
    const parsed = Number(String(event.target.value).replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= .1 && parsed <= 15) {
      state.splice.seconds = Math.round(parsed * 10) / 10;
      renderTimeline();
    } else showToast("Укажите длительность перехода от 0,1 до 15 секунд.", "error");
    event.target.value = state.splice.seconds.toFixed(1);
    renderControls();
  });

  const timeline = qs("#v2-repair-timeline");
  const percentOfPointer = (event) => {
    const bounds = timeline.getBoundingClientRect();
    return clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  };
  timeline.addEventListener("pointerdown", (event) => {
    if (!state.a || !duration(state.a)) return;
    const cutHandle = event.target.closest("[data-repair-cut-edge]");
    if (isSplice() && cutHandle) {
      state.dragging = "cut:" + cutHandle.dataset.repairCutEdge;
      timeline.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const handle = event.target.closest("[data-repair-handle]");
    if (handle && !isSplice()) {
      state.dragging = handle.dataset.repairHandle;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    } else timelineSeek(percentOfPointer(event) * total());
  });
  timeline.addEventListener("pointermove", (event) => {
    if (state.dragging?.startsWith("cut:")) {
      const edge = state.dragging.split(":")[1];
      const value = percentOfPointer(event) * total();
      updateSpliceCut(edge, edge === "a" ? value : value - duration(state.a) - bridgeSeconds());
    } else if (state.dragging) updateRange(state.dragging, percentOfPointer(event) * duration(state.a));
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
