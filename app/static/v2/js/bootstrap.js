(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;

  api.loadDraft?.();
  api.restoreDraftToUi?.();

  const hashView = location.hash.replace(/^#/, "");
  const storedView = localStorage.getItem(api.keys.view) || "";
  const initialView =
    api.titleMap?.[hashView] ? hashView :
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
    if (["library", "queue", "editor", "system"].includes(view)) {
      W.refreshState({ silent: true });
    }
  });

  setInterval(() => api.refreshSystem?.(), 8000);
  setInterval(() => {
    const view = api.state.view;
    if (view === "queue") {
      W.refreshState({ silent: true, includeMedia: false });
    }
  }, 4000);

  window.addEventListener("beforeunload", () => {
    api.state.uploadUrls.forEach((url) => URL.revokeObjectURL(url));
    api.state.uploadUrls.clear();
    W.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    W.objectUrls.clear();
  });
})();