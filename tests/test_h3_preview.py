"""Local-only checks for H3 preview plumbing (no GPU/ComfyUI required)."""

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import unittest
import uuid
import wave
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from PIL import Image


_test_data = tempfile.TemporaryDirectory(prefix="aivideosite-preview-test-")
os.environ["DATA_DIR"] = _test_data.name

from fastapi import HTTPException  # noqa: E402
from app import db  # noqa: E402
from app.config import settings  # noqa: E402
from app.comfy import ComfyUIClient  # noqa: E402
from app.h3_preview import (  # noqa: E402
    _make_preview_poster, cleanup_job_preview, list_job_previews, preview_path,
    preview_poster_path, save_job_preview, save_test_audio, test_audio_path,
)
from app.main import api_cancel_job, api_continue_test_job, api_job_preview, api_job_test_audio, _v2_test_step  # noqa: E402
from comfyui_nodes.aivideosite_run_nonce import AIVideoRunNonce  # noqa: E402


def make_animated_webp(color: str) -> bytes:
    first = Image.new("RGB", (32, 24), color)
    second = Image.new("RGB", (32, 24), "white")
    target = BytesIO()
    first.save(target, format="WEBP", save_all=True, append_images=[second], duration=250, loop=0)
    return target.getvalue()


WEBP_BYTES = make_animated_webp("red")
WEBP_BYTES_STEP4 = make_animated_webp("blue")


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = iter(messages)

    def settimeout(self, _timeout):
        pass

    def recv(self):
        return next(self.messages)


