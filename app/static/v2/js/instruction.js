(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { qs, qsa, copyText, showToast } = api;

  const copyFullChatGptGuide = async (button) => {
    if (button) button.disabled = true;
    try {
      const [siteResponse, h3VideoResponse, h3ImageResponse] = await Promise.all([
        fetch("/static/v2-chatgpt-site-guide.txt", { cache: "no-store" }),
        fetch("/static/h3-prompting-guide-ai.txt", { cache: "no-store" }),
        fetch("/static/h3-image-prompting-guide-ai.txt", { cache: "no-store" }),
      ]);
      if (!siteResponse.ok || !h3VideoResponse.ok || !h3ImageResponse.ok) throw new Error("guide unavailable");
      const siteGuide = await siteResponse.text();
      const h3VideoGuide = await h3VideoResponse.text();
      const h3ImageGuide = await h3ImageResponse.text();
      const combined =
        siteGuide.trim() +
        "\n\n\n=====================================================\n" +
        "FULL CURRENT MINIMAX H3 VIDEO MACHINE GUIDE\n" +
        "=====================================================\n\n" +
        h3VideoGuide.trim() +
        "\n\n\n=====================================================\n" +
        "FULL CURRENT MINIMAX H3 IMAGE GUIDE\n" +
        "=====================================================\n\n" +
        h3ImageGuide.trim() +
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
