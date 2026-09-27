"""Shared LaMa inpainting helper (Large Mask inpainting, ~196 MB).

LaMa is a Fourier-convolution inpainting model trained on big masks — much
better than diffusion at "fill this hole clean and leave no hint". White in the
mask = inpaint, black = keep.

Extracted from nodes_object_remove so both Object Removal and Lens · 3D Reframe
(which fills disocclusion holes after reprojection) share one session + loop.
"""
from __future__ import annotations

import os

import numpy as np
import torch

import folder_paths
from comfy_extras._model_downloads import (
    ModelBundle, ModelFile, loader_cache, register_bundle,
)

# Carve mirrors the official big-lama as a single fp32 ONNX, which means we can
# lean on onnxruntime (already pulled in by rembg) instead of
# bundling the PyTorch source.
_MODELS_ROOT = os.path.join(folder_paths.models_dir, "lama")
_MODEL_PATH = os.path.join(_MODELS_ROOT, "lama_fp32.onnx")
_MODEL_URLS = [
    "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
]
_MODEL_SIZE = 205_653_341  # bytes, official file size


register_bundle(ModelBundle(
    key="objectremove",
    label="Object Removal",
    files=[ModelFile(name="lama_fp32.onnx", path=_MODEL_PATH, size=_MODEL_SIZE, urls=_MODEL_URLS)],
))


def lama_ready() -> bool:
    """True iff the LaMa ONNX model is on disk."""
    return os.path.isfile(_MODEL_PATH)


def _get_session():
    cache = loader_cache()
    if "objectremove:session" in cache:
        return cache["objectremove:session"]
    import onnxruntime as ort
    providers = (
        ["CoreMLExecutionProvider", "CPUExecutionProvider"]
        if not torch.cuda.is_available()
        else ["CUDAExecutionProvider", "CPUExecutionProvider"]
    )
    sess = ort.InferenceSession(_MODEL_PATH, providers=providers)
    cache["objectremove:session"] = sess
    return sess


# This Carve LaMa-ONNX export has a FIXED 512x512 input (verified via the
# model's declared input shape ['batch',3,512,512]) — it is NOT dynamic-shape.
# So we run the model at 512, then resize the fill back and composite only the
# masked pixels over the full-resolution original (non-hole pixels stay sharp).
_LAMA_SIZE = 512


def lama_inpaint(frames: torch.Tensor, mask: torch.Tensor, grow: int = 0) -> torch.Tensor:
    """Inpaint the white regions of `mask` in `frames` using LaMa.

    frames: IMAGE tensor [T,H,W,3] or [H,W,3], values [0,1].
    mask:   [H,W] (one mask for all frames) or [T,H,W], values [0,1] (white = fill).
    grow:   dilate the mask by this many pixels before inpainting (original-res px).

    Returns a tensor matching the input rank ([T,H,W,3] in → [T,H,W,3] out,
    [H,W,3] in → [H,W,3] out). Only masked pixels change; the rest is preserved.
    """
    import cv2

    squeeze_out = frames.ndim == 3
    if squeeze_out:
        frames = frames.unsqueeze(0)
    T, H, W, _ = frames.shape

    # Normalize mask to [T,H,W].
    if mask.dim() == 2:
        mask_batch = mask.unsqueeze(0).expand(T, -1, -1).contiguous()
    else:
        mask_batch = mask
        if mask_batch.shape[0] == 1 and T > 1:
            mask_batch = mask_batch.expand(T, -1, -1).contiguous()

    sess = _get_session()
    in_name_img = sess.get_inputs()[0].name
    in_name_mask = sess.get_inputs()[1].name
    kernel = np.ones((3, 3), np.uint8)

    out_frames: list[torch.Tensor] = []
    for t in range(T):
        img = (frames[t].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
        m = (mask_batch[t].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)

        if grow > 0:
            m = cv2.dilate(m, kernel, iterations=int(grow))

        # Nothing to fill on this frame → leave it untouched.
        if int(m.max()) == 0:
            out_frames.append(frames[t].detach().cpu().clone())
            continue

        # Resize to the model's fixed 512x512 (area for image, linear for mask).
        img_s = cv2.resize(img, (_LAMA_SIZE, _LAMA_SIZE), interpolation=cv2.INTER_AREA)
        m_s = cv2.resize(m, (_LAMA_SIZE, _LAMA_SIZE), interpolation=cv2.INTER_LINEAR)

        # ONNX inputs: image [1,3,512,512] float32 [0,1], mask [1,1,512,512] {0,1}.
        img_t = img_s.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        mask_t = (m_s.astype(np.float32) > 127.5).astype(np.float32)[None, None]

        out = sess.run(None, {in_name_img: img_t, in_name_mask: mask_t})[0]
        # LaMa returns uint8-scaled floats [0, 255] in some exports. Normalize.
        arr = out[0].transpose(1, 2, 0)
        if arr.max() > 1.5:
            arr = arr / 255.0
        arr = np.clip(arr, 0.0, 1.0)

        # Resize the fill back to full res and composite only the masked pixels
        # over the original (so unmasked pixels keep their full resolution).
        fill = cv2.resize((arr * 255.0).astype(np.uint8), (W, H),
                          interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255.0
        blend = (m.astype(np.float32) / 255.0)[..., None]
        composed = fill * blend + frames[t].detach().cpu().numpy() * (1.0 - blend)
        out_frames.append(torch.from_numpy(composed.astype(np.float32)))

    result = torch.stack(out_frames, dim=0)
    return result[0] if squeeze_out else result
