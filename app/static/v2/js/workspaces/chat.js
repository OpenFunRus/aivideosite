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
    .map((item) => ({
      role: item.role,
      content: String(item.content),
      created_at: Number.isFinite(Number(item.created_at)) ? Number(item.created_at) : null,
    }))
    .slice(-400);

  const save = () => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    } catch {}
  };

  const modelMessages = () => messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const formatTime = (value) => {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    return new Date(timestamp).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const makeIcon = (symbol) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/static/icons.svg#" + symbol);
    svg.appendChild(use);
    return svg;
  };

  const makeAvatar = (role) => {
    const avatar = document.createElement("div");
    avatar.className = "v2-chat-avatar " + role;
    avatar.appendChild(makeIcon(role === "user" ? "icon-users" : "icon-player-play"));
    return avatar;
  };

  const makeMessageRow = (message, options = {}) => {
    const row = document.createElement("div");
    row.className = "v2-chat-row " + message.role + (options.pending ? " pending" : "");

    const bubble = document.createElement("div");
    bubble.className = "v2-chat-bubble";

    const content = document.createElement("div");
    content.className = "v2-chat-content";
    content.textContent = message.content || (options.pending ? "…" : "");
    bubble.appendChild(content);

    const timeText = formatTime(message.created_at);
    if (timeText) {
      const time = document.createElement("span");
      time.className = "v2-chat-time";
      time.textContent = timeText;
      bubble.appendChild(time);
    }

    const avatar = makeAvatar(message.role);
    if (message.role === "user") {
      row.appendChild(bubble);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(bubble);
    }

    return { row, content };
  };

  const appendReadyState = (root) => {
    const last = messages[messages.length - 1];
    if (busy || !last || last.role !== "assistant") return;

    const row = document.createElement("div");
    row.className = "v2-chat-ready";
    row.appendChild(makeAvatar("assistant"));

    const pill = document.createElement("div");
    pill.className = "v2-chat-ready-pill";

    const check = document.createElement("span");
    check.className = "v2-chat-ready-check";
    check.appendChild(makeIcon("icon-check"));
    pill.appendChild(check);

    const label = document.createElement("span");
    label.textContent = "Готов ответить.";
    pill.appendChild(label);

    const timeText = formatTime(last.created_at);
    if (timeText) {
      const time = document.createElement("span");
      time.className = "v2-chat-ready-time";
      time.textContent = timeText;
      pill.appendChild(time);
    }

    row.appendChild(pill);
    root.appendChild(row);
  };

  const render = () => {
    const root = qs("#v2-chat-messages");
    if (!root) return;
    root.innerHTML = "";
    messages.forEach((message) => {
      root.appendChild(makeMessageRow(message).row);
    });
    appendReadyState(root);
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
          messages: modelMessages(),
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
    const submit = qs("#v2-chat-form button[type='submit']");
    const text = input?.value.trim();
    if (!text || busy) return;

    busy = true;
    if (submit) submit.disabled = true;
    input.value = "";
    messages.push({ role: "user", content: text, created_at: Date.now() });
    save();
    render();

    const root = qs("#v2-chat-messages");
    const pending = makeMessageRow(
      { role: "assistant", content: "", created_at: null },
      { pending: true }
    );
    root?.appendChild(pending.row);
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
          messages: modelMessages(),
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
      pending.row.classList.remove("pending");
      pending.content.textContent = "";
      if (!reader) throw new Error("Streaming response недоступен.");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        pending.content.textContent = answer;
        if (root) root.scrollTop = root.scrollHeight;
      }
      answer += decoder.decode();
      answer = answer.trim();

      if (answer) {
        messages.push({ role: "assistant", content: answer, created_at: Date.now() });
        save();
      } else {
        pending.content.textContent = "Пустой ответ.";
      }
    } catch (error) {
      pending.row.classList.remove("pending");
      pending.content.textContent = "Ошибка: " + error.message;
      showToast("Чат: " + error.message, "error");
    } finally {
      busy = false;
      if (submit) submit.disabled = false;
      if (answer) render();
      await updateContext();
    }
  };

  qs("#v2-chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  qs("#v2-chat-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
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
