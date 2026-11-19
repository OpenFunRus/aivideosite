# AI Video Site — полный handoff / инфраструктура / текущий статус

> Этот файл предназначен для быстрого продолжения работы в новом чате без повторного восстановления контекста.
>
> Репозиторий: `OpenFunRus/aivideosite`
>
> Основная ветка: `main`
>
> Кодовый checkpoint перед созданием этого handoff: `61136873957931a3099b55731b92d59b4ec7f23a`
>
> После чтения этого файла новый исполнитель ОБЯЗАН сначала перечитать актуальный `main` на GitHub, потому что код мог измениться после обновления документа.

---

## 1. Цель проекта

`aivideosite` — локальная веб-панель для AI-видео на одной Ubuntu VM с RTX 3090 24 GB.

Основные задачи:

1. Генерировать видео через MiniMax H3 в ComfyUI.
2. Поддерживать T2V / I2V / First+Last Frame.
3. Хранить очередь и библиотеку независимо от браузера.
4. Позволять закрыть сайт, вернуться позже и увидеть результат.
5. Делать LipSync через LatentSync.
6. Делать простые операции со звуком через FFmpeg.
7. В перспективе добавить отдельный audio-driven генератор Wan2.2 S2V:
   - reference image;
   - audio/vocal;
   - prompt;
   - генерация видео сразу синхронно с аудио.
8. Позже построить клиповый workflow:
   - полный трек;
   - выделение вокала;
   - разбиение на музыкальные фразы;
   - генерация S2V-сегментов;
   - склейка;
   - возврат оригинального финального трека.

Сайт рассчитан на локальное использование по HTTP:

```text
http://IP_ВМ:8000
```

HTTPS специально не используется на текущем этапе.

---

## 2. GitHub и правила работы

Репозиторий:

```text
OpenFunRus/aivideosite
```

Ветка:

```text
main
```

Правила для продолжения:

- всегда читать актуальный код из GitHub перед изменениями;
- не придумывать существующие файлы, классы, API или архитектуру;
- изучать связанные файлы до правок;
- исправлять первопричину, а не поверхностный симптом;
- работать в `main`;
- не создавать GitHub Actions / CI без прямой просьбы;
- runtime GPU и визуальный результат проверяет пользователь на Ubuntu VM;
- после законченного этапа коммитить изменения в `main`;
- в конце сообщать:
  - изменённые файлы;
  - что сделано;
  - какие проверки действительно выполнены;
  - что не проверено;
  - что проверить пользователю;
  - известные ограничения;
  - полный SHA последнего commit.

---

## 3. VM / железо / гипервизор

Из текущей рабочей конфигурации известно:

### Хост

- гипервизор: Proxmox VE 8.4;
- CPU хоста: Intel Core i9-10980XE;
- GPU 0: NVIDIA GeForce RTX 3090, 24576 MiB VRAM, PCI bus `00000000:01:00.0`;
- GPU 1: NVIDIA GeForce RTX 2080 Ti mod, 22528 MiB VRAM, PCI bus `00000000:02:00.0`;
- обе GPU проброшены в Ubuntu VM через PCI passthrough и видны `nvidia-smi`.

### Ubuntu VM

- Ubuntu Server 24.04;
- vCPU: 12;
- RAM: 56 GiB;
- виртуальный диск после расширения: примерно 328 GB;
- NVIDIA driver работает;
- `nvidia-smi` работает;
- CUDA runtime для PyTorch работает;
- Docker установлен, но для текущего сайта не требуется;
- FFmpeg / ffprobe используются напрямую.

Не зафиксированы в этом документе и не должны выдумываться:

- Proxmox VM ID;
- точный LAN IP;
- bridge/interface;
- MAC;
- gateway;
- hostname VM.

Если они понадобятся:

```bash
hostname
hostname -I
ip -br a
ip route
```

### Проверка GPU

Подтверждённый вывод после подключения второй карты:

```text
GPU 0: NVIDIA GeForce RTX 3090
GPU 1: NVIDIA GeForce RTX 2080 Ti
```

