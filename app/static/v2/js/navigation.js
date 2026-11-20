(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { app, state, qs, qsa, saveDraft } = api;

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

  const closeMobileDrawers = () => {
    app.classList.remove("mobile-menu-open", "mobile-characters-open");
    qs("#v2-mobile-menu-button")?.setAttribute("aria-expanded", "false");
    qs("#v2-mobile-character-button")?.setAttribute("aria-expanded", "false");
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
    if (updateHash) history.replaceState(null, "", view === "create" ? "/v2" : "/v2#" + view);
    saveDraft();
    closeMobileDrawers();
    window.dispatchEvent(new CustomEvent("v2:viewchange", { detail: { view } }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  qsa("[data-v2-nav]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.v2Nav));
  });

  const mobileMenuButton = qs("#v2-mobile-menu-button");
  const mobileCharacterButton = qs("#v2-mobile-character-button");
  const mobileBackdrop = qs("#v2-mobile-backdrop");

  mobileMenuButton?.addEventListener("click", () => {
    const opening = !app.classList.contains("mobile-menu-open");
    app.classList.toggle("mobile-menu-open", opening);
    app.classList.remove("mobile-characters-open");
    mobileMenuButton.setAttribute("aria-expanded", opening ? "true" : "false");
    mobileCharacterButton?.setAttribute("aria-expanded", "false");
  });

  mobileCharacterButton?.addEventListener("click", () => {
    const opening = !app.classList.contains("mobile-characters-open");
    app.classList.toggle("mobile-characters-open", opening);
    app.classList.remove("mobile-menu-open");
    mobileCharacterButton.setAttribute("aria-expanded", opening ? "true" : "false");
    mobileMenuButton?.setAttribute("aria-expanded", "false");
  });

  mobileBackdrop?.addEventListener("click", closeMobileDrawers);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeMobileDrawers();
  });

  Object.assign(api, { titleMap, setView, closeMobileDrawers });
})();