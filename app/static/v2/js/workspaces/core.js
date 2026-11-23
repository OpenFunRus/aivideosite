(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { qs, qsa, fetchJson, showToast, escapeHtml } = api;

  const W = {
    snapshot: null,
    allMedia: [],
    refreshing: null,
    objectUrls: new Map(),
  };

  W.loadJson = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "");
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  W.saveJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };

  W.setObjectUrl = (key, file) => {
    const old = W.objectUrls.get(key);
    if (old) URL.revokeObjectURL(old);
    W.objectUrls.delete(key);
    if (!file) return "";
    const url = URL.createObjectURL(file);
    W.objectUrls.set(key, url);
    return url;
  };

  W.formatSeconds = (value) => {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
  };

  W.formatBytes = (value) => {
    let bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit += 1;
    }
    return bytes.toFixed(unit >= 3 ? 1 : 0) + " " + units[unit];
  };

  W.formatDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };

  W.elapsed = (start, endSeconds) => {
    if (!start) return "—";
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) return "—";
    const endMs = endSeconds ? Number(endSeconds) * 1000 : Date.now();
    return W.formatSeconds(Math.max(0, (endMs - startMs) / 1000));
  };

  W.mediaById = (id) =>
    W.allMedia.find((item) => String(item.id) === String(id)) || null;

  W.selectedCharacterIds = () =>
    Array.from(api.state.selectedCharacterIds || []).map(String);

  W.selectedLocationIds = () =>
    Array.from(api.state.selectedLocationIds || []).map(String);

  W.mutedCharacterIds = () =>
    (api.mutedCharacterIds?.() || []).map(String);

  W.settingValue = (name, fallback = "") => {
    const group = qs('[data-v2-setting="' + name + '"]');
    return qs("button.active", group)?.dataset.value || fallback;
  };

  W.populateSelect = (select, placeholder) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML =
      '<option value="">' + escapeHtml(placeholder) + "</option>" +
      W.allMedia.map((item) =>
        '<option value="' + escapeHtml(item.id) + '">' +
        escapeHtml(item.title || item.filename || item.id) + "</option>"
      ).join("");
    if (W.allMedia.some((item) => String(item.id) === current)) select.value = current;
  };

  W.populateTrackSelect = (select, placeholder) => {
    if (!select) return;
    const current = select.value;
    const tracks = Array.isArray(W.snapshot?.tracks) ? W.snapshot.tracks : [];
    select.innerHTML =
      '<option value="">' + escapeHtml(placeholder) + "</option>" +
      tracks.map((track) =>
        '<option value="' + escapeHtml(track.id) + '">' +
        escapeHtml(track.title || track.id) +
        (track.duration ? " · " + W.formatSeconds(track.duration) : "") +
        "</option>"
      ).join("");
    if (tracks.some((track) => String(track.id) === current)) select.value = current;
  };

  W.populateMediaSelectors = () => {
    W.populateTrackSelect(qs("#v2-audio-track"), "Выберите сохранённый трек…");
  };

  W.mediaResolution = (item) => {
    const meta = item?.meta || {};
    const width = Number(meta.width);
    const height = Number(meta.height);
    return width && height ? width + "×" + height : "—";
  };

  W.mediaPrompt = (item) => {
    const meta = item?.meta || {};
    return String(meta.user_prompt || meta.prompt || "");
  };

  W.gpuJob = (index) => {
    const needles = index === 0
      ? ["rtx3090", "rtx 3090", "3090"]
      : index === 1
        ? ["rtx2080", "rtx 2080", "2080"]
        : ["gpu " + index, "gpu" + index];
    return (W.snapshot?.active_global || []).find((job) => {
      if (job.status !== "running") return false;
      const haystack = [
        job.gpu_backend,
        job.stage,
        job.worker,
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      return needles.some((needle) => haystack.includes(needle));
    });
  };

  W.refreshState = async ({ silent = false, includeMedia = true } = {}) => {
    if (W.refreshing) return W.refreshing;
    W.refreshing = (async () => {
      try {
        const statePromise = fetchJson("/api/v2/state?media_page=1");
        const mediaPromise =
          includeMedia || !W.allMedia.length
            ? fetchJson("/api/editor/media")
            : Promise.resolve({ items: W.allMedia });
        const [stateData, mediaData] = await Promise.all([statePromise, mediaPromise]);
        W.snapshot = stateData;
        W.allMedia = Array.isArray(mediaData.items) ? mediaData.items : W.allMedia;
        W.populateMediaSelectors();
        window.dispatchEvent(new CustomEvent("v2:datarefresh", {
          detail: { snapshot: W.snapshot, media: W.allMedia },
        }));
        return stateData;
      } catch (error) {
        if (!silent) showToast("Не удалось обновить V2: " + error.message, "error");
        return null;
      } finally {
        W.refreshing = null;
      }
    })();
    return W.refreshing;
  };

  W.submitForm = async (url, formData, button) => {
    button?.classList.add("is-loading");
    if (button) button.disabled = true;
    try {
      const result = await fetchJson(url, { method: "POST", body: formData });
      showToast("Задача добавлена в очередь · " + String(result.job_id || "").slice(0, 8));
      await W.refreshState({ silent: true });
      api.setView?.("queue");
      return result;
    } catch (error) {
      showToast("Не удалось запустить: " + error.message, "error");
      return null;
    } finally {
      button?.classList.remove("is-loading");
      if (button) button.disabled = false;
    }
  };

  qsa("[data-v2-setting]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("[data-value]");
      if (!button) return;
      qsa("[data-value]", group).forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      W.updateAudioRange?.();
    });
  });

  window.AIVideoV2Workspaces = W;
})();
