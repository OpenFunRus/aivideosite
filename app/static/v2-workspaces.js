(() => {
  "use strict";

  const api = window.AIVideoV2;
  if (!api) return;

  const { qs, qsa, fetchJson, showToast, escapeHtml, setView } = api;
  const app = qs(".v2-app");
  const userId = api.userId || app?.dataset.userId || "user";
  const CHAT_KEY = "aivideosite-" + userId + "-v2-chat";
  const EDITOR_KEY = "aivideosite-" + userId + "-v2-editor";

  let snapshot = null;
  let allMedia = [];
  let refreshing = null;
  const objectUrls = new Map();
  let chatMessages = loadJson(CHAT_KEY, []);
  let chatBusy = false;
  let editorState = loadJson(EDITOR_KEY, { title: "Монтаж V2", clips: [] });
  if (!Array.isArray(editorState.clips)) editorState.clips = [];
  let editorSelected = -1;
  let editorDragIndex = -1;
  let editorAudioFile = null;
  let libraryLimit = 40;

  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "");
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode/storage denial should not break the workspace.
    }
  }

  function setObjectUrl(key, file) {
    const old = objectUrls.get(key);
    if (old) URL.revokeObjectURL(old);
    objectUrls.delete(key);
    if (!file) return "";
    const url = URL.createObjectURL(file);
    objectUrls.set(key, url);
    return url;
  }

  function formatSeconds(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
  }

  function formatBytes(value) {
    let bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit += 1;
    }
    return bytes.toFixed(unit >= 3 ? 1 : 0) + " " + units[unit];
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function elapsed(start, endSeconds) {
    if (!start) return "—";
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) return "—";
    const endMs = endSeconds ? Number(endSeconds) * 1000 : Date.now();
    return formatSeconds(Math.max(0, (endMs - startMs) / 1000));
  }

  function mediaById(id) {
    return allMedia.find((item) => String(item.id) === String(id)) || null;
  }

  function selectedCharacterIds() {
    return Array.from(api.state.selectedCharacterIds || []).map(String);
  }

  function settingValue(name, fallback = "") {
    const group = qs('[data-v2-setting="' + name + '"]');
    return qs("button.active", group)?.dataset.value || fallback;
  }

  qsa("[data-v2-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      qsa("[data-value]", group).forEach((item) => item.classList.toggle("active", item === button));
      updateClipRange();
    });
  });

  async function refreshState({ silent = false, includeMedia = true } = {}) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const statePromise = fetchJson("/api/v2/state?media_page=1&jobs_page=1");
        const mediaPromise =
          includeMedia || !allMedia.length
            ? fetchJson("/api/editor/media")
            : Promise.resolve({ items: allMedia });
        const [stateData, mediaData] = await Promise.all([statePromise, mediaPromise]);
        snapshot = stateData;
        allMedia = Array.isArray(mediaData.items) ? mediaData.items : allMedia;
        populateMediaSelectors();
        renderLibrary();
        renderQueue();
        renderSystem();
        renderEditorLibrary();
        reconcileEditorClips();
        return stateData;
      } catch (error) {
        if (!silent) showToast("Не удалось обновить V2: " + error.message, "error");
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function populateSelect(select, placeholder) {
    if (!select) return;
    const current = select.value;
    select.innerHTML =
      '<option value="">' + escapeHtml(placeholder) + "</option>" +
      allMedia
        .map(
          (item) =>
            '<option value="' +
            escapeHtml(item.id) +
            '">' +
            escapeHtml(item.title || item.filename || item.id) +
            "</option>"
        )
        .join("");
    if (allMedia.some((item) => String(item.id) === current)) select.value = current;
  }

  function populateMediaSelectors() {
    populateSelect(qs("#v2-continue-library"), "Выберите ролик…");
    populateSelect(qs("#v2-clip-library"), "Выберите ролик…");
  }

  function mediaResolution(item) {
    const meta = item?.meta || {};
    const width = Number(meta.width);
    const height = Number(meta.height);
    return width && height ? width + "×" + height : "—";
  }

  function mediaPrompt(item) {
    const meta = item?.meta || {};
    return String(meta.user_prompt || meta.prompt || "");
  }

  /* Library */
  function renderLibrary() {
    const grid = qs("#v2-library-grid");
    const empty = qs("#v2-library-empty");
    const count = qs("#v2-library-count");
    if (!grid) return;
    if (count) count.textContent = allMedia.length + " роликов";
    empty && (empty.hidden = allMedia.length > 0);
    const visibleMedia = allMedia.slice(0, libraryLimit);
    const more = qs("#v2-library-more");
    if (more) more.hidden = visibleMedia.length >= allMedia.length;
    grid.innerHTML = visibleMedia
      .map((item) => {
        const meta = item.meta || {};
        const duration = Number(item.duration || meta.seconds || 0);
        const kind = meta.v2_context?.workspace || meta.operation || item.kind || "video";
        return (
          '<article class="v2-media-card" data-media-id="' + escapeHtml(item.id) + '">' +
          '<video src="/media/' + encodeURIComponent(item.id) + '" preload="metadata" muted playsinline></video>' +
          '<div class="v2-media-card-body">' +
          "<h3>" + escapeHtml(item.title || "Видео") + "</h3>" +
          '<div class="v2-media-meta"><span>' + escapeHtml(formatDate(item.created_at)) + "</span>" +
          "<span>" + escapeHtml(duration ? formatSeconds(duration) : "—") + "</span>" +
          "<span>" + escapeHtml(mediaResolution(item)) + "</span>" +
          "<span>" + escapeHtml(kind) + "</span></div>" +
          '<div class="v2-media-actions">' +
          '<button type="button" data-library-action="open"><svg class="icon"><use href="/static/icons.svg#icon-player-play"></use></svg>Открыть</button>' +
          '<a href="/media/' + encodeURIComponent(item.id) + '?download=1"><svg class="icon"><use href="/static/icons.svg#icon-download"></use></svg>Скачать</a>' +
          '<button type="button" data-library-action="continue">Продолжить</button>' +
          '<button type="button" data-library-action="clip">След. клип</button>' +
          '<button type="button" data-library-action="editor"><svg class="icon"><use href="/static/icons.svg#icon-scissors"></use></svg>Монтаж</button>' +
          '<button class="danger" type="button" data-library-action="delete"><svg class="icon"><use href="/static/icons.svg#icon-trash"></use></svg></button>' +
          "</div></div></article>"
        );
      })
      .join("");
  }

  qs("#v2-library-refresh")?.addEventListener("click", () => {
    libraryLimit = 40;
    refreshState();
  });
  qs("#v2-library-more")?.addEventListener("click", () => {
    libraryLimit += 40;
    renderLibrary();
  });

  qs("#v2-library-grid")?.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-library-action]");
    if (!actionButton) return;
    const card = actionButton.closest("[data-media-id]");
    const item = mediaById(card?.dataset.mediaId);
    if (!item) return;
    const action = actionButton.dataset.libraryAction;
    if (action === "open") {
      openMediaDialog(item);
    } else if (action === "continue") {
      const select = qs("#v2-continue-library");
      if (select) select.value = item.id;
      applyLibrarySource("continue", item);
      setView("continue");
    } else if (action === "clip") {
      const select = qs("#v2-clip-library");
      if (select) select.value = item.id;
      applyLibrarySource("clip", item);
      const nextStart = Number(item.meta?.v2_context?.audio_end);
      if (Number.isFinite(nextStart) && nextStart >= 0) {
        const input = qs("#v2-clip-audio-start");
        if (input) input.value = String(nextStart);
        updateClipRange();
      }
      setView("clip");
    } else if (action === "editor") {
      addEditorClip(item);
      setView("editor");
    } else if (action === "delete") {
      if (!confirm("Удалить этот ролик из Библиотеки?")) return;
      actionButton.disabled = true;
      try {
        await fetchJson("/api/media/" + encodeURIComponent(item.id), { method: "DELETE" });
        showToast("Ролик удалён.");
        await refreshState({ silent: true });
      } catch (error) {
        showToast("Не удалось удалить: " + error.message, "error");
      }
    }
  });

  function openMediaDialog(item) {
    const dialog = qs("#v2-media-dialog");
    if (!dialog) return;
    const meta = item.meta || {};
    const prompt = mediaPrompt(item) || "Prompt не сохранён";
    dialog.innerHTML =
      '<div class="v2-media-dialog-inner">' +
      '<div class="v2-media-dialog-head"><h3>' + escapeHtml(item.title || "Видео") + '</h3><button class="v2-icon-button" type="button" data-media-dialog-close><svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>' +
      '<video src="/media/' + encodeURIComponent(item.id) + '" controls autoplay playsinline></video>' +
      '<div class="v2-media-detail-grid">' +
      detailCell("Дата", formatDate(item.created_at)) +
      detailCell("Размер", mediaResolution(item)) +
      detailCell("Длительность", formatSeconds(item.duration || meta.seconds || 0)) +
      detailCell("Seed", meta.seed ?? "—") +
      detailCell("Шаги", meta.steps ?? "—") +
      detailCell("GPU", meta.gpu_backend || "—") +
      detailCell("Режим", meta.generation_mode || meta.operation || item.kind || "—") +
      detailCell("Звук", meta.generate_audio === false ? "Нет" : "Да") +
      "</div>" +
      '<div class="v2-media-detail-prompt"><span>Prompt</span><p>' + escapeHtml(prompt) + "</p></div>" +
      '<div class="v2-media-actions">' +
      '<button type="button" data-dialog-continue>Продолжить</button>' +
      '<button type="button" data-dialog-editor>В монтаж</button>' +
      '<button type="button" data-dialog-copy><svg class="icon"><use href="/static/icons.svg#icon-copy"></use></svg>Копировать prompt</button>' +
      '<a href="/media/' + encodeURIComponent(item.id) + '?download=1">Скачать</a>' +
      "</div></div>";
    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    qs("[data-dialog-continue]", dialog)?.addEventListener("click", () => {
      dialog.close();
      const select = qs("#v2-continue-library");
      if (select) select.value = item.id;
      applyLibrarySource("continue", item);
      setView("continue");
    });
    qs("[data-dialog-editor]", dialog)?.addEventListener("click", () => {
      dialog.close();
      addEditorClip(item);
      setView("editor");
    });
    qs("[data-dialog-copy]", dialog)?.addEventListener("click", async () => {
      try {
        await api.copyText(prompt);
        showToast("Prompt скопирован.");
      } catch {
        showToast("Не удалось скопировать prompt.", "error");
      }
    });
    dialog.showModal();
  }

  function detailCell(label, value) {
    return "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";
  }

  qs("#v2-media-dialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  /* Queue */
  function gpuJob(index) {
    const label = index === 0 ? "RTX3090" : index === 1 ? "RTX2080" : "GPU " + index;
    return (snapshot?.active_global || []).find(
      (job) =>
        job.status === "running" &&
        String(job.stage || "").toLowerCase().includes(label.toLowerCase())
    );
  }

  function renderQueue() {
    const gpuRoot = qs("#v2-queue-gpus");
    const jobsRoot = qs("#v2-job-list");
    if (!gpuRoot || !jobsRoot || !snapshot) return;
    const gpus = snapshot.system?.gpus || [];
    gpuRoot.innerHTML = [0, 1]
      .map((index) => {
        const gpu = gpus.find((item) => Number(item.index) === index);
        const active = gpuJob(index);
        const name = gpu?.name || (index === 0 ? "RTX3090" : "RTX2080");
        return (
          '<article class="v2-queue-gpu' + (active ? " busy" : "") + '">' +
          '<div class="v2-queue-gpu-head"><h3>' + escapeHtml(name) + '</h3><span class="v2-queue-gpu-status">' + (active ? "Занята" : "Свободна") + "</span></div>" +
          '<div class="v2-queue-gpu-metrics"><span>VRAM ' + escapeHtml(gpu ? (gpu.memory_used_mb / 1024).toFixed(1) + "/" + (gpu.memory_total_mb / 1024).toFixed(0) + "GB" : "—") + "</span><span>GPU " + escapeHtml(gpu ? gpu.utilization + "%" : "—") + "</span><span>" + escapeHtml(gpu ? gpu.temperature + "°C" : "—") + "</span></div>" +
          (active
            ? '<div class="v2-queue-gpu-job"><strong>' + escapeHtml(active.user_label || active.owner_id) + "</strong><br>" + escapeHtml(active.prompt || active.stage || "H3 generation") + "</div>"
            : '<div class="v2-queue-gpu-job">Готова принять следующую H3-задачу.</div>') +
          "</article>"
        );
      })
      .join("");

    const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
    qs("#v2-queue-empty") && (qs("#v2-queue-empty").hidden = jobs.length > 0);
    jobsRoot.innerHTML = jobs.map(renderJob).join("");
  }

  function jobTitle(job) {
    const payload = job.payload || {};
    if (job.kind === "editor_export") return payload.title || "Монтаж";
    if (job.kind === "generate") return String(payload.user_prompt || payload.prompt || "MiniMax H3").slice(0, 140);
    return job.kind || "Задача";
  }

  function renderJob(job) {
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const running = job.status === "running";
    const time = running
      ? elapsed(job.started_at, snapshot?.server_now)
      : elapsed(job.started_at || job.created_at, job.finished_at ? new Date(job.finished_at).getTime() / 1000 : snapshot?.server_now);
    let actions = "";
    if (["queued", "running"].includes(job.status)) {
      actions += '<button type="button" data-job-action="cancel">Стоп</button>';
    }
    if (job.status === "failed") {
      actions += '<button type="button" data-job-action="retry">Retry</button>';
    }
    if (!["queued", "running"].includes(job.status)) {
      actions += '<button type="button" data-job-action="delete">Удалить</button>';
    }
    if (job.result_media_id) {
      actions += '<button type="button" data-job-action="open">Результат</button>';
    }
    return (
      '<article class="v2-job" data-job-id="' + escapeHtml(job.id) + '" data-status="' + escapeHtml(job.status) + '">' +
      '<div class="v2-job-status"><i></i><span>' + escapeHtml(job.status) + "</span></div>" +
      '<div class="v2-job-main"><strong>' + escapeHtml(jobTitle(job)) + '</strong><small>' + escapeHtml(job.stage || "") + '</small><div class="v2-job-progress"><span style="width:' + progress + '%"></span></div></div>' +
      '<div class="v2-job-time">' + escapeHtml(time) + "</div>" +
      '<div class="v2-job-actions">' + actions + "</div></article>"
    );
  }

  qs("#v2-queue-refresh")?.addEventListener("click", () => refreshState());

  qs("#v2-job-list")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-job-action]");
    if (!button) return;
    const row = button.closest("[data-job-id]");
    const id = row?.dataset.jobId;
    const action = button.dataset.jobAction;
    if (!id) return;
    button.disabled = true;
    try {
      if (action === "cancel") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
      } else if (action === "retry") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST" });
      } else if (action === "delete") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id), { method: "DELETE" });
      } else if (action === "open") {
        const job = (snapshot?.jobs || []).find((item) => String(item.id) === id);
        const item = mediaById(job?.result_media_id);
        if (item) openMediaDialog(item);
      }
      await refreshState({ silent: true });
    } catch (error) {
      showToast("Действие не выполнено: " + error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  /* Shared source pickers */
  function bindSourcePicker(prefix) {
    const select = qs("#v2-" + prefix + "-library");
    const upload = qs("#v2-" + prefix + "-upload");
    select?.addEventListener("change", () => {
      if (select.value) {
        if (upload) upload.value = "";
        setObjectUrl(prefix + "-source", null);
        applyLibrarySource(prefix, mediaById(select.value));
      } else {
        clearSourcePreview(prefix);
      }
    });
    upload?.addEventListener("change", () => {
      const file = upload.files?.[0];
      if (!file) return;
      if (select) select.value = "";
      const url = setObjectUrl(prefix + "-source", file);
      const preview = qs("#v2-" + prefix + "-preview");
      if (preview) {
        preview.src = url;
        preview.hidden = false;
      }
      const meta = qs("#v2-" + prefix + "-meta");
      if (meta) meta.textContent = file.name + " · размер определяется сервером";
    });
  }

  function applyLibrarySource(prefix, item) {
    const preview = qs("#v2-" + prefix + "-preview");
    if (!preview) return;
    if (!item) {
      clearSourcePreview(prefix);
      return;
    }
    preview.src = "/media/" + encodeURIComponent(item.id);
    preview.hidden = false;
    const meta = qs("#v2-" + prefix + "-meta");
    if (meta) {
      meta.textContent =
        mediaResolution(item) +
        " · " +
        formatSeconds(item.duration || item.meta?.seconds || 0) +
        " · формат наследуется";
    }
  }

  function clearSourcePreview(prefix) {
    const preview = qs("#v2-" + prefix + "-preview");
    if (preview) {
      preview.pause?.();
      preview.removeAttribute("src");
      preview.load?.();
      preview.hidden = true;
    }
  }

  bindSourcePicker("continue");
  bindSourcePicker("clip");

  /* Prompt magic wands */
  async function improvePrompt(kind) {
    const config = {
      continue: {
        target: "#v2-continue-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 video continuation prompt. Preserve end-state continuity, movement direction, pose, camera direction, lighting and scene geography. Return only changes.prompt.",
        settings: { generation_mode: "reference", reference_task: "video_continuation" },
      },
      audio: {
        target: "#v2-audio-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 Digital Human/audio-driven performance prompt. Synchronize visible performance and mouth/body motion to the driving audio. Return only changes.prompt.",
        settings: { generation_mode: "digital_human", reference_task: "audio_reference" },
      },
      clip: {
        target: "#v2-clip-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 next music-video segment prompt. Preserve previous-video continuity and synchronize action to the supplied master-track segment. Return only changes.prompt.",
        settings: { generation_mode: "reference", reference_task: "video_continuation" },
      },
    }[kind];
    if (!config) return;
    const target = qs(config.target);
    const source = target?.value.trim();
    if (!source) {
      showToast("Сначала напишите обычный prompt.", "error");
      target?.focus();
      return;
    }
    const button = qs('[data-v2-wand="' + kind + '"]');
    button && (button.disabled = true);
    try {
      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: config.instruction + "\n\n" + source }],
          settings: {
            ...api.currentAssistantSettings(),
            ...config.settings,
            selected_character_ids: selectedCharacterIds(),
          },
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (!improved) throw new Error(result?.message || "ИИ не вернул prompt.");
      target.value = String(improved).trim();
      showToast("Prompt улучшен под H3.");
    } catch (error) {
      showToast("Не удалось улучшить prompt: " + error.message, "error");
    } finally {
      button && (button.disabled = false);
    }
  }

  qsa("[data-v2-wand]").forEach((button) =>
    button.addEventListener("click", () => improvePrompt(button.dataset.v2Wand))
  );

  async function submitForm(form, url, formData, button) {
    button?.classList.add("is-loading");
    if (button) button.disabled = true;
    try {
      const result = await fetchJson(url, { method: "POST", body: formData });
      showToast("Задача добавлена в очередь · " + String(result.job_id || "").slice(0, 8));
      await refreshState({ silent: true });
      setView("queue");
      return result;
    } catch (error) {
      showToast("Не удалось запустить: " + error.message, "error");
      return null;
    } finally {
      button?.classList.remove("is-loading");
      if (button) button.disabled = false;
    }
  }

  qs("#v2-continue-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData();
    const prompt = qs("#v2-continue-prompt")?.value.trim() || "";
    if (!prompt) return showToast("Напишите, что должно происходить дальше.", "error");
    data.set("prompt", prompt);
    data.set("source_media_id", qs("#v2-continue-library")?.value || "");
    const upload = qs("#v2-continue-upload")?.files?.[0];
    if (upload) data.set("source_video", upload);
    data.set("seconds", settingValue("continue-seconds", "10"));
    data.set("steps", settingValue("continue-steps", "12"));
    data.set("seed", qs("#v2-continue-seed")?.value || "");
    data.set("generate_audio", qs("#v2-continue-audio")?.checked ? "true" : "false");
    data.set("character_ids", JSON.stringify(selectedCharacterIds()));
    await submitForm(form, "/api/v2/continue", data, qs('button[type="submit"]', form));
  });

  const audioInput = qs("#v2-audio-file");
  audioInput?.addEventListener("change", () => {
    const file = audioInput.files?.[0];
    const player = qs("#v2-audio-player");
    if (!player) return;
    if (!file) {
      player.hidden = true;
      return;
    }
    player.src = setObjectUrl("audio-driving", file);
    player.hidden = false;
  });

  qs("#v2-audio-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const audio = qs("#v2-audio-file")?.files?.[0];
    const prompt = qs("#v2-audio-prompt")?.value.trim() || "";
    if (!audio) return showToast("Выберите аудиотрек.", "error");
    if (!prompt) return showToast("Опишите сценическое действие.", "error");
    const data = new FormData();
    data.set("prompt", prompt);
    data.set("audio", audio);
    const visual = qs("#v2-audio-visual")?.files?.[0];
    if (visual) data.set("visual_reference", visual);
    data.set("quality", settingValue("audio-quality", "720"));
    data.set("ratio", settingValue("audio-ratio", "16:9"));
    data.set("seconds", settingValue("audio-seconds", "10"));
    data.set("steps", settingValue("audio-steps", "12"));
    data.set("seed", qs("#v2-audio-seed")?.value || "");
    data.set("character_ids", JSON.stringify(selectedCharacterIds()));
    await submitForm(form, "/api/v2/audio", data, qs('button[type="submit"]', form));
  });

  const clipAudio = qs("#v2-clip-audio");
  clipAudio?.addEventListener("change", () => {
    const file = clipAudio.files?.[0];
    const player = qs("#v2-clip-audio-player");
    if (!player) return;
    if (!file) {
      player.hidden = true;
      return;
    }
    player.src = setObjectUrl("clip-master-audio", file);
    player.hidden = false;
  });
  qs("#v2-clip-audio-start")?.addEventListener("input", updateClipRange);

  function updateClipRange() {
    const start = Math.max(0, Number(qs("#v2-clip-audio-start")?.value) || 0);
    const seconds = Number(settingValue("clip-seconds", "10")) || 10;
    const label = qs("#v2-clip-range");
    if (label) label.textContent = "Будет использован отрезок " + start.toFixed(1) + "–" + (start + seconds).toFixed(1) + " сек";
  }

  qs("#v2-clip-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const prompt = qs("#v2-clip-prompt")?.value.trim() || "";
    const audio = qs("#v2-clip-audio")?.files?.[0];
    if (!prompt) return showToast("Опишите следующий фрагмент.", "error");
    if (!audio) return showToast("Выберите master track.", "error");
    const data = new FormData();
    data.set("prompt", prompt);
    data.set("source_media_id", qs("#v2-clip-library")?.value || "");
    const upload = qs("#v2-clip-upload")?.files?.[0];
    if (upload) data.set("source_video", upload);
    data.set("master_audio", audio);
    data.set("audio_start", qs("#v2-clip-audio-start")?.value || "0");
    data.set("seconds", settingValue("clip-seconds", "10"));
    data.set("steps", settingValue("clip-steps", "12"));
    data.set("seed", qs("#v2-clip-seed")?.value || "");
    data.set("character_ids", JSON.stringify(selectedCharacterIds()));
    const result = await submitForm(form, "/api/v2/clip", data, qs('button[type="submit"]', form));
    if (result && Number.isFinite(Number(result.audio_end))) {
      const input = qs("#v2-clip-audio-start");
      if (input) input.value = String(result.audio_end);
      updateClipRange();
    }
  });

  /* Chat */
  if (!Array.isArray(chatMessages)) chatMessages = [];
  chatMessages = chatMessages
    .filter((item) => item && ["user", "assistant"].includes(item.role) && item.content)
    .slice(-400);

  function renderChat() {
    const root = qs("#v2-chat-messages");
    if (!root) return;
    root.innerHTML = "";
    chatMessages.forEach((message) => {
      const div = document.createElement("div");
      div.className = "v2-chat-message " + message.role;
      div.textContent = message.content;
      root.appendChild(div);
    });
    root.scrollTop = root.scrollHeight;
  }

  async function updateChatContext() {
    const label = qs("#v2-chat-context-label");
    const fill = qs("#v2-chat-context-fill");
    const note = qs("#v2-chat-context-note");
    if (!label || !fill || !note) return;
    try {
      const usage = await fetchJson("/api/assistant/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: chatMessages,
          thinking: Boolean(qs("#v2-chat-thinking")?.checked),
        }),
      });
      const used = Number(usage.estimated_tokens || 0);
      const limit = Number(usage.context_limit || 32768);
      label.textContent = (used / 1000).toFixed(1) + "k / " + Math.round(limit / 1000) + "k";
      fill.style.width = Math.min(100, (used / limit) * 100) + "%";
      note.textContent = usage.dropped_messages
        ? "Старых сообщений не отправлено модели: " + usage.dropped_messages
        : "В активный контекст помещается вся текущая история";
    } catch {
      label.textContent = "— / 32k";
      note.textContent = "Не удалось посчитать контекст";
    }
  }

  async function sendChat() {
    const input = qs("#v2-chat-input");
    const text = input?.value.trim();
    if (!text || chatBusy) return;
    chatBusy = true;
    input.value = "";
    chatMessages.push({ role: "user", content: text });
    saveJson(CHAT_KEY, chatMessages);
    renderChat();

    const root = qs("#v2-chat-messages");
    const bubble = document.createElement("div");
    bubble.className = "v2-chat-message assistant pending";
    bubble.textContent = "…";
    root?.appendChild(bubble);
    root && (root.scrollTop = root.scrollHeight);

    let answer = "";
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "AI-Video-Site-V2",
        },
        body: JSON.stringify({
          messages: chatMessages,
          thinking: Boolean(qs("#v2-chat-thinking")?.checked),
        }),
      });
      if (!response.ok) {
        let detail = "HTTP " + response.status;
        try {
          const body = await response.json();
          detail = body.detail || detail;
        } catch {}
        throw new Error(detail);
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      bubble.classList.remove("pending");
      bubble.textContent = "";
      if (!reader) throw new Error("Streaming response недоступен.");
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        bubble.textContent = answer;
        root && (root.scrollTop = root.scrollHeight);
      }
      answer += decoder.decode();
      answer = answer.trim();
      if (answer) chatMessages.push({ role: "assistant", content: answer });
      else bubble.textContent = "Пустой ответ.";
      saveJson(CHAT_KEY, chatMessages);
    } catch (error) {
      bubble.classList.remove("pending");
      bubble.textContent = "Ошибка: " + error.message;
      showToast("Чат: " + error.message, "error");
    } finally {
      chatBusy = false;
      await updateChatContext();
    }
  }

  qs("#v2-chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat();
  });
  qs("#v2-chat-clear")?.addEventListener("click", () => {
    if (chatMessages.length && !confirm("Очистить этот локальный чат?")) return;
    chatMessages = [];
    saveJson(CHAT_KEY, chatMessages);
    renderChat();
    updateChatContext();
  });
  qs("#v2-chat-thinking")?.addEventListener("change", updateChatContext);

  /* System */
  function renderSystem() {
    const root = qs("#v2-system-grid");
    if (!root || !snapshot) return;
    const sys = snapshot.system || {};
    const assistant = snapshot.assistant || {};
    const gpus = sys.gpus || [];
    const cards = [];
    gpus.forEach((gpu) => {
      const active = gpuJob(Number(gpu.index));
      cards.push(
        systemCard(
          gpu.name || "GPU " + gpu.index,
          true,
          [
            ["VRAM", (gpu.memory_used_mb / 1024).toFixed(1) + " / " + (gpu.memory_total_mb / 1024).toFixed(1) + " GB"],
            ["Load", gpu.utilization + "%"],
            ["Temp", gpu.temperature + "°C"],
            ["User", active ? active.user_label : "Свободна"],
          ],
          active ? (active.prompt || active.stage || "") : ""
        )
      );
    });
    cards.push(
      systemCard(
        "Local Qwen3-8B",
        Boolean(assistant.online),
        [
          ["Target", assistant.target || "—"],
          ["Process", assistant.llama_alive ? "Loaded" : assistant.loading ? "Loading" : "Offline"],
          ["Context", "32k"],
          ["Reserved GPU", (assistant.reserved_gpus || []).join(", ") || "—"],
        ]
      )
    );
    cards.push(
      systemCard("ComfyUI", Boolean(sys.comfyui && sys.comfyui_secondary), [
        ["Primary", sys.comfyui ? "Online" : "Offline"],
        ["Secondary", sys.comfyui_secondary ? "Online" : "Offline"],
        ["Queued", snapshot.global_counts?.queued ?? 0],
        ["Running", snapshot.global_counts?.running ?? 0],
      ])
    );
    cards.push(
      systemCard("RAM / CPU", true, [
        ["RAM used", sys.ram_total && sys.ram_available ? formatBytes(sys.ram_total - sys.ram_available) : "—"],
        ["RAM total", formatBytes(sys.ram_total)],
        ["Load 1m", sys.cpu_load_1m ?? "—"],
        ["Load 5m", sys.cpu_load_5m ?? "—"],
      ])
    );
    cards.push(
      systemCard("Disk", true, [
        ["Used", sys.disk_total ? formatBytes(sys.disk_total - sys.disk_free) : "—"],
        ["Free", formatBytes(sys.disk_free)],
        ["Total", formatBytes(sys.disk_total)],
        ["Library", snapshot.global_counts?.media ?? 0],
      ])
    );
    root.innerHTML = cards.join("");
  }

  function systemCard(title, online, metrics, extra = "") {
    return (
      '<article class="v2-system-card">' +
      '<div class="v2-system-card-head"><h3>' + escapeHtml(title) + '</h3><span class="v2-system-state' + (online ? "" : " offline") + '">' + (online ? "ONLINE" : "OFFLINE") + "</span></div>" +
      '<div class="v2-system-metrics">' +
      metrics.map(([label, value]) => '<div class="v2-system-metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + "</strong></div>").join("") +
      "</div>" +
      (extra ? '<div class="v2-system-users">' + escapeHtml(extra) + "</div>" : "") +
      "</article>"
    );
  }
  qs("#v2-system-refresh")?.addEventListener("click", () => refreshState());

  /* Editor */
  function normalizeEditorState() {
    const valid = new Set(allMedia.map((item) => String(item.id)));
    editorState.clips = editorState.clips.filter((clip) => valid.has(String(clip.media_id)));
    editorState.title = String(editorState.title || "Монтаж V2");
    saveEditor();
  }

  function saveEditor() {
    saveJson(EDITOR_KEY, editorState);
  }

  function reconcileEditorClips() {
    normalizeEditorState();
    if (editorSelected >= editorState.clips.length) editorSelected = editorState.clips.length - 1;
    const title = qs("#v2-editor-title");
    if (title && document.activeElement !== title) title.value = editorState.title;
    renderEditorTimeline();
    renderEditorInspector();
  }

  function renderEditorLibrary() {
    const root = qs("#v2-editor-media");
    if (!root) return;
    root.innerHTML = allMedia
      .map(
        (item) =>
          '<button class="v2-editor-library-item" type="button" data-editor-add="' + escapeHtml(item.id) + '">' +
          '<span class="v2-editor-thumb"><svg class="icon"><use href="/static/icons.svg#icon-video"></use></svg></span>' +
          '<span><strong>' + escapeHtml(item.title || "Видео") + '</strong><small>' + escapeHtml(formatSeconds(item.duration || item.meta?.seconds || 0)) + "</small></span></button>"
      )
      .join("");
  }

  function addEditorClip(item) {
    if (!item) return;
    editorState.clips.push({
      media_id: item.id,
      volume: 1,
      trim_start: 0,
      trim_duration: 0,
      fade_in: 0,
      fade_out: 0,
    });
    editorSelected = editorState.clips.length - 1;
    saveEditor();
    renderEditorTimeline();
    renderEditorInspector();
    showToast("Клип добавлен на таймлайн.");
  }

  qs("#v2-editor-media")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-editor-add]");
    if (button) addEditorClip(mediaById(button.dataset.editorAdd));
  });

  function effectiveClipDuration(clip) {
    const item = mediaById(clip.media_id);
    const source = Number(item?.duration || item?.meta?.seconds || 0);
    const start = Math.max(0, Number(clip.trim_start) || 0);
    const requested = Math.max(0, Number(clip.trim_duration) || 0);
    return requested > 0 ? Math.min(requested, Math.max(0, source - start)) : Math.max(0, source - start);
  }

  function renderEditorTimeline() {
    const root = qs("#v2-editor-timeline");
    if (!root) return;
    root.innerHTML = editorState.clips
      .map((clip, index) => {
        const item = mediaById(clip.media_id);
        const duration = effectiveClipDuration(clip);
        return (
          '<div class="v2-timeline-clip' + (index === editorSelected ? " selected" : "") + '" draggable="true" data-editor-index="' + index + '">' +
          "<strong>" + escapeHtml(item?.title || "Клип") + "</strong>" +
          "<small>" + escapeHtml(formatSeconds(duration)) + " · " + Math.round((Number(clip.volume) || 0) * 100) + "%</small>" +
          "</div>"
        );
      })
      .join("");
    const duration = editorState.clips.reduce((sum, clip) => sum + effectiveClipDuration(clip), 0);
    const durationLabel = qs("#v2-editor-duration");
    if (durationLabel) durationLabel.textContent = formatSeconds(duration);
  }

  qs("#v2-editor-timeline")?.addEventListener("click", (event) => {
    const clip = event.target.closest("[data-editor-index]");
    if (!clip) return;
    editorSelected = Number(clip.dataset.editorIndex);
    renderEditorTimeline();
    renderEditorInspector();
  });
  qs("#v2-editor-timeline")?.addEventListener("dragstart", (event) => {
    const clip = event.target.closest("[data-editor-index]");
    editorDragIndex = clip ? Number(clip.dataset.editorIndex) : -1;
  });
  qs("#v2-editor-timeline")?.addEventListener("dragover", (event) => event.preventDefault());
  qs("#v2-editor-timeline")?.addEventListener("drop", (event) => {
    event.preventDefault();
    const target = event.target.closest("[data-editor-index]");
    const targetIndex = target ? Number(target.dataset.editorIndex) : editorState.clips.length - 1;
    if (editorDragIndex < 0 || targetIndex < 0 || editorDragIndex === targetIndex) return;
    const [moved] = editorState.clips.splice(editorDragIndex, 1);
    editorState.clips.splice(targetIndex, 0, moved);
    editorSelected = targetIndex;
    editorDragIndex = -1;
    saveEditor();
    renderEditorTimeline();
    renderEditorInspector();
  });

  function renderEditorInspector() {
    const controls = qs("#v2-editor-controls");
    const empty = qs("#v2-editor-no-selection");
    const clip = editorState.clips[editorSelected];
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
    const item = mediaById(clip.media_id);
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
  }

  const editorFields = {
    "#v2-editor-trim-start": "trim_start",
    "#v2-editor-trim-duration": "trim_duration",
    "#v2-editor-volume": "volume",
    "#v2-editor-fade-in": "fade_in",
    "#v2-editor-fade-out": "fade_out",
  };
  Object.entries(editorFields).forEach(([selector, key]) => {
    qs(selector)?.addEventListener("input", (event) => {
      const clip = editorState.clips[editorSelected];
      if (!clip) return;
      clip[key] = Math.max(0, Number(event.target.value) || 0);
      if (key === "volume") clip[key] = Math.min(2, clip[key]);
      saveEditor();
      renderEditorTimeline();
    });
  });

  qs("#v2-editor-title")?.addEventListener("input", (event) => {
    editorState.title = event.target.value;
    saveEditor();
  });

  qs("#v2-editor-remove")?.addEventListener("click", () => {
    if (!editorState.clips[editorSelected]) return;
    editorState.clips.splice(editorSelected, 1);
    editorSelected = Math.min(editorSelected, editorState.clips.length - 1);
    saveEditor();
    renderEditorTimeline();
    renderEditorInspector();
  });

  qs("#v2-editor-split")?.addEventListener("click", () => {
    const clip = editorState.clips[editorSelected];
    if (!clip) return;
    const duration = effectiveClipDuration(clip);
    const split = Number(qs("#v2-editor-split-at")?.value) || 0;
    if (split <= 0.05 || split >= duration - 0.05) {
      return showToast("Точка разреза должна находиться внутри клипа.", "error");
    }
    const originalStart = Number(clip.trim_start) || 0;
    const right = { ...clip };
    clip.trim_duration = split;
    right.trim_start = originalStart + split;
    right.trim_duration = duration - split;
    editorState.clips.splice(editorSelected + 1, 0, right);
    saveEditor();
    renderEditorTimeline();
    renderEditorInspector();
  });

  qs("#v2-editor-audio")?.addEventListener("change", (event) => {
    editorAudioFile = event.target.files?.[0] || null;
    if (editorAudioFile) showToast("Аудиодорожка выбрана: " + editorAudioFile.name);
  });

  qs("#v2-editor-export")?.addEventListener("click", async (event) => {
    if (!editorState.clips.length) return showToast("Добавьте хотя бы один ролик на таймлайн.", "error");
    const button = event.currentTarget;
    const data = new FormData();
    const project = {
      title: qs("#v2-editor-title")?.value.trim() || "Монтаж V2",
      clips: editorState.clips,
      audio: {
        enabled: Boolean(editorAudioFile),
        offset: Number(qs("#v2-editor-audio-offset")?.value) || 0,
        trim_start: Number(qs("#v2-editor-audio-trim")?.value) || 0,
        trim_duration: Number(qs("#v2-editor-audio-length")?.value) || 0,
        volume: Number(qs("#v2-editor-audio-volume")?.value) || 1,
      },
    };
    data.set("project", JSON.stringify(project));
    if (editorAudioFile) data.set("audio", editorAudioFile);
    await submitForm(null, "/api/editor/export", data, button);
  });

  /* View lifecycle */
  async function activateView(view) {
    if (["library", "queue", "continue", "clip", "editor", "system"].includes(view)) {
      await refreshState({ silent: true });
    }
    if (view === "chat") {
      renderChat();
      updateChatContext();
    }
    if (view === "editor") {
      reconcileEditorClips();
    }
  }

  window.addEventListener("v2:viewchange", (event) => activateView(event.detail?.view || "create"));
  updateClipRange();
  renderChat();
  updateChatContext();
  refreshState({ silent: true });
  activateView(api.state.view);

  setInterval(() => {
    const view = api.state.view;
    if (["queue", "system"].includes(view)) refreshState({ silent: true, includeMedia: false });
  }, 4000);

  window.addEventListener("beforeunload", () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  });
})();
