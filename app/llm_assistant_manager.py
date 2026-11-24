#!/usr/bin/env python3
from __future__ import annotations
import json, os, signal, subprocess, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LLAMA_BIN=os.getenv("LLM_SERVER_BIN","/opt/ai/llama.cpp/build/bin/llama-server")
MODEL=os.getenv("LLM_MODEL","/opt/ai/models/llm/gemma-4-26B-A4B-it-uncensored-heretic-Q4_K_M.gguf")
HOST=os.getenv("LLM_HOST","127.0.0.1"); PORT=int(os.getenv("LLM_PORT","8090"))
CONTROL_HOST=os.getenv("LLM_CONTROL_HOST","127.0.0.1"); CONTROL_PORT=int(os.getenv("LLM_CONTROL_PORT","8091"))
CTX_SIZE=int(os.getenv("LLM_CTX_SIZE","131072")); THREADS=int(os.getenv("LLM_THREADS","18"))
POLL_SECONDS=float(os.getenv("LLM_GPU_POLL_SECONDS","1.0"))
GPU_TARGETS=(
    {"index":1,"label":"RTX2080","target":"rtx2080","comfy":"http://127.0.0.1:8189"},
    {"index":0,"label":"RTX3090","target":"rtx3090","comfy":"http://127.0.0.1:8188"},
)
GPU_BY_INDEX={int(x["index"]):x for x in GPU_TARGETS}

class ResourceBusy(RuntimeError): pass

def _json_request(url:str,*,method:str="GET",body:dict[str,Any]|None=None,timeout:float=1.5)->Any:
    data=None; headers={}
    if body is not None:
        data=json.dumps(body).encode("utf-8"); headers["Content-Type"]="application/json"
    req=urllib.request.Request(url,data=data,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=timeout) as response:
        payload=response.read()
    return json.loads(payload.decode("utf-8")) if payload else {}

def _comfy_idle(base_url:str)->bool:
    try: q=_json_request(f"{base_url}/queue",timeout=1.2)
    except Exception: return False
    return not q.get("queue_running") and not q.get("queue_pending")

def _free_comfy_memory(base_url:str)->None:
    try:_json_request(f"{base_url}/free",method="POST",body={"unload_models":True,"free_memory":True},timeout=8)
    except Exception:pass

class AssistantManager:
    def __init__(self)->None:
        self.lock=threading.RLock(); self.video_reservations:dict[int,str]={}
        self.assistant_gpu:int|None=None; self.assistant_request_id:str|None=None
        self.process:subprocess.Popen[Any]|None=None; self.target:str|None=None
        self.stop_event=threading.Event()

    def _stop_child(self)->None:
        p=self.process; self.process=None
        if p is None or p.poll() is not None:return
        p.terminate()
        try:p.wait(timeout=12)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait(timeout=5)

    def _start_child(self,gpu:dict[str,Any])->None:
        _free_comfy_memory(str(gpu["comfy"]))
        env=os.environ.copy(); env["CUDA_VISIBLE_DEVICES"]=str(gpu["index"])
        args=[LLAMA_BIN,"--model",MODEL,"--host",HOST,"--port",str(PORT),"--ctx-size",str(CTX_SIZE),
              "--threads",str(THREADS),"--threads-batch",str(THREADS),"--parallel","1","--jinja",
              "--reasoning-format","deepseek","--n-gpu-layers","all"]
        self.target=str(gpu["label"]); print(f"[llm-manager] starting assistant on {self.target}",flush=True)
        p=subprocess.Popen(args,env=env); self.process=p; time.sleep(.25)
        if p.poll() is not None:
            code=p.returncode; self.process=None; self.target=None
            raise RuntimeError(f"llama-server failed to start, exit={code}")

    def _candidate(self)->dict[str,Any]|None:
        for gpu in GPU_TARGETS:
            idx=int(gpu["index"])
            if idx in self.video_reservations:continue
            if not _comfy_idle(str(gpu["comfy"])):continue
            return gpu
        return None

    def reserve_video(self,gpu_index:int,reservation_id:str)->dict[str,Any]:
        if gpu_index not in GPU_BY_INDEX:raise ValueError("Unknown GPU.")
        reservation_id=str(reservation_id or "").strip()
        if not reservation_id:raise ValueError("reservation_id is required.")
        with self.lock:
            current=self.video_reservations.get(gpu_index)
            if current==reservation_id:return self.status()
            if current is not None:raise ResourceBusy("Эта видеокарта уже занята генерацией видео.")
            if self.assistant_gpu==gpu_index:raise ResourceBusy("Эта видеокарта сейчас занята ответом ИИ-ассистента.")
            if not _comfy_idle(str(GPU_BY_INDEX[gpu_index]["comfy"])):raise ResourceBusy("Эта видеокарта занята задачей ComfyUI.")
            self.video_reservations[gpu_index]=reservation_id
            return self.status()

    def release_video(self,gpu_index:int,reservation_id:str)->dict[str,Any]:
        with self.lock:
            current=self.video_reservations.get(gpu_index)
            if current is not None and (not reservation_id or current==str(reservation_id)):
                self.video_reservations.pop(gpu_index,None)
            return self.status()

    def sync_video(self,reservations:list[dict[str,Any]])->dict[str,Any]:
        next_map={}
        for item in reservations:
            try:idx=int(item.get("gpu")); rid=str(item.get("reservation_id") or "").strip()
            except Exception:continue
            if idx in GPU_BY_INDEX and rid:next_map[idx]=rid
        with self.lock:
            if self.process is not None:self._stop_child()
            self.assistant_gpu=None; self.assistant_request_id=None; self.target=None
            self.video_reservations=next_map
            return self.status()

    def acquire_assistant(self,request_id:str)->dict[str,Any]:
        request_id=str(request_id or "").strip()
        if not request_id:raise ValueError("request_id is required.")
        with self.lock:
            if self.assistant_gpu is not None:
                if self.assistant_request_id==request_id:return self.status()
                raise ResourceBusy("ИИ-ассистент уже отвечает на другой запрос.")
            gpu=self._candidate()
            if gpu is None:raise ResourceBusy("Нет свободной видеокарты для ИИ-ассистента: RTX2080 и RTX3090 заняты.")
            self.assistant_gpu=int(gpu["index"]); self.assistant_request_id=request_id
            try:self._start_child(gpu)
            except Exception:
                self.assistant_gpu=None; self.assistant_request_id=None; self.target=None; raise
            return self.status()

    def release_assistant(self,request_id:str)->dict[str,Any]:
        with self.lock:
            if self.assistant_gpu is None:return self.status()
            if request_id and self.assistant_request_id!=str(request_id):return self.status()
            self._stop_child(); self.assistant_gpu=None; self.assistant_request_id=None; self.target=None
            return self.status()

    def status(self)->dict[str,Any]:
        with self.lock:
            p=self.process; alive=p is not None and p.poll() is None
            if p is not None and not alive and self.process is p:
                self.process=None; self.assistant_gpu=None; self.assistant_request_id=None; self.target=None
            slots=[]
            for idx in (0,1):
                gpu=GPU_BY_INDEX[idx]; video_id=self.video_reservations.get(idx); assistant=self.assistant_gpu==idx
                comfy_idle=_comfy_idle(str(gpu["comfy"]))
                if video_id:kind,label="video","Генерация видео"
                elif assistant:kind,label="assistant","ИИ-ассистент отвечает"
                elif not comfy_idle:kind,label="comfy","ComfyUI занят"
                else:kind,label=None,"Свободна"
                slots.append({"gpu":idx,"target":gpu["target"],"label":gpu["label"],"available":kind is None,
                              "busy_kind":kind,"busy_label":label,"video_reservation_id":video_id,
                              "assistant_active":assistant,"comfy_idle":comfy_idle})
            return {"ok":True,"target":self.target,"reserved_gpus":sorted(self.video_reservations),
                    "llama_alive":alive,"assistant_active":self.assistant_gpu is not None,
                    "assistant_gpu":self.assistant_gpu,"assistant_request_id":self.assistant_request_id,
                    "assistant_available":any(x["available"] for x in slots),"slots":slots}

    def monitor(self)->None:
        while not self.stop_event.wait(POLL_SECONDS):
            with self.lock:
                p=self.process
                if self.assistant_gpu is not None and p is not None and p.poll() is not None:
                    self.process=None; self.assistant_gpu=None; self.assistant_request_id=None; self.target=None

    def stop(self)->None:
        self.stop_event.set()
        with self.lock:self._stop_child()

