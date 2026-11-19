# AI Video Site

Локальная веб-панель для генерации и монтажа AI-видео через ComfyUI и FFmpeg.

## Что уже реализовано

- три независимых password-only профиля: у каждого своя библиотека, очередь/история и browser-настройки;
- тёмный адаптивный интерфейс без внешних CDN;
- локальные SVG-иконки Tabler;
- три H3-режима: FL2VA «Кадры», Ref2VA «Референсы» и Digital Human;
- FL2VA: T2V / First Frame / Last Frame / First+Last Frame с точными endpoint anchors;
- Ref2VA: до 9 reference images, 3 reference videos, 3 standalone audio и 15 media всего; роли и retention на каждый direct reference;
- per-user библиотека «Персонажи»: 1–4 appearance images, описание постоянных признаков и optional voice reference;
- Ref2VA task presets: reference generation, storyboard/keyframe completion, video editing, video continuation, audio reuse и audio reference;
- Digital Human: visual references + ровно один driving audio;
- длительность 1–30 секунд, по умолчанию 5 секунд;
- все ratio локального H3 Easy: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9; классы 360p / 480p / 720p / 1080p округляются вверх до сетки ×32, плюс 256×256 для 1:1 тестов;
- FPS 12/16/20/24/25/30, по умолчанию рекомендованные 24 FPS;
- FL2VA: 4/8 шагов используют FL Turbo LoRA; 12/16/20 — Base. Ref2VA: 4 шага используют отдельную Ref Turbo LoRA, 8/12/16/20 — Base;
- полноэкранный гайд по MiniMax H3 прямо в интерфейсе: FL2VA/Ref2VA/Digital Human, Characters, roles/retention, video editing/continuation, shots/timing, camera, dialogue/audio, ограничения и примеры;
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
- два независимых H3 ComfyUI backend: primary RTX 3090 и secondary RTX 2080 Ti, плюс сайт;
- мобильная навигация и responsive layout.

## Ожидаемая структура на Ubuntu

Проект рассчитан на уже настроенную машину:

- ComfyUI: `/opt/ai/ComfyUI`
- RTX 3090 24 GB + RTX 2080 Ti mod 22 GB / NVIDIA driver уже доступны
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

При первом запуске, если `SITE_USER1_PASSWORD` / `SITE_USER2_PASSWORD` / `SITE_USER3_PASSWORD` не заданы, приложение создаёт три уникальных шестизначных числовых пароля и сохраняет их в:

```text
data/.site_users.json
```

Файл получает права `0600` и не коммитится, потому что весь `data/` находится в `.gitignore`. Посмотреть текущие локальные пароли:

```bash
cat /opt/ai/aivideosite/data/.site_users.json
```

Можно задать свои значения через `.env`, но тогда необходимо указать все три уникальных пароля. Старый `SITE_PASSWORD` больше не используется.

При `SESSION_SECRET=auto` приложение само создаёт случайный постоянный ключ в `data/.session_secret`. Проект рассчитан на локальную сеть и HTTP по IP:port.

### Первый ручной запуск

Primary H3 ComfyUI слушает `0.0.0.0:8188` на RTX 3090, secondary H3 ComfyUI — `0.0.0.0:8189` на RTX 2080 Ti; внутри сайта используются localhost URL `127.0.0.1:8188/8189`, а из LAN оба UI доступны по IP VM.

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

Оба backend используют один и тот же H3-профиль и общие файлы моделей на диске. Primary закреплён за RTX 3090, secondary — за RTX 2080 Ti mod 22 GB:

```text
H3_FL2VA_MODEL=minimax_h3_fl2va_pruned_int8_convrot.safetensors
H3_REF2VA_MODEL=minimax_h3_ref2va_pruned_int8_convrot.safetensors
H3_TEXT_ENCODER=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
H3_VIDEO_VAE=minimax_h3_video_vae_fp16.safetensors
H3_AUDIO_VAE=minimax_h3_audio_vae_fp32.safetensors
H3_TURBO_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
H3_REF_TURBO_LORA=minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
```

