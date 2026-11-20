# Локальный ИИ-помощник для AI Video Site

Выбранная модель: `w3joe/Qwen3-8B-abliterated`, квант `Q4_K_M`.

Цель первого этапа — поднять отдельный локальный OpenAI-compatible API на `127.0.0.1:8090`.
Сайт пока к нему не подключён. Это позволяет сначала проверить модель отдельно, не затрагивая H3.

## Автоматический выбор GPU / CPU

`llm-assistant.service` запускает не сам `llama-server`, а локальный менеджер `app/llm_assistant_manager.py`.

Приоритет:

1. RTX2080, если она свободна;
2. RTX3090, если RTX2080 занята, а RTX3090 свободна;
3. CPU, если обе GPU заняты H3.

Перед запуском H3-задачи worker синхронно резервирует нужную GPU через локальный control API `127.0.0.1:8091`. Если LLM находится на этой карте, менеджер сначала останавливает его и переносит на другую свободную GPU либо CPU. После завершения H3 карта освобождается, и менеджер автоматически возвращает LLM на GPU.

Менеджер также опрашивает ComfyUI `/queue`, поэтому ручная задача, запущенная непосредственно через ComfyUI, тоже делает соответствующую карту недоступной для LLM.

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
  -DGGML_CUDA=ON \
  -DGGML_BLAS=ON \
  -DGGML_BLAS_VENDOR=OpenBLAS \
  -DCMAKE_CUDA_ARCHITECTURES="75;86"
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

> Сервис сам выполняет безопасную очистку старого тестового `llama-server`, запущенного с `--port 8090`, перед стартом менеджера. Это предотвращает ошибку `couldn't bind HTTP server socket` после ручных тестов.

## 3. Установить systemd service

Перед установкой остановите ручной тестовый `llama-server`, чтобы порт 8090 был свободен.

После обновления `aivideosite`:

```bash
sudo systemctl stop llm-assistant.service 2>/dev/null || true
pkill -f '/opt/ai/llama.cpp/build/bin/llama-server.*--port 8090' || true

sudo cp /opt/ai/aivideosite/systemd/llm-assistant.service /etc/systemd/system/llm-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable --now llm-assistant.service
```

Проверить выбранное устройство:

```bash
curl -sS http://127.0.0.1:8091/status
```

Например:

```json
{"ok":true,"target":"RTX2080","reserved_gpus":[],"llama_alive":true,"llama_port":8090}
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


## Контекст и system prompt

Локальный Qwen3 assistant запускается с контекстом **32768 токенов** (`LLM_CTX_SIZE=32768`).
System prompt использует полный `app/static/h3-prompting-guide-ai.txt` плюс компактный operator layer.
Текущий guide около 31k символов (~8k токенов грубой оценки), поэтому system prompt остаётся заметно ниже бюджета ~16k токенов и оставляет примерно половину контекста для истории, текущего состояния генератора и ответа.

Thinking по умолчанию выключен. В UI его можно включить кнопкой-мозг; frontend передаёт `thinking=true`, backend добавляет `/think`. Внутренний reasoning не выводится пользователю.
