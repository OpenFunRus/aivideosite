(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const app = qs(".v2-app");
  if (!app) return;

  const userId = app.dataset.userId || "user";
  const keys = {
    draft: "aivideosite-" + userId + "-v2-draft",
    view: "aivideosite-" + userId + "-v2-view",
    recentCharacters: "aivideosite-" + userId + "-v2-recent-characters",
    assistantUserPrompt: "aivideosite-" + userId + "-v2-assistant-user-prompt",
  };

  const state = {
    view: "create",
    characters: [],
    selectedCharacterIds: new Set(),
    mutedCharacterIds: new Set(),
    recentCharacterIds: [],
    characterTab: "all",
    locations: [],
    selectedLocationIds: new Set(),
    misc: [],
    selectedMiscIds: new Set(),
    presetTab: "characters",
    uploadUrls: new Map(),
    draft: {
      prompt: "",
      quality: "720",
      ratio: "16:9",
      seconds: "10",
      steps: "12",
      seed: "",
      audio: true,
      useTrack: false,
      embedTrack: true,
      sceneSound: false,
      trackId: "",
      audioStart: 0,
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
      } catch {}
    }
    if (!copyFallback(value)) throw new Error("copy failed");
  };

  const getAssistantUserPrompt = () => {
    try {
      return String(localStorage.getItem(keys.assistantUserPrompt) || "").slice(0, 12000);
    } catch {
      return "";
    }
  };

  const setAssistantUserPrompt = (value) => {
    const text = String(value || "").slice(0, 12000);
    try {
      if (text) localStorage.setItem(keys.assistantUserPrompt, text);
      else localStorage.removeItem(keys.assistantUserPrompt);
    } catch {}
    window.dispatchEvent(new CustomEvent("v2:assistant-user-prompt-change", {
      detail: { configured: Boolean(text) },
    }));
    return text;
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
      } catch {}
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
        keys.draft,
        JSON.stringify({
          ...state.draft,
          selectedCharacterIds: Array.from(state.selectedCharacterIds),
          mutedCharacterIds: Array.from(state.mutedCharacterIds || []),
          selectedLocationIds: Array.from(state.selectedLocationIds),
          selectedMiscIds: Array.from(state.selectedMiscIds),
          presetTab: state.presetTab,
        })
      );
      localStorage.setItem(keys.view, state.view);
      localStorage.setItem(
        keys.recentCharacters,
        JSON.stringify(state.recentCharacterIds.slice(0, 30))
      );
    } catch {}
  };

  const loadDraft = () => {
    const saved = readStoredJson(keys.draft, {});
    if (saved && typeof saved === "object") {
      ["prompt", "quality", "ratio", "seconds", "steps", "seed", "trackId"].forEach((key) => {
        if (saved[key] !== undefined && saved[key] !== null) state.draft[key] = String(saved[key]);
      });
      if (typeof saved.audio === "boolean") state.draft.audio = saved.audio;
      if (typeof saved.useTrack === "boolean") state.draft.useTrack = saved.useTrack;
      if (typeof saved.embedTrack === "boolean") state.draft.embedTrack = saved.embedTrack;
      if (typeof saved.sceneSound === "boolean") state.draft.sceneSound = saved.sceneSound;
      if (Number.isFinite(Number(saved.audioStart))) state.draft.audioStart = Math.max(0, Number(saved.audioStart));
      if (["characters", "locations", "misc"].includes(saved.presetTab)) state.presetTab = saved.presetTab;
      if (Array.isArray(saved.selectedCharacterIds)) {
        state.selectedCharacterIds = new Set(saved.selectedCharacterIds.map(String));
      }
      if (Array.isArray(saved.mutedCharacterIds)) {
        state.mutedCharacterIds = new Set(saved.mutedCharacterIds.map(String));
      }
      if (Array.isArray(saved.selectedLocationIds)) {
        state.selectedLocationIds = new Set(saved.selectedLocationIds.map(String));
      }
      if (Array.isArray(saved.selectedMiscIds)) {
        state.selectedMiscIds = new Set(saved.selectedMiscIds.map(String));
      }
    }
    const recent = readStoredJson(keys.recentCharacters, []);
    if (Array.isArray(recent)) state.recentCharacterIds = recent.map(String).slice(0, 30);
  };

  // Hydrate persisted state before any later V2 module can render or save defaults.
  // bootstrap.js calls loadDraft again harmlessly, but dependent modules must see the
  // stored draft during their own initialization.
  loadDraft();

  window.AIVideoV2 = {
    app,
    userId,
    keys,
    state,
    qs,
    qsa,
    fetchJson,
    showToast,
    escapeHtml,
    copyText,
    getAssistantUserPrompt,
    setAssistantUserPrompt,
    readStoredJson,
    saveDraft,
    loadDraft,
  };
})();