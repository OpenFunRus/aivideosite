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

PROMPT WRITING — HARD LANGUAGE AND FORMAT RULES
- Production prompt first; explanation/settings second.
- EVERY production-ready MiniMax H3 prompt MUST be written in ENGLISH, regardless of the user's language.
- The ONLY exception is literal content: exact dialogue, exact lyrics and exact visible on-screen text.
- Exact dialogue uses a stable speaker ID and language tag: (S1) ... <d>[Russian] точная реплика</d>.
- For normal V2 prompt fields and MAGIC WAND output, use the canonical THREE fields in this exact order:
  integrated_multimodal_description:
  overall_soundscape:
  non_diegetic_music:
  Leave a blank line between fields.
- In Ref2VA/Characters/Continue/Audio workspaces, DO NOT invent subject_definitions, Picture/Video/Audio ordinals,
  summary or retention_analysis. The server owns real attached-reference mapping and promotes the three-field
  prompt into the six-field Ref2VA schema safely.
- Only write an explicit six-field Ref2VA prompt when the user explicitly asks for the full low-level prompt
  AND the actual reference mapping is known.
- [Shot 1] has no timestamp. Every later cut uses an increasing exact time:
  [Shot 2] At 00:04.000, the camera cuts to...
- The shot timeline must fit the selected duration exactly; the final shot runs to the end.
- Start each shot with concrete style/framing/subject state. Use one primary camera behavior per shot.
- Camera moves are sentences, not keyword piles: static shot, push in/pull out, pan, truck, tilt,
  pedestal, arc shot, tracking shot, POV, roll, or controlled shake.
- Write observable actions in chronological order and make motion measurable when useful.
- State the final pose/state explicitly when continuity matters.
- Sounds caused by visible actions belong in the shot description.
- Constant ambience/weather/crowd/room tone belongs in overall_soundscape.
- Audience-only score belongs only in non_diegetic_music. Use N/A when no score is wanted.
- Do not use vague music mood words alone; describe instruments, tempo/rhythm and dynamics.
- For external master-track workflows (Audio / Continue Clip), non_diegetic_music is normally N/A:
  the master track is an input/muxed track, not music H3 should invent again.
- Use concrete exclusions as sentences (for example no subtitles/on-screen text/watermarks) instead of
  pretending there is a separate negative-prompt field.
- Keep Character identity, clothing, markings, props, handedness and voices consistent.
- Never confuse a Ref2VA semantic Picture with an exact Timeline Guide.
- Never mix FL2VA and Ref2VA schemas casually.

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
    "You are the conversational assistant inside AI Video Studio V2. "
    "This endpoint is CHAT, not form control and not Magic Wand. "
    "Talk naturally in the user's language, answer questions, brainstorm, explain choices, troubleshoot, "
    "and give practical advice about the site, video ideas and MiniMax H3. "
    "Do NOT behave like an autonomous operator: do not claim you changed a form, selected files, characters, "
    "settings or started a job. Do not return control JSON. "
    "Do not force every answer into H3 prompt fields. Only produce a copy-ready production prompt when the user "
    "explicitly asks for a prompt or asks you to rewrite one; otherwise discuss the idea normally first. "
    "When a production H3 prompt is explicitly requested, follow the reference guide below accurately. "
    "Keep answers conversational and useful; avoid repetitive boilerplate. Never reveal hidden reasoning.\n\n"
    "================ H3 REFERENCE KNOWLEDGE (use when relevant) ================\n\n"
    + _load_h3_guide()
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
    "If the user asks for a production-ready prompt for a V2 prompt field, put it in changes.prompt using the canonical three fields integrated_multimodal_description / overall_soundscape / non_diegetic_music in that exact order. All THREE fields are mandatory, even when one or both sound fields are N/A. Write it in ENGLISH only, except exact dialogue/lyrics/on-screen text. Preserve every concrete user fact exactly: numeric age, count, direction, handedness, props, weather, requested actions and exact dialogue. Do not generalize 35 to early 30s. Do not invent thunder, footsteps, extra actions, music, people or environmental events that the user did not request. If the described camera changes to a new framing via a cut/switch, represent it as a new [Shot N] with an exact increasing timestamp. Do not invent low-level Ref2VA labels or ordinals; the backend maps real references. "
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
            "workspace",
            "has_first_frame",
            "has_last_frame",
            "embed_track",
            "generate_scene_audio",
            "audio_start",
            "audio_end",
            "quality",
            "source_kind",
            "source_title",
            "source_prompt",
            "source_duration",
            "source_workspace",
            "master_track_title",
            "has_visual_reference",
        )
        if key in settings
    }
    if "prompt" in settings:
        safe["prompt"] = str(settings.get("prompt") or "")[:5000]
    if "source_prompt" in settings:
        safe["source_prompt"] = str(settings.get("source_prompt") or "")[:5000]
    if "source_title" in settings:
        safe["source_title"] = str(settings.get("source_title") or "")[:300]
    if "master_track_title" in settings:
        safe["master_track_title"] = str(settings.get("master_track_title") or "")[:300]
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
    max_tokens = 2400 if thinking else 1400
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
        max_tokens=2400 if thinking else 1400,
        temperature=0.58,
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


