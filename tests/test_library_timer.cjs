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
  status: "queued",
  created_at: "2026-11-26T12:00:00+00:00",
  started_at: null,
  sampling_started_at: null,
};
assert.equal(W.formatSeconds(W.generationElapsedSeconds(job)), "00:01", "timer must begin immediately when GPU job is submitted");
tickMs += 60_000;
job.status = "running";
job.started_at = "2026-11-26T12:00:30+00:00";
job.sampling_started_at = "2026-11-26T12:00:55+00:00";
assert.equal(W.generationElapsedSeconds(job), 60, "count queue, loading and sampling time with server clock despite browser skew");
assert.equal(W.generationElapsedSeconds({ ...job, started_at: null, sampling_started_at: null }), 60, "timer does not wait for sampler");
assert.equal(W.generationElapsedSeconds({ ...job, kind: undefined }), 60, "Library cards omit kind; still count video jobs");
assert.equal(W.generationElapsedSeconds({ ...job, kind: "editor_export", started_at: null }), 0, "export timer still starts with worker");

tickMs += 30_000;
assert.equal(W.generationElapsedSeconds(job), 90, "the timer continues during the final decode");
assert.equal(W.generationElapsedSeconds({ ...job, status: "completed", finished_at: "2026-11-26T12:01:25+00:00" }), 85, "completed jobs use actual finish time");

console.log("Library generation timer: OK");
