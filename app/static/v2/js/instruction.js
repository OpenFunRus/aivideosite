(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { qs, qsa, copyText, showToast } = api;

  const copyFullChatGptGuide = async (button) => {
    if (button) button.disabled = true;
    try {
      const [siteResponse, h3Response] = await Promise.all([
        fetch("/static/v2-chatgpt-site-guide.txt", { cache: "no-store" }),
        fetch("/static/h3-prompting-guide-ai.txt", { cache: "no-store" }),
      ]);
      if (!siteResponse.ok || !h3Response.ok) throw new Error("guide unavailable");
      const siteGuide = await siteResponse.text();
      const h3Guide = await h3Response.text();
      const combined =
        siteGuide.trim() +
        "\n\n\n=====================================================\n" +
        "FULL CURRENT MINIMAX H3 VIDEO MACHINE GUIDE\n" +
        "=====================================================\n\n" +
        h3Guide.trim() +
        "\n";
      await copyText(combined);
      showToast("Полная инструкция для ChatGPT скопирована.");
    } catch {
      showToast("Не удалось скопировать инструкцию.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  };

  ["#v2-copy-chatgpt", "#v2-copy-chatgpt-bottom"].forEach((selector) => {
    const button = qs(selector);
    button?.addEventListener("click", () => copyFullChatGptGuide(button));
  });

  qsa("[data-guide-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = qs("#" + button.dataset.guideCopy);
      if (!target) return;
      try {
        await copyText(target.textContent || "");
        showToast("Пример промпта скопирован.");
      } catch {
        showToast("Не удалось скопировать пример.", "error");
      }
    });
  });
})();
