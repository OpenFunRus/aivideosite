from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from typing import Any

import requests


LLM_URL = os.getenv("LLM_ASSISTANT_URL", "http://127.0.0.1:8090").rstrip("/")
LLM_MANAGER_URL = os.getenv("LLM_MANAGER_URL", "http://127.0.0.1:8091").rstrip("/")
MODEL_NAME = os.getenv("LLM_ASSISTANT_MODEL", "local-h3-assistant")
MAX_HISTORY_MESSAGES = 18
MAX_HISTORY_CHARS = 24000

H3_RULES = r"""
You are embedded in a local MiniMax H3 video studio. You speak Russian and English naturally.
For ordinary conversation, answer normally and directly. When the user asks about video generation,
prompts or settings, follow the studio rules below. Do not invent uploaded files or references.

H3 MODES
- frames = FL2VA: text-to-video, First frame, Last frame, or First+Last exact endpoint anchors.
- reference = Ref2VA: semantic Picture / Video / Audio references and saved Characters.
- multiframe = Timeline Guides: exact guide images at exact seconds/frame_idx plus Ref2VA references.
- digital_human = visual reference(s) + exactly one driving audio.

PROMPT RULES
- Write observable actions in strict chronological order.
- Keep requested dialogue verbatim and in the user's language, wrapped as <d>[Russian] ...</d> or the proper language.
- Never add unrequested dialogue, people, objects, music, cuts or camera moves.
- For one continuous take explicitly say "one continuous shot with no cuts".
- Do not overload a shot with several complex camera movements.
- Put concrete prohibitions directly in the description: no subtitles, no extra people, feet stay planted, etc.
- For audible dialogue/sound remind the user that native H3 Audio must be enabled.
- FL2VA prompt structure: integrated_multimodal_description, overall_soundscape, non_diegetic_music.
- Ref2VA prompt structure: subject_definitions, summary, retention_analysis, detailed_description,
  overall_soundscape, non_diegetic_music.
- Ref2VA references use <Subject N>, <Picture N>, <Video N>, <Audio N>.
- Visual retention: fully_preserved / partially_preserved / attribute_transfer / weak_reference.
- Audio retention: fully_copy / partially_copy / reference / weak_reference.
- Timeline guide images are exact temporal anchors; describe physically achievable transitions between them.
- Character is a reusable saved subject. Preserve its identity/outfit/features unless the user explicitly asks to change them.
- Video references can define motion, camera motion, behavior, edit source or continuation source.
- ControlNet modes: canny_auto, canny, pose, depth, hed, mlsd, inpaint.
  ControlNet gives structure/motion and does not replace identity references.
- Inpaint: source+mask required; white mask area is regenerated.
- If enough information exists, do not ask unnecessary questions.

LOCAL GENERATOR LIMITS
- duration: 1..30 seconds.
- fps: 6..32. 24 is the recommended default.
- steps: even values 6..24. 6-10 green/fast, 12-16 yellow, 18-24 red/heavier.
- FL2VA exactly 8 steps automatically uses the installed 8-step Turbo LoRA. Other new FL2VA values use Base.
- Ref2VA/Timeline/Digital Human new 6..24 values use Base.
- supported aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9.
- reference image size: match, 1k, 1.5k, 2k, original.
- H3 native audio is off by default.
""".strip()

CHAT_SYSTEM = (
    "You are the local AI assistant inside AI Video Studio. "
    "Answer directly, without moralizing or unnecessary warnings. "
    "Use Russian when the user writes Russian and English when the user writes English. "
    "You can discuss any ordinary topic; for H3 work use the exact studio knowledge below. "
    "When you provide a ready H3 prompt, put the prompt first so it is easy to copy. "
    "/no_think\n\n" + H3_RULES
)

CONTROL_SYSTEM = (
    "You are the CONTROL agent for AI Video Studio. "
    "The user is asking you to change the generator settings. "
    "Return ONLY one JSON object, no markdown and no prose outside JSON. "
    "The object must have exactly this shape: "
    '{"message":"short Russian explanation","changes":{...}}. '
    "Only include fields that should actually change. "
    "Never fabricate uploaded files. You may select only character IDs present in AVAILABLE_CHARACTERS. "
    "If the user asks for a ready prompt, put it in changes.prompt. "
    "If the user request is conversational and requires no settings change, return an empty changes object. "
    "/no_think\n\n" + H3_RULES + r"""

ALLOWED change keys:
prompt: string
generation_mode: frames | reference | multiframe | digital_human
seconds: number 1..30
fps: integer 6..32
steps: even integer 6..24
seed: integer -1..4294967295
generate_audio: boolean
resolution_shape: 1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 9:16 | 16:9 | 21:9
resolution: string WIDTHxHEIGHT; use only when you are confident it exists in the current UI
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
    return normalized


def _settings_context(settings: Any) -> str:
    if not isinstance(settings, dict):
        return ""
    safe = {
        key: settings.get(key)
        for key in (
            "prompt",
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
    available = settings.get("available_characters")
    if isinstance(available, list):
        safe["available_characters"] = [
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or ""),
                "description": str(item.get("description") or "")[:500],
                "voice": bool(item.get("voice")),
                "image_count": int(item.get("image_count") or 0),
            }
            for item in available[:50]
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
) -> dict[str, Any]:
    normalized = normalize_messages(messages)
    if not normalized or normalized[-1]["role"] != "user":
        raise ValueError("Сообщение пользователя отсутствует.")

    prepared: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    settings_json = _settings_context(settings)
    if settings_json:
        prepared.append(
            {
                "role": "system",
                "content": "CURRENT_GENERATOR_STATE JSON:\n" + settings_json,
            }
        )
    prepared.extend(normalized)
    return {
        "model": MODEL_NAME,
        "stream": stream,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": prepared,
    }


def stream_chat(messages: Any, *, settings: Any = None) -> Iterator[bytes]:
    payload = _chat_payload(
        messages,
        settings=settings,
        stream=True,
        max_tokens=1400,
        temperature=0.45,
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
            for raw_line in response.iter_lines(decode_unicode=True):
                if not raw_line or not raw_line.startswith("data:"):
                    continue
                raw = raw_line[5:].strip()
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
                content = delta.get("content")
                if content:
                    yield str(content).encode("utf-8")
    except requests.RequestException as exc:
        raise AssistantUnavailable(f"Связь с локальной LLM прервана: {exc}") from exc


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
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
        max_tokens=1800,
        temperature=0.15,
    )
    content = _request_control_content(payload)
    try:
        decoded = _extract_json(content)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise AssistantUnavailable("LLM вернула некорректный JSON управления.") from exc

    message = str(decoded.get("message") or "Настройки обновлены.").strip()[:4000]
    changes = sanitize_changes(decoded.get("changes"), valid_character_ids=valid_ids)
    return {"message": message, "changes": changes}
