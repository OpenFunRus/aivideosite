(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const widget = qs("#assistant-widget");
  if (!widget) return;

  const appShell = qs(".app-shell");
  const userId = appShell?.dataset.userId || "user";
  const HISTORY_KEY = `aivideosite-${userId}-assistant-history-v1`;
  const MODE_KEY = `aivideosite-${userId}-assistant-mode`;

  const panel = qs("#assistant-panel");
  const toggle = qs("#assistant-toggle");
  const closeButton = qs("#assistant-close");
  const clearButton = qs("#assistant-clear");
  const form = qs("#assistant-form");
  const input = qs("#assistant-input");
  const sendButton = qs("#assistant-send");
  const messagesElement = qs("#assistant-messages");
  const statusElement = qs("#assistant-status");
  const modeButtons = qsa("[data-assistant-mode]");

  let mode = localStorage.getItem(MODE_KEY) === "control" ? "control" : "chat";
  let busy = false;
  let history = [];

  const repairMojibake = (value) => {
    const text = String(value ?? "");
    const markers = (text.match(/[ÐÑÃÂ]/g) || []).length;
    if (markers < 2) return text;
    try {
      const bytes = Uint8Array.from([...text], (char) => char.charCodeAt(0) & 0xff);
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const repairedMarkers = (repaired.match(/[ÐÑÃÂ]/g) || []).length;
      return repairedMarkers < markers ? repaired : text;
    } catch {
      return text;
    }
  };

  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (Array.isArray(saved)) {
      history = saved
        .filter(
          (item) =>
            item &&
            ["user", "assistant"].includes(item.role) &&
            typeof item.content === "string"
        )
        .map((item) => ({ ...item, content: repairMojibake(item.content) }))
        .slice(-24);
    }
  } catch {
    history = [];
  }

  const persist = () => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-24)));
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // The assistant continues to work even when browser storage is disabled.
    }
  };

  const scrollToBottom = () => {
    messagesElement.scrollTop = messagesElement.scrollHeight;
  };

  const createMessage = (role, content = "", { temporary = false } = {}) => {
    const row = document.createElement("div");
    row.className = `assistant-message ${role}`;
    if (temporary) row.classList.add("is-temporary");

    const bubble = document.createElement("div");
    bubble.className = "assistant-message-bubble";

    const text = document.createElement("div");
    text.className = "assistant-message-text";
    text.textContent = content;
    bubble.appendChild(text);

    if (role === "assistant" && !temporary) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "assistant-copy";
      copy.textContent = "Копировать";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(text.textContent || "");
          copy.textContent = "Скопировано";
          setTimeout(() => {
            copy.textContent = "Копировать";
          }, 1200);
        } catch {
          copy.textContent = "Ошибка";
        }
      });
      bubble.appendChild(copy);
    }

    row.appendChild(bubble);
    messagesElement.appendChild(row);
    scrollToBottom();
    return { row, text, bubble };
  };

  const renderHistory = () => {
    messagesElement.innerHTML = "";
    if (!history.length) {
      const intro = document.createElement("div");
      intro.className = "assistant-empty";
      intro.innerHTML =
        "<strong>Локальный ИИ</strong><span>Разговор — обычный чат и H3-промты. Управление — меняет настройки генератора по твоей команде.</span>";
      messagesElement.appendChild(intro);
      return;
    }
    history.forEach((item) => createMessage(item.role, item.content));
  };

  const setMode = (nextMode) => {
    mode = nextMode === "control" ? "control" : "chat";
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.assistantMode === mode);
    });
    input.placeholder =
      mode === "control"
        ? "Например: 10 секунд, 24 FPS, 12 шагов, включи звук и сделай промт..."
        : "Напиши сообщение или попроси готовый H3-промт...";
    persist();
  };

  const setOpen = (open) => {
    widget.classList.toggle("open", open);
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      refreshStatus();
      setTimeout(() => input.focus(), 60);
      scrollToBottom();
    }
  };

  const readError = async (response) => {
    try {
      const body = await response.json();
      return body.detail || body.error || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  };

  const currentSettings = () => {
    try {
      return window.AIVideoGenerator?.getSettings?.() || {};
    } catch {
      return {};
    }
  };

  const refreshStatus = async () => {
    try {
      const response = await fetch("/api/assistant/status", {
        cache: "no-store",
        headers: { "X-Requested-With": "AI-Video-Site" },
      });
      if (response.status === 401) {
        location.href = "/login";
        return;
      }
      const data = response.ok ? await response.json() : {};
      statusElement.classList.toggle("online", Boolean(data.online));
      statusElement.classList.toggle("offline", !data.online);
      const target = data.target || "LLM";
      statusElement.textContent = data.online
        ? `${target} · готова`
        : data.loading
          ? `${target} · загрузка`
          : `${target} · недоступна`;
    } catch {
      statusElement.classList.remove("online");
      statusElement.classList.add("offline");
      statusElement.textContent = "LLM · недоступна";
    }
  };

  const appendHistory = (role, content) => {
    history.push({ role, content: String(content || "") });
    history = history.slice(-24);
    persist();
  };

  const runChat = async () => {
    const response = await fetch("/api/assistant/chat", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "AI-Video-Site",
      },
      body: JSON.stringify({
        messages: history,
        settings: currentSettings(),
      }),
    });
    if (response.status === 401) {
      location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error("LLM не вернула поток ответа.");

    const message = createMessage("assistant", "", { temporary: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
        message.text.textContent = content;
        scrollToBottom();
      }
      content += decoder.decode();
    } catch (error) {
      if (!content) throw error;
      content += "\n\n[Соединение с моделью прервано.]";
    }

    message.row.remove();
    const finalContent = content.trim() || "Пустой ответ.";
    createMessage("assistant", finalContent);
    appendHistory("assistant", finalContent);
  };

  const runControl = async () => {
    const waiting = createMessage("assistant", "Применяю настройки…", {
      temporary: true,
    });
    try {
      const response = await fetch("/api/assistant/control", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "AI-Video-Site",
        },
        body: JSON.stringify({
          messages: history,
          settings: currentSettings(),
        }),
      });
      if (response.status === 401) {
        location.href = "/login";
        return;
      }
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      const changes = result.changes && typeof result.changes === "object"
        ? result.changes
        : {};
      const applied = window.AIVideoGenerator?.applyChanges?.(changes) || [];
      let content = String(result.message || "Готово.");
      if (applied.length) {
        content += `\n\nПрименено: ${applied.join(", ")}.`;
      } else if (Object.keys(changes).length) {
        content += "\n\nИзменения получены, но текущая форма не смогла применить их.";
      }
      waiting.row.remove();
      createMessage("assistant", content);
      appendHistory("assistant", content);
    } catch (error) {
      waiting.row.remove();
      throw error;
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const content = input.value.trim();
    if (!content) return;

    busy = true;
    sendButton.disabled = true;
    modeButtons.forEach((button) => {
      button.disabled = true;
    });

    input.value = "";
    createMessage("user", content);
    appendHistory("user", content);

    try {
      if (mode === "control") await runControl();
      else await runChat();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      createMessage("assistant", `Ошибка: ${message}`);
      await refreshStatus();
    } finally {
      busy = false;
      sendButton.disabled = false;
      modeButtons.forEach((button) => {
        button.disabled = false;
      });
      input.focus();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  toggle.addEventListener("click", () => setOpen(!widget.classList.contains("open")));
  closeButton.addEventListener("click", () => setOpen(false));
  clearButton.addEventListener("click", () => {
    history = [];
    persist();
    renderHistory();
  });
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.assistantMode));
  });

  renderHistory();
  setMode(mode);
  setOpen(false);
  refreshStatus();
  setInterval(refreshStatus, 8000);
})();
