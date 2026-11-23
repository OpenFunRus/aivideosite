# Локальный ИИ-помощник AI Video Site

Актуальная модель:

```text
llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF
Q4_K_M
context: 131072 tokens
```

Gemma — единственная текущая chat / Magic Wand модель сайта.

## Архитектура

Основные файлы:

```text
app/assistant.py
app/llm_assistant_manager.py

app/static/assistant_context/
  01_minimax_h3_master_guide_en.txt
  02_minimax_h3_practical_playbook_en.txt
  03_aivideosite_v2_operator_map_en.txt

app/static/v2/js/workspaces/chat.js
app/static/v2/js/create.js
systemd/llm-assistant.service
```

`app/static/h3-prompting-guide-ai.txt` остаётся публичным machine-readable guide для внешнего копирования/ChatGPT, но НЕ является единственным preload локальной Gemma.

Browser не обращается к llama.cpp напрямую.

Site API:

```text
GET  /api/assistant/status
POST /api/assistant/chat
POST /api/assistant/control
POST /api/assistant/context
```

Runtime:
- llama.cpp OpenAI-compatible API: `127.0.0.1:8090`;
- LLM placement manager: `127.0.0.1:8091`.

## Preload / context

Каждый эффективный LLM request получает:

1. system/operator rules из `app/assistant.py`;
2. три preload-файла `assistant_context/01..03`;
3. sanitized `CURRENT_SITE_STATE`;
4. conversation history;
5. persistent user prompt, если он задан.

Preset visibility — жёсткий backend gate:
- в LLM context попадают только отмеченные справа Character/Location/Misc;
- неотмеченные presets вообще не сериализуются;
- для отмеченных передаются name + deep text metadata, voice state и image count;
- сами reference pixels Gemma не видит: их получает MiniMax H3 при generation.

## Промт пользователя

Кнопка **«Промт пользователя»** хранит до 12 000 символов в per-user localStorage.

Инструкция применяется на user priority:
- к обычному Чату с ИИ;
- к Magic Wand.

Она не может переопределить higher-priority system rules.

## Чат с ИИ

Чат:
- streaming;
- говорит на языке пользователя;
- не меняет формы и не утверждает, что запустил генерацию;
- хранит историю per-user в browser localStorage;
- показывает 128k context meter.

Copy-ready output contract:
- H3 prompt -> fenced ```text block;
- code -> соответствующий language fence;
- JSON / shell / config / template -> отдельный fenced block;
- UI рендерит fence как отдельную карточку с кнопкой Copy.

Обычный разговорный текст не нужно заворачивать в code fence.

## Magic Wand

Magic Wand возвращает prompt для текущего поля Video.

Canonical H3 fields:

```text
integrated_multimodal_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

Жёсткие правила:
- production instructions — English;
- exact dialogue / lyrics / on-screen text сохраняются на исходном языке;
- явная речь/пение: stable `(Sx)` + `<d>[Language] ...</d>`;
- никакого `changes.prompt:`, `message:`, `Mode:` footer;
- runtime `generation_mode` / `has_driving_audio` важнее статических предположений;
- master track с visual input = authoritative driving audio;
- master track без visual input = mux-only, не H3 conditioning.

Pipeline:
1. Gemma draft;
2. cleanup;
3. deterministic validation;
4. один repair-pass при необходимости;
5. single-dialogue normalizer для типичного случая обычных кавычек.

Validator — страховка, а не точка отказа.

## Thinking

Thinking управляется через llama.cpp chat template:

```python
chat_template_kwargs = {"enable_thinking": bool(thinking)}
```

Сайт НЕ добавляет вручную `/think` или `/no_think`.

Visible response:
- `reasoning_content` не форвардится;
- inline `<think>...</think>` фильтруется.

## Dynamic GPU / CPU placement

Приоритет LLM:

1. RTX2080;
2. RTX3090;
3. CPU, если обе GPU заняты H3.

H3 worker резервирует GPU. Manager при необходимости переносит llama-server на другую свободную GPU или CPU, а после освобождения снова возвращает модель на GPU.

Manager также учитывает очереди двух ComfyUI backend.

## Model file

```text
/opt/ai/models/llm/gemma-4-26B-A4B-it-uncensored-heretic-Q4_K_M.gguf
```

Установка/обновление модели автоматизируется `scripts/setup_gemma_assistant.sh`.

## llama.cpp CUDA build

Пример:

```bash
cd /opt/ai/llama.cpp

cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DGGML_BLAS=ON \
  -DGGML_BLAS_VENDOR=OpenBLAS \
  -DCMAKE_CUDA_ARCHITECTURES="75;86"

cmake --build build --config Release -j 18 -t llama-server
```

Проверка:

```bash
./build/bin/llama-server --list-devices
```

## systemd

```bash
cd /opt/ai/aivideosite
git pull origin main

sudo cp systemd/llm-assistant.service /etc/systemd/system/llm-assistant.service
sudo cp systemd/aivideosite.service /etc/systemd/system/aivideosite.service
sudo systemctl daemon-reload

sudo systemctl restart llm-assistant.service
sudo systemctl restart aivideosite.service
```

Диагностика:

```bash
systemctl --no-pager --full status llm-assistant.service
journalctl -u llm-assistant.service -n 150 --no-pager
curl -sS http://127.0.0.1:8091/status
echo
curl -sS http://127.0.0.1:8090/health
```

## Что проверяет пользователь вручную

1. Chat streaming.
2. Thinking OFF / ON.
3. «Промт пользователя» после reload.
4. Copy-ready fenced blocks.
5. Magic Wand canonical fields/dialogue format.
6. Selected-only Presets visibility.
7. Dynamic RTX2080 -> RTX3090 -> CPU placement under H3 load.
8. Возврат Gemma на GPU после завершения H3.
