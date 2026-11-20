(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const app = qs(".v2-app");
  if (!app) return;

  const userId = app.dataset.userId || "user";
  const DRAFT_KEY = "aivideosite-" + userId + "-v2-draft";
  const VIEW_KEY = "aivideosite-" + userId + "-v2-view";
  const RECENT_CHARACTERS_KEY = "aivideosite-" + userId + "-v2-recent-characters";

  const titleMap = {
    create: "Создать видео",
    continue: "Продолжить видео",
    audio: "Видео по аудио",
    clip: "Продолжить клип",
    library: "Библиотека",
    queue: "Очередь",
    editor: "Монтаж",
    chat: "Чат",
    system: "Система",
    instruction: "Инструкция",
  };

  const state = {
    view: "create",
    characters: [],
    selectedCharacterIds: new Set(),
    recentCharacterIds: [],
    characterTab: "all",
    uploadUrls: new Map(),
    draft: {
      prompt: "",
      quality: "720",
      ratio: "16:9",
      seconds: "10",
      steps: "12",
      seed: "",
      audio: true,
    },
  };

  const toast = qs("#v2-toast");
  let toastTimer = null;

  const showToast = (message, kind = "info") => {
    if (!toast) return;
    toast.textContent = String(message || "");
    toast.classList.toggle("error", kind === "error");
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  };

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const copyFallback = (text) => {
    const helper = document.createElement("textarea");
    helper.value = String(text || "");
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    helper.style.top = "0";
    document.body.appendChild(helper);
    helper.focus({ preventScroll: true });
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      helper.remove();
    }
    return ok;
  };

  const copyText = async (text) => {
    const value = String(text || "");
    if (!value) throw new Error("empty");
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // HTTP/LAN and browser permissions can reject Clipboard API.
      }
    }
    if (!copyFallback(value)) throw new Error("copy failed");
  };

  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "X-Requested-With": "AI-Video-Site-V2",
        ...(options.headers || {}),
      },
      ...options,
    });
    if (response.status === 401) {
      location.href = "/login";
      throw new Error("Требуется вход.");
    }
    if (!response.ok) {
      let detail = "HTTP " + response.status;
      try {
        const body = await response.json();
        detail = body.detail || body.error || detail;
      } catch {
        // Keep HTTP fallback.
      }
      throw new Error(detail);
    }
    return response.json();
  };

  const readStoredJson = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "");
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  const saveDraft = () => {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          ...state.draft,
          selectedCharacterIds: Array.from(state.selectedCharacterIds),
        })
      );
      localStorage.setItem(VIEW_KEY, state.view);
      localStorage.setItem(RECENT_CHARACTERS_KEY, JSON.stringify(state.recentCharacterIds.slice(0, 30)));
    } catch {
      // V2 remains usable when browser storage is disabled.
    }
  };

  const loadDraft = () => {
    const saved = readStoredJson(DRAFT_KEY, {});
    if (saved && typeof saved === "object") {
      ["prompt", "quality", "ratio", "seconds", "steps", "seed"].forEach((key) => {
        if (saved[key] !== undefined && saved[key] !== null) {
          state.draft[key] = String(saved[key]);
        }
      });
      if (typeof saved.audio === "boolean") state.draft.audio = saved.audio;
      if (Array.isArray(saved.selectedCharacterIds)) {
        state.selectedCharacterIds = new Set(saved.selectedCharacterIds.map(String));
      }
    }
    const recent = readStoredJson(RECENT_CHARACTERS_KEY, []);
    if (Array.isArray(recent)) {
      state.recentCharacterIds = recent.map(String).slice(0, 30);
    }
  };

  const setView = (nextView, { updateHash = true } = {}) => {
    const view = titleMap[nextView] ? nextView : "create";
    state.view = view;
    qsa("[data-v2-view]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.v2View === view);
    });
    qsa("[data-v2-nav]").forEach((button) => {
      button.classList.toggle("active", button.dataset.v2Nav === view);
    });
    const title = qs("#v2-page-title");
    if (title) title.textContent = titleMap[view];
    if (updateHash) {
      history.replaceState(null, "", view === "create" ? "/v2" : "/v2#" + view);
    }
    saveDraft();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  qsa("[data-v2-nav]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.v2Nav));
  });

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

  const prompt = qs("#v2-prompt");
  const promptCount = qs("#v2-prompt-count");
  const seed = qs("#v2-seed");
  const audio = qs("#v2-audio");

  const updatePromptCount = () => {
    if (promptCount && prompt) promptCount.textContent = prompt.value.length.toLocaleString("ru-RU") + " / 16 000";
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
        return;
      }

      const url = URL.createObjectURL(file);
      state.uploadUrls.set(kind, url);
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
      remove.hidden = false;
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
    if (count) count.textContent = String(chosen.length);
    if (tabCount) tabCount.textContent = String(chosen.length);
    if (!container) return;

    if (!chosen.length) {
      container.innerHTML = '<span class="v2-empty-inline">Персонажи не выбраны</span>';
      return;
    }

    container.innerHTML = chosen
      .map((character) => {
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
      })
      .join("");

    qsa("[data-character-chip] button", container).forEach((button) => {
      button.addEventListener("click", () => {
        const chip = button.closest("[data-character-chip]");
        if (!chip) return;
        state.selectedCharacterIds.delete(chip.dataset.characterChip);
        renderSelectedCharacters();
        renderCharacterGrid();
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
      list = list.filter((item) => {
        const haystack = (String(item.name || "") + " " + String(item.description || "")).toLowerCase();
        return haystack.includes(search);
      });
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
          "Лимит одной H3-задачи: до 9 изображений, 3 аудио и 15 reference media. Список персонажей может быть большим, но выбрать в одну генерацию можно только то, что помещается в лимит.",
          "error"
        );
        return;
      }
      state.selectedCharacterIds.add(id);
      state.recentCharacterIds = [id, ...state.recentCharacterIds.filter((value) => value !== id)].slice(0, 30);
    }
    renderSelectedCharacters();
    renderCharacterGrid();
    saveDraft();
  };

  const renderCharacterGrid = () => {
    if (!characterGrid) return;
    const list = filteredCharacters();
    const total = qs("#v2-character-total");
    if (total) total.textContent = state.characters.length + " персонажей";
    if (characterEmpty) characterEmpty.hidden = list.length > 0;
    characterGrid.innerHTML = list
      .map((character) => {
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
      })
      .join("");

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
  characterSearch?.addEventListener("input", renderCharacterGrid);
  qsa("[data-character-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.characterTab = button.dataset.characterTab || "all";
      qsa("[data-character-tab]").forEach((item) => item.classList.toggle("active", item === button));
      renderCharacterGrid();
    });
  });

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
          messages: [
            {
              role: "user",
              content:
                "Перепиши только этот пользовательский запрос в production-ready MiniMax H3 prompt для текущего состояния V2. " +
                "Не меняй настройки формы. Верни только changes.prompt; message сделай очень коротким. " +
                "H3 prompt должен быть на английском, но точные реплики, lyrics и visible text сохрани на исходном языке.\n\n" +
                source,
            },
          ],
          settings: currentAssistantSettings(),
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

  qs("#v2-generate")?.addEventListener("click", () => {
    showToast("Экран V2 уже готов. Подключение simplified V2 → H3 generation будет следующим этапом после визуальной проверки этого shell.");
  });

  const copyFullChatGptGuide = async (button) => {
    const original = button?.textContent || "";
    if (button) button.disabled = true;
    try {
      const [siteResponse, h3Response] = await Promise.all([
        fetch("/static/v2-chatgpt-site-guide.txt", { cache: "no-store" }),
        fetch("/static/h3-prompting-guide-ai.txt", { cache: "no-store" }),
      ]);
      if (!siteResponse.ok || !h3Response.ok) throw new Error("guide unavailable");
      const siteGuide = await siteResponse.text();
      const h3Guide = await h3Response.text();
      const combined =
        siteGuide.trim() +
        "\n\n\n=====================================================\n" +
        "FULL CURRENT MINIMAX H3 MACHINE GUIDE\n" +
        "=====================================================\n\n" +
        h3Guide.trim() +
        "\n";
      await copyText(combined);
      showToast("Полная инструкция для ChatGPT скопирована.");
    } catch {
      showToast("Не удалось скопировать инструкцию.", "error");
    } finally {
      if (button) {
        button.disabled = false;
        if (original) button.textContent = original;
      }
    }
  };

  ["#v2-copy-chatgpt", "#v2-copy-chatgpt-bottom"].forEach((selector) => {
    const button = qs(selector);
    button?.addEventListener("click", () => copyFullChatGptGuide(button));
  });

  const compactGpuName = (gpu) => {
    const raw = String(gpu?.name || "");
    const match = raw.match(/RTX\s*\d+(?:\s*Ti)?/i);
    return match ? match[0].replace(/RTX\s*/i, "RTX ") : "GPU " + (gpu?.index ?? "");
  };

  const formatVramPart = (valueMb, digits = 1) => {
    const value = Number(valueMb);
    if (!Number.isFinite(value)) return "—";
    return (value / 1024).toFixed(digits);
  };

  const renderGpu = (element, gpu, fallback) => {
    if (!element) return;
    if (!gpu) {
      element.innerHTML =
        '<span class="status-dot"></span><span class="v2-gpu-model">' +
        escapeHtml(fallback) +
        "</span>";
      element.classList.remove("online");
      return;
    }

    const used = formatVramPart(gpu.memory_used_mb, 1);
    const total = formatVramPart(gpu.memory_total_mb, 0);
    const utilization = Number.isFinite(Number(gpu.utilization)) ? Number(gpu.utilization) : 0;
    element.innerHTML =
      '<span class="status-dot"></span>' +
      '<span class="v2-gpu-model">' + escapeHtml(compactGpuName(gpu)) + "</span>" +
      '<span class="v2-gpu-separator"></span>' +
      '<span class="v2-gpu-metric"><span>VRAM</span><b>' + used + " / " + total + " GB</b></span>" +
      '<span class="v2-gpu-separator"></span>' +
      '<span class="v2-gpu-load">LOAD <b>' + utilization + "%</b></span>";
    element.classList.add("online");
  };

  const refreshSystem = async () => {
    try {
      const data = await fetchJson("/api/state?media_page=1&jobs_page=1");
      const gpus = Array.isArray(data?.system?.gpus) ? data.system.gpus : [];
      renderGpu(qs("#v2-gpu-0"), gpus.find((item) => Number(item.index) === 0), "GPU 0 · нет данных");
      renderGpu(qs("#v2-gpu-1"), gpus.find((item) => Number(item.index) === 1), "GPU 1 · нет данных");
    } catch {
      renderGpu(qs("#v2-gpu-0"), null, "GPU 0 · недоступна");
      renderGpu(qs("#v2-gpu-1"), null, "GPU 1 · недоступна");
    }
  };

  const leftRail = qs(".v2-sidebar");
  const rightRail = qs("#v2-character-rail");

  const bindHoverRail = (element, className) => {
    if (!element) return;
    let closeTimer = null;
    const open = () => {
      clearTimeout(closeTimer);
      app.classList.add(className);
    };
    const close = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => app.classList.remove(className), 90);
    };
    element.addEventListener("mouseenter", open);
    element.addEventListener("mouseleave", close);
    element.addEventListener("focusin", open);
    element.addEventListener("focusout", (event) => {
      if (!element.contains(event.relatedTarget)) close();
    });
  };

  bindHoverRail(leftRail, "left-open");
  bindHoverRail(rightRail, "right-open");

  const restoreDraftToUi = () => {
    if (prompt) prompt.value = state.draft.prompt;
    if (seed) seed.value = state.draft.seed;
    if (audio) audio.checked = Boolean(state.draft.audio);
    ["quality", "ratio", "seconds", "steps"].forEach((key) => applySegment(key, state.draft[key], false));
    updatePromptCount();
  };

  loadDraft();
  restoreDraftToUi();

  const hashView = location.hash.replace(/^#/, "");
  const storedView = localStorage.getItem(VIEW_KEY) || "";
  setView(titleMap[hashView] ? hashView : titleMap[storedView] ? storedView : "create", { updateHash: false });

  refreshCharacters();
  refreshSystem();
  setInterval(refreshSystem, 8000);

  window.addEventListener("beforeunload", () => {
    state.uploadUrls.forEach((url) => URL.revokeObjectURL(url));
    state.uploadUrls.clear();
  });
})();