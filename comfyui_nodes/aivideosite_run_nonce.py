"""A pass-through model node that keeps distinct site jobs out of ComfyUI's output cache.

The run ID participates in ComfyUI's input signature, but never changes the
model, sampler seed, conditioning, or generated pixels.
"""


class AIVideoRunNonce:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "run_id": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "passthrough"
    CATEGORY = "aivideosite"

    def passthrough(self, model, run_id):
        return (model,)


NODE_CLASS_MAPPINGS = {"AIVideoRunNonce": AIVideoRunNonce}
NODE_DISPLAY_NAME_MAPPINGS = {"AIVideoRunNonce": "AI Video · New Generation"}