def _request_plain_content(payload: dict[str, Any]) -> str:
    candidate = dict(payload)
    candidate.pop("response_format", None)
    try:
        response = requests.post(
            f"{LLM_URL}/v1/chat/completions",
            json=candidate,
            timeout=(8, 180),
        )
    except requests.RequestException as exc:
        raise AssistantUnavailable(f"Не удалось обратиться к локальной LLM: {exc}") from exc
    if not response.ok:
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
        raise AssistantUnavailable("LLM не вернула текст.")
    return str(content)


def _extract_h3_prompt_text(content: str) -> str:
    text = _strip_think_blocks(str(content or "")).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:text|txt|markdown|md)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)

    try:
        decoded = _extract_json(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        decoded = {}
    if isinstance(decoded, dict):
        changes = decoded.get("changes")
        if isinstance(changes, dict):
            prompt = changes.get("prompt")
            if isinstance(prompt, str) and prompt.strip():
                return prompt.strip()
        prompt = decoded.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return prompt.strip()

    if "\\n" in text and "\n" not in text:
        text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\\"", "\"")

    lowered = text.lower()
    start = lowered.find("integrated_multimodal_description:")
    if start < 0:
        raise AssistantUnavailable("LLM не вернула H3 prompt.")
    prompt = text[start:].strip()
    prompt = re.sub(r"\s*```+\s*$", "", prompt).strip()
    if prompt.endswith('\"}') or prompt.endswith("'}"):
        prompt = prompt[:-2].rstrip()
    return prompt[:16000]


_V2_WAND_WORKSPACES = {"create", "continue", "audio", "clip"}

def _v2_wand_system() -> str:
    return (
        "You are the dedicated MiniMax H3 Magic Wand for AI Video Site V2. "
        "Return ONLY the final H3 prompt text. No JSON, no Markdown fences, no explanation. "
        "The output MUST contain exactly these three fields in this exact order: "
        "integrated_multimodal_description, overall_soundscape, non_diegetic_music. "
        "Write H3 production instructions in English, but keep exact dialogue, lyrics and exact visible text "
        "in their requested language. Preserve every concrete user fact exactly: numeric age/count, direction, "
        "handedness, props, weather, requested actions, camera request and exact dialogue. Do not invent extra "
        "sounds, actions, people, objects, weather events, emotions, music or a specific source for an unspecified noise. "
        "[Shot 1] has no timestamp. Every later camera cut/switch starts a new [Shot N] with an exact increasing "
        "timestamp that fits CURRENT_GENERATOR_STATE.seconds. If music was not requested, non_diegetic_music: N/A. "
        "If CURRENT_GENERATOR_STATE.generate_audio is false, both sound fields are exactly N/A. "
        "Never output subject_definitions, summary, retention_analysis or detailed_description; the backend owns Ref2VA mapping. "
        "Follow the workspace-specific user instruction and the H3 reference guide below.\n\n"
        + H3_EXPERT_GUIDE
    )


