(() => {
  "use strict";
  const api = window.AIVideoV2;
  if (!api) return;
  const { qs, fetchJson, escapeHtml } = api;

  const compactGpuName = (gpu) => {
    const raw = String(gpu?.name || "");
    const match = raw.match(/RTX\s*\d+(?:\s*Ti)?/i);
    return match ? match[0].replace(/RTX\s*/i, "RTX ") : "GPU " + (gpu?.index ?? "");
  };
  const formatVramPart = (valueMb, digits = 1) => {
    const value = Number(valueMb);
    if (!Number.isFinite(value)) return "—";
    return (value / 1024).toFixed(digits);
  };
  const renderGpu = (element, gpu, fallback) => {
    if (!element) return;
    if (!gpu) {
      element.innerHTML =
        '<span class="status-dot"></span><span class="v2-gpu-model">' +
        escapeHtml(fallback) +
        "</span>";
      element.classList.remove("online");
      return;
    }
    const used = formatVramPart(gpu.memory_used_mb, 1);
    const total = formatVramPart(gpu.memory_total_mb, 0);
    const utilization = Number.isFinite(Number(gpu.utilization)) ? Number(gpu.utilization) : 0;
    element.innerHTML =
      '<span class="status-dot"></span>' +
      '<span class="v2-gpu-model">' + escapeHtml(compactGpuName(gpu)) + "</span>" +
      '<span class="v2-gpu-separator"></span>' +
      '<span class="v2-gpu-metric"><span>VRAM</span><b>' + used + " / " + total + " GB</b></span>" +
      '<span class="v2-gpu-separator"></span>' +
      '<span class="v2-gpu-load">LOAD <b>' + utilization + "%</b></span>";
    element.classList.add("online");
  };

  const refreshSystem = async () => {
    try {
      const data = await fetchJson("/api/state?media_page=1&jobs_page=1");
      const gpus = Array.isArray(data?.system?.gpus) ? data.system.gpus : [];
      renderGpu(qs("#v2-gpu-0"), gpus.find((item) => Number(item.index) === 0), "GPU 0 · нет данных");
      renderGpu(qs("#v2-gpu-1"), gpus.find((item) => Number(item.index) === 1), "GPU 1 · нет данных");
    } catch {
      renderGpu(qs("#v2-gpu-0"), null, "GPU 0 · недоступна");
      renderGpu(qs("#v2-gpu-1"), null, "GPU 1 · недоступна");
    }
  };

  api.refreshSystem = refreshSystem;
})();