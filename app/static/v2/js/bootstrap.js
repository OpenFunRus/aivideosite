(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;

  api.restoreDraftToUi?.();
  W.restoreAudioMode?.();

  const hashView = location.hash.replace(/^#/, "");
  const storedView = localStorage.getItem(api.keys.view) || "";
  const initialView =
    hashView === "queue" ? "library" :
    api.titleMap?.[hashView] ? hashView :
    storedView === "queue" ? "library" :
    api.titleMap?.[storedView] ? storedView :
    "create";

  api.setView?.(initialView, { updateHash: false });
  api.refreshCharacters?.();
  api.refreshLocations?.();
  api.refreshMisc?.();
  api.refreshSystem?.();
  W.refreshState({ silent: true });

  window.addEventListener("v2:viewchange", (event) => {
    const view = event.detail?.view || "create";
    if (["library", "editor", "system"].includes(view)) {
      W.refreshState({ silent: true });
    }
  });

  setInterval(() => api.refreshSystem?.(), 8000);
  setInterval(() => {
    const view = api.state.view;
    if (view === "library") {
      W.refreshState({ silent: true, includeMedia: true });
    }
  }, 4000);

  window.addEventListener("beforeunload", () => {
    api.state.uploadUrls.forEach((url) => URL.revokeObjectURL(url));
    api.state.uploadUrls.clear();
    W.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    W.objectUrls.clear();
  });
})();
