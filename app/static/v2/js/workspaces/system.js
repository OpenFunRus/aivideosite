(() => {
  "use strict";
  const api = window.AIVideoV2;
  const W = window.AIVideoV2Workspaces;
  if (!api || !W) return;
  const { qs, escapeHtml } = api;

  const AUTO_KEY = "aivideosite-" + api.userId + "-v2-system-auto";
  const INTERVAL_KEY = "aivideosite-" + api.userId + "-v2-system-interval";
  const HISTORY_MS = 10 * 60 * 1000;
  const history = [];
  let autoTimer = null;
  let lastRecordedAt = 0;

  const finite = (value) => Number.isFinite(Number(value));
  const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
  const percent = (value, total) => total > 0 ? clamp((Number(value) / Number(total)) * 100) : 0;
  const icon = (name) => '<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#icon-' + name + '"></use></svg>';
  const stateBadge = (online) => '<span class="v2-system-state' + (online ? '' : ' offline') + '">' + (online ? 'ONLINE' : 'OFFLINE') + '</span>';
  const line = (label, value) => '<div class="v2-system-line"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>';
  const tableRow = (label, value) => '<div class="v2-system-table-row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>';
  const ring = (value, label) =>
    '<div class="v2-system-ring" style="--p:' + clamp(value).toFixed(1) + '"><div><strong>' +
    (finite(value) ? Math.round(Number(value)) + '%' : '—') + '</strong><span>' + escapeHtml(label) + '</span></div></div>';

  const cardHead = (title, iconName, online) =>
    '<div class="v2-system-card-head"><div class="v2-system-card-title"><span class="v2-system-card-icon">' +
    icon(iconName) + '</span><h3>' + escapeHtml(title) + '</h3></div>' + stateBadge(online) + '</div>';

  const gpuCard = (gpu) => {
    const online = Boolean(gpu);
    if (!gpu) {
      return '<article class="v2-system-card">' + cardHead('GPU', 'gpu', false) +
        '<div class="v2-system-card-body">' + line('Состояние', 'Нет данных') + '</div></article>';
    }
    const load = clamp(gpu.utilization);
    const vram = percent(gpu.memory_used_mb, gpu.memory_total_mb);
    const active = W.gpuJob(Number(gpu.index));
    const used = (Number(gpu.memory_used_mb || 0) / 1024).toFixed(1);
    const total = (Number(gpu.memory_total_mb || 0) / 1024).toFixed(1);
    return '<article class="v2-system-card">' + cardHead(gpu.name || ('GPU ' + gpu.index), 'gpu', online) +
      '<div class="v2-system-card-body v2-system-gpu-body">' +
      ring(load, 'GPU') +
      '<div class="v2-system-lines">' +
      '<div class="v2-system-vram"><div class="v2-system-vram-head"><span>VRAM</span><strong>' + used + ' / ' + total +
      ' GB</strong></div><div class="v2-system-bar"><span style="width:' + vram.toFixed(1) + '%"></span></div></div>' +
      line('Температура', finite(gpu.temperature) ? gpu.temperature + '°C' : '—') +
      line('Пользователь', active ? (active.user_label || 'Занята') : 'Свободна') +
      '</div></div></article>';
  };

  const llmCard = (assistant) => {
    const online = Boolean(assistant && assistant.online);
    const process = assistant?.llama_alive ? 'Loaded' : assistant?.loading ? 'Loading' : 'Offline';
    return '<article class="v2-system-card">' + cardHead('Local Qwen3-8B', 'brain', online) +
      '<div class="v2-system-card-body v2-system-llm-body">' +
      '<div class="v2-system-llm-badge">' + icon('brain') + '</div>' +
      '<div class="v2-system-table">' +
      tableRow('Цель (TARGET)', assistant?.target || '—') +
      tableRow('Процесс', process) +
      tableRow('Контекст', '32k') +
      tableRow('Резервный GPU', (assistant?.reserved_gpus || []).join(', ') || '—') +
      '</div></div></article>';
  };

  const comfyCard = (sys) => {
    const online = Boolean(sys.comfyui && sys.comfyui_secondary);
    return '<article class="v2-system-card">' + cardHead('ComfyUI', 'stack', online) +
      '<div class="v2-system-card-body v2-system-table">' +
      tableRow('Основной', sys.comfyui ? 'Online' : 'Offline') +
      tableRow('Вторичный', sys.comfyui_secondary ? 'Online' : 'Offline') +
      tableRow('В очереди', W.snapshot?.global_counts?.queued ?? 0) +
      tableRow('В работе', W.snapshot?.global_counts?.running ?? 0) +
      '</div></article>';
  };

  const ramCpuCard = (sys) => {
    const used = finite(sys.ram_total) && finite(sys.ram_available) ? Number(sys.ram_total) - Number(sys.ram_available) : null;
    const ramPct = used !== null ? percent(used, sys.ram_total) : null;
    let cpuPct = finite(sys.cpu_utilization) ? clamp(sys.cpu_utilization) : null;
    if (cpuPct === null && finite(sys.cpu_load_1m) && finite(sys.cpu_count) && Number(sys.cpu_count) > 0) {
      cpuPct = clamp(Number(sys.cpu_load_1m) / Number(sys.cpu_count) * 100);
    }
    const ramStats = '<div class="v2-system-stat-stack"><div><span>Использовано</span><strong>' +
      (used !== null ? W.formatBytes(used) : '—') + '</strong></div><div><span>Всего</span><strong>' +
      W.formatBytes(sys.ram_total) + '</strong></div></div>';
    const cpuStats = '<div class="v2-system-stat-stack"><div><span>Load 1m</span><strong>' +
      (finite(sys.cpu_load_1m) ? sys.cpu_load_1m : '—') + '</strong></div><div><span>Load 5m</span><strong>' +
      (finite(sys.cpu_load_5m) ? sys.cpu_load_5m : '—') + '</strong></div></div>';
    return '<article class="v2-system-card">' + cardHead('RAM / CPU', 'activity', true) +
      '<div class="v2-system-card-body v2-system-dual">' +
      '<div class="v2-system-mini">' + ring(ramPct, 'RAM') + ramStats + '</div>' +
      '<div class="v2-system-mini">' + ring(cpuPct, 'CPU') + cpuStats + '</div>' +
      '</div></article>';
  };

  const diskCard = (sys) => {
    const used = finite(sys.disk_total) && finite(sys.disk_free) ? Number(sys.disk_total) - Number(sys.disk_free) : null;
    const diskPct = used !== null ? percent(used, sys.disk_total) : null;
    return '<article class="v2-system-card">' + cardHead('Диск', 'database', finite(sys.disk_total)) +
      '<div class="v2-system-card-body v2-system-disk-body">' + ring(diskPct, 'Занято') +
      '<div class="v2-system-table">' +
      tableRow('Использовано', used !== null ? W.formatBytes(used) : '—') +
      tableRow('Свободно', W.formatBytes(sys.disk_free)) +
      tableRow('Всего', W.formatBytes(sys.disk_total)) +
      tableRow('Библиотека', W.snapshot?.global_counts?.media ?? 0) +
      '</div></div></article>';
  };

  const currentCpuPercent = (sys) => {
    if (finite(sys.cpu_utilization)) return clamp(sys.cpu_utilization);
    if (finite(sys.cpu_load_1m) && finite(sys.cpu_count) && Number(sys.cpu_count) > 0) {
      return clamp(Number(sys.cpu_load_1m) / Number(sys.cpu_count) * 100);
    }
    return null;
  };

  const recordHistory = () => {
    if (api.state.view !== 'system' || !W.snapshot) return;
    const now = Date.now();
    if (now - lastRecordedAt < 1500) return;
    lastRecordedAt = now;

    const sys = W.snapshot.system || {};
    const gpus = Array.isArray(sys.gpus) ? sys.gpus : [];
    const gpu0 = gpus.find((item) => Number(item.index) === 0);
    const gpu1 = gpus.find((item) => Number(item.index) === 1);
    const ramUsed = finite(sys.ram_total) && finite(sys.ram_available) ? Number(sys.ram_total) - Number(sys.ram_available) : null;
    history.push({
      t: now,
      gpu0: gpu0 && finite(gpu0.utilization) ? clamp(gpu0.utilization) : null,
      gpu1: gpu1 && finite(gpu1.utilization) ? clamp(gpu1.utilization) : null,
      ram: ramUsed !== null ? percent(ramUsed, sys.ram_total) : null,
      cpu: currentCpuPercent(sys),
    });
    while (history.length && history[0].t < now - HISTORY_MS) history.shift();
    while (history.length > 240) history.shift();
  };

  const chartSvg = (series, fillClass = '') => {
    const width = 560, height = 170, left = 40, right = 10, top = 10, bottom = 25;
    const plotW = width - left - right, plotH = height - top - bottom;
    const now = Date.now();
    let grid = '';
    [0,25,50,75,100].forEach((value) => {
      const y = top + plotH - (value / 100) * plotH;
      grid += '<line class="v2-system-chart-grid" x1="' + left + '" y1="' + y + '" x2="' + (width-right) + '" y2="' + y + '"></line>';
      grid += '<text class="v2-system-chart-label" x="0" y="' + (y+3) + '">' + value + '%</text>';
    });
    const labels = [
      [0,'−10 мин'],[.2,'−8 мин'],[.4,'−6 мин'],[.6,'−4 мин'],[.8,'−2 мин'],[1,'сейчас']
    ].map((item) => '<text class="v2-system-chart-label" text-anchor="' + (item[0] === 0 ? 'start' : item[0] === 1 ? 'end' : 'middle') +
      '" x="' + (left + plotW*item[0]) + '" y="' + (height-5) + '">' + item[1] + '</text>').join('');

    const pathFor = (key) => {
      const points = history.filter((item) => finite(item[key])).map((item) => {
        const age = Math.min(HISTORY_MS, Math.max(0, now - item.t));
        const x = left + (1 - age / HISTORY_MS) * plotW;
        const y = top + plotH - clamp(item[key]) / 100 * plotH;
        return [x,y];
      });
      if (!points.length) return { line:'', area:'' };
      if (points.length === 1) points.unshift([Math.max(left, points[0][0]-2), points[0][1]]);
      const linePath = points.map((point,index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ');
      const areaPath = 'M' + points[0][0].toFixed(1) + ' ' + (top+plotH) + ' ' +
        points.map((point) => 'L' + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ') +
        ' L' + points[points.length-1][0].toFixed(1) + ' ' + (top+plotH) + ' Z';
      return { line:linePath, area:areaPath };
    };

    let paths = '';
    series.forEach((item,index) => {
      const data = pathFor(item.key);
      if (!data.line) return;
      if (fillClass && index === 0) paths += '<path class="v2-system-area" d="' + data.area + '"></path>';
      paths += '<path class="v2-system-series ' + item.className + '" d="' + data.line + '"></path>';
    });

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
      grid + paths + labels + '</svg>';
  };

  const renderCharts = () => {
    const gpuRoot = qs('#v2-system-chart-gpu');
    const ramRoot = qs('#v2-system-chart-ram');
    const cpuRoot = qs('#v2-system-chart-cpu');
    if (!gpuRoot || !ramRoot || !cpuRoot) return;
    if (!history.length) {
      const empty = '<div class="v2-system-empty-chart">История появится после первого обновления</div>';
      gpuRoot.innerHTML = ramRoot.innerHTML = cpuRoot.innerHTML = empty;
      return;
    }
    gpuRoot.innerHTML = chartSvg([{key:'gpu0',className:'gpu0'},{key:'gpu1',className:'gpu1'}]);
    ramRoot.innerHTML = chartSvg([{key:'ram',className:'ram'}], 'ram');
    cpuRoot.innerHTML = chartSvg([{key:'cpu',className:'cpu'}], 'cpu');

    const latest = history[history.length-1];
    const sys = W.snapshot?.system || {};
    const ramUsed = finite(sys.ram_total) && finite(sys.ram_available) ? Number(sys.ram_total) - Number(sys.ram_available) : null;
    const ramValue = qs('#v2-system-chart-ram-value');
    const cpuValue = qs('#v2-system-chart-cpu-value');
    if (ramValue) ramValue.textContent = ramUsed !== null ? W.formatBytes(ramUsed) + ' / ' + W.formatBytes(sys.ram_total) + ' (' + Math.round(latest.ram || 0) + '%)' : '—';
    if (cpuValue) cpuValue.textContent = finite(latest.cpu) ? 'Текущая: ' + Math.round(latest.cpu) + '%' : '—';
  };

  const renderSystem = () => {
    const root = qs('#v2-system-grid');
    if (!root || !W.snapshot) return;
    const sys = W.snapshot.system || {};
    const assistant = W.snapshot.assistant || {};
    const gpus = Array.isArray(sys.gpus) ? sys.gpus.slice().sort((a,b) => Number(a.index)-Number(b.index)) : [];
    root.innerHTML =
      gpuCard(gpus[0]) +
      gpuCard(gpus[1]) +
      llmCard(assistant) +
      comfyCard(sys) +
      ramCpuCard(sys) +
      diskCard(sys);
    recordHistory();
    renderCharts();
  };

  const autoEnabled = () => qs('#v2-system-auto')?.checked === true;
  const intervalValue = () => {
    const value = Number(qs('#v2-system-interval')?.value || 5000);
    return [5000,10000,15000,30000].includes(value) ? value : 5000;
  };

  const storeSettings = () => {
    try {
      localStorage.setItem(AUTO_KEY, autoEnabled() ? '1' : '0');
      localStorage.setItem(INTERVAL_KEY, String(intervalValue()));
    } catch {}
  };

  const scheduleAutoRefresh = () => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    if (api.state.view !== 'system' || !autoEnabled()) return;
    autoTimer = setInterval(() => {
      W.refreshState({ silent:true, includeMedia:false });
    }, intervalValue());
  };

  const restoreSettings = () => {
    const auto = qs('#v2-system-auto');
    const interval = qs('#v2-system-interval');
    try {
      const savedAuto = localStorage.getItem(AUTO_KEY);
      const savedInterval = Number(localStorage.getItem(INTERVAL_KEY));
      if (auto && savedAuto !== null) auto.checked = savedAuto !== '0';
      if (interval && [5000,10000,15000,30000].includes(savedInterval)) interval.value = String(savedInterval);
    } catch {}
  };

  qs('#v2-system-refresh')?.addEventListener('click', () => W.refreshState({ silent:false, includeMedia:false }));
  qs('#v2-system-auto')?.addEventListener('change', () => {
    storeSettings();
    scheduleAutoRefresh();
  });
  qs('#v2-system-interval')?.addEventListener('change', () => {
    storeSettings();
    scheduleAutoRefresh();
  });

  window.addEventListener('v2:datarefresh', renderSystem);
  window.addEventListener('v2:viewchange', (event) => {
    if (event.detail?.view === 'system') {
      renderSystem();
      W.refreshState({ silent:true, includeMedia:false });
    }
    scheduleAutoRefresh();
  });

  restoreSettings();
  scheduleAutoRefresh();
})();
