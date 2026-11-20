(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { qs, fetchJson, showToast } = api;

  const CHAT_KEY = "aivideosite-" + api.userId + "-v2-chat";
  let messages = api.readStoredJson(CHAT_KEY, []);
  let busy = false;

  if (!Array.isArray(messages)) messages = [];
  messages = messages
    .filter((item) => item && ["user", "assistant"].includes(item.role) && item.content)
    .slice(-400);

  const save = () => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    } catch {}
  };

  const render = () => {
    const root = qs("#v2-chat-messages");
    if (!root) return;
    root.innerHTML = "";
    messages.forEach((message) => {
      const div = document.createElement("div");
      div.className = "v2-chat-message " + message.role;
      div.textContent = message.content;
      root.appendChild(div);
    });
    root.scrollTop = root.scrollHeight;
  };

  const updateContext = async () => {
    const label = qs("#v2-chat-context-label");
    const fill = qs("#v2-chat-context-fill");
    const note = qs("#v2-chat-context-note");
    if (!label || !fill || !note) return;

    try {
      const usage = await fetchJson("/api/assistant/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          thinking: Boolean(qs("#v2-chat-thinking")?.checked),
        }),
      });
      const used = Number(usage.estimated_tokens || 0);
      const limit = Number(usage.context_limit || 32768);
      label.textContent = (used / 1000).toFixed(1) + "k / " + Math.round(limit / 1000) + "k";
      fill.style.width = Math.min(100, (used / limit) * 100) + "%";
      note.textContent = usage.dropped_messages
        ? "Старых сообщений не отправлено модели: " + usage.dropped_messages
        : "В активный контекст помещается вся текущая история";
    } catch {
      label.textContent = "— / 32k";
      note.textContent = "Не удалось посчитать контекст";
    }
  };

  const send = async () => {
    const input = qs("#v2-chat-input");
    const text = input?.value.trim();
    if (!text || busy) return;

    busy = true;
    input.value = "";
    messages.push({ role: "user", content: text });
    save();
    render();

    const root = qs("#v2-chat-messages");
    const bubble = document.createElement("div");
    bubble.className = "v2-chat-message assistant pending";
    bubble.textContent = "…";
    root?.appendChild(bubble);
    if (root) root.scrollTop = root.scrollHeight;

    let answer = "";
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "AI-Video-Site-V2",
        },
        body: JSON.stringify({
          messages,
          thinking: Boolean(qs("#v2-chat-thinking")?.checked),
        }),
      });

      if (!response.ok) {
        let detail = "HTTP " + response.status;
        try {
          const body = await response.json();
          detail = body.detail || detail;
        } catch {}
        throw new Error(detail);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      bubble.classList.remove("pending");
      bubble.textContent = "";
      if (!reader) throw new Error("Streaming response недоступен.");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        bubble.textContent = answer;
        if (root) root.scrollTop = root.scrollHeight;
      }
      answer += decoder.decode();
      answer = answer.trim();
      if (answer) messages.push({ role: "assistant", content: answer });
      else bubble.textContent = "Пустой ответ.";
      save();
    } catch (error) {
      bubble.classList.remove("pending");
      bubble.textContent = "Ошибка: " + error.message;
      showToast("Чат: " + error.message, "error");
    } finally {
      busy = false;
      await updateContext();
    }
  };

  qs("#v2-chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  qs("#v2-chat-clear")?.addEventListener("click", () => {
    if (messages.length && !confirm("Очистить этот локальный чат?")) return;
    messages = [];
    save();
    render();
    updateContext();
  });

  qs("#v2-chat-thinking")?.addEventListener("change", updateContext);

  window.addEventListener("v2:viewchange", (event) => {
    if (event.detail?.view === "chat") {
      render();
      updateContext();
    }
  });

  render();
})();