VRAM:

```text
GPU 0: 24576 MiB
GPU 1: 22528 MiB
```

Проверка:

```bash
nvidia-smi -L
nvidia-smi --query-gpu=index,name,memory.total,pci.bus_id --format=csv
```

Для мониторинга:

```bash
watch -n 1 nvidia-smi
```

---

## 4. Основные пути Ubuntu

Корневая папка AI:

```text
/opt/ai
```

ComfyUI:

```text
/opt/ai/ComfyUI
```

ComfyUI venv:

```text
/opt/ai/ComfyUI/.venv
```

LatentSync:

```text
/opt/ai/LatentSync
```

Conda env LatentSync:

```text
/home/openfun/miniconda3/envs/latentsync
```

LatentSync Python:

```text
/home/openfun/miniconda3/envs/latentsync/bin/python
```

AI Video Site:

```text
/opt/ai/aivideosite
```

Site venv:

```text
/opt/ai/aivideosite/.venv
```

---

## 5. ComfyUI

Обычный ручной запуск:

```bash
cd /opt/ai/ComfyUI
source .venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188
```

Для ручной работы с UI при необходимости можно временно слушать `0.0.0.0`, но штатный backend сайта использует:

```text
http://127.0.0.1:8188
```

Проверка:

```bash
curl -s http://127.0.0.1:8188/system_stats | head
ss -ltnp | grep 8188
```

### H3 custom node

Используется:

```text
ComfyUI-MiniMaxH3-Easy
```

Проверенная вручную H3-конфигурация на RTX 3090:

- 1344x768;
- 24 FPS;
- 5 сек;
- Fast / Turbo 8 steps;
- I2V и First/Last Frame работают;
- 10 секунд тоже ранее проверялись;
- примерное ранее наблюдавшееся время 5-секундного H3 на 1344x768 — около 3 мин 18 сек, но это не SLA и может меняться после обновлений.

### H3 модели

Diffusion:

```text
/opt/ai/ComfyUI/models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
```

Text encoder:

```text
/opt/ai/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
```

Video VAE:

```text
/opt/ai/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors
```

Audio VAE:

```text
/opt/ai/ComfyUI/models/vae/minimax_h3_audio_vae_fp32.safetensors
```

Turbo LoRA:

```text
/opt/ai/ComfyUI/models/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
```

### H3 профили в сайте

- `fast`: Turbo LoRA + 8 steps;
- `quality`: base + 20 steps;
- `max`: base + 30 steps.

По умолчанию:

```text
Fast
```

---

## 6. LatentSync

Установлен отдельно от ComfyUI.

Путь:

```text
/opt/ai/LatentSync
```

Python:

```text
/home/openfun/miniconda3/envs/latentsync/bin/python
```

Checkpoint:

```text
/opt/ai/LatentSync/checkpoints/latentsync_unet.pt
```

Whisper:

```text
/opt/ai/LatentSync/checkpoints/whisper/tiny.pt
```

Базовая команда, вокруг которой построен worker:

```bash
/home/openfun/miniconda3/envs/latentsync/bin/python -m scripts.inference \
  --unet_config_path configs/unet/stage2_512.yaml \
  --inference_ckpt_path checkpoints/latentsync_unet.pt \
  --inference_steps 20 \
  --guidance_scale 1.5 \
  --enable_deepcache \
  --video_path INPUT_25FPS.mp4 \
  --audio_path VOCAL_16K_MONO.wav \
  --video_out_path OUTPUT.mp4
```

Перед этим сайт:

- делает видео 25 FPS;
- удаляет исходный звук из временного video;
- делает audio 16 kHz mono;
- учитывает `audio_start`;
- ограничивает audio длительностью исходного видео.

### Исправленная проблема VRAM

Была ошибка:

```text
torch.OutOfMemoryError
GPU 0 has ... Process ComfyUI has ~21.84 GiB memory in use
```

Причина:

