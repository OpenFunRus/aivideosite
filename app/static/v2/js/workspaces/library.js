(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, qsa, fetchJson, showToast, escapeHtml, copyText } = api;

  const detailCell = (label, value) =>
    "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";

  const formatFullDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  };

  const icon = (name) => '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-' + name + '"></use></svg>';
  const generationTime = (item, end = Date.now()) => {
    const start = Date.parse(item.started_at || item.created_at || "");
    if (!Number.isFinite(start)) return "—";
    if (item.finished_at) end = Math.min(end, Date.parse(item.finished_at) || end);
    const paused = Number(item.test_paused_seconds) || 0;
    const pauseStart = item.test_paused ? Date.parse(item.test_paused_at || "") : NaN;
    const elapsed = (Number.isFinite(pauseStart) ? Math.min(end, pauseStart) : end) - start;
    return W.formatSeconds(Math.max(0, elapsed / 1000 - paused));
  };

  const downloadFrame = async (item, position, button = null) => {
    const suffix = position === "final" ? "final" : "start";
    if (button) button.disabled = true;
    try {
      const response = await fetch(
        "/api/media/" + encodeURIComponent(item.id) + "/frame/" + suffix,
        { headers: { "X-Requested-With": "AI-Video-Site-V2" } }
      );
      if (!response.ok) {
        let detail = "HTTP " + response.status;
        try {
          const body = await response.json();
          detail = body.detail || detail;
        } catch {}
        throw new Error(detail);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const base = String(item.title || item.id || "video")
        .replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "video";
      link.href = url;
      link.download = base + (suffix === "final" ? "_final.png" : "_start.png");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(suffix === "final" ? "Финальный кадр сохранён в PNG." : "Стартовый кадр сохранён в PNG.");
    } catch (error) {
      showToast("Не удалось извлечь кадр: " + error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  };

  const openMediaDialog = (item) => {
    const dialog = qs("#v2-media-dialog");
    if (!dialog || !item) return;
    const meta = item.meta || {};
    const prompt = W.mediaPrompt(item) || "Prompt не сохранён";
    dialog.innerHTML =
      '<div class="v2-media-dialog-inner">' +
      '<div class="v2-media-dialog-head"><h3>' + escapeHtml(item.title || "Видео") +
      '</h3><button class="v2-icon-button" type="button" data-media-dialog-close><svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>' +
      '<video src="/media/' + encodeURIComponent(item.id) + '" controls autoplay playsinline></video>' +
      '<div class="v2-media-timing-detail">' + icon("clock") +
      '<span>Запущено: <strong>' + escapeHtml(formatFullDate(meta.generation_started_at || item.created_at)) + '</strong></span>' +
      '<span>Генерировалось: <strong>' + escapeHtml(meta.generation_seconds != null ? W.formatSeconds(meta.generation_seconds) : "—") + '</strong></span></div>' +
      '<div class="v2-media-detail-grid">' +
      detailCell("Дата", W.formatDate(item.created_at)) +
      detailCell("Размер", W.mediaResolution(item)) +
      detailCell("Длительность", W.formatSeconds(item.duration || meta.seconds || 0)) +
      detailCell("Seed", meta.seed ?? "—") +
      detailCell("Шаги", meta.steps ?? "—") +
      detailCell("GPU", meta.gpu_backend || "—") +
      detailCell("Режим", meta.generation_mode || meta.operation || item.kind || "—") +
      detailCell("Звук", meta.generate_audio === false ? "Нет" : "Да") +
      "</div>" +
      '<div class="v2-media-detail-prompt"><span>Prompt</span><p>' + escapeHtml(prompt) + "</p></div>" +
      '<div class="v2-media-actions">' +
      '<button type="button" data-dialog-frame="start"><svg class="icon"><use href="/static/icons.svg#icon-photo"></use></svg>Стартовый кадр</button>' +
      '<button type="button" data-dialog-frame="final"><svg class="icon"><use href="/static/icons.svg#icon-photo"></use></svg>Финальный кадр</button>' +
      '<button type="button" data-dialog-copy><svg class="icon"><use href="/static/icons.svg#icon-copy"></use></svg>Копировать prompt</button>' +
      '<a href="/media/' + encodeURIComponent(item.id) + '?download=1">Скачать</a>' +
      "</div></div>";

    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    qsa("[data-dialog-frame]", dialog).forEach((button) => {
      button.addEventListener("click", () => downloadFrame(item, button.dataset.dialogFrame, button));
    });
    qs("[data-dialog-copy]", dialog)?.addEventListener("click", async () => {
      try {
        await copyText(prompt);
        showToast("Prompt скопирован.");
      } catch {
        showToast("Не удалось скопировать prompt.", "error");
      }
    });
    dialog.showModal();
  };

  W.openMediaDialog = openMediaDialog;

  const PAGE_SIZE = 20;
  const LIBRARY_UI_KEY = "aivideosite-" + api.userId + "-v2-library-ui";
  const savedLibraryUi = W.loadJson(LIBRARY_UI_KEY, {});
  let page = Math.max(1, Number(savedLibraryUi?.page) || 1);
  let searchText = String(savedLibraryUi?.search || "");
  let search = searchText.trim().toLocaleLowerCase("ru-RU");
  let renderedMediaHtml = null;
  const saveLibraryUi = () => W.saveJson(LIBRARY_UI_KEY, { page, search: searchText });
  const searchInput = qs("#v2-library-search");
  if (searchInput) searchInput.value = searchText;
  const pageNumbers = (current, total) => {
    const numbers = new Set([1, total, current - 1, current, current + 1]);
    return [...numbers].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  };

  const renderPagination = (totalPages) => {
    const nav = qs("#v2-library-pagination");
    const buttons = qs("#v2-library-pages");
    if (!nav || !buttons) return;
    nav.hidden = totalPages <= 1;
    if (totalPages <= 1) { buttons.innerHTML = ""; return; }
    const sequence = pageNumbers(page, totalPages);
    let previous = 0;
    let html = '<button type="button" data-library-page="' + (page - 1) + '" ' + (page === 1 ? "disabled" : "") + ' aria-label="Предыдущая страница">‹</button>';
    for (const number of sequence) {
      if (previous && number > previous + 1) html += '<span class="v2-library-page-ellipsis">…</span>';
      html += '<button type="button" data-library-page="' + number + '" ' + (number === page ? 'class="active" aria-current="page"' : "") + '>' + number + '</button>';
      previous = number;
    }
    html += '<button type="button" data-library-page="' + (page + 1) + '" ' + (page === totalPages ? "disabled" : "") + ' aria-label="Следующая страница">›</button>';
    buttons.innerHTML = html;
  };

  const renderGeneratingCard = (job) => {
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    const waiting = job.status === "queued";
    const failed = job.status === "failed";
    const test = Number(job.test_pause_step) > 0;
    const paused = Boolean(job.test_paused);
    const exportJob = job.kind === "editor_export";
    const ready = paused && Number(job.preview_step) === Number(job.test_pause_step) && Boolean(job.preview_mime);
    const statusLabel = failed ? "Ошибка" : waiting ? "В очереди" : paused ? "Ожидает продолжения" : exportJob ? "Экспорт ролика" : test ? "Тестовая генерация" : "Генерация";
    const gpu = exportJob ? "CPU · Монтаж" : job.gpu_target === "rtx2080" ? "RTX 2080" : "RTX 3090";
    return '<article class="v2-media-card v2-generation-card" data-paused="' + paused + '" data-failed="' + failed + '" data-preview-job-id="' + escapeHtml(job.id) + '">' +
      '<div class="v2-media-cover v2-generation-cover">' +
      '<div class="v2-generation-screen"><span class="v2-generation-spinner" aria-hidden="true"></span><strong>' +
      escapeHtml(failed ? 'Ошибка' : paused ? 'Тест · Пауза' : waiting ? 'Ожидание запуска' : exportJob ? 'Экспорт' : 'Генерация') +
      '</strong><b>' + progress + '%</b></div>' +
      '<span class="v2-generation-time">' + icon("clock") + '<span data-generation-timer="' + escapeHtml(job.id) + '">' + escapeHtml(generationTime(job)) + '</span></span>' +
      '<span class="v2-generation-step-badge">' + (exportJob ? 'МОНТАЖ' : test ? 'ТЕСТ · ШАГ ' + escapeHtml(String(job.test_pause_step)) + '/' + escapeHtml(String(job.steps || 8)) : 'MINIMAX H3 · LIVE') + '</span>' +
      '<span class="v2-generation-gpu">' + escapeHtml(gpu) + '</span></div>' +
      '<div class="v2-media-card-body">' +
      '<h3 title="' + escapeHtml(job.title) + '">' + escapeHtml(job.title || "MiniMax H3") + '</h3>' +
      '<div class="v2-media-meta"><span>' + escapeHtml(W.formatDate(job.created_at)) + '</span>' +
      '<span>' + escapeHtml(String(job.seconds || 5)) + ' сек</span>' +
      '<span>' + escapeHtml(statusLabel) + '</span></div>' +
      '<div class="v2-generation-progress"><span style="width:' + progress + '%"></span></div>' +
      '<div class="v2-generation-progress-label"><span>' + escapeHtml(job.stage || "Подготовка") + '</span><b>' + progress + '%</b></div>' +
      (failed ? '<p class="v2-generation-error" title="' + escapeHtml(job.error || '') + '">' + escapeHtml(String(job.error || 'Не удалось выполнить задачу.').slice(0, 160)) + '</p>' : '') +
      '<div class="v2-generation-actions">' +
      (failed ? '<button class="v2-generation-play" type="button" data-library-action="retry">' + icon("refresh") + 'Повторить</button>' +
      '<button class="v2-generation-cancel" type="button" data-library-action="dismiss">' + icon("trash") + 'Убрать ошибку</button>' :
      (paused ? '<button class="v2-generation-play" type="button" data-library-action="preview" ' + (ready ? '' : 'disabled ') + '>' + icon("player-play") + (ready ? 'Посмотреть тест' : 'Готовим тест…') + '</button>' +
      '<button class="v2-generation-play" type="button" data-library-action="continue">' + icon("player-play") + 'Продолжить</button>' : '') +
      '<button class="v2-generation-cancel" type="button" data-library-action="cancel">' + icon("x") + 'Отменить генерацию</button>') +
      '</div></div></article>';
  };

  const previewPlayerHtml = (job) => {
    const previewUrl = "/api/jobs/" + encodeURIComponent(job.id) + "/preview?step=" + Number(job.test_pause_step);
    return job.preview_mime === "video/mp4"
      ? '<video src="' + previewUrl + '" controls autoplay loop playsinline></video>'
      : '<img class="v2-generation-preview-animation" src="' + previewUrl + '" alt="Черновое тестовое видео">';
  };

  const openPreviewDialog = (job) => {
    const dialog = qs("#v2-media-dialog");
    if (!dialog || !job || !job.test_paused || !job.preview_mime) return;
    dialog.innerHTML = '<div class="v2-media-dialog-inner v2-generation-dialog">' +
      '<div class="v2-media-dialog-head"><h3>Тестовая генерация · шаг ' + Number(job.test_pause_step) +
      ' из ' + escapeHtml(String(job.steps || 8)) + '</h3>' +
      '<button class="v2-icon-button" type="button" data-media-dialog-close aria-label="Закрыть">' + icon("x") + '</button></div>' +
      '<div>' + previewPlayerHtml(job) + '</div>' +
      (job.test_audio_ready ? '<div class="v2-test-audio-preview"><strong>Черновая озвучка</strong><audio controls preload="metadata" src="/api/jobs/' + encodeURIComponent(job.id) + '/test-audio"></audio></div>' : '<p class="v2-generation-dialog-note">Черновая озвучка ещё не готова или звук отключён.</p>') +
      '<p class="v2-generation-dialog-note">На промежуточном шаге видео Tiny VAE размыто, а озвучка может содержать шум. Для окончательной оценки нажмите «Продолжить».</p>' +
      '</div>';
    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    dialog.showModal();
  };

  const renderLibraryGpus = () => {
    const root = qs("#v2-library-gpus");
    if (!root || !W.snapshot) return;
    const gpus = W.snapshot.system?.gpus || [];
    root.innerHTML = [0, 1].map((index) => {
      const gpu = gpus.find((item) => Number(item.index) === index);
      const active = W.gpuJob(index);
      const name = gpu?.name || (index === 0 ? "RTX 3090" : "RTX 2080 Ti");
      const util = Math.max(0, Math.min(100, Number(gpu?.utilization) || 0));
      const memory = gpu && Number.isFinite(Number(gpu.memory_total_mb))
        ? (Number(gpu.memory_used_mb || 0) / 1024).toFixed(1) + " / " + (Number(gpu.memory_total_mb) / 1024).toFixed(0) + " GB"
        : "—";
      const footer = active
        ? icon("users") + '<span>Пользователь: <strong>' + escapeHtml(active.user_label || active.owner_id || "—") + '</strong></span>' +
          icon("clock") + '<span>Генерирует: <strong>' + escapeHtml(W.elapsed(active.started_at || active.created_at, W.snapshot.server_now)) + '</strong></span>'
        : icon("clock") + '<span>Ожидает новых задач.</span>';
      return '<article class="v2-queue-gpu' + (active ? ' busy' : '') + '">' +
        '<div class="v2-queue-gpu-head"><span class="v2-queue-gpu-icon">' + icon("gpu") + '</span><div class="v2-queue-gpu-name"><h3>' + escapeHtml(name) + '</h3>' +
        '<div class="v2-queue-gpu-metrics">VRAM ' + escapeHtml(memory) + ' <span>·</span> GPU ' + util + '% <span>·</span> ' + escapeHtml(gpu?.temperature == null ? '—' : gpu.temperature + '°C') + '</div></div>' +
        '<span class="v2-queue-gpu-status">' + (active ? 'Занята' : 'Свободна') + '</span></div>' +
        '<div class="v2-queue-utilization"><span style="width:' + util + '%"></span></div>' +
        '<div class="v2-queue-gpu-job">' + footer + '</div></article>';
    }).join('');
  };

  const libraryJobs = () => {
    const otherJobs = (W.snapshot?.jobs || []).filter((job) =>
      ["generate", "editor_export"].includes(job.kind) &&
      (job.status === "failed" || (job.kind === "editor_export" && ["queued", "running"].includes(job.status)))
    ).map((job) => ({ ...job,
      title: job.payload?.title || job.payload?.user_prompt || job.payload?.prompt || "Экспорт видео",
      test_pause_step: job.payload?.test_pause_step || 0,
      steps: job.payload?.steps || 8,
      seconds: job.payload?.seconds || 5,
    }));
    return (W.snapshot?.library_jobs || []).concat(otherJobs);
  };

  const updateGenerationTimers = () => {
    const jobs = new Map(libraryJobs().map((job) => [String(job.id), job]));
    qsa('[data-generation-timer]', qs('#v2-library-grid') || document).forEach((node) => {
      const job = jobs.get(String(node.dataset.generationTimer));
      if (job) node.textContent = generationTime(job);
    });
  };
  setInterval(updateGenerationTimers, 1000);

  const renderLibrary = () => {
    renderLibraryGpus();
    const grid = qs("#v2-library-grid");
    const empty = qs("#v2-library-empty");
    const count = qs("#v2-library-count");
    if (!grid) return;

    const filtered = W.allMedia.filter((item) =>
      String(item.title || item.filename || "Видео").toLocaleLowerCase("ru-RU").includes(search)
    );
    const generating = libraryJobs().filter((job) =>
      String(job.title || "MiniMax H3").toLocaleLowerCase("ru-RU").includes(search)
    );
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages);
    if (count) count.textContent = (search ? filtered.length + " из " + W.allMedia.length : W.allMedia.length) + " видео" + (generating.length ? " · " + generating.length + " в работе" : "");
    if (empty) empty.hidden = filtered.length + generating.length > 0;
    const emptyTitle = qs("#v2-library-empty-title");
    const emptyDescription = qs("#v2-library-empty-description");
    if (emptyTitle) emptyTitle.textContent = search ? "Ничего не найдено" : "Библиотека пока пуста";
    if (emptyDescription) emptyDescription.textContent = search ? "Попробуйте другое название ролика." : "Готовые ролики появятся здесь автоматически.";
    const visibleMedia = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    renderPagination(totalPages);

    const mediaHtml = visibleMedia.map((item) => {
      const meta = item.meta || {};
      const duration = Number(item.duration || meta.seconds || 0);
      const kind = meta.v2_context?.workspace || meta.operation || item.kind || "video";
      return (
        '<article class="v2-media-card" data-media-id="' + escapeHtml(item.id) + '">' +
        '<div class="v2-media-cover"><video src="/media/' + encodeURIComponent(item.id) + '" preload="metadata" muted playsinline></video>' +
        '<span class="v2-media-generation-time">' + icon("clock") + escapeHtml(meta.generation_seconds != null ? W.formatSeconds(meta.generation_seconds) : "—") + '</span>' +
        '<span class="v2-media-duration">' + icon("video") + escapeHtml(duration ? W.formatSeconds(duration) : "—") + '</span></div>' +
        '<div class="v2-media-card-body">' +
        "<h3>" + escapeHtml(item.title || "Видео") + "</h3>" +
        '<div class="v2-media-meta"><span>' + escapeHtml(W.formatDate(item.created_at)) + "</span>" +
        "<span>" + escapeHtml(duration ? W.formatSeconds(duration) : "—") + "</span>" +
        "<span>" + escapeHtml(W.mediaResolution(item)) + "</span>" +
        "<span>" + escapeHtml(kind) + "</span></div>" +
        '<div class="v2-media-actions">' +
        '<button class="v2-media-action-open" type="button" data-library-action="open">' + icon("player-play") + '<span>Открыть</span></button>' +
        '<a href="/media/' + encodeURIComponent(item.id) + '?download=1">' + icon("download") + '<span>Скачать</span></a>' +
        '<button type="button" data-library-action="frame-start">' + icon("photo") + '<span>Стартовый кадр</span></button>' +
        '<button type="button" data-library-action="frame-final">' + icon("photo") + '<span>Финальный кадр</span></button>' +
        '<button class="v2-media-action-delete" type="button" data-library-action="delete" aria-label="Удалить ролик" title="Удалить ролик">' + icon("trash") + '<span>Удалить</span></button>' +
        "</div></div></article>"
      );
    }).join("");
    const generatingHtml = generating.map(renderGeneratingCard).join("");
    if (renderedMediaHtml !== mediaHtml) {
      grid.innerHTML = generatingHtml + mediaHtml;
      renderedMediaHtml = mediaHtml;
    } else {
      // Preserve completed video elements while refreshing running cards.
      const existing = new Map(Array.from(grid.querySelectorAll(":scope > .v2-generation-card"))
        .map((card) => [card.dataset.previewJobId, card]));
      const template = document.createElement("template");
      template.innerHTML = generatingHtml;
      const cards = Array.from(template.content.children);
      for (const card of cards) {
        const old = existing.get(card.dataset.previewJobId);
        if (!old) continue;
        old.replaceWith(card);
        existing.delete(card.dataset.previewJobId);
      }
      existing.forEach((card) => card.remove());
      for (let index = cards.length - 1; index >= 0; index--) grid.prepend(cards[index]);
    }
    updateGenerationTimers();
  };

  qs("#v2-library-refresh")?.addEventListener("click", () => {
    W.refreshState();
  });

  searchInput?.addEventListener("input", (event) => {
    searchText = event.target.value;
    search = searchText.trim().toLocaleLowerCase("ru-RU");
    page = 1;
    saveLibraryUi();
    renderLibrary();
  });

  qs("#v2-library-pages")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-library-page]");
    if (!button || button.disabled) return;
    page = Number(button.dataset.libraryPage) || 1;
    saveLibraryUi();
    renderLibrary();
    qs("#v2-library-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  qs("#v2-library-grid")?.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-library-action]");
    if (!actionButton) return;
    const jobCard = actionButton.closest("[data-preview-job-id]");
    if (jobCard) {
      const job = libraryJobs().find((item) => String(item.id) === jobCard.dataset.previewJobId);
      if (!job) return;
      if (actionButton.dataset.libraryAction === "preview") {
        openPreviewDialog(job);
      } else if (actionButton.dataset.libraryAction === "retry" || actionButton.dataset.libraryAction === "dismiss") {
        actionButton.disabled = true;
        try {
          const retry = actionButton.dataset.libraryAction === "retry";
          await fetchJson("/api/jobs/" + encodeURIComponent(job.id) + (retry ? "/retry" : ""), { method: retry ? "POST" : "DELETE" });
          showToast(retry ? "Повторная задача запущена." : "Запись об ошибке удалена.");
          await W.refreshState({ silent: true });
        } catch (error) {
          showToast("Не удалось выполнить действие: " + error.message, "error");
          actionButton.disabled = false;
        }
      } else if (actionButton.dataset.libraryAction === "continue") {
        actionButton.disabled = true;
        try {
          await fetchJson("/api/jobs/" + encodeURIComponent(job.id) + "/continue", { method: "POST" });
          showToast("Тестовая генерация продолжена.");
          await W.refreshState({ silent: true });
        } catch (error) {
          showToast("Не удалось продолжить: " + error.message, "error");
          actionButton.disabled = false;
        }
      } else if (actionButton.dataset.libraryAction === "cancel") {
        if (!confirm("Отменить генерацию? Карточка исчезнет из Библиотеки.")) return;
        actionButton.disabled = true;
        try {
          await fetchJson("/api/jobs/" + encodeURIComponent(job.id) + "/cancel", { method: "POST" });
          showToast("Генерация отменяется.");
          await W.refreshState({ silent: true });
        } catch (error) {
          showToast("Не удалось отменить: " + error.message, "error");
          actionButton.disabled = false;
        }
      }
      return;
    }
    const card = actionButton.closest("[data-media-id]");
    const item = W.mediaById(card?.dataset.mediaId);
    if (!item) return;
    const action = actionButton.dataset.libraryAction;

    if (action === "open") {
      openMediaDialog(item);
    } else if (action === "frame-start") {
      await downloadFrame(item, "start", actionButton);
    } else if (action === "frame-final") {
      await downloadFrame(item, "final", actionButton);
    } else if (action === "delete") {
      if (!confirm("Удалить этот ролик из Библиотеки?")) return;
      actionButton.disabled = true;
      try {
        await fetchJson("/api/media/" + encodeURIComponent(item.id), { method: "DELETE" });
        showToast("Ролик удалён.");
        await W.refreshState({ silent: true });
      } catch (error) {
        showToast("Не удалось удалить: " + error.message, "error");
      } finally {
        actionButton.disabled = false;
      }
    }
  });

  qs("#v2-media-dialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  window.addEventListener("v2:datarefresh", renderLibrary);
})();
