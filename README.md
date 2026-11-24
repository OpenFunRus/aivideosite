# AI Video Site

Локальная веб-панель для генерации и монтажа AI-видео через ComfyUI и FFmpeg.

## Что уже реализовано

Основной интерфейс доступен на корне сайта:

```text
http://IP_ВМ:8000/
```

Маршруты `/v2` и `/v2/` оставлены только как совместимые alias. Legacy V1 frontend удалён.

### Видео

- единая форма генерации MiniMax H3;
- качество: 480p / 720p / 1080p;
- формат: 1:1 / 16:9 / 9:16;
- длительность: 5 / 10 / 15 секунд;
- 8 / 12 / 16 steps;
- фиксированные 24 FPS;
- Seed: Auto (`-1`) или `0..4294967295`;
- prompt до 16 000 символов;
- First Frame / Last Frame;
- reusable Character / Location / «Прочее» presets;
- Character: 1–4 appearance refs, описание и optional voice reference;
- Location: 1–4 environment refs + сохранённый prompt;
- Misc: reusable semantic refs по категориям object / gear / vehicle / creature / environment / visual trait / pose-action / style;
- ordinary H3 Audio toggle;
- master-track workflow прямо в той же форме.

Режим выбирается backend автоматически:

- без visual refs -> Frames / FL2VA;
- Character / Location / Misc -> Ref2VA;
- semantic preset + First/Last -> Ref2VA + native exact Timeline Guides;
- master track без visual input -> обычная генерация + optional final mux;
- master track + First/Last или semantic preset -> Digital Human с driving audio;
- First/Last в Digital Human режиме применяются отдельно как native exact Timeline Guides.

### Prompt / локальный ИИ

- Magic Wand переписывает обычный запрос в canonical MiniMax H3 prompt;
- FORMAT LOCK + few-shot примеры для shots, dialogue, singing, First/Last и driving audio;
- exact dialogue/lyrics сохраняются через stable `(Sx)` + `<d>[Language] ...</d>`;
- «Промт пользователя» — persistent per-user инструкция, общая для Chat и Magic Wand;
- локальная Gemma4 26B A4B Heretic Q4_K_M;
- 128k context;
- Thinking toggle;
- copy-ready prompt/code/JSON/shell/config блоки в чате получают отдельную кнопку копирования;
- LLM получает глубокие metadata только отмеченных справа Character/Location/Misc; неотмеченные presets вообще не сериализуются в её context.

### Состояние формы

В per-user localStorage сохраняются все восстанавливаемые настройки:

- prompt;
- quality / ratio / duration / steps / seed;
- H3 Audio;
- master-track mode;
- выбранный сохранённый track и позиция waveform;
- embed-track / scene-sound;
- selected Character / Location / Misc;
- muted Character voices;
- активная preset-вкладка;
- chat history, user prompt, editor project и другие workspace-specific настройки.

Browser security не позволяет после reload восстановить локальный `File`, выбранный напрямую с диска: First/Last и незагруженный audio-файл нужно выбрать заново. Сохранённый master track восстанавливается.

### Библиотека / очередь / монтаж / система

- per-user библиотека готовых MP4;
- просмотр, download, delete, извлечение Start/Final PNG;
- rolling queue последних задач: Cancel / Retry / Result;
- две H3 GPU lanes: перед каждой генерацией пользователь вручную выбирает свободную RTX3090 или RTX2080;
- failed-job Retry сохраняет нужные temporary inputs; удаление/prune очищают их;
- FFmpeg editor: sequential video timeline, reorder, trim, split, per-clip volume, fade in/out, one Music track, JSON project save/open, export to Library;
- системный экран: GPU/VRAM/load/temp, Gemma target/status, оба ComfyUI, RAM/CPU/disk, queue counts и графики;
- мобильные drawers для навигации и Presets.

### Архитектура frontend

Текущий frontend структурирован, а не собран в legacy-монолит:

```text
app/templates/v2.html
app/templates/v2/layout/
app/templates/v2/components/
app/templates/v2/views/

app/static/v2/css/
app/static/v2/css/workspaces/
app/static/v2/js/
app/static/v2/js/workspaces/
```

