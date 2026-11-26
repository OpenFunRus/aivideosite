(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, qsa, fetchJson, showToast, escapeHtml, copyText } = api;

  const detailCell = (label, value) =>
    "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";

  let activePreviewJobId = null;
  let displayedPreviewStep = 0;
  let displayedPreviewMime = "";

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
    activePreviewJobId = null;
    const meta = item.meta || {};
    const prompt = W.mediaPrompt(item) || "Prompt не сохранён";
    dialog.innerHTML =
      '<div class="v2-media-dialog-inner">' +
      '<div class="v2-media-dialog-head"><h3>' + escapeHtml(item.title || "Видео") +
      '</h3><button class="v2-icon-button" type="button" data-media-dialog-close><svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>' +
      '<video src="/media/' + encodeURIComponent(item.id) + '" controls autoplay playsinline></video>' +
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
  const icon = (name) => '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-' + name + '"></use></svg>';
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
    const step = Math.max(0, Number(job.preview_step) || 0);
    const ready = step >= 2 && Boolean(job.preview_mime);
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    const waiting = job.status === "queued";
    const unavailable = !waiting && !job.preview_enabled && progress >= 10;
    const statusLabel = waiting ? "В очереди" : ready ? "Предпросмотр готов" : unavailable ? "Без предпросмотра" : "Генерация";
    const previewLabel = ready ? "Воспроизвести шаг " + step : unavailable ? "Превью не подключено" : "Ожидаем шаг 2";
    const gpu = job.gpu_target === "rtx2080" ? "RTX 2080" : "RTX 3090";
    return '<article class="v2-media-card v2-generation-card" data-preview-job-id="' + escapeHtml(job.id) + '">' +
      '<div class="v2-media-cover v2-generation-cover">' +
      '<div class="v2-generation-ambient" aria-hidden="true"></div>' +
      '<div class="v2-generation-cover-content">' +
      '<span class="v2-generation-kicker">' + icon("bolt") + 'MINIMAX H3 · LIVE</span>' +
      '<span class="v2-generation-symbol">' + icon(waiting ? "clock" : "video") + '</span>' +
      '<strong>' + escapeHtml(statusLabel) + '</strong>' +
      '<span>' + escapeHtml(waiting ? "Ожидает свободную видеокарту" : ready ? "Промежуточное видео · шаг " + step : unavailable ? "Нужен Tiny VAE и Preview Override" : "Видео появится после шага 2") + '</span>' +
      '</div><span class="v2-generation-gpu">' + escapeHtml(gpu) + '</span></div>' +
      '<div class="v2-media-card-body">' +
      '<h3 title="' + escapeHtml(job.title) + '">' + escapeHtml(job.title || "MiniMax H3") + '</h3>' +
      '<div class="v2-media-meta"><span>' + escapeHtml(W.formatDate(job.created_at)) + '</span>' +
      '<span>' + escapeHtml(String(job.seconds || 5)) + ' сек</span>' +
      '<span>' + escapeHtml(statusLabel) + '</span></div>' +
      '<div class="v2-generation-progress"><span style="width:' + progress + '%"></span></div>' +
      '<div class="v2-generation-progress-label"><span>' + escapeHtml(job.stage || "Подготовка") + '</span><b>' + progress + '%</b></div>' +
      '<div class="v2-generation-actions">' +
      '<button class="v2-generation-play" type="button" data-library-action="preview" ' + (ready ? '' : 'disabled ') + '>' + icon("player-play") + escapeHtml(previewLabel) + '</button>' +
      '<button class="v2-generation-cancel" type="button" data-library-action="cancel">' + icon("x") + 'Отменить генерацию</button>' +
      '</div></div></article>';
  };

  const previewPlayerHtml = (job) => {
    const previewUrl = "/api/jobs/" + encodeURIComponent(job.id) + "/preview?step=" + Number(job.preview_step);
    return job.preview_mime === "video/mp4"
      ? '<video src="' + previewUrl + '" controls autoplay loop playsinline></video>'
      : '<img class="v2-generation-preview-animation" src="' + previewUrl + '" alt="Анимированный предпросмотр видео">';
  };

  const openPreviewDialog = (job) => {
    const dialog = qs("#v2-media-dialog");
    if (!dialog || !job || Number(job.preview_step) < 2) return;
    activePreviewJobId = String(job.id);
    displayedPreviewStep = Number(job.preview_step);
    displayedPreviewMime = String(job.preview_mime || "");
    dialog.innerHTML = '<div class="v2-media-dialog-inner v2-generation-dialog">' +
      '<div class="v2-media-dialog-head"><h3 data-generation-preview-title>Предпросмотр · шаг ' + Number(job.preview_step) +
      ' из ' + escapeHtml(String(job.steps || 8)) + '</h3>' +
      '<button class="v2-icon-button" type="button" data-media-dialog-close aria-label="Закрыть">' + icon("x") + '</button></div>' +
      '<div data-generation-preview-player>' + previewPlayerHtml(job) + '</div>' +
      '<p class="v2-generation-dialog-note">Предпросмотр автоматически обновляется на шагах 2, 4, 6, 8. Tiny VAE показывает грубую картинку даже на последнем шаге; чёткий результат появится после финального декодирования.</p>' +
      '</div>';
    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    dialog.showModal();
  };

  const updateOpenPreviewDialog = () => {
    if (!activePreviewJobId) return;
    const dialog = qs("#v2-media-dialog");
    if (!dialog?.open) return;
    const job = (W.snapshot?.library_jobs || []).find((item) => String(item.id) === activePreviewJobId);
    if (!job || Number(job.preview_step) < 2) return;
    const step = Number(job.preview_step);
    const mime = String(job.preview_mime || "");
    if (step <= displayedPreviewStep && mime === displayedPreviewMime) return;
    displayedPreviewStep = step;
    displayedPreviewMime = mime;
    const title = qs("[data-generation-preview-title]", dialog);
    if (title) title.textContent = "Предпросмотр · шаг " + step + " из " + String(job.steps || 8);
    const player = qs("[data-generation-preview-player]", dialog);
    if (player) player.innerHTML = previewPlayerHtml(job);
  };

  const renderLibrary = () => {
    const grid = qs("#v2-library-grid");
    const empty = qs("#v2-library-empty");
    const count = qs("#v2-library-count");
    if (!grid) return;

    const filtered = W.allMedia.filter((item) =>
      String(item.title || item.filename || "Видео").toLocaleLowerCase("ru-RU").includes(search)
    );
    const generating = (W.snapshot?.library_jobs || []).filter((job) =>
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
      // Poll live progress without rebuilding finished video elements: that
      // would repeatedly restart their metadata loading every four seconds.
      grid.querySelectorAll(":scope > .v2-generation-card").forEach((card) => card.remove());
      if (generatingHtml) grid.insertAdjacentHTML("afterbegin", generatingHtml);
    }
    updateOpenPreviewDialog();
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
      const job = (W.snapshot?.library_jobs || []).find((item) => String(item.id) === jobCard.dataset.previewJobId);
      if (!job) return;
      if (actionButton.dataset.libraryAction === "preview") {
        openPreviewDialog(job);
      } else if (actionButton.dataset.libraryAction === "cancel") {
        if (!confirm("Отменить генерацию? Карточка и предпросмотр исчезнут из Библиотеки.")) return;
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
  qs("#v2-media-dialog")?.addEventListener("close", () => {
    activePreviewJobId = null;
    displayedPreviewStep = 0;
    displayedPreviewMime = "";
  });

  window.addEventListener("v2:datarefresh", renderLibrary);
})();
