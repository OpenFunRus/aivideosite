"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Simulate a workstation clock 2m23s ahead of the Ubuntu server.
let tickMs = 100;
const serverMs = Date.parse("2026-11-26T12:00:00+00:00");
class WrongBrowserClock extends Date {
  static now() { return serverMs + 143_000 + tickMs; }
}
const browser = { AIVideoV2: {
  qs: () => null, qsa: () => [], fetchJson: () => null,
  showToast: () => {}, escapeHtml: String,
} };
const source = fs.readFileSync(
  path.join(__dirname, "../app/static/v2/js/workspaces/core.js"), "utf8",
);
vm.runInNewContext(source, {
  window: browser,
  Date: WrongBrowserClock,
  performance: { now: () => tickMs },
  localStorage: { getItem: () => null, setItem: () => {} },
}, { filename: "core.js" });

const W = browser.AIVideoV2Workspaces;
W.snapshot = { server_now: serverMs / 1000 };
W.snapshotReceivedAt = tickMs;

const job = {
  kind: "generate",
  status: "running",
  created_at: "2026-11-26T11:50:00+00:00",
  started_at: "2026-11-26T11:57:37+00:00",
  sampling_started_at: "2026-11-26T12:00:00+00:00",
};
assert.equal(W.generationElapsedSeconds(job), 0, "new sampler must show zero");
tickMs += 60_000;
assert.equal(W.generationElapsedSeconds(job), 60, "must use server time despite browser clock skew");
assert.equal(W.generationElapsedSeconds({ ...job, sampling_started_at: null }), 0, "queued/loading time is not render time");

job.test_paused = true;
job.test_paused_at = "2026-11-26T12:00:40+00:00";
assert.equal(W.generationElapsedSeconds(job), 40, "pause freezes elapsed render time");
job.test_paused = false;
job.test_paused_seconds = 20;
tickMs += 30_000;
assert.equal(W.generationElapsedSeconds(job), 70, "time paused is excluded after continuation");

console.log("Library generation timer: OK");
