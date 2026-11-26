"""Offline CPU repair tests. No ComfyUI/GPU or live site required."""

import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


_temporary_data = tempfile.TemporaryDirectory(prefix="aivideosite-repair-test-")
os.environ["DATA_DIR"] = _temporary_data.name

from app import db  # noqa: E402
from app.config import settings  # noqa: E402
from app.worker import JobWorker, probe_duration, probe_has_audio  # noqa: E402


class RepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.sources = []
        for index, seconds in enumerate((2.4, 2.6, 2.3)):
            media_id = uuid.uuid4().hex
            path = settings.library_dir / f"{media_id}.mp4"
            command = [str(settings.ffmpeg_bin), "-v", "error", "-y",
                       "-f", "lavfi", "-i", f"testsrc2=s=160x90:r=24:d={seconds}"]
            if index < 2:
                command.extend(["-f", "lavfi", "-i", f"sine=frequency={380 + index * 200}:duration={seconds}"])
            command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)])
            subprocess.run(
                command,
                check=True, capture_output=True, text=True,
            )
            db.insert_media(
                media_id=media_id, filename=path.name, kind="imported",
                title=f"Source {index}", parent_id=None, metadata={},
                size_bytes=path.stat().st_size, duration=probe_duration(path),
            )
            cls.sources.append(media_id)

    def test_ffmpeg_segment_audio_and_splice(self):
        cases = [
            ({"mode": "fragment", "media_id": self.sources[0], "start": .5, "end": 1.2}, 1.7),
            ({"mode": "fragment", "media_id": self.sources[0], "start": 0, "end": .75}, 1.65),
            ({"mode": "sound", "media_id": self.sources[0], "start": .5, "end": 1.2, "volume": 0}, 2.4),
            ({"mode": "splice", "media_id": self.sources[0], "second_media_id": self.sources[1], "transition": "fade"}, 4),
            ({"mode": "splice", "media_id": self.sources[0], "second_media_id": self.sources[1], "transition": "wipeleft"}, 4),
            ({"mode": "splice", "media_id": self.sources[2], "second_media_id": self.sources[0], "transition": "slideleft"}, 3.7),
            ({"mode": "splice_cut", "media_id": self.sources[0], "second_media_id": self.sources[1],
              "start": .8, "end": .6}, 2.8),
            ({"mode": "splice_cut", "media_id": self.sources[2], "second_media_id": self.sources[0],
              "start": .1, "end": 2.3}, .2),
        ]
        # Only exercise the CPU export method; no ComfyUI clients are needed.
        worker = object.__new__(JobWorker)
        for payload, expected_seconds in cases:
            with self.subTest(mode=payload["mode"]):
                job_id = uuid.uuid4().hex
                payload["title"] = "Repair test"
                db.enqueue_job(job_id, "repair_export", payload)
                media_id = worker._repair_export({"id": job_id, "owner_id": "user1", "payload": payload})
                media = db.get_media(media_id, "user1")
                self.assertIsNotNone(media)
                output = settings.library_dir / media["filename"]
                self.assertTrue(output.is_file())
                self.assertTrue(probe_has_audio(output))
                self.assertAlmostEqual(probe_duration(output), expected_seconds, delta=.20)
                if payload["mode"] == "splice_cut":
                    self.assertEqual(media["meta"]["method"], "hard_cut_cpu")

if __name__ == "__main__":
    unittest.main()
