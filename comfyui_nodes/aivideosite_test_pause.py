"""Pause an active H3 sampler after a selected denoising step.

The sampler stays alive with its exact noise and sigma state. Continuing does
not resample completed steps. The site and ComfyUI share the control folder.
"""

import logging
import re
import time
from pathlib import Path

import comfy.patcher_extension
from server import PromptServer


_JOB_ID = re.compile(r"[0-9a-f]{32}\Z")


class _PauseWrapper:
    def __init__(self, job_id, pause_step, control_dir):
        self.job_id = job_id
        self.pause_step = int(pause_step)
        self.folder = Path(control_dir)

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask,
                 callback, disable_pbar, seed, latent_shapes):
        def on_step(step, x0, x, total_steps):
            if callback is not None:
                callback(step, x0, x, total_steps)
            if int(step) + 1 != self.pause_step:
                return
            try:
                PromptServer.instance.send_sync(
                    "aivideosite_test_pause",
                    {"job_id": self.job_id, "step": self.pause_step},
                    PromptServer.instance.client_id,
                )
            except Exception:
                logging.exception("AIVideo test pause notification failed")
            resume = self.folder / (self.job_id + ".resume")
            cancel = self.folder / (self.job_id + ".cancel")
            while True:
                if cancel.is_file():
                    cancel.unlink(missing_ok=True)
                    raise RuntimeError("AIVideo test generation cancelled")
                if resume.is_file():
                    resume.unlink(missing_ok=True)
                    break
                time.sleep(0.25)

        return executor(
            noise, latent_image, sampler, sigmas, denoise_mask, on_step,
            disable_pbar, seed, latent_shapes=latent_shapes,
        )


class AIVideoTestPause:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "job_id": ("STRING", {"default": ""}),
            "pause_step": ("INT", {"default": 4, "min": 1, "max": 24}),
            "control_dir": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "wrap"
    CATEGORY = "aivideosite"

    def wrap(self, model, job_id, pause_step, control_dir):
        if not _JOB_ID.fullmatch(str(job_id)) or not control_dir:
            raise ValueError("Invalid AIVideo test pause configuration")
        clone = model.clone()
        clone.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            "aivideosite_test_pause_" + job_id,
            _PauseWrapper(job_id, pause_step, control_dir),
        )
        return (clone,)


NODE_CLASS_MAPPINGS = {"AIVideoTestPause": AIVideoTestPause}
NODE_DISPLAY_NAME_MAPPINGS = {"AIVideoTestPause": "AI Video · Test Pause"}