Legacy `app/templates/index.html`, `app/static/app.js`, `app/static/app.css` и `app/static/assistant.js` удалены.

Подробная структура: [docs/v2/FRONTEND_STRUCTURE.md](docs/v2/FRONTEND_STRUCTURE.md).

### Machine-readable guides

- внешний/копируемый H3 guide: `/static/h3-prompting-guide-ai.txt`;
- site context для внешнего ChatGPT: `/static/v2-chatgpt-site-guide.txt`;
- preload локальной Gemma:
  - `app/static/assistant_context/01_minimax_h3_master_guide_en.txt`;
  - `02_minimax_h3_practical_playbook_en.txt`;
  - `03_aivideosite_v2_operator_map_en.txt`.

## Ожидаемая структура на Ubuntu

Проект рассчитан на уже настроенную машину:

- ComfyUI: `/opt/ai/ComfyUI`
- RTX3090 24 GB + RTX2080 mod 22 GB / NVIDIA driver уже доступны
- FFmpeg установлен

Рекомендуемый путь проекта:

```text
/opt/ai/aivideosite
```

## Установка

```bash
cd /opt/ai
git clone https://github.com/OpenFunRus/aivideosite.git
cd aivideosite

python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt

cp .env.example .env
```

### Подготовка встроенных голосов Qwen3-TTS

V2 Character поддерживает 16 встроенных голосовых пресетов: 8 мужских и 8 женских. Они не грузят TTS-модель во время обычной работы сайта: один раз создаются локальные русские WAV и затем используются как обычные H3 voice references.

Запускайте в момент, когда хотя бы на одной GPU достаточно свободной VRAM:

```bash
cd /opt/ai/aivideosite
bash scripts/setup_voice_presets.sh
```

По умолчанию скрипт использует `VOICE_PRESET_GPU=auto`: через `nvidia-smi` выбирает GPU с максимальным объёмом свободной VRAM и не запускает VoiceDesign, если свободно меньше 7000 MiB.

Для принудительного выбора карты:

```bash
VOICE_PRESET_GPU=1 bash scripts/setup_voice_presets.sh
```

Скрипт создаёт изолированный runtime и кеш только внутри `data/`. ComfyUI venv не изменяется. После генерации должны быть доступны 16 файлов `data/voice_presets/*.wav`. Формат samples сейчас только русский: `«Привет, это мой голос.»`. Старые двуязычные WAV автоматически перегенерируются один раз; уже актуальные русские samples повторный запуск пропускает по version-sidecar.


Пользователи конфигурируются без жёсткого лимита «три профиля».

Поддерживаются:

- `SITE_USERS_JSON` с произвольным list/dict пользователей;
- `SITE_USER<N>_PASSWORD` + optional `SITE_USER<N>_ID` / `SITE_USER<N>_NAME` (N=1..100);
- локальный `data/.site_users.json`, включая старый формат `user1/user2/user3`.

Если ничего не настроено и файла ещё нет, первый запуск по-прежнему создаёт три уникальных шестизначных профиля. Файл получает права `0600`.

```bash
cat /opt/ai/aivideosite/data/.site_users.json
```

Пример добавления четвёртого пользователя без изменения кода:

```dotenv
SITE_USER4_ID=editor
SITE_USER4_NAME=Editor
SITE_USER4_PASSWORD=451923
```

Либо одной переменной:

```dotenv
SITE_USERS_JSON=[{"id":"openfun","label":"OpenFun","password":"123456"},{"id":"editor","label":"Editor","password":"451923"}]
```

Пароли должны быть уникальны. Старый `SITE_PASSWORD` больше не используется.

При `SESSION_SECRET=auto` приложение само создаёт случайный постоянный ключ в `data/.session_secret`. Проект рассчитан на локальную сеть и HTTP по IP:port.

### Первый ручной запуск

Primary H3 ComfyUI слушает `0.0.0.0:8188` на RTX3090, secondary H3 ComfyUI — `0.0.0.0:8189` на RTX2080; внутри сайта используются localhost URL `127.0.0.1:8188/8189`, а из LAN оба UI доступны по IP VM.

