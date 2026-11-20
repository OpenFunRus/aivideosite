#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LLAMA_BIN = os.getenv("LLM_SERVER_BIN", "/opt/ai/llama.cpp/build/bin/llama-server")
MODEL = os.getenv(
    "LLM_MODEL",
    "/opt/ai/models/llm/Qwen3-8B-abliterated-Q4_K_M.gguf",
)
HOST = os.getenv("LLM_HOST", "127.0.0.1")
PORT = int(os.getenv("LLM_PORT", "8090"))
CONTROL_HOST = os.getenv("LLM_CONTROL_HOST", "127.0.0.1")
CONTROL_PORT = int(os.getenv("LLM_CONTROL_PORT", "8091"))
CTX_SIZE = int(os.getenv("LLM_CTX_SIZE", "32768"))
THREADS = int(os.getenv("LLM_THREADS", "18"))
POLL_SECONDS = float(os.getenv("LLM_GPU_POLL_SECONDS", "2.0"))

# Prefer the secondary GPU for chat so the first H3 job can use RTX3090.
GPU_TARGETS = (
    {"index": 1, "label": "RTX2080", "comfy": "http://127.0.0.1:8189"},
    {"index": 0, "label": "RTX3090", "comfy": "http://127.0.0.1:8188"},
)


def _json_request(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 1.5,
) -> Any:
    data = None
    headers: dict[str, str] = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return json.loads(payload.decode("utf-8")) if payload else {}


def _comfy_idle(base_url: str) -> bool:
    try:
        queue = _json_request(f"{base_url}/queue", timeout=1.2)
    except Exception:
        return False
    return not queue.get("queue_running") and not queue.get("queue_pending")


def _free_comfy_memory(base_url: str) -> None:
    try:
        _json_request(
            f"{base_url}/free",
            method="POST",
            body={"unload_models": True, "free_memory": True},
            timeout=5.0,
        )
    except Exception:
        # ComfyUI may not expose /free on every build. Loading can still proceed.
        pass


class AssistantManager:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.reserved: set[int] = set()
        self.process: subprocess.Popen[Any] | None = None
        self.target: str | None = None
        self.stop_event = threading.Event()

    def _choose_target(self) -> dict[str, Any] | None:
        for gpu in GPU_TARGETS:
            if int(gpu["index"]) in self.reserved:
                continue
            if _comfy_idle(str(gpu["comfy"])):
                return gpu
        return None

    def _stop_child(self) -> None:
        process = self.process
        self.process = None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _start_child(self, gpu: dict[str, Any] | None) -> None:
        env = os.environ.copy()
        args = [
            LLAMA_BIN,
            "--model",
            MODEL,
            "--host",
            HOST,
            "--port",
            str(PORT),
            "--ctx-size",
            str(CTX_SIZE),
            "--threads",
            str(THREADS),
            "--threads-batch",
            str(THREADS),
            "--parallel",
            "1",
            "--jinja",
        ]

        if gpu is None:
            env["CUDA_VISIBLE_DEVICES"] = ""
            args += ["--n-gpu-layers", "0"]
            target = "CPU"
        else:
            _free_comfy_memory(str(gpu["comfy"]))
            env["CUDA_VISIBLE_DEVICES"] = str(gpu["index"])
            args += ["--n-gpu-layers", "all"]
            target = str(gpu["label"])

        print(f"[llm-manager] starting assistant on {target}", flush=True)
        process = subprocess.Popen(args, env=env)
        self.process = process
        self.target = target

        # Catch immediate startup failures (most commonly: port 8090 is
        # already occupied by an old/manual llama-server) before reporting
        # the child as alive to the control API.
        time.sleep(0.25)
        return_code = process.poll()
        if return_code is not None:
            print(
                f"[llm-manager] assistant failed to start on {target}, "
                f"exit={return_code}",
                flush=True,
            )
            if self.process is process:
                self.process = None

    def reconcile(self, *, force: bool = False) -> None:
        with self.lock:
            gpu = self._choose_target()
            desired = str(gpu["label"]) if gpu is not None else "CPU"
            alive = self.process is not None and self.process.poll() is None
            if not force and alive and self.target == desired:
                return
            if alive:
                print(
                    f"[llm-manager] moving assistant {self.target} -> {desired}",
                    flush=True,
                )
            self._stop_child()
            if self.stop_event.is_set():
                return
            self._start_child(gpu)

    def reserve(self, gpu_index: int) -> dict[str, Any]:
        with self.lock:
            self.reserved.add(gpu_index)
        # Synchronous: do not return until llama-server has left this GPU.
        self.reconcile()
        return self.status()

    def release(self, gpu_index: int) -> dict[str, Any]:
        with self.lock:
            self.reserved.discard(gpu_index)
        self.reconcile()
        return self.status()

    def status(self) -> dict[str, Any]:
        with self.lock:
            process = self.process
            alive = process is not None and process.poll() is None
            if process is not None and not alive and self.process is process:
                self.process = None
            return {
                "ok": True,
                "target": self.target,
                "reserved_gpus": sorted(self.reserved),
                "llama_alive": alive,
                "llama_port": PORT,
            }

    def monitor(self) -> None:
        while not self.stop_event.wait(POLL_SECONDS):
            try:
                self.reconcile()
            except Exception as exc:
                print(f"[llm-manager] reconcile error: {exc}", flush=True)

    def stop(self) -> None:
        self.stop_event.set()
        with self.lock:
            self._stop_child()


MANAGER = AssistantManager()


class ControlHandler(BaseHTTPRequestHandler):
    server_version = "AIVideoLLMManager/1.0"

    def _reply(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/status":
            self._reply(200, MANAGER.status())
            return
        self._reply(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path not in {"/reserve", "/release"}:
            self._reply(404, {"ok": False, "error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0") or 0)
            body = json.loads(self.rfile.read(size).decode("utf-8") or "{}")
            gpu = int(body["gpu"])
            if gpu not in {0, 1}:
                raise ValueError("gpu must be 0 or 1")
            result = MANAGER.reserve(gpu) if self.path == "/reserve" else MANAGER.release(gpu)
            self._reply(200, result)
        except Exception as exc:
            self._reply(400, {"ok": False, "error": str(exc)})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    MANAGER.reconcile(force=True)
    monitor = threading.Thread(target=MANAGER.monitor, name="llm-gpu-monitor", daemon=True)
    monitor.start()

    server = ThreadingHTTPServer((CONTROL_HOST, CONTROL_PORT), ControlHandler)

    def shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(
        f"[llm-manager] control=http://{CONTROL_HOST}:{CONTROL_PORT} "
        f"chat=http://{HOST}:{PORT}",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        MANAGER.stop()
        server.server_close()


if __name__ == "__main__":
    main()