MANAGER=AssistantManager()

class ControlHandler(BaseHTTPRequestHandler):
    server_version="AIVideoLLMManager/2.0"
    def _reply(self,status:int,payload:dict[str,Any])->None:
        data=json.dumps(payload,ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def _body(self)->dict[str,Any]:
        size=int(self.headers.get("Content-Length","0") or 0)
        body=json.loads(self.rfile.read(size).decode("utf-8") or "{}")
        if not isinstance(body,dict):raise ValueError("JSON object required.")
        return body
    def do_GET(self)->None:
        if self.path=="/status":self._reply(200,MANAGER.status()); return
        self._reply(404,{"ok":False,"error":"not found"})
    def do_POST(self)->None:
        try:
            b=self._body()
            if self.path=="/video/reserve":r=MANAGER.reserve_video(int(b["gpu"]),str(b["reservation_id"]))
            elif self.path=="/video/release":r=MANAGER.release_video(int(b["gpu"]),str(b.get("reservation_id") or ""))
            elif self.path=="/video/sync":
                if not isinstance(b.get("reservations"),list):raise ValueError("reservations must be a list.")
                r=MANAGER.sync_video(b["reservations"])
            elif self.path=="/assistant/acquire":r=MANAGER.acquire_assistant(str(b["request_id"]))
            elif self.path=="/assistant/release":r=MANAGER.release_assistant(str(b.get("request_id") or ""))
            else:self._reply(404,{"ok":False,"error":"not found"}); return
            self._reply(200,r)
        except ResourceBusy as exc:self._reply(409,{"ok":False,"error":str(exc)})
        except Exception as exc:self._reply(400,{"ok":False,"error":str(exc)})
    def log_message(self,format:str,*args:Any)->None:return

def main()->None:
    threading.Thread(target=MANAGER.monitor,name="llm-gpu-monitor",daemon=True).start()
    server=ThreadingHTTPServer((CONTROL_HOST,CONTROL_PORT),ControlHandler)
    def shutdown(_s:int,_f:Any)->None:threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,shutdown); signal.signal(signal.SIGINT,shutdown)
    print(f"[llm-manager] control=http://{CONTROL_HOST}:{CONTROL_PORT} chat=http://{HOST}:{PORT} mode=on-demand-gpu-only",flush=True)
    try:server.serve_forever(poll_interval=.5)
    finally:MANAGER.stop(); server.server_close()
if __name__=="__main__":main()
