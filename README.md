# AI Video Site

Локальная веб-панель для генерации и монтажа AI-видео через ComfyUI и FFmpeg.

## Что уже реализовано

- произвольное количество password-only профилей из config: у каждого своя библиотека, очередь/история, Characters, V2 chat/editor drafts и browser-настройки;
- тёмный адаптивный интерфейс без внешних CDN;
- локальные SVG-иконки Tabler;
- четыре H3-режима: FL2VA «Кадры», Ref2VA «Референсы», native «Таймлайн» с exact guide frames и Digital Human;
- FL2VA: T2V / First Frame / Last Frame / First+Last Frame с точными endpoint anchors;
- Ref2VA: до 9 reference images, 3 reference videos, 3 standalone audio и 15 media всего; роли и retention на каждый direct reference;
- per-user библиотека «Персонажи»: 1–4 appearance images, описание постоянных признаков и optional voice reference;
- Ref2VA task presets: reference generation, semantic storyboard/keyframe completion, video editing, video continuation, audio reuse и audio reference;
- Timeline: до 16 exact guide images с точным временем; сайт строит native `MiniMaxH3AddGuide` chain и переводит секунды в `frame_idx`;
- H3 Fun ControlNet Union поверх любого режима: Canny Auto, prepared Canny/Pose/Depth/HED/MLSD и video inpainting через source+mask;
- Digital Human: visual references + ровно один driving audio;
- длительность 1–30 секунд, по умолчанию 5 секунд;
- все ratio локального H3 Easy: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9; классы 360p / 480p / 720p / 1080p округляются вверх до сетки ×32, плюс 256×256 для 1:1 тестов;
- FPS регулируется ползунком 6–32 с шагом 1; 24 FPS — рекомендуемое значение;
- шаги регулируются ползунком 6–24 с шагом 2. Для новых FL2VA-задач ровно 8 шагов используют установленную FL Turbo LoRA; остальные значения идут через Base. Ref2VA/Timeline/Digital Human в новом диапазоне 6–24 работают через Base, потому что установленная Ref Turbo LoRA рассчитана на 4 шага;
- native Timeline Guides и ControlNet переключают sampler на `res_multistep`, как в официальных ComfyUI H3 workflows; обычный Easy path остаётся на `euler`;
- полноэкранный гайд по MiniMax H3 прямо в интерфейсе: FL2VA/Ref2VA/Timeline/Digital Human, Characters, roles/retention, ControlNet, video editing/continuation, shots/timing, camera, dialogue/audio, ограничения и примеры;
- отдельный machine-readable guide: `/static/h3-prompting-guide-ai.txt`, плюс готовый copy-paste для ChatGPT;
- опциональное нативное аудио MiniMax H3 через Audio VAE, выключено по умолчанию;
- prompt и все параметры генерации автоматически сохраняются в localStorage и восстанавливаются после перезагрузки;
- очередь GPU-задач с хранением состояния в SQLite;
- генерация продолжает работать после закрытия браузера;
- библиотека роликов с просмотром и скачиванием;
- удалить звук или заменить аудиодорожку через FFmpeg;
- отдельная вкладка «Монтаж»: drag-and-drop клипов из библиотеки на таймлайн, перестановка порядка, громкость/полное отключение звука каждого клипа;
- отдельная пользовательская аудиодорожка с позицией на таймлайне, обрезкой начала/длины и громкостью;
- экспорт таймлайна через FFmpeg в единый MP4 с автоматическим скачиванием и сохранением результата в библиотеке;
- два независимых H3 ComfyUI backend: primary RTX3090 и secondary RTX2080, плюс сайт;
- мобильная навигация и responsive layout.


## V2 — упрощённый task-first интерфейс

Старый интерфейс сохранён на `/`. Новый V2 доступен на:

```text
http://IP_ВМ:8000/v2
```

V2 уже содержит отдельные рабочие пространства:

- **Создать** — 480p/720p/1080p, 1:1/16:9/9:16, 5/10/15 сек, 8/12/16 steps, seed, sound, first/last frames, Characters и magic wand;
- **Продолжить** — Library/upload source, автоматическое наследование размера и Ref2VA video continuation;
- **По аудио** — Digital Human с driving audio и Character/visual reference;
- **Продолжить клип** — previous video + master track, автоматическая нарезка следующего аудиосегмента;
- **Библиотека** и **Очередь** — V2-native просмотр результатов, jobs и занятость обеих GPU;
- **Монтаж** — последовательный Video 1 timeline, reorder, trim, split, volume, fade in/out и отдельная Music-дорожка с FFmpeg export;
- **Чат** — streaming Qwen3-8B с Thinking и управлением реальным 32k context budget;
- **Система** — GPU/VRAM/load/temp, Qwen, ComfyUI, RAM/CPU/disk;
- **Инструкция** — обучение по сайту/H3 и полный copy-paste context для ChatGPT.

Подробный статус и ограничения: [docs/v2/PLAN.md](docs/v2/PLAN.md).

## Опциональный локальный ИИ-помощник

В сайт встроен плавающий локальный чат с 32k context на `w3joe/Qwen3-8B-abliterated Q4_K_M` через `llama.cpp`:

- **Разговор** — обычный стриминговый чат, помощь по H3 и готовые промты;
- **Управление** — модель получает текущую форму генератора, возвращает серверно валидируемый JSON и может менять промт, режим, длительность, FPS, steps, seed, H3 Audio, формат/размер, Ref2VA/ControlNet и выбранных сохранённых персонажей;
- история чата хранится отдельно в браузере каждого пользователя;
- браузер не ходит напрямую на порт 8090: запросы проксируются через авторизованные API сайта.

Менеджер держит LLM на свободной GPU (приоритет RTX2080, затем RTX3090), а когда обе карты заняты H3 — автоматически переносит модель на CPU. H3 worker резервирует GPU до запуска задачи и освобождает после завершения.

Установка и проверка: [docs/LOCAL_LLM_ASSISTANT.md](docs/LOCAL_LLM_ASSISTANT.md).

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

Для агентов/локальных нейронок есть чистый текст без UI:

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

GPU и worker общие: диспетчер выбирает следующую задачу из общей очереди всех пользователей, RTX3090 остаётся primary, RTX2080 — secondary. Пользователь видит только свои задачи, но индикатор занятости GPU и метрика общей очереди учитывают всех.

## Очередь

Сайт запускается строго с одним Uvicorn worker. Внутри приложения работает один диспетчер с двумя независимыми H3 GPU-линиями: новая генерация сначала идёт на RTX3090; если primary уже занят задачей сайта, следующая генерация запускается параллельно на RTX2080. FFmpeg/монтаж имеют отдельную CPU-линию.

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
