(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const appPage = $(".app-page");
  if (!appPage) return;

  const SETTINGS_KEY = "aivideosite-settings-v1";
  const STORAGE_PREFIX = "aivideosite-";

  let stateTimer = null;
  let lastState = null;
  let lastMediaSignature = "";
  let mediaPage = 1;
  let jobsPage = 1;
  let serverClockAtFetchMs = null;
  let serverClockPerfAtFetch = null;
  let currentView = localStorage.getItem("aivideosite-view") || "generate";
  const uploadObjectUrls = new Map();

  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-${name}"></use></svg>`;

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        "X-Requested-With": "AI-Video-Site",
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      location.href = "/login";
      throw new Error("Требуется вход");
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (!response.ok) {
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return body;
  };

  const showToast = (message, type = "success") => {
    const container = $("#toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      ${icon(type === "error" ? "alert" : "check")}
      <div>${escapeHtml(message)}</div>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  };

  const humanBytes = (bytes) => {
    const value = Number(bytes || 0);
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
      Math.floor(Math.log(value) / Math.log(1024)),
      units.length - 1
    );
    return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
  };

  const humanDuration = (seconds) => {
    if (seconds === null || seconds === undefined) return "—";
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "—";
    if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} сек`;
    const minutes = Math.floor(value / 60);
    return `${minutes}:${String(Math.round(value % 60)).padStart(2, "0")}`;
  };

  const shortDate = (iso) => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  };

  const formatHms = (seconds) => {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return [hours, minutes, secs]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  };

  const syncedServerNowMs = () => {
    if (serverClockAtFetchMs === null || serverClockPerfAtFetch === null) {
      return Date.now();
    }
    return serverClockAtFetchMs + (performance.now() - serverClockPerfAtFetch);
  };

  const elapsedBetween = (startIso, endIso = null) => {
    if (!startIso) return null;
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : syncedServerNowMs();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, (end - start) / 1000);
  };

  const jobElapsed = (job) =>
    elapsedBetween(job.started_at, job.finished_at || null);

  const jobWait = (job) => {
    if (!job.created_at) return null;
    if (job.started_at) {
      return elapsedBetween(job.created_at, job.started_at);
    }
    if (job.status === "queued") {
      return elapsedBetween(job.created_at);
    }
    return null;
  };

  const updateLiveJobTimers = () => {
    qsa("#job-list [data-job-start]").forEach((element) => {
      const start = element.dataset.jobStart || "";
      const finished = element.dataset.jobFinished || "";
      const elapsed = elapsedBetween(start, finished || null);
      element.textContent = elapsed === null ? "—" : formatHms(elapsed);
    });

    qsa("#job-list [data-job-created]").forEach((element) => {
      const created = element.dataset.jobCreated || "";
      const started = element.dataset.jobStarted || "";
      const status = element.dataset.jobStatus || "";
      let elapsed = null;
      if (started) {
        elapsed = elapsedBetween(created, started);
      } else if (status === "queued") {
        elapsed = elapsedBetween(created);
      }
      element.textContent = elapsed === null ? "—" : formatHms(elapsed);
    });
  };

  const switchView = (view, refresh = false, persist = true) => {
    if (!["generate", "library", "queue"].includes(view)) view = "generate";
    currentView = view;
    if (persist) {
      localStorage.setItem("aivideosite-view", view);
    }

    $$("[data-view]").forEach((element) =>
      element.classList.toggle("active", element.dataset.view === view)
    );
    $$("[data-nav]").forEach((element) =>
      element.classList.toggle("active", element.dataset.nav === view)
    );

    const titles = {
      generate: "Генерация",
      library: "Библиотека",
      queue: "Очередь",
    };
    $("#page-title").textContent = titles[view];

    if (refresh) {
      refreshState(true, view === "library");
    }
  };

  $$("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.nav, true));
  });
  switchView(currentView);

  const generationForm = $("#generate-form");
  const secondsRange = $("#seconds-range");
  const secondsValue = $("#seconds-value");

  const updateSeconds = () => {
    if (secondsRange && secondsValue) {
      secondsValue.textContent = `${secondsRange.value} сек`;
    }
  };

  const collectGeneratorSettings = () => {
    const checkedProfile = $('[name="profile"]:checked', generationForm);
    return {
      prompt: $("#prompt")?.value || "",
      resolution: $("#resolution")?.value || "1344x768",
      seconds: secondsRange?.value || "5",
      fps: $('[name="fps"]', generationForm)?.value || "24",
      profile: checkedProfile?.value || "fast",
      seed: $('[name="seed"]', generationForm)?.value || "-1",
      generate_audio: Boolean($("#generate-audio")?.checked),
    };
  };

  const saveGeneratorSettings = () => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(collectGeneratorSettings())
      );
    } catch {
      // Storage may be disabled by the browser. The app can still work.
    }
  };

  const restoreGeneratorSettings = () => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== "object") {
      updateSeconds();
      return;
    }

    if (typeof saved.prompt === "string") {
      $("#prompt").value = saved.prompt;
    }

    const resolution = $("#resolution");
    if (
      resolution &&
      [...resolution.options].some((option) => option.value === saved.resolution)
    ) {
      resolution.value = saved.resolution;
    }

    if (secondsRange) {
      const seconds = Math.max(1, Math.min(30, Number(saved.seconds || 5)));
      secondsRange.value = String(seconds);
    }

    const fps = $('[name="fps"]', generationForm);
    if (
      fps &&
      [...fps.options].some((option) => option.value === String(saved.fps))
    ) {
      fps.value = String(saved.fps);
    }

    const profile = $(
      `[name="profile"][value="${CSS.escape(String(saved.profile || "fast"))}"]`,
      generationForm
    );
    if (profile) {
      profile.checked = true;
    }

    const seed = $('[name="seed"]', generationForm);
    if (seed && saved.seed !== undefined && saved.seed !== null) {
      seed.value = String(saved.seed);
    }

    const audio = $("#generate-audio");
    if (audio) {
      audio.checked = Boolean(saved.generate_audio);
    }

    updateSeconds();
  };

  const clearAppStorageAndReset = () => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }

    generationForm.reset();
    qsa(".upload-card input[type=file]").forEach((input) => {
      clearUploadPreview(input);
    });

    mediaPage = 1;
    jobsPage = 1;
    updateSeconds();
    switchView("generate", false, false);
    showToast("Промт и настройки сброшены по умолчанию.");
  };

  restoreGeneratorSettings();

  generationForm.addEventListener("input", (event) => {
    if (event.target.matches('input[type="file"]')) return;
    updateSeconds();
    saveGeneratorSettings();
  });

  generationForm.addEventListener("change", (event) => {
    if (event.target.matches('input[type="file"]')) return;
    updateSeconds();
    saveGeneratorSettings();
  });

  $("#reset-settings").addEventListener("click", clearAppStorageAndReset);

  const renderSystem = (state) => {
    const gpu = state.system?.gpu;
    const comfy = state.system?.comfyui;
    const running = Number(state.counts?.running || 0);
    const queued = Number(state.counts?.queued || 0);

    const comfyPill = $("#comfy-status");
    const comfyDot = $(".status-dot", comfyPill);
    comfyDot.className = `status-dot ${comfy ? "ok" : "error"}`;
    comfyPill.title = comfy ? "ComfyUI доступен" : "ComfyUI недоступен";

    const active = $("#active-status");
    active.innerHTML = running
      ? `${icon("bolt")}<span>GPU занят</span>`
      : `${icon("check")}<span>GPU свободен</span>`;

    $("#sidebar-queue-count").textContent = String(running + queued);
    $("#mobile-queue-count").textContent = String(running + queued);
    $("#sidebar-media-count").textContent = String(state.counts?.media || 0);
    $("#metric-queue").textContent = String(running + queued);

    const miniDot = $("#gpu-status-dot");
    if (gpu) {
      miniDot.className = `status-dot ${running ? "busy" : "ok"}`;
      $("#gpu-mini-name").textContent = gpu.name || "NVIDIA GPU";
      $("#gpu-mini-value").textContent =
        `${gpu.memory_used_mb} / ${gpu.memory_total_mb} MB`;
      $("#metric-gpu").textContent = (gpu.name || "RTX 3090").replace(
        "NVIDIA GeForce ",
        ""
      );
      $("#metric-vram").textContent =
        `${(gpu.memory_used_mb / 1024).toFixed(1)} / ${(
          gpu.memory_total_mb / 1024
        ).toFixed(0)} GB VRAM`;
      $("#metric-util").textContent = `${gpu.utilization}%`;
      $("#metric-temp").textContent = `${gpu.temperature} °C`;
    } else {
      miniDot.className = "status-dot error";
      $("#gpu-mini-value").textContent = "nvidia-smi недоступен";
      $("#metric-gpu").textContent = "Нет данных";
      $("#metric-vram").textContent = "—";
      $("#metric-util").textContent = "—";
      $("#metric-temp").textContent = "—";
    }

    $("#metric-disk").textContent = humanBytes(state.system?.disk_free || 0);
  };

  const kindLabel = (kind) =>
    ({
      generated: "H3",
      lipsync: "LipSync",
      audio: "Audio",
      silent: "Silent",
    }[kind] || kind);

  const mediaSignature = (media) =>
    (media || [])
      .map((item) => `${item.id}:${item.size_bytes}:${item.created_at}`)
      .join("|");

  const libraryHasPlayingVideo = () =>
    $$("#media-grid video").some((video) => !video.paused && !video.ended);

  const renderMedia = (media) => {
    const grid = $("#media-grid");
    const empty = $("#media-empty");
    empty.classList.toggle("show", !media.length);

    grid.innerHTML = media
      .map((item) => {
        const meta = item.meta || {};
        const details = [];
        if (meta.width && meta.height) {
          details.push(`${meta.width}×${meta.height}`);
        }
        if (meta.profile) {
          const profile =
            { fast: "Fast", quality: "Quality", max: "Max" }[meta.profile] ||
            meta.profile;
          details.push(profile);
        }
        if (meta.fps) details.push(`${meta.fps} FPS`);
        if (meta.generate_audio) details.push("H3 Audio");
        if (meta.seed !== undefined && meta.seed !== null) {
          details.push(`seed ${meta.seed}`);
        }
        details.push(humanDuration(item.duration));
        details.push(humanBytes(item.size_bytes));

        return `
          <article class="media-card" data-media-id="${escapeHtml(item.id)}">
            <div class="media-preview">
              <video
                src="/media/${encodeURIComponent(item.id)}"
                controls
                playsinline
                preload="metadata"></video>
            </div>
            <div class="media-body">
              <div style="display:flex;align-items:center;gap:8px;min-width:0">
                <span class="badge badge-blue">${escapeHtml(
                  kindLabel(item.kind)
                )}</span>
                <h3 class="media-title" title="${escapeHtml(
                  item.title
                )}">${escapeHtml(item.title)}</h3>
              </div>
              <div class="media-meta">
                <span>${escapeHtml(shortDate(item.created_at))}</span>
                ${details
                  .filter(Boolean)
                  .map((detail) => `<span>· ${escapeHtml(detail)}</span>`)
                  .join("")}
              </div>
              <div class="media-actions">
                <button type="button" data-action="info" title="Промт и параметры">
                  ${icon("info")}
                </button>
                <button type="button" data-action="lipsync" title="LipSync">
                  ${icon("microphone")}
                </button>
                <button type="button" data-action="audio" title="Наложить аудио">
                  ${icon("music")}
                </button>
                <button type="button" data-action="remove-audio" title="Убрать звук">
                  ${icon("volume-off")}
                </button>
                <a href="/media/${encodeURIComponent(
                  item.id
                )}?download=1" title="Скачать">
                  ${icon("download")}
                </a>
                <button class="danger" type="button" data-action="delete" title="Удалить">
                  ${icon("trash")}
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  };

  const jobLabel = (kind) =>
    ({
      generate: "MiniMax H3",
      lipsync: "LatentSync",
      audio_replace: "Наложение аудио",
      audio_remove: "Удаление звука",
    }[kind] || kind);

  const statusBadge = (status) => {
    const labels = {
      queued: ["В очереди", "gray"],
      running: ["В работе", "yellow"],
      done: ["Готово", "green"],
      failed: ["Ошибка", "red"],
      canceled: ["Отменено", "gray"],
    };
    const [label, color] = labels[status] || [status, "gray"];
    return `<span class="badge badge-${color}">${escapeHtml(label)}</span>`;
  };

  const jobActions = (job) => {
    if (job.status === "queued" || job.status === "running") {
      return `
        <button class="btn btn-danger btn-compact" type="button" data-job-action="cancel" data-job-id="${escapeHtml(
          job.id
        )}">
          ${icon("x")} Отменить
        </button>
      `;
    }

    const actions = [];
    if (job.status === "failed") {
      actions.push(`
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="retry" data-job-id="${escapeHtml(
          job.id
        )}">
          ${icon("refresh")} Повторить
        </button>
      `);
    }

    if (job.status === "done" && job.result_media_id) {
      actions.push(`
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="library" data-media-id="${escapeHtml(
          job.result_media_id
        )}">
          ${icon("library")} Открыть библиотеку
        </button>
      `);
    }

    actions.push(`
      <button class="btn btn-danger btn-compact" type="button" data-job-action="delete" data-job-id="${escapeHtml(
        job.id
      )}">
        ${icon("trash")} Удалить
      </button>
    `);

    return actions.join("");
  };

  const renderJobs = (jobs) => {
    const list = $("#job-list");
    const empty = $("#job-empty");
    empty.classList.toggle("show", !jobs.length);

    list.innerHTML = jobs
      .map((job) => {
        const payload = job.payload || {};
        const prompt = job.kind === "generate" ? payload.prompt || "" : "";
        const progress = Math.max(
          0,
          Math.min(100, Number(job.progress || 0))
        );
        const elapsed = jobElapsed(job);
        const progressText =
          job.status === "running"
            ? `≈ ${Math.round(progress)}%`
            : `${Math.round(progress)}%`;

        return `
          <article class="job-card" data-job-id="${escapeHtml(job.id)}">
            <div class="job-top">
              <div class="job-name">
                <span class="metric-icon job-icon">
                  ${icon(
                    job.kind === "generate"
                      ? "wand"
                      : job.kind === "lipsync"
                        ? "microphone"
                        : "settings"
                  )}
                </span>
                <div>
                  <strong>${escapeHtml(jobLabel(job.kind))}</strong>
                  <small>${escapeHtml(job.stage || "В очереди")}</small>
                </div>
              </div>
              ${statusBadge(job.status)}
            </div>

            ${prompt ? `<div class="job-prompt">${escapeHtml(prompt)}</div>` : ""}

            <div class="job-stats">
              <span><b>Создано:</b> ${escapeHtml(shortDate(job.created_at))}</span>
              <span><b>Начало:</b> ${
                job.started_at ? escapeHtml(shortDate(job.started_at)) : "—"
              }</span>
              <span><b>Ожидание:</b> <span
                data-job-created="${escapeHtml(job.created_at || "")}"
                data-job-started="${escapeHtml(job.started_at || "")}"
                data-job-status="${escapeHtml(job.status || "")}"
              >${jobWait(job) === null ? "—" : formatHms(jobWait(job))}</span></span>
              <span><b>Генерация:</b> <span
                data-job-start="${escapeHtml(job.started_at || "")}"
                data-job-finished="${escapeHtml(job.finished_at || "")}"
              >${elapsed === null ? "—" : formatHms(elapsed)}</span></span>
              <span><b>Прогресс:</b> ${progressText}</span>
            </div>

            <div class="job-progress" style="--progress:${progress}%">
              <span></span>
            </div>

            ${job.error ? `<pre class="job-error">${escapeHtml(job.error)}</pre>` : ""}
            <div class="job-actions">${jobActions(job)}</div>
          </article>
        `;
      })
      .join("");
  };

  const renderPagination = (containerId, pagination, target) => {
    const container = $(containerId);
    if (!pagination || pagination.total <= pagination.page_size) {
      container.innerHTML = pagination?.total
        ? `<span class="pagination-info">${pagination.total} записей · по ${pagination.page_size} на странице</span>`
        : "";
      return;
    }

    const page = Number(pagination.page || 1);
    const pages = Number(pagination.pages || 1);
    container.innerHTML = `
      <button type="button" data-page-target="${target}" data-page="${
        page - 1
      }" ${page <= 1 ? "disabled" : ""}>←</button>
      <span class="pagination-info">Страница <strong>${page}</strong> из ${pages} · ${pagination.total} записей</span>
      <button type="button" data-page-target="${target}" data-page="${
        page + 1
      }" ${page >= pages ? "disabled" : ""}>→</button>
    `;
  };

  const refreshState = async (quiet = true, forceMedia = false) => {
    try {
      const state = await api(
        `/api/state?media_page=${mediaPage}&jobs_page=${jobsPage}`
      );
      lastState = state;
      if (Number.isFinite(Number(state.server_now))) {
        serverClockAtFetchMs = Number(state.server_now) * 1000;
        serverClockPerfAtFetch = performance.now();
      }

      mediaPage = Number(state.media_pagination?.page || mediaPage);
      jobsPage = Number(state.jobs_pagination?.page || jobsPage);

      renderSystem(state);
      renderJobs(state.jobs || []);
      renderPagination("#job-pagination", state.jobs_pagination, "jobs");
      renderPagination("#media-pagination", state.media_pagination, "media");

      const signature = mediaSignature(state.media || []);
      const safeToRenderMedia = forceMedia || !libraryHasPlayingVideo();
      if (
        safeToRenderMedia &&
        (forceMedia || signature !== lastMediaSignature)
      ) {
        renderMedia(state.media || []);
        lastMediaSignature = signature;
      }
    } catch (error) {
      if (!quiet) showToast(error.message, "error");
    } finally {
      scheduleRefresh();
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(
      () => refreshState(true, false),
      document.hidden ? 15000 : 3000
    );
  };

  document.addEventListener("visibilitychange", () => {
    clearTimeout(stateTimer);
    refreshState(true, false);
  });

  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page-target]");
    if (!pageButton || pageButton.disabled) return;

    const page = Math.max(1, Number(pageButton.dataset.page || 1));
    if (pageButton.dataset.pageTarget === "media") {
      mediaPage = page;
      lastMediaSignature = "";
      refreshState(true, true);
    } else {
      jobsPage = page;
      refreshState(true, false);
    }
  });

  $("#refresh-library").addEventListener("click", () => {
    lastMediaSignature = "";
    refreshState(false, true);
  });

  $("#clear-library").addEventListener("click", async () => {
    if (
      !confirm(
        "Удалить все ролики из библиотеки? Ролики, которые нужны активной задаче, будут сохранены."
      )
    ) {
      return;
    }

    const button = $("#clear-library");
    button.disabled = true;
    try {
      const result = await api("/api/media", { method: "DELETE" });
      mediaPage = 1;
      lastMediaSignature = "";
      const protectedText = result.protected
        ? ` Защищено активными задачами: ${result.protected}.`
        : "";
      showToast(`Удалено роликов: ${result.deleted}.${protectedText}`);
      await refreshState(true, true);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#clear-queue").addEventListener("click", async () => {
    if (
      !confirm(
        "Очистить очередь? Будут удалены завершённые, ошибочные, отменённые и ожидающие задачи. Работающие останутся."
      )
    ) {
      return;
    }

    const button = $("#clear-queue");
    button.disabled = true;
    try {
      const result = await api("/api/jobs", { method: "DELETE" });
      jobsPage = 1;
      const runningText = result.running_kept
        ? ` Работающих оставлено: ${result.running_kept}.`
        : "";
      showToast(`Удалено задач: ${result.deleted}.${runningText}`);
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const clearUploadPreview = (input) => {
    if (!input) return;
    const card = input.closest(".upload-card");
    const existingUrl = uploadObjectUrls.get(input);
    if (existingUrl) {
      URL.revokeObjectURL(existingUrl);
      uploadObjectUrls.delete(input);
    }

    input.value = "";
    if (!card) return;

    const preview = $(".upload-preview", card);
    const name = $(".upload-name", card);
    if (preview) {
      preview.removeAttribute("src");
      preview.hidden = true;
    }
    if (name) {
      name.textContent = "Выбрать изображение";
    }
    card.classList.remove("has-preview");
  };

  const showUploadPreview = (input, file) => {
    const card = input.closest(".upload-card");
    if (!card || !file) {
      clearUploadPreview(input);
      return;
    }

    const previousUrl = uploadObjectUrls.get(input);
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }

    const objectUrl = URL.createObjectURL(file);
    uploadObjectUrls.set(input, objectUrl);

    const preview = $(".upload-preview", card);
    const name = $(".upload-name", card);
    if (preview) {
      preview.src = objectUrl;
      preview.hidden = false;
    }
    if (name) {
      name.textContent = file.name;
    }
    card.classList.add("has-preview");
  };

  qsa(".upload-card input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      if (file) {
        showUploadPreview(input, file);
      } else {
        clearUploadPreview(input);
      }
    });
  });

  qsa(".upload-card .upload-remove").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const card = button.closest(".upload-card");
      const input = card ? $('input[type="file"]', card) : null;
      clearUploadPreview(input);
    });
  });

  window.addEventListener("beforeunload", () => {
    uploadObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    uploadObjectUrls.clear();
  });

  generationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#generate-button");
    const data = new FormData(generationForm);
    const [width, height] = $("#resolution").value.split("x");

    data.delete("resolution");
    data.set("width", width);
    data.set("height", height);

    if (!$("#generate-audio").checked) {
      data.delete("generate_audio");
    }

    saveGeneratorSettings();
    button.disabled = true;
    try {
      await api("/api/generate", { method: "POST", body: data });
      jobsPage = 1;
      switchView("queue");
      showToast("Задача H3 добавлена в очередь.");
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const dialog = $("#action-dialog");
  const actionForm = $("#action-form");

  const openActionDialog = (mediaId, type) => {
    $("#action-media-id").value = mediaId;
    $("#action-type").value = type;
    const isLipSync = type === "lipsync";

    $("#dialog-kicker").textContent = isLipSync
      ? "LATENTSYNC 1.6"
      : "FFMPEG AUDIO";
    $("#dialog-title").textContent = isLipSync
      ? "LipSync по вокалу"
      : "Наложить аудио";
    $("#audio-label").textContent = isLipSync
      ? "Вокал / песня"
      : "Аудиодорожка";
    $("#lipsync-options").style.display = isLipSync ? "" : "none";
    dialog.showModal();
  };

  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });

  actionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mediaId = $("#action-media-id").value;
    const type = $("#action-type").value;
    const data = new FormData(actionForm);
    data.delete("media_id");
    data.delete("action");

    const endpoint =
      type === "lipsync"
        ? `/api/media/${encodeURIComponent(mediaId)}/lipsync`
        : `/api/media/${encodeURIComponent(mediaId)}/audio`;

    $("#action-submit").disabled = true;
    try {
      await api(endpoint, { method: "POST", body: data });
      dialog.close();
      jobsPage = 1;
      switchView("queue");
      showToast(
        type === "lipsync"
          ? "LipSync добавлен в очередь."
          : "Обработка аудио добавлена в очередь."
      );
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      $("#action-submit").disabled = false;
    }
  });

  const infoDialog = $("#media-info-dialog");

  const profileLabel = (value) =>
    ({ fast: "Fast · Turbo 8", quality: "Quality · Base 20", max: "Max · Base 30" }[
      value
    ] || value || "—");

  const openMediaInfo = (mediaId) => {
    const item = (lastState?.media || []).find((media) => media.id === mediaId);
    if (!item) {
      showToast("Не удалось найти параметры ролика на текущей странице.", "error");
      return;
    }

    const meta = item.meta || {};
    $("#media-info-prompt").value = meta.prompt || "";
    $("#media-info-seed").value =
      meta.seed === undefined || meta.seed === null ? "" : String(meta.seed);

    const rows = [
      ["Тип", kindLabel(item.kind)],
      ["Операция", meta.operation || "—"],
      [
        "Разрешение",
        meta.width && meta.height ? `${meta.width} × ${meta.height}` : "—",
      ],
      ["Длительность задания", meta.seconds ? `${meta.seconds} сек` : "—"],
      ["FPS", meta.fps ?? "—"],
      ["Профиль", profileLabel(meta.profile)],
      ["Нативный звук H3", meta.generate_audio ? "Да" : "Нет"],
      ["Референсов", meta.reference_count ?? "—"],
      ["Длительность файла", humanDuration(item.duration)],
      ["Размер файла", humanBytes(item.size_bytes)],
      ["Создан", shortDate(item.created_at)],
    ];

    $("#media-info-grid").innerHTML = rows
      .map(
        ([label, value]) => `
          <div class="info-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `
      )
      .join("");

    infoDialog.showModal();
  };

  $$("[data-close-info-dialog]").forEach((button) => {
    button.addEventListener("click", () => infoDialog.close());
  });

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  };

  $$("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await copyText(target.value || target.textContent || "");
        showToast("Скопировано.");
      } catch {
        showToast("Не удалось скопировать.", "error");
      }
    });
  });

  $("#media-grid").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const card = target.closest("[data-media-id]");
    const mediaId = card?.dataset.mediaId;
    if (!mediaId) return;

    const action = target.dataset.action;

    if (action === "info") {
      openMediaInfo(mediaId);
      return;
    }

    if (action === "lipsync" || action === "audio") {
      openActionDialog(mediaId, action);
      return;
    }

    if (action === "remove-audio") {
      if (!confirm("Создать отдельную копию ролика без аудиодорожки?")) {
        return;
      }
      try {
        await api(
          `/api/media/${encodeURIComponent(mediaId)}/remove-audio`,
          { method: "POST" }
        );
        jobsPage = 1;
        switchView("queue");
        showToast("Удаление звука добавлено в очередь.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      }
      return;
    }

    if (action === "delete") {
      if (
        !confirm(
          "Удалить этот файл из библиотеки? Производные версии не удаляются."
        )
      ) {
        return;
      }
      try {
        await api(`/api/media/${encodeURIComponent(mediaId)}`, {
          method: "DELETE",
        });
        lastMediaSignature = "";
        showToast("Ролик удалён.");
        await refreshState(true, true);
      } catch (error) {
        showToast(error.message, "error");
      }
    }
  });

  $("#job-list").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-job-action]");
    if (!target) return;

    const action = target.dataset.jobAction;

    if (action === "library") {
      mediaPage = 1;
      lastMediaSignature = "";
      switchView("library");
      await refreshState(true, true);
      return;
    }

    const jobId = target.dataset.jobId;
    if (!jobId) return;

    if (action === "cancel") {
      if (!confirm("Отменить эту задачу?")) return;
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: "POST",
        });
        showToast("Отмена запрошена.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (action === "retry") {
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
          method: "POST",
        });
        jobsPage = 1;
        showToast("Задача повторно добавлена в очередь.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (action === "delete") {
      if (!confirm("Удалить эту запись из очереди?")) return;
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
        });
        showToast("Запись удалена из очереди.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
    }
  });

  setInterval(updateLiveJobTimers, 1000);
  refreshState(true, currentView === "library");
})();
