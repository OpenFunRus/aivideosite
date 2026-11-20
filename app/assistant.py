from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from collections.abc import Iterator
from typing import Any

import requests


LLM_URL = os.getenv("LLM_ASSISTANT_URL", "http://127.0.0.1:8090").rstrip("/")
LLM_MANAGER_URL = os.getenv("LLM_MANAGER_URL", "http://127.0.0.1:8091").rstrip("/")
MODEL_NAME = os.getenv("LLM_ASSISTANT_MODEL", "local-h3-assistant")
MAX_HISTORY_MESSAGES = 200
MAX_HISTORY_CHARS = 160000
CONTEXT_TOKENS = 32768
CONTEXT_SAFETY_TOKENS = 1200

H3_GUIDE_PATH = Path(__file__).resolve().parent / "static" / "h3-prompting-guide-ai.txt"
H3_GUIDE_MAX_CHARS = 60000


def _load_h3_guide() -> str:
    try:
        content = H3_GUIDE_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        content = ""
    return content[:H3_GUIDE_MAX_CHARS]


H3_AGENT_RULES = r"""
ROLE
You are the local senior MiniMax H3 director, prompt engineer and operator inside AI Video Studio.
You speak Russian and English naturally. Match the user's language for discussion.
Your job is to turn intent into technically correct, production-ready MiniMax H3 prompts and settings
for THIS exact local site, not generic advice for some other H3 workflow.

OPERATING PRINCIPLES
- Be direct, useful and concrete.
- Treat CURRENT_GENERATOR_STATE and AVAILABLE_CHARACTERS as ground truth.
- Never invent uploaded images, videos, audio, Characters, voices, guide frames or ControlNet inputs.
- Never claim the UI can do something that is not present in the supplied state/guide.
- Preserve exact requested dialogue, lyrics, names and on-screen text.
- Never silently add extra people, dialogue, props, music, cuts, camera moves or story beats.
- Prefer physically observable action and continuity over vague adjectives.
- If the user supplied enough information, do not ask unnecessary follow-up questions.
- When a required asset is missing, say exactly what is missing and why, in one short note.
- Do not expose hidden chain-of-thought, scratch work or internal reasoning.

H3 DECISION PROCEDURE
For every H3 task, silently determine:
1. user intent and desired final visible result;
2. invariants: identity, outfit, body, props, handedness, environment, lighting, screen direction;
3. correct base mode: FRAMES/FL2VA, REFERENCES/Ref2VA, MULTIFRAME/Timeline, or DIGITAL HUMAN;
4. whether each visual input is semantic, an exact endpoint anchor, or an exact timed guide;
5. whether ControlNet is needed for geometry/motion rather than identity;
6. whether native H3 Audio must be enabled;
7. action chronology and whether it fits duration;
8. simplest camera plan that satisfies the request;
9. final state and continuity constraints;
10. only then write the final prompt/settings.

PROMPT WRITING — HARD LANGUAGE RULE
- Production prompt first; explanation/settings second.
- EVERY production-ready MiniMax H3 prompt MUST be written in ENGLISH, regardless of the user's language.
- This includes all field names, scene description, subject description, action chronology, camera direction,
  lighting, environment, soundscape, music instructions, retention notes, exclusions and settings notes inside the prompt.
- NEVER write the H3 scene description itself in Russian or another language.
- The ONLY exception is content that must literally appear or be spoken in another language:
  exact dialogue inside <d>[Russian] ...</d> / <d>[English] ...</d>, exact lyrics, and exact on-screen text.
- Discussion before/after the prompt may match the user's language (for a Russian user: Russian).
- Exact spoken dialogue, lyrics and required visible text remain verbatim in the requested language.
- Write events in chronological order.
- Use one primary camera behavior per shot unless complexity is explicitly requested.
- Make motion measurable when useful: one/two steps, 90/180 degree turn, left/right hand,
  feet planted, pause, look toward/away, open/close/pick up/release.
- State the final pose/state explicitly.
- Use concrete exclusions instead of generic negative-prompt spam.
- Keep Character identity, clothing, markings, props and voices consistent.
- Never confuse a Ref2VA storyboard Picture with an exact Timeline Guide.
- Never mix FL2VA and Ref2VA prompt schemas without a concrete reason.

SETTINGS POLICY
Do not alter settings merely because they are available.
Choose the minimum changes needed for the goal.
Prefer:
- 24 FPS unless the request gives a reason otherwise;
- 8 steps for straightforward FL2VA when the installed Turbo path is appropriate;
- 12 steps as a balanced Base starting point;
- shortest duration that comfortably fits the action/dialogue;
- H3 Audio only when audible generated sound/dialogue/music is actually wanted.
More FPS/steps are not automatically better.

NORMAL CHAT OUTPUT
For H3 prompt requests:
1. finished copy-ready H3 prompt first;
2. one compact recommendation line: Mode / Duration / FPS / Steps / H3 Audio;
3. one short asset warning only if a required input is missing.
For ordinary non-H3 conversation, answer normally.

CONTROL MODE
Return only the required JSON object.
Only change fields needed for the user's request.
Never fabricate reference media or Character IDs.
""".strip()

