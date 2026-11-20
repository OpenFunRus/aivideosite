# Локальный ИИ-помощник для AI Video Site

Выбранная модель: `w3joe/Qwen3-8B-abliterated`, квант `Q4_K_M`.

Цель первого этапа — поднять отдельный локальный OpenAI-compatible API на `127.0.0.1:8090`.
Сайт пока к нему не подключён. Это позволяет сначала проверить модель отдельно, не затрагивая H3.

## Почему CPU-only

Сервис намеренно запускается с `--n-gpu-layers 0`.

Так RTX3090 и RTX2080 полностью остаются двум ComfyUI/H3 backend. Модель занимает RAM, а не VRAM.
Для текущего сервера Q4_K_M выбран как компромисс между скоростью и качеством.

## 1. Собрать llama.cpp

```bash
sudo apt update
sudo apt install -y git cmake build-essential libopenblas-dev curl

cd /opt/ai
if [ ! -d llama.cpp/.git ]; then
  sudo -u openfun git clone https://github.com/ggml-org/llama.cpp.git
fi

cd /opt/ai/llama.cpp
sudo -u openfun git pull --ff-only
sudo -u openfun cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_BLAS=ON \
  -DGGML_BLAS_VENDOR=OpenBLAS
sudo -u openfun cmake --build build --config Release -j 18 -t llama-server
```

Проверка:

```bash
/opt/ai/llama.cpp/build/bin/llama-server --version
```

## 2. Скачать модель

```bash
sudo install -d -o openfun -g openfun /opt/ai/models/llm

sudo -u openfun curl -L --fail --retry 5 \
  'https://huggingface.co/w3joe/Qwen3-8B-abliterated/resolve/main/gguf/Qwen3-8B-abliterated-Q4_K_M.gguf?download=true' \
  -o /opt/ai/models/llm/Qwen3-8B-abliterated-Q4_K_M.gguf

ls -lh /opt/ai/models/llm/Qwen3-8B-abliterated-Q4_K_M.gguf
```

Ожидаемый размер — примерно 5 GB.

## 3. Установить systemd service

После обновления `aivideosite`:

```bash
sudo cp /opt/ai/aivideosite/systemd/llm-assistant.service /etc/systemd/system/llm-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable --now llm-assistant.service
```

Проверить:

```bash
systemctl --no-pager --full status llm-assistant.service
journalctl -u llm-assistant.service -n 100 --no-pager
```

## 4. Проверить API

Health:

```bash
curl -sS http://127.0.0.1:8090/health
```

Русский/английский chat test:

```bash
curl -sS http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "local-h3-assistant",
    "temperature": 0.4,
    "max_tokens": 300,
    "messages": [
      {
        "role": "system",
        "content": "Отвечай прямо и кратко. Понимай русский и английский. /no_think"
      },
      {
        "role": "user",
        "content": "Придумай короткую сцену для MiniMax H3: выживший входит в заброшенный магазин. Ответь по-русски."
      }
    ]
  }'
```

Для будущего режима «Управление» сайт будет использовать schema-constrained JSON через OpenAI-compatible API llama.cpp, а не парсить свободный текст.

## Следующий этап сайта

Планируется один плавающий чат справа снизу с двумя режимами:

- **Разговор** — обычный диалог и помощь с H3; может выдать готовый prompt и рекомендации, но сам интерфейс не меняет.
- **Управление** — модель возвращает строго валидируемый JSON с prompt и настройками H3; сайт показывает, что будет изменено, и применяет разрешённые поля генератора.

Отдельный режим «Промт» не нужен: генерация prompt естественно входит в «Разговор».
