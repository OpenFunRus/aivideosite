(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, fetchJson, showToast } = api;

  const applyLibrarySource = (prefix, item) => {
    const preview = qs("#v2-" + prefix + "-preview");
    if (!preview) return;
    if (!item) {
      preview.pause?.();
      preview.removeAttribute("src");
      preview.load?.();
      preview.hidden = true;
      return;
    }
    preview.src = "/media/" + encodeURIComponent(item.id);
    preview.hidden = false;
    const meta = qs("#v2-" + prefix + "-meta");
    if (meta) {
      meta.textContent =
        W.mediaResolution(item) +
        " · " +
        W.formatSeconds(item.duration || item.meta?.seconds || 0) +
        " · формат наследуется";
    }
  };

  const bindSourcePicker = (prefix) => {
    const select = qs("#v2-" + prefix + "-library");
    const upload = qs("#v2-" + prefix + "-upload");
    select?.addEventListener("change", () => {
      if (select.value) {
        if (upload) upload.value = "";
        W.setObjectUrl(prefix + "-source", null);
        applyLibrarySource(prefix, W.mediaById(select.value));
      } else {
        applyLibrarySource(prefix, null);
      }
    });
    upload?.addEventListener("change", () => {
      const file = upload.files?.[0];
      if (!file) return;
      if (select) select.value = "";
      const url = W.setObjectUrl(prefix + "-source", file);
      const preview = qs("#v2-" + prefix + "-preview");
      if (preview) {
        preview.src = url;
        preview.hidden = false;
      }
      const meta = qs("#v2-" + prefix + "-meta");
      if (meta) meta.textContent = file.name + " · размер определяется сервером";
    });
  };

  const continuePrompt = qs("#v2-continue-prompt");
  const continuePromptCount = qs("#v2-continue-prompt-count");
  const continueLibrary = qs("#v2-continue-library");
  const continueUpload = qs("#v2-continue-upload");
  const continueLibraryTab = qs("#v2-continue-library-tab");
  const continueUploadTab = qs("#v2-continue-upload-tab");
  const continueLibraryPicker = qs("#v2-continue-library-picker");
  const continueUploadHint = qs("#v2-continue-upload-hint");
  const continueSourcePicker = qs("#v2-continue-source-picker");
  const continueSelectedSource = qs("#v2-continue-selected-source");
  const continuePreview = qs("#v2-continue-preview");
  const continueSourceName = qs("#v2-continue-source-name");
  const continueMeta = qs("#v2-continue-meta");
  const continueReplace = qs("#v2-continue-replace");

  const setWorkspaceSetting = (name, value) => {
    const group = qs('[data-v2-setting="' + name + '"]');
    if (!group) return;
    const buttons = Array.from(group.querySelectorAll("[data-value]"));
    const target = buttons.find((button) => button.dataset.value === String(value));
    if (!target) return;
    buttons.forEach((button) => button.classList.toggle("active", button === target));
  };

  const inferContinueProfile = (width, height) => {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

    const ratio = w / h;
    const targets = [
      { value: "1:1", ratio: 1 },
      { value: "16:9", ratio: 16 / 9 },
      { value: "9:16", ratio: 9 / 16 },
    ];
    targets.sort(
      (a, b) =>
        Math.abs(Math.log(ratio / a.ratio)) -
        Math.abs(Math.log(ratio / b.ratio))
    );
    setWorkspaceSetting("continue-ratio", targets[0].value);

    const shortSide = Math.min(w, h);
    const qualities = [
      { value: "480", pixels: 480 },
      { value: "720", pixels: 736 },
      { value: "1080", pixels: 1088 },
    ];
    qualities.sort(
      (a, b) =>
        Math.abs(shortSide - a.pixels) -
        Math.abs(shortSide - b.pixels)
    );
    setWorkspaceSetting("continue-quality", qualities[0].value);
  };

  const updateContinuePromptCount = () => {
    if (!continuePromptCount || !continuePrompt) return;
    continuePromptCount.textContent =
      continuePrompt.value.length.toLocaleString("ru-RU") + " / 16 000";
  };

  const setContinueSourceMode = (mode) => {
    const libraryMode = mode !== "upload";
    continueLibraryTab?.classList.toggle("active", libraryMode);
    continueUploadTab?.classList.toggle("active", !libraryMode);
    if (continueLibraryPicker) continueLibraryPicker.hidden = !libraryMode;
    if (continueUploadHint) continueUploadHint.hidden = libraryMode;
  };

  const clearContinueSourceVisual = () => {
    if (continuePreview) {
      continuePreview.pause?.();
      continuePreview.removeAttribute("src");
      continuePreview.load?.();
    }
    if (continueSelectedSource) continueSelectedSource.hidden = true;
    if (continueSourcePicker) continueSourcePicker.hidden = false;
    if (continueSourceName) continueSourceName.textContent = "Исходный ролик";
    if (continueMeta) continueMeta.textContent = "Размер определяется автоматически";
  };

  const renderContinueSource = ({ url, name, width = 0, height = 0, duration = 0, sizeBytes = 0 } = {}) => {
    if (!url || !continuePreview) {
      clearContinueSourceVisual();
      return;
    }

    continuePreview.src = url;
    if (continueSelectedSource) continueSelectedSource.hidden = false;
    if (continueSourcePicker) continueSourcePicker.hidden = true;
    if (continueSourceName) continueSourceName.textContent = name || "Исходный ролик";

    const renderMeta = (resolvedWidth, resolvedHeight, resolvedDuration) => {
      const parts = [];
      if (resolvedDuration > 0) parts.push(W.formatSeconds(resolvedDuration));
      if (resolvedWidth > 0 && resolvedHeight > 0) {
        const ratio =
          Math.abs(resolvedWidth / resolvedHeight - 1) < 0.08
            ? "1:1"
            : resolvedWidth > resolvedHeight
              ? "16:9"
              : "9:16";
        parts.push(Math.round(resolvedWidth) + " × " + Math.round(resolvedHeight) + " (" + ratio + ")");
        inferContinueProfile(resolvedWidth, resolvedHeight);
      }
      if (Number(sizeBytes) > 0) parts.push(W.formatBytes(sizeBytes));
      if (continueMeta) {
        continueMeta.textContent =
          parts.length ? parts.join("  ·  ") : "Параметры определятся после загрузки";
      }
    };

    renderMeta(Number(width), Number(height), Number(duration));

    continuePreview.onloadedmetadata = () => {
      renderMeta(
        continuePreview.videoWidth || Number(width),
        continuePreview.videoHeight || Number(height),
        continuePreview.duration || Number(duration)
      );
    };
  };

  continuePrompt?.addEventListener("input", updateContinuePromptCount);
  updateContinuePromptCount();

  continueLibraryTab?.addEventListener("click", () => {
    setContinueSourceMode("library");
    if (continueUpload?.files?.length) {
      continueUpload.value = "";
      W.setObjectUrl("continue-source", null);
    }
    if (continueLibrary?.value) {
      const item = W.mediaById(continueLibrary.value);
      if (item) {
        renderContinueSource({
          url: "/media/" + encodeURIComponent(item.id),
          name: item.title || item.filename || "Видео из библиотеки",
          width: item.meta?.width,
          height: item.meta?.height,
          duration: item.duration || item.meta?.seconds,
          sizeBytes: item.size_bytes,
        });
      }
    } else {
      clearContinueSourceVisual();
    }
  });

  continueUploadTab?.addEventListener("click", () => {
    if (continueLibrary) continueLibrary.value = "";
    setContinueSourceMode("upload");
    clearContinueSourceVisual();
    if (continueUploadHint) continueUploadHint.hidden = false;
    if (continueLibraryPicker) continueLibraryPicker.hidden = true;
    continueUpload?.click();
  });

  continueLibrary?.addEventListener("change", () => {
    if (!continueLibrary.value) {
      clearContinueSourceVisual();
      return;
    }
    if (continueUpload) continueUpload.value = "";
    W.setObjectUrl("continue-source", null);
    setContinueSourceMode("library");
    const item = W.mediaById(continueLibrary.value);
    if (!item) return;
    renderContinueSource({
      url: "/media/" + encodeURIComponent(item.id),
      name: item.title || item.filename || "Видео из библиотеки",
      width: item.meta?.width,
      height: item.meta?.height,
      duration: item.duration || item.meta?.seconds,
      sizeBytes: item.size_bytes,
    });
  });

  continueUpload?.addEventListener("change", () => {
    const file = continueUpload.files?.[0];
    if (!file) return;
    if (continueLibrary) continueLibrary.value = "";
    setContinueSourceMode("upload");
    const url = W.setObjectUrl("continue-source", file);
    renderContinueSource({ url, name: file.name, sizeBytes: file.size });
  });

  continueReplace?.addEventListener("click", () => {
    if (continueLibrary) continueLibrary.value = "";
    if (continueUpload) continueUpload.value = "";
    W.setObjectUrl("continue-source", null);
    setContinueSourceMode("library");
    clearContinueSourceVisual();
  });

  setContinueSourceMode("library");

  const improvePrompt = async (kind) => {
    const config = {
      continue: {
        target: "#v2-continue-prompt",
        instruction:
          "Перепиши запрос для V2 «Продолжить» в канонические три H3-поля. " +
          "Это Ref2VA video continuation: backend сам добавит subject_definitions/summary/retention_analysis и реальный <Video N>. " +
          "Не придумывай reference labels. В [Shot 1] начинай ровно из конечного состояния source video: поза, направление движения, momentum, camera direction, свет и география сцены сохраняются. " +
          "Дальше опиши только новое действие. Тайминг shots обязан укладываться в выбранную duration. " +
          "Если звук включён — физические звуки/атмосфера в overall_soundscape; если выключен — N/A. Музыку не добавляй без просьбы. Return only changes.prompt.",
        settings: () => ({
          workspace: "continue",
          generation_mode: "reference",
          reference_task: "video_continuation",
          seconds: Number(W.settingValue("continue-seconds", "10")),
          steps: Number(W.settingValue("continue-steps", "12")),
          generate_audio: Boolean(qs("#v2-continue-audio")?.checked),
        }),
      },
      audio: {
        target: "#v2-audio-prompt",
        instruction:
          "Перепиши запрос для V2 «По аудио» в канонические три H3-поля. " +
          "Это Digital Human: master track уже является driving audio, поэтому НЕ описывай его как музыку, которую H3 должен сочинить, и ставь non_diegetic_music: N/A. " +
          "Синхронизируй видимое исполнение, артикуляцию, жесты и body motion с driving audio, но не выдумывай lyrics, если пользователь их не дал. " +
          "Если «Фоновые звуки H3» выключены — overall_soundscape: N/A; если включены — только физические/фоновые звуки сцены, без дублирования master track. " +
          "Backend сам добавит реальные reference labels. Тайминг shots обязан укладываться в выбранную duration. Return only changes.prompt.",
        settings: () => ({
          workspace: "audio",
          generation_mode: "digital_human",
          reference_task: "audio_reference",
          seconds: Number(W.settingValue("audio-seconds", "10")),
          steps: Number(W.settingValue("audio-steps", "12")),
          embed_track: Boolean(qs("#v2-audio-embed-track")?.checked),
          generate_scene_audio: Boolean(qs("#v2-audio-scene-sound")?.checked),
        }),
      },
      clip: {
        target: "#v2-clip-prompt",
        instruction:
          "Перепиши запрос для V2 «Продолжить клип» в канонические три H3-поля. " +
          "Это следующий video-continuation segment поверх следующего отрезка того же master track. " +
          "Начинай из точного end-state предыдущего ролика, сохраняй identity, pose, screen direction, momentum, camera motion, lighting и scene geography. " +
          "Master track уже внешний: non_diegetic_music: N/A. Если «Фоновые звуки H3» выключены — overall_soundscape: N/A; если включены — только дополнительные звуки сцены. " +
          "Backend сам добавит реальные reference labels. Тайминг shots обязан укладываться в выбранную duration. Return only changes.prompt.",
        settings: () => ({
          workspace: "clip",
          generation_mode: "reference",
          reference_task: "video_continuation",
          seconds: Number(W.settingValue("clip-seconds", "10")),
          steps: Number(W.settingValue("clip-steps", "12")),
          embed_track: Boolean(qs("#v2-clip-embed-track")?.checked),
          generate_scene_audio: Boolean(qs("#v2-clip-scene-sound")?.checked),
          audio_start: Number(qs("#v2-clip-audio-start")?.value || 0),
        }),
      },
    }[kind];
    if (!config) return;

    const target = qs(config.target);
    const source = target?.value.trim();
    if (!source) {
      showToast("Сначала напишите обычный prompt.", "error");
      target?.focus();
      return;
    }
    const button = qs('[data-v2-wand="' + kind + '"]');
    if (button) button.disabled = true;
    try {
      const result = await fetchJson("/api/assistant/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: config.instruction + "\n\n" + source }],
          settings: {
            ...(api.currentAssistantSettings?.() || {}),
            ...(typeof config.settings === "function" ? config.settings() : config.settings),
            selected_character_ids: W.selectedCharacterIds(),
          },
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (!improved) throw new Error(result?.message || "ИИ не вернул prompt.");
      target.value = String(improved).trim();
      target.dispatchEvent(new Event("input", { bubbles: true }));
      showToast("Prompt улучшен под H3.");
    } catch (error) {
      showToast("Не удалось улучшить prompt: " + error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  };

  bindSourcePicker("clip");

  document.querySelectorAll("[data-v2-wand]").forEach((button) => {
    button.addEventListener("click", () => improvePrompt(button.dataset.v2Wand));
  });

  qs("#v2-continue-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData();
    const prompt = qs("#v2-continue-prompt")?.value.trim() || "";
    if (!prompt) return showToast("Напишите, что должно происходить дальше.", "error");
    data.set("prompt", prompt);
    data.set("source_media_id", qs("#v2-continue-library")?.value || "");
    const upload = qs("#v2-continue-upload")?.files?.[0];
    if (upload) data.set("source_video", upload);
    data.set("quality", W.settingValue("continue-quality", "720"));
    data.set("ratio", W.settingValue("continue-ratio", "16:9"));
    data.set("seconds", W.settingValue("continue-seconds", "10"));
    data.set("steps", W.settingValue("continue-steps", "12"));
    data.set("seed", qs("#v2-continue-seed")?.value || "");
    data.set("generate_audio", qs("#v2-continue-audio")?.checked ? "true" : "false");
    data.set("character_ids", JSON.stringify(W.selectedCharacterIds()));
    await W.submitForm("/api/v2/continue", data, qs('button[type="submit"]', form));
  });

  const clipAudio = qs("#v2-clip-audio");
  const clipTrackSelect = qs("#v2-clip-track");
  const clipPrompt = qs("#v2-clip-prompt");
  const clipPromptCount = qs("#v2-clip-prompt-count");
  const updateClipPromptCount = () => {
    if (clipPromptCount && clipPrompt) {
      clipPromptCount.textContent = clipPrompt.value.length.toLocaleString("ru-RU") + " / 16 000";
    }
  };
  clipPrompt?.addEventListener("input", updateClipPromptCount);
  updateClipPromptCount();

  const setClipSourceMode = (kind, mode) => {
    const library = mode !== "upload";
    qs("#v2-clip-" + kind + "-library-tab")?.classList.toggle("active", library);
    qs("#v2-clip-" + kind + "-upload-tab")?.classList.toggle("active", !library);
    const picker = qs("#v2-clip-" + kind + "-picker");
    const hint = qs("#v2-clip-" + kind + "-upload-hint");
    if (picker) picker.hidden = !library;
    if (hint) hint.hidden = library;
  };
  for (const [kind, inputId] of [["video", "v2-clip-upload"], ["track", "v2-clip-audio"]]) {
    qs("#v2-clip-" + kind + "-library-tab")?.addEventListener("click", () => setClipSourceMode(kind, "library"));
    qs("#v2-clip-" + kind + "-upload-tab")?.addEventListener("click", () => {
      setClipSourceMode(kind, "upload");
      qs("#" + inputId)?.click();
    });
    qs("#" + inputId)?.addEventListener("change", () => {
      if (qs("#" + inputId)?.files?.length) setClipSourceMode(kind, "upload");
    });
  }
  qs("#v2-clip-library")?.addEventListener("change", () => setClipSourceMode("video", "library"));
  clipTrackSelect?.addEventListener("change", () => setClipSourceMode("track", "library"));
  clipTrackSelect?.addEventListener("change", () => {
    if (!clipTrackSelect.value) return;
    if (clipAudio) clipAudio.value = "";
    W.setObjectUrl("clip-master-audio", null);
    const player = qs("#v2-clip-audio-player");
    if (player) {
      player.pause?.();
      player.hidden = true;
      player.removeAttribute("src");
    }
  });
  clipAudio?.addEventListener("change", () => {
    const file = clipAudio.files?.[0];
    const player = qs("#v2-clip-audio-player");
    if (file && clipTrackSelect) clipTrackSelect.value = "";
    if (!player) return;
    if (!file) {
      player.hidden = true;
      return;
    }
    player.src = W.setObjectUrl("clip-master-audio", file);
    player.hidden = false;
  });

  const updateClipRange = () => {
    const start = Math.max(0, Number(qs("#v2-clip-audio-start")?.value) || 0);
    const seconds = Number(W.settingValue("clip-seconds", "10")) || 10;
    const label = qs("#v2-clip-range");
    if (label) {
      label.textContent =
        "Будет использован отрезок " +
        start.toFixed(1) +
        "–" +
        (start + seconds).toFixed(1) +
        " сек";
    }
  };
  W.updateClipRange = updateClipRange;

  qs("#v2-clip-audio-start")?.addEventListener("input", updateClipRange);

  qs("#v2-clip-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const prompt = qs("#v2-clip-prompt")?.value.trim() || "";
    const audio = clipAudio?.files?.[0];
    const trackId = clipTrackSelect?.value || "";
    if (!prompt) return showToast("Опишите следующий фрагмент.", "error");
    if (!audio && !trackId) {
      return showToast("Выберите сохранённый master track или новый файл.", "error");
    }

    const data = new FormData();
    data.set("prompt", prompt);
    data.set("source_media_id", qs("#v2-clip-library")?.value || "");
    const upload = qs("#v2-clip-upload")?.files?.[0];
    if (upload) data.set("source_video", upload);
    data.set("track_id", trackId);
    if (audio) data.set("master_audio", audio);
    data.set("audio_start", qs("#v2-clip-audio-start")?.value || "0");
    data.set("quality", W.settingValue("clip-quality", "720"));
    data.set("ratio", W.settingValue("clip-ratio", "16:9"));
    data.set("seconds", W.settingValue("clip-seconds", "10"));
    data.set("steps", W.settingValue("clip-steps", "12"));
    data.set("seed", qs("#v2-clip-seed")?.value || "");
    data.set("embed_track", qs("#v2-clip-embed-track")?.checked ? "true" : "false");
    data.set("generate_scene_audio", qs("#v2-clip-scene-sound")?.checked ? "true" : "false");
    data.set("character_ids", JSON.stringify(W.selectedCharacterIds()));

    const result = await W.submitForm("/api/v2/clip", data, qs('button[type="submit"]', form));
    if (result) {
      if (clipTrackSelect && result.track_id) clipTrackSelect.value = String(result.track_id);
      if (Number.isFinite(Number(result.audio_end))) {
        const input = qs("#v2-clip-audio-start");
        if (input) input.value = String(result.audio_end);
        updateClipRange();
      }
    }
  });

  window.addEventListener("v2:use-continue", (event) => {
    const item = W.mediaById(event.detail?.mediaId);
    if (!item) return;
    if (continueLibrary) continueLibrary.value = item.id;
    if (continueUpload) continueUpload.value = "";
    setContinueSourceMode("library");
    renderContinueSource({
      url: "/media/" + encodeURIComponent(item.id),
      name: item.title || item.filename || "Видео из библиотеки",
      width: item.meta?.width,
      height: item.meta?.height,
      duration: item.duration || item.meta?.seconds,
      sizeBytes: item.size_bytes,
    });
    api.setView?.("continue");
  });

  window.addEventListener("v2:use-clip", (event) => {
    const item = W.mediaById(event.detail?.mediaId);
    if (!item) return;
    const select = qs("#v2-clip-library");
    if (select) select.value = item.id;
    setClipSourceMode("video", "library");
    applyLibrarySource("clip", item);
    const context = item.meta?.v2_context || {};
    if (context.quality) setWorkspaceSetting("clip-quality", context.quality);
    if (context.ratio) setWorkspaceSetting("clip-ratio", context.ratio);
    const trackId = String(item.meta?.v2_context?.track_id || "");
    if (clipTrackSelect && trackId) {
      clipTrackSelect.value = trackId;
      setClipSourceMode("track", "library");
      if (clipAudio) clipAudio.value = "";
    }
    const nextStart = Number(item.meta?.v2_context?.audio_end);
    if (Number.isFinite(nextStart) && nextStart >= 0) {
      const input = qs("#v2-clip-audio-start");
      if (input) input.value = String(nextStart);
    }
    updateClipRange();
    api.setView?.("clip");
  });

  updateClipRange();
})();
