(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, escapeHtml } = api;

  const systemCard = (title, online, metrics, extra = "") =>
    '<article class="v2-system-card">' +
    '<div class="v2-system-card-head"><h3>' + escapeHtml(title) +
    '</h3><span class="v2-system-state' + (online ? "" : " offline") + '">' +
    (online ? "ONLINE" : "OFFLINE") + "</span></div>" +
    '<div class="v2-system-metrics">' +
    metrics.map(([label, value]) =>
      '<div class="v2-system-metric"><span>' + escapeHtml(label) +
      '</span><strong>' + escapeHtml(value) + "</strong></div>"
    ).join("") +
    "</div>" +
    (extra ? '<div class="v2-system-users">' + escapeHtml(extra) + "</div>" : "") +
    "</article>";

  const renderSystem = () => {
    const root = qs("#v2-system-grid");
    if (!root || !W.snapshot) return;

    const sys = W.snapshot.system || {};
    const assistant = W.snapshot.assistant || {};
    const gpus = sys.gpus || [];
    const cards = [];

    gpus.forEach((gpu) => {
      const active = W.gpuJob(Number(gpu.index));
      cards.push(systemCard(
        gpu.name || "GPU " + gpu.index,
        true,
        [
          ["VRAM", (gpu.memory_used_mb / 1024).toFixed(1) + " / " + (gpu.memory_total_mb / 1024).toFixed(1) + " GB"],
          ["Load", gpu.utilization + "%"],
          ["Temp", gpu.temperature + "°C"],
          ["User", active ? active.user_label : "Свободна"],
        ],
        active ? (active.prompt || active.stage || "") : ""
      ));
    });

    cards.push(systemCard(
      "Local Qwen3-8B",
      Boolean(assistant.online),
      [
        ["Target", assistant.target || "—"],
        ["Process", assistant.llama_alive ? "Loaded" : assistant.loading ? "Loading" : "Offline"],
        ["Context", "32k"],
        ["Reserved GPU", (assistant.reserved_gpus || []).join(", ") || "—"],
      ]
    ));

    cards.push(systemCard(
      "ComfyUI",
      Boolean(sys.comfyui && sys.comfyui_secondary),
      [
        ["Primary", sys.comfyui ? "Online" : "Offline"],
        ["Secondary", sys.comfyui_secondary ? "Online" : "Offline"],
        ["Queued", W.snapshot.global_counts?.queued ?? 0],
        ["Running", W.snapshot.global_counts?.running ?? 0],
      ]
    ));

    cards.push(systemCard(
      "RAM / CPU",
      true,
      [
        ["RAM used", sys.ram_total && sys.ram_available ? W.formatBytes(sys.ram_total - sys.ram_available) : "—"],
        ["RAM total", W.formatBytes(sys.ram_total)],
        ["Load 1m", sys.cpu_load_1m ?? "—"],
        ["Load 5m", sys.cpu_load_5m ?? "—"],
      ]
    ));

    cards.push(systemCard(
      "Disk",
      true,
      [
        ["Used", sys.disk_total ? W.formatBytes(sys.disk_total - sys.disk_free) : "—"],
        ["Free", W.formatBytes(sys.disk_free)],
        ["Total", W.formatBytes(sys.disk_total)],
        ["Library", W.snapshot.global_counts?.media ?? 0],
      ]
    ));

    root.innerHTML = cards.join("");
  };

  qs("#v2-system-refresh")?.addEventListener("click", () => W.refreshState());
  window.addEventListener("v2:datarefresh", renderSystem);
})();