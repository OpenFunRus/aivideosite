# Локальный ИИ-помощник для AI Video Site

Актуальное состояние на 2026-11-20.

Модель:

\`\`\`text
w3joe/Qwen3-8B-abliterated
Q4_K_M GGUF
\`\`\`

Модель уже встроена в сайт. Это НЕ только отдельный тестовый API.

## Архитектура

Компоненты:

\`\`\`text
app/assistant.py
app/llm_assistant_manager.py
app/static/assistant.js
app/static/h3-prompting-guide-ai.txt
systemd/llm-assistant.service
\`\`\`

Порты:

- \`127.0.0.1:8090\` — llama.cpp OpenAI-compatible API;
- \`127.0.0.1:8091\` — local GPU/CPU manager control API.

Site API:

\`\`\`text
GET  /api/assistant/status
POST /api/assistant/chat
POST /api/assistant/control
\`\`\`

Browser не обращается к 8090 напрямую.

## Dynamic GPU / CPU placement

Приоритет LLM:

1. RTX2080;
2. RTX3090;
3. CPU, если обе GPU заняты H3.

\`app/worker.py\` резервирует GPU перед H3 generation и освобождает после success/error/cancel.

Если текущая GPU LLM нужна H3, manager:

1. останавливает текущий llama-server;
2. выбирает вторую свободную GPU;
3. если обе заняты — запускает CPU-only;
4. после освобождения GPU возвращает LLM на GPU.

Менеджер также смотрит \`/queue\` обоих ComfyUI backend.

## llama.cpp / CUDA build

Нужна CUDA-сборка:

\`\`\`bash
cd /opt/ai/llama.cpp

cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DGGML_BLAS=ON \
  -DGGML_BLAS_VENDOR=OpenBLAS \
  -DCMAKE_CUDA_ARCHITECTURES="75;86"

cmake --build build --config Release -j 18 -t llama-server
\`\`\`

Проверка:

\`\`\`bash
./build/bin/llama-server --list-devices
\`\`\`

## Model file

\`\`\`text
/opt/ai/models/llm/Qwen3-8B-abliterated-Q4_K_M.gguf
\`\`\`

Если модель нужно скачать заново:

\`\`\`bash
sudo install -d -o openfun -g openfun /opt/ai/models/llm

sudo -u openfun curl -L --fail --retry 5 \
  'https://huggingface.co/w3joe/Qwen3-8B-abliterated/resolve/main/gguf/Qwen3-8B-abliterated-Q4_K_M.gguf?download=true' \
  -o /opt/ai/models/llm/Qwen3-8B-abliterated-Q4_K_M.gguf
\`\`\`

## Context

Service запускает модель с:

\`\`\`text
LLM_CTX_SIZE=32768
\`\`\`

То есть context = 32k tokens.

System prompt состоит из:

- H3 operator layer в \`app/assistant.py\`;
- полного \`app/static/h3-prompting-guide-ai.txt\`;
- текущего generator state;
- conversation history.

Текущий full H3 guide — около 20k chars. Цель — держать system prompt компактным, чтобы в 32k context оставался запас под историю, generator state и output.

## Thinking

По умолчанию OFF.

Кнопка-мозг в assistant UI:

- OFF -> \`/no_think\`;
- ON -> \`/think\`.

Thinking действует и в \`Разговор\`, и в \`Управление\`.

Visible output не должен содержать reasoning:

- \`reasoning_content\` игнорируется;
- \`<think>...</think>\` фильтруется.

## Разговор

Streaming local chat.

При H3-запросах модель получает полный H3 guide и текущую форму.

Жёсткое правило:

- объяснение может быть по-русски;
- production-ready H3 instructions всегда English;
- exact dialogue / lyrics / exact on-screen text сохраняются на исходном языке;
- обычный V2 prompt и Magic Wand используют три поля: `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`;
- в Ref2VA-workspace backend сам добавляет `subject_definitions / summary / retention_analysis` и реальные reference labels, поэтому LLM не должна выдумывать `<Picture N>/<Video N>/<Audio N>`.

## Разделение Chat и Magic Wand

- `POST /api/assistant/chat` — **обычный разговорный помощник**: идеи, вопросы, разбор результатов, советы, troubleshooting. Он не управляет формой и не обязан превращать любой ответ в H3 prompt.
- `POST /api/assistant/control` — **Magic Wand / control agent**. Только он возвращает JSON `changes.prompt` для формы.
- Каждая палочка получает собственный workspace context:
  - Create — duration/ratio/steps/sound + first/last flags + Characters;
  - Continue — source video context + свои settings;
  - Audio — выбранный master-track диапазон + embed/scene-sound + visual/Characters;
  - Clip — previous video + следующий master-track диапазон + свои settings.
- Состояние Create нельзя spread/переиспользовать для Continue/Audio/Clip.

## Управление

Модель возвращает JSON, backend валидирует и разрешает менять только allowlisted fields:

- prompt;
- generation_mode;
- seconds;
- fps;
- steps;
- seed;
- generate_audio;
- resolution_shape/resolution;
- reference_task;
- ref_image_size;
- ControlNet settings;
- selected Character IDs.

Она не имеет shell-доступа и не должна выдумывать отсутствующие assets.

## H3 knowledge

Главный machine guide:

\`\`\`text
app/static/h3-prompting-guide-ai.txt
\`\`\`

В нём описаны:

- FL2VA;
- Ref2VA;
- Characters;
- exact Timeline Guides;
- Digital Human;
- H3 Audio;
- reference roles/retention;
- video edit/continuation;
- H3 Fun ControlNet Union;
- Inpaint;
- action/camera/dialogue/sound grammar;
- continuity checklist;
- templates;
- canonical three-field V2 prompt contract;
- automatic three-field → six-field Ref2VA promotion in `app/h3_references.py`.

## UI

Плавающая кнопка справа снизу -> assistant panel.

Режимы:

- Разговор;
- Управление.

Дополнительно:

- Thinking brain-toggle;
- status target GPU/CPU;
- per-user localStorage history;
- streaming;
- copy response;
- clear history.

## Clipboard

Копирование не должно зависеть только от Clipboard API.

Общий порядок:

1. \`navigator.clipboard.writeText()\`;
2. если unavailable/rejected -> hidden textarea;
3. \`document.execCommand("copy")\`.

Используется для assistant и guide copy buttons.

## UTF-8

SSE от llama.cpp читается как raw bytes и явно декодируется \`utf-8\`.

Это исправляет mojibake вида \`Ð...\`.

Saved assistant history также пытается восстановить типичный UTF-8/Latin-1 mojibake при загрузке.

## systemd install/update

\`\`\`bash
cd /opt/ai/aivideosite
git pull origin main

sudo cp systemd/llm-assistant.service /etc/systemd/system/llm-assistant.service
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service

sudo systemctl daemon-reload
sudo systemctl enable llm-assistant.service
sudo systemctl enable aivideosite.service

sudo systemctl restart llm-assistant.service
sudo systemctl restart aivideosite.service
\`\`\`

\`llm-assistant.service\` очищает старый ручной \`llama-server --port 8090\` через \`ExecStartPre\`, чтобы избежать bind conflict.

## Проверка

\`\`\`bash
systemctl --no-pager --full status llm-assistant.service
journalctl -u llm-assistant.service -n 150 --no-pager

curl -sS http://127.0.0.1:8091/status
echo
curl -sS http://127.0.0.1:8090/health

watch -n 0.5 nvidia-smi
\`\`\`

Ожидаемо при свободной RTX2080:

\`\`\`json
{"ok":true,"target":"RTX2080","reserved_gpus":[],"llama_alive":true,"llama_port":8090}
\`\`\`

## Runtime checks, которые делает пользователь

1. Brain OFF/ON.
2. H3 prompt на английском при русском запросе.
3. Copy в assistant и guide.
4. Dynamic move RTX2080 -> RTX3090 -> CPU при H3 load.
5. Возврат LLM на GPU после завершения H3.
6. Реальный 32k context после установки systemd service.
7. Desktop/mobile UI.


## Валидация Magic Wand

- `/api/assistant/control` не доверяет первому `changes.prompt` вслепую.
- Для production prompt сервер проверяет наличие и порядок трёх обязательных полей, `[Shot 1]`, timestamp у последующих Shot и отсутствие low-level Ref2VA wrapper в обычном V2 output.
- Если в одном Shot написан явный camera cut/switch без нового timed Shot, результат считается некорректным.
- При `generate_audio=false` оба sound-поля обязаны быть ровно `N/A`.
- При первой ошибке сервер делает один corrective retry с перечислением нарушений и требованием сохранить конкретные факты пользователя без выдуманных деталей.
- Если повторный ответ тоже не проходит проверку, textarea не заменяется плохим prompt: API возвращает ошибку пользователю.
