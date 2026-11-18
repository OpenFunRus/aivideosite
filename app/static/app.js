(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const appPage = $(".app-page");
  if (!appPage) return;

  let stateTimer = null;
  let lastState = null;
  let lastMediaSignature = "";
  let mediaPage = 1;
  let jobsPage = 1;
  let currentView = localStorage.getItem("aivideosite-view") || "generate";

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
    return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
  };

  const jobElapsed = (job) => {
    if (!job.started_at) return null;
    const start = new Date(job.started_at).getTime();
    const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, (end - start) / 1000);
  };

  const switchView = (view, refresh = false) => {
    if (!["generate", "library", "queue"].includes(view)) view = "generate";
    currentView = view;
    localStorage.setItem("aivideosite-view", view);

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
      $("#metric-gpu").textContent = (gpu.name || "RTX 3090").replace("NVIDIA GeForce ", "");
      $("#metric-vram").textContent =
        `${(gpu.memory_used_mb / 1024).toFixed(1)} / ${(gpu.memory_total_mb / 1024).toFixed(0)} GB VRAM`;
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

  const kindLabel = (kind) => ({
    generated: "H3",
    lipsync: "LipSync",
    audio: "Audio",
    silent: "Silent",
  }[kind] || kind);

  const mediaSignature = (media) =>
    (media || []).map((item) => `${item.id}:${item.size_bytes}:${item.created_at}`).join("|");

  const libraryHasPlayingVideo = () =>
    $$("#media-grid video").some((video) => !video.paused && !video.ended);

  const renderMedia = (media) => {
    const grid = $("#media-grid");
    const empty = $("#media-empty");
    empty.classList.toggle("show", !media.length);

    grid.innerHTML = media.map((item) => {
      const meta = item.meta || {};
      const details = [];
      if (meta.width && meta.height) details.push(`${meta.width}×${meta.height}`);
      if (meta.profile) {
        const profile = { fast: "Fast", quality: "Quality", max: "Max" }[meta.profile] || meta.profile;
        details.push(profile);
      }
      if (meta.fps) details.push(`${meta.fps} FPS`);
      if (meta.seed !== undefined && meta.seed !== null) details.push(`seed ${meta.seed}`);
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
              <span class="badge badge-blue">${escapeHtml(kindLabel(item.kind))}</span>
              <h3 class="media-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
            </div>
            <div class="media-meta">
              <span>${escapeHtml(shortDate(item.created_at))}</span>
              ${details.filter(Boolean).map((detail) => `<span>· ${escapeHtml(detail)}</span>`).join("")}
            </div>
            <div class="media-actions">
              <button type="button" data-action="lipsync" title="LipSync">
                ${icon("microphone")}
              </button>
              <button type="button" data-action="audio" title="Наложить аудио">
                ${icon("music")}
              </button>
              <button type="button" data-action="remove-audio" title="Убрать звук">
                ${icon("volume-off")}
              </button>
              <a href="/media/${encodeURIComponent(item.id)}?download=1" title="Скачать">
                ${icon("download")}
              </a>
              <button class="danger" type="button" data-action="delete" title="Удалить">
                ${icon("trash")}
              </button>
            </div>
          </div>
        </article>
      `;
    }).join("");
  };

  const jobLabel = (kind) => ({
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
        <button class="btn btn-danger btn-compact" type="button" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">
          ${icon("x")} Отменить
        </button>
      `;
    }
    if (job.status === "failed") {
      return `
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="retry" data-job-id="${escapeHtml(job.id)}">
          ${icon("refresh")} Повторить
        </button>
      `;
    }
    if (job.status === "done" && job.result_media_id) {
      return `
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="library" data-media-id="${escapeHtml(job.result_media_id)}">
          ${icon("library")} Открыть библиотеку
        </button>
      `;
    }
    return "";
  };

  const renderJobs = (jobs) => {
    const list = $("#job-list");
    const empty = $("#job-empty");
    empty.classList.toggle("show", !jobs.length);

    list.innerHTML = jobs.map((job) => {
      const payload = job.payload || {};
      const prompt = job.kind === "generate" ? payload.prompt || "" : "";
      const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
      const elapsed = jobElapsed(job);
      const progressText = job.status === "running"
        ? `≈ ${Math.round(progress)}%`
        : `${Math.round(progress)}%`;

      return `
        <article class="job-card" data-job-id="${escapeHtml(job.id)}">
          <div class="job-top">
            <div class="job-name">
              <span class="metric-icon job-icon">
                ${icon(job.kind === "generate" ? "wand" : job.kind === "lipsync" ? "microphone" : "settings")}
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
            <span><b>Начало:</b> ${job.started_at ? escapeHtml(shortDate(job.started_at)) : "—"}</span>
            <span><b>Время:</b> ${elapsed === null ? "—" : formatHms(elapsed)}</span>
            <span><b>Прогресс:</b> ${progressText}</span>
          </div>

          <div class="job-progress" style="--progress:${progress}%">
            <span></span>
          </div>

          ${job.error ? `<pre class="job-error">${escapeHtml(job.error)}</pre>` : ""}
          <div class="job-actions">${jobActions(job)}</div>
        </article>
      `;
    }).join("");
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
      <button type="button" data-page-target="${target}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>
        ←
      </button>
      <span class="pagination-info">Страница <strong>${page}</strong> из ${pages} · ${pagination.total} записей</span>
      <button type="button" data-page-target="${target}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>
        →
      </button>
    `;
  };

  const refreshState = async (quiet = true, forceMedia = false) => {
    try {
      const state = await api(
        `/api/state?media_page=${mediaPage}&jobs_page=${jobsPage}`
      );
      lastState = state;

      mediaPage = Number(state.media_pagination?.page || mediaPage);
      jobsPage = Number(state.jobs_pagination?.page || jobsPage);

      renderSystem(state);
      renderJobs(state.jobs || []);
      renderPagination("#job-pagination", state.jobs_pagination, "jobs");
      renderPagination("#media-pagination", state.media_pagination, "media");

      const signature = mediaSignature(state.media || []);
      const safeToRenderMedia = forceMedia || !libraryHasPlayingVideo();
      if (safeToRenderMedia && (forceMedia || signature !== lastMediaSignature)) {
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

  const secondsRange = $("#seconds-range");
  const secondsValue = $("#seconds-value");
  if (secondsRange && secondsValue) {
    const updateSeconds = () => {
      secondsValue.textContent = `${secondsRange.value} сек`;
    };
    secondsRange.addEventListener("input", updateSeconds);
    updateSeconds();
  }

  $$(".upload-card input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const label = input.closest(".upload-card");
      const name = $(".upload-name", label);
      name.textContent = input.files?.[0]?.name || "Выбрать изображение";
    });
  });

  $("#generate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("#generate-button");
    const data = new FormData(form);
    const [width, height] = $("#resolution").value.split("x");

    data.delete("resolution");
    data.set("width", width);
    data.set("height", height);

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

    $("#dialog-kicker").textContent = isLipSync ? "LATENTSYNC 1.6" : "FFMPEG AUDIO";
    $("#dialog-title").textContent = isLipSync ? "LipSync по вокалу" : "Наложить аудио";
    $("#audio-label").textContent = isLipSync ? "Вокал / песня" : "Аудиодорожка";
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

    const endpoint = type === "lipsync"
      ? `/api/media/${encodeURIComponent(mediaId)}/lipsync`
      : `/api/media/${encodeURIComponent(mediaId)}/audio`;

    $("#action-submit").disabled = true;
    try {
      await api(endpoint, { method: "POST", body: data });
      dialog.close();
      jobsPage = 1;
      switchView("queue");
      showToast(type === "lipsync"
        ? "LipSync добавлен в очередь."
        : "Обработка аудио добавлена в очередь.");
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      $("#action-submit").disabled = false;
    }
  });

  $("#media-grid").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const card = target.closest("[data-media-id]");
    const mediaId = card?.dataset.mediaId;
    if (!mediaId) return;

    const action = target.dataset.action;
    if (action === "lipsync" || action === "audio") {
      openActionDialog(mediaId, action);
      return;
    }

    if (action === "remove-audio") {
      if (!confirm("Создать отдельную копию ролика без аудиодорожки?")) return;
      try {
        await api(`/api/media/${encodeURIComponent(mediaId)}/remove-audio`, {
          method: "POST",
        });
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
      if (!confirm("Удалить этот файл из библиотеки? Производные версии не удаляются.")) return;
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
    }
  });

  refreshState(true, currentView === "library");
})();
