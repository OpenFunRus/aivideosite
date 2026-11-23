(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, fetchJson, showToast, escapeHtml } = api;
  const icon = (name) => '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-' + name + '"></use></svg>';
  const statusLabels = {
    running: "В работе", queued: "В очереди", done: "Готово",
    failed: "Ошибка", cancelled: "Отменено", canceled: "Отменено",
  };

  const jobTitle = (job) => {
    const payload = job.payload || {};
    if (job.kind === "editor_export") return payload.title || "Экспорт видео";
    if (job.kind === "generate") return String(payload.user_prompt || payload.prompt || "MiniMax H3").slice(0, 140);
    return job.kind || "Задача";
  };
  const jobProgress = (job) => job.status === "done"
    ? 100 : Math.max(0, Math.min(100, Number(job.progress) || 0));
  const jobTime = (job) => W.elapsed(
    job.started_at || job.created_at,
    job.finished_at ? new Date(job.finished_at).getTime() / 1000 : W.snapshot?.server_now
  );
  const renderJob = (job) => {
    const status = String(job.status || "queued");
    const progress = jobProgress(job);
    const running = ["queued", "running"].includes(status);
    const actions = [];
    if (running) actions.push('<button class="v2-queue-stop" type="button" data-job-action="cancel">' + icon("x") + 'Остановить</button>');
    if (status === "failed") actions.push('<button type="button" data-job-action="retry">' + icon("refresh") + 'Повторить</button>');
    if (job.result_media_id) actions.push('<button class="v2-queue-result" type="button" data-job-action="open">' + icon("player-play") + 'Результат</button>');
    const subtitle = [job.stage || "H3", job.gpu_backend || ""].filter(Boolean).join(" · ");
    return '<article class="v2-job" data-job-id="' + escapeHtml(job.id) + '" data-status="' + escapeHtml(status) + '">' +
      '<span class="v2-job-icon">' + icon("video") + '</span>' +
      '<div class="v2-job-main"><strong title="' + escapeHtml(jobTitle(job)) + '">' + escapeHtml(jobTitle(job)) + '</strong><small>' + escapeHtml(subtitle) + '</small></div>' +
      '<span class="v2-job-status">' + (status === "done" ? icon("check") : "") + escapeHtml(statusLabels[status] || status) + '</span>' +
      '<div class="v2-job-progress-info"><b>' + progress + '%</b><div class="v2-job-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress + '"><span style="width:' + progress + '%"></span></div></div>' +
      '<span class="v2-job-time">' + icon("clock") + escapeHtml(jobTime(job)) + '</span>' +
      '<div class="v2-job-actions">' + actions.join("") + '</div></article>';
  };

  const renderQueue = () => {
    const gpuRoot = qs("#v2-queue-gpus");
    const jobsRoot = qs("#v2-job-list");
    if (!gpuRoot || !jobsRoot || !W.snapshot) return;
    const gpus = W.snapshot.system?.gpus || [];
    gpuRoot.innerHTML = [0, 1].map((index) => {
      const gpu = gpus.find((item) => Number(item.index) === index);
      const active = W.gpuJob(index);
      const name = gpu?.name || (index === 0 ? "RTX 3090" : "RTX 2080 Ti");
      const util = Math.max(0, Math.min(100, Number(gpu?.utilization) || 0));
      const memory = gpu && Number.isFinite(Number(gpu.memory_total_mb))
        ? (Number(gpu.memory_used_mb || 0) / 1024).toFixed(1) + " / " + (Number(gpu.memory_total_mb) / 1024).toFixed(0) + " GB"
        : "—";
      const footer = active
        ? icon("users") + '<span>Пользователь: <strong>' + escapeHtml(active.user_label || active.owner_id || "—") + '</strong></span>' +
          icon("clock") + '<span>Генерирует: <strong>' + escapeHtml(W.elapsed(active.started_at || active.created_at, W.snapshot.server_now)) + '</strong></span>'
        : icon("clock") + '<span>Ожидает новых задач.</span>';
      return '<article class="v2-queue-gpu' + (active ? " busy" : "") + '">' +
        '<div class="v2-queue-gpu-head"><span class="v2-queue-gpu-icon">' + icon("gpu") + '</span><div class="v2-queue-gpu-name"><h3>' + escapeHtml(name) + '</h3>' +
        '<div class="v2-queue-gpu-metrics">VRAM ' + escapeHtml(memory) + ' <span>·</span> GPU ' + util + '% <span>·</span> ' + escapeHtml(gpu?.temperature == null ? "—" : gpu.temperature + "°C") + '</div></div>' +
        '<span class="v2-queue-gpu-status">' + (active ? "Занята" : "Свободна") + '</span></div>' +
        '<div class="v2-queue-utilization"><span style="width:' + util + '%"></span></div>' +
        '<div class="v2-queue-gpu-job">' + footer + '</div></article>';
    }).join("");

    const jobs = Array.isArray(W.snapshot.jobs) ? W.snapshot.jobs : [];
    const total = jobs.length;
    const empty = qs("#v2-queue-empty");
    const count = qs("#v2-queue-count");
    if (empty) empty.hidden = total > 0;
    if (count) count.textContent = total + " задач";
    jobsRoot.innerHTML = jobs.map(renderJob).join("");
  };

  qs("#v2-queue-refresh")?.addEventListener("click", () => W.refreshState());
  qs("#v2-job-list")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-job-action]");
    if (!button) return;
    const id = button.closest("[data-job-id]")?.dataset.jobId;
    const action = button.dataset.jobAction;
    if (!id) return;
    button.disabled = true;
    try {
      if (action === "cancel") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
      } else if (action === "retry") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST" });
      } else if (action === "open") {
        const job = (W.snapshot?.jobs || []).find((item) => String(item.id) === id);
        const item = W.mediaById(job?.result_media_id);
        if (item) W.openMediaDialog?.(item);
        else showToast("Результат ещё не найден в библиотеке.", "error");
        return;
      }
      await W.refreshState({ silent: true });
    } catch (error) {
      showToast("Действие не выполнено: " + error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener("v2:datarefresh", renderQueue);
})();