- H3/ComfyUI после генерации продолжал держать почти всю VRAM;
- LatentSync не мог загрузить свои модели.

Сайт теперь перед LatentSync:

1. вызывает ComfyUI:
   `POST /free`
2. передаёт:
   ```json
   {
     "unload_models": true,
     "free_memory": true
   }
   ```
3. проверяет реальную VRAM через `nvidia-smi`;
4. ждёт минимум около 19000 MiB свободной памяти;
5. только затем запускает LatentSync;
6. запускает его с:
   ```text
   PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
   ```

После LipSync ComfyUI при следующей H3-задаче загружает модель снова.

### Исправленная проблема Face not detected

Получена реальная ошибка:

```text
RuntimeError: Face not detected
```

Это происходило на extreme close-up, когда лицо почти целиком занимало кадр.

В сайт добавлен:

```text
app/latentsync_face_check.py
```

Он использует тот же InsightFace / `FaceDetector`, что LatentSync.

Алгоритм:

1. подготовить исходный 25 FPS video;
2. preflight по всем кадрам тем же face detector;
3. если лицо определяется во всех кадрах — запускать LatentSync как раньше;
4. если не определяется:
   - временно уменьшить video до 85% с полями;
   - проверить;
   - если не помогло — 75%;
   - затем 65%;
5. если один вариант проходит — LatentSync работает по временному safe-frame;
6. после LipSync поля crop-ятся;
7. видео растягивается обратно в исходное разрешение;
8. аудио сохраняется;
9. если даже 65% не проходит — возвращается понятная ошибка с проблемным frame.

ВАЖНО: этот fallback реализован, но после последнего изменения пользователь ещё должен подтвердить его runtime-результат.

---

## 7. AI Video Site — backend

Stack:

- Python;
- FastAPI;
- Jinja2;
- SQLite;
- vanilla JS;
- vanilla CSS;
- локальный SVG sprite в стиле Tabler;
- requests;
- websocket-client;
- FFmpeg.

Dependencies закреплены в:

```text
requirements.txt
```

Ключевые backend-файлы:

```text
app/main.py
app/config.py
app/db.py
app/comfy.py
app/worker.py
app/latentsync_face_check.py
```

Frontend:

```text
app/templates/base.html
app/templates/login.html
app/templates/index.html
app/static/app.js
app/static/app.css
app/static/icons.svg
```

---

## 8. Авторизация

Один общий пароль.

Default:

```text
11332244
```

Задаётся:

```text
SITE_PASSWORD=11332244
```

Session secret:

```text
SESSION_SECRET=auto
```

При `auto` приложение создаёт постоянный случайный secret:

```text
data/.session_secret
```

Права файла пытаются выставиться `0600`.

Сессия HttpOnly.

Сайт рассчитан на LAN / HTTP. Не считать текущую конфигурацию интернет-facing production security.

---

## 9. SQLite / фоновые jobs

DB:

```text
/opt/ai/aivideosite/data/aivideosite.db
```

WAL включён.

Runtime dirs:

```text
data/uploads/
data/library/
data/tmp/
```

Они не коммитятся.

Сайт должен запускаться только:

```text
--workers 1
```

Причина:

- внутри процесса один `JobWorker`;
- GPU heavy jobs должны выполняться последовательно;
- несколько Uvicorn workers создали бы несколько GPU workers и риск OOM.

При restart:

- `running` jobs восстанавливаются в `queued`.

---

## 10. Очередь — текущий UX

Реализовано:

- после постановки генерации сразу открывается Queue;
- статусы:
  - queued;
  - running;
  - done;
  - failed;
  - canceled;
- время создания;
- время фактического старта;
- ожидание в очереди;
- живой таймер генерации;
- итоговое время;
- приблизительный процент;
- Cancel;
- Retry для failed;
- кнопка открыть Library после success;
- удалить завершённую/ошибочную/отменённую запись;
- работающую задачу удалить нельзя — сначала Cancel;
- `Очистить всё` удаляет всё неработающее;
- работающие остаются;
- пагинация 20 jobs/page.