def _generate_v2_wand_prompt(
    messages: Any,
    *,
    settings_payload: dict[str, Any],
    thinking: bool,
) -> str:
    payload = _chat_payload(
        messages,
        settings=settings_payload,
        system_prompt=_v2_wand_system(),
        stream=False,
        max_tokens=2800 if thinking else 1800,
        temperature=0.08,
        thinking=thinking,
    )
    return _extract_h3_prompt_text(_request_plain_content(payload))

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



_V2_PROMPT_LABELS = (
    "integrated_multimodal_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)


def _v2_prompt_validation_issues(prompt: str, settings: dict[str, Any]) -> list[str]:
    text = str(prompt or "").strip()
    lowered = text.lower()
    issues: list[str] = []

    positions = [lowered.find(label) for label in _V2_PROMPT_LABELS]
    if any(position < 0 for position in positions):
        missing = [
            label[:-1]
            for label, position in zip(_V2_PROMPT_LABELS, positions)
            if position < 0
        ]
        issues.append("missing mandatory field(s): " + ", ".join(missing))
    elif positions != sorted(positions):
        issues.append("the three mandatory fields are not in canonical order")

    for label in _V2_PROMPT_LABELS:
        if lowered.count(label) != 1:
            issues.append(f"{label[:-1]} must appear exactly once")

    if "[shot 1]" not in lowered:
        issues.append("integrated_multimodal_description must contain [Shot 1]")

    shot_matches = list(re.finditer(r"\[shot\s+(\d+)\]", text, flags=re.IGNORECASE))
    previous_time = -1.0
    selected_seconds = _float(settings.get("seconds"), 1.0, 30.0) or 0.0
    for index, match in enumerate(shot_matches):
        shot_number = int(match.group(1))
        if index == 0 and shot_number != 1:
            issues.append("the first shot must be [Shot 1]")
        if shot_number >= 2:
            segment_end = shot_matches[index + 1].start() if index + 1 < len(shot_matches) else len(text)
            segment = text[match.end():segment_end]
            timestamp = re.search(
                r"\bat\s+(\d{2}):(\d{2})(?:\.(\d{1,3}))?",
                segment,
                flags=re.IGNORECASE,
            )
            if not timestamp:
                issues.append(f"[Shot {shot_number}] requires an exact 'At 00:SS.mmm' timestamp")
                continue
            minutes = int(timestamp.group(1))
            seconds = int(timestamp.group(2))
            millis = int((timestamp.group(3) or "0").ljust(3, "0")[:3])
            moment = minutes * 60 + seconds + millis / 1000.0
            if moment <= previous_time:
                issues.append("shot timestamps must be strictly increasing")
            if selected_seconds and moment >= selected_seconds:
                issues.append(
                    f"shot timestamp {moment:.3f}s must be inside the selected {selected_seconds:g}s duration"
                )
            previous_time = moment

    if len(shot_matches) <= 1 and re.search(
        r"\b(?:camera\s+cuts?|cuts?\s+to|camera\s+switches?|switches?\s+to\s+(?:a|an|the)\s+(?:close|medium|wide|long|extreme))\b",
        lowered,
    ):
        issues.append("a described camera cut/switch must start a new timed [Shot N]")

    forbidden_ref2va = (
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
    )
    if any(label in lowered for label in forbidden_ref2va):
        issues.append("normal V2 Magic Wand output must not contain low-level Ref2VA wrapper fields")

    if settings.get("generate_audio") is False:
        sound_match = re.search(
            r"overall_soundscape:\s*(.*?)(?=\n\s*non_diegetic_music:|\Z)",
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
        music_match = re.search(
            r"non_diegetic_music:\s*(.*)\Z",
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not sound_match or sound_match.group(1).strip().upper() != "N/A":
            issues.append("generate_audio is off, so overall_soundscape must be exactly N/A")
        if not music_match or music_match.group(1).strip().upper() != "N/A":
            issues.append("generate_audio is off, so non_diegetic_music must be exactly N/A")

    return issues


def _decode_control_json(content: str) -> dict[str, Any]:
    try:
        return _extract_json(content)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise AssistantUnavailable("LLM вернула некорректный JSON управления.") from exc


def _repair_control_prompt(
    original_messages: Any,
    *,
    settings_payload: dict[str, Any],
    bad_prompt: str,
    issues: list[str],
    thinking: bool,
) -> dict[str, Any]:
    source_text = _wand_source_text(original_messages)
    repair_system = (
        "You are a dedicated H3 PROMPT REPAIR agent. Return ONLY the repaired H3 prompt text. "
        "No JSON, no Markdown, no explanation. The prompt MUST contain exactly three fields in order: "
        "integrated_multimodal_description, overall_soundscape, non_diegetic_music. "
        "Preserve every concrete SOURCE fact exactly and remove every unsupported detail. "
        "Never invent thunder, footsteps, traffic, wind, extra actions, people, objects, music, emotions, "
        "or a specific source for an unspecified noise. Keep exact dialogue/lyrics/visible text unchanged. "
        "[Shot 1] has no timestamp; every later cut/switch uses a new timed [Shot N] inside the selected duration. "
        "If generate_audio is false, both sound fields are N/A. If music was not requested, non_diegetic_music is N/A. "
        "Do not output low-level Ref2VA wrapper fields."
    )
    repair_user = (
        "SOURCE USER REQUEST:\n"
        + source_text[:12000]
        + "\n\nVALIDATION / FAITHFULNESS ERRORS:\n- "
        + "\n- ".join(issues[:12])
        + "\n\nINVALID H3 PROMPT:\n"
        + bad_prompt[:16000]
        + "\n\nReturn only the corrected H3 prompt."
    )
    payload = _chat_payload(
        [{"role": "user", "content": repair_user}],
        settings=settings_payload,
        system_prompt=repair_system,
        stream=False,
        max_tokens=2800 if thinking else 1800,
        temperature=0.0,
        thinking=thinking,
    )
    prompt = _extract_h3_prompt_text(_request_plain_content(payload))
    return {"message": "исправлено", "changes": {"prompt": prompt}}

def _wand_source_text(messages: Any) -> str:
    normalized = normalize_messages(messages)
    if not normalized:
        return ""
    content = str(normalized[-1].get("content") or "").strip()
    if "\n\n" in content:
        tail = content.rsplit("\n\n", 1)[-1].strip()
        if tail:
            return tail[:12000]
    return content[:12000]


def _clean_v2_wand_prompt(
    original_messages: Any,
    *,
    settings_payload: dict[str, Any],
    candidate_prompt: str,
    thinking: bool,
) -> str:
    source_text = _wand_source_text(original_messages)
    cleanup_system = (
        "You are the final cleanup pass for a MiniMax H3 prompt. SOURCE is the absolute truth. "
        "Return ONLY the cleaned H3 prompt text. No JSON, no Markdown, no explanation. "
        "Keep exactly three fields in this order: integrated_multimodal_description, overall_soundscape, non_diegetic_music. "
        "Preserve all concrete SOURCE facts exactly: numeric age/count, direction, handedness, props, weather, actions, camera request, dialogue, lyrics and visible text. "
        "REMOVE every detail not explicitly supported by SOURCE. Do not enrich the scene from common sense. "
        "Do not add thunder, footsteps, traffic, wind, branch snaps, extra people, extra actions, extra objects, emotions, or a named source for an unspecified noise unless SOURCE says so. "
        "overall_soundscape may contain ONLY sounds explicitly supported by SOURCE; if SOURCE provides no sound at all, use N/A. "
        "If SOURCE says music is not wanted, non_diegetic_music must be N/A. "
        "[Shot 1] has no timestamp. If SOURCE explicitly requests a camera switch/cut/new framing, represent that switch as a new [Shot N] with an exact timestamp inside CURRENT_GENERATOR_STATE.seconds. "
        "Do not output low-level Ref2VA wrapper fields."
    )
    cleanup_user = (
        "SOURCE USER REQUEST:\n"
        + source_text[:12000]
        + "\n\nDRAFT H3 PROMPT:\n"
        + candidate_prompt[:16000]
        + "\n\nRewrite the draft faithfully to SOURCE and return only the final H3 prompt."
    )
    payload = _chat_payload(
        [{"role": "user", "content": cleanup_user}],
        settings=settings_payload,
        system_prompt=cleanup_system,
        stream=False,
        max_tokens=2800 if thinking else 1800,
        temperature=0.0,
        thinking=thinking,
    )
    return _extract_h3_prompt_text(_request_plain_content(payload))


def _source_literal_validation_issues(
    source_text: str,
    candidate_prompt: str,
) -> list[str]:
    source = str(source_text or "")
    prompt = str(candidate_prompt or "")
    issues: list[str] = []

    # Concrete numbers from the user's own text must survive the rewrite.
    source_numbers = {m.group(0).replace(",", ".") for m in re.finditer(r"(?<![\w])\d+(?:[\.,]\d+)?(?![\w])", source)}
    prompt_numbers = {m.group(0).replace(",", ".") for m in re.finditer(r"(?<![\w])\d+(?:[\.,]\d+)?(?![\w])", prompt)}
    missing_numbers = sorted(source_numbers - prompt_numbers)
    if missing_numbers:
        issues.append("missing exact source number(s): " + ", ".join(missing_numbers[:8]))

    # Exact quoted content (dialogue / visible text) must remain verbatim.
    quoted: list[str] = []
    for pattern in (r"«([^»\n]{1,500})»", r"“([^”\n]{1,500})”", r'"([^"\n]{1,500})"'):
        quoted.extend(match.group(1).strip() for match in re.finditer(pattern, source) if match.group(1).strip())
    for literal in quoted:
        if literal not in prompt:
            issues.append("missing exact quoted source text: " + literal[:120])

    source_lower = source.lower()
    no_music = any(
        phrase in source_lower
        for phrase in (
            "музыки не надо", "без музыки", "музыка не нужна", "музыку не надо",
            "no music", "without music", "music is not needed",
        )
    )
    if no_music:
        music = re.search(
            r"non_diegetic_music:\s*(.*)\Z",
            prompt,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not music or music.group(1).strip().upper() != "N/A":
            issues.append("source explicitly requests no music, so non_diegetic_music must be N/A")

    return issues

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

    workspace = str(settings_payload.get("workspace") or "").strip().lower()
    if workspace in _V2_WAND_WORKSPACES:
        prompt = _generate_v2_wand_prompt(
            messages,
            settings_payload=settings_payload,
            thinking=thinking,
        )
        prompt = _clean_v2_wand_prompt(
            messages,
            settings_payload=settings_payload,
            candidate_prompt=prompt,
            thinking=thinking,
        )
        source_text = _wand_source_text(messages)
        issues = _v2_prompt_validation_issues(prompt, settings_payload)
        issues.extend(_source_literal_validation_issues(source_text, prompt))
        if issues:
            repaired = _repair_control_prompt(
                messages,
                settings_payload=settings_payload,
                bad_prompt=prompt,
                issues=issues,
                thinking=thinking,
            )
            prompt = str((repaired.get("changes") or {}).get("prompt") or "").strip()
            repaired_issues = _v2_prompt_validation_issues(prompt, settings_payload)
            repaired_issues.extend(_source_literal_validation_issues(source_text, prompt))
            if repaired_issues:
                raise AssistantUnavailable(
                    "Локальная LLM не смогла собрать корректный H3 prompt: "
                    + "; ".join(repaired_issues[:4])
                )
        return {"message": "Промт подготовлен.", "changes": {"prompt": prompt}}

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
    decoded = _decode_control_json(content)
    message = str(decoded.get("message") or "Настройки обновлены.").strip()[:4000]
    changes = sanitize_changes(decoded.get("changes"), valid_character_ids=valid_ids)
    return {"message": message, "changes": changes}