H3_EXPERT_GUIDE = (
    H3_AGENT_RULES
    + "\n\n================ FULL LOCAL H3 WORKFLOW GUIDE ================\n\n"
    + _load_h3_guide()
)

CHAT_SYSTEM = (
    "You are the local AI assistant inside AI Video Studio. "
    "You can answer ordinary questions, but your specialist domain is MiniMax H3 video generation. "
    "Use the user's language. For H3 work, follow the local expert instructions and workflow guide exactly. "
    "Return only the useful final answer; never reveal hidden reasoning.\n\n"
    + H3_EXPERT_GUIDE
)

CONTROL_SYSTEM = (
    "You are the CONTROL agent for AI Video Studio. "
    "Understand the request using the local H3 expert guide, then return ONLY one valid JSON object. "
    "No Markdown, no code fences, no prose outside JSON. "
    "Shape: "
    '{"message":"short explanation in the user language","changes":{...}}. '
    "Only include fields that truly need to change. "
    "Never fabricate uploaded files, reference media or Character IDs. "
    "You may select only Character IDs present in AVAILABLE_CHARACTERS. "
    "If the user asks for a production-ready prompt, put it in changes.prompt and write changes.prompt in ENGLISH only, except exact dialogue/lyrics/on-screen text. "
    "If no form change is required, return an empty changes object.\n\n"
    + H3_EXPERT_GUIDE
    + r"""

ALLOWED CHANGE KEYS
prompt: string
generation_mode: frames | reference | multiframe | digital_human
seconds: number 1..30
fps: integer 6..32
steps: even integer 6..24
seed: integer -1..4294967295
generate_audio: boolean
resolution_shape: 1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 9:16 | 16:9 | 21:9
resolution: string WIDTHxHEIGHT; set only if that exact option exists in CURRENT_GENERATOR_STATE/UI
reference_task: reference_generation | keyframe_completion | video_editing | video_continuation | audio_reuse | audio_reference | timeline_guides
ref_image_size: match | 1k | 1.5k | 2k | original
control_mode: none | canny_auto | canny | pose | depth | hed | mlsd | inpaint
control_strength: number 0..10
control_start_percent: number 0..1
control_end_percent: number 0..1
control_canny_low: number 0.01..0.99
control_canny_high: number 0.01..0.99
selected_character_ids: array of IDs from AVAILABLE_CHARACTERS
""".strip()
)