### Таймер

Был исправлен важный баг.

Сервер отдаёт:

```text
server_now
```

Фронтенд синхронизирует локальный live-counter с серверным временем.

Фактические timestamps:

- `created_at` — enqueue;
- `started_at` — worker реально забрал job;
- `finished_at` — complete/fail/cancel.

Нельзя снова рассчитывать generation time от параметра длительности видео или от приблизительного config.

---

## 11. Библиотека

Реализовано:

- inline video preview;
- download;
- LipSync;
- audio replace;
- remove audio;
- delete;
- clear all;
- pagination 20/page;
- metadata modal.

### Важный fix playback

Раньше polling каждые 3 секунды полностью перерисовывал Library, из-за чего `<video>` начинал воспроизведение заново.

Теперь Library не перерисовывается, пока ролик играет, если media signature не требует безопасного refresh.

Не возвращать старую механику unconditional `innerHTML` refresh каждые 3 секунды.

### Metadata modal

Показывает:

- prompt;
- seed;
- resolution;
- generation seconds;
- FPS;
- profile;
- native H3 audio;
- reference count;
- actual file duration;
- size;
- created timestamp;
- operation type.

Prompt и seed имеют copy buttons.

Для HTTP/IP используется clipboard fallback, если Secure Context API недоступен.

---

## 12. First / Last Frame UI

После выбора:

- картинка показывается preview внутри upload card;
- на desktop при hover появляется крестик;
- на touch/mobile крестик виден постоянно;
- крестик очищает конкретный input;
- repeat selection заменяет preview;
- Object URL освобождается.

ВАЖНЫЙ уже исправленный regression:

В JS были перепутаны одиночный selector и selector-all helper, из-за чего file input handlers не регистрировались.

Теперь helper-ы названы явно:

```js
qs()
qsa()
```

Не возвращать неоднозначные `$ / $$`, потому что именно это уже вызвало регрессию.

Файлы всё равно отправляются через:

```js
new FormData(generationForm)
```

Browser security не позволяет восстановить выбранный local file после reload. Поэтому localStorage хранит настройки, но не binary first/last frame.

---

## 13. localStorage

Хранятся:

- prompt;
- resolution;
- seconds;
- FPS;
- profile;
- seed;
- H3 native audio checkbox;
- текущий view.

Key generator settings:

```text
aivideosite-settings-v1
```

Кнопка:

```text
По умолчанию
```

Удаляет app keys из localStorage и возвращает:

- prompt = empty;
- default resolution;
- 5 sec;
- 24 FPS;
- Fast;
- seed = -1;
- native H3 audio = off;
- first/last input cleared.

---

## 14. H3 generation options

Duration:

```text
1–30 sec
```

Default:

```text
5 sec
```

FPS:

- 12;
- 16;
- 20;
- 24 default/recommended;
- 25;
- 30.

Resolution presets:

- 1344x768;
- 768x1344;
- 1024x1024;
- 1152x768;
- 768x1152;
- 1024x768;
- 768x1024;
- 1344x576;
- 1536x864;
- 864x1536.

1536 variants не считать гарантированно проверенными на RTX 3090.

### H3 native audio

Checkbox:

```text
Генерировать со звуком
```

Default: off.

При on workflow добавляет:

```text
VAEDecodeAudio
```

и подключает audio к:

```text
CreateVideo
```

Это H3-generated audio.

Это НЕ означает input song -> lip movement.

---

## 15. FFmpeg audio operations

### Remove audio

Создаётся отдельный производный ролик.

Video stream копируется:

```text
-c:v copy -an
```

### Replace / overlay track

Текущая операция фактически заменяет audio track загруженной дорожкой, используя:

- video copy;
- AAC;
- 192k;
- `-shortest`;
- `audio_start`.

Исходный library video не перезаписывается.

---

## 16. Установка сайта на чистой/восстановленной Ubuntu VM

Предполагается, что ComfyUI и LatentSync уже настроены.

