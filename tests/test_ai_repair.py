"""Offline H3 repair preparation/assembly tests with synthetic FFmpeg inputs."""

import base64
import io
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from PIL import Image, ImageDraw


_temporary_data = tempfile.TemporaryDirectory(prefix="aivideosite-ai-repair-")
os.environ["DATA_DIR"] = _temporary_data.name

from app.ai_repair import assembly_command, decode_mask, prepare_ai_inputs  # noqa: E402
from app.config import settings  # noqa: E402


class AIRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = []
        for idx, seconds in enumerate((2.4, 2.6, 5.0, 2.5)):
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
                    start=.4, end=1.5, size=(160, 96),
                    second_video=self.files[3] if mode == "splice" else None,
                    mask_png=self.mask_data() if mode == "object" else "",
                )
                self.assertEqual(result["seconds"], 5)
                self.assertEqual(len(result["guides"]), 2)
                for item in result["guides"] + result["references"]:
                    self.assertTrue(Path(item["path"]).is_file(), item)
                if mode == "object":
                    self.assertEqual(result["control"]["mode"], "inpaint")
                    self.assertTrue(Path(result["control"]["mask_video_path"]).is_file())
                if mode == "splice":
                    self.assertEqual([g["frame_idx"] for g in result["guides"]], [48, 72])
                if mode == "fragment":
                    self.assertAlmostEqual(self.probe_seconds(Path(result["references"][0]["path"])), 5, delta=.12)

    def test_generated_montage(self):
        cases = [
            ("fragment", .4, 1.5, 2.4, self.files[0], None, 2.4),
            ("fragment", 0, .9, 2.4, self.files[0], None, 2.4),
            ("sound", .4, 1.5, 2.4, self.files[0], None, 2.4),
            ("sound", 0, 1.1, 2.4, self.files[0], None, 2.4),
            ("sound", 0, 2.4, 2.4, self.files[0], None, 2.4),
            ("object", .4, 1.5, 2.4, self.files[3], None, 2.4),
            ("splice", 0, 0, 2.4, self.files[0], self.files[3], 5.9),
        ]
        for mode, start, end, length, source, second, expected in cases:
            with self.subTest(mode=mode, start=start):
                output = Path(_temporary_data.name) / f"output_{mode}_{start}.mp4"
                command = assembly_command(
                    mode=mode, source=source, generated=self.files[2], destination=output,
                    start=start, end=end, source_duration=length, size=(160, 96),
                    generated_duration=5, source_has_audio=source != self.files[3],
                    generated_has_audio=True, second=second,
                    second_duration=2.5 if second else 0, second_has_audio=False,
                )
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr[-1600:])
                self.assertAlmostEqual(self.probe_seconds(output), expected, delta=.17)
                self.assertTrue(self.probe_audio(output))


if __name__ == "__main__":
    unittest.main()
