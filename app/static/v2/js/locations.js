(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, escapeHtml, saveDraft } = api;

  if (!(state.selectedLocationIds instanceof Set)) state.selectedLocationIds = new Set();
  if (!Array.isArray(state.locations)) state.locations = [];

  const grid = qs("#v2-location-grid");
  const empty = qs("#v2-location-empty");
  const search = qs("#v2-location-search");
  const dialog = qs("#v2-location-create-dialog");
  const form = qs("#v2-location-create-form");
  const imageInput = qs("#v2-location-create-images");
  const drop = qs("#v2-location-reference-drop");
  const previews = qs("#v2-location-reference-previews");
  const referenceCount = qs("#v2-location-reference-count");
  const formTitle = qs("#v2-location-form-title");
  const formSubtitle = qs("#v2-location-form-subtitle");
  const submitLabel = qs("#v2-location-submit-label");
  const deleteButton = qs("#v2-location-delete");

  let newImageFiles = [];
  let existingImageUrls = [];
  let keptExistingImageIndices = new Set();
  let editingLocationId = "";

  const clearPreviewUrls = () => {
    qsa("[data-location-preview-url]", previews || document).forEach((node) => {
      const url = node.dataset.locationPreviewUrl;
      if (url) URL.revokeObjectURL(url);
    });
  };

  const renderCreateImages = () => {
    const kept = Array.from(keptExistingImageIndices).sort((a, b) => a - b);
    const total = kept.length + newImageFiles.length;
    if (referenceCount) referenceCount.textContent = total + " / 4";
    if (!previews) return;
    clearPreviewUrls();

    const oldMarkup = kept.map((index) => {
      const url = existingImageUrls[index] || "";
      return '<div class="v2-character-reference-preview">' +
        '<img src="' + escapeHtml(url) + '" alt="Сохранённый референс ' + (index + 1) + '">' +
        '<span class="v2-character-reference-existing">Текущий</span>' +
        '<button type="button" data-location-existing-image-remove="' + index + '" aria-label="Убрать изображение">' +
          '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg>' +
        "</button></div>";
    });

    const newMarkup = newImageFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      return '<div class="v2-character-reference-preview" data-location-preview-url="' + escapeHtml(url) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="Новый референс ' + (index + 1) + '">' +
        '<span class="v2-character-reference-existing">Новый</span>' +
        '<button type="button" data-location-new-image-remove="' + index + '" aria-label="Убрать изображение">' +
          '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg>' +
        "</button></div>";
    });

    previews.innerHTML = oldMarkup.concat(newMarkup).join("");
  };

  const addImageFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((file) => file?.type?.startsWith("image/"));
    const free = Math.max(0, 4 - keptExistingImageIndices.size - newImageFiles.length);
    if (incoming.length > free) {
      showToast("Для одной локации можно сохранить до 4 изображений.", "error");
    }
    newImageFiles.push(...incoming.slice(0, free));
    if (imageInput) imageInput.value = "";
    renderCreateImages();
  };

  const resetForm = () => {
    form?.reset();
    clearPreviewUrls();
    newImageFiles = [];
    existingImageUrls = [];
    keptExistingImageIndices = new Set();
    editingLocationId = "";
    if (formTitle) formTitle.textContent = "Добавить локацию";
    if (formSubtitle) formSubtitle.textContent = "Сохраните окружение один раз и используйте его как стабильный фон сцены.";
    if (submitLabel) submitLabel.textContent = "Сохранить локацию";
    if (deleteButton) deleteButton.hidden = true;
    drop?.classList.remove("dragover");
    renderCreateImages();
  };

  const openCreateDialog = () => {
    resetForm();
    dialog?.showModal();
    requestAnimationFrame(() => qs("#v2-location-create-name")?.focus());
  };

  const openEditDialog = (locationId) => {
    const location = state.locations.find((item) => String(item.id) === String(locationId));
    if (!location) {
      showToast("Локация не найдена.", "error");
      return;
    }
    resetForm();
    editingLocationId = String(location.id);
    existingImageUrls = Array.isArray(location.image_urls)
      ? location.image_urls.slice(0, 4)
      : (location.preview_url ? [location.preview_url] : []);
    keptExistingImageIndices = new Set(existingImageUrls.map((_, index) => index));

    const name = qs("#v2-location-create-name");
    const prompt = qs("#v2-location-create-prompt");
    if (name) name.value = location.name || "";
    if (prompt) prompt.value = location.prompt || "";
    if (formTitle) formTitle.textContent = "Редактировать локацию";
    if (formSubtitle) formSubtitle.textContent = "Измените промпт и референсы окружения. Старые изображения сохранятся, пока вы их явно не уберёте.";
    if (submitLabel) submitLabel.textContent = "Сохранить изменения";
    if (deleteButton) deleteButton.hidden = false;
    renderCreateImages();
    dialog?.showModal();
    requestAnimationFrame(() => name?.focus());
  };

  const selectedLocations = () =>
    state.locations.filter((location) => state.selectedLocationIds.has(String(location.id)));

  const budgetWithLocations = (locationIds) => {
    if (api.referenceBudget) {
      return api.referenceBudget(state.selectedCharacterIds, locationIds, state.mutedCharacterIds);
    }
    const set = locationIds instanceof Set ? locationIds : new Set(locationIds || []);
    const images = state.locations.reduce(
      (sum, location) =>
        sum + (set.has(String(location.id)) ? Number(location.image_count || 0) : 0),
      0
    );
    return { images, audios: 0, total: images };
  };

  const renderSelectedLocations = () => {
    const countValue = selectedLocations().length;
    for (const selector of ["#v2-location-count", "#v2-mobile-location-count"]) {
      const count = qs(selector);
      if (count) {
        count.textContent = String(countValue);
        count.hidden = countValue === 0;
      }
    }
  };

  const filteredLocations = () => {
    const query = (search?.value || "").trim().toLocaleLowerCase("ru");
    const selectedOrder = new Map(
      Array.from(state.selectedLocationIds).map((id, index) => [String(id), index])
    );
    const list = state.locations.filter((item) => {
      if (!query) return true;
      return (String(item.name || "") + " " + String(item.prompt || ""))
        .toLocaleLowerCase("ru")
        .includes(query);
    });
    list.sort((a, b) => {
      const aId = String(a.id);
      const bId = String(b.id);
      const aSelected = selectedOrder.has(aId);
      const bSelected = selectedOrder.has(bId);
      if (aSelected && bSelected) return selectedOrder.get(aId) - selectedOrder.get(bId);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      return String(a.name || "").localeCompare(
        String(b.name || ""),
        ["ru", "en"],
        { sensitivity: "base", numeric: true }
      );
    });
    return list;
  };

  const toggleLocation = (locationId) => {
    const id = String(locationId);
    if (state.selectedLocationIds.has(id)) {
      state.selectedLocationIds.delete(id);
    } else {
      const candidate = new Set(state.selectedLocationIds);
      candidate.add(id);
      const budget = budgetWithLocations(candidate);
      if (budget.images > 9 || budget.audios > 3 || budget.total > 15) {
        showToast(
          "Лимит H3: до 9 изображений, 3 аудио и 15 reference media на одну генерацию.",
          "error"
        );
        return;
      }
      state.selectedLocationIds.add(id);
    }
    renderSelectedLocations();
    renderLocationGrid();
    api.updateCreateCompatibility?.();
    saveDraft();
  };

  const renderLocationGrid = () => {
    if (!grid) return;
    const list = filteredLocations();
    const total = qs("#v2-location-total");
    if (total) total.textContent = state.locations.length + " локаций";
    if (empty) empty.hidden = list.length > 0;

    const addCard =
      '<button class="v2-character-add-card v2-location-add-card" type="button" data-location-add-card>' +
        '<span class="v2-character-add-card-icon"><svg class="icon"><use href="/static/icons.svg#icon-plus"></use></svg></span>' +
        "<strong>Добавить локацию</strong>" +
      "</button>";

    const cards = list.map((location) => {
      const id = String(location.id);
      const selected = state.selectedLocationIds.has(id);
      const image = location.preview_url
        ? '<img src="' + escapeHtml(location.preview_url) + '" alt="">'
        : '<span class="v2-user-avatar"><svg class="icon"><use href="/static/icons.svg#icon-map-pin"></use></svg></span>';
      return (
        '<div class="v2-character-card v2-location-card' + (selected ? " selected" : "") + '" data-location-id="' + escapeHtml(id) + '">' +
          '<button class="v2-character-card-main" type="button" data-location-select="' + escapeHtml(id) + '">' +
            '<span class="v2-character-selectmark"><svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg></span>' +
            image +
            "<strong>" + escapeHtml(location.name) + "</strong>" +
          "</button>" +
          '<button class="v2-character-edit-button" type="button" data-location-edit="' + escapeHtml(id) + '" title="Редактировать локацию" aria-label="Редактировать локацию">' +
            '<svg class="icon"><use href="/static/icons.svg#icon-settings"></use></svg>' +
          "</button>" +
        "</div>"
      );
    }).join("");

    grid.innerHTML = addCard + cards;
    qs("[data-location-add-card]", grid)?.addEventListener("click", openCreateDialog);
    qsa("[data-location-select]", grid).forEach((button) => {
      button.addEventListener("click", () => toggleLocation(button.dataset.locationSelect));
    });
    qsa("[data-location-edit]", grid).forEach((button) => {
      button.addEventListener("click", () => openEditDialog(button.dataset.locationEdit));
    });
  };

  const refreshLocations = async () => {
    try {
      const result = await fetchJson("/api/locations");
      state.locations = Array.isArray(result.locations) ? result.locations : [];
      const valid = new Set(state.locations.map((item) => String(item.id)));
      state.selectedLocationIds = new Set(
        Array.from(state.selectedLocationIds).filter((id) => valid.has(String(id)))
      );
      renderSelectedLocations();
      renderLocationGrid();
      api.renderCharacterGrid?.();
    } catch (error) {
      showToast("Не удалось загрузить локации: " + error.message, "error");
    }
  };

  const activatePresetTab = (name) => {
    const next = name === "locations" ? "locations" : "characters";
    state.presetTab = next;
    qsa("[data-v2-preset-tab]").forEach((button) => {
      const active = button.dataset.v2PresetTab === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    qsa("[data-v2-preset-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.v2PresetPanel !== next;
    });
  };

  qsa("[data-v2-preset-tab]").forEach((button) => {
    button.addEventListener("click", () => activatePresetTab(button.dataset.v2PresetTab));
  });
  search?.addEventListener("input", renderLocationGrid);

  qsa("[data-location-create-close]").forEach((button) => {
    button.addEventListener("click", () => dialog?.close());
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog?.addEventListener("close", () => {
    clearPreviewUrls();
    newImageFiles = [];
  });

  imageInput?.addEventListener("change", () => addImageFiles(imageInput.files));
  previews?.addEventListener("click", (event) => {
    const existingButton = event.target.closest("[data-location-existing-image-remove]");
    if (existingButton) {
      keptExistingImageIndices.delete(Number(existingButton.dataset.locationExistingImageRemove));
      renderCreateImages();
      return;
    }
    const newButton = event.target.closest("[data-location-new-image-remove]");
    if (newButton) {
      newImageFiles.splice(Number(newButton.dataset.locationNewImageRemove), 1);
      renderCreateImages();
    }
  });
  ["dragenter", "dragover"].forEach((name) => {
    drop?.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    drop?.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("dragover");
    });
  });
  drop?.addEventListener("drop", (event) => addImageFiles(event.dataTransfer?.files));

  deleteButton?.addEventListener("click", async () => {
    if (!editingLocationId) return;
    const location = state.locations.find((item) => String(item.id) === editingLocationId);
    const label = location?.name ? " «" + location.name + "»" : "";
    if (!window.confirm("Удалить локацию" + label + "? Это удалит её референсы.")) return;

    deleteButton.disabled = true;
    try {
      await fetchJson("/api/locations/" + encodeURIComponent(editingLocationId), {
        method: "DELETE",
      });
      state.selectedLocationIds.delete(editingLocationId);
      dialog?.close();
      await refreshLocations();
      api.updateCreateCompatibility?.();
      saveDraft();
      showToast("Локация удалена.");
    } catch (error) {
      showToast("Не удалось удалить локацию: " + error.message, "error");
    } finally {
      deleteButton.disabled = false;
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = qs("#v2-location-create-name")?.value.trim() || "";
    const prompt = qs("#v2-location-create-prompt")?.value.trim() || "";
    if (!name) {
      showToast("Введите название локации.", "error");
      qs("#v2-location-create-name")?.focus();
      return;
    }
    const imageCount = keptExistingImageIndices.size + newImageFiles.length;
    if (imageCount < 1 || imageCount > 4) {
      showToast("У локации должно быть от 1 до 4 изображений.", "error");
      return;
    }

    const submit = qs("#v2-location-create-submit");
    if (submit) submit.disabled = true;
    const editedId = editingLocationId;
    try {
      const data = new FormData();
      data.set("name", name);
      data.set("prompt", prompt);
      newImageFiles.forEach((file) => data.append("images", file, file.name));

      let result;
      if (editedId) {
        data.set(
          "keep_image_indices",
          JSON.stringify(Array.from(keptExistingImageIndices).sort((a, b) => a - b))
        );
        result = await fetchJson("/api/locations/" + encodeURIComponent(editedId), {
          method: "POST",
          body: data,
        });
      } else {
        result = await fetchJson("/api/locations", { method: "POST", body: data });
      }

      dialog?.close();
      await refreshLocations();

      if (editedId) {
        const budget = budgetWithLocations(state.selectedLocationIds);
        if (
          state.selectedLocationIds.has(editedId) &&
          (budget.images > 9 || budget.audios > 3 || budget.total > 15)
        ) {
          state.selectedLocationIds.delete(editedId);
          renderSelectedLocations();
          renderLocationGrid();
          showToast(
            "Из-за новых референсов локация снята с выбора: превышен лимит H3.",
            "error"
          );
        } else {
          showToast("Локация обновлена.");
        }
      } else {
        showToast("Локация сохранена.");
        const id = String(result?.location?.id || "");
        if (id) {
          const candidate = new Set(state.selectedLocationIds);
          candidate.add(id);
          const budget = budgetWithLocations(candidate);
          if (budget.images <= 9 && budget.audios <= 3 && budget.total <= 15) {
            state.selectedLocationIds.add(id);
            renderSelectedLocations();
            renderLocationGrid();
          }
        }
      }

      api.updateCreateCompatibility?.();
      saveDraft();
    } catch (error) {
      showToast(
        (editedId ? "Не удалось обновить локацию: " : "Не удалось сохранить локацию: ") +
          error.message,
        "error"
      );
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  activatePresetTab(state.presetTab);
  renderSelectedLocations();

  Object.assign(api, {
    selectedLocations,
    refreshLocations,
    renderLocationGrid,
    renderSelectedLocations,
    activatePresetTab,
  });
})();