```bash
cd /opt/ai
git clone https://github.com/OpenFunRus/aivideosite.git
cd /opt/ai/aivideosite

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
pip install -r requirements.txt

cp .env.example .env
```

Проверить:

```bash
cat .env
```

Пути должны соответствовать текущей VM.

Проверка import:

```bash
cd /opt/ai/aivideosite
source .venv/bin/activate
python -c "from app.main import app; print('AI Video Site: OK')"
```

Ручной запуск:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Открыть:

```text
http://IP_ВМ:8000
```

Login:

```text
11332244
```

Если UFW active:

```bash
sudo ufw allow 8000/tcp
```

---

## 17. .env — актуальный baseline

```dotenv
SITE_PASSWORD=11332244
SESSION_SECRET=auto
HOST=0.0.0.0
PORT=8000

DATA_DIR=/opt/ai/aivideosite/data
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_OUTPUT_DIR=/opt/ai/ComfyUI/output
LATENTSYNC_DIR=/opt/ai/LatentSync
LATENTSYNC_PYTHON=/home/openfun/miniconda3/envs/latentsync/bin/python
FFMPEG_BIN=/usr/bin/ffmpeg
FFPROBE_BIN=/usr/bin/ffprobe

H3_FL2VA_MODEL=minimax_h3_fl2va_pruned_int8_convrot.safetensors
H3_REF2VA_MODEL=none
H3_TEXT_ENCODER=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
H3_VIDEO_VAE=minimax_h3_video_vae_fp16.safetensors
H3_AUDIO_VAE=minimax_h3_audio_vae_fp32.safetensors
H3_TURBO_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
H3_ATTENTION_BACKEND=comfy kitchen attention

MAX_IMAGE_UPLOAD_MB=40
MAX_AUDIO_UPLOAD_MB=300
```

---

## 18. systemd

### ComfyUI

Repo file:

```text
systemd/comfyui.service
```

Current assumptions:

```ini
User=openfun
Group=openfun
WorkingDirectory=/opt/ai/ComfyUI
ExecStart=/opt/ai/ComfyUI/.venv/bin/python /opt/ai/ComfyUI/main.py --listen 127.0.0.1 --port 8188
```

### ComfyUI Wan / GPU 1

Repo file:

```text
systemd/comfyui-wan.service
```

Схема GPU isolation:

- `comfyui.service` -> `CUDA_VISIBLE_DEVICES=0` -> физическая RTX 3090 -> port 8188;
- `comfyui-wan.service` -> `CUDA_VISIBLE_DEVICES=1` -> физическая RTX 2080 Ti 22 GB mod -> port 8189.

Оба процесса используют один и тот же installation tree:

```text
/opt/ai/ComfyUI
```

и общие модели на диске, но CUDA context и VRAM полностью раздельные.

WAN service:

```ini
User=openfun
Group=openfun
WorkingDirectory=/opt/ai/ComfyUI
Environment=PYTHONUNBUFFERED=1
Environment=CUDA_VISIBLE_DEVICES=1
ExecStart=/opt/ai/ComfyUI/.venv/bin/python /opt/ai/ComfyUI/main.py --listen 127.0.0.1 --port 8189
Restart=always
```

ВАЖНО:

- внутри процесса `CUDA_VISIBLE_DEVICES=1` эта физическая GPU будет отображаться приложению как локальная CUDA device 0 — это нормально;
- текущий сайт пока использует только `COMFYUI_URL=http://127.0.0.1:8188`;
- интеграция WAN backend `http://127.0.0.1:8189` в сайт ещё не реализована;
- S2V 14B FP8 на RTX 2080 Ti 22 GB ещё требует runtime smoke test; не считать, что оно гарантированно влезает/работает до реального запуска.

### Site

Repo file:

```text
systemd/aivideosite.service
```

Current assumptions:

```ini
User=openfun
Group=openfun
WorkingDirectory=/opt/ai/aivideosite
EnvironmentFile=-/opt/ai/aivideosite/.env
ExecStart=/opt/ai/aivideosite/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Install:

```bash
cd /opt/ai/aivideosite

