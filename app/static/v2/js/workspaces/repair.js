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
    fragment: { action: "Удалить фрагмент", help: "Удаление выделенного участка без новой генерации. Остальные кадры будут соединены через FFmpeg.", prompt: false },
    object: { action: "AI-исправление недоступно", help: "H3 Ref2VA создаёт новый ролик по референсу, но не умеет гарантированно заменять только один объект в готовых кадрах. Точное AI-исправление пока не подключено.", prompt: true, unsupported: true },
    motion: { action: "AI-исправление недоступно", help: "Точная правка движения с сохранением всех остальных кадров не поддержана текущим H3-пайплайном. Режим оставлен для будущей интеграции.", prompt: true, unsupported: true },
    sound: { action: "Исправить звук", help: "Изменение громкости звука только внутри выделенного участка. Видео остаётся без изменения изображения.", prompt: false },
    splice: { action: "Создать переход", help: "Реальный 1-секундный видеопереход и плавное смешивание звука через FFmpeg. Это монтаж, а не AI-дорисовка промежуточных кадров.", prompt: false },
  };
  const FPS = 24;
  const state = { mode: "fragment", a: null, b: null, pickerSlot: "a", start: 0, end: 0, previewSlot: "a", dragging: null, uploading: false, submitting: false };
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
  const total = () => isSplice() && state.a && state.b
    ? Math.max(.01, duration(state.a) + duration(state.b) - 1)
    : Math.max(.01, duration(state.a));
  const currentTimelineTime = () => state.previewSlot === "b" && isSplice() && state.a
    ? Math.max(0, duration(state.a) - 1) + (player.currentTime || 0)
    : player.currentTime || 0;

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
    qs("#v2-repair-prompt-field").hidden = !modes[mode].prompt;
    qs("#v2-repair-range-row").hidden = isSplice();
    qs("#v2-repair-mark-start").hidden = isSplice();
    qs("#v2-repair-mark-end").hidden = isSplice();
    qs("#v2-repair-timeline-help").textContent = isSplice()
      ? "Фиолетовый участок между двумя видео — переход длительностью 1 сек"
      : "Перетащите границы или поставьте начало и конец на текущем кадре";
    const context = qs("#v2-repair-context");
    context.textContent = modes[mode].help;
    context.classList.toggle("warning", !!modes[mode].unsupported);
    if (state.previewSlot === "b" && !isSplice()) setPreview("a", 0);
    renderTimeline();
    renderControls();
  }

  function renderControls() {
    const action = qs("#v2-repair-submit");
    action.textContent = modes[state.mode].action;
    action.disabled = state.submitting || state.uploading || !state.a || !!modes[state.mode].unsupported ||
      (isSplice() ? (!state.b || duration(state.a) <= 1.05 || duration(state.b) <= 1.05)
        : !(state.end > state.start + .04 && state.end <= duration(state.a) + .001 && (state.mode !== "fragment" || state.end - state.start < duration(state.a) - .04)));
    qs("#v2-repair-note").textContent = modes[state.mode].unsupported
      ? "AI-правка недоступна: кнопка запуска заблокирована, чтобы не тратить время GPU на неподходящий workflow."
      : isSplice() ? "Склейка через FFmpeg, с переходом ровно 1 сек. Результат сохранится отдельным роликом в Библиотеке."
        : "Исходник не меняется. Результат появится в Библиотеке как новый ролик.";
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
      const start = duration(state.a) - 1;
      filmstrip.innerHTML = strip(state.a, "a", duration(state.a) / whole * 100) +
        strip(state.b, "b", (duration(state.b) - 1) / whole * 100);
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
    if (isSplice() && state.b && position >= duration(state.a) - 1) {
      setPreview("b", position - (duration(state.a) - 1));
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

  async function submit() {
    const button = qs("#v2-repair-submit");
    if (button.disabled || state.submitting) return;
    const mode = state.mode;
    if (!window.confirm(mode === "fragment" ? "Удалить выбранный фрагмент из новой копии видео?" :
      mode === "sound" ? "Создать новую версию с изменённым звуком?" : "Соединить два видео с переходом в 1 секунду?")) return;
    state.submitting = true;
    renderControls();
    try {
      await fetchJson("/api/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode, media_id: state.a.id, second_media_id: state.b?.id || null,
          start: state.start, end: state.end,
          volume: Number(qs("#v2-repair-volume").value),
          transition: qs("#v2-repair-transition").value,
        }),
      });
      await W.refreshState({ silent: true, includeMedia: true });
      api.setView("library");
      showToast("Исправление добавлено в Библиотеку.");
    } catch (error) {
      showToast("Не удалось запустить: " + error.message, "error");
    } finally {
      state.submitting = false;
      renderControls();
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
  qs("#v2-repair-submit").addEventListener("click", submit);
  window.addEventListener("v2:datarefresh", () => {
    if (qs("#v2-repair-picker").open) renderPicker();
  });
  setMode("fragment");
})();