class H3PreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def setUp(self):
        self.job_id = uuid.uuid4().hex
        db.enqueue_job(self.job_id, "generate", {"prompt": "test"}, owner_id="owner", gpu_target="rtx3090")
        self.assertIsNotNone(db.claim_next_job({"generate"}, gpu_target="rtx3090"))

    def tearDown(self):
        cleanup_job_preview(self.job_id)
        with db.connect() as conn:
            conn.execute("DELETE FROM jobs WHERE id=?", (self.job_id,))

    def test_first_and_second_step_and_owner_only(self):
        self.assertTrue(save_job_preview(self.job_id, 1, "image/webp", WEBP_BYTES))
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        self.assertTrue(preview_path(self.job_id, "image/webp", 2).is_file())
        poster = preview_poster_path(self.job_id, 2)
        self.assertTrue(poster.is_file())
        with Image.open(poster) as image:
            self.assertEqual(image.size, (32, 24))
        response = asyncio.run(api_job_preview(self.job_id, user_id="owner"))
        self.assertEqual(response.media_type, "image/webp")
        poster_response = asyncio.run(api_job_preview(self.job_id, step=2, poster=True, user_id="owner"))
        self.assertEqual(poster_response.media_type, "image/jpeg")
        with self.assertRaises(HTTPException) as other_user:
            asyncio.run(api_job_preview(self.job_id, user_id="stranger"))
        self.assertEqual(other_user.exception.status_code, 404)

    def test_cancel_hides_preview_and_prevents_late_updates(self):
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        db.request_cancel(self.job_id, "owner")
        self.assertFalse(save_job_preview(self.job_id, 4, "image/webp", WEBP_BYTES))
        self.assertEqual(db.get_job(self.job_id)["preview_step"], 0)
        self.assertFalse(db.complete_job(self.job_id, "fake-media-id"))
        with self.assertRaises(HTTPException) as cancelled:
            asyncio.run(api_job_preview(self.job_id, user_id="owner"))
        self.assertEqual(cancelled.exception.status_code, 404)
        self.assertFalse(any(x["id"] == self.job_id for x in db.list_active_generation_jobs("owner")))

    def test_preview_format_validation(self):
        self.assertFalse(save_job_preview(self.job_id, 2, "image/webp", b"not a webp"))
        self.assertFalse(save_job_preview(self.job_id, 2, "image/png", WEBP_BYTES))
        self.assertIsNone(preview_path("../wrong", "image/webp", 2))
        self.assertIsNone(preview_path(self.job_id, "image/webp", 0))
        self.assertIsNone(preview_path(self.job_id, "image/webp", 25))

    @unittest.skipUnless(settings.ffmpeg_bin.is_file(), "FFmpeg is not installed")
    def test_mp4_first_frame_poster(self):
        with tempfile.TemporaryDirectory(prefix="h3-mp4-preview-") as directory:
            path = Path(directory) / "sample.mp4"
            command = [
                str(settings.ffmpeg_bin), "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=blue:s=160x96:r=2:d=1",
                "-frames:v", "2", "-c:v", "mpeg4", "-y", str(path),
            ]
            result = subprocess.run(command, capture_output=True, timeout=10, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            poster = _make_preview_poster("video/mp4", path.read_bytes())
            self.assertIsNotNone(poster)
            with Image.open(BytesIO(poster)) as image:
                self.assertEqual(image.size, (160, 96))

    def test_steps_are_distinct_and_selectable(self):
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        self.assertTrue(save_job_preview(self.job_id, 4, "image/webp", WEBP_BYTES_STEP4))
        self.assertFalse(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES_STEP4))
        step2 = preview_path(self.job_id, "image/webp", 2)
        step4 = preview_path(self.job_id, "image/webp", 4)
        self.assertEqual(step2.read_bytes(), WEBP_BYTES)
        self.assertEqual(step4.read_bytes(), WEBP_BYTES_STEP4)
        self.assertNotEqual(step2.read_bytes(), step4.read_bytes())
        self.assertEqual([item["step"] for item in list_job_previews(self.job_id, 4)], [2, 4])
        self.assertEqual(asyncio.run(api_job_preview(self.job_id, step=2, user_id="owner")).path, step2)
        self.assertEqual(asyncio.run(api_job_preview(self.job_id, step=4, user_id="owner")).path, step4)
        for invalid in (3, 6, 24):
            with self.assertRaises(HTTPException) as failure:
                asyncio.run(api_job_preview(self.job_id, step=invalid, user_id="owner"))
            self.assertEqual(failure.exception.status_code, 404)
        cleanup_job_preview(self.job_id)
        self.assertFalse(step2.exists())
        self.assertFalse(step4.exists())
        self.assertFalse(preview_poster_path(self.job_id, 2).exists())

    def test_cancel_endpoint_removes_preview_file(self):
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        path = preview_path(self.job_id, "image/webp", 2)
        poster = preview_poster_path(self.job_id, 2)
        fake_worker = SimpleNamespace(cancel_job=lambda *_: True)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(worker=fake_worker)))
        result = asyncio.run(api_cancel_job(self.job_id, request, user_id="owner"))
        self.assertTrue(result["ok"])
        self.assertFalse(path.exists())
        self.assertFalse(poster.exists())
        self.assertFalse(any(x["id"] == self.job_id for x in db.list_active_generation_jobs("owner")))

    def test_workflow_injects_preview_into_normal_and_guided_sampling(self):
        client = ComfyUIClient()
        payload = {"prompt": "test", "seed": 123, "steps": 8}
        normal = client._build_h3_workflow(job_id=self.job_id, payload=payload.copy(), uploaded_images=[], enable_preview=True)
        self.assertEqual(normal["35"]["class_type"], "MiniMaxH3PreviewOverride")
        self.assertEqual(normal["30"]["inputs"]["model"], ["35", 0])
        self.assertEqual(normal["5"]["inputs"]["model"], ["35", 0])
        original = client._build_h3_workflow(job_id=self.job_id, payload=payload.copy(), uploaded_images=[])
        self.assertNotIn("35", original)
        guided = client._build_h3_workflow(
            job_id=self.job_id, payload=payload.copy(), uploaded_images=[],
            staged_guides=[{"name": "some_image.png", "frame_idx": 10}], enable_preview=True,
        )
        self.assertEqual(guided["32"]["inputs"]["model"], ["35", 0])

    def test_distinct_jobs_invalidate_sampler_cache_without_changing_seed(self):
        client = ComfyUIClient()
        payload = {"prompt": "same prompt", "seed": 12345, "steps": 8}
        second_id = uuid.uuid4().hex
        first = client._build_h3_workflow(
            job_id=self.job_id, payload=payload.copy(), uploaded_images=[],
            enable_preview=True, enable_run_nonce=True,
        )
        second = client._build_h3_workflow(
            job_id=second_id, payload=payload.copy(), uploaded_images=[],
            enable_preview=True, enable_run_nonce=True,
        )
        self.assertEqual(first["30"]["inputs"]["seed"], second["30"]["inputs"]["seed"])
        self.assertEqual(first["36"]["inputs"]["run_id"], self.job_id)
        self.assertEqual(second["36"]["inputs"]["run_id"], second_id)
        self.assertEqual(first["35"]["inputs"]["model"], ["36", 0])
        self.assertEqual(first["30"]["inputs"]["model"], ["35", 0])
        self.assertEqual(first["5"]["inputs"]["model"], ["35", 0])
        without_preview = client._build_h3_workflow(
            job_id=self.job_id, payload=payload.copy(), uploaded_images=[],
            enable_preview=False, enable_run_nonce=True,
        )
        self.assertEqual(without_preview["30"]["inputs"]["model"], ["36", 0])
        self.assertEqual(without_preview["5"]["inputs"]["model"], ["36", 0])
        guided = client._build_h3_workflow(
            job_id=self.job_id, payload=payload.copy(), uploaded_images=[],
            staged_guides=[{"name": "guide.png", "frame_idx": 0}],
            enable_preview=True, enable_run_nonce=True,
        )
        self.assertEqual(guided["32"]["inputs"]["model"], ["35", 0])
        sentinel = object()
        self.assertIs(AIVideoRunNonce().passthrough(sentinel, self.job_id)[0], sentinel)

    def test_run_nonce_node_detection(self):
        client = ComfyUIClient()

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"AIVideoRunNonce": {"input": {"required": {"model": ["MODEL"]}}}}

        client.session.get = lambda *_args, **_kwargs: FakeResponse()
        self.assertTrue(client._h3_run_nonce_ready())

    def test_websocket_preview_event(self):
        image_events = []
        messages = [
            {"type": "minimax_h3_preview_override", "data": {
                "step": step, "mime": "image/webp", "image": base64.b64encode(WEBP_BYTES).decode(),
            }} for step in (1, 2, 3, 4)
        ]
        messages.append({"type": "execution_success", "data": {}})
        socket = FakeWebSocket([json.dumps(item) for item in messages])
        client = ComfyUIClient()
        client._wait_websocket(socket, "prompt-id", lambda *_: None, on_preview=lambda *args: image_events.append(args))
        self.assertEqual([event[0] for event in image_events], [1, 2, 3, 4])
        self.assertEqual(image_events[0][2], WEBP_BYTES)

    def test_test_step_validation_and_workflow(self):
        self.assertEqual(_v2_test_step(1, 8), 1)
        self.assertEqual(_v2_test_step(8, 8), 8)
        for invalid in (-1, 9):
            with self.assertRaises(HTTPException):
                _v2_test_step(invalid, 8)
        client = ComfyUIClient()
        workflow = client._build_h3_workflow(
            job_id=self.job_id,
            payload={"prompt": "test", "steps": 8, "seed": 15, "test_pause_step": 5, "generate_audio": True},
            uploaded_images=[], enable_preview=True, enable_run_nonce=True,
        )
        self.assertEqual(workflow["37"]["class_type"], "AIVideoTestPause")
        self.assertEqual(workflow["37"]["inputs"]["pause_step"], 5)
        self.assertEqual(workflow["38"]["inputs"]["start_at_percent"], 62)
        self.assertEqual(workflow["37"]["inputs"]["model"], ["38", 0])
        self.assertEqual(workflow["30"]["inputs"]["model"], ["37", 0])
        self.assertEqual(workflow["5"]["inputs"]["model"], ["37", 0])
        quiet = client._build_h3_workflow(
            job_id=self.job_id,
            payload={"prompt": "test", "steps": 8, "seed": 15, "test_pause_step": 1, "generate_audio": False},
            uploaded_images=[], enable_preview=True,
        )
        self.assertNotIn("38", quiet)
        self.assertEqual(quiet["37"]["inputs"]["pause_step"], 1)

    def test_pause_continue_and_owner_authorization(self):
        db.set_test_paused(self.job_id, True, 3)
        self.assertTrue(db.get_job(self.job_id)["test_paused"])
        calls = []
        fake_worker = SimpleNamespace(resume_test=lambda identifier: calls.append(identifier) or True)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(worker=fake_worker)))
        with self.assertRaises(HTTPException) as forbidden:
            asyncio.run(api_continue_test_job(self.job_id, request, user_id="other"))
        self.assertEqual(forbidden.exception.status_code, 404)
        # An ordinary job cannot be continued, even if someone marked it paused.
        with self.assertRaises(HTTPException) as not_a_test:
            asyncio.run(api_continue_test_job(self.job_id, request, user_id="owner"))
        self.assertEqual(not_a_test.exception.status_code, 409)
        with db.connect() as conn:
            conn.execute("UPDATE jobs SET payload_json=? WHERE id=?", (
                json.dumps({"prompt": "test", "test_pause_step": 3}), self.job_id,
            ))
        response = asyncio.run(api_continue_test_job(self.job_id, request, user_id="owner"))
        self.assertTrue(response["ok"])
        self.assertEqual(calls, [self.job_id])
        self.assertFalse(db.get_job(self.job_id)["test_paused"])
        self.assertGreaterEqual(db.get_job(self.job_id)["test_paused_seconds"], 0)
        with self.assertRaises(HTTPException) as repeated:
            asyncio.run(api_continue_test_job(self.job_id, request, user_id="owner"))
        self.assertEqual(repeated.exception.status_code, 409)

    def test_restart_recovers_interrupted_test_pause(self):
        db.set_test_paused(self.job_id, True, 2)
        self.assertIn(self.job_id, db.interrupted_test_pauses())
        self.assertEqual(db.recover_interrupted_jobs(), 1)
        recovered = db.get_job(self.job_id)
        self.assertEqual(recovered["status"], "queued")
        self.assertFalse(recovered["test_paused"])
        self.assertNotIn(self.job_id, db.interrupted_test_pauses())

    def test_test_audio_owner_protection_and_cleanup(self):
        with db.connect() as conn:
            conn.execute("UPDATE jobs SET payload_json=? WHERE id=?", (
                json.dumps({"prompt": "test", "test_pause_step": 2}), self.job_id,
            ))
        target = BytesIO()
        with wave.open(target, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"\x00\x00" * 800)
        self.assertTrue(save_test_audio(self.job_id, target.getvalue()))
        db.set_test_paused(self.job_id, True, 2)
        response = asyncio.run(api_job_test_audio(self.job_id, user_id="owner"))
        self.assertEqual(response.media_type, "audio/wav")
        with self.assertRaises(HTTPException) as forbidden:
            asyncio.run(api_job_test_audio(self.job_id, user_id="other"))
        self.assertEqual(forbidden.exception.status_code, 404)
        cleanup_job_preview(self.job_id)
        self.assertFalse(test_audio_path(self.job_id).exists())

    def test_websocket_test_pause_and_audio(self):
        events = [
            {"type": "minimax_h3_audio_preview", "data": {
                "step": 4, "node_id": "38", "url": "/minimax_h3/audio_preview?node_id=38&seq=1",
            }},
            {"type": "aivideosite_test_pause", "data": {"job_id": self.job_id, "step": 4}},
            {"type": "execution_success", "data": {}},
        ]
        socket = FakeWebSocket([json.dumps(item) for item in events])
        client = ComfyUIClient()
        audio = []
        paused = []
        client.session.get = lambda *_args, **_kw: SimpleNamespace(ok=True, content=b"audio")
        client._wait_websocket(
            socket, "prompt-id", lambda *_: None, test_step=4, test_job_id=self.job_id,
            on_test_audio=audio.append, on_pause=paused.append,
        )
        self.assertEqual(audio, [b"audio"])
        self.assertEqual(paused, [4])

    def test_preview_enabled_when_node_is_available_even_if_schema_differs(self):
        client = ComfyUIClient()

        class FakeResponse:
            data = {}

            def raise_for_status(self):
                pass

            def json(self):
                return self.data

        response = FakeResponse()
        client.session.get = lambda *_args, **_kwargs: response
        response.data = {"MiniMaxH3PreviewOverride": {"input": {"optional": {
            "vae_name": ["COMBO", {"options": ["taeh3_decoder.safetensors"]}],
        }}}}
        self.assertTrue(client._h3_preview_ready())
        response.data = {"MiniMaxH3PreviewOverride": {"display_name": "MiniMax H3 Preview Override"}}
        self.assertTrue(client._h3_preview_ready())
        response.data = {}
        self.assertFalse(client._h3_preview_ready())


if __name__ == "__main__":
    unittest.main()
