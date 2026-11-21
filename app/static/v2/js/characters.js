(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, escapeHtml, saveDraft } = api;

  const characterGrid = qs("#v2-character-grid");
  const characterEmpty = qs("#v2-character-empty");
  const characterSearch = qs("#v2-character-search");
  const createDialog = qs("#v2-character-create-dialog");
  const createForm = qs("#v2-character-create-form");
  const createImages = qs("#v2-character-create-images");
  const createVoice = qs("#v2-character-create-voice");
  const referenceDrop = qs("#v2-character-reference-drop");
  const referencePreviews = qs("#v2-character-reference-previews");
  const referenceCount = qs("#v2-character-reference-count");
  const voiceName = qs("#v2-character-voice-name");
  const voicePresetInput = qs("#v2-character-create-voice-preset");
  const voicePresetsRoot = qs("#v2-character-voice-presets");
  const voiceNote = qs("#v2-character-voice-note");
  const ownVoice = qs("#v2-character-own-voice");
  let createImageFiles = [];
  let voicePresets = [];
  let voicePresetsLoaded = false;
  let selectedVoicePreset = "";
  let playingVoicePreset = "";
  let voicePreviewAudio = null;


  const syncCreateImageInput = () => {
    if (!createImages || typeof DataTransfer === "undefined") return;
    const transfer = new DataTransfer();
    createImageFiles.forEach((file) => transfer.items.add(file));
    createImages.files = transfer.files;
  };

  const clearCreatePreviewUrls = () => {
    qsa("[data-character-preview-url]", referencePreviews || document).forEach((node) => {
      const url = node.dataset.characterPreviewUrl;
      if (url) URL.revokeObjectURL(url);
    });
  };

  const renderCreateImages = () => {
    if (referenceCount) referenceCount.textContent = createImageFiles.length + " / 4";
    if (!referencePreviews) return;
    clearCreatePreviewUrls();
    referencePreviews.innerHTML = createImageFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      return '<div class="v2-character-reference-preview" data-character-preview-url="' + escapeHtml(url) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="Референс ' + (index + 1) + '">' +
        '<button type="button" data-character-image-remove="' + index + '" aria-label="Убрать изображение">' +
        '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>';
    }).join("");
    syncCreateImageInput();
  };

  const setCreateImages = (files, { append = false } = {}) => {
    const incoming = Array.from(files || []).filter((file) =>
      file && (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name))
    );
    const next = append ? [...createImageFiles, ...incoming] : incoming;
    const unique = [];
    const seen = new Set();
    next.forEach((file) => {
      const key = file.name + ":" + file.size + ":" + file.lastModified;
      if (!seen.has(key) && unique.length < 4) {
        seen.add(key);
        unique.push(file);
      }
    });
    createImageFiles = unique;
    renderCreateImages();
    if (next.length > 4) showToast("Для персонажа можно сохранить максимум 4 изображения.", "error");
  };

  const renderVoicePresets = () => {
    if (!voicePresetsRoot) return;
    if (!voicePresets.length) {
      voicePresetsRoot.innerHTML = '<div class="v2-character-voice-loading">Встроенные голоса недоступны.</div>';
      return;
    }

    const group = (gender, title) => {
      const items = voicePresets.filter((item) => item.gender === gender);
      return (
        '<div class="v2-character-voice-group"><span class="v2-character-voice-group-title">' +
        escapeHtml(title) +
        '</span><div class="v2-character-voice-grid">' +
        items.map((item) => {
          const selected = selectedVoicePreset === String(item.id);
          const playing = playingVoicePreset === String(item.id);
          const disabled = item.available === false;
          return (
            '<button class="v2-character-voice-preset' +
            (selected ? ' selected' : '') +
            (playing ? ' playing' : '') +
            '" type="button" data-voice-preset="' + escapeHtml(item.id) + '"' +
            (disabled ? ' disabled' : '') + '>' +
            '<span class="v2-character-voice-play">' + (playing ? '■' : '▶') + '</span>' +
            '<span class="v2-character-voice-preset-copy"><strong>' + escapeHtml(item.name) +
            '</strong><small>' + escapeHtml(item.tone || '') + '</small></span>' +
            '<span class="v2-character-voice-check"><svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg></span>' +
            '</button>'
          );
        }).join('') +
        '</div></div>'
      );
    };

    voicePresetsRoot.innerHTML =
      group("male", "Мужские") +
      group("female", "Женские");
  };

  const stopVoicePreview = (rerender = true) => {
    if (voicePreviewAudio) {
      voicePreviewAudio.pause();
      voicePreviewAudio.currentTime = 0;
      voicePreviewAudio = null;
    }
    playingVoicePreset = "";
    if (rerender) renderVoicePresets();
  };

  const loadVoicePresets = async () => {
    if (voicePresetsLoaded) {
      renderVoicePresets();
      return;
    }
    voicePresetsLoaded = true;
    try {
      const result = await fetchJson("/api/voice-presets");
      voicePresets = Array.isArray(result.presets) ? result.presets : [];
      if (voiceNote) {
        voiceNote.textContent = result.available
          ? "Встроенные синтетические пресеты разрешены для коммерческого использования. Preview-фраза английская — это только тембр; язык будущей реплики задаётся prompt."
          : "На сервере FFmpeg без flite: встроенные пресеты недоступны. Можно загрузить свой голос.";
      }
    } catch (error) {
      voicePresets = [];
      if (voiceNote) voiceNote.textContent = "Не удалось загрузить встроенные голоса. Свой аудиофайл по-прежнему доступен.";
    }
    renderVoicePresets();
  };

  voicePresetsRoot?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-voice-preset]");
    if (!button || button.disabled) return;
    const id = String(button.dataset.voicePreset || "");
    const preset = voicePresets.find((item) => String(item.id) === id);
    if (!preset) return;

    if (selectedVoicePreset !== id) {
      selectedVoicePreset = id;
      if (voicePresetInput) voicePresetInput.value = id;
      if (createVoice) createVoice.value = "";
      if (voiceName) voiceName.textContent = "Выбрать файл";
      ownVoice?.classList.remove("selected");
    }

    if (playingVoicePreset === id) {
      stopVoicePreview();
      return;
    }

    stopVoicePreview(false);
    if (!preset.preview_url) {
      renderVoicePresets();
      return;
    }

    playingVoicePreset = id;
    voicePreviewAudio = new Audio(preset.preview_url);
    voicePreviewAudio.preload = "auto";
    voicePreviewAudio.addEventListener("ended", () => {
      voicePreviewAudio = null;
      playingVoicePreset = "";
      renderVoicePresets();
    }, { once: true });
    voicePreviewAudio.addEventListener("error", () => {
      voicePreviewAudio = null;
      playingVoicePreset = "";
      renderVoicePresets();
      showToast("Не удалось воспроизвести голосовой пресет.", "error");
    }, { once: true });
    voicePreviewAudio.play().catch(() => {
      voicePreviewAudio = null;
      playingVoicePreset = "";
      renderVoicePresets();
      showToast("Браузер не разрешил воспроизведение голоса.", "error");
    });
    renderVoicePresets();
  });

  const resetCreateForm = () => {
    createForm?.reset();
    createImageFiles = [];
    selectedVoicePreset = "";
    if (voicePresetInput) voicePresetInput.value = "";
    stopVoicePreview(false);
    renderCreateImages();
    renderVoicePresets();
    ownVoice?.classList.remove("selected");
    if (voiceName) voiceName.textContent = "Выбрать файл";
    referenceDrop?.classList.remove("dragover");
  };

  const openCreateDialog = () => {
    resetCreateForm();
    createDialog?.showModal();
    loadVoicePresets();
    requestAnimationFrame(() => qs("#v2-character-create-name")?.focus());
  };

  qs("#v2-character-add")?.addEventListener("click", openCreateDialog);
  qsa("[data-character-create-close]").forEach((button) => {
    button.addEventListener("click", () => createDialog?.close());
  });
  createDialog?.addEventListener("click", (event) => {
    if (event.target === createDialog) createDialog.close();
  });
  createDialog?.addEventListener("close", () => {
    stopVoicePreview(false);
    clearCreatePreviewUrls();
    createImageFiles = [];
  });

  createImages?.addEventListener("change", () => setCreateImages(createImages.files, { append: true }));
  referencePreviews?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-character-image-remove]");
    if (!button) return;
    createImageFiles.splice(Number(button.dataset.characterImageRemove), 1);
    renderCreateImages();
  });
  ["dragenter", "dragover"].forEach((name) => {
    referenceDrop?.addEventListener(name, (event) => {
      event.preventDefault();
      referenceDrop.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    referenceDrop?.addEventListener(name, (event) => {
      event.preventDefault();
      referenceDrop.classList.remove("dragover");
    });
  });
  referenceDrop?.addEventListener("drop", (event) => {
    setCreateImages(event.dataTransfer?.files, { append: true });
  });

  createVoice?.addEventListener("change", () => {
    const file = createVoice.files?.[0] || null;
    if (file) {
      selectedVoicePreset = "";
      if (voicePresetInput) voicePresetInput.value = "";
      stopVoicePreview(false);
      renderVoicePresets();
    }
    ownVoice?.classList.toggle("selected", Boolean(file));
    if (voiceName) voiceName.textContent = file?.name || "Выбрать файл";
  });

  createForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = qs("#v2-character-create-name")?.value.trim() || "";
    if (!name) {
      showToast("Введите имя персонажа.", "error");
      qs("#v2-character-create-name")?.focus();
      return;
    }
    if (createImageFiles.length < 1 || createImageFiles.length > 4) {
      showToast("Добавьте от 1 до 4 изображений персонажа.", "error");
      return;
    }

    syncCreateImageInput();
    const submit = qs("#v2-character-create-submit");
    if (submit) submit.disabled = true;
    try {
      const data = new FormData();
      data.set("name", name);
      data.set("description", qs("#v2-character-create-description")?.value.trim() || "");
      createImageFiles.forEach((file) => data.append("images", file, file.name));
      const voice = createVoice?.files?.[0];
      if (selectedVoicePreset) {
        data.set("voice_preset", selectedVoicePreset);
      } else if (voice) {
        data.set("voice", voice, voice.name);
      }
      const result = await fetchJson("/api/characters", {
        method: "POST",
        body: data,
      });
      createDialog?.close();
      showToast("Персонаж сохранён.");
      await refreshCharacters();
      const id = String(result?.character?.id || "");
      if (id) {
        const candidate = new Set(state.selectedCharacterIds);
        candidate.add(id);
        const budget = characterBudget(candidate);
        if (budget.images <= 9 && budget.audios <= 3 && budget.total <= 15) {
          state.selectedCharacterIds.add(id);
          state.recentCharacterIds = [id, ...state.recentCharacterIds.filter((value) => value !== id)].slice(0, 30);
          renderSelectedCharacters();
          renderCharacterGrid();
          api.updateCreateCompatibility?.();
          saveDraft();
        }
      }
    } catch (error) {
      showToast("Не удалось сохранить персонажа: " + error.message, "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  const selectedCharacters = () =>
    state.characters.filter((character) => state.selectedCharacterIds.has(String(character.id)));

  const characterBudget = (ids) => {
    const set = ids instanceof Set ? ids : new Set(ids);
    return state.characters.reduce(
      (acc, character) => {
        if (!set.has(String(character.id))) return acc;
        acc.images += Number(character.image_count || 0);
        acc.audios += character.voice ? 1 : 0;
        acc.total += Number(character.image_count || 0) + (character.voice ? 1 : 0);
        return acc;
      },
      { images: 0, audios: 0, total: 0 }
    );
  };

  const renderSelectedCharacters = () => {
    const container = qs("#v2-selected-characters");
    const count = qs("#v2-character-count");
    const tabCount = qs("#v2-selected-tab-count");
    const chosen = selectedCharacters();
    if (count) {
      count.textContent = String(chosen.length);
      count.hidden = chosen.length === 0;
    }
    const mobileCount = qs("#v2-mobile-character-count");
    if (mobileCount) {
      mobileCount.textContent = String(chosen.length);
      mobileCount.hidden = chosen.length === 0;
    }
    if (tabCount) tabCount.textContent = String(chosen.length);
    if (!container) return;

    if (!chosen.length) {
      container.innerHTML = '<span class="v2-empty-inline">Персонажи не выбраны</span>';
      return;
    }

    container.innerHTML = chosen.map((character) => {
      const image = character.preview_url
        ? '<img src="' + escapeHtml(character.preview_url) + '" alt="">'
        : '<span class="v2-user-avatar">' + escapeHtml(character.name.slice(0, 1).toUpperCase()) + "</span>";
      return (
        '<span class="v2-character-chip" data-character-chip="' + escapeHtml(character.id) + '">' +
        image +
        "<strong>" + escapeHtml(character.name) + "</strong>" +
        '<button type="button" title="Убрать"><svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button>' +
        "</span>"
      );
    }).join("");

    qsa("[data-character-chip] button", container).forEach((button) => {
      button.addEventListener("click", () => {
        const chip = button.closest("[data-character-chip]");
        if (!chip) return;
        state.selectedCharacterIds.delete(chip.dataset.characterChip);
        renderSelectedCharacters();
        renderCharacterGrid();
        api.updateCreateCompatibility?.();
        saveDraft();
      });
    });
  };

  const filteredCharacters = () => {
    const search = (characterSearch?.value || "").trim().toLowerCase();
    let list = [...state.characters];
    if (state.characterTab === "selected") {
      list = list.filter((item) => state.selectedCharacterIds.has(String(item.id)));
    } else if (state.characterTab === "recent") {
      const order = new Map(state.recentCharacterIds.map((id, index) => [String(id), index]));
      list = list
        .filter((item) => order.has(String(item.id)))
        .sort((a, b) => order.get(String(a.id)) - order.get(String(b.id)));
    }
    if (search) {
      list = list.filter((item) =>
        (String(item.name || "") + " " + String(item.description || "")).toLowerCase().includes(search)
      );
    }
    return list;
  };

  const toggleCharacter = (characterId) => {
    const id = String(characterId);
    if (state.selectedCharacterIds.has(id)) {
      state.selectedCharacterIds.delete(id);
    } else {
      const candidate = new Set(state.selectedCharacterIds);
      candidate.add(id);
      const budget = characterBudget(candidate);
      if (budget.images > 9 || budget.audios > 3 || budget.total > 15) {
        showToast(
          "Лимит одной H3-задачи: до 9 изображений, 3 аудио и 15 reference media.",
          "error"
        );
        return;
      }
      state.selectedCharacterIds.add(id);
      state.recentCharacterIds = [id, ...state.recentCharacterIds.filter((value) => value !== id)].slice(0, 30);
    }
    renderSelectedCharacters();
    renderCharacterGrid();
    api.updateCreateCompatibility?.();
    saveDraft();
  };

  const renderCharacterGrid = () => {
    if (!characterGrid) return;
    const list = filteredCharacters();
    const total = qs("#v2-character-total");
    if (total) total.textContent = state.characters.length + " персонажей";
    if (characterEmpty) characterEmpty.hidden = list.length > 0;
    characterGrid.innerHTML = list.map((character) => {
      const selected = state.selectedCharacterIds.has(String(character.id));
      const image = character.preview_url
        ? '<img src="' + escapeHtml(character.preview_url) + '" alt="">'
        : '<span class="v2-user-avatar">' + escapeHtml(character.name.slice(0, 1).toUpperCase()) + "</span>";
      const meta = Number(character.image_count || 0) + " фото" + (character.voice ? " · голос" : "");
      return (
        '<button class="v2-character-card' + (selected ? " selected" : "") + '" type="button" data-character-id="' + escapeHtml(character.id) + '">' +
        image +
        "<span><strong>" + escapeHtml(character.name) + "</strong><small>" + escapeHtml(meta) + "</small></span>" +
        '<span class="v2-character-selectmark"><svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg></span>' +
        "</button>"
      );
    }).join("");

    qsa("[data-character-id]", characterGrid).forEach((button) => {
      button.addEventListener("click", () => toggleCharacter(button.dataset.characterId));
    });
  };

  const refreshCharacters = async () => {
    try {
      const result = await fetchJson("/api/characters");
      state.characters = Array.isArray(result.characters) ? result.characters : [];
      const valid = new Set(state.characters.map((item) => String(item.id)));
      state.selectedCharacterIds = new Set(
        Array.from(state.selectedCharacterIds).filter((id) => valid.has(String(id)))
      );
      renderSelectedCharacters();
      renderCharacterGrid();
    } catch (error) {
      showToast("Не удалось загрузить персонажей: " + error.message, "error");
    }
  };

  const currentCreateAssistantSettings = () => ({
    prompt: state.draft.prompt,
    resolution_shape: state.draft.ratio,
    seconds: Number(state.draft.seconds),
    fps: 24,
    steps: Number(state.draft.steps),
    seed: state.draft.seed.trim() ? Number(state.draft.seed) : -1,
    generate_audio: Boolean(state.draft.audio),
    selected_character_ids: Array.from(state.selectedCharacterIds),
    available_characters: state.characters.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || "",
      voice: Boolean(item.voice),
      image_count: Number(item.image_count || 0),
    })),
  });

  characterSearch?.addEventListener("input", renderCharacterGrid);
  qsa("[data-character-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.characterTab = button.dataset.characterTab || "all";
      qsa("[data-character-tab]").forEach((item) => item.classList.toggle("active", item === button));
      renderCharacterGrid();
    });
  });

  Object.assign(api, {
    selectedCharacters,
    refreshCharacters,
    currentCreateAssistantSettings,
    currentAssistantSettings: currentCreateAssistantSettings,
    renderCharacterGrid,
    renderSelectedCharacters,
  });
})();