sudo cp systemd/comfyui.service /etc/systemd/system/comfyui.service
sudo cp systemd/comfyui-wan.service /etc/systemd/system/comfyui-wan.service
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service

sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl enable --now comfyui-wan.service
sudo systemctl enable --now aivideosite.service
```

Status:

```bash
systemctl status comfyui --no-pager
systemctl status comfyui-wan --no-pager
systemctl status aivideosite --no-pager
```

Logs:

```bash
journalctl -u comfyui -n 150 --no-pager
journalctl -u aivideosite -n 150 --no-pager
```

Live:

```bash
journalctl -u comfyui -f
journalctl -u aivideosite -f
```

Если сейчас процессы запущены вручную, сначала остановить manual instance, иначе будет port conflict на 8188/8000.

---

## 19. Wan2.2 S2V — следующий большой этап

### Почему

Текущий pipeline:

```text
H3 -> готовый video -> LatentSync -> final
```

LipSync постфактум ограничен face detector и меняет только область лица.

Для музыкального клипа лучше:

```text
reference image + vocal/audio + prompt -> S2V video already driven by audio
```

Wan2.2 S2V подходит для:

- dialogue;
- singing;
- performance;
- facial motion;
- head/body motion.

### Выбранный стартовый вариант для RTX 3090 24 GB

Использовать native ComfyUI Wan2.2 S2V.

Основная модель:

```text
wan2.2_s2v_14B_fp8_scaled.safetensors
```

Text encoder:

```text
umt5_xxl_fp8_e4m3fn_scaled.safetensors
```

VAE:

```text
wan_2.1_vae.safetensors
```

Audio encoder:

```text
wav2vec2_large_english_fp16.safetensors
```

Опционально для быстрых preview:

```text
wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors
```

Этот LoRA НЕ специально обучен для S2V. ComfyUI documentation предупреждает:

- много ключей LoRA не совпадают;
- он ускоряет до примерно 4 steps;
- может значительно ухудшить динамику и качество;
- финальное качество лучше проверять стандартным S2V около 20 steps.

### Папки

```text
/opt/ai/ComfyUI/models/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors
/opt/ai/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
/opt/ai/ComfyUI/models/vae/wan_2.1_vae.safetensors
/opt/ai/ComfyUI/models/audio_encoders/wav2vec2_large_english_fp16.safetensors
/opt/ai/ComfyUI/models/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors
```

### Одна команда на скачивание

```bash
bash -lc 'set -euo pipefail; C=/opt/ai/ComfyUI; mkdir -p "$C/models/"{diffusion_models,text_encoders,vae,audio_encoders,loras}; curl -fL --retry 10 --retry-all-errors -C - -o "$C/models/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors" "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors"; curl -fL --retry 10 --retry-all-errors -C - -o "$C/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"; curl -fL --retry 10 --retry-all-errors -C - -o "$C/models/vae/wan_2.1_vae.safetensors" "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/vae/wan_2.1_vae.safetensors"; curl -fL --retry 10 --retry-all-errors -C - -o "$C/models/audio_encoders/wav2vec2_large_english_fp16.safetensors" "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/audio_encoders/wav2vec2_large_english_fp16.safetensors"; curl -fL --retry 10 --retry-all-errors -C - -o "$C/models/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors" "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"; echo "Wan2.2 S2V files downloaded"; ls -lh "$C/models/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors" "$C/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" "$C/models/vae/wan_2.1_vae.safetensors" "$C/models/audio_encoders/wav2vec2_large_english_fp16.safetensors" "$C/models/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"'
```

Ориентировочный общий download для этого набора: около 25 GB.

### Первый S2V smoke test, который надо сделать после скачивания

Не интегрировать сразу в сайт.

Сначала вручную проверить в ComfyUI:

- reference portrait;
- 4–5 sec audio fragment;
- желательно русский вокал из текущей песни;
- 832x480 или аналогичный 480p старт;
- 16 FPS;
- один chunk около 77 frames;
- standard quality path сначала 20 steps;
- затем отдельно попробовать Lightning 4-step;
- torch.compile не использовать на первом тесте;
- перед тестом выгрузить H3 из VRAM.

Нужно записать:

- peak VRAM;
- wall-clock generation time;
- стабильность identity;
- lip timing на русском;
- head/body motion;
- качество рта;
- поведение с music+vocal против isolated vocal.

### Почему 77 frames

Native S2V workflow строится chunk-ами.

При 16 FPS:

```text
77 / 16 = 4.8125 sec
```

Для более длинного audio используются S2V Extend chunks.

Для 14 sec:

```text
14 * 16 = 224 frames
224 / 77 ~= 2.91
=> 3 chunks
```

### План будущей интеграции сайта

Добавить model/engine selector:

```text
MiniMax H3
Wan2.2 S2V
```

При H3 оставить текущую форму.

При Wan S2V показать:

- reference image;
- audio;
- prompt;
- audio start/end;
- output resolution;
- quality profile;
- seed;
- optional automatic vocal separation later.

Worker должен:

1. сериализовать S2V с остальными GPU jobs;
2. выгрузить H3/лишние модели перед S2V;
3. загрузить S2V;
4. использовать audio as conditioning;
5. сохранить output в Library;
6. записать prompt/seed/audio metadata;
7. mux original requested audio в final file, если Comfy graph выдаёт silent video.

---

## 20. План клипа из полного трека

Предпочтительный будущий pipeline:

```text
full song
  -> vocal separation (Demucs/UVR)
  -> phrase segmentation
  -> for each phrase:
       reference image
       vocal chunk
       prompt
       Wan2.2 S2V
  -> concatenate generated clips
  -> mux original full-quality song
  -> final clip
