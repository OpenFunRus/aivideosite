(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, fetchJson, showToast, escapeHtml, copyText } = api;

  const detailCell = (label, value) =>
    "<div><span>" + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";

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
      '<button type="button" data-dialog-continue>Продолжить</button>' +
      '<button type="button" data-dialog-copy><svg class="icon"><use href="/static/icons.svg#icon-copy"></use></svg>Копировать prompt</button>' +
      '<a href="/media/' + encodeURIComponent(item.id) + '?download=1">Скачать</a>' +
      "</div></div>";

    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    qs("[data-dialog-continue]", dialog)?.addEventListener("click", () => {
      dialog.close();
      window.dispatchEvent(new CustomEvent("v2:use-continue", { detail: { mediaId: item.id } }));
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
  let page = 1;
  let search = "";
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

  const renderLibrary = () => {
    const grid = qs("#v2-library-grid");
    const empty = qs("#v2-library-empty");
    const count = qs("#v2-library-count");
    if (!grid) return;

    const filtered = W.allMedia.filter((item) =>
      String(item.title || item.filename || "Видео").toLocaleLowerCase("ru-RU").includes(search)
    );
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages);
    if (count) count.textContent = (search ? filtered.length + " из " + W.allMedia.length : W.allMedia.length) + " роликов";
    if (empty) empty.hidden = filtered.length > 0;
    const emptyTitle = qs("#v2-library-empty-title");
    const emptyDescription = qs("#v2-library-empty-description");
    if (emptyTitle) emptyTitle.textContent = search ? "Ничего не найдено" : "Библиотека пока пуста";
    if (emptyDescription) emptyDescription.textContent = search ? "Попробуйте другое название ролика." : "Готовые ролики появятся здесь автоматически.";
    const visibleMedia = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    renderPagination(totalPages);

    grid.innerHTML = visibleMedia.map((item) => {
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
        '<button type="button" data-library-action="continue">' + icon("player-play") + '<span>Продолжить</span></button>' +
        '<button type="button" data-library-action="clip">' + icon("video") + '<span>След. клип</span></button>' +
        '<button class="v2-media-action-delete" type="button" data-library-action="delete" aria-label="Удалить ролик" title="Удалить ролик">' + icon("trash") + '<span>Удалить</span></button>' +
        "</div></div></article>"
      );
    }).join("");
  };

  qs("#v2-library-refresh")?.addEventListener("click", () => {
    W.refreshState();
  });

  qs("#v2-library-search")?.addEventListener("input", (event) => {
    search = event.target.value.trim().toLocaleLowerCase("ru-RU");
    page = 1;
    renderLibrary();
  });

  qs("#v2-library-pages")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-library-page]");
    if (!button || button.disabled) return;
    page = Number(button.dataset.libraryPage) || 1;
    renderLibrary();
    qs("#v2-library-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  qs("#v2-library-grid")?.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-library-action]");
    if (!actionButton) return;
    const card = actionButton.closest("[data-media-id]");
    const item = W.mediaById(card?.dataset.mediaId);
    if (!item) return;
    const action = actionButton.dataset.libraryAction;

    if (action === "open") {
      openMediaDialog(item);
    } else if (action === "continue") {
      window.dispatchEvent(new CustomEvent("v2:use-continue", { detail: { mediaId: item.id } }));
    } else if (action === "clip") {
      window.dispatchEvent(new CustomEvent("v2:use-clip", { detail: { mediaId: item.id } }));
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