```bash
source /opt/ai/aivideosite/.venv/bin/activate
cd /opt/ai/aivideosite
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Открыть:

```text
http://IP_ВМ:8000
```

### Фоновая работа через systemd

После проверки ручного запуска:

```bash
sudo cp systemd/comfyui.service /etc/systemd/system/comfyui.service
sudo cp systemd/comfyui-secondary.service /etc/systemd/system/comfyui-secondary.service
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service

sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl enable --now comfyui-secondary.service
sudo systemctl enable --now aivideosite.service
```

Проверка:

```bash
systemctl status comfyui --no-pager
systemctl status comfyui-secondary --no-pager
systemctl status aivideosite --no-pager
```

Логи:

```bash
journalctl -u comfyui -f
journalctl -u comfyui-secondary -f
journalctl -u aivideosite -f
```

Если UFW включён:

```bash
sudo ufw allow 8000/tcp
```

## Важные настройки .env

Оба backend используют один и тот же H3-профиль и общие файлы моделей на диске. Primary закреплён за RTX3090, secondary — за RTX2080 mod 22 GB:

```text
H3_FL2VA_MODEL=minimax_h3_fl2va_pruned_int8_convrot.safetensors
H3_REF2VA_MODEL=minimax_h3_ref2va_pruned_int8_convrot.safetensors
H3_TEXT_ENCODER=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
H3_VIDEO_VAE=minimax_h3_video_vae_fp16.safetensors
H3_AUDIO_VAE=minimax_h3_audio_vae_fp32.safetensors
H3_TURBO_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
H3_REF_TURBO_LORA=minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
H3_CONTROLNET_MODEL_PATCH=minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors
```

Если файл модели называется иначе, достаточно изменить `.env`, код трогать не нужно. FL2VA и Ref2VA передаются в EasyLoader раздельно, поэтому отсутствие нового Ref2VA checkpoint не ломает старые FL2VA-задачи; Ref2VA начнёт работать после установки указанного checkpoint. Для 4-step Ref Turbo отдельно нужен Ref2V Turbo LoRA. ControlNet требует отдельный model patch в ComfyUI `models/model_patches`. Модели приложение само не скачивает.

### Шаги, FPS и разрешения

UI/API используют прямые параметры:

- `steps`: 6–24, шаг 2;
- `fps`: 6–32, шаг 1;
- для новых FL2VA-задач 8 шагов автоматически включают FL Turbo LoRA;
- остальные новые FL2VA значения используют Base;
- Ref2VA / Timeline / Digital Human в диапазоне 6–24 используют Base;
- старые queued jobs с `profile=steps4/steps8/...` продолжают поддерживаться внутри ComfyUI-адаптера.

UI позволяет выбрать все aspect ratio, которые поддерживает текущий MiniMaxH3Easy node: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9`. Для каждого ratio классы 360p/480p/720p/1080p строятся на сетке ×32 с округлением вверх. В 1:1 дополнительно доступен 256×256 test. 21:9 1080-class шире 2048 px, поэтому API допускает стороны до 3072 px; этот режим требует отдельной проверки VRAM.

## Гайд по промптам MiniMax H3

В верхней левой части интерфейса есть кнопка `Гайд`. Она открывает полноэкранную инструкцию именно под текущий сайт:

