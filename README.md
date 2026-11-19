# AI Video Site

Локальная веб-панель для генерации и монтажа AI-видео через ComfyUI и FFmpeg.

## Что уже реализовано

- три независимых password-only профиля: у каждого своя библиотека, очередь/история и browser-настройки;
- тёмный адаптивный интерфейс без внешних CDN;
- локальные SVG-иконки Tabler;
- T2V / I2V / First+Last Frame для MiniMax H3;
- длительность 1–30 секунд, по умолчанию 5 секунд;
- три простые группы размеров: квадрат 1:1, горизонталь 16:9 и вертикаль 9:16; внутри — 360p / 480p / 720p / 1080p, плюс 256×256 для быстрых квадратных тестов;
- FPS 12/16/20/24/25/30, по умолчанию рекомендованные 24 FPS;
- пять профилей по числу шагов: 4/8 (Turbo LoRA) и 12/16/20 (Base); 30 шагов удалены;
- полноэкранный гайд по MiniMax H3 прямо в интерфейсе: структура prompt, shots/timing, camera, first/last frame, dialogue/audio, ограничения и примеры;
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
H3_TEXT_ENCODER=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
H3_VIDEO_VAE=minimax_h3_video_vae_fp16.safetensors
H3_AUDIO_VAE=minimax_h3_audio_vae_fp32.safetensors
H3_TURBO_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
```

Если файл модели называется иначе, достаточно изменить `.env`, код трогать не нужно.

### Профили шагов и разрешения

Профили H3:

- 4 шага — Turbo;
- 8 шагов — Turbo, значение по умолчанию;
- 12 шагов — Base;
- 16 шагов — Base;
- 20 шагов — Base.

Разрешения сгруппированы по форме кадра. Пользователь выбирает квадрат, горизонталь или вертикаль, затем класс 360p / 480p / 720p / 1080p. Фактический размер никогда не меньше выбранного класса: каждая сторона при необходимости округляется вверх до H3-валидной сетки ×32, сохраняя максимально близкое соотношение сторон. Для квадрата дополнительно есть 256×256 как сверхбыстрый тестовый режим.


Текущие H3-валидные размеры:

- квадрат: 256×256, 384×384, 480×480, 736×736, 1088×1088;
- горизонталь: 672×384, 864×480, 1312×736, 1920×1088;
- вертикаль: 384×672, 480×864, 736×1312, 1088×1920.

## Гайд по промптам MiniMax H3

В верхней левой части интерфейса есть кнопка `Гайд`. Она открывает полноэкранную инструкцию, адаптированную именно под текущий сайт:

- T2V без кадров;
- I2V с первым кадром;
- FL2V с первым и последним кадром;
- три поля `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`;
- shots, тайминги и движения камеры;
- диалоги через speaker IDs и `<d>`;
- H3 native audio;
- прямые ограничения вместо отдельного negative prompt;
- готовые шаблоны и примеры.

Для агентов/локальных нейронок есть чистый текст без UI:

```text
/static/h3-prompting-guide-ai.txt
```

В модалке есть кнопка `Ссылка для нейронки`, копирование абсолютного URL и отдельный copy-paste блок для ChatGPT. Machine guide намеренно описывает только режимы, реально подключённые в текущем FL2VA workflow, а не Mage-specific Characters/Ref2VA.

## Пользователи и изоляция данных

Авторизация остаётся password-only: введённый пароль однозначно определяет один из трёх профилей. Отдельное имя пользователя вводить не нужно.

Изоляция:

- jobs/история фильтруются по `owner_id`;
- media/library фильтруются по `owner_id`;
- просмотр/download/delete/audio/editor не позволяют обращаться к чужому `media_id`;
- cancel/retry/delete не позволяют обращаться к чужому `job_id`;
- localStorage браузера также разделён по пользователям, поэтому prompt/seed/последняя вкладка не переходят между профилями;
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
data/tmp/
```

Оригинальные и производные ролики хранятся отдельно. Операции с аудио и монтаж не перезаписывают исходник.

## Безопасность

Это LAN-инструмент без HTTPS. Авторизация использует три независимых парольных профиля и подписанную HttpOnly-сессию с автоматически сгенерированным локальным ключом. Не пробрасывайте порт 8000 напрямую в публичный интернет без HTTPS, сетевого ACL/VPN и смены стартового пароля.
