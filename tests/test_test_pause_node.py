"""Exercise the ComfyUI pause wrapper without CUDA or a ComfyUI install."""

import importlib.util
import sys
import tempfile
import threading
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


NODE_FILE = Path(__file__).resolve().parents[1] / "comfyui_nodes" / "aivideosite_test_pause.py"


def import_pause_node():
    comfy = types.ModuleType("comfy")
    extension = types.ModuleType("comfy.patcher_extension")
    extension.WrappersMP = types.SimpleNamespace(OUTER_SAMPLE="outer")
    comfy.patcher_extension = extension
    server = types.ModuleType("server")
    notification = threading.Event()

    class FakePromptServer:
        client_id = "test-user"

        def send_sync(self, name, payload, client_id):
            if name == "aivideosite_test_pause":
                notification.set()

    server.PromptServer = types.SimpleNamespace(instance=FakePromptServer())
    spec = importlib.util.spec_from_file_location("test_pause_node_under_test", NODE_FILE)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"comfy": comfy, "comfy.patcher_extension": extension, "server": server}):
        spec.loader.exec_module(module)
    return module, notification


class TestPauseNodeTests(unittest.TestCase):
    def test_resumes_from_selected_step_without_repeating_steps(self):
        module, paused = import_pause_node()
        with tempfile.TemporaryDirectory(prefix="aivideo-test-gate-") as folder:
            job_id = uuid.uuid4().hex
            wrapped = module._PauseWrapper(job_id, 3, folder)
            processed = []
            errors = []

            def executor(*_args, **kwargs):
                callback = _args[5]
                for step in range(8):
                    callback(step, None, None, 8)
                    processed.append(step + 1)
                return "finished"

            def execute():
                try:
                    wrapped(executor, None, None, None, None, None, None, False, 1, [])
                except Exception as exc:
                    errors.append(exc)

            thread = threading.Thread(target=execute, daemon=True)
            thread.start()
            self.assertTrue(paused.wait(2), "Third step never paused")
            self.assertEqual(processed, [1, 2])  # Callback for step 3 is waiting.
            Path(folder, job_id + ".resume").touch()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(processed, list(range(1, 9)))

    def test_cancel_wakes_blocked_sampler(self):
        module, paused = import_pause_node()
        with tempfile.TemporaryDirectory(prefix="aivideo-test-gate-") as folder:
            job_id = uuid.uuid4().hex
            wrapper = module._PauseWrapper(job_id, 1, folder)
            errors = []

            def executor(*args, **_kwargs):
                args[5](0, None, None, 8)

            def execute():
                try:
                    wrapper(executor, None, None, None, None, None, None, False, 1, [])
                except Exception as exc:
                    errors.append(exc)

            thread = threading.Thread(target=execute, daemon=True)
            thread.start()
            self.assertTrue(paused.wait(2))
            Path(folder, job_id + ".cancel").touch()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIn("cancelled", str(errors[0]))


if __name__ == "__main__":
    unittest.main()
