(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, saveDraft } = api;

  const prompt = qs("#v2-prompt");
  const promptCount = qs("#v2-prompt-count");
  const seed = qs("#v2-seed");
  const audio = qs("#v2-audio");

  const applySegment = (setting, value, save = true) => {
    const group = qs('[data-setting="' + setting + '"]');
    if (!group) return;
    const buttons = qsa("[data-value]", group);
    const target = buttons.find((button) => button.dataset.value === String(value)) || buttons[0];
    buttons.forEach((button) => button.classList.toggle("active", button === target));
    if (target) state.draft[setting] = target.dataset.value;
    if (save) saveDraft();
  };

  qsa("[data-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      applySegment(group.dataset.setting, button.dataset.value);
    });
  });

  const updatePromptCount = () => {
    if (promptCount && prompt) {
      promptCount.textContent = prompt.value.length.toLocaleString("ru-RU") + " / 16 000";
    }
  };

  prompt?.addEventListener("input", () => {
    state.draft.prompt = prompt.value;
    updatePromptCount();
    saveDraft();
  });
  seed?.addEventListener("input", () => {
    state.draft.seed = seed.value;
    saveDraft();
  });
  audio?.addEventListener("change", () => {
    state.draft.audio = audio.checked;
    saveDraft();
  });

  const setupUploadCard = (kind) => {
    const card = qs('[data-v2-upload="' + kind + '"]');
    const input = card?.querySelector('input[type="file"]');
    const preview = card?.querySelector(".v2-upload-preview");
    const placeholder = card?.querySelector(".v2-upload-placeholder");
    const remove = card?.querySelector(".v2-upload-remove");
    if (!card || !input || !preview || !placeholder || !remove) return;

    const render = () => {
      const file = input.files?.[0];
      const oldUrl = state.uploadUrls.get(kind);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      state.uploadUrls.delete(kind);

      if (!file) {
        preview.hidden = true;
        preview.removeAttribute("src");
        placeholder.hidden = false;
        remove.hidden = true;
        api.updateCreateCompatibility?.();
        return;
      }

      const url = URL.createObjectURL(file);
      state.uploadUrls.set(kind, url);
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
      remove.hidden = false;
      api.updateCreateCompatibility?.();
    };

    input.addEventListener("change", render);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      render();
    });

    ["dragenter", "dragover"].forEach((name) => {
      card.addEventListener(name, (event) => {
        event.preventDefault();
        card.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((name) => {
      card.addEventListener(name, () => card.classList.remove("dragover"));
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      const transfer = new DataTransfer();
      transfer.items.add(files[0]);
      input.files = transfer.files;
      render();
    });
  };

  setupUploadCard("first");
  setupUploadCard("last");

  qs("#v2-wand")?.addEventListener("click", async () => {
    const source = prompt?.value.trim() || "";
    if (!source) {
      showToast("Сначала напишите обычный промт.", "error");
      prompt?.focus();
      return;
    }
    const button = qs("#v2-wand");
    button.disabled = true;
    showToast("Локальный ИИ улучшает промт…");
    try {
      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content:
              "Перепиши только этот запрос для поля prompt раздела «Создать». " +
              "Верни changes.prompt в каноническом формате MiniMax H3 из трёх полей: " +
              "integrated_multimodal_description, overall_soundscape, non_diegetic_music. " +
              "Соблюдай выбранную длительность: [Shot 1] без времени, каждый следующий cut с точным временем. " +
              "Один основной camera move на shot. Точные реплики оформляй как (S1) и <d>[Language] ...</d> без перевода. " +
              "Если generate_audio выключен — overall_soundscape: N/A и non_diegetic_music: N/A. " +
              "Если звук включён, но музыки не просили — non_diegetic_music: N/A. " +
              "Если есть first/last frame, добавь перед тремя полями правильную alignment line из H3 guide. " +
              "Если выбраны Characters, не придумывай Picture/Subject ordinals и не пиши шесть Ref2VA-полей: backend добавит их сам. " +
              "Сохрани все конкретные факты буквально: возраст/числа, направление, предметы, погоду, действия и точные реплики. " +
              "Не обобщай возраст и не придумывай гром, шаги, новые действия или другие детали. " +
              "Не меняй настройки формы и не добавляй события, которых пользователь не просил. " +
              "Верни только changes.prompt; message сделай очень коротким.\n\n" +
              source,
          }],
          settings: {
            ...(api.currentAssistantSettings?.() || {}),
            workspace: "create",
            generation_mode:
              (qs("#v2-first-frame")?.files?.[0] || qs("#v2-last-frame")?.files?.[0])
                ? "frames"
                : (api.selectedCharacters?.()?.length ? "reference" : "frames"),
            has_first_frame: Boolean(qs("#v2-first-frame")?.files?.[0]),
            has_last_frame: Boolean(qs("#v2-last-frame")?.files?.[0]),
          },
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (typeof improved !== "string" || !improved.trim()) {
        throw new Error(result?.message || "ИИ не вернул улучшенный промт.");
      }
      prompt.value = improved.trim();
      state.draft.prompt = prompt.value;
      updatePromptCount();
      saveDraft();
      showToast("Промт улучшен под MiniMax H3.");
    } catch (error) {
      showToast("Не удалось улучшить промт: " + error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const createForm = qs("#v2-create-form");
  const generateButton = qs("#v2-generate");
  const generateLabel = qs(".v2-generate-label", generateButton || document);
  const createWarning = qs("#v2-create-warning");
  const firstFrameInput = qs("#v2-first-frame");
  const lastFrameInput = qs("#v2-last-frame");

  const createHasFrames = () =>
    Boolean(firstFrameInput?.files?.length || lastFrameInput?.files?.length);

  const updateCreateCompatibility = () => {
    const conflict = state.selectedCharacterIds.size > 0 && createHasFrames();
    if (createWarning) {
      createWarning.hidden = !conflict;
      createWarning.textContent = conflict
        ? "Точные начальный/конечный кадры и Characters используют разные H3 pipelines. Для одной генерации оставьте либо кадры, либо персонажей."
        : "";
    }
    if (generateButton && !generateButton.classList.contains("is-loading")) {
      generateButton.disabled = conflict;
    }
    return !conflict;
  };

  createForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!updateCreateCompatibility()) {
      showToast("Нельзя одновременно использовать точные кадры и Characters.", "error");
      return;
    }
    const sourcePrompt = prompt?.value.trim() || "";
    if (!sourcePrompt) {
      showToast("Сначала напишите prompt.", "error");
      prompt?.focus();
      return;
    }

    const formData = new FormData();
    formData.set("prompt", sourcePrompt);
    formData.set("quality", state.draft.quality);
    formData.set("ratio", state.draft.ratio);
    formData.set("seconds", state.draft.seconds);
    formData.set("steps", state.draft.steps);
    formData.set("seed", state.draft.seed.trim());
    formData.set("generate_audio", state.draft.audio ? "true" : "false");
    formData.set("character_ids", JSON.stringify(Array.from(state.selectedCharacterIds)));
    if (firstFrameInput?.files?.[0]) formData.set("first_frame", firstFrameInput.files[0]);
    if (lastFrameInput?.files?.[0]) formData.set("last_frame", lastFrameInput.files[0]);

    if (generateButton) {
      generateButton.disabled = true;
      generateButton.classList.add("is-loading");
    }
    if (generateLabel) generateLabel.textContent = "Добавляем в очередь…";

    try {
      const result = await fetchJson("/api/v2/generate", { method: "POST", body: formData });
      const shortId = String(result?.job_id || "").slice(0, 8);
      const resolved = result?.v2;
      const resolutionText =
        resolved?.width && resolved?.height ? " · " + resolved.width + "×" + resolved.height : "";
      showToast("Задача добавлена в очередь" + (shortId ? " · " + shortId : "") + resolutionText);
      api.setView?.("queue");
      setTimeout(() => api.refreshSystem?.(), 700);
    } catch (error) {
      showToast("Не удалось запустить генерацию: " + error.message, "error");
    } finally {
      generateButton?.classList.remove("is-loading");
      if (generateLabel) generateLabel.textContent = "Сгенерировать видео";
      updateCreateCompatibility();
    }
  });

  const restoreDraftToUi = () => {
    if (prompt) prompt.value = state.draft.prompt;
    if (seed) seed.value = state.draft.seed;
    if (audio) audio.checked = Boolean(state.draft.audio);
    ["quality", "ratio", "seconds", "steps"].forEach((key) => applySegment(key, state.draft[key], false));
    updatePromptCount();
    updateCreateCompatibility();
  };

  Object.assign(api, {
    applySegment,
    updatePromptCount,
    updateCreateCompatibility,
    restoreDraftToUi,
  });
})();