GENERATION_MODES = {"frames", "reference", "multiframe", "digital_human"}
RATIOS = {"1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"}
REFERENCE_TASKS = {
    "reference_generation",
    "keyframe_completion",
    "video_editing",
    "video_continuation",
    "audio_reuse",
    "audio_reference",
    "timeline_guides",
}
REF_SIZES = {"match", "1k", "1.5k", "2k", "original"}
CONTROL_MODES = {"none", "canny_auto", "canny", "pose", "depth", "hed", "mlsd", "inpaint"}


class AssistantUnavailable(RuntimeError):
    pass


def _safe_json(response: requests.Response) -> dict[str, Any]:
    try:
        data = response.json()
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def status() -> dict[str, Any]:
    manager: dict[str, Any] = {}
    try:
        response = requests.get(f"{LLM_MANAGER_URL}/status", timeout=1.5)
        if response.ok:
            manager = _safe_json(response)
    except requests.RequestException:
        pass

    online = False
    loading = False
    try:
        response = requests.get(f"{LLM_URL}/health", timeout=1.5)
        online = response.ok
        loading = response.status_code == 503
    except requests.RequestException:
        pass

    return {
        "online": online,
        "loading": loading,
        "target": manager.get("target"),
        "llama_alive": bool(manager.get("llama_alive")),
        "reserved_gpus": manager.get("reserved_gpus") or [],
    }


def ensure_available() -> None:
    current = status()
    if not current["online"]:
        target = current.get("target") or "неизвестно"
        state = "модель загружается" if current.get("loading") else "LLM недоступна"
        raise AssistantUnavailable(f"{state} ({target}). Повторите через несколько секунд.")


def normalize_messages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, str]] = []
    total = 0
    for item in reversed(value):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        content = content[:8000]
        if total + len(content) > MAX_HISTORY_CHARS and normalized:
            break
        total += len(content)
        normalized.append({"role": role, "content": content})
        if len(normalized) >= MAX_HISTORY_MESSAGES:
            break
    normalized.reverse()
    while normalized and normalized[0]["role"] == "assistant":
        normalized.pop(0)
    return normalized


def _fallback_token_count(text: str) -> int:
    # Conservative fallback for mixed Russian/English H3 text.
    return max(1, int(math.ceil(len(text) / 3.2)))


def _token_count(text: str) -> int:
    if not text:
        return 0
    try:
        response = requests.post(
            f"{LLM_URL}/tokenize",
            json={"content": text},
            timeout=2.5,
        )
        if response.ok:
            data = _safe_json(response)
            tokens = data.get("tokens")
            if isinstance(tokens, list):
                return len(tokens)
            count = data.get("count")
            if isinstance(count, int):
                return count
    except requests.RequestException:
        pass
    return _fallback_token_count(text)


def _messages_token_count(messages: list[dict[str, str]]) -> int:
    if not messages:
        return 0
    combined = "\n".join(
        f"{item.get('role', 'message')}: {item.get('content', '')}"
        for item in messages
    )
    return _token_count(combined) + len(messages) * 6 + 8


def _trim_history_to_context(
    system_messages: list[dict[str, str]],
    history: list[dict[str, str]],
    *,
    max_tokens: int,
) -> tuple[list[dict[str, str]], dict[str, int]]:
    system_tokens = _messages_token_count(system_messages)
    budget = max(
        1024,
        CONTEXT_TOKENS - int(max_tokens) - CONTEXT_SAFETY_TOKENS - system_tokens,
    )
    kept = list(history)
    token_counts = [
        _token_count(f"{item.get('role', 'message')}: {item.get('content', '')}") + 6
        for item in kept
    ]
    current_history_tokens = sum(token_counts)
    dropped = 0

    while current_history_tokens > budget and len(kept) > 1:
        remove_count = 1
        if (
            len(kept) >= 3
            and kept[0].get("role") == "user"
            and kept[1].get("role") == "assistant"
        ):
            remove_count = 2
        current_history_tokens -= sum(token_counts[:remove_count])
        del kept[:remove_count]
        del token_counts[:remove_count]
        dropped += remove_count

        while kept and kept[0].get("role") == "assistant" and len(kept) > 1:
            current_history_tokens -= token_counts[0]
            kept.pop(0)
            token_counts.pop(0)
            dropped += 1

    input_tokens = system_tokens + max(0, current_history_tokens)
    return kept, {
        "context_limit": CONTEXT_TOKENS,
        "estimated_tokens": input_tokens + int(max_tokens),
        "input_tokens": input_tokens,
        "reserved_output_tokens": int(max_tokens),
        "dropped_messages": dropped,
        "sent_messages": len(kept),
    }