- FL2VA: T2V / First / Last / First+Last;
- Ref2VA six-field prompt: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`;
- `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>`;
- Characters и saved voice references;
- roles / visual retention / audio retention;
- reference generation, semantic storyboard guidance, video editing и continuation;
- exact Timeline Guides через native `MiniMaxH3AddGuide`;
- ControlNet Union: Canny/Pose/Depth/HED/MLSD/inpaint;
- Digital Human;
- shots, тайминги, camera, dialogue `<d>`, H3 native audio и concrete exclusions;
- чёткое различие: обычный Ref2VA storyboard Picture — semantic reference, а Timeline Guide — точный `frame_idx` anchor.

Для агентов/локальных нейронок есть чистые тексты без UI:

```text
/static/h3-prompting-guide-ai.txt
```

В модалке есть кнопка `Ссылка для нейронки`, копирование абсолютного URL и отдельный copy-paste блок для ChatGPT. Machine guide теперь описывает все реально подключённые режимы: FL2VA, Ref2VA, exact Timeline Guides, Characters, video/audio references, Digital Human и ControlNet Union.

## Пользователи и изоляция данных

Авторизация остаётся password-only: введённый пароль однозначно определяет один из трёх профилей. Отдельное имя пользователя вводить не нужно.

Изоляция:

- jobs/история фильтруются по `owner_id`;
- media/library фильтруются по `owner_id`;
- просмотр/download/delete/audio/editor не позволяют обращаться к чужому `media_id`;
- cancel/retry/delete не позволяют обращаться к чужому `job_id`;
- localStorage браузера также разделён по пользователям, поэтому prompt/seed/последняя вкладка не переходят между профилями;
- Characters фильтруются по `owner_id`, их preview endpoint также проверяет владельца;
- Character нельзя удалить, пока его файлы используются queued/running задачей;
- существующие до миграции jobs/media автоматически принадлежат `user1`.

GPU и worker общие, но карта для каждой новой видеогенерации выбирается пользователем в live-модалке. Занятая генерацией, ручной ComfyUI-задачей или текущим ответом Gemma карта недоступна. Пользователь видит только свои задачи, но состояние занятости GPU глобальное для всех пользователей.

## Очередь

Сайт запускается строго с одним Uvicorn worker. Внутри приложения работают две независимые H3 GPU-линии, но автоматического выбора карты больше нет: при нажатии «Сгенерировать видео» открывается live-модалка RTX3090 / RTX2080, и сервер атомарно резервирует выбранную свободную карту до завершения задачи. Gemma не работает на CPU и не держит GPU в простое: на время ответа она берёт свободную карту с приоритетом RTX2080 → RTX3090, после ответа llama-server останавливается и GPU освобождается. Если обе карты заняты видео, ответ Gemma не запускается. FFmpeg/монтаж остаются на отдельной CPU-линии.

Задачи сохраняются в SQLite. Если сервис перезапустить, незавершённая задача снова попадает в очередь.

## Данные

Runtime-файлы не коммитятся:

```text
data/aivideosite.db
data/uploads/
data/library/
data/characters/
data/tmp/
```

Оригинальные и производные ролики хранятся отдельно. Операции с аудио и монтаж не перезаписывают исходник.

## H3 References / Timeline / ControlNet — runtime-файлы и staging

- Character originals живут в `data/characters/<owner>/<character_id>/` и не удаляются после генерации.
- Direct reference uploads живут в `data/uploads/` до успешного завершения или удаления задачи, чтобы Retry мог повторить failed job.
- Перед Ref2VA/Timeline/ControlNet запуском сайт копирует нужные image/video/audio в `COMFYUI_INPUT_DIR/aivideosite/<job_id>/`; каталог создаётся лениво только для такой задачи и всегда удаляется в `finally` после success/error/cancel.
- В metadata готового ролика сохраняются generation mode, task, reference map, Timeline guide times, sanitized ControlNet settings, ref image size, actual prompt, user prompt и GPU backend.
- План этапа и ручных проверок: `docs/H3_REFERENCES_CHARACTERS_PLAN.md`.

## Требования для новых H3 controls

- Для Ref2VA нужен актуальный `ComfyUI-MiniMaxH3-Easy` и Ref2VA checkpoint.
- Exact Timeline Guides используют native `MiniMaxH3AddGuide` и требуют ComfyUI 0.34+.
- Fun ControlNet Union v1 использует native `ModelPatchLoader` + `MiniMaxH3FunControlNetApply` и требует ComfyUI 0.35+.
- Текущий default намеренно использует Union v1 patch; Union 2.0 не включён автоматически и требует отдельного обновления/проверки более нового ComfyUI.
- Canny Auto строится сайтом через встроенный ComfyUI Canny. Для Pose/Depth/HED/MLSD загружается уже подготовленное control video; сайт не выдаёт обычное RGB-видео за эти control representations.
- Inpaint требует source video и чёрно-белое mask video; белая область маски регенерируется.

## Безопасность

Это LAN-инструмент без HTTPS. Авторизация использует три независимых парольных профиля и подписанную HttpOnly-сессию с автоматически сгенерированным локальным ключом. Не пробрасывайте порт 8000 напрямую в публичный интернет без HTTPS, сетевого ACL/VPN и смены стартового пароля.
