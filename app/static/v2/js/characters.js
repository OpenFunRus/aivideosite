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
  const formTitle = qs("#v2-character-form-title");
  const formSubtitle = qs("#v2-character-form-subtitle");
  const submitLabel = qs("#v2-character-submit-label");
  const deleteButton = qs("#v2-character-delete");
  const currentVoice = qs("#v2-character-current-voice");
  const currentVoiceTitle = qs("#v2-character-current-voice-title");
  const currentVoiceStatus = qs("#v2-character-current-voice-status");
  const currentVoiceRemove = qs("#v2-character-current-voice-remove");
  let createImageFiles = [];
  let existingImageUrls = [];
  let keptExistingImageIndices = new Set();
  let editingCharacterId = "";
  let existingVoice = false;
  let existingVoicePreset = "";
  let removeExistingVoice = false;
  let voicePresets = [];
  let voicePresetsLoaded = false;
  let selectedVoicePreset = "";
  let playingVoicePreset = "";
  let voicePreviewAudio = null;

  if (!(state.mutedCharacterIds instanceof Set)) {
    state.mutedCharacterIds = new Set();
  }

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
    const kept = Array.from(keptExistingImageIndices).sort((a, b) => a - b);
    const total = kept.length + createImageFiles.length;
    if (referenceCount) referenceCount.textContent = total + " / 4";
    if (!referencePreviews) return;
    clearCreatePreviewUrls();

    const existingMarkup = kept.map((index) => {
      const url = existingImageUrls[index] || "";
      return '<div class="v2-character-reference-preview">' +
        '<img src="' + escapeHtml(url) + '" alt="Сохранённый референс ' + (index + 1) + '">' +
        '<span class="v2-character-reference-existing">Текущий</span>' +
        '<button type="button" data-character-existing-image-remove="' + index + '" aria-label="Убрать изображение">' +
        '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>';
    }).join("");

    const newMarkup = createImageFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      return '<div class="v2-character-reference-preview" data-character-preview-url="' + escapeHtml(url) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="Новый референс ' + (index + 1) + '">' +
        '<span class="v2-character-reference-existing new">Новый</span>' +
        '<button type="button" data-character-new-image-remove="' + index + '" aria-label="Убрать изображение">' +
        '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>';
    }).join("");

    referencePreviews.innerHTML = existingMarkup + newMarkup;
    syncCreateImageInput();
  };

  const setCreateImages = (files, { append = false } = {}) => {
    const incoming = Array.from(files || []).filter((file) =>
      file && (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name))
    );
    const next = append ? [...createImageFiles, ...incoming] : incoming;
    const maxNew = Math.max(0, 4 - keptExistingImageIndices.size);
    const unique = [];
    const seen = new Set();
    next.forEach((file) => {
      const key = file.name + ":" + file.size + ":" + file.lastModified;
      if (!seen.has(key) && unique.length < maxNew) {
        seen.add(key);
        unique.push(file);
      }
    });
    createImageFiles = unique;
    renderCreateImages();
    if (next.length > maxNew) {
      showToast("Для персонажа можно сохранить максимум 4 изображения.", "error");
    }
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
          ? "Preview: «" + (result.sample_text || "Привет, это мой голос.") + "»"
          : "Встроенные голоса ещё не подготовлены на сервере. Свой голос можно загрузить прямо сейчас.";
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

    if (selectedVoicePreset !== id || removeExistingVoice) {
      selectedVoicePreset = id;
      if (voicePresetInput) voicePresetInput.value = id;
      if (createVoice) createVoice.value = "";
      if (voiceName) voiceName.textContent = "Выбрать файл";
      removeExistingVoice = false;
      ownVoice?.classList.remove("selected");
      renderCurrentVoice();
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

  const renderCurrentVoice = () => {
    if (!currentVoice) return;
    currentVoice.hidden = !(editingCharacterId && existingVoice);
    if (currentVoice.hidden) return;

    const replacementSelected = Boolean(
      createVoice?.files?.[0] ||
      (selectedVoicePreset && selectedVoicePreset !== existingVoicePreset)
    );
    currentVoice.classList.toggle("removed", removeExistingVoice);
    currentVoice.classList.toggle("replacing", replacementSelected);

    if (replacementSelected) {
      if (currentVoiceTitle) currentVoiceTitle.textContent = "Текущий голос будет заменён";
      if (currentVoiceStatus) currentVoiceStatus.textContent = "После сохранения будет использоваться выбранный выше голос.";
    } else if (removeExistingVoice) {
      if (currentVoiceTitle) currentVoiceTitle.textContent = "Текущий голос будет удалён";
      if (currentVoiceStatus) currentVoiceStatus.textContent = "Нажмите «Оставить голос», чтобы отменить удаление.";
    } else {
      if (currentVoiceTitle) currentVoiceTitle.textContent = "Текущий голос сохранён";
      if (currentVoiceStatus) currentVoiceStatus.textContent = "Оставьте как есть, удалите или выберите новый голос выше.";
    }

    if (currentVoiceRemove) {
      currentVoiceRemove.disabled = replacementSelected;
      currentVoiceRemove.textContent = removeExistingVoice ? "Оставить голос" : "Удалить голос";
    }
  };

  const resetCreateForm = () => {
    createForm?.reset();
    createImageFiles = [];
    existingImageUrls = [];
    keptExistingImageIndices = new Set();
    editingCharacterId = "";
    existingVoice = false;
    existingVoicePreset = "";
    removeExistingVoice = false;
    selectedVoicePreset = "";
    if (voicePresetInput) voicePresetInput.value = "";
    stopVoicePreview(false);
    if (formTitle) formTitle.textContent = "Добавить персонажа";
    if (formSubtitle) formSubtitle.textContent = "Сохраните внешний вид один раз и используйте его в генераторах через правую панель.";
    if (submitLabel) submitLabel.textContent = "Сохранить персонажа";
    if (deleteButton) deleteButton.hidden = true;
    renderCreateImages();
    renderVoicePresets();
    renderCurrentVoice();
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

  const openEditDialog = (characterId) => {
    const character = state.characters.find((item) => String(item.id) === String(characterId));
    if (!character) {
      showToast("Персонаж не найден.", "error");
      return;
    }

    resetCreateForm();
    editingCharacterId = String(character.id);
    existingImageUrls = Array.isArray(character.image_urls)
      ? character.image_urls.slice(0, 4)
      : (character.preview_url ? [character.preview_url] : []);
    keptExistingImageIndices = new Set(existingImageUrls.map((_, index) => index));
    existingVoice = Boolean(character.voice);
    existingVoicePreset = String(character.voice_preset_id || "");
    selectedVoicePreset = existingVoicePreset;
    if (voicePresetInput) voicePresetInput.value = selectedVoicePreset;

    const nameInput = qs("#v2-character-create-name");
    const descriptionInput = qs("#v2-character-create-description");
    if (nameInput) nameInput.value = character.name || "";
    if (descriptionInput) descriptionInput.value = character.description || "";
    if (formTitle) formTitle.textContent = "Редактировать персонажа";
    if (formSubtitle) formSubtitle.textContent = "Измените описание, референсы внешности и голос. Старые файлы сохранятся, пока вы их явно не уберёте.";
    if (submitLabel) submitLabel.textContent = "Сохранить изменения";
    if (deleteButton) deleteButton.hidden = false;

    renderCreateImages();
    renderCurrentVoice();
    createDialog?.showModal();
    loadVoicePresets();
    requestAnimationFrame(() => nameInput?.focus());
  };

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
    const existingButton = event.target.closest("[data-character-existing-image-remove]");
    if (existingButton) {
      keptExistingImageIndices.delete(Number(existingButton.dataset.characterExistingImageRemove));
      renderCreateImages();
      return;
    }
    const newButton = event.target.closest("[data-character-new-image-remove]");
    if (newButton) {
      createImageFiles.splice(Number(newButton.dataset.characterNewImageRemove), 1);
      renderCreateImages();
    }
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
      removeExistingVoice = false;
      if (voicePresetInput) voicePresetInput.value = "";
      stopVoicePreview(false);
      renderVoicePresets();
    }
    ownVoice?.classList.toggle("selected", Boolean(file));
    if (voiceName) voiceName.textContent = file?.name || "Выбрать файл";
    renderCurrentVoice();
  });

  currentVoiceRemove?.addEventListener("click", () => {
    if (!editingCharacterId || !existingVoice) return;
    removeExistingVoice = !removeExistingVoice;
    renderCurrentVoice();
  });

  deleteButton?.addEventListener("click", async () => {
    if (!editingCharacterId) return;
    const character = state.characters.find((item) => String(item.id) === editingCharacterId);
    const label = character?.name ? " «" + character.name + "»" : "";
    if (!window.confirm("Удалить персонажа" + label + "? Это удалит его референсы и голос.")) return;

    deleteButton.disabled = true;
    try {
      await fetchJson("/api/characters/" + encodeURIComponent(editingCharacterId), { method: "DELETE" });
      state.selectedCharacterIds.delete(editingCharacterId);
      state.recentCharacterIds = state.recentCharacterIds.filter((id) => String(id) !== editingCharacterId);
      createDialog?.close();
      await refreshCharacters();
      api.updateCreateCompatibility?.();
      saveDraft();
      showToast("Персонаж удалён.");
    } catch (error) {
      showToast("Не удалось удалить персонажа: " + error.message, "error");
    } finally {
      deleteButton.disabled = false;
    }
  });

  createForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = qs("#v2-character-create-name")?.value.trim() || "";
    if (!name) {
      showToast("Введите имя персонажа.", "error");
      qs("#v2-character-create-name")?.focus();
      return;
    }

    const imageCount = keptExistingImageIndices.size + createImageFiles.length;
    if (imageCount < 1 || imageCount > 4) {
      showToast("У персонажа должно быть от 1 до 4 изображений.", "error");
      return;
    }

    syncCreateImageInput();
    const submit = qs("#v2-character-create-submit");
    if (submit) submit.disabled = true;
    const editedId = editingCharacterId;

    try {
      const data = new FormData();
      data.set("name", name);
      data.set("description", qs("#v2-character-create-description")?.value.trim() || "");
      createImageFiles.forEach((file) => data.append("images", file, file.name));
      const voice = createVoice?.files?.[0];

      if (selectedVoicePreset && (!editedId || selectedVoicePreset !== existingVoicePreset)) {
        data.set("voice_preset", selectedVoicePreset);
      } else if (voice) {
        data.set("voice", voice, voice.name);
      }

      let result;
      if (editedId) {
        data.set(
          "keep_image_indices",
          JSON.stringify(Array.from(keptExistingImageIndices).sort((a, b) => a - b))
        );
        data.set("remove_voice", removeExistingVoice ? "true" : "false");
        result = await fetchJson("/api/characters/" + encodeURIComponent(editedId), {
          method: "POST",
          body: data,
        });
      } else {
        result = await fetchJson("/api/characters", {
          method: "POST",
          body: data,
        });
      }

      createDialog?.close();
      await refreshCharacters();

      if (editedId) {
        const budget = characterBudget(state.selectedCharacterIds);
        if (
          state.selectedCharacterIds.has(editedId) &&
          referenceBudgetExceeded(budget)
        ) {
          state.selectedCharacterIds.delete(editedId);
          renderSelectedCharacters();
          renderCharacterGrid();
          showToast("Из-за новых референсов персонаж снят с выбора: превышен лимит H3.", "error");
        } else {
          showToast("Персонаж обновлён.");
        }
        api.updateCreateCompatibility?.();
        saveDraft();
      } else {
        showToast("Персонаж сохранён.");
        const id = String(result?.character?.id || "");
        if (id) {
          const candidate = new Set(state.selectedCharacterIds);
          candidate.add(id);
          const budget = characterBudget(candidate);
          if (!referenceBudgetExceeded(budget)) {
            state.selectedCharacterIds.add(id);
            state.recentCharacterIds = [id, ...state.recentCharacterIds.filter((value) => value !== id)].slice(0, 30);
            renderSelectedCharacters();
            renderCharacterGrid();
            api.updateCreateCompatibility?.();
            saveDraft();
          }
        }
      }
    } catch (error) {
      showToast((editedId ? "Не удалось обновить персонажа: " : "Не удалось сохранить персонажа: ") + error.message, "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  const selectedCharacters = () =>
    state.characters.filter((character) => state.selectedCharacterIds.has(String(character.id)));

  const referenceBudget = (
    characterIds = state.selectedCharacterIds,
    locationIds = state.selectedLocationIds,
    mutedIds = state.mutedCharacterIds,
    miscIds = state.selectedMiscIds
  ) => {
    const characterSet = characterIds instanceof Set ? characterIds : new Set(characterIds || []);
    const locationSet = locationIds instanceof Set ? locationIds : new Set(locationIds || []);
    const muted = mutedIds instanceof Set ? mutedIds : new Set(mutedIds || []);
    const miscSet = miscIds instanceof Set ? miscIds : new Set(miscIds || []);
    const budget = state.characters.reduce(
      (acc, character) => {
        const id = String(character.id);
        if (!characterSet.has(id)) return acc;
        const voiceActive = Boolean(character.voice) && !muted.has(id);
        acc.images += Number(character.image_count || 0);
        acc.audios += voiceActive ? 1 : 0;
        acc.total += Number(character.image_count || 0) + (voiceActive ? 1 : 0);
        return acc;
      },
      { images: 0, audios: 0, total: 0 }
    );
    (state.locations || []).forEach((location) => {
      if (!locationSet.has(String(location.id))) return;
      const images = Number(location.image_count || 0);
      budget.images += images;
      budget.total += images;
    });
    (state.misc || []).forEach((preset) => {
      if (!miscSet.has(String(preset.id))) return;
      const images = Number(preset.image_count || 0);
      budget.images += images;
      budget.total += images;
    });
    return budget;
  };

  const referenceBudgetExceeded = (budget) =>
    budget.images > 9 || budget.audios > 3 || budget.total > 15;

  const referenceBudgetMessage = () =>
    "Лимит одной H3-задачи: до 9 изображений, 3 аудио и 15 reference media.";

  const characterBudget = (ids, mutedIds = state.mutedCharacterIds) =>
    referenceBudget(ids, state.selectedLocationIds, mutedIds);

  const mutedCharacterIds = () => Array.from(state.mutedCharacterIds).map(String);

  const toggleCharacterVoice = (characterId) => {
    const id = String(characterId);
    const character = state.characters.find((item) => String(item.id) === id);
    if (!character?.voice) return;

    if (state.mutedCharacterIds.has(id)) {
      const candidateMuted = new Set(state.mutedCharacterIds);
      candidateMuted.delete(id);
      const budget = characterBudget(state.selectedCharacterIds, candidateMuted);
      if (referenceBudgetExceeded(budget)) {
        showToast(
          "Нельзя включить голос: лимит H3 — до 3 audio refs и 15 reference media.",
          "error"
        );
        return;
      }
      state.mutedCharacterIds.delete(id);
    } else {
      state.mutedCharacterIds.add(id);
    }

    renderCharacterGrid();
    api.updateCreateCompatibility?.();
    saveDraft();
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
    const search = (characterSearch?.value || "").trim().toLocaleLowerCase("ru");
    const selectedOrder = new Map(
      Array.from(state.selectedCharacterIds).map((id, index) => [String(id), index])
    );
    const list = state.characters.filter((item) => {
      if (!search) return true;
      return (String(item.name || "") + " " + String(item.description || ""))
        .toLocaleLowerCase("ru")
        .includes(search);
    });

    list.sort((a, b) => {
      const aId = String(a.id);
      const bId = String(b.id);
      const aSelected = selectedOrder.has(aId);
      const bSelected = selectedOrder.has(bId);
      if (aSelected && bSelected) {
        return selectedOrder.get(aId) - selectedOrder.get(bId);
      }
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      return String(a.name || "").localeCompare(
        String(b.name || ""),
        ["ru", "en"],
        { sensitivity: "base", numeric: true }
      );
    });
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
      if (referenceBudgetExceeded(budget)) {
        showToast(
          referenceBudgetMessage(),
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

    const addCard =
      '<button class="v2-character-add-card" type="button" data-character-add-card>' +
        '<span class="v2-character-add-card-icon"><svg class="icon"><use href="/static/icons.svg#icon-plus"></use></svg></span>' +
        '<strong><span>Добавить</span><span>персонажа</span></strong>' +
      '</button>';

    const characterCards = list.map((character) => {
      const id = String(character.id);
      const selected = state.selectedCharacterIds.has(id);
      const hasVoice = Boolean(character.voice);
      const muted = !hasVoice || state.mutedCharacterIds.has(id);
      const voiceTitle = !hasVoice
        ? "У персонажа нет сохранённого голоса"
        : muted
          ? "Включить голос персонажа"
          : "Заглушить голос персонажа";
      const voiceIcon = muted ? "icon-volume-off" : "icon-volume";
      const image = character.preview_url
        ? '<img src="' + escapeHtml(character.preview_url) + '" alt="">'
        : '<span class="v2-user-avatar">' + escapeHtml(character.name.slice(0, 1).toUpperCase()) + "</span>";
      return (
        '<div class="v2-character-card' + (selected ? " selected" : "") + '" data-character-id="' + escapeHtml(id) + '">' +
          '<button class="v2-character-card-main" type="button" data-character-select="' + escapeHtml(id) + '">' +
            '<span class="v2-character-selectmark"><svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg></span>' +
            image +
            "<strong>" + escapeHtml(character.name) + "</strong>" +
          "</button>" +
          '<button class="v2-character-voice-button' + (muted ? " muted" : "") + (!hasVoice ? " no-voice" : "") + '" type="button" data-character-voice-toggle="' + escapeHtml(id) + '" title="' + escapeHtml(voiceTitle) + '" aria-label="' + escapeHtml(voiceTitle) + '"' + (!hasVoice ? " disabled" : "") + '>' +
            '<svg class="icon"><use href="/static/icons.svg#' + voiceIcon + '"></use></svg>' +
          "</button>" +
          '<button class="v2-character-edit-button" type="button" data-character-edit="' + escapeHtml(id) + '" title="Редактировать персонажа" aria-label="Редактировать персонажа">' +
            '<svg class="icon"><use href="/static/icons.svg#icon-settings"></use></svg>' +
          "</button>" +
        "</div>"
      );
    }).join("");

    characterGrid.innerHTML = addCard + characterCards;

    qs("[data-character-add-card]", characterGrid)?.addEventListener("click", openCreateDialog);
    qsa("[data-character-select]", characterGrid).forEach((button) => {
      button.addEventListener("click", () => toggleCharacter(button.dataset.characterSelect));
    });
    qsa("[data-character-voice-toggle]", characterGrid).forEach((button) => {
      button.addEventListener("click", () => toggleCharacterVoice(button.dataset.characterVoiceToggle));
    });
    qsa("[data-character-edit]", characterGrid).forEach((button) => {
      button.addEventListener("click", () => openEditDialog(button.dataset.characterEdit));
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
      state.mutedCharacterIds = new Set(
        Array.from(state.mutedCharacterIds).filter((id) => valid.has(String(id)))
      );
      renderSelectedCharacters();
      renderCharacterGrid();
    } catch (error) {
      showToast("Не удалось загрузить персонажей: " + error.message, "error");
    }
  };

  const currentCreateAssistantSettings = () => {
    const audioContext = window.AIVideoV2Workspaces?.audioAssistantContext?.() || {};
    const audioMode = Boolean(audioContext.audio_mode);
    const hasFrames = Boolean(
      qs("#v2-first-frame")?.files?.[0] ||
      qs("#v2-last-frame")?.files?.[0]
    );
    const hasPresets = Boolean(
      state.selectedCharacterIds.size ||
      state.selectedLocationIds?.size ||
      state.selectedMiscIds?.size
    );

    return {
      workspace: "create",
      prompt: String(qs("#v2-prompt")?.value ?? state.draft.prompt ?? ""),
      quality: String(qs('[data-setting="quality"] button.active')?.dataset.value || state.draft.quality || "720"),
      resolution_shape: String(qs('[data-setting="ratio"] button.active')?.dataset.value || state.draft.ratio || "16:9"),
      seconds: Number(qs('[data-setting="seconds"] button.active')?.dataset.value || state.draft.seconds || 10),
      fps: 24,
      steps: Number(qs('[data-setting="steps"] button.active')?.dataset.value || state.draft.steps || 12),
      seed: String(qs("#v2-seed")?.value || "").trim()
        ? Number(qs("#v2-seed")?.value)
        : -1,
      audio_mode: audioMode,
      generation_mode: audioMode
        ? "digital_human"
        : (hasFrames ? (hasPresets ? "multiframe" : "frames") : (hasPresets ? "reference" : "frames")),
      reference_task: audioMode ? "audio_reference" : (hasFrames && hasPresets ? "timeline_guides" : "reference_generation"),
      generate_audio: audioMode
        ? Boolean(audioContext.generate_scene_audio)
        : Boolean(qs("#v2-audio")?.checked),
      has_first_frame: Boolean(qs("#v2-first-frame")?.files?.[0]),
      has_last_frame: Boolean(qs("#v2-last-frame")?.files?.[0]),
      selected_character_ids: Array.from(state.selectedCharacterIds).map(String),
      selected_location_ids: Array.from(state.selectedLocationIds || []).map(String),
      selected_misc_ids: Array.from(state.selectedMiscIds || []).map(String),
      muted_character_ids: mutedCharacterIds().map(String),
      ...audioContext,
    };
  };

  characterSearch?.addEventListener("input", renderCharacterGrid);

  Object.assign(api, {
    selectedCharacters,
    mutedCharacterIds,
    characterBudget,
    referenceBudget,
    referenceBudgetExceeded,
    referenceBudgetMessage,
    refreshCharacters,
    currentCreateAssistantSettings,
    currentAssistantSettings: currentCreateAssistantSettings,
    renderCharacterGrid,
    renderSelectedCharacters,
  });
})();