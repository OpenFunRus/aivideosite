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

  const improvePrompt = async (kind) => {
    const config = {
      continue: {
        target: "#v2-continue-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 video continuation prompt. Preserve end-state continuity, movement direction, pose, camera direction, lighting and scene geography. Return only changes.prompt.",
        settings: { generation_mode: "reference", reference_task: "video_continuation" },
      },
      audio: {
        target: "#v2-audio-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 Digital Human/audio-driven performance prompt. Synchronize visible performance and mouth/body motion to the driving audio. Return only changes.prompt.",
        settings: { generation_mode: "digital_human", reference_task: "audio_reference" },
      },
      clip: {
        target: "#v2-clip-prompt",
        instruction:
          "Rewrite this as a production-ready MiniMax H3 next music-video segment prompt. Preserve previous-video continuity and synchronize action to the supplied master-track segment. Return only changes.prompt.",
        settings: { generation_mode: "reference", reference_task: "video_continuation" },
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
            ...config.settings,
            selected_character_ids: W.selectedCharacterIds(),
          },
          thinking: false,
        }),
      });
      const improved = result?.changes?.prompt;
      if (!improved) throw new Error(result?.message || "ИИ не вернул prompt.");
      target.value = String(improved).trim();
      showToast("Prompt улучшен под H3.");
    } catch (error) {
      showToast("Не удалось улучшить prompt: " + error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  };

  bindSourcePicker("continue");
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
    data.set("seconds", W.settingValue("continue-seconds", "10"));
    data.set("steps", W.settingValue("continue-steps", "12"));
    data.set("seed", qs("#v2-continue-seed")?.value || "");
    data.set("generate_audio", qs("#v2-continue-audio")?.checked ? "true" : "false");
    data.set("character_ids", JSON.stringify(W.selectedCharacterIds()));
    await W.submitForm("/api/v2/continue", data, qs('button[type="submit"]', form));
  });

  const audioInput = qs("#v2-audio-file");
  const audioTrackSelect = qs("#v2-audio-track");
  audioTrackSelect?.addEventListener("change", () => {
    if (!audioTrackSelect.value) return;
    if (audioInput) audioInput.value = "";
    W.setObjectUrl("audio-driving", null);
    const player = qs("#v2-audio-player");
    if (player) {
      player.pause?.();
      player.hidden = true;
      player.removeAttribute("src");
    }
  });
  audioInput?.addEventListener("change", () => {
    const file = audioInput.files?.[0];
    const player = qs("#v2-audio-player");
    if (file && audioTrackSelect) audioTrackSelect.value = "";
    if (!player) return;
    if (!file) {
      player.hidden = true;
      return;
    }
    player.src = W.setObjectUrl("audio-driving", file);
    player.hidden = false;
  });

  qs("#v2-audio-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const audio = audioInput?.files?.[0];
    const trackId = audioTrackSelect?.value || "";
    const prompt = qs("#v2-audio-prompt")?.value.trim() || "";
    if (!audio && !trackId) return showToast("Выберите master track или новый аудиофайл.", "error");
    if (!prompt) return showToast("Опишите сценическое действие.", "error");

    const data = new FormData();
    data.set("prompt", prompt);
    data.set("track_id", trackId);
    if (audio) data.set("audio", audio);
    const visual = qs("#v2-audio-visual")?.files?.[0];
    if (visual) data.set("visual_reference", visual);
    data.set("quality", W.settingValue("audio-quality", "720"));
    data.set("ratio", W.settingValue("audio-ratio", "16:9"));
    data.set("seconds", W.settingValue("audio-seconds", "10"));
    data.set("steps", W.settingValue("audio-steps", "12"));
    data.set("seed", qs("#v2-audio-seed")?.value || "");
    data.set("character_ids", JSON.stringify(W.selectedCharacterIds()));
    await W.submitForm("/api/v2/audio", data, qs('button[type="submit"]', form));
  });

  const clipAudio = qs("#v2-clip-audio");
  const clipTrackSelect = qs("#v2-clip-track");
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
    data.set("seconds", W.settingValue("clip-seconds", "10"));
    data.set("steps", W.settingValue("clip-steps", "12"));
    data.set("seed", qs("#v2-clip-seed")?.value || "");
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
    const select = qs("#v2-continue-library");
    if (select) select.value = item.id;
    applyLibrarySource("continue", item);
    api.setView?.("continue");
  });

  window.addEventListener("v2:use-clip", (event) => {
    const item = W.mediaById(event.detail?.mediaId);
    if (!item) return;
    const select = qs("#v2-clip-library");
    if (select) select.value = item.id;
    applyLibrarySource("clip", item);
    const trackId = String(item.meta?.v2_context?.track_id || "");
    if (clipTrackSelect && trackId) {
      clipTrackSelect.value = trackId;
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