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
      '<button type="button" data-dialog-editor>В монтаж</button>' +
      '<button type="button" data-dialog-copy><svg class="icon"><use href="/static/icons.svg#icon-copy"></use></svg>Копировать prompt</button>' +
      '<a href="/media/' + encodeURIComponent(item.id) + '?download=1">Скачать</a>' +
      "</div></div>";

    qs("[data-media-dialog-close]", dialog)?.addEventListener("click", () => dialog.close());
    qs("[data-dialog-continue]", dialog)?.addEventListener("click", () => {
      dialog.close();
      window.dispatchEvent(new CustomEvent("v2:use-continue", { detail: { mediaId: item.id } }));
    });
    qs("[data-dialog-editor]", dialog)?.addEventListener("click", () => {
      dialog.close();
      window.dispatchEvent(new CustomEvent("v2:add-editor", { detail: { mediaId: item.id } }));
      api.setView?.("editor");
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

  const renderLibrary = () => {
    const grid = qs("#v2-library-grid");
    const empty = qs("#v2-library-empty");
    const count = qs("#v2-library-count");
    if (!grid) return;

    if (count) count.textContent = W.allMedia.length + " роликов";
    if (empty) empty.hidden = W.allMedia.length > 0;

    const visibleMedia = W.allMedia.slice(0, W.libraryLimit);
    const more = qs("#v2-library-more");
    if (more) more.hidden = visibleMedia.length >= W.allMedia.length;

    grid.innerHTML = visibleMedia.map((item) => {
      const meta = item.meta || {};
      const duration = Number(item.duration || meta.seconds || 0);
      const kind = meta.v2_context?.workspace || meta.operation || item.kind || "video";
      return (
        '<article class="v2-media-card" data-media-id="' + escapeHtml(item.id) + '">' +
        '<video src="/media/' + encodeURIComponent(item.id) + '" preload="metadata" muted playsinline></video>' +
        '<div class="v2-media-card-body">' +
        "<h3>" + escapeHtml(item.title || "Видео") + "</h3>" +
        '<div class="v2-media-meta"><span>' + escapeHtml(W.formatDate(item.created_at)) + "</span>" +
        "<span>" + escapeHtml(duration ? W.formatSeconds(duration) : "—") + "</span>" +
        "<span>" + escapeHtml(W.mediaResolution(item)) + "</span>" +
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
    }).join("");
  };

  qs("#v2-library-refresh")?.addEventListener("click", () => {
    W.libraryLimit = 40;
    W.refreshState();
  });

  qs("#v2-library-more")?.addEventListener("click", () => {
    W.libraryLimit += 40;
    renderLibrary();
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
    } else if (action === "editor") {
      window.dispatchEvent(new CustomEvent("v2:add-editor", { detail: { mediaId: item.id } }));
      api.setView?.("editor");
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