def _settings_context(settings: Any) -> str:
    if not isinstance(settings, dict):
        return ""
    safe = {
        key: settings.get(key)
        for key in (
            "resolution",
            "resolution_shape",
            "seconds",
            "fps",
            "steps",
            "seed",
            "generate_audio",
            "generation_mode",
            "reference_task",
            "ref_image_size",
            "control_mode",
            "control_strength",
            "control_start_percent",
            "control_end_percent",
            "control_canny_low",
            "control_canny_high",
            "selected_character_ids",
        )
        if key in settings
    }
    if "prompt" in settings:
        safe["prompt"] = str(settings.get("prompt") or "")[:5000]
    available = settings.get("available_characters")
    if isinstance(available, list):
        safe["available_characters"] = [
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or ""),
                "description": str(item.get("description") or "")[:240],
                "voice": bool(item.get("voice")),
                "image_count": int(item.get("image_count") or 0),
            }
            for item in available[:20]
            if isinstance(item, dict) and item.get("id")
        ]
    return json.dumps(safe, ensure_ascii=False, separators=(",", ":"))


def _chat_payload(
    messages: Any,
    *,
    settings: Any = None,
    system_prompt: str = CHAT_SYSTEM,
    stream: bool,
    max_tokens: int,
    temperature: float,
    thinking: bool = False,
) -> dict[str, Any]:
    normalized = normalize_messages(messages)
    if not normalized or normalized[-1]["role"] != "user":
        raise ValueError("Сообщение пользователя отсутствует.")

    think_directive = "/think" if thinking else "/no_think"
    prepared: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt + "\n\n" + think_directive}
    ]
    settings_json = _settings_context(settings)
    if settings_json:
        prepared.append(
            {
                "role": "system",
                "content": "CURRENT_GENERATOR_STATE JSON:\n" + settings_json,
            }
        )
    prepared.append(
        {
            "role": "system",
            "content": (
                "HARD OUTPUT LANGUAGE RULE: If the user asks for, edits, generates, or applies a MiniMax H3 prompt, "
                "the H3 prompt itself MUST be entirely in English. Do not write scene/action/camera/sound instructions "
                "in Russian. Only exact spoken dialogue, exact lyrics, and exact visible on-screen text may remain in "
                "their requested language. Explanations outside the prompt should match the user's language."
            ),
        }
    )
    trimmed, _usage = _trim_history_to_context(
        prepared,
        normalized,
        max_tokens=max_tokens,
    )
    prepared.extend(trimmed)
    return {
        "model": MODEL_NAME,
        "stream": stream,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": prepared,
    }



def context_usage(
    messages: Any,
    *,
    settings: Any = None,
    thinking: bool = False,
) -> dict[str, int]:
    normalized = normalize_messages(messages)
    max_tokens = 1800 if thinking else 1000
    think_directive = "/think" if thinking else "/no_think"
    system_messages: list[dict[str, str]] = [
        {"role": "system", "content": CHAT_SYSTEM + "\n\n" + think_directive}
    ]
    settings_json = _settings_context(settings)
    if settings_json:
        system_messages.append(
            {
                "role": "system",
                "content": "CURRENT_GENERATOR_STATE JSON:\n" + settings_json,
            }
        )
    system_messages.append(
        {
            "role": "system",
            "content": (
                "HARD OUTPUT LANGUAGE RULE: MiniMax H3 production prompts are English; "
                "exact dialogue/lyrics/visible text keep the requested language."
            ),
        }
    )
    _kept, usage = _trim_history_to_context(
        system_messages,
        normalized,
        max_tokens=max_tokens,
    )
    usage["stored_messages"] = len(normalized)
    return usage

