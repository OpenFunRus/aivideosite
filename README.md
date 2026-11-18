# AI Video Site

Локальная веб-панель для генерации видео на MiniMax H3 через ComfyUI и постобработки через LatentSync/FFmpeg.

## Что уже реализовано

- вход по одному паролю;
- тёмный адаптивный интерфейс без внешних CDN;
- локальные SVG-иконки Tabler;
- T2V / I2V / First+Last Frame для MiniMax H3;
- быстрый Turbo 8-step и качественный 20-step профили;
- очередь GPU-задач с хранением состояния в SQLite;
- генерация продолжает работать после закрытия браузера;
- библиотека роликов с просмотром и скачиванием;
- LatentSync для lip-sync по загруженной аудиодорожке;
- удалить звук или заменить аудиодорожку через FFmpeg;
- systemd units для ComfyUI и сайта;
- мобильная навигация и responsive layout.

## Ожидаемая структура на Ubuntu

Проект рассчитан на уже настроенную машину:

- ComfyUI: `/opt/ai/ComfyUI`
- LatentSync: `/opt/ai/LatentSync`
- Conda env LatentSync: `/home/openfun/miniconda3/envs/latentsync`
- RTX 3090 / NVIDIA driver уже доступны
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

Стартовый пароль в `.env.example`:

```text
11332244
```

Перед публикацией машины в интернет пароль и `SESSION_SECRET` необходимо заменить. Этот проект рассчитан на локальную сеть и HTTP по IP:port.

### Первый ручной запуск

ComfyUI должен быть доступен на `127.0.0.1:8188`.

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
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service

sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl enable --now aivideosite.service
```

Проверка:

```bash
systemctl status comfyui --no-pager
systemctl status aivideosite --no-pager
```

Логи:

```bash
journalctl -u comfyui -f
journalctl -u aivideosite -f
```

Если UFW включён:

```bash
sudo ufw allow 8000/tcp
```

## Важные настройки .env

Имена моделей по умолчанию соответствуют установленному ранее H3-профилю RTX 3090 24 GB:

```text
H3_FL2VA_MODEL=minimax_h3_fl2va_pruned_int8_convrot.safetensors
H3_TEXT_ENCODER=qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
H3_VIDEO_VAE=minimax_h3_video_vae_fp16.safetensors
H3_AUDIO_VAE=minimax_h3_audio_vae_fp32.safetensors
H3_TURBO_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
```

Если файл модели называется иначе, достаточно изменить `.env`, код трогать не нужно.

## Очередь

Сайт запускается строго с одним Uvicorn worker. Внутри приложения есть один GPU worker, поэтому две тяжёлые задачи одновременно на RTX 3090 не стартуют.

Задачи сохраняются в SQLite. Если сервис перезапустить, незавершённая задача снова попадает в очередь.

## Данные

Runtime-файлы не коммитятся:

```text
data/aivideosite.db
data/uploads/
data/library/
data/tmp/
```

Оригинальные и производные ролики хранятся отдельно. Операции с аудио и lip-sync не перезаписывают исходник.

## Безопасность

Это LAN-инструмент без HTTPS. Авторизация защищает интерфейс одним паролем и подписанной HttpOnly-сессией. Не пробрасывайте порт 8000 напрямую в публичный интернет без HTTPS, сетевого ACL/VPN и смены стартового пароля.
