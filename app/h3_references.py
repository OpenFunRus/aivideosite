from __future__ import annotations

import json
from typing import Any


MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
MAX_REFERENCE_MEDIA = 15

VISUAL_RETENTION = {
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
}
AUDIO_RETENTION = {
    "fully_copy",
    "partially_copy",
    "reference",
    "weak_reference",
}
REFERENCE_ROLES = {
    "character",
    "object",
    "setting",
    "style",
    "composition",
    "storyboard",
    "motion",
    "camera_motion",
    "voice",
    "audio",
}
REFERENCE_TASKS = {
    "reference_generation": "reference generation",
    "keyframe_completion": "keyframe completion",
    "video_editing": "video editing",
    "video_continuation": "video continuation",
    "audio_reuse": "audio reuse",
    "audio_reference": "audio reference",
}


def parse_reference_manifest(raw: str | None) -> dict[str, list[dict[str, str]]]:
    defaults = {"images": [], "videos": [], "audios": []}
    if not raw:
        return defaults
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return defaults
    if not isinstance(value, dict):
        return defaults

    result: dict[str, list[dict[str, str]]] = {}
    for key, media_type in (("images", "visual"), ("videos", "visual"), ("audios", "audio")):
        items = value.get(key)
        if not isinstance(items, list):
            result[key] = []
            continue
        normalized: list[dict[str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                normalized.append({})
                continue
            role = str(item.get("role") or "").strip().lower()
            if role not in REFERENCE_ROLES:
                role = "audio" if media_type == "audio" else "character"
            retention = str(item.get("retention") or "").strip().lower()
            allowed = AUDIO_RETENTION if media_type == "audio" else VISUAL_RETENTION
            if retention not in allowed:
                retention = "reference" if media_type == "audio" else "fully_preserved"
            note = str(item.get("note") or "").strip()
            normalized.append({"role": role, "retention": retention, "note": note})
        result[key] = normalized
    return result


def validate_reference_items(items: list[dict[str, Any]], *, digital_human: bool = False) -> None:
    counts = {"image": 0, "video": 0, "audio": 0}
    for item in items:
        media_type = str(item.get("type") or "")
        if media_type not in counts:
            raise ValueError("Unsupported reference media type.")
        counts[media_type] += 1

    if len(items) > MAX_REFERENCE_MEDIA:
        raise ValueError("Ref2VA supports at most 15 media resources.")
    if counts["image"] > MAX_REFERENCE_IMAGES:
        raise ValueError("Ref2VA supports at most 9 reference images.")
    if counts["video"] > MAX_REFERENCE_VIDEOS:
        raise ValueError("Ref2VA supports at most 3 reference videos.")
    if counts["audio"] > MAX_REFERENCE_AUDIOS:
        raise ValueError("Ref2VA supports at most 3 standalone audio clips.")

    if digital_human:
        if counts["image"] + counts["video"] < 1:
            raise ValueError("Digital Human needs at least one visual reference.")
        if counts["audio"] != 1:
            raise ValueError("Digital Human needs exactly one driving audio clip.")
    elif not items:
        raise ValueError("Ref2VA needs at least one reference resource.")
    elif counts["image"] + counts["video"] < 1:
        raise ValueError("Ref2VA needs at least one visual reference image or video.")


def _structured_reference_prompt(prompt: str) -> bool:
    lowered = prompt.lower()
    required = (
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
        "overall_soundscape:",
        "non_diegetic_music:",
    )
    return all(label in lowered for label in required)


def build_reference_prompt(
    prompt: str,
    *,
    task: str,
    items: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    """Return the prompt actually sent to H3 and a deterministic reference map.

    The Easy node presents references to H3 in this order:
    pictures, then videos (with each video soundtrack taking an Audio ordinal
    immediately before that Video), then standalone audios.
    """

    image_items = [item for item in items if item.get("type") == "image"]
    video_items = [item for item in items if item.get("type") == "video"]
    audio_items = [item for item in items if item.get("type") == "audio"]

    reference_map: list[dict[str, Any]] = []
    for ordinal, item in enumerate(image_items, start=1):
        entry = dict(item)
        entry["label"] = f"<Picture {ordinal}>"
        reference_map.append(entry)

    audio_ordinal = 0
    for ordinal, item in enumerate(video_items, start=1):
        if bool(item.get("has_audio")):
            audio_ordinal += 1
            reference_map.append(
                {
                    "type": "video_soundtrack",
                    "source_name": item.get("source_name"),
                    "role": "audio",
                    "retention": item.get("audio_retention") or "reference",
                    "label": f"<Audio {audio_ordinal}>",
                    "video_label": f"<Video {ordinal}>",
                    "character_id": item.get("character_id"),
                    "character_name": item.get("character_name"),
                }
            )
        entry = dict(item)
        entry["label"] = f"<Video {ordinal}>"
        reference_map.append(entry)

    for item in audio_items:
        audio_ordinal += 1
        entry = dict(item)
        entry["label"] = f"<Audio {audio_ordinal}>"
        reference_map.append(entry)

    if _structured_reference_prompt(prompt):
        return prompt.strip(), reference_map

    task_label = REFERENCE_TASKS.get(task, REFERENCE_TASKS["reference_generation"])

    subject_lines: list[str] = []
    retention_lines: list[str] = []
    character_subjects: dict[str, dict[str, Any]] = {}

    for entry in reference_map:
        char_id = str(entry.get("character_id") or "").strip()
        if not char_id:
            continue
        group = character_subjects.setdefault(
            char_id,
            {
                "name": str(entry.get("character_name") or "Character").strip(),
                "description": str(entry.get("character_description") or "").strip(),
                "labels": [],
            },
        )
        group["labels"].append(str(entry["label"]))

    subject_index = 0
    for group in character_subjects.values():
        subject_index += 1
        labels = ", ".join(group["labels"])
        description = f" {group['description']}" if group["description"] else ""
        subject_lines.append(
            f"<Subject {subject_index}>: reusable character \"{group['name']}\" "
            f"defined by {labels}.{description}".strip()
        )

    for entry in reference_map:
        label = str(entry["label"])
        role = str(entry.get("role") or "reference").replace("_", " ")
        source_name = str(entry.get("source_name") or "reference")
        if not entry.get("character_id"):
            note = str(entry.get("note") or "").strip()
            note_text = f" {note}" if note else ""
            subject_lines.append(f"{label}: {role} reference \"{source_name}\".{note_text}".strip())

        retention = str(entry.get("retention") or "reference")
        retention_lines.append(f"{label}: {retention}; role={role}.")

    if not subject_lines:
        subject_lines.append("Use the attached references exactly according to their labels and roles.")
    if not retention_lines:
        retention_lines.append("Preserve reference identity and requested attributes consistently.")

    simple_prompt = prompt.strip()
    target_sentence = {
        "video_editing": "The target video is an edited version of the supplied reference video.",
        "video_continuation": "The target video continues naturally from the supplied reference video.",
        "audio_reuse": "The target video reuses the supplied audio according to its retention rule.",
        "audio_reference": "The target video uses the supplied audio as a voice, timbre or rhythm reference.",
        "keyframe_completion": "The supplied pictures are storyboard/keyframe references, not exact latent anchors.",
    }.get(task, "The target video is generated from the supplied multimodal references.")

    wrapped = (
        "subject_definitions:\n"
        + "\n".join(f"- {line}" for line in subject_lines)
        + "\n\nsummary: "
        + f"[{task_label}] {target_sentence}"
        + "\n\nretention_analysis:\n"
        + "\n".join(f"- {line}" for line in retention_lines)
        + "\n\ndetailed_description: "
        + simple_prompt
        + "\n\noverall_soundscape: Preserve and generate only the ambience, physical sounds, voices, and reference audio explicitly requested in detailed_description.\n"
        + "\nnon_diegetic_music: N/A unless detailed_description explicitly requests audience-only score."
    )
    return wrapped, reference_map
