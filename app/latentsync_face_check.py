from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--latentsync-dir", required=True)
    args = parser.parse_args()

    latentsync_dir = Path(args.latentsync_dir).resolve()
    sys.path.insert(0, str(latentsync_dir))

    from latentsync.utils.face_detector import FaceDetector

    detector = FaceDetector(device="cuda")
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "video_open_failed"}))
        return 0

    frame_index = 0
    failed_frame = None
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        bbox, _ = detector(frame_rgb)
        if bbox is None:
            failed_frame = frame_index
            break
        frame_index += 1

    cap.release()

    print(
        json.dumps(
            {
                "ok": failed_frame is None,
                "failed_frame": failed_frame,
                "checked_frames": frame_index if failed_frame is not None else total_frames,
                "total_frames": total_frames,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
