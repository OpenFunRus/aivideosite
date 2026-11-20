(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, fetchJson, showToast, escapeHtml } = api;

  const jobTitle = (job) => {
    const payload = job.payload || {};
    if (job.kind === "editor_export") return payload.title || "Монтаж";
    if (job.kind === "generate") {
      return String(payload.user_prompt || payload.prompt || "MiniMax H3").slice(0, 140);
    }
    return job.kind || "Задача";
  };

  const renderJob = (job) => {
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const running = job.status === "running";
    const time = running
      ? W.elapsed(job.started_at, W.snapshot?.server_now)
      : W.elapsed(
          job.started_at || job.created_at,
          job.finished_at ? new Date(job.finished_at).getTime() / 1000 : W.snapshot?.server_now
        );

    let actions = "";
    if (["queued", "running"].includes(job.status)) {
      actions += '<button type="button" data-job-action="cancel">Стоп</button>';
    }
    if (job.status === "failed") {
      actions += '<button type="button" data-job-action="retry">Retry</button>';
    }
    if (!["queued", "running"].includes(job.status)) {
      actions += '<button type="button" data-job-action="delete">Удалить</button>';
    }
    if (job.result_media_id) {
      actions += '<button type="button" data-job-action="open">Результат</button>';
    }

    return (
      '<article class="v2-job" data-job-id="' + escapeHtml(job.id) +
      '" data-status="' + escapeHtml(job.status) + '">' +
      '<div class="v2-job-status"><i></i><span>' + escapeHtml(job.status) + "</span></div>" +
      '<div class="v2-job-main"><strong>' + escapeHtml(jobTitle(job)) +
      '</strong><small>' + escapeHtml(job.stage || "") +
      '</small><div class="v2-job-progress"><span style="width:' + progress + '%"></span></div></div>' +
      '<div class="v2-job-time">' + escapeHtml(time) + "</div>" +
      '<div class="v2-job-actions">' + actions + "</div></article>"
    );
  };

  const renderQueue = () => {
    const gpuRoot = qs("#v2-queue-gpus");
    const jobsRoot = qs("#v2-job-list");
    if (!gpuRoot || !jobsRoot || !W.snapshot) return;

    const gpus = W.snapshot.system?.gpus || [];
    gpuRoot.innerHTML = [0, 1].map((index) => {
      const gpu = gpus.find((item) => Number(item.index) === index);
      const active = W.gpuJob(index);
      const name = gpu?.name || (index === 0 ? "RTX3090" : "RTX2080");
      return (
        '<article class="v2-queue-gpu' + (active ? " busy" : "") + '">' +
        '<div class="v2-queue-gpu-head"><h3>' + escapeHtml(name) +
        '</h3><span class="v2-queue-gpu-status">' + (active ? "Занята" : "Свободна") + "</span></div>" +
        '<div class="v2-queue-gpu-metrics"><span>VRAM ' +
        escapeHtml(gpu ? (gpu.memory_used_mb / 1024).toFixed(1) + "/" + (gpu.memory_total_mb / 1024).toFixed(0) + "GB" : "—") +
        "</span><span>GPU " + escapeHtml(gpu ? gpu.utilization + "%" : "—") +
        "</span><span>" + escapeHtml(gpu ? gpu.temperature + "°C" : "—") + "</span></div>" +
        (active
          ? '<div class="v2-queue-gpu-job"><strong>' +
            escapeHtml(active.user_label || active.owner_id) +
            "</strong><br>" +
            escapeHtml(active.prompt || active.stage || "H3 generation") +
            "</div>"
          : '<div class="v2-queue-gpu-job">Готова принять следующую H3-задачу.</div>') +
        "</article>"
      );
    }).join("");

    const jobs = Array.isArray(W.snapshot.jobs) ? W.snapshot.jobs : [];
    const empty = qs("#v2-queue-empty");
    if (empty) empty.hidden = jobs.length > 0;
    jobsRoot.innerHTML = jobs.map(renderJob).join("");
  };

  qs("#v2-queue-refresh")?.addEventListener("click", () => W.refreshState());

  qs("#v2-job-list")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-job-action]");
    if (!button) return;
    const row = button.closest("[data-job-id]");
    const id = row?.dataset.jobId;
    const action = button.dataset.jobAction;
    if (!id) return;

    button.disabled = true;
    try {
      if (action === "cancel") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
      } else if (action === "retry") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST" });
      } else if (action === "delete") {
        await fetchJson("/api/jobs/" + encodeURIComponent(id), { method: "DELETE" });
      } else if (action === "open") {
        const job = (W.snapshot?.jobs || []).find((item) => String(item.id) === id);
        const item = W.mediaById(job?.result_media_id);
        if (item) W.openMediaDialog?.(item);
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