Если файл модели называется иначе, достаточно изменить `.env`, код трогать не нужно. FL2VA и Ref2VA передаются в EasyLoader раздельно, поэтому отсутствие нового Ref2VA checkpoint не ломает старые FL2VA-задачи; Ref2VA начнёт работать после установки указанного checkpoint. Для 4-step Ref Turbo отдельно нужен Ref2V Turbo LoRA.

### Профили шагов и разрешения

Профили H3:

- FL2VA 4/8 шагов — FL Turbo;
- FL2VA 12/16/20 — Base;
- Ref2VA / Digital Human 4 шага — отдельный Ref Turbo;
- Ref2VA / Digital Human 8/12/16/20 — Base.

UI позволяет выбрать все aspect ratio, которые поддерживает текущий MiniMaxH3Easy node: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9`. Для каждого ratio классы 360p/480p/720p/1080p строятся на сетке ×32 с округлением вверх. В 1:1 дополнительно доступен 256×256 test. 21:9 1080-class шире 2048 px, поэтому API допускает стороны до 3072 px; этот режим требует отдельной проверки VRAM.

## Гайд по промптам MiniMax H3

В верхней левой части интерфейса есть кнопка `Гайд`. Она открывает полноэкранную инструкцию именно под текущий сайт:

- FL2VA: T2V / First / Last / First+Last;
- Ref2VA six-field prompt: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`;
- `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>`;
- Characters и saved voice references;
- roles / visual retention / audio retention;
- reference generation, storyboard guidance, video editing и continuation;
- Digital Human;
- shots, тайминги, camera, dialogue `<d>`, H3 native audio и concrete exclusions;
- чёткое ограничение: Ref2VA storyboard Picture не выдаётся за точный arbitrary-time latent keyframe.

Для агентов/локальных нейронок есть чистый текст без UI:

```text
/static/h3-prompting-guide-ai.txt
```

В модалке есть кнопка `Ссылка для нейронки`, копирование абсолютного URL и отдельный copy-paste блок для ChatGPT. Machine guide теперь описывает все реально подключённые режимы: FL2VA, Ref2VA, Characters, video/audio references и Digital Human.

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

GPU и worker общие: диспетчер выбирает следующую задачу из общей очереди всех пользователей, RTX 3090 остаётся primary, RTX 2080 Ti — secondary. Пользователь видит только свои задачи, но индикатор занятости GPU и метрика общей очереди учитывают всех.

## Очередь

Сайт запускается строго с одним Uvicorn worker. Внутри приложения работает один диспетчер с двумя независимыми H3 GPU-линиями: новая генерация сначала идёт на RTX 3090; если primary уже занят задачей сайта, следующая генерация запускается параллельно на RTX 2080 Ti. FFmpeg/монтаж имеют отдельную CPU-линию.

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

## Ref2VA / Characters — runtime-файлы и staging

- Character originals живут в `data/characters/<owner>/<character_id>/` и не удаляются после генерации.
- Direct reference uploads живут в `data/uploads/` до успешного завершения или удаления задачи, чтобы Retry мог повторить failed job.
- Перед Ref2VA запуском сайт копирует нужные image/video/audio в `COMFYUI_INPUT_DIR/aivideosite/<job_id>/`; staging всегда удаляется в `finally` после success/error/cancel.
- В metadata готового ролика сохраняются generation mode, task, reference map, ref image size, actual prompt, user prompt и GPU backend.
- План этапа и ручных проверок: `docs/H3_REFERENCES_CHARACTERS_PLAN.md`.

## Безопасность

Это LAN-инструмент без HTTPS. Авторизация использует три независимых парольных профиля и подписанную HttpOnly-сессию с автоматически сгенерированным локальным ключом. Не пробрасывайте порт 8000 напрямую в публичный интернет без HTTPS, сетевого ACL/VPN и смены стартового пароля.
