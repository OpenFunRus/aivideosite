"""Static H3 workflow/API checks; requires neither GPUs nor a ComfyUI server."""

import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone


_test_data = tempfile.TemporaryDirectory(prefix="aivideosite-h3-generation-test-")
os.environ["DATA_DIR"] = _test_data.name

from fastapi import HTTPException  # noqa: E402
from app import db  # noqa: E402
from app.comfy import ComfyUIClient, ComfyUIError  # noqa: E402
from app.main import _v2_validate_simple_settings, app  # noqa: E402
from app.worker import _generation_elapsed_from_submission  # noqa: E402
from comfyui_nodes.aivideosite_run_nonce import AIVideoRunNonce  # noqa: E402


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = iter(messages)

    def settimeout(self, _timeout):
        pass

    def recv(self):
        return next(self.messages)


class H3GenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def setUp(self):
        self.job_id = uuid.uuid4().hex

    def test_every_step_is_full_video_and_audio_decode(self):
        client = ComfyUIClient()
        for steps in (1, 2, 4, 8, 12, 16):
            with self.subTest(steps=steps):
                _v2_validate_simple_settings(5, steps)
                workflow = client._build_h3_workflow(
                    job_id=self.job_id,
                    payload={"prompt": "Cinematic scene", "steps": steps, "seed": 42, "generate_audio": True},
                    uploaded_images=[], enable_run_nonce=True,
                )
                self.assertEqual(workflow["5"]["inputs"]["steps"], steps)
                self.assertEqual(workflow["30"]["inputs"]["seed"], 42)
                self.assertEqual(workflow["9"]["class_type"], "VAEDecode")
                self.assertEqual(workflow["9"]["inputs"]["vae"], ["13", 2])
                self.assertEqual(workflow["10"]["class_type"], "VAEDecodeAudio")
                self.assertEqual(workflow["10"]["inputs"]["vae"], ["13", 3])
                self.assertEqual(workflow["11"]["inputs"]["audio"], ["10", 0])
                self.assertEqual(workflow["12"]["inputs"]["format"], "mp4")
                self.assertEqual(workflow["36"]["inputs"]["run_id"], self.job_id)
                self.assertEqual(workflow["30"]["inputs"]["model"], ["36", 0])
                self.assertFalse({"35", "37", "38"}.intersection(workflow))

    def test_invalid_steps_rejected_in_api_and_comfy(self):
        client = ComfyUIClient()
        for steps in (0, 3, 5, 6, 10, 20, 24):
            with self.subTest(steps=steps):
                with self.assertRaises(HTTPException):
                    _v2_validate_simple_settings(5, steps)
                with self.assertRaises(ComfyUIError):
                    client._build_h3_workflow(
                        job_id=self.job_id, payload={"prompt": "Scene", "steps": steps},
                        uploaded_images=[],
                    )

    def test_audio_off_omits_decoder_but_keeps_video(self):
        workflow = ComfyUIClient()._build_h3_workflow(
            job_id=self.job_id,
            payload={"prompt": "Scene", "steps": 2, "generate_audio": False},
            uploaded_images=[],
        )
        self.assertNotIn("10", workflow)
        self.assertNotIn("audio", workflow["11"]["inputs"])
        self.assertIn("9", workflow)

    def test_repeated_seed_is_not_reused_from_comfy_cache(self):
        client = ComfyUIClient()
        payload = {"prompt": "Same prompt", "steps": 2, "seed": 12345}
        first = client._build_h3_workflow(
            job_id=self.job_id, payload=payload.copy(), uploaded_images=[], enable_run_nonce=True,
        )
        second_id = uuid.uuid4().hex
        second = client._build_h3_workflow(
            job_id=second_id, payload=payload.copy(), uploaded_images=[], enable_run_nonce=True,
        )
        self.assertEqual(first["30"]["inputs"]["seed"], second["30"]["inputs"]["seed"])
        self.assertEqual(first["36"]["inputs"]["run_id"], self.job_id)
        self.assertEqual(second["36"]["inputs"]["run_id"], second_id)
        sentinel = object()
        self.assertIs(AIVideoRunNonce().passthrough(sentinel, self.job_id)[0], sentinel)

    def test_guided_sampling_uses_nonce_and_full_decoder(self):
        workflow = ComfyUIClient()._build_h3_workflow(
            job_id=self.job_id,
            payload={"prompt": "Scene", "steps": 4, "seed": 15, "generate_audio": True},
            uploaded_images=[], staged_guides=[{"name": "guide.png", "frame_idx": 0}],
            enable_run_nonce=True,
        )
        self.assertEqual(workflow["32"]["inputs"]["model"], ["36", 0])
        self.assertEqual(workflow["5"]["inputs"]["model"], ["36", 0])
        self.assertEqual(workflow["9"]["inputs"]["samples"], ["30", 0])
        self.assertEqual(workflow["10"]["inputs"]["samples"], ["30", 0])
        self.assertFalse({"35", "37", "38"}.intersection(workflow))

    def test_nonce_node_detection(self):
        client = ComfyUIClient()

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"AIVideoRunNonce": {"input": {"required": {"model": ["MODEL"]}}}}

        client.session.get = lambda *_args, **_kwargs: FakeResponse()
        self.assertTrue(client._h3_run_nonce_ready())

    def test_sampling_start_only_on_first_matching_progress_event(self):
        db.enqueue_job(self.job_id, "generate", {"prompt": "Scene"}, owner_id="owner", gpu_target="rtx3090")
        try:
            self.assertIsNotNone(db.claim_next_job({"generate"}, gpu_target="rtx3090"))
            events = [
                {"type": "executing", "data": {"node": "5", "prompt_id": "prompt-id"}},
                {"type": "progress", "data": {"value": 1, "max": 2, "prompt_id": "wrong-id"}},
                {"type": "progress", "data": {"value": 1, "max": 2, "prompt_id": "prompt-id"}},
                {"type": "progress", "data": {"value": 2, "max": 2, "prompt_id": "prompt-id"}},
                {"type": "execution_success", "data": {"prompt_id": "prompt-id"}},
            ]
            starts = []
            progress = []
            ComfyUIClient()._wait_websocket(
                FakeWebSocket([json.dumps(event) for event in events]),
                "prompt-id", lambda *args: progress.append(args),
                on_sampling_start=lambda: starts.append(db.mark_sampling_started(self.job_id)),
            )
            self.assertEqual(starts, [True])
            self.assertEqual([entry[0] for entry in progress if entry[0] >= 15], [50.0, 85.0])
            self.assertTrue(db.get_job(self.job_id)["sampling_started_at"])
        finally:
            with db.connect() as connection:
                connection.execute("DELETE FROM jobs WHERE id=?", (self.job_id,))

    def test_test_pause_and_preview_endpoints_removed(self):
        paths = {route.path for route in app.routes}
        for path in (
            "/api/jobs/{job_id}/continue",
            "/api/jobs/{job_id}/preview",
            "/api/jobs/{job_id}/test-audio",
        ):
            self.assertNotIn(path, paths)

    def test_saved_generation_time_starts_at_gpu_submission(self):
        completed = datetime(2026, 11, 26, 12, 3, 4, tzinfo=timezone.utc)
        # Job was created before ComfyUI loaded its model and sampled frames.
        job = {
            "created_at": "2026-11-26T12:00:00+00:00",
            "started_at": "2026-11-26T12:00:30+00:00",
            "sampling_started_at": "2026-11-26T12:02:00+00:00",
        }
        started, seconds = _generation_elapsed_from_submission(job, completed)
        self.assertEqual(started, job["created_at"])
        self.assertEqual(seconds, 184.0)
        self.assertEqual(
            _generation_elapsed_from_submission({"started_at": job["started_at"]}, completed),
            (job["started_at"], 154.0),
        )


if __name__ == "__main__":
    unittest.main()
