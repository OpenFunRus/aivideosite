(() => {
  "use strict";

  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;

  const { state, qs, showToast, saveDraft } = api;
  const RESERVE_SECONDS = 1.0;

  const useTrack = qs("#v2-use-track");
  const body = qs("#v2-audio-track-body");
  const normalSoundOption = qs("#v2-generate-sound-option");
  const trackSelect = qs("#v2-audio-track");
  const audioInput = qs("#v2-audio-file");
  const libraryTab = qs("#v2-audio-library-tab");
  const uploadTab = qs("#v2-audio-upload-tab");
  const sourcePicker = qs("#v2-audio-source-picker");
  const libraryPicker = qs("#v2-audio-library-picker");
  const uploadHint = qs("#v2-audio-upload-hint");
  const selectedRoot = qs("#v2-audio-selected");
  const replaceButton = qs("#v2-audio-replace");
  const fileName = qs("#v2-audio-file-name");
  const trackDurationLabel = qs("#v2-audio-track-duration");
  const trackBitrateLabel = qs("#v2-audio-track-bitrate");
  const trackSizeLabel = qs("#v2-audio-track-size");
  const trackFormatLabel = qs("#v2-audio-track-format");
  const totalTimeLabel = qs("#v2-audio-total-time");
  const startLabel = qs("#v2-audio-start-label");
  const endLabel = qs("#v2-audio-end-label");
  const playButton = qs("#v2-audio-play");
  const waveStage = qs("#v2-audio-wave-stage");
  const canvas = qs("#v2-audio-waveform");
  const rangeWindow = qs("#v2-audio-window");
  const rangeLabel = qs("#v2-audio-window-label");
  const embedTrack = qs("#v2-audio-embed-track");
  const sceneSound = qs("#v2-audio-scene-sound");

  if (!useTrack || !body) return;

  const previewAudio = new Audio();
  previewAudio.preload = "metadata";

  let selectedTrack = null;
  let decodedBuffer = null;
  let audioStart = 0;
  let dragging = false;
  let dragOffsetPx = 0;

  const formatAudioTime = (value) => {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return String(minutes).padStart(2, "0") + ":" + rest.toFixed(1).padStart(4, "0");
  };

  const selectedSeconds = () =>
    Math.max(1, Number(state.draft?.seconds || 10) || 10);

  const trackDuration = () =>
    Math.max(0, Number(selectedTrack?.duration || previewAudio.duration || 0));

  const maxStart = () => {
    const duration = trackDuration();
    const seconds = selectedSeconds();
    if (!duration) return 0;
    const preferred = duration - seconds - RESERVE_SECONDS;
    if (preferred >= 0) return preferred;
    return Math.max(0, duration - seconds);
  };

  const clampStart = (value) =>
    Math.max(0, Math.min(maxStart(), Number(value) || 0));

  const setSourceMode = (mode) => {
    const library = mode !== "upload";
    libraryTab?.classList.toggle("active", library);
    uploadTab?.classList.toggle("active", !library);
    if (libraryPicker) libraryPicker.hidden = !library;
    if (uploadHint) uploadHint.hidden = library;
  };

  const metadataForTrack = (track) => {
    const duration = Math.max(0, Number(track?.duration || 0));
    const size = Math.max(0, Number(track?.size_bytes || track?.size || 0));
    let bitrate = Number(track?.bitrate_kbps || 0);
    if (!bitrate && size > 0 && duration > 0) {
      bitrate = Math.round(size * 8 / duration / 1000);
    }
    const extension = String(
      track?.extension ||
      String(track?.title || track?.file?.name || "").split(".").pop() ||
      "audio"
    ).replace(/[^a-z0-9]/gi, "").toUpperCase() || "AUDIO";
    return { duration, size, bitrate, extension };
  };

  const drawWaveform = () => {
    if (!canvas || !waveStage) return;
    const rect = waveStage.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const center = height / 2;
    const data = decodedBuffer?.getChannelData?.(0);
    const samples = Math.max(80, Math.floor(width / Math.max(2, ratio * 2)));
    ctx.lineWidth = Math.max(1, ratio);
    ctx.strokeStyle = "#444b61";
    ctx.beginPath();

    if (data?.length) {
      const step = Math.max(1, Math.floor(data.length / samples));
      for (let i = 0; i < samples; i += 1) {
        let peak = 0;
        const start = i * step;
        const end = Math.min(data.length, start + step);
        for (let index = start; index < end; index += 1) {
          peak = Math.max(peak, Math.abs(data[index]));
        }
        const x = (i / Math.max(1, samples - 1)) * width;
        const amplitude = Math.max(ratio * 1.5, peak * height * 0.42);
        ctx.moveTo(x, center - amplitude);
        ctx.lineTo(x, center + amplitude);
      }
    } else {
      for (let i = 0; i < samples; i += 1) {
        const x = (i / Math.max(1, samples - 1)) * width;
        const amplitude = (0.12 + 0.16 * Math.abs(Math.sin(i * 0.37))) * height;
        ctx.moveTo(x, center - amplitude / 2);
        ctx.lineTo(x, center + amplitude / 2);
      }
    }
    ctx.stroke();
  };

  const decodeWaveform = async (source) => {
    decodedBuffer = null;
    drawWaveform();
    try {
      let arrayBuffer;
      if (source instanceof File) {
        arrayBuffer = await source.arrayBuffer();
      } else {
        const response = await fetch(String(source), {
          cache: "no-store",
          headers: { "X-Requested-With": "AI-Video-Site-V2" },
        });
        if (!response.ok) throw new Error("audio fetch failed");
        arrayBuffer = await response.arrayBuffer();
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      try {
        decodedBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        await context.close().catch(() => {});
      }
      drawWaveform();
    } catch {
      decodedBuffer = null;
      drawWaveform();
    }
  };

  const updateRange = () => {
    if (!rangeWindow) return;
    const duration = trackDuration();
    const seconds = selectedSeconds();
    audioStart = clampStart(audioStart);

    if (!duration) {
      rangeWindow.style.left = "0%";
      rangeWindow.style.width = "20%";
      if (rangeLabel) rangeLabel.textContent = seconds + " сек";
      if (startLabel) startLabel.textContent = "00:00.0";
      if (endLabel) endLabel.textContent = formatAudioTime(seconds + RESERVE_SECONDS) + " (авто)";
      if (totalTimeLabel) totalTimeLabel.textContent = "00:00.0";
      return;
    }

    const visibleWindow = Math.min(seconds, duration);
    rangeWindow.style.left = (audioStart / duration) * 100 + "%";
    rangeWindow.style.width = Math.min(100, (visibleWindow / duration) * 100) + "%";

    const end = Math.min(duration, audioStart + seconds + RESERVE_SECONDS);
    if (rangeLabel) rangeLabel.textContent = seconds + " сек";
    if (startLabel) startLabel.textContent = formatAudioTime(audioStart);
    if (endLabel) endLabel.textContent = formatAudioTime(end) + " (авто)";
    if (totalTimeLabel) totalTimeLabel.textContent = formatAudioTime(duration);

    if (!previewAudio.paused) previewAudio.currentTime = Math.min(audioStart, duration);
  };

  const stopPreview = () => {
    previewAudio.pause();
    playButton?.classList.remove("playing");
  };

  const renderMode = () => {
    const enabled = Boolean(useTrack.checked);
    body.hidden = !enabled;
    if (normalSoundOption) normalSoundOption.hidden = enabled;
    if (!enabled) stopPreview();
    state.draft.useTrack = enabled;
    saveDraft();
    if (enabled) {
      requestAnimationFrame(() => {
        drawWaveform();
        updateRange();
      });
    }
  };

  const renderTrack = async (track, source) => {
    selectedTrack = { ...track };
    audioStart = 0;
    const meta = metadataForTrack(selectedTrack);
    if (meta.duration > 0) selectedTrack.duration = meta.duration;

    if (fileName) fileName.textContent = selectedTrack.title || selectedTrack.file?.name || "Аудиодорожка";
    if (trackDurationLabel) trackDurationLabel.textContent = meta.duration > 0 ? formatAudioTime(meta.duration) : "—";
    if (trackBitrateLabel) trackBitrateLabel.textContent = meta.bitrate > 0 ? meta.bitrate + " kbps" : "—";
    if (trackSizeLabel) trackSizeLabel.textContent = meta.size > 0 ? W.formatBytes(meta.size) : "—";
    if (trackFormatLabel) trackFormatLabel.textContent = meta.extension;

    if (sourcePicker) sourcePicker.hidden = true;
    if (selectedRoot) selectedRoot.hidden = false;

    stopPreview();
    previewAudio.src = source instanceof File
      ? W.setObjectUrl("audio-driving", source)
      : String(source || "");
    previewAudio.load();

    previewAudio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(previewAudio.duration) && previewAudio.duration > 0) {
        selectedTrack.duration = previewAudio.duration;
        const currentMeta = metadataForTrack(selectedTrack);
        if (!selectedTrack.bitrate_kbps && currentMeta.size > 0) {
          selectedTrack.bitrate_kbps = Math.round(currentMeta.size * 8 / previewAudio.duration / 1000);
          if (trackBitrateLabel) trackBitrateLabel.textContent = selectedTrack.bitrate_kbps + " kbps";
        }
        if (trackDurationLabel) trackDurationLabel.textContent = formatAudioTime(previewAudio.duration);
      }
      updateRange();
    }, { once: true });

    await decodeWaveform(source);
    updateRange();
  };

  const selectSavedTrack = async (trackId) => {
    const track = (W.snapshot?.tracks || []).find((item) => String(item.id) === String(trackId));
    if (!track) {
      showToast("Сохранённый трек не найден.", "error");
      return;
    }
    if (audioInput) audioInput.value = "";
    setSourceMode("library");
    await renderTrack(track, "/api/v2/tracks/" + encodeURIComponent(track.id) + "/audio");
  };

  const selectUploadedTrack = async (file) => {
    if (!file) return;
    if (trackSelect) trackSelect.value = "";
    setSourceMode("upload");
    const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "audio";
    await renderTrack({
      title: file.name,
      file,
      size_bytes: file.size,
      extension,
    }, file);
  };

  const clearTrack = () => {
    stopPreview();
    previewAudio.removeAttribute("src");
    previewAudio.load();
    W.setObjectUrl("audio-driving", null);
    decodedBuffer = null;
    selectedTrack = null;
    audioStart = 0;
    if (trackSelect) trackSelect.value = "";
    if (audioInput) audioInput.value = "";
    if (selectedRoot) selectedRoot.hidden = true;
    if (sourcePicker) sourcePicker.hidden = false;
    setSourceMode("library");
    drawWaveform();
    updateRange();
  };

  const setStartFromPointer = (event, offsetPx = 0) => {
    if (!waveStage || !trackDuration()) return;
    const rect = waveStage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const duration = trackDuration();
    const x = event.clientX - rect.left - offsetPx;
    audioStart = clampStart((x / rect.width) * duration);
    updateRange();
  };

  W.updateAudioRange = updateRange;
  W.audioModeEnabled = () => Boolean(useTrack.checked);
  W.audioAssistantContext = () => ({
    audio_mode: Boolean(useTrack.checked),
    audio_start: Number(audioStart.toFixed(3)),
    audio_end: Number((audioStart + selectedSeconds()).toFixed(3)),
    master_track_title: String(selectedTrack?.title || selectedTrack?.file?.name || ""),
    source_kind: selectedTrack?.id ? "library_track" : (selectedTrack ? "uploaded_track" : "none"),
    has_driving_audio: Boolean(selectedTrack),
    embed_track: Boolean(embedTrack?.checked),
    generate_scene_audio: Boolean(sceneSound?.checked),
  });
  W.audioSubmission = () => ({
    enabled: Boolean(useTrack.checked),
    trackId: String(trackSelect?.value || ""),
    uploadedAudio: audioInput?.files?.[0] || null,
    audioStart: Number(audioStart.toFixed(3)),
    embedTrack: Boolean(embedTrack?.checked),
    generateSceneAudio: Boolean(sceneSound?.checked),
    hasTrack: Boolean(selectedTrack),
  });

  useTrack.addEventListener("change", renderMode);
  embedTrack?.addEventListener("change", saveDraft);
  sceneSound?.addEventListener("change", saveDraft);

  libraryTab?.addEventListener("click", () => {
    if (selectedTrack?.id) {
      setSourceMode("library");
      return;
    }
    clearTrack();
    setSourceMode("library");
  });

  uploadTab?.addEventListener("click", () => audioInput?.click());

  trackSelect?.addEventListener("change", () => {
    if (trackSelect.value) selectSavedTrack(trackSelect.value);
  });

  audioInput?.addEventListener("change", () => {
    const file = audioInput.files?.[0];
    if (file) selectUploadedTrack(file);
  });

  replaceButton?.addEventListener("click", clearTrack);

  rangeWindow?.addEventListener("pointerdown", (event) => {
    if (!trackDuration()) return;
    dragging = true;
    const rect = rangeWindow.getBoundingClientRect();
    dragOffsetPx = event.clientX - rect.left;
    rangeWindow.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  rangeWindow?.addEventListener("pointermove", (event) => {
    if (dragging) setStartFromPointer(event, dragOffsetPx);
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    rangeWindow?.releasePointerCapture?.(event.pointerId);
  };
  rangeWindow?.addEventListener("pointerup", endDrag);
  rangeWindow?.addEventListener("pointercancel", endDrag);

  waveStage?.addEventListener("pointerdown", (event) => {
    if (event.target === rangeWindow || rangeWindow?.contains(event.target)) return;
    const rect = rangeWindow?.getBoundingClientRect();
    setStartFromPointer(event, (rect?.width || 0) / 2);
  });

  playButton?.addEventListener("click", async () => {
    if (!selectedTrack || !previewAudio.src) {
      showToast("Сначала выберите аудиодорожку.", "error");
      return;
    }
    if (!previewAudio.paused) {
      stopPreview();
      return;
    }
    previewAudio.currentTime = Math.min(audioStart, Math.max(0, trackDuration() - 0.05));
    try {
      await previewAudio.play();
      playButton.classList.add("playing");
    } catch {
      showToast("Браузер не разрешил воспроизведение аудио.", "error");
    }
  });

  previewAudio.addEventListener("timeupdate", () => {
    const previewEnd = Math.min(trackDuration(), audioStart + selectedSeconds());
    if (!previewAudio.paused && previewAudio.currentTime >= previewEnd) {
      stopPreview();
      previewAudio.currentTime = audioStart;
    }
  });
  previewAudio.addEventListener("ended", stopPreview);

  window.addEventListener("v2:datarefresh", () => {
    if (!selectedTrack?.id) return;
    const updated = (W.snapshot?.tracks || []).find((item) => String(item.id) === String(selectedTrack.id));
    if (!updated) return;
    selectedTrack = { ...selectedTrack, ...updated };
    const meta = metadataForTrack(selectedTrack);
    if (trackSizeLabel && meta.size > 0) trackSizeLabel.textContent = W.formatBytes(meta.size);
    if (trackBitrateLabel && meta.bitrate > 0) trackBitrateLabel.textContent = meta.bitrate + " kbps";
  });

  if (window.ResizeObserver && waveStage) {
    const observer = new ResizeObserver(drawWaveform);
    observer.observe(waveStage);
  } else {
    window.addEventListener("resize", drawWaveform);
  }

  setSourceMode("library");
  useTrack.checked = Boolean(state.draft.useTrack);
  renderMode();
  updateRange();
  drawWaveform();

  window.addEventListener("beforeunload", stopPreview);
})();