```

Важно:

- не резать механически каждые ровно 5 секунд;
- резать по фразам / паузам / строкам;
- S2V должен получать тот audio segment, под который он генерирует;
- в финал возвращать original master track, а не separated vocal;
- отдельный vocal нужен primarily как motion/lip driver.

Demucs/UVR пока НЕ установлен и не интегрирован.

---

## 21. Известные ограничения

1. Runtime visual/GPU tests выполняются на Ubuntu VM пользователем.
2. Site-side Wan2.2 S2V ещё не реализован.
3. Wan2.2 S2V на RTX 3090 ещё не протестирован в текущей VM.
4. Русский singing lip timing через English Wav2Vec2 audio encoder надо проверить empirically.
5. Lightning LoRA для S2V не является специально обученной S2V LoRA и может портить результат.
6. H3 quality/max profiles в текущем сайте нельзя считать полностью runtime-tested так же хорошо, как Fast.
7. 1536x864 H3 presets не считать гарантированно проверенными по VRAM/performance.
8. LatentSync face-safe fallback 85/75/65 реализован, но после последнего commit требует реального runtime retest.
9. Demucs/UVR отсутствует.
10. Полноценный timeline editor отсутствует.
11. Browser не может восстановить local file input после F5 — это ограничение браузера.
12. Сайт без HTTPS и рассчитан на LAN.

---

## 22. Быстрая диагностика

### Site

```bash
curl -I http://127.0.0.1:8000/
ss -ltnp | grep 8000
```

### ComfyUI

```bash
curl -s http://127.0.0.1:8188/system_stats | head
ss -ltnp | grep 8188
```

### GPU

```bash
nvidia-smi
```

### Disk

```bash
df -h /
df -h /opt/ai
```

### Site logs

Manual mode: смотреть terminal с Uvicorn.

systemd:

```bash
journalctl -u aivideosite -n 150 --no-pager
```

### ComfyUI logs

```bash
journalctl -u comfyui -n 200 --no-pager
```

---

## 23. Что делать в новом чате

Если задача продолжается по `aivideosite`:

1. Открыть этот файл.
2. Прочитать актуальный README.
3. Прочитать актуальный `main` GitHub.
4. Не считать SHA из этого документа актуальным HEAD.
5. Если пользователь сообщает runtime error:
   - сначала исправить текущий этап;
   - не переходить к следующему большому feature.
6. Если Wan2.2 S2V файлы уже скачаны:
   - проверить размеры файлов;
   - проверить, видит ли их ComfyUI;
   - вручную собрать/открыть native Wan2.2 S2V workflow;
   - сделать 4–5 sec smoke test;
   - только после этого добавлять Wan engine в сайт.
7. После каждого существенного этапа:
   - commit main;
   - назвать полный SHA;
   - дать конкретный manual checklist.

---

## 24. Последние важные исправления перед этим handoff

По хронологии:

- background persistent queue;
- H3 T2V/I2V/First+Last;
- native H3 audio;
- Library;
- LatentSync;
- FFmpeg audio tools;
- responsive mobile UI;
- localStorage;
- paginated Queue/Library;
- Cancel/Retry/Delete/Clear;
- server-synchronized job timers;
- first/last image preview + remove cross;
- fix Library playback reset from polling;
- fix JS selector regression by replacing ambiguous `$ / $$` with `qs / qsa`;
- automatic ComfyUI VRAM unload before LatentSync;
- LatentSync face detector preflight;
- close-up fallback 85% / 75% / 65%;
- planned next engine: native Wan2.2 S2V.

---

## 25. Current recommended next action

Пока Wan models скачиваются:

1. не менять H3 pipeline;
2. закончить runtime test текущего LatentSync close-up fallback;
3. после download перезапустить/обновить ComfyUI только если native S2V nodes отсутствуют;
4. открыть native Wan2.2 S2V template;
5. test reference image + 4–5 sec Russian vocal;
6. записать speed/VRAM/quality;
7. решить:
   - 20-step quality;
   - 4-step preview;
8. после этого реализовать engine switch в сайте.


---

## 23. Вкладка «Монтаж» / timeline editor

Добавлен отдельный монтажный workflow без генерации референсов персонажей.

Реализовано:

- отдельная вкладка `Монтаж` в desktop и mobile navigation;
- список до 500 роликов из Library в качестве source clips;
- ролики можно добавлять кнопкой или drag-and-drop на видеодорожку;
- клипы на таймлайне можно менять местами drag-and-drop;
- у каждого клипа есть громкость 0–200%; 0% полностью убирает его исходный звук;
- отдельная пользовательская аудиодорожка загружается из браузера;
- аудиоблок на таймлайне можно перетаскивать мышью/пальцем; правый край меняет длину используемого фрагмента;
- для аудиодорожки настраиваются:
  - позиция на общем таймлайне;
  - trim начала;
  - длина используемого фрагмента;
  - громкость 0–200%;
- экспорт выполняется фоновой job `editor_export`;
- FFmpeg нормализует все клипы к разрешению первого ролика и 24 FPS, затем склеивает их в один MP4;
- если исходный ролик не имеет audio stream или его громкость равна нулю, в его участок подставляется silence, поэтому concat остаётся стабильным;
- отдельный трек микшируется поверх исходного звука клипов;
- результат сохраняется в Library с kind `edited`;
- кнопка `Склеить и скачать` запоминает job id в localStorage и после статуса done запускает скачивание результата;
- source clips защищены от удаления, пока editor export queued/running;
- uploaded audio сохраняется для Retry при failed и удаляется после успешного экспорта.

Ограничения текущей версии:

- это последовательная видеодорожка без наложения двух видео друг на друга;
- переходы между клипами пока hard cut;
- видео-трим отдельных клипов пока не реализован;
- speed/time-stretch отдельных клипов и аудио пока не реализован;
- output FPS фиксирован 24;
- output frame size берётся из первого клипа; ролики другого aspect ratio вписываются с black padding;
- browser binary audio не переживает reload страницы, поэтому после reload файл нужно выбрать снова.