def stream_chat(
    messages: Any,
    *,
    settings: Any = None,
    thinking: bool = False,
) -> Iterator[bytes]:
    payload = _chat_payload(
        messages,
        settings=settings,
        stream=True,
        max_tokens=1800 if thinking else 1000,
        temperature=0.45,
        thinking=thinking,
    )
    try:
        with requests.post(
            f"{LLM_URL}/v1/chat/completions",
            json=payload,
            stream=True,
            timeout=(8, 300),
        ) as response:
            if not response.ok:
                data = _safe_json(response)
                raise AssistantUnavailable(
                    str(data.get("error") or data.get("detail") or f"LLM HTTP {response.status_code}")
                )
            think_buffer = ""
            hiding_think = False
            for raw_line in response.iter_lines(decode_unicode=False):
                if not raw_line or not raw_line.startswith(b"data:"):
                    continue
                try:
                    raw = raw_line[5:].strip().decode("utf-8")
                except UnicodeDecodeError:
                    continue
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                choices = event.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # llama.cpp may expose Qwen reasoning separately.
                # Never forward reasoning_content to the browser.
                content = delta.get("content")
                if not content:
                    continue

                think_buffer += str(content)
                while think_buffer:
                    if hiding_think:
                        close = think_buffer.lower().find("</think>")
                        if close < 0:
                            # Keep only a short suffix in case the closing tag is split across chunks.
                            think_buffer = think_buffer[-16:]
                            break
                        think_buffer = think_buffer[close + len("</think>"):]
                        hiding_think = False
                        continue

                    open_pos = think_buffer.lower().find("<think>")
                    if open_pos >= 0:
                        visible = think_buffer[:open_pos]
                        if visible:
                            yield visible.encode("utf-8")
                        think_buffer = think_buffer[open_pos + len("<think>"):]
                        hiding_think = True
                        continue

                    # Preserve a suffix that could be the beginning of a split <think> tag.
                    lower = think_buffer.lower()
                    keep = 0
                    for size in range(1, min(len("<think>") - 1, len(lower)) + 1):
                        if "<think>".startswith(lower[-size:]):
                            keep = size
                    visible = think_buffer[:-keep] if keep else think_buffer
                    if visible:
                        yield visible.encode("utf-8")
                    think_buffer = think_buffer[-keep:] if keep else ""
                    break

            if think_buffer and not hiding_think:
                yield think_buffer.encode("utf-8")
    except requests.RequestException as exc:
        raise AssistantUnavailable(f"Связь с локальной LLM прервана: {exc}") from exc


def _strip_think_blocks(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL).strip()


def _extract_json(text: str) -> dict[str, Any]:
    text = _strip_think_blocks(text).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        result = json.loads(text)
        return result if isinstance(result, dict) else {}
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            result = json.loads(text[start : end + 1])
            return result if isinstance(result, dict) else {}
        raise


def _request_control_content(payload: dict[str, Any]) -> str:
    primary = dict(payload)
    primary["response_format"] = {"type": "json_object"}
    for candidate in (primary, payload):
        try:
            response = requests.post(
                f"{LLM_URL}/v1/chat/completions",
                json=candidate,
                timeout=(8, 180),
            )
        except requests.RequestException as exc:
            raise AssistantUnavailable(f"Не удалось обратиться к локальной LLM: {exc}") from exc
        if not response.ok:
            if candidate is primary:
                continue
            data = _safe_json(response)
            raise AssistantUnavailable(
                str(data.get("error") or data.get("detail") or f"LLM HTTP {response.status_code}")
            )
        data = _safe_json(response)
        choices = data.get("choices") or []
        if not choices:
            raise AssistantUnavailable("LLM вернула пустой ответ.")
        content = (choices[0].get("message") or {}).get("content")
        if not content:
            raise AssistantUnavailable("LLM не вернула JSON управления.")
        return str(content)
    raise AssistantUnavailable("LLM не приняла запрос управления.")


