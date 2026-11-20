(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { state, qs, qsa, fetchJson, showToast, escapeHtml, saveDraft } = api;

  const characterGrid = qs("#v2-character-grid");
  const characterEmpty = qs("#v2-character-empty");
  const characterSearch = qs("#v2-character-search");

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

  const currentAssistantSettings = () => ({
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
    currentAssistantSettings,
    renderCharacterGrid,
    renderSelectedCharacters,
  });
})();