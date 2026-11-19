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

`aivideosite` — локальная веб-панель для AI-видео на одной Ubuntu VM с двумя GPU: RTX 3090 24 GB и RTX 2080 Ti mod 22 GB.

Основные задачи:

1. Генерировать видео через MiniMax H3 в ComfyUI.
2. Поддерживать T2V / I2V / First+Last Frame.
3. Хранить очередь и библиотеку независимо от браузера.
4. Позволять закрыть сайт, вернуться позже и увидеть результат.
5. Делать простые операции со звуком через FFmpeg.
7. Использовать обе GPU для MiniMax H3 с автоматическим распределением:
   - RTX 3090 — primary;
   - RTX 2080 Ti mod 22 GB — secondary;
   - если primary занят генерацией сайта, следующая H3-задача запускается на secondary.
8. Сохранять монтажный и аудио workflow через FFmpeg.

### Важное архитектурное решение: legacy lip-sync удалён

19 ноября 2026 пользователь решил полностью отказаться от LatentSync. Причина: целевой музыкальный workflow должен генерировать видео сразу по аудио через removed legacy video engine, поэтому отдельная постобработка губ больше не нужна.

Из проекта удалены:

- API отдельного lip-sync;
- worker pipeline и face-preflight;
- кнопка lip-sync в библиотеке;
- Steps/Guidance UI;
- конфигурация и environment variables LatentSync;
- helper `app/latentsync_face_check.py`.

Не возвращать LatentSync без нового прямого запроса пользователя. Обычное наложение/удаление аудио через FFmpeg и монтажная аудиодорожка остаются.

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
python main.py --listen 0.0.0.0 --port 8188
```

ComfyUI services слушают `0.0.0.0`, чтобы UI был доступен из локальной сети. Штатный backend сайта при этом использует localhost URL:

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

Исторически проверенная вручную H3-конфигурация на RTX 3090 (после перехода на dual-GPU тот же H3 профиль нужно подтвердить на RTX 2080 Ti mod 22 GB):

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

Предполагается, что ComfyUI уже настроен.

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
COMFYUI_SECONDARY_URL=http://127.0.0.1:8189
COMFYUI_OUTPUT_DIR=/opt/ai/ComfyUI/output
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

### LAN-доступ к ComfyUI

Оба ComfyUI backend слушают на всех интерфейсах:

- H3 primary / RTX 3090: `0.0.0.0:8188`;
- H3 secondary / RTX 2080 Ti: `0.0.0.0:8189`.

При текущем IP VM `192.168.1.244` UI доступны из локальной сети по:

```text
http://192.168.1.244:8188
http://192.168.1.244:8189
```

UFW на момент настройки был inactive, поэтому отдельное firewall-правило не требовалось. ComfyUI UI не имеет встроенной авторизации в этой схеме, поэтому не пробрасывать 8188/8189 в интернет.

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
ExecStart=/opt/ai/ComfyUI/.venv/bin/python /opt/ai/ComfyUI/main.py --listen 0.0.0.0 --port 8188
```

### Secondary H3 / GPU 1

Repo file:

```text
systemd/comfyui-secondary.service
```

Схема GPU isolation:

- `comfyui.service` -> `CUDA_VISIBLE_DEVICES=0` -> физическая RTX 3090 24 GB -> H3 primary -> port 8188;
- `comfyui-secondary.service` -> `CUDA_VISIBLE_DEVICES=1` -> физическая RTX 2080 Ti mod 22 GB -> H3 secondary -> port 8189.

Оба процесса используют один и тот же installation tree:

```text
/opt/ai/ComfyUI
```

и общие модели на диске, но CUDA context и VRAM полностью раздельные.

Secondary H3 service:

```ini
User=openfun
Group=openfun
WorkingDirectory=/opt/ai/ComfyUI
Environment=PYTHONUNBUFFERED=1
Environment=CUDA_VISIBLE_DEVICES=1
ExecStart=/opt/ai/ComfyUI/.venv/bin/python /opt/ai/ComfyUI/main.py --listen 0.0.0.0 --port 8189
Restart=always
```

ВАЖНО:

- внутри каждого процесса выбранная через `CUDA_VISIBLE_DEVICES` физическая GPU отображается приложению как локальная CUDA device 0 — это нормально;
- текущий сайт пока использует только `COMFYUI_URL=http://127.0.0.1:8188`;
- интеграция WAN backend `http://127.0.0.1:8189` в сайт ещё не реализована;
- removed legacy video engine 14B FP8 целенаправленно запускается на RTX 3090 24 GB; runtime smoke test ещё требуется.

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
sudo cp systemd/comfyui-secondary.service /etc/systemd/system/comfyui-secondary.service
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service

sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl enable --now comfyui-secondary.service
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

## 19. Dual H3 dispatcher — актуальная архитектура

19 ноября 2026 пользователь отказался от removed legacy video engine после ручного теста качества. Wan больше не является частью проекта и не должен возвращаться без нового прямого запроса.

Текущая схема:

```text
RTX 3090 24 GB
  -> comfyui.service
  -> CUDA_VISIBLE_DEVICES=0
  -> 0.0.0.0:8188
  -> H3 primary

RTX 2080 Ti mod 22 GB
  -> comfyui-secondary.service
  -> CUDA_VISIBLE_DEVICES=1
  -> 0.0.0.0:8189
  -> H3 secondary
```

Оба процесса используют один installation tree и один набор файлов моделей:

```text
/opt/ai/ComfyUI
```

Внутри сайта:

```dotenv
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_SECONDARY_URL=http://127.0.0.1:8189
```

Правило диспетчеризации генераций:

1. первая свободная H3-задача всегда назначается RTX 3090;
2. если RTX 3090 уже занята H3-задачей сайта, следующая H3-задача запускается на RTX 2080 Ti;
3. обе генерации могут идти параллельно;
4. если обе GPU заняты, следующие H3-задачи остаются queued;
5. FFmpeg audio/editor jobs имеют отдельную CPU-линию и не блокируют выдачу новой H3-задачи на свободную GPU;
6. Cancel направляется именно в тот ComfyUI backend, где реально работает job.

В metadata готового ролика сохраняется:

```text
gpu_backend = RTX 3090
```

или:

```text
gpu_backend = RTX 2080 Ti
```

Это позволяет сравнивать фактические результаты и скорость двух GPU.

### Подтверждённый runtime

До перехода на эту финальную схему пользователь уже подтвердил, что MiniMax H3 успешно работает на RTX 2080 Ti mod 22 GB. По субъективному времени та же генерация была примерно в 2 раза медленнее, чем на RTX 3090.

Следующий обязательный runtime test после установки новой версии:

- поставить две H3-задачи подряд;
- убедиться, что первая идёт на RTX 3090;
- убедиться, что вторая одновременно стартует на RTX 2080 Ti;
- проверить Cancel отдельно для каждой задачи;
- проверить, что в Library metadata указан правильный GPU.

---

## 20. Wan удалён

removed legacy video engine признан неподходящим по качеству для этого проекта.

Удалить с Ubuntu:

- старый `comfyui-wan.service`;
- Wan diffusion model;
- Wan text encoder;
- Wan VAE;
- Wan audio encoder;
- Wan Lightning LoRA.

Не удалять H3 модели, H3 custom node или общий ComfyUI.

---

## 21. Известные ограничения

1. Runtime/визуальные GPU-тесты выполняет пользователь на Ubuntu VM.
2. RTX 2080 Ti примерно в 2 раза медленнее RTX 3090 в уже проверенном H3-тесте.
3. Приоритет диспетчера учитывает занятость задачами сайта; ручные задания, отправленные напрямую через ComfyUI UI, не являются штатным способом работы сайта.
4. H3 quality/max profiles проверены слабее Fast.
5. 1536x864 H3 presets не считать гарантированно проверенными по VRAM/performance.
6. Browser не может восстановить local file input после F5.
7. Сайт без HTTPS и рассчитан на LAN.
8. ComfyUI 8188/8189 доступны в LAN без собственной авторизации — не пробрасывать их в интернет.

---

## 22. Быстрая диагностика

Site:

```bash
curl -I http://127.0.0.1:8000/
```

Primary H3 / RTX 3090:

```bash
curl -s http://127.0.0.1:8188/system_stats | head
```

Secondary H3 / RTX 2080 Ti:

```bash
curl -s http://127.0.0.1:8189/system_stats | head
```

Порты:

```bash
ss -ltnp | grep -E '8000|8188|8189'
```

GPU:

```bash
nvidia-smi
```

Сервисы:

```bash
systemctl status comfyui.service --no-pager
systemctl status comfyui-secondary.service --no-pager
systemctl status aivideosite.service --no-pager
```

Логи:

```bash
journalctl -u comfyui.service -n 150 --no-pager
journalctl -u comfyui-secondary.service -n 150 --no-pager
journalctl -u aivideosite.service -n 150 --no-pager
```

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