def _int(value: Any, minimum: int, maximum: int) -> int | None:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return max(minimum, min(maximum, number))


def _float(value: Any, minimum: float, maximum: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return max(minimum, min(maximum, number))


def sanitize_changes(value: Any, *, valid_character_ids: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}

    prompt = value.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        result["prompt"] = prompt.strip()[:16000]

    mode = value.get("generation_mode")
    if mode in GENERATION_MODES:
        result["generation_mode"] = mode

    seconds = _float(value.get("seconds"), 1.0, 30.0)
    if seconds is not None:
        result["seconds"] = round(seconds, 2)

    fps = _int(value.get("fps"), 6, 32)
    if fps is not None:
        result["fps"] = fps

    steps = _int(value.get("steps"), 6, 24)
    if steps is not None:
        steps = max(6, min(24, int(round(steps / 2) * 2)))
        result["steps"] = steps

    seed = _int(value.get("seed"), -1, 4294967295)
    if seed is not None:
        result["seed"] = seed

    if isinstance(value.get("generate_audio"), bool):
        result["generate_audio"] = value["generate_audio"]

    ratio = value.get("resolution_shape")
    if ratio in RATIOS:
        result["resolution_shape"] = ratio

    resolution = value.get("resolution")
    if isinstance(resolution, str) and re.fullmatch(r"\d{3,4}x\d{3,4}", resolution):
        width, height = (int(part) for part in resolution.split("x", 1))
        if 256 <= width <= 3072 and 256 <= height <= 3072 and width % 32 == 0 and height % 32 == 0:
            result["resolution"] = resolution

    task = value.get("reference_task")
    if task in REFERENCE_TASKS:
        result["reference_task"] = task

    ref_size = value.get("ref_image_size")
    if ref_size in REF_SIZES:
        result["ref_image_size"] = ref_size

    control_mode = value.get("control_mode")
    if control_mode in CONTROL_MODES:
        result["control_mode"] = control_mode

    for key, minimum, maximum in (
        ("control_strength", 0.0, 10.0),
        ("control_start_percent", 0.0, 1.0),
        ("control_end_percent", 0.0, 1.0),
        ("control_canny_low", 0.01, 0.99),
        ("control_canny_high", 0.01, 0.99),
    ):
        number = _float(value.get(key), minimum, maximum)
        if number is not None:
            result[key] = round(number, 4)

    character_ids = value.get("selected_character_ids")
    if isinstance(character_ids, list):
        result["selected_character_ids"] = [
            str(item)
            for item in character_ids
            if str(item) in valid_character_ids
        ]

    return result


def control(
    messages: Any,
    *,
    settings: Any = None,
    characters: list[dict[str, Any]] | None = None,
    thinking: bool = False,
) -> dict[str, Any]:
    characters = characters or []
    valid_ids = {str(item.get("id")) for item in characters if item.get("id")}
    settings_payload = dict(settings) if isinstance(settings, dict) else {}
    settings_payload["available_characters"] = characters

    payload = _chat_payload(
        messages,
        settings=settings_payload,
        system_prompt=CONTROL_SYSTEM,
        stream=False,
        max_tokens=2200 if thinking else 1200,
        temperature=0.15,
        thinking=thinking,
    )
    content = _request_control_content(payload)
    try:
        decoded = _extract_json(content)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise AssistantUnavailable("LLM вернула некорректный JSON управления.") from exc

    message = str(decoded.get("message") or "Настройки обновлены.").strip()[:4000]
    changes = sanitize_changes(decoded.get("changes"), valid_character_ids=valid_ids)
    return {"message": message, "changes": changes}
