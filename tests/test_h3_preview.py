"""Local-only checks for H3 preview plumbing (no GPU/ComfyUI required)."""

import asyncio
import base64
import json
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace


_test_data = tempfile.TemporaryDirectory(prefix="aivideosite-preview-test-")
os.environ["DATA_DIR"] = _test_data.name

from fastapi import HTTPException  # noqa: E402
from app import db  # noqa: E402
from app.comfy import ComfyUIClient  # noqa: E402
from app.h3_preview import cleanup_job_preview, preview_path, save_job_preview  # noqa: E402
from app.main import api_cancel_job, api_job_preview  # noqa: E402
from comfyui_nodes.aivideosite_run_nonce import AIVideoRunNonce  # noqa: E402


WEBP_BYTES = b"RIFF\x04\x00\x00\x00WEBP"


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

    def test_second_step_and_owner_only(self):
        self.assertFalse(save_job_preview(self.job_id, 1, "image/webp", WEBP_BYTES))
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        self.assertTrue(preview_path(self.job_id, "image/webp").is_file())
        response = asyncio.run(api_job_preview(self.job_id, user_id="owner"))
        self.assertEqual(response.media_type, "image/webp")
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
        self.assertIsNone(preview_path("../wrong", "image/webp"))

    def test_cancel_endpoint_removes_preview_file(self):
        self.assertTrue(save_job_preview(self.job_id, 2, "image/webp", WEBP_BYTES))
        path = preview_path(self.job_id, "image/webp")
        fake_worker = SimpleNamespace(cancel_job=lambda *_: True)
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(worker=fake_worker)))
        result = asyncio.run(api_cancel_job(self.job_id, request, user_id="owner"))
        self.assertTrue(result["ok"])
        self.assertFalse(path.exists())
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
        self.assertEqual([event[0] for event in image_events], [2, 4])
        self.assertEqual(image_events[0][2], WEBP_BYTES)

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
