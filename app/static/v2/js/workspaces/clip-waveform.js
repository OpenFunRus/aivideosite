(() => {
  "use strict";
  const W = window.AIVideoV2Workspaces;
  if (!W) return;
  const $ = (selector) => document.querySelector(selector);
  const trackSelect = $("#v2-clip-track");
  const upload = $("#v2-clip-audio");
  const startInput = $("#v2-clip-audio-start");
  const timeline = $("#v2-clip-timeline");
  const stage = $("#v2-clip-wave-stage");
  const canvas = $("#v2-clip-waveform");
  const windowBlock = $("#v2-clip-window");
  const playButton = $("#v2-clip-play");
  if (!trackSelect || !stage || !windowBlock) return;

  const audio = new Audio();
  audio.preload = "metadata";
  let buffer = null;
  let duration = 0;
  let dragging = false;
  let dragOffset = 0;
  let revision = 0;
  let objectUrl = null;
  const seconds = () => Number(W.settingValue("clip-seconds", "10")) || 10;
  const time = (v) => {
    const safe = Math.max(0, Number(v) || 0);
    return String(Math.floor(safe / 60)).padStart(2, "0") + ":" + (safe % 60).toFixed(1).padStart(4, "0");
  };
  const maxStart = () => Math.max(0, duration - seconds());
  const start = () => Math.max(0, Math.min(maxStart(), Number(startInput.value) || 0));

  const draw = () => {
    const scale = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(stage.clientWidth * scale));
    const height = Math.max(1, Math.floor(stage.clientHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const samples = Math.max(80, Math.floor(width / (2 * scale)));
    const data = buffer?.getChannelData(0);
    const step = data ? Math.max(1, Math.floor(data.length / samples)) : 1;
    ctx.strokeStyle = "#555e78";
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    for (let i = 0; i < samples; i++) {
      let peak = 0.1 + 0.1 * Math.abs(Math.sin(i * 0.37));
      if (data) {
        peak = 0;
        const begin = i * step;
        for (let j = begin; j < Math.min(data.length, begin + step); j++) {
          peak = Math.max(peak, Math.abs(data[j]));
        }
      }
      const x = i / Math.max(1, samples - 1) * width;
      const amplitude = Math.max(scale, peak * height * 0.42);
      ctx.moveTo(x, height / 2 - amplitude);
      ctx.lineTo(x, height / 2 + amplitude);
    }
    ctx.stroke();
  };
  const render = () => {
    const position = start();
    startInput.value = position.toFixed(1);
    windowBlock.style.left = duration ? position / duration * 100 + "%" : "0%";
    windowBlock.style.width = duration ? Math.min(100, seconds() / duration * 100) + "%" : "20%";
    $("#v2-clip-window-label").textContent = seconds() + " сек";
    $("#v2-clip-total-time").textContent = time(duration);
    $("#v2-clip-start-label").textContent = time(position);
    $("#v2-clip-end-label").textContent = time(Math.min(duration || Infinity, position + seconds()));
    W.updateClipRange?.();
  };
  const load = async () => {
    const token = ++revision;
    audio.pause();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    buffer = null;
    const file = upload.files?.[0];
    const id = trackSelect.value;
    if (!file && !id) {
      timeline.hidden = true;
      audio.removeAttribute("src");
      duration = 0;
      return;
    }
    if (file) objectUrl = URL.createObjectURL(file);
    const source = file ? objectUrl : "/api/v2/tracks/" + encodeURIComponent(id) + "/audio";
    audio.src = source;
    timeline.hidden = false;
    const meta = (W.snapshot?.tracks || []).find((track) => String(track.id) === id);
    duration = Math.max(0, Number(file ? 0 : meta?.duration) || 0);
    render();
    try {
      const bytes = file ? await file.arrayBuffer() : await (async () => {
        const response = await fetch(source, { cache: "no-store" });
        if (!response.ok) throw new Error("track fetch failed");
        return response.arrayBuffer();
      })();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      try {
        const decoded = await context.decodeAudioData(bytes.slice(0));
        if (token !== revision) return;
        buffer = decoded;
        duration = decoded.duration;
      } finally { await context.close().catch(() => {}); }
    } catch { /* Leave the timeline usable when waveform decoding is unavailable. */ }
    if (token !== revision) return;
    draw();
    render();
  };
  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration)) duration = audio.duration;
    render();
  });
  audio.addEventListener("timeupdate", () => {
    if (!audio.paused && audio.currentTime >= start() + seconds()) audio.pause();
  });
  playButton?.addEventListener("click", async () => {
    if (!audio.src) return;
    if (!audio.paused) { audio.pause(); return; }
    audio.currentTime = start();
    try { await audio.play(); } catch { /* Browser may block playback. */ }
  });
  const pointerStart = (event, offset) => {
    const rect = stage.getBoundingClientRect();
    const raw = (event.clientX - rect.left - offset) / Math.max(1, rect.width) * duration;
    startInput.value = Math.max(0, Math.min(maxStart(), raw)).toFixed(1);
    render();
  };
  windowBlock.addEventListener("pointerdown", (event) => {
    dragging = true;
    dragOffset = event.clientX - windowBlock.getBoundingClientRect().left;
    windowBlock.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  windowBlock.addEventListener("pointermove", (event) => { if (dragging) pointerStart(event, dragOffset); });
  for (const name of ["pointerup", "pointercancel"]) windowBlock.addEventListener(name, () => { dragging = false; });
  stage.addEventListener("pointerdown", (event) => {
    if (windowBlock.contains(event.target)) return;
    pointerStart(event, windowBlock.getBoundingClientRect().width / 2);
  });
  trackSelect.addEventListener("change", load);
  upload.addEventListener("change", load);
  document.querySelectorAll('[data-v2-setting="clip-seconds"] button').forEach((button) => button.addEventListener("click", () => queueMicrotask(render)));
  window.addEventListener("v2:use-clip", () => queueMicrotask(load));
  window.addEventListener("resize", draw);
  render();
})();
