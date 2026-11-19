(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const appPage = qs(".app-page");
  if (!appPage) return;

  const appShell = qs(".app-shell");
  const currentUserId = appShell?.dataset.userId || "user";
  const STORAGE_PREFIX = `aivideosite-${currentUserId}-`;
  const SETTINGS_KEY = `${STORAGE_PREFIX}settings-v2`;
  const VIEW_KEY = `${STORAGE_PREFIX}view`;
  const EDITOR_EXPORT_JOB_KEY = `${STORAGE_PREFIX}editor-export-job`;

  if (currentUserId === "user1") {
    const legacySettings = localStorage.getItem("aivideosite-settings-v1");
    if (!localStorage.getItem(SETTINGS_KEY) && legacySettings) {
      localStorage.setItem(SETTINGS_KEY, legacySettings);
    }
    const legacyView = localStorage.getItem("aivideosite-view");
    if (!localStorage.getItem(VIEW_KEY) && legacyView) {
      localStorage.setItem(VIEW_KEY, legacyView);
    }
    const legacyEditorJob = localStorage.getItem("aivideosite-editor-export-job");
    if (!localStorage.getItem(EDITOR_EXPORT_JOB_KEY) && legacyEditorJob) {
      localStorage.setItem(EDITOR_EXPORT_JOB_KEY, legacyEditorJob);
    }
    localStorage.removeItem("aivideosite-settings-v1");
    localStorage.removeItem("aivideosite-view");
    localStorage.removeItem("aivideosite-editor-export-job");
  }

  let stateTimer = null;
  let lastState = null;
  let lastMediaSignature = "";
  let mediaPage = 1;
  let jobsPage = 1;
  let serverClockAtFetchMs = null;
  let serverClockPerfAtFetch = null;
  let currentView = localStorage.getItem(VIEW_KEY) || "generate";
  const uploadObjectUrls = new Map();
  let characters = [];
  const selectedCharacterIds = new Set();
  let refreshCharacters = async () => {};
  let editorMedia = [];
  let editorClips = [];
  let editorDraggedClipIndex = null;
  let refreshEditorMedia = async () => {};
  let editorAudio = {
    file: null,
    objectUrl: "",
    duration: 0,
    offset: 0,
    trimStart: 0,
    trimDuration: 0,
    volume: 1,
  };

  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-${name}"></use></svg>`;

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        "X-Requested-With": "AI-Video-Site",
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      location.href = "/login";
      throw new Error("Требуется вход");
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (!response.ok) {
      throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    }
    return body;
  };

  const showToast = (message, type = "success") => {
    const container = qs("#toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      ${icon(type === "error" ? "alert" : "check")}
      <div>${escapeHtml(message)}</div>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  };

  const humanBytes = (bytes) => {
    const value = Number(bytes || 0);
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
      Math.floor(Math.log(value) / Math.log(1024)),
      units.length - 1
    );
    return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
  };

  const humanDuration = (seconds) => {
    if (seconds === null || seconds === undefined) return "—";
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "—";
    if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} сек`;
    const minutes = Math.floor(value / 60);
    return `${minutes}:${String(Math.round(value % 60)).padStart(2, "0")}`;
  };

  const shortDate = (iso) => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  };

  const formatHms = (seconds) => {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return [hours, minutes, secs]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  };

  const syncedServerNowMs = () => {
    if (serverClockAtFetchMs === null || serverClockPerfAtFetch === null) {
      return Date.now();
    }
    return serverClockAtFetchMs + (performance.now() - serverClockPerfAtFetch);
  };

  const elapsedBetween = (startIso, endIso = null) => {
    if (!startIso) return null;
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : syncedServerNowMs();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, (end - start) / 1000);
  };

  const jobElapsed = (job) =>
    elapsedBetween(job.started_at, job.finished_at || null);

  const jobWait = (job) => {
    if (!job.created_at) return null;
    if (job.started_at) {
      return elapsedBetween(job.created_at, job.started_at);
    }
    if (job.status === "queued") {
      return elapsedBetween(job.created_at);
    }
    return null;
  };

  const updateLiveJobTimers = () => {
    qsa("#job-list [data-job-start]").forEach((element) => {
      const start = element.dataset.jobStart || "";
      const finished = element.dataset.jobFinished || "";
      const elapsed = elapsedBetween(start, finished || null);
      element.textContent = elapsed === null ? "—" : formatHms(elapsed);
    });

    qsa("#job-list [data-job-created]").forEach((element) => {
      const created = element.dataset.jobCreated || "";
      const started = element.dataset.jobStarted || "";
      const status = element.dataset.jobStatus || "";
      let elapsed = null;
      if (started) {
        elapsed = elapsedBetween(created, started);
      } else if (status === "queued") {
        elapsed = elapsedBetween(created);
      }
      element.textContent = elapsed === null ? "—" : formatHms(elapsed);
    });
  };

  const switchView = (view, refresh = false, persist = true) => {
    if (!["generate", "characters", "editor", "library", "queue"].includes(view)) view = "generate";
    currentView = view;
    if (persist) {
      localStorage.setItem(VIEW_KEY, view);
    }

    qsa("[data-view]").forEach((element) =>
      element.classList.toggle("active", element.dataset.view === view)
    );
    qsa("[data-nav]").forEach((element) =>
      element.classList.toggle("active", element.dataset.nav === view)
    );

    const titles = {
      generate: "Генерация",
      characters: "Персонажи",
      editor: "Монтаж",
      library: "Библиотека",
      queue: "Очередь",
    };
    qs("#page-title").textContent = titles[view];

    if (view === "characters") {
      refreshCharacters();
    }
    if (view === "generate") {
      refreshCharacters();
    }
    if (view === "editor") {
      refreshEditorMedia();
    }
    if (refresh) {
      refreshState(true, view === "library");
    }
  };

  qsa("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.nav, true));
  });
  switchView(currentView);

  const generationForm = qs("#generate-form");
  const secondsRange = qs("#seconds-range");
  const secondsValue = qs("#seconds-value");
  const resolutionSelect = qs("#resolution");

  const RESOLUTION_RATIOS = {
    "1:1": [1, 1],
    "2:3": [2, 3],
    "3:2": [3, 2],
    "3:4": [3, 4],
    "4:3": [4, 3],
    "9:16": [9, 16],
    "16:9": [16, 9],
    "21:9": [21, 9],
  };
  const RESOLUTION_TIERS = [
    { tier: "360", short: 384, label: "360p" },
    { tier: "480", short: 480, label: "480p" },
    { tier: "720", short: 736, label: "720p" },
    { tier: "1080", short: 1088, label: "1080p" },
  ];
  const roundGridUp = (value) => Math.ceil(Number(value) / 32) * 32;
  const buildResolutionPresets = (ratioName) => {
    const [rw, rh] = RESOLUTION_RATIOS[ratioName] || RESOLUTION_RATIOS["16:9"];
    const ratio = rw / rh;
    const presets = RESOLUTION_TIERS.map(({ tier, short, label }) => {
      let width = short;
      let height = short;
      if (ratio > 1) {
        height = short;
        width = roundGridUp(short * ratio);
      } else if (ratio < 1) {
        width = short;
        height = roundGridUp(short / ratio);
      }
      return {
        value: `${width}x${height}`,
        tier,
        label: `${label} · ${width} × ${height}`,
      };
    });
    if (ratioName === "1:1") {
      presets.unshift({
        value: "256x256",
        tier: "draft",
        label: "256 × 256 · быстрый тест",
      });
    }
    return presets;
  };
  const RESOLUTION_PRESETS = Object.fromEntries(
    Object.keys(RESOLUTION_RATIOS).map((ratio) => [ratio, buildResolutionPresets(ratio)])
  );
  const DEFAULT_RESOLUTION_SHAPE = "16:9";
  const DEFAULT_RESOLUTION = "1312x736";
  const LEGACY_PROFILE_MAP = {
    fast: "steps8",
    quality: "steps20",
    max: "steps20",
  };
  const PROFILE_LABELS = {
    steps4: "4 шага · Turbo",
    steps8: "8 шагов · Turbo",
    steps12: "12 шагов · Base",
    steps16: "16 шагов · Base",
    steps20: "20 шагов · Base",
    fast: "Fast · Turbo 8 (старый)",
    quality: "Quality · Base 20 (старый)",
    max: "Max · Base 30 (старый)",
  };

  const inferResolutionShape = (value) => {
    const [width, height] = String(value || "").split("x").map(Number);
    if (!width || !height) return DEFAULT_RESOLUTION_SHAPE;
    const ratio = width / height;
    return Object.entries(RESOLUTION_RATIOS).reduce(
      (best, [name, [rw, rh]]) => {
        const error = Math.abs(Math.log(ratio / (rw / rh)));
        return error < best.error ? { name, error } : best;
      },
      { name: DEFAULT_RESOLUTION_SHAPE, error: Number.POSITIVE_INFINITY }
    ).name;
  };

  const inferResolutionTier = (value) => {
    const [width, height] = String(value || "").split("x").map(Number);
    if (!width || !height) return "";
    const shortSide = Math.min(width, height);
    if (width === height && shortSide <= 256) return "draft";
    if (shortSide <= 400) return "360";
    if (shortSide <= 600) return "480";
    if (shortSide <= 900) return "720";
    return "1080";
  };

  const renderResolutionOptions = (
    shape,
    preferredValue = "",
    preferredTier = ""
  ) => {
    const normalizedShape = RESOLUTION_PRESETS[shape]
      ? shape
      : DEFAULT_RESOLUTION_SHAPE;
    const presets = RESOLUTION_PRESETS[normalizedShape];
    const previousTier =
      preferredTier || resolutionSelect?.selectedOptions?.[0]?.dataset?.tier || "";
    if (!resolutionSelect) return;

    resolutionSelect.innerHTML = presets
      .map(
        (preset) =>
          `<option value="${preset.value}" data-tier="${preset.tier}">${preset.label}</option>`
      )
      .join("");

    const preferred = presets.find((preset) => preset.value === preferredValue);
    const sameTier = presets.find((preset) => preset.tier === previousTier);
    const fallback =
      normalizedShape === DEFAULT_RESOLUTION_SHAPE
        ? presets.find((preset) => preset.value === DEFAULT_RESOLUTION)
        : presets.find((preset) => preset.tier === "720");
    resolutionSelect.value = (preferred || sameTier || fallback || presets[0]).value;
  };

  const updateSeconds = () => {
    if (secondsRange && secondsValue) {
      secondsValue.textContent = `${secondsRange.value} сек`;
    }
  };

  const collectGeneratorSettings = () => {
    const checkedProfile = qs('[name="profile"]:checked', generationForm);
    return {
      prompt: qs("#prompt")?.value || "",
      resolution: qs("#resolution")?.value || DEFAULT_RESOLUTION,
      resolution_shape:
        qs('[name="resolution_shape"]:checked', generationForm)?.value ||
        DEFAULT_RESOLUTION_SHAPE,
      seconds: secondsRange?.value || "5",
      fps: qs('[name="fps"]', generationForm)?.value || "24",
      profile: checkedProfile?.value || "steps8",
      seed: qs('[name="seed"]', generationForm)?.value || "-1",
      generate_audio: Boolean(qs("#generate-audio")?.checked),
      generation_mode:
        qs('[name="generation_mode"]:checked', generationForm)?.value || "frames",
      reference_task: qs("#reference-task")?.value || "reference_generation",
      ref_image_size: qs("#ref-image-size")?.value || "match",
    };
  };

  const saveGeneratorSettings = () => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(collectGeneratorSettings())
      );
    } catch {
      // Storage may be disabled by the browser. The app can still work.
    }
  };

  const restoreGeneratorSettings = () => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    } catch {
      saved = null;
    }

    const savedResolution =
      saved && typeof saved === "object" ? String(saved.resolution || "") : "";
    const savedShape =
      saved && typeof saved === "object" && RESOLUTION_PRESETS[saved.resolution_shape]
        ? saved.resolution_shape
        : inferResolutionShape(savedResolution);
    const shape = RESOLUTION_PRESETS[savedShape]
      ? savedShape
      : DEFAULT_RESOLUTION_SHAPE;
    const shapeInput = qs("#resolution-shape", generationForm);
    if (shapeInput) shapeInput.value = shape;
    renderResolutionOptions(
      shape,
      savedResolution,
      inferResolutionTier(savedResolution)
    );

    if (!saved || typeof saved !== "object") {
      updateSeconds();
      return;
    }

    if (typeof saved.prompt === "string") {
      qs("#prompt").value = saved.prompt;
    }

    if (secondsRange) {
      const seconds = Math.max(1, Math.min(30, Number(saved.seconds || 5)));
      secondsRange.value = String(seconds);
    }

    const fps = qs('[name="fps"]', generationForm);
    if (
      fps &&
      [...fps.options].some((option) => option.value === String(saved.fps))
    ) {
      fps.value = String(saved.fps);
    }

    const normalizedProfile =
      LEGACY_PROFILE_MAP[String(saved.profile || "")] ||
      String(saved.profile || "steps8");
    const profile = qs(
      `[name="profile"][value="${CSS.escape(normalizedProfile)}"]`,
      generationForm
    );
    if (profile) {
      profile.checked = true;
    }

    const seed = qs('[name="seed"]', generationForm);
    if (seed && saved.seed !== undefined && saved.seed !== null) {
      seed.value = String(saved.seed);
    }

    const audio = qs("#generate-audio");
    if (audio) {
      audio.checked = Boolean(saved.generate_audio);
    }

    const savedMode = ["frames", "reference", "digital_human"].includes(saved.generation_mode)
      ? saved.generation_mode
      : "frames";
    const modeInput = qs(
      `[name="generation_mode"][value="${CSS.escape(savedMode)}"]`,
      generationForm
    );
    if (modeInput) modeInput.checked = true;

    const referenceTask = qs("#reference-task");
    if (
      referenceTask &&
      [...referenceTask.options].some((option) => option.value === String(saved.reference_task))
    ) {
      referenceTask.value = String(saved.reference_task);
    }
    const refSize = qs("#ref-image-size");
    if (
      refSize &&
      [...refSize.options].some((option) => option.value === String(saved.ref_image_size))
    ) {
      refSize.value = String(saved.ref_image_size);
    }

    updateSeconds();
  };

  const clearAppStorageAndReset = () => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }

    generationForm.reset();
    renderResolutionOptions(DEFAULT_RESOLUTION_SHAPE, DEFAULT_RESOLUTION);
    qsa(".upload-card input[type=file]").forEach((input) => {
      clearUploadPreview(input);
    });

    mediaPage = 1;
    jobsPage = 1;
    updateSeconds();
    switchView("generate", false, false);
    showToast("Промт и настройки сброшены по умолчанию.");
  };

  qs("#resolution-shape", generationForm)?.addEventListener("change", (event) => {
    const tier = resolutionSelect?.selectedOptions?.[0]?.dataset?.tier || "";
    renderResolutionOptions(event.target.value, "", tier);
    saveGeneratorSettings();
  });

  restoreGeneratorSettings();

  const referenceInputs = {
    images: qs("#reference-images"),
    videos: qs("#reference-videos"),
    audios: qs("#reference-audios"),
  };

  const roleOptions = {
    images: [
      ["character", "Персонаж / внешность"],
      ["object", "Предмет"],
      ["setting", "Локация / окружение"],
      ["style", "Стиль"],
      ["composition", "Композиция"],
      ["storyboard", "Storyboard / keyframe"],
    ],
    videos: [
      ["motion", "Движение / действие"],
      ["camera_motion", "Движение камеры"],
      ["character", "Персонаж / поведение"],
      ["setting", "Локация / окружение"],
      ["style", "Стиль"],
      ["composition", "Композиция"],
    ],
    audios: [
      ["voice", "Голос / тембр"],
      ["audio", "Звук / ритм"],
    ],
  };
  const retentionOptions = {
    images: [
      ["fully_preserved", "Полностью сохранить"],
      ["partially_preserved", "Частично сохранить"],
      ["attribute_transfer", "Перенести атрибут"],
      ["weak_reference", "Слабый ориентир"],
    ],
    videos: [
      ["fully_preserved", "Полностью сохранить"],
      ["partially_preserved", "Частично сохранить"],
      ["attribute_transfer", "Перенести атрибут"],
      ["weak_reference", "Слабый ориентир"],
    ],
    audios: [
      ["fully_copy", "Полностью копировать"],
      ["partially_copy", "Частично копировать"],
      ["reference", "Референс"],
      ["weak_reference", "Слабый ориентир"],
    ],
  };

  const currentGenerationMode = () =>
    qs('[name="generation_mode"]:checked', generationForm)?.value || "frames";

  const referenceFiles = (kind) => [...(referenceInputs[kind]?.files || [])];

  const renderReferenceList = (kind) => {
    const container = qs(`#reference-${kind}-list`);
    if (!container) return;
    const files = referenceFiles(kind);
    if (!files.length) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = files
      .map((file, index) => {
        const roleChoices = roleOptions[kind]
          .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
          .join("");
        const retentionChoices = retentionOptions[kind]
          .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
          .join("");
        const typeLabel = kind === "images" ? "Picture" : kind === "videos" ? "Video" : "Audio";
        return `
          <div class="reference-file-row" data-ref-kind="${kind}" data-ref-index="${index}">
            <div class="reference-file-name">
              <strong>${typeLabel} · ${index + 1}</strong>
              <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            </div>
            <select class="ref-role" aria-label="Роль референса">${roleChoices}</select>
            <select class="ref-retention" aria-label="Сила сохранения">${retentionChoices}</select>
            <input class="ref-note" maxlength="240" placeholder="Короткое уточнение роли · необязательно">
          </div>`;
      })
      .join("");
  };

  const syncCharacterSelection = () => {
    qsa("#generator-character-list input[type=checkbox]").forEach((input) => {
      if (input.checked) selectedCharacterIds.add(input.value);
      else selectedCharacterIds.delete(input.value);
    });
    const hidden = qs("#character-ids");
    if (hidden) hidden.value = JSON.stringify([...selectedCharacterIds]);
  };

  const getReferenceBudget = () => {
    const selected = characters.filter((item) => selectedCharacterIds.has(item.id));
    const characterImages = selected.reduce((sum, item) => sum + Number(item.image_count || 0), 0);
    const characterVoices = selected.reduce((sum, item) => sum + (item.voice ? 1 : 0), 0);
    const images = characterImages + referenceFiles("images").length;
    const videos = referenceFiles("videos").length;
    const audios = characterVoices + referenceFiles("audios").length;
    return { images, videos, audios, total: images + videos + audios };
  };

  const updateReferenceBudget = () => {
    syncCharacterSelection();
    const budget = getReferenceBudget();
    const element = qs("#reference-budget");
    if (!element) return budget;
    element.textContent =
      `${budget.total} / 15 media · ${budget.images} / 9 images · ${budget.videos} / 3 videos · ${budget.audios} / 3 audio`;
    const mode = currentGenerationMode();
    const invalid =
      budget.total > 15 ||
      budget.images > 9 ||
      budget.videos > 3 ||
      budget.audios > 3 ||
      (mode === "digital_human" && budget.audios !== 1);
    element.classList.toggle("is-error", invalid);
    return budget;
  };

  const buildReferenceManifest = () => {
    const manifest = { images: [], videos: [], audios: [] };
    qsa(".reference-file-row").forEach((row) => {
      const kind = row.dataset.refKind;
      if (!manifest[kind]) return;
      manifest[kind][Number(row.dataset.refIndex)] = {
        role: qs(".ref-role", row)?.value || "",
        retention: qs(".ref-retention", row)?.value || "",
        note: qs(".ref-note", row)?.value || "",
      };
    });
    const hidden = qs("#reference-manifest");
    if (hidden) hidden.value = JSON.stringify(manifest);
    return manifest;
  };

  const updateGenerationModeUI = () => {
    const mode = currentGenerationMode();
    const frames = qs("#frames-mode-panel");
    const references = qs("#reference-mode-panel");
    if (frames) frames.hidden = mode !== "frames";
    if (references) references.hidden = mode === "frames";
    const kicker = qs("#generator-mode-kicker");
    if (kicker) {
      kicker.textContent =
        mode === "frames"
          ? "MiniMax H3 FL2VA"
          : mode === "digital_human"
            ? "MiniMax H3 DIGITAL HUMAN"
            : "MiniMax H3 REF2VA";
    }
    const audioInput = referenceInputs.audios;
    if (audioInput) audioInput.multiple = mode !== "digital_human";
    const audioTitle = qs("#reference-audio-title");
    const audioHelp = qs("#reference-audio-help");
    if (audioTitle) audioTitle.textContent = mode === "digital_human" ? "Driving audio" : "Аудио / голос";
    if (audioHelp) {
      audioHelp.textContent =
        mode === "digital_human"
          ? "ровно 1 driving audio вместе с Character voice"
          : "до 3 standalone audio";
    }
    const taskField = qs("#reference-task-field");
    if (taskField) taskField.hidden = mode === "digital_human";
    const note = qs("#reference-mode-note");
    if (note) {
      note.textContent =
        mode === "digital_human"
          ? "Digital Human: минимум один визуальный reference и ровно один Audio reference. Это driving track, а не обычная подсказка тембра."
          : "Ref2VA: Pictures/Videos/Audio — референсы. Storyboard images задают ориентиры, но не являются точными latent-keyframes на произвольной секунде.";
    }
    updateReferenceBudget();
  };

  Object.entries(referenceInputs).forEach(([kind, input]) => {
    input?.addEventListener("change", () => {
      renderReferenceList(kind);
      buildReferenceManifest();
      updateReferenceBudget();
    });
  });
  qs("#reference-mode-panel")?.addEventListener("input", () => {
    buildReferenceManifest();
    updateReferenceBudget();
  });
  qsa('[name="generation_mode"]', generationForm).forEach((input) => {
    input.addEventListener("change", () => {
      updateGenerationModeUI();
      saveGeneratorSettings();
    });
  });
  updateGenerationModeUI();

  generationForm.addEventListener("input", (event) => {
    if (event.target.matches('input[type="file"]')) return;
    updateSeconds();
    saveGeneratorSettings();
  });

  generationForm.addEventListener("change", (event) => {
    if (event.target.matches('input[type="file"]')) return;
    updateSeconds();
    saveGeneratorSettings();
  });

  qs("#reset-settings").addEventListener("click", clearAppStorageAndReset);

  const renderSystem = (state) => {
    const gpu = state.system?.gpu;
    const secondaryGpu = state.system?.secondary_gpu;
    const comfy = state.system?.comfyui;
    const comfySecondary = state.system?.comfyui_secondary;
    const running = Number(state.counts?.running || 0);
    const queued = Number(state.counts?.queued || 0);
    const globalRunning = Number(state.global_counts?.running || 0);
    const globalQueued = Number(state.global_counts?.queued || 0);

    const comfyPill = qs("#comfy-status");
    const comfyDot = qs(".status-dot", comfyPill);
    comfyDot.className = `status-dot ${comfy ? "ok" : "error"}`;
    comfyPill.title = comfy ? "ComfyUI доступен" : "ComfyUI недоступен";

    const comfySecondaryPill = qs("#comfy-secondary-status");
    if (comfySecondaryPill) {
      const comfySecondaryDot = qs(".status-dot", comfySecondaryPill);
      comfySecondaryDot.className = `status-dot ${comfySecondary ? "ok" : "error"}`;
      comfySecondaryPill.title = comfySecondary
        ? "H3 secondary доступен на RTX 2080 Ti"
        : "H3 secondary недоступен";
    }

    const active = qs("#active-status");
    active.innerHTML = globalRunning
      ? `${icon("bolt")}<span>GPU занят</span>`
      : `${icon("check")}<span>GPU свободен</span>`;

    qs("#sidebar-queue-count").textContent = String(running + queued);
    qs("#mobile-queue-count").textContent = String(running + queued);
    qs("#sidebar-media-count").textContent = String(state.counts?.media || 0);
    qs("#metric-queue").textContent = String(globalRunning + globalQueued);

    const miniDot = qs("#gpu-status-dot");
    if (gpu) {
      const gpuBusy = Number(gpu.utilization || 0) > 5;
      miniDot.className = `status-dot ${comfy ? (gpuBusy ? "busy" : "ok") : "error"}`;
      qs("#gpu-mini-name").textContent = (gpu.name || "RTX 3090").replace(
        "NVIDIA GeForce ",
        ""
      );
      qs("#gpu-mini-value").textContent =
        `${gpu.memory_used_mb} / ${gpu.memory_total_mb} MB`;
      qs("#metric-gpu").textContent = (gpu.name || "RTX 3090").replace(
        "NVIDIA GeForce ",
        ""
      );
      qs("#metric-vram").textContent =
        `${(gpu.memory_used_mb / 1024).toFixed(1)} / ${(
          gpu.memory_total_mb / 1024
        ).toFixed(0)} GB VRAM`;
      qs("#metric-util").textContent = `${gpu.utilization}%`;
      qs("#metric-temp").textContent = `${gpu.temperature} °C`;
    } else {
      miniDot.className = "status-dot error";
      qs("#gpu-mini-value").textContent = "nvidia-smi недоступен";
      qs("#metric-gpu").textContent = "Нет данных";
      qs("#metric-vram").textContent = "—";
      qs("#metric-util").textContent = "—";
      qs("#metric-temp").textContent = "—";
    }

    const secondaryMiniDot = qs("#gpu-secondary-status-dot");
    if (secondaryGpu) {
      const secondaryBusy = Number(secondaryGpu.utilization || 0) > 5;
      secondaryMiniDot.className =
        `status-dot ${comfySecondary ? (secondaryBusy ? "busy" : "ok") : "error"}`;
      qs("#gpu-secondary-mini-name").textContent = (
        secondaryGpu.name || "RTX 2080 Ti"
      ).replace("NVIDIA GeForce ", "");
      qs("#gpu-secondary-mini-value").textContent =
        `${secondaryGpu.memory_used_mb} / ${secondaryGpu.memory_total_mb} MB`;
      qs("#metric-secondary-gpu").textContent = (
        secondaryGpu.name || "RTX 2080 Ti"
      ).replace("NVIDIA GeForce ", "");
      qs("#metric-secondary-vram").textContent =
        `${(secondaryGpu.memory_used_mb / 1024).toFixed(1)} / ${(
          secondaryGpu.memory_total_mb / 1024
        ).toFixed(0)} GB VRAM`;
      qs("#metric-secondary-util").textContent = `${secondaryGpu.utilization}%`;
      qs("#metric-secondary-temp").textContent = `${secondaryGpu.temperature} °C`;
    } else {
      secondaryMiniDot.className = "status-dot error";
      qs("#gpu-secondary-mini-value").textContent = "nvidia-smi недоступен";
      qs("#metric-secondary-gpu").textContent = "Нет данных";
      qs("#metric-secondary-vram").textContent = "—";
      qs("#metric-secondary-util").textContent = "—";
      qs("#metric-secondary-temp").textContent = "—";
    }

    qs("#metric-disk").textContent = humanBytes(state.system?.disk_free || 0);
  };

  const kindLabel = (kind) =>
    ({
      generated: "H3",
      audio: "Audio",
      silent: "Silent",
      edited: "Монтаж",
    }[kind] || kind);

  const gpuBadge = (gpuBackend) => {
    if (!gpuBackend) return "";
    const label = String(gpuBackend);
    const badgeClass = label.includes("3090") ? "badge-green" : "badge-yellow";
    return `<span class="badge ${badgeClass}" title="GPU генерации">${escapeHtml(label)}</span>`;
  };

  const mediaSignature = (media) =>
    (media || [])
      .map((item) => `${item.id}:${item.size_bytes}:${item.created_at}`)
      .join("|");

  const libraryHasPlayingVideo = () =>
    qsa("#media-grid video").some((video) => !video.paused && !video.ended);

  const renderMedia = (media) => {
    const grid = qs("#media-grid");
    const empty = qs("#media-empty");
    empty.classList.toggle("show", !media.length);

    grid.innerHTML = media
      .map((item) => {
        const meta = item.meta || {};
        const details = [];
        if (meta.width && meta.height) {
          details.push(`${meta.width}×${meta.height}`);
        }
        if (meta.profile) {
          const profile = PROFILE_LABELS[meta.profile] || meta.profile;
          details.push(profile);
        }
        if (meta.fps) details.push(`${meta.fps} FPS`);
        if (meta.generate_audio) details.push("H3 Audio");
        if (meta.seed !== undefined && meta.seed !== null) {
          details.push(`seed ${meta.seed}`);
        }
        details.push(humanDuration(item.duration));
        details.push(humanBytes(item.size_bytes));

        return `
          <article class="media-card" data-media-id="${escapeHtml(item.id)}">
            <div class="media-preview">
              <video
                src="/media/${encodeURIComponent(item.id)}"
                controls
                playsinline
                preload="metadata"></video>
            </div>
            <div class="media-body">
              <div style="display:flex;align-items:center;gap:8px;min-width:0">
                <span class="badge badge-blue">${escapeHtml(
                  kindLabel(item.kind)
                )}</span>
                ${gpuBadge(meta.gpu_backend)}
                <h3 class="media-title" title="${escapeHtml(
                  item.title
                )}">${escapeHtml(item.title)}</h3>
              </div>
              <div class="media-meta">
                <span>${escapeHtml(shortDate(item.created_at))}</span>
                ${details
                  .filter(Boolean)
                  .map((detail) => `<span>· ${escapeHtml(detail)}</span>`)
                  .join("")}
              </div>
              <div class="media-actions">
                <button type="button" data-action="info" title="Промт и параметры">
                  ${icon("info")}
                </button>
                <button type="button" data-action="audio" title="Наложить аудио">
                  ${icon("music")}
                </button>
                <button type="button" data-action="remove-audio" title="Убрать звук">
                  ${icon("volume-off")}
                </button>
                <a href="/media/${encodeURIComponent(
                  item.id
                )}?download=1" title="Скачать">
                  ${icon("download")}
                </a>
                <button class="danger" type="button" data-action="delete" title="Удалить">
                  ${icon("trash")}
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  };

  const editorMediaById = (mediaId) =>
    editorMedia.find((item) => item.id === mediaId) || null;

  const editorClock = (seconds) => {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const editorTotalDuration = () =>
    editorClips.reduce((total, clip) => {
      const media = editorMediaById(clip.mediaId);
      return total + Math.max(0, Number(media?.duration || 0));
    }, 0);

  const renderEditorMedia = () => {
    const pool = qs("#editor-media-pool");
    const empty = qs("#editor-media-empty");
    if (!pool || !empty) return;
    empty.classList.toggle("show", !editorMedia.length);
    pool.innerHTML = editorMedia
      .map((item) => `
        <article class="editor-pool-card" draggable="true" data-editor-media-id="${escapeHtml(item.id)}">
          <div class="editor-pool-preview">
            <video src="/media/${encodeURIComponent(item.id)}" muted playsinline preload="metadata"></video>
          </div>
          <div class="editor-pool-body">
            <div>
              <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(kindLabel(item.kind))} · ${escapeHtml(humanDuration(item.duration))}</small>
            </div>
            <button class="btn btn-secondary btn-compact" type="button" data-editor-add="${escapeHtml(item.id)}">
              ${icon("player-play")} На таймлайн
            </button>
          </div>
        </article>
      `)
      .join("");
  };

  const renderEditorTimeline = () => {
    const track = qs("#editor-video-track");
    if (!track) return;
    const total = editorTotalDuration();
    const empty = qs("#editor-video-empty");
    const clipWord =
      editorClips.length % 10 === 1 && editorClips.length % 100 !== 11
        ? "клип"
        : [2, 3, 4].includes(editorClips.length % 10) &&
            ![12, 13, 14].includes(editorClips.length % 100)
          ? "клипа"
          : "клипов";
    qs("#editor-clip-count").textContent = `${editorClips.length} ${clipWord}`;
    qs("#editor-total-duration").textContent = editorClock(total);
    qs("#editor-export").disabled = editorClips.length === 0;

    const first = editorClips.length ? editorMediaById(editorClips[0].mediaId) : null;
    const firstMeta = first?.meta || {};
    qs("#editor-output-summary").textContent = first
      ? `${firstMeta.width && firstMeta.height ? `${firstMeta.width} × ${firstMeta.height} · ` : ""}${editorClips.length} клипов · ${editorClock(total)}`
      : "Добавьте видео на таймлайн";

    qsa(".editor-clip", track).forEach((node) => node.remove());
    empty.classList.toggle("show", editorClips.length === 0);

    editorClips.forEach((clip, index) => {
      const media = editorMediaById(clip.mediaId);
      if (!media) return;
      const duration = Math.max(0.1, Number(media.duration || 0.1));
      const card = document.createElement("article");
      card.className = "editor-clip";
      card.draggable = true;
      card.dataset.editorClipIndex = String(index);
      card.style.setProperty("--clip-grow", String(Math.max(1, duration)));
      card.innerHTML = `
        <div class="editor-clip-top">
          <span class="editor-clip-index">${index + 1}</span>
          <div>
            <strong title="${escapeHtml(media.title)}">${escapeHtml(media.title)}</strong>
            <small>${escapeHtml(humanDuration(media.duration))}</small>
          </div>
          <button type="button" class="editor-clip-remove" data-editor-remove="${index}" title="Убрать с таймлайна">
            ${icon("x")}
          </button>
        </div>
        <label class="editor-clip-volume">
          <span>Звук <b>${Math.round(clip.volume * 100)}%</b></span>
          <input type="range" min="0" max="200" step="1" value="${Math.round(clip.volume * 100)}" data-editor-volume="${index}">
        </label>
      `;
      track.appendChild(card);
    });

    renderEditorAudioTrack();
  };

  const renderEditorAudioTrack = () => {
    const total = editorTotalDuration();
    const block = qs("#editor-audio-block");
    const empty = qs("#editor-audio-empty");
    const controls = qs("#editor-audio-controls");
    const hasAudio = Boolean(editorAudio.file);
    if (!block || !empty || !controls) return;

    block.hidden = !hasAudio;
    empty.classList.toggle("show", !hasAudio);
    controls.hidden = !hasAudio;
    if (!hasAudio) return;

    const available = Math.max(0, editorAudio.duration - editorAudio.trimStart);
    const requested = editorAudio.trimDuration > 0 ? editorAudio.trimDuration : available;
    const audibleDuration = Math.max(0, Math.min(available, requested));
    qs("#editor-audio-name").textContent = editorAudio.file.name;
    qs("#editor-audio-block-meta").textContent = `${editorClock(audibleDuration)} · +${editorAudio.offset.toFixed(1)} сек`;
    qs("#editor-audio-volume-value").textContent = `${Math.round(editorAudio.volume * 100)}%`;

    const base = Math.max(total, 1);
    const left = Math.max(0, Math.min(100, (editorAudio.offset / base) * 100));
    const width = Math.max(
      3,
      Math.min(100 - left, (audibleDuration / base) * 100)
    );
    block.style.left = `${left}%`;
    block.style.width = `${width}%`;
  };

  const addEditorClip = (mediaId, atIndex = null) => {
    if (!editorMediaById(mediaId)) return;
    const clip = { mediaId, volume: 1 };
    if (Number.isInteger(atIndex) && atIndex >= 0 && atIndex <= editorClips.length) {
      editorClips.splice(atIndex, 0, clip);
    } else {
      editorClips.push(clip);
    }
    renderEditorTimeline();
  };

  const clearEditorAudio = () => {
    if (editorAudio.objectUrl) {
      URL.revokeObjectURL(editorAudio.objectUrl);
    }
    editorAudio = {
      file: null,
      objectUrl: "",
      duration: 0,
      offset: 0,
      trimStart: 0,
      trimDuration: 0,
      volume: 1,
    };
    const input = qs("#editor-audio-input");
    if (input) input.value = "";
    renderEditorAudioTrack();
  };

  const loadEditorAudio = (file) => {
    clearEditorAudio();
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    editorAudio.file = file;
    editorAudio.objectUrl = objectUrl;
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = objectUrl;
    audio.addEventListener("loadedmetadata", () => {
      editorAudio.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      editorAudio.trimDuration = editorAudio.duration;
      qs("#editor-audio-offset").value = "0";
      qs("#editor-audio-trim-start").value = "0";
      qs("#editor-audio-trim-duration").value = editorAudio.duration
        ? editorAudio.duration.toFixed(1)
        : "0";
      qs("#editor-audio-volume").value = "100";
      renderEditorAudioTrack();
    }, { once: true });
    audio.addEventListener("error", () => {
      showToast("Не удалось прочитать длительность аудиофайла.", "error");
      renderEditorAudioTrack();
    }, { once: true });
    renderEditorAudioTrack();
  };

  refreshEditorMedia = async () => {
    if (!qs("#editor-media-pool")) return;
    try {
      const result = await api("/api/editor/media");
      editorMedia = result.items || [];
      editorClips = editorClips.filter((clip) => editorMediaById(clip.mediaId));
      renderEditorMedia();
      renderEditorTimeline();
    } catch (error) {
      showToast(error.message, "error");
    }
  };

  const startEditorDownload = (mediaId) => {
    const link = document.createElement("a");
    link.href = `/media/${encodeURIComponent(mediaId)}?download=1`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handlePendingEditorExport = (state) => {
    const pendingId = localStorage.getItem(EDITOR_EXPORT_JOB_KEY);
    if (!pendingId) return;
    const job = (state.jobs || []).find((item) => item.id === pendingId);
    if (!job) return;
    if (job.status === "done" && job.result_media_id) {
      localStorage.removeItem(EDITOR_EXPORT_JOB_KEY);
      startEditorDownload(job.result_media_id);
      showToast("Монтаж готов. Скачивание началось.");
      return;
    }
    if (job.status === "failed" || job.status === "canceled") {
      localStorage.removeItem(EDITOR_EXPORT_JOB_KEY);
      showToast(
        job.status === "failed"
          ? "Экспорт монтажа завершился с ошибкой."
          : "Экспорт монтажа отменён.",
        "error"
      );
    }
  };

  const jobLabel = (kind) =>
    ({
      generate: "MiniMax H3",
      audio_replace: "Наложение аудио",
      audio_remove: "Удаление звука",
      editor_export: "Монтаж / экспорт",
    }[kind] || kind);

  const statusBadge = (status) => {
    const labels = {
      queued: ["В очереди", "gray"],
      running: ["В работе", "yellow"],
      done: ["Готово", "green"],
      failed: ["Ошибка", "red"],
      canceled: ["Отменено", "gray"],
    };
    const [label, color] = labels[status] || [status, "gray"];
    return `<span class="badge badge-${color}">${escapeHtml(label)}</span>`;
  };

  const jobActions = (job) => {
    if (job.status === "queued" || job.status === "running") {
      return `
        <button class="btn btn-danger btn-compact" type="button" data-job-action="cancel" data-job-id="${escapeHtml(
          job.id
        )}">
          ${icon("x")} Отменить
        </button>
      `;
    }

    const actions = [];
    const retryableKinds = new Set([
      "generate",
      "audio_replace",
      "audio_remove",
      "editor_export",
    ]);
    if (job.status === "failed" && retryableKinds.has(job.kind)) {
      actions.push(`
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="retry" data-job-id="${escapeHtml(
          job.id
        )}">
          ${icon("refresh")} Повторить
        </button>
      `);
    }

    if (job.status === "done" && job.result_media_id) {
      actions.push(`
        <button class="btn btn-secondary btn-compact" type="button" data-job-action="library" data-media-id="${escapeHtml(
          job.result_media_id
        )}">
          ${icon("library")} Открыть библиотеку
        </button>
      `);
    }

    actions.push(`
      <button class="btn btn-danger btn-compact" type="button" data-job-action="delete" data-job-id="${escapeHtml(
        job.id
      )}">
        ${icon("trash")} Удалить
      </button>
    `);

    return actions.join("");
  };

  const renderJobs = (jobs) => {
    const list = qs("#job-list");
    const empty = qs("#job-empty");
    empty.classList.toggle("show", !jobs.length);

    list.innerHTML = jobs
      .map((job) => {
        const payload = job.payload || {};
        const prompt = job.kind === "generate" ? payload.prompt || "" : "";
        const progress = Math.max(
          0,
          Math.min(100, Number(job.progress || 0))
        );
        const elapsed = jobElapsed(job);
        const progressText =
          job.status === "running"
            ? `≈ ${Math.round(progress)}%`
            : `${Math.round(progress)}%`;

        return `
          <article class="job-card" data-job-id="${escapeHtml(job.id)}">
            <div class="job-top">
              <div class="job-name">
                <span class="metric-icon job-icon">
                  ${icon(job.kind === "generate" ? "wand" : "settings")}
                </span>
                <div>
                  <strong>${escapeHtml(jobLabel(job.kind))}</strong>
                  <small>${escapeHtml(job.stage || "В очереди")}</small>
                </div>
              </div>
              ${statusBadge(job.status)}
            </div>

            ${prompt ? `<div class="job-prompt">${escapeHtml(prompt)}</div>` : ""}

            <div class="job-stats">
              <span><b>Создано:</b> ${escapeHtml(shortDate(job.created_at))}</span>
              <span><b>Начало:</b> ${
                job.started_at ? escapeHtml(shortDate(job.started_at)) : "—"
              }</span>
              <span><b>Ожидание:</b> <span
                data-job-created="${escapeHtml(job.created_at || "")}"
                data-job-started="${escapeHtml(job.started_at || "")}"
                data-job-status="${escapeHtml(job.status || "")}"
              >${jobWait(job) === null ? "—" : formatHms(jobWait(job))}</span></span>
              <span><b>Генерация:</b> <span
                data-job-start="${escapeHtml(job.started_at || "")}"
                data-job-finished="${escapeHtml(job.finished_at || "")}"
              >${elapsed === null ? "—" : formatHms(elapsed)}</span></span>
              <span><b>Прогресс:</b> ${progressText}</span>
            </div>

            <div class="job-progress" style="--progress:${progress}%">
              <span></span>
            </div>

            ${job.error ? `<pre class="job-error">${escapeHtml(job.error)}</pre>` : ""}
            <div class="job-actions">${jobActions(job)}</div>
          </article>
        `;
      })
      .join("");
  };

  const renderPagination = (containerId, pagination, target) => {
    const container = qs(containerId);
    if (!pagination || pagination.total <= pagination.page_size) {
      container.innerHTML = pagination?.total
        ? `<span class="pagination-info">${pagination.total} записей · по ${pagination.page_size} на странице</span>`
        : "";
      return;
    }

    const page = Number(pagination.page || 1);
    const pages = Number(pagination.pages || 1);
    container.innerHTML = `
      <button type="button" data-page-target="${target}" data-page="${
        page - 1
      }" ${page <= 1 ? "disabled" : ""}>←</button>
      <span class="pagination-info">Страница <strong>${page}</strong> из ${pages} · ${pagination.total} записей</span>
      <button type="button" data-page-target="${target}" data-page="${
        page + 1
      }" ${page >= pages ? "disabled" : ""}>→</button>
    `;
  };

  const refreshState = async (quiet = true, forceMedia = false) => {
    try {
      const state = await api(
        `/api/state?media_page=${mediaPage}&jobs_page=${jobsPage}`
      );
      lastState = state;
      if (Number.isFinite(Number(state.server_now))) {
        serverClockAtFetchMs = Number(state.server_now) * 1000;
        serverClockPerfAtFetch = performance.now();
      }

      mediaPage = Number(state.media_pagination?.page || mediaPage);
      jobsPage = Number(state.jobs_pagination?.page || jobsPage);

      renderSystem(state);
      renderJobs(state.jobs || []);
      handlePendingEditorExport(state);
      renderPagination("#job-pagination", state.jobs_pagination, "jobs");
      renderPagination("#media-pagination", state.media_pagination, "media");

      const signature = mediaSignature(state.media || []);
      const safeToRenderMedia = forceMedia || !libraryHasPlayingVideo();
      if (
        safeToRenderMedia &&
        (forceMedia || signature !== lastMediaSignature)
      ) {
        renderMedia(state.media || []);
        lastMediaSignature = signature;
      }
    } catch (error) {
      if (!quiet) showToast(error.message, "error");
    } finally {
      scheduleRefresh();
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(
      () => refreshState(true, false),
      document.hidden ? 15000 : 3000
    );
  };

  document.addEventListener("visibilitychange", () => {
    clearTimeout(stateTimer);
    refreshState(true, false);
  });

  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page-target]");
    if (!pageButton || pageButton.disabled) return;

    const page = Math.max(1, Number(pageButton.dataset.page || 1));
    if (pageButton.dataset.pageTarget === "media") {
      mediaPage = page;
      lastMediaSignature = "";
      refreshState(true, true);
    } else {
      jobsPage = page;
      refreshState(true, false);
    }
  });

  const editorPool = qs("#editor-media-pool");
  const editorVideoTrack = qs("#editor-video-track");

  if (editorPool) {
    editorPool.addEventListener("click", (event) => {
      const button = event.target.closest("[data-editor-add]");
      if (!button) return;
      addEditorClip(button.dataset.editorAdd);
    });

    editorPool.addEventListener("dragstart", (event) => {
      const card = event.target.closest("[data-editor-media-id]");
      if (!card || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-aivideosite-media", card.dataset.editorMediaId);
      event.dataTransfer.setData("text/plain", card.dataset.editorMediaId);
    });
  }

  if (editorVideoTrack) {
    editorVideoTrack.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          editorDraggedClipIndex === null ? "copy" : "move";
      }
      editorVideoTrack.classList.add("drag-over");
    });
    editorVideoTrack.addEventListener("dragleave", (event) => {
      if (!editorVideoTrack.contains(event.relatedTarget)) {
        editorVideoTrack.classList.remove("drag-over");
      }
    });
    editorVideoTrack.addEventListener("drop", (event) => {
      event.preventDefault();
      editorVideoTrack.classList.remove("drag-over");
      const targetClip = event.target.closest("[data-editor-clip-index]");
      let targetIndex = targetClip
        ? Number(targetClip.dataset.editorClipIndex)
        : editorClips.length;

      if (editorDraggedClipIndex !== null) {
        const from = editorDraggedClipIndex;
        editorDraggedClipIndex = null;
        if (from < 0 || from >= editorClips.length) return;
        const [clip] = editorClips.splice(from, 1);
        if (from < targetIndex) targetIndex -= 1;
        targetIndex = Math.max(0, Math.min(editorClips.length, targetIndex));
        editorClips.splice(targetIndex, 0, clip);
        renderEditorTimeline();
        return;
      }

      const mediaId =
        event.dataTransfer?.getData("application/x-aivideosite-media") ||
        event.dataTransfer?.getData("text/plain");
      if (mediaId) addEditorClip(mediaId, targetIndex);
    });

    editorVideoTrack.addEventListener("dragstart", (event) => {
      const clip = event.target.closest("[data-editor-clip-index]");
      if (!clip || !event.dataTransfer) return;
      editorDraggedClipIndex = Number(clip.dataset.editorClipIndex);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", `clip:${editorDraggedClipIndex}`);
      clip.classList.add("dragging");
    });
    editorVideoTrack.addEventListener("dragend", (event) => {
      editorDraggedClipIndex = null;
      editorVideoTrack.classList.remove("drag-over");
      event.target.closest("[data-editor-clip-index]")?.classList.remove("dragging");
    });

    editorVideoTrack.addEventListener("click", (event) => {
      const button = event.target.closest("[data-editor-remove]");
      if (!button) return;
      const index = Number(button.dataset.editorRemove);
      if (!Number.isInteger(index) || !editorClips[index]) return;
      editorClips.splice(index, 1);
      renderEditorTimeline();
    });

    editorVideoTrack.addEventListener("input", (event) => {
      const input = event.target.closest("[data-editor-volume]");
      if (!input) return;
      const index = Number(input.dataset.editorVolume);
      if (!editorClips[index]) return;
      editorClips[index].volume = Math.max(
        0,
        Math.min(2, Number(input.value) / 100)
      );
      const label = input.closest(".editor-clip-volume")?.querySelector("b");
      if (label) {
        label.textContent = `${Math.round(editorClips[index].volume * 100)}%`;
      }
    });
  }

  qs("#editor-refresh-media")?.addEventListener("click", refreshEditorMedia);
  qs("#editor-audio-input")?.addEventListener("change", (event) => {
    loadEditorAudio(event.target.files?.[0] || null);
  });
  qs("#editor-remove-audio")?.addEventListener("click", clearEditorAudio);

  const editorAudioBlock = qs("#editor-audio-block");
  const editorAudioTrack = qs("#editor-audio-track");
  if (editorAudioBlock && editorAudioTrack) {
    editorAudioBlock.addEventListener("pointerdown", (event) => {
      if (!editorAudio.file) return;
      const total = editorTotalDuration();
      if (total <= 0) return;

      event.preventDefault();
      const resize = Boolean(event.target.closest(".editor-audio-resize"));
      const startX = event.clientX;
      const startOffset = editorAudio.offset;
      const startDuration = editorAudio.trimDuration;
      const rect = editorAudioTrack.getBoundingClientRect();
      const pixelsPerSecond = rect.width / total;
      if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return;

      editorAudioBlock.setPointerCapture(event.pointerId);
      editorAudioBlock.classList.add(resize ? "resizing" : "dragging");

      const onMove = (moveEvent) => {
        const deltaSeconds = (moveEvent.clientX - startX) / pixelsPerSecond;
        if (resize) {
          const available = Math.max(
            0,
            editorAudio.duration - editorAudio.trimStart
          );
          const maxByTimeline = Math.max(0, total - editorAudio.offset);
          const maxDuration = Math.min(available, maxByTimeline);
          editorAudio.trimDuration = Math.max(
            0.1,
            Math.min(maxDuration, startDuration + deltaSeconds)
          );
          qs("#editor-audio-trim-duration").value =
            editorAudio.trimDuration.toFixed(1);
        } else {
          const available = Math.max(
            0,
            editorAudio.duration - editorAudio.trimStart
          );
          const usedDuration = Math.min(
            available,
            editorAudio.trimDuration > 0
              ? editorAudio.trimDuration
              : available
          );
          const maxOffset = Math.max(0, total - Math.min(total, usedDuration));
          editorAudio.offset = Math.max(
            0,
            Math.min(maxOffset, startOffset + deltaSeconds)
          );
          qs("#editor-audio-offset").value = editorAudio.offset.toFixed(1);
        }
        renderEditorAudioTrack();
      };

      const onEnd = (endEvent) => {
        editorAudioBlock.classList.remove("dragging", "resizing");
        try {
          editorAudioBlock.releasePointerCapture(endEvent.pointerId);
        } catch {
          // Pointer capture may already be released by the browser.
        }
        editorAudioBlock.removeEventListener("pointermove", onMove);
        editorAudioBlock.removeEventListener("pointerup", onEnd);
        editorAudioBlock.removeEventListener("pointercancel", onEnd);
      };

      editorAudioBlock.addEventListener("pointermove", onMove);
      editorAudioBlock.addEventListener("pointerup", onEnd);
      editorAudioBlock.addEventListener("pointercancel", onEnd);
    });
  }

  const syncEditorAudioControls = () => {
    if (!editorAudio.file) return;
    editorAudio.offset = Math.max(
      0,
      Number(qs("#editor-audio-offset").value) || 0
    );
    editorAudio.trimStart = Math.max(
      0,
      Number(qs("#editor-audio-trim-start").value) || 0
    );
    editorAudio.trimDuration = Math.max(
      0,
      Number(qs("#editor-audio-trim-duration").value) || 0
    );
    editorAudio.volume = Math.max(
      0,
      Math.min(2, Number(qs("#editor-audio-volume").value) / 100)
    );
    renderEditorAudioTrack();
  };
  [
    "#editor-audio-offset",
    "#editor-audio-trim-start",
    "#editor-audio-trim-duration",
    "#editor-audio-volume",
  ].forEach((selector) => {
    qs(selector)?.addEventListener("input", syncEditorAudioControls);
    qs(selector)?.addEventListener("change", syncEditorAudioControls);
  });

  qs("#editor-clear")?.addEventListener("click", () => {
    if (editorClips.length || editorAudio.file) {
      if (!confirm("Очистить весь таймлайн и аудиодорожку?")) return;
    }
    editorClips = [];
    clearEditorAudio();
    renderEditorTimeline();
  });

  qs("#editor-export")?.addEventListener("click", async () => {
    if (!editorClips.length) {
      showToast("Добавьте хотя бы один ролик на таймлайн.", "error");
      return;
    }

    const button = qs("#editor-export");
    const project = {
      title: `Монтаж · ${new Date().toLocaleString("ru-RU")}`,
      clips: editorClips.map((clip) => ({
        media_id: clip.mediaId,
        volume: clip.volume,
      })),
      audio: {
        enabled: Boolean(editorAudio.file),
        offset: editorAudio.offset,
        trim_start: editorAudio.trimStart,
        trim_duration: editorAudio.trimDuration,
        volume: editorAudio.volume,
      },
    };
    const data = new FormData();
    data.set("project", JSON.stringify(project));
    if (editorAudio.file) {
      data.set("audio", editorAudio.file, editorAudio.file.name);
    }

    button.disabled = true;
    try {
      const result = await api("/api/editor/export", {
        method: "POST",
        body: data,
      });
      localStorage.setItem(EDITOR_EXPORT_JOB_KEY, result.job_id);
      jobsPage = 1;
      switchView("queue");
      showToast(
        "Экспорт добавлен в очередь. После завершения файл скачается автоматически."
      );
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  });

  if (currentView === "editor") {
    refreshEditorMedia();
  }

  qs("#refresh-library").addEventListener("click", () => {
    lastMediaSignature = "";
    refreshState(false, true);
  });

  qs("#clear-library").addEventListener("click", async () => {
    if (
      !confirm(
        "Удалить все ролики из библиотеки? Ролики, которые нужны активной задаче, будут сохранены."
      )
    ) {
      return;
    }

    const button = qs("#clear-library");
    button.disabled = true;
    try {
      const result = await api("/api/media", { method: "DELETE" });
      mediaPage = 1;
      lastMediaSignature = "";
      const protectedText = result.protected
        ? ` Защищено активными задачами: ${result.protected}.`
        : "";
      showToast(`Удалено роликов: ${result.deleted}.${protectedText}`);
      await refreshState(true, true);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  qs("#clear-queue").addEventListener("click", async () => {
    if (
      !confirm(
        "Очистить очередь? Будут удалены завершённые, ошибочные, отменённые и ожидающие задачи. Работающие останутся."
      )
    ) {
      return;
    }

    const button = qs("#clear-queue");
    button.disabled = true;
    try {
      const result = await api("/api/jobs", { method: "DELETE" });
      jobsPage = 1;
      const runningText = result.running_kept
        ? ` Работающих оставлено: ${result.running_kept}.`
        : "";
      showToast(`Удалено задач: ${result.deleted}.${runningText}`);
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const clearUploadPreview = (input) => {
    if (!input) return;
    const card = input.closest(".upload-card");
    const existingUrl = uploadObjectUrls.get(input);
    if (existingUrl) {
      URL.revokeObjectURL(existingUrl);
      uploadObjectUrls.delete(input);
    }

    input.value = "";
    if (!card) return;

    const preview = qs(".upload-preview", card);
    const name = qs(".upload-name", card);
    if (preview) {
      preview.removeAttribute("src");
      preview.hidden = true;
    }
    if (name) {
      name.textContent = "Выбрать изображение";
    }
    card.classList.remove("has-preview");
  };

  const showUploadPreview = (input, file) => {
    const card = input.closest(".upload-card");
    if (!card || !file) {
      clearUploadPreview(input);
      return;
    }

    const previousUrl = uploadObjectUrls.get(input);
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }

    const objectUrl = URL.createObjectURL(file);
    uploadObjectUrls.set(input, objectUrl);

    const preview = qs(".upload-preview", card);
    const name = qs(".upload-name", card);
    if (preview) {
      preview.src = objectUrl;
      preview.hidden = false;
    }
    if (name) {
      name.textContent = file.name;
    }
    card.classList.add("has-preview");
  };

  qsa(".upload-card input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      if (file) {
        showUploadPreview(input, file);
      } else {
        clearUploadPreview(input);
      }
    });
  });

  qsa(".upload-card .upload-remove").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const card = button.closest(".upload-card");
      const input = card ? qs('input[type="file"]', card) : null;
      clearUploadPreview(input);
    });
  });

  window.addEventListener("beforeunload", () => {
    uploadObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    uploadObjectUrls.clear();
    if (editorAudio.objectUrl) {
      URL.revokeObjectURL(editorAudio.objectUrl);
    }
  });

  generationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = qs("#generate-button");
    const data = new FormData(generationForm);
    const [width, height] = qs("#resolution").value.split("x");

    data.delete("resolution");
    data.delete("resolution_shape");
    data.set("width", width);
    data.set("height", height);

    if (!qs("#generate-audio").checked) {
      data.delete("generate_audio");
    }

    saveGeneratorSettings();
    button.disabled = true;
    try {
      await api("/api/generate", { method: "POST", body: data });
      jobsPage = 1;
      switchView("queue");
      showToast("Задача H3 добавлена в очередь.");
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  const dialog = qs("#action-dialog");
  const actionForm = qs("#action-form");

  const openActionDialog = (mediaId) => {
    qs("#action-media-id").value = mediaId;
    dialog.showModal();
  };

  qsa("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });

  actionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mediaId = qs("#action-media-id").value;
    const data = new FormData(actionForm);
    data.delete("media_id");

    qs("#action-submit").disabled = true;
    try {
      await api(`/api/media/${encodeURIComponent(mediaId)}/audio`, {
        method: "POST",
        body: data,
      });
      dialog.close();
      jobsPage = 1;
      switchView("queue");
      showToast("Обработка аудио добавлена в очередь.");
      await refreshState(true, false);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      qs("#action-submit").disabled = false;
    }
  });

  const infoDialog = qs("#media-info-dialog");
  const guideDialog = qs("#prompt-guide-dialog");
  const guideOpenButton = qs("#prompt-guide-open");

  guideOpenButton?.addEventListener("click", () => {
    guideDialog?.showModal();
  });

  qsa("[data-close-guide]").forEach((button) => {
    button.addEventListener("click", () => guideDialog?.close());
  });

  const profileLabel = (value) => PROFILE_LABELS[value] || value || "—";

  const openMediaInfo = (mediaId) => {
    const item = (lastState?.media || []).find((media) => media.id === mediaId);
    if (!item) {
      showToast("Не удалось найти параметры ролика на текущей странице.", "error");
      return;
    }

    const meta = item.meta || {};
    qs("#media-info-prompt").value = meta.prompt || "";
    qs("#media-info-seed").value =
      meta.seed === undefined || meta.seed === null ? "" : String(meta.seed);

    const rows = [
      ["Тип", kindLabel(item.kind)],
      ["Операция", meta.operation || "—"],
      [
        "Разрешение",
        meta.width && meta.height ? `${meta.width} × ${meta.height}` : "—",
      ],
      ["Длительность задания", meta.seconds ? `${meta.seconds} сек` : "—"],
      ["FPS", meta.fps ?? "—"],
      ["Профиль", profileLabel(meta.profile)],
      ["GPU", meta.gpu_backend || "—"],
      ["Нативный звук H3", meta.generate_audio ? "Да" : "Нет"],
      ["Референсов", meta.reference_count ?? "—"],
      ["Длительность файла", humanDuration(item.duration)],
      ["Размер файла", humanBytes(item.size_bytes)],
      ["Создан", shortDate(item.created_at)],
    ];

    qs("#media-info-grid").innerHTML = rows
      .map(
        ([label, value]) => `
          <div class="info-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `
      )
      .join("");

    infoDialog.showModal();
  };

  qsa("[data-close-info-dialog]").forEach((button) => {
    button.addEventListener("click", () => infoDialog.close());
  });

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  };

  qs("#copy-ai-guide-link")?.addEventListener("click", async () => {
    const url = new URL("/static/h3-prompting-guide-ai.txt", window.location.origin).href;
    try {
      await copyText(url);
      showToast("Ссылка для нейронки скопирована.");
    } catch {
      showToast("Не удалось скопировать ссылку.", "error");
    }
  });

  qsa("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await copyText(target.value || target.textContent || "");
        showToast("Скопировано.");
      } catch {
        showToast("Не удалось скопировать.", "error");
      }
    });
  });

  qs("#media-grid").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const card = target.closest("[data-media-id]");
    const mediaId = card?.dataset.mediaId;
    if (!mediaId) return;

    const action = target.dataset.action;

    if (action === "info") {
      openMediaInfo(mediaId);
      return;
    }

    if (action === "audio") {
      openActionDialog(mediaId);
      return;
    }

    if (action === "remove-audio") {
      if (!confirm("Создать отдельную копию ролика без аудиодорожки?")) {
        return;
      }
      try {
        await api(
          `/api/media/${encodeURIComponent(mediaId)}/remove-audio`,
          { method: "POST" }
        );
        jobsPage = 1;
        switchView("queue");
        showToast("Удаление звука добавлено в очередь.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      }
      return;
    }

    if (action === "delete") {
      if (
        !confirm(
          "Удалить этот файл из библиотеки? Производные версии не удаляются."
        )
      ) {
        return;
      }
      try {
        await api(`/api/media/${encodeURIComponent(mediaId)}`, {
          method: "DELETE",
        });
        lastMediaSignature = "";
        showToast("Ролик удалён.");
        await refreshState(true, true);
      } catch (error) {
        showToast(error.message, "error");
      }
    }
  });

  qs("#job-list").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-job-action]");
    if (!target) return;

    const action = target.dataset.jobAction;

    if (action === "library") {
      mediaPage = 1;
      lastMediaSignature = "";
      switchView("library");
      await refreshState(true, true);
      return;
    }

    const jobId = target.dataset.jobId;
    if (!jobId) return;

    if (action === "cancel") {
      if (!confirm("Отменить эту задачу?")) return;
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: "POST",
        });
        showToast("Отмена запрошена.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (action === "retry") {
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
          method: "POST",
        });
        jobsPage = 1;
        showToast("Задача повторно добавлена в очередь.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (action === "delete") {
      if (!confirm("Удалить эту запись из очереди?")) return;
      target.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
        });
        showToast("Запись удалена из очереди.");
        await refreshState(true, false);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        target.disabled = false;
      }
    }
  });

  setInterval(updateLiveJobTimers, 1000);
  refreshState(true, currentView === "library");
})();
