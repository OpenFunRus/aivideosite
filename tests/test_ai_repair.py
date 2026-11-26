"""Offline H3 repair preparation/assembly tests with synthetic FFmpeg inputs."""

import base64
import io
import os
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path

from PIL import Image, ImageDraw


_temporary_data = tempfile.TemporaryDirectory(prefix="aivideosite-ai-repair-")
os.environ["DATA_DIR"] = _temporary_data.name

from app.ai_repair import (  # noqa: E402
    assembly_command, decode_mask, prepare_ai_inputs, splice_window, splice_canvas_size,
)
from app.config import settings  # noqa: E402


class AIRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = []
        for idx, seconds in enumerate((2.4, 2.6, 6.0, 2.5)):
            file = Path(_temporary_data.name) / f"sample_{idx}.mp4"
            cmd = [str(settings.ffmpeg_bin), "-v", "error", "-y", "-f", "lavfi",
                   "-i", f"testsrc2=s=160x96:r=24:d={seconds}"]
            if idx != 3:
                cmd += ["-f", "lavfi", "-i", f"sine=frequency={400 + idx * 100}:duration={seconds}"]
            cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-shortest", str(file)]
            subprocess.run(cmd, check=True, capture_output=True, text=True)
            cls.files.append(file)

    @staticmethod
    def probe_seconds(path):
        data = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                                        "format=duration", "-of", "default=nw=1:nk=1", str(path)])
        return float(data)

    @staticmethod
    def probe_audio(path):
        data = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams",
                                        "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)])
        return bool(data.strip())

    def test_splice_sizes(self):
        self.assertEqual(splice_canvas_size((160, 96), "480", "16:9"), (864, 480))
        self.assertEqual(splice_canvas_size((160, 96), "720", "9:16"), (736, 1312))
        self.assertEqual(splice_canvas_size((160, 96), "480", "auto"), (800, 480))
        with self.assertRaises(ValueError):
            splice_canvas_size((160, 96), "4K", "16:9")

    def test_splice_window_range(self):
        self.assertEqual(splice_window(0)["seconds"], 0)
        for selected in (.1, .2, 1, 5, 10, 15):
            with self.subTest(seconds=selected):
                window = splice_window(selected)
                self.assertEqual((window["native_frames"] - 5) % 17, 0)
                self.assertGreaterEqual(window["native_frames"], 124)
                self.assertEqual(window["bridge_start_seconds"], 0)
                self.assertEqual(window["bridge_native_seconds"], window["seconds"])
                self.assertGreaterEqual(window["seconds"], selected - 1 / 24)
                self.assertLessEqual(window["native_frames"], 362)
        self.assertGreater(splice_window(15)["seconds"], 15)
        for bad in (-.01, 15.1, float("nan")):
            with self.assertRaises(ValueError):
                splice_window(bad)

    def test_two_still_frames_without_reference_audio(self):
        # Inspect the FL2VA First/Last Frame workflow without launching ComfyUI.
        sys.modules.setdefault("requests", types.ModuleType("requests"))
        sys.modules.setdefault("websocket", types.ModuleType("websocket"))
        from app.comfy import ComfyUIClient

        workflow = ComfyUIClient._build_h3_workflow(
            object.__new__(ComfyUIClient), job_id="test-bridge",
            payload={"generation_mode": "frames", "steps": 8, "seed": 123,
                     "prompt": "Smooth transition", "width": 480, "height": 480,
                     "seconds": 5, "fps": 24, "generate_audio": True},
            uploaded_images=["last_a.png", "first_b.png"], staged_references=[],
            staged_guides=[],
            staged_control={},
        )
        self.assertNotEqual(workflow["1"]["inputs"]["fl2va_model"], "none")
        self.assertEqual(workflow["101"]["class_type"], "LoadImage")
        self.assertEqual(workflow["102"]["inputs"]["image"], "first_b.png")
        self.assertEqual(workflow["2"]["inputs"]["media_1"], ["101", 0])
        self.assertEqual(workflow["2"]["inputs"]["media_2"], ["102", 0])
        self.assertNotIn("401", workflow)
        self.assertNotIn("501", workflow)
        self.assertNotIn("media_3", workflow["2"]["inputs"])

    def mask_data(self):
        mask = Image.new("RGB", (160, 96), "black")
        ImageDraw.Draw(mask).ellipse((15, 15, 65, 65), fill="white")
        buffer = io.BytesIO()
        mask.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    def test_mask_validation(self):
        path = Path(_temporary_data.name) / "brush.png"
        decode_mask(self.mask_data(), path)
        self.assertEqual(Image.open(path).getextrema()[1], 255)
        with self.assertRaises(ValueError):
            decode_mask("data:image/png;base64,invalid", path)

    def test_model_inputs(self):
        for mode in ("fragment", "object", "sound", "splice"):
            with self.subTest(mode=mode):
                result = prepare_ai_inputs(
                    job_id=uuid.uuid4().hex, mode=mode,
                    first_video=self.files[0], first_duration=2.4,
                    start=1.6 if mode == "splice" else .4,
                    end=.7 if mode == "splice" else 1.5,
                    size=(160, 96),
                    second_video=self.files[3] if mode == "splice" else None,
                    second_duration=2.5 if mode == "splice" else 0,
                    transition_seconds=1,
                    mask_png=self.mask_data() if mode == "object" else "",
                )
                self.assertAlmostEqual(result["seconds"], splice_window(1)["seconds"] if mode == "splice" else 5)
                self.assertEqual(len(result["images"]), 2 if mode == "splice" else 0)
                self.assertEqual(len(result["guides"]), 0 if mode == "splice" else 2)
                for image in result["images"]:
                    self.assertTrue(Path(image).is_file(), image)
                for item in result["guides"] + result["references"]:
                    self.assertTrue(Path(item["path"]).is_file(), item)
                if mode == "object":
                    self.assertEqual(result["control"]["mode"], "inpaint")
                    self.assertTrue(Path(result["control"]["mask_video_path"]).is_file())
                if mode == "splice":
                    self.assertEqual(result["references"], [])
                    self.assertEqual([Path(p).suffix for p in result["images"]], [".png", ".png"])
                    for image in result["images"]:
                        with Image.open(image) as still:
                            self.assertEqual(still.size, (result["width"], result["height"]))
                    self.assertEqual(result["splice_window"]["bridge_native_seconds"], splice_window(1)["seconds"])
                if mode == "fragment":
                    self.assertAlmostEqual(self.probe_seconds(Path(result["references"][0]["path"])), 5, delta=.12)

    def test_splice_tiny_source_edges_and_long_bridge_frames(self):
        result = prepare_ai_inputs(
            job_id=uuid.uuid4().hex, mode="splice",
            first_video=self.files[0], first_duration=2.4,
            start=.1, end=2.4, size=(160, 96),
            second_video=self.files[3], second_duration=2.5,
            transition_seconds=15,
        )
        window = splice_window(15)
        self.assertEqual(result["seconds"], window["seconds"])
        self.assertEqual(len(result["images"]), 2)
        self.assertEqual(result["guides"], [])
        for image in result["images"]:
            with Image.open(image) as still:
                self.assertEqual(still.size, (result["width"], result["height"]))

    def test_generated_montage(self):
        cases = [
            ("fragment", .4, 1.5, 2.4, self.files[0], None, 1, 2.4),
            ("fragment", 0, .9, 2.4, self.files[0], None, 1, 2.4),
            ("sound", .4, 1.5, 2.4, self.files[0], None, 1, 2.4),
            ("sound", 0, 1.1, 2.4, self.files[0], None, 1, 2.4),
            ("sound", 0, 2.4, 2.4, self.files[0], None, 1, 2.4),
            ("object", .4, 1.5, 2.4, self.files[3], None, 1, 2.4),
            ("splice", .8, .6, 2.4, self.files[0], self.files[3], 1, 3.7),
            ("splice", .8, .6, 2.4, self.files[0], self.files[3], .1, 2.8),
        ]
        for mode, start, end, length, source, second, transition, expected in cases:
            with self.subTest(mode=mode, start=start, transition=transition):
                output = Path(_temporary_data.name) / f"output_{mode}_{start}_{end}_{transition}.mp4"
                win = splice_window(transition)
                command = assembly_command(
                    mode=mode, source=source, generated=self.files[2], destination=output,
                    start=start, end=end, source_duration=length, size=(160, 96),
                    generated_duration=6, source_has_audio=source != self.files[3],
                    generated_has_audio=True, second=second,
                    second_duration=2.5 if second else 0, second_has_audio=False,
                    splice_bridge_start=win["bridge_start_seconds"],
                    splice_bridge_native_seconds=win["bridge_native_seconds"],
                    splice_bridge_seconds=transition,
                )
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr[-1600:])
                self.assertAlmostEqual(self.probe_seconds(output), expected, delta=.17)
                self.assertTrue(self.probe_audio(output))


if __name__ == "__main__":
    unittest.main()
