(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, userId, qs, qsa, fetchJson, showToast, escapeHtml } = api;

  const form = qs("#v2-image-form");
  const prompt = qs("#v2-image-prompt");
  const count = qs("#v2-image-prompt-count");
  const title = qs("#v2-image-prompt-title");
  const help = qs("#v2-image-prompt-help");
  const seed = qs("#v2-image-seed");
  const wand = qs("#v2-image-wand");
  const grid = qs("#v2-image-results-grid");
  const status = qs("#v2-image-results-status");
  const button = qs("#v2-image-generate");
  const buttonLabel = qs("#v2-image-generate-label");
  const warning = qs("#v2-image-warning");
  const storageKey = "aivideosite-" + userId + "-v2-image-draft";

  let results = [];
  let selectedImageId = "";
  let pollTimer = null;
  let submitting = false;

  const imageSettingValue = (name, fallback) =>
    String(qs('[data-image-setting="' + name + '"] button.active')?.dataset.value || fallback);

  const applyImageSegment = (name, value, save = true) => {
    const group = qs('[data-image-setting="' + name + '"]');
    if (!group) return;
    const buttons = qsa("[data-value]", group);
    const target = buttons.find((item) => item.dataset.value === String(value)) || buttons[0];
    buttons.forEach((item) => item.classList.toggle("active", item === target));
    if (save) saveLocal();
  };

  const currentImageAssistantSettings = () => ({
    workspace: "images",
    prompt: String(prompt?.value || ""),
    quality: imageSettingValue("quality", "720"),
    resolution_shape: imageSettingValue("ratio", "16:9"),
    seed: String(seed?.value || "").trim() ? Number(seed.value) : -1,
    image_mode: selectedImageId ? "edit" : (
      (state.selectedCharacterIds?.size || state.selectedLocationIds?.size || state.selectedMiscIds?.size)
        ? "reference"
        : "generate"
    ),
    source_image_selected: Boolean(selectedImageId),
    selected_character_ids: Array.from(state.selectedCharacterIds || []).map(String),
    selected_location_ids: Array.from(state.selectedLocationIds || []).map(String),
    selected_misc_ids: Array.from(state.selectedMiscIds || []).map(String),
  });

  api.currentImageAssistantSettings = currentImageAssistantSettings;

  const saveLocal = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        prompt: prompt?.value || "",
        quality: imageSettingValue("quality", "720"),
        ratio: imageSettingValue("ratio", "16:9"),
        seed: seed?.value || "",
      }));
    } catch {}
  };

  const loadLocal = () => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (prompt && typeof value.prompt === "string") prompt.value = value.prompt;
      applyImageSegment("quality", value.quality || "720", false);
      applyImageSegment("ratio", value.ratio || "16:9", false);
      if (seed && value.seed !== undefined && value.seed !== null) seed.value = String(value.seed);
    } catch {}
  };

  const updatePromptMode = () => {
    const editing = Boolean(selectedImageId);
    if (title) title.textContent = editing ? "Что нужно изменить в изображении?" : "Что должно быть на изображении?";
    if (prompt) {
      prompt.placeholder = editing
        ? "Опишите только нужные изменения. Выбранное изображение станет Picture 1, остальное H3 Image постарается сохранить."
        : "Опишите обычным языком: кто в кадре, где находится, поза, одежда, предметы, свет, камера и атмосфера.";
    }
    if (help) {
      help.textContent = editing
        ? "Режим перерисовки включён автоматически. Снимите галку с результата, чтобы снова создавать изображение с нуля."
        : "Выбранные справа персонажи, локации и прочее используются как референсы H3 Image.";
    }
    if (buttonLabel) buttonLabel.textContent = editing ? "Перерисовать изображение" : "Сгенерировать изображение";
  };

  const imageClass = (item) => {
    const w = Number(item.width || 0);
    const h = Number(item.height || 0);
    if (w && h && Math.abs(w - h) < 8) return " is-square";
    if (h > w) return " is-portrait";
    return "";
  };

  const render = () => {
    if (!grid) return;
    if (!results.length) {
      grid.innerHTML = '<div class="v2-image-results-empty">Здесь появятся сгенерированные изображения.</div>';
      updatePromptMode();
      return;
    }
    grid.innerHTML = results.map((item) => {
      const id = String(item.id || "");
      const selected = id === selectedImageId;
      const resolution = (item.width || "?") + " × " + (item.height || "?");
      return (
        '<article class="v2-image-result' + (selected ? ' selected' : '') + imageClass(item) + '" data-image-result="' + escapeHtml(id) + '">' +
          '<div class="v2-image-result-head">' +
            '<button class="v2-image-select-source" type="button" data-image-select="' + escapeHtml(id) + '" title="' + (selected ? 'Выключить перерисовку' : 'Перерисовать это изображение') + '">' +
              '<svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg>' +
            '</button>' +
            '<span class="v2-image-result-meta">' + escapeHtml(resolution) + '</span>' +
          '</div>' +
          '<div class="v2-image-result-preview">' +
            '<img src="' + escapeHtml(item.url) + '" alt="Результат H3 Image" loading="lazy">' +
            '<div class="v2-image-result-actions">' +
              '<button class="v2-image-result-action frame" type="button" data-image-frame="first" data-image-id="' + escapeHtml(id) + '" title="Поставить как начальный кадр">1</button>' +
              '<button class="v2-image-result-action frame" type="button" data-image-frame="last" data-image-id="' + escapeHtml(id) + '" title="Поставить как конечный кадр">2</button>' +
              '<a class="v2-image-result-action" href="' + escapeHtml(item.download_url) + '" download title="Скачать"><svg class="icon"><use href="/static/icons.svg#icon-download"></use></svg></a>' +
              '<button class="v2-image-result-action danger" type="button" data-image-delete="' + escapeHtml(id) + '" title="Удалить"><svg class="icon"><use href="/static/icons.svg#icon-trash"></use></svg></button>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join("");
    updatePromptMode();
  };

  const refresh = async () => {
    try {
      const data = await fetchJson("/api/v2/images");
      results = Array.isArray(data.images) ? data.images : [];
      if (selectedImageId && !results.some((item) => String(item.id) === selectedImageId)) selectedImageId = "";
      const active = data.active_job;
      if (status) {
        status.classList.toggle("running", Boolean(active));
        status.textContent = active
          ? (active.status === "queued" ? "Изображение в очереди…" : (active.stage || "H3 Image генерирует…"))
          : "До 8 изображений · новые появляются первыми";
      }
      render();
    } catch (error) {
      if (status) status.textContent = "Не удалось обновить результаты";
    }
  };

  const installFrame = async (imageId, slot) => {
    const input = qs(slot === "first" ? "#v2-first-frame" : "#v2-last-frame");
    if (!input || typeof DataTransfer === "undefined") {
      showToast("Браузер не позволяет передать кадр в форму видео.", "error");
      return;
    }
    try {
      const response = await fetch("/api/v2/images/" + encodeURIComponent(imageId) + "/file", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const blob = await response.blob();
      const file = new File([blob], "h3-image-" + imageId + ".png", { type: blob.type || "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      api.setView?.("create");
      showToast(slot === "first" ? "Изображение поставлено как начальный кадр." : "Изображение поставлено как конечный кадр.");
    } catch (error) {
      showToast("Не удалось передать изображение в видео: " + error.message, "error");
    }
  };

  grid?.addEventListener("click", async (event) => {
    const select = event.target.closest("[data-image-select]");
    if (select) {
      const id = String(select.dataset.imageSelect || "");
      selectedImageId = selectedImageId === id ? "" : id;
      render();
      return;
    }

    const frame = event.target.closest("[data-image-frame]");
    if (frame) {
      await installFrame(String(frame.dataset.imageId || ""), String(frame.dataset.imageFrame || ""));
      return;
    }

    const remove = event.target.closest("[data-image-delete]");
    if (remove) {
      const id = String(remove.dataset.imageDelete || "");
      try {
        await fetchJson("/api/v2/images/" + encodeURIComponent(id), { method: "DELETE" });
        if (selectedImageId === id) selectedImageId = "";
        await refresh();
        showToast("Изображение удалено.");
      } catch (error) {
        showToast("Не удалось удалить изображение: " + error.message, "error");
      }
    }
  });

  prompt?.addEventListener("input", () => {
    if (count) count.textContent = (prompt.value || "").length.toLocaleString("ru-RU") + " / 16 000";
    saveLocal();
  });
  qsa("[data-image-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const target = event.target.closest("[data-value]");
      if (!target) return;
      applyImageSegment(group.dataset.imageSetting, target.dataset.value);
    });
  });
  seed?.addEventListener("input", saveLocal);

  wand?.addEventListener("click", async () => {
    const source = (prompt?.value || "").trim();
    if (!source) {
      showToast(selectedImageId ? "Сначала опишите, что нужно изменить." : "Сначала опишите изображение.", "error");
      prompt?.focus();
      return;
    }

    wand.disabled = true;
    showToast(selectedImageId ? "ИИ готовит точную инструкцию перерисовки…" : "ИИ улучшает prompt для H3 Image…");
    try {
      const instruction = selectedImageId
        ? (
          "Перепиши запрос именно для MiniMax H3 Image REDRAW/EDIT. " +
          "Выбрано одно исходное изображение, backend сам сделает его edit target / Picture 1. " +
          "Верни только чистую инструкцию изменения на английском без Shot-блоков, таймингов, audio-полей, JSON и без выдуманных Picture-номеров. " +
          "Сохрани всё, что пользователь не просил менять: identity, одежду, окружение, композицию, камеру и свет. " +
          "Учитывай выбранные справа Characters, Locations и Misc как реальные image references. Не меняй настройки формы."
        )
        : (
          "Перепиши запрос именно для MiniMax H3 Image. " +
          "Верни только один готовый still-image prompt на английском без Shot-блоков, таймингов, audio-полей, JSON и без выдуманных Picture-номеров. " +
          "Приоритет: точное следование запросу, фотореализм если стиль не указан, естественная анатомия, стабильные лица и понятная композиция. " +
          "Учитывай выбранные справа Characters, Locations и Misc как реальные image references. Не меняй настройки формы."
        );

      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: instruction + "\n\nUSER IMAGE REQUEST:\n" + source }],
          settings: currentImageAssistantSettings(),
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (typeof improved !== "string" || !improved.trim()) {
        throw new Error(result?.message || "ИИ не вернул image prompt.");
      }
      prompt.value = improved.trim();
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      showToast(selectedImageId ? "Инструкция перерисовки улучшена." : "Prompt улучшен под MiniMax H3 Image.");
    } catch (error) {
      showToast("Не удалось улучшить image prompt: " + error.message, "error");
    } finally {
      wand.disabled = false;
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const text = (prompt?.value || "").trim();
    if (!text) {
      showToast(selectedImageId ? "Опишите, что нужно изменить." : "Опишите изображение.", "error");
      prompt?.focus();
      return;
    }

    const data = new FormData();
    data.set("prompt", text);
    data.set("quality", imageSettingValue("quality", "720"));
    data.set("ratio", imageSettingValue("ratio", "16:9"));
    data.set("seed", seed?.value || "");
    data.set("source_image_id", selectedImageId);
    data.set("character_ids", JSON.stringify(Array.from(state.selectedCharacterIds || [])));
    data.set("location_ids", JSON.stringify(Array.from(state.selectedLocationIds || [])));
    data.set("misc_ids", JSON.stringify(Array.from(state.selectedMiscIds || [])));

    submitting = true;
    if (button) button.disabled = true;
    const oldLabel = buttonLabel?.textContent || "";
    if (buttonLabel) buttonLabel.textContent = "Добавляем в очередь…";
    if (warning) warning.hidden = true;
    try {
      await fetchJson("/api/v2/images/generate", { method: "POST", body: data });
      showToast(selectedImageId ? "Перерисовка добавлена в очередь RTX2080." : "Генерация добавлена в очередь RTX2080.");
      await refresh();
    } catch (error) {
      if (warning) {
        warning.textContent = error.message;
        warning.hidden = false;
      }
      showToast("Не удалось запустить H3 Image: " + error.message, "error");
    } finally {
      submitting = false;
      if (button) button.disabled = false;
      if (buttonLabel) buttonLabel.textContent = oldLabel;
      updatePromptMode();
    }
  });

  window.addEventListener("v2:viewchange", (event) => {
    if (event.detail?.view === "images") refresh();
  });

  loadLocal();
  if (count && prompt) count.textContent = (prompt.value || "").length.toLocaleString("ru-RU") + " / 16 000";
  updatePromptMode();
  refresh();
  pollTimer = window.setInterval(() => {
    if (state.view === "images") refresh();
  }, 3000);
  window.addEventListener("beforeunload", () => window.clearInterval(pollTimer), { once: true });
})();
