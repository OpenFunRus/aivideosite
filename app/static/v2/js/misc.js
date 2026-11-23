(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, escapeHtml, saveDraft } = api;

  if (!(state.selectedMiscIds instanceof Set)) state.selectedMiscIds = new Set();
  if (!Array.isArray(state.misc)) state.misc = [];

  const grid = qs("#v2-misc-grid");
  const empty = qs("#v2-misc-empty");
  const search = qs("#v2-misc-search");
  const dialog = qs("#v2-misc-create-dialog");
  const form = qs("#v2-misc-create-form");
  const imageInput = qs("#v2-misc-create-images");
  const drop = qs("#v2-misc-reference-drop");
  const previews = qs("#v2-misc-reference-previews");
  const referenceCount = qs("#v2-misc-reference-count");
  const categoryInput = qs("#v2-misc-create-category");
  const formTitle = qs("#v2-misc-form-title");
  const formSubtitle = qs("#v2-misc-form-subtitle");
  const submitLabel = qs("#v2-misc-submit-label");
  const deleteButton = qs("#v2-misc-delete");

  let newImageFiles = [];
  let existingImageUrls = [];
  let keptExistingImageIndices = new Set();
  let editingMiscId = "";

  const clearPreviewUrls = () => {
    qsa("[data-misc-preview-url]", previews || document).forEach((node) => {
      const url = node.dataset.miscPreviewUrl;
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
        '<button type="button" data-misc-existing-image-remove="' + index + '" aria-label="Убрать изображение">' +
        '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>';
    });
    const newMarkup = newImageFiles.map((file, index) => {
      const url = URL.createObjectURL(file);
      return '<div class="v2-character-reference-preview" data-misc-preview-url="' + escapeHtml(url) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="Новый референс ' + (index + 1) + '">' +
        '<span class="v2-character-reference-existing new">Новый</span>' +
        '<button type="button" data-misc-new-image-remove="' + index + '" aria-label="Убрать изображение">' +
        '<svg class="icon"><use href="/static/icons.svg#icon-x"></use></svg></button></div>';
    });
    previews.innerHTML = oldMarkup.concat(newMarkup).join("");
  };

  const addImageFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((file) => file?.type?.startsWith("image/"));
    const free = Math.max(0, 4 - keptExistingImageIndices.size - newImageFiles.length);
    if (incoming.length > free) showToast("Для одного пресета можно сохранить до 4 изображений.", "error");
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
    editingMiscId = "";
    if (categoryInput) categoryInput.value = "prop";
    if (formTitle) formTitle.textContent = "Добавить пресет";
    if (formSubtitle) formSubtitle.textContent = "Сохраните предмет, особенность, одежду, транспорт, позу или другой повторяемый визуальный элемент для H3.";
    if (submitLabel) submitLabel.textContent = "Сохранить пресет";
    if (deleteButton) deleteButton.hidden = true;
    drop?.classList.remove("dragover");
    renderCreateImages();
  };

  const openCreateDialog = () => {
    resetForm();
    dialog?.showModal();
    requestAnimationFrame(() => qs("#v2-misc-create-name")?.focus());
  };

  const openEditDialog = (miscId) => {
    const preset = state.misc.find((item) => String(item.id) === String(miscId));
    if (!preset) return showToast("Пресет не найден.", "error");
    resetForm();
    editingMiscId = String(preset.id);
    existingImageUrls = Array.isArray(preset.image_urls) ? preset.image_urls.slice(0, 4) : (preset.preview_url ? [preset.preview_url] : []);
    keptExistingImageIndices = new Set(existingImageUrls.map((_, index) => index));
    const name = qs("#v2-misc-create-name");
    const description = qs("#v2-misc-create-description");
    if (name) name.value = preset.name || "";
    if (categoryInput) categoryInput.value = preset.category || "other";
    if (description) description.value = preset.description || "";
    if (formTitle) formTitle.textContent = "Редактировать пресет";
    if (formSubtitle) formSubtitle.textContent = "Измените категорию, описание и референсы. Старые изображения сохранятся, пока вы их явно не уберёте.";
    if (submitLabel) submitLabel.textContent = "Сохранить изменения";
    if (deleteButton) deleteButton.hidden = false;
    renderCreateImages();
    dialog?.showModal();
    requestAnimationFrame(() => name?.focus());
  };

  const selectedMisc = () => state.misc.filter((preset) => state.selectedMiscIds.has(String(preset.id)));

  const budgetWithMisc = (miscIds) => {
    if (api.referenceBudget) {
      return api.referenceBudget(state.selectedCharacterIds, state.selectedLocationIds, state.mutedCharacterIds, miscIds);
    }
    const set = miscIds instanceof Set ? miscIds : new Set(miscIds || []);
    const images = state.misc.reduce((sum, preset) =>
      sum + (set.has(String(preset.id)) ? Number(preset.image_count || 0) : 0), 0);
    return { images, audios: 0, total: images };
  };

  const budgetExceeded = (budget) =>
    api.referenceBudgetExceeded
      ? api.referenceBudgetExceeded(budget)
      : (budget.images > 9 || budget.audios > 3 || budget.total > 15);
  const budgetMessage = () =>
    api.referenceBudgetMessage
      ? api.referenceBudgetMessage()
      : "Лимит H3: до 9 изображений, 3 аудио и 15 reference media на одну генерацию.";

  const renderSelectedMisc = () => {
    const countValue = selectedMisc().length;
    ["#v2-misc-count", "#v2-mobile-misc-count"].forEach((selector) => {
      const count = qs(selector);
      if (!count) return;
      count.textContent = String(countValue);
      count.hidden = countValue === 0;
    });
  };

  const filteredMisc = () => {
    const query = (search?.value || "").trim().toLocaleLowerCase("ru");
    const order = new Map(Array.from(state.selectedMiscIds).map((id, index) => [String(id), index]));
    const list = state.misc.filter((item) => !query || (
      String(item.name || "") + " " + String(item.category_label || "") + " " + String(item.description || "")
    ).toLocaleLowerCase("ru").includes(query));
    list.sort((a, b) => {
      const ai=String(a.id), bi=String(b.id), as=order.has(ai), bs=order.has(bi);
      if (as && bs) return order.get(ai) - order.get(bi);
      if (as !== bs) return as ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""), ["ru","en"], { sensitivity:"base", numeric:true });
    });
    return list;
  };

  const toggleMisc = (miscId) => {
    const id = String(miscId);
    if (state.selectedMiscIds.has(id)) state.selectedMiscIds.delete(id);
    else {
      const candidate = new Set(state.selectedMiscIds);
      candidate.add(id);
      const budget = budgetWithMisc(candidate);
      if (budgetExceeded(budget)) {
        showToast(budgetMessage(), "error");
        return;
      }
      state.selectedMiscIds.add(id);
    }
    renderSelectedMisc();
    renderMiscGrid();
    api.updateCreateCompatibility?.();
    saveDraft();
  };

  const renderMiscGrid = () => {
    if (!grid) return;
    const list = filteredMisc();
    const total = qs("#v2-misc-total");
    if (total) total.textContent = state.misc.length + " пресетов";
    if (empty) empty.hidden = list.length > 0;
    const addCard = '<button class="v2-character-add-card v2-misc-add-card" type="button" data-misc-add-card>' +
      '<span class="v2-character-add-card-icon"><svg class="icon"><use href="/static/icons.svg#icon-plus"></use></svg></span><strong><span>Добавить</span><span>пресет</span></strong></button>';
    const cards = list.map((preset) => {
      const id=String(preset.id), selected=state.selectedMiscIds.has(id);
      const image=preset.preview_url ? '<img src="'+escapeHtml(preset.preview_url)+'" alt="">' :
        '<span class="v2-user-avatar"><svg class="icon"><use href="/static/icons.svg#icon-stack"></use></svg></span>';
      return '<div class="v2-character-card v2-misc-card'+(selected?" selected":"")+'" data-misc-id="'+escapeHtml(id)+'">' +
        '<button class="v2-character-card-main" type="button" data-misc-select="'+escapeHtml(id)+'">' +
        '<span class="v2-character-selectmark"><svg class="icon"><use href="/static/icons.svg#icon-check"></use></svg></span>' +
        image + '<span class="v2-misc-category-chip">'+escapeHtml(preset.category_label || "Другое")+'</span><strong>'+escapeHtml(preset.name)+'</strong></button>' +
        '<button class="v2-character-edit-button" type="button" data-misc-edit="'+escapeHtml(id)+'" aria-label="Редактировать пресет"><svg class="icon"><use href="/static/icons.svg#icon-settings"></use></svg></button></div>';
    }).join("");
    grid.innerHTML = addCard + cards;
    qs("[data-misc-add-card]", grid)?.addEventListener("click", openCreateDialog);
    qsa("[data-misc-select]", grid).forEach((button) => button.addEventListener("click", () => toggleMisc(button.dataset.miscSelect)));
    qsa("[data-misc-edit]", grid).forEach((button) => button.addEventListener("click", () => openEditDialog(button.dataset.miscEdit)));
  };

  const refreshMisc = async () => {
    try {
      const result = await fetchJson("/api/misc");
      state.misc = Array.isArray(result.misc) ? result.misc : [];
      const valid = new Set(state.misc.map((item) => String(item.id)));
      state.selectedMiscIds = new Set(Array.from(state.selectedMiscIds).filter((id) => valid.has(String(id))));
      renderSelectedMisc();
      renderMiscGrid();
      api.renderCharacterGrid?.();
      api.renderLocationGrid?.();
    } catch (error) {
      showToast("Не удалось загрузить «Прочее»: " + error.message, "error");
    }
  };

  search?.addEventListener("input", renderMiscGrid);
  qsa("[data-misc-create-close]").forEach((button) => button.addEventListener("click", () => dialog?.close()));
  dialog?.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog?.addEventListener("close", () => { clearPreviewUrls(); newImageFiles = []; });
  imageInput?.addEventListener("change", () => addImageFiles(imageInput.files));
  previews?.addEventListener("click", (event) => {
    const old = event.target.closest("[data-misc-existing-image-remove]");
    if (old) { keptExistingImageIndices.delete(Number(old.dataset.miscExistingImageRemove)); renderCreateImages(); return; }
    const fresh = event.target.closest("[data-misc-new-image-remove]");
    if (fresh) { newImageFiles.splice(Number(fresh.dataset.miscNewImageRemove), 1); renderCreateImages(); }
  });
  ["dragenter","dragover"].forEach((name) => drop?.addEventListener(name, (event) => {
    event.preventDefault(); drop.classList.add("dragover");
  }));
  ["dragleave","drop"].forEach((name) => drop?.addEventListener(name, (event) => {
    event.preventDefault(); drop.classList.remove("dragover");
  }));
  drop?.addEventListener("drop", (event) => addImageFiles(event.dataTransfer?.files));

  deleteButton?.addEventListener("click", async () => {
    if (!editingMiscId) return;
    const preset=state.misc.find((item)=>String(item.id)===editingMiscId);
    if (!window.confirm("Удалить пресет" + (preset?.name ? " «"+preset.name+"»" : "") + "? Это удалит его референсы.")) return;
    deleteButton.disabled=true;
    try {
      await fetchJson("/api/misc/"+encodeURIComponent(editingMiscId), {method:"DELETE"});
      state.selectedMiscIds.delete(editingMiscId);
      dialog?.close(); await refreshMisc(); api.updateCreateCompatibility?.(); saveDraft(); showToast("Пресет удалён.");
    } catch(error) { showToast("Не удалось удалить пресет: "+error.message,"error"); }
    finally { deleteButton.disabled=false; }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name=qs("#v2-misc-create-name")?.value.trim() || "";
    const category=categoryInput?.value || "other";
    const description=qs("#v2-misc-create-description")?.value.trim() || "";
    if (!name) { showToast("Введите название пресета.","error"); qs("#v2-misc-create-name")?.focus(); return; }
    const imageCount=keptExistingImageIndices.size+newImageFiles.length;
    if (imageCount<1 || imageCount>4) { showToast("У пресета должно быть от 1 до 4 изображений.","error"); return; }
    const submit=qs("#v2-misc-create-submit"); if(submit) submit.disabled=true;
    const editedId=editingMiscId;
    try {
      const data=new FormData();
      data.set("name",name); data.set("category",category); data.set("description",description);
      newImageFiles.forEach((file)=>data.append("images",file,file.name));
      let result;
      if(editedId){
        data.set("keep_image_indices",JSON.stringify(Array.from(keptExistingImageIndices).sort((a,b)=>a-b)));
        result=await fetchJson("/api/misc/"+encodeURIComponent(editedId),{method:"POST",body:data});
      } else result=await fetchJson("/api/misc",{method:"POST",body:data});
      dialog?.close(); await refreshMisc();
      if(editedId){
        const budget=budgetWithMisc(state.selectedMiscIds);
        if(state.selectedMiscIds.has(editedId)&&budgetExceeded(budget)){
          state.selectedMiscIds.delete(editedId); renderSelectedMisc(); renderMiscGrid();
          showToast("Из-за новых референсов пресет снят с выбора: превышен лимит H3.","error");
        } else showToast("Пресет обновлён.");
      } else {
        showToast("Пресет сохранён.");
        const id=String(result?.misc?.id||"");
        if(id){
          const candidate=new Set(state.selectedMiscIds); candidate.add(id);
          const budget=budgetWithMisc(candidate);
          if(!budgetExceeded(budget)){
            state.selectedMiscIds.add(id); renderSelectedMisc(); renderMiscGrid();
          }
        }
      }
      api.updateCreateCompatibility?.(); saveDraft();
    } catch(error) {
      showToast((editedId?"Не удалось обновить пресет: ":"Не удалось сохранить пресет: ")+error.message,"error");
    } finally { if(submit) submit.disabled=false; }
  });

  // Render the add-card immediately, before /api/misc finishes. This keeps the
  // creation entry point available even if the list request is slow or fails.
  renderSelectedMisc();
  renderMiscGrid();
  Object.assign(api,{selectedMisc,refreshMisc,renderMiscGrid,renderSelectedMisc});
})();