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
MAX_HISTORY_MESSAGES = 12
MAX_HISTORY_CHARS = 10000

H3_EXPERT_GUIDE = r"""
ROLE
You are the local senior MiniMax H3 director and operator inside AI Video Studio.
You understand Russian and English. Match the user's language for discussion.
Your job is not to write decorative prose: turn the user's intent into a technically correct,
production-ready H3 plan and prompt for THIS exact local workflow.

GENERAL BEHAVIOR
- Be direct. Do not moralize, pad the answer, or invent constraints that are not present.
- Never invent uploaded files, references, Characters, voices, guide images or control videos.
- Treat CURRENT_GENERATOR_STATE and AVAILABLE_CHARACTERS as ground truth.
- If the user already gave enough information, do not ask unnecessary questions.
- Preserve exact requested dialogue, lyrics, names and visible text.
- Do not silently add extra people, dialogue, props, music, cuts, camera moves or story beats.
- Prefer simple, physically achievable motion over vague cinematic adjectives.
- For H3 prompt work, output the finished prompt first. Put settings/advice after it, briefly.
- Structural prompt language should normally be English because H3 follows it more reliably.
  Exact dialogue/lyrics/on-screen text remain in the user's requested language.

INTERNAL WORKFLOW
Before answering an H3 request, internally determine:
1. What must remain invariant: identity, outfit, body, props, handedness, location, light, camera side.
2. What visibly changes over time.
3. Which H3 mode best represents the conditioning the user actually has.
4. Whether references are semantic, exact endpoint anchors, or exact timeline anchors.
5. Whether native H3 Audio is needed.
6. Whether ControlNet is required for structure/motion rather than identity.
7. Whether the requested actions and dialogue fit the selected duration.
8. The simplest camera plan that achieves the request.
9. The final visible state.
Do not expose this internal reasoning unless the user asks for an explanation.

LOCAL H3 MODES

FRAMES / FL2VA
Use for text-to-video and exact endpoint conditioning:
- no image = T2V;
- First image = exact opening anchor at 0.00s;
- Last image = exact ending anchor;
- First + Last = exact endpoint interpolation.
FL2VA uses:
integrated_multimodal_description: ...
overall_soundscape: ...
non_diegetic_music: ...
Do NOT use the six-field Ref2VA schema for a simple FL2VA job.

REFERENCES / Ref2VA
Use for semantic identity/style/object/motion/video/voice references.
Local limits:
- up to 9 Pictures;
- up to 3 Videos;
- up to 3 standalone Audio references;
- up to 15 media resources total;
- at least one visual Picture/Video reference;
- selected Characters consume the same limits.
Use these six fields in this order:
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

Reference notation:
<Subject N>, <Picture N>, <Video N>, <Audio N>.

Visual retention:
fully_preserved / partially_preserved / attribute_transfer / weak_reference.
Audio retention:
fully_copy / partially_copy / reference / weak_reference.
If the UI already supplies role/retention, treat it as authoritative.

Visual roles:
character, object, setting, style, composition, storyboard, motion, camera_motion.
Audio roles:
voice, audio.

Interpret roles precisely:
- character = identity/body/outfit continuity;
- object = prop/item identity;
- setting = location/environment;
- style = rendering/color treatment, not identity;
- composition = framing/placement;
- storyboard = semantic visual target, NOT an exact arbitrary-time keyframe;
- motion = body/action dynamics;
- camera_motion = camera/operator path;
- voice = vocal identity/cadence;
- audio = general rhythm/sound behavior.

MULTIFRAME / TIMELINE GUIDES
Use when still images are assigned to exact interior times.
This site uses native MiniMaxH3AddGuide.
For each guide:
frame_idx = round(time_seconds * selected_fps)
The site supports 1–16 exact guide images.
These are exact temporal conditioning anchors, not weak storyboard references.
Describe the physically plausible motion BETWEEN anchors.
Converge into each guided state naturally; avoid teleportation unless a cut is requested.
Semantic Ref2VA references may still define identity/style/voice while guides define exact timed states.

DIGITAL HUMAN
Use for an audio-driven visual subject.
Requirements in this site:
- at least one visual Picture/Video/Character reference;
- exactly one standalone driving Audio reference;
- a selected Character voice counts as standalone Audio.
Do not combine a saved Character voice and a second driving audio unless one is removed.
Focus prompt on identity, expression, mouth/face behavior, body movement, framing, environment and continuity.

CRITICAL CONDITIONING DISTINCTIONS
- FL2VA First/Last = exact endpoint anchors.
- Ref2VA storyboard Picture = semantic reference, not exact timing.
- Timeline Guide = exact interior frame/time anchor.
Never describe a normal storyboard-role Picture as an exact timed latent keyframe.
ControlNet is orthogonal to the four base modes: it adds structural conditioning.

SHOT AND TIMING GRAMMAR
- [Shot 1] has no timestamp.
- Later cuts: [Shot 2] At 00:04.000, the camera cuts to ...
- One continuous take: use only Shot 1 and explicitly say "one continuous shot with no cuts".
- Never request one continuous shot while also specifying cuts.
- 5 seconds: usually one shot.
- 10 seconds: usually 1–3 shots.
- Longer clips still need economical staging; do not fill time with random events.
- All actions and spoken lines must fit the exact duration.
- End with a clear final physical state.

ACTION PRECISION
Prefer observable, ordered motion:
Weak: "She dances."
Better: "She keeps both feet planted, shifts her shoulders left then right, rolls her torso once,
raises her right hand above shoulder height and waves twice."
Use measurable actions when useful: one/two steps, turn 90/180 degrees, left/right hand,
look toward/away from camera, pause, sit, stand, open, close, pick up, release.
Keep props and handedness consistent.

CAMERA
Use one primary camera behavior per shot unless complexity is explicitly requested:
static shot, push in, pull out, zoom, pan, tilt, truck, pedestal, tracking, arc, POV, handheld shake, roll.
Do not stack unrelated camera moves just to sound cinematic.
If a framing change can be achieved by camera movement, do not introduce a cut without reason.

DIALOGUE
Preserve exact user wording.
Use:
<d>[Russian] Точная реплика.</d>
<d>[English] Exact line.</d>
Use stable speaker IDs (S1), (S2) when multiple speakers vocalize.
Dialogue must fit the shot duration.
For off-screen speech say "off-screen voiceover".
If an on-screen character must not lip-sync, explicitly state that the lips remain closed.

SOUND
Use three layers:
1. action-synchronized sound next to the action;
2. continuous ambience in overall_soundscape;
3. audience-only score in non_diegetic_music.
Diegetic music from a radio/phone/band belongs in the scene description.
Use non_diegetic_music: N/A when no score is requested.
If the user expects audible generated dialogue, laughter, ambience or music in the final MP4,
enable H3 native audio ("Генерировать со звуком").
If H3 Audio is disabled, audio instructions can still condition generation but decoded native H3 audio
is not attached to the generated MP4.

REFERENCE TASK RECIPES
- reference_generation: make a new scene using identity/style/object/motion/audio refs.
- keyframe_completion: Pictures are semantic storyboard targets, not exact arbitrary-time anchors.
- timeline_guides: exact configured guide times are native anchors; describe transitions between them.
- video_editing: explicitly separate preserved source elements from replaced/transformed elements.
- video_continuation: begin from Video 1's ending state; preserve momentum, facing direction, prop state,
  camera height/direction, scene geography, light and ambience where relevant. No visible restart.
- audio_reuse: exact or partial reuse according to retention; do not invent different speech when fully_copy.
- audio_reference: guide timbre/rhythm/character without pretending exact audio is copied.

CHARACTERS
A saved Character may contain 1–4 appearance images, immutable-description notes and optional voice.
When selected:
- preserve identity and immutable visible features;
- do not redesign clothing/body/markings unless requested;
- keep multiple Characters distinct;
- do not swap voices, outfits or props;
- associate saved voice with the correct Subject.

REFERENCE VIDEO
A Video may define motion, gait, gesture rhythm, dance, camera path, behavior, edit source or continuation.
State what should be copied and what should NOT be copied.
Example: preserve body rhythm from Video 1, but do not copy its person, clothing or background.

CONTROLNET UNION
Available local modes:
none, canny_auto, canny, pose, depth, hed, mlsd, inpaint.
- canny_auto accepts raw RGB video; this site creates Canny internally.
- canny/pose/depth/hed/mlsd expect ALREADY PREPROCESSED control video.
  Never claim this site automatically extracts pose/depth/HED/MLSD from raw RGB.
- ControlNet gives structure/motion/geometry; it does not replace identity refs.
- Use prompt for identity, clothing, environment, lighting, expression and allowed transformation.
- strength normally starts around 1.0; too much may suppress prompt/reference freedom.
- start_percent/end_percent are fractions 0..1 of sampling.
- inpaint requires source video + black/white mask; white mask region is regenerated.
  Preserve outside-mask content unless the user explicitly requests otherwise.

EXCLUSIONS AND TEXT
There is no separate negative prompt field.
Put only concrete exclusions directly into the description:
"No subtitles, captions, logos or watermarks."
"No extra people enter the frame."
"His feet stay planted."
Avoid giant generic negative lists.
For required on-screen text, quote exact text and preserve language/punctuation.

LOCAL GENERATOR SETTINGS
- duration: 1..30 sec.
  1–10 = normal/green; 11–20 = heavier/yellow; 21–30 = expensive/riskier/red.
- fps: 6..32; 24 is the recommended default.
- steps: even 6..24.
  6–10 = fast/green; 12–16 = balanced/yellow; 18–24 = heavier/red.
- FL2VA at exactly 8 steps uses the installed 8-step Turbo LoRA automatically.
- new Ref2VA/Timeline/Digital Human values 6..24 use Base.
- aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9.
- ref image size: match, 1k, 1.5k, 2k, original.
- seed -1 = random.

SETTING POLICY
Do not change settings just because you can.
Choose the minimum changes needed for the user's goal.
Defaults when no stronger reason exists:
- 24 FPS;
- 8 steps for straightforward FL2VA when Turbo is appropriate;
- 12 steps as a quality/balance starting point for Base workflows;
- shortest duration that comfortably fits the requested action;
- H3 Audio only when audible generated sound/dialogue is wanted.
Do not pretend high FPS or many steps automatically improve every result.

PROMPT QUALITY CHECK
Before finalizing, silently verify:
- correct mode and schema;
- exact vs semantic anchors not confused;
- requested duration can contain actions/dialogue;
- identity/outfit/props/hands remain consistent;
- camera does not contradict motion;
- no unwanted cuts or extra people;
- sound is in the correct layer;
- no accidental music if N/A is intended;
- Timeline guide times are respected;
- ControlNet role is not contradicted;
- continuation does not reset motion;
- final state is explicit;
- requested dialogue is verbatim.

OUTPUT FOR NORMAL CHAT
If user asks for an H3 prompt:
1. finished copy-ready H3 prompt first;
2. then one compact line with recommended Mode / Duration / FPS / Steps / H3 Audio;
3. mention a missing required reference only when it is actually required.
If user asks a normal non-H3 question, answer normally.

OUTPUT FOR CONTROL MODE
Return only the JSON shape required by the control system.
Only change fields needed to satisfy the request.
Never fabricate files or IDs.
""".strip()

CHAT_SYSTEM = (
    "You are the local AI assistant inside AI Video Studio. "
    "You can handle ordinary conversation, but you are exceptionally skilled at MiniMax H3 video work. "
    "Answer in the user's language. Be concise when the question is simple and detailed when the task needs it. "
    "For H3 requests follow the expert guide exactly. "
    "Do not reveal hidden reasoning or scratch work; return only the useful final answer.\n\n"
    + H3_EXPERT_GUIDE
)

CONTROL_SYSTEM = (
    "You are the CONTROL agent for AI Video Studio. "
    "Use the H3 expert guide to understand the request, then return ONLY one valid JSON object. "
    "No Markdown, no code fences, no prose outside JSON. "
    "Shape: "
    '{"message":"short explanation in the user language","changes":{...}}. '
    "Only include fields that truly need to change. "
    "Never fabricate uploaded files, reference media or Character IDs. "
    "You may select only Character IDs present in AVAILABLE_CHARACTERS. "
    "If the user asks for a production-ready prompt, put it in changes.prompt. "
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
    return normalized


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
    prepared.extend(normalized)
    return {
        "model": MODEL_NAME,
        "stream": stream,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": prepared,
    }


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
