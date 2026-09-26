"""Writes frontend/tests/unit/fixtures/runner-blend-keep.json: what the REAL
Frame (`CompositorNode.execute`, comfy_extras/nodes_compositor.py) and the REAL
Blend scene (`BlendSceneNode.execute`, comfy_api_nodes/nodes_replicate.py) make
when a Frame's protect_mask is wired into Blend's keep_subject, for the Sailor
runner's port (frontend/server/runner/compositor/, Task F11b) to be measured
against (tests/unit/runner-blend-keep.unit.spec.ts).

Each case: one or two Frames built from small synthetic pictures loaded the way
a real run loads them (an Image card's `Image.process`), a Blend scene whose
`image` is a Frame's composite (or an Image card) and whose `keep_subject` is a
Frame's protect_mask, and a stand-in for the provider: the provider call is
replaced by a fixed URL and the download by a fixed picture, which then goes
through the real `download_url_to_image_tensor` (bytesio_to_image_tensor).
Everything after the download is the node's own code, unchanged.

Stored per case: each Frame's 8-bit composite (what save_live_preview writes),
its protect_mask (round(x·65535), little-endian uint16), and the Blend result's
8-bit pixels (what save_generation_output writes), or the error Python raised.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python frontend/scripts/blend_keep_fixtures.py

The network is blocked: every outbound connect and DNS lookup raises and the
provider keys are removed before any node module is imported.
"""
import asyncio
import base64
import io
import json
import os
import socket
import sys
import tempfile
import zlib
from unittest import mock

PROVIDER_KEYS = ("FAL_KEY", "FAL_API_KEY", "NUXT_REPLICATE_TOKEN", "REPLICATE_API_TOKEN")


def block_network() -> None:
    def refuse(*a, **_k):
        raise RuntimeError(f"NETWORK BLOCKED: {a!r}")
    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    for key in PROVIDER_KEYS:
        os.environ.pop(key, None)


block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-blend-keep.json")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402

WORK = tempfile.mkdtemp(prefix="blend-keep-fixtures-")
for sub in ("input", "temp", "output"):
    os.makedirs(os.path.join(WORK, sub), exist_ok=True)
folder_paths.set_input_directory(os.path.join(WORK, "input"))
folder_paths.set_temp_directory(os.path.join(WORK, "temp"))
folder_paths.set_output_directory(os.path.join(WORK, "output"))

from comfy_extras import nodes_compositor as nc  # noqa: E402
from comfy_extras.nodes_image import Image as ImageCard  # noqa: E402
from comfy_api_nodes import nodes_replicate as nr  # noqa: E402
from comfy_api_nodes.util import download_helpers  # noqa: E402
from comfy_api.latest._io import HiddenHolder  # noqa: E402


# ── Synthetic pictures ───────────────────────────────────────────────────────

def _pattern(h: int, w: int, seed: int) -> np.ndarray:
    """A busy but deterministic RGB picture (the same recipe as scripts/compositor_fixtures.py)."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    r = 0.5 + 0.5 * np.sin(x * (0.37 + 0.05 * seed) + y * 0.11 + seed)
    g = (x / max(1, w - 1)) * 0.7 + (y / max(1, h - 1)) * 0.3
    b = 0.5 + 0.5 * np.cos((x - y) * (0.23 + 0.02 * seed) - seed * 0.7)
    img = np.stack([r, g, b], axis=-1)
    y0, x0 = h // 4 + seed % 3, w // 5 + seed % 4
    img[y0:y0 + h // 3, x0:x0 + w // 4] = [(seed * 0.29) % 1, 0.9, (seed * 0.53) % 1]
    return np.clip(np.floor(img * 255.0 + 0.5), 0, 255).astype(np.uint8)


def _circle_alpha(h: int, w: int, soft: float = 4.0) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    d = np.sqrt((x - (w - 1) / 2) ** 2 + (y - (h - 1) / 2) ** 2)
    rad = min(h, w) * 0.38
    a = np.clip((rad - d) / soft + 0.5, 0, 1)
    return np.floor(a * 255.0 + 0.5).astype(np.uint8)


def _png(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    PILImage.fromarray(arr, mode).save(buf, "PNG")
    return buf.getvalue()


def _assets() -> dict[str, bytes]:
    a: dict[str, bytes] = {}
    # Frame pictures (Image cards).
    a["land.png"] = _png(_pattern(32, 48, 1), "RGB")
    a["wide.png"] = _png(_pattern(36, 64, 3), "RGB")
    a["tall.png"] = _png(_pattern(120, 100, 4), "RGB")
    a["disc.png"] = _png(np.dstack([_pattern(40, 40, 6), _circle_alpha(40, 40)]), "RGBA")
    a["port.png"] = _png(_pattern(48, 32, 2), "RGB")
    # What the stand-in provider sends back.
    a["edit_big.png"] = _png(_pattern(64, 96, 21), "RGB")
    a["edit_same.png"] = _png(_pattern(32, 48, 22), "RGB")
    buf = io.BytesIO()
    PILImage.fromarray(_pattern(20, 30, 23), "RGB").save(buf, "JPEG", quality=88)
    a["edit_small.jpg"] = buf.getvalue()
    ramp = np.tile(np.linspace(0, 255, 48).astype(np.uint8), (32, 1))
    a["edit_rgba.png"] = _png(np.dstack([_pattern(32, 48, 24), ramp]), "RGBA")
    a["edit_wide.png"] = _png(_pattern(50, 90, 25), "RGB")
    a["edit_tall.png"] = _png(_pattern(150, 125, 26), "RGB")
    return a


ASSETS = _assets()
for _name, _bytes in ASSETS.items():
    with open(os.path.join(WORK, "input", _name), "wb") as f:
        f.write(_bytes)


def card(name: str) -> torch.Tensor:
    """The tensor an Image card showing `name` hands on (Image.process)."""
    out = ImageCard().process(
        image=name, export=False, filename_prefix="fixture", format="png", quality=90,
        lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=False,
        batch_index=-1, images=None, prompt=None, extra_pnginfo=None, unique_id="fixture",
    )
    return out["result"][0]


# ── Encoding ─────────────────────────────────────────────────────────────────

def _pack(arr: np.ndarray, dtype) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr).astype(dtype).tobytes(), 9)).decode("ascii")


def u16(t: torch.Tensor) -> str:
    """Float in [0,1] → round(x·65535) as little-endian uint16 (the runner's 16-bit mask file rounds the same way)."""
    a = t.detach().float().cpu().numpy()
    return _pack(np.floor(np.clip(a, 0.0, 1.0) * 65535.0 + 0.5), "<u2")


def u8_truncated(t: torch.Tensor) -> str:
    """Exactly what save_live_preview and save_generation_output write: clip(255·x).astype(uint8)."""
    a = t.detach().float().cpu().numpy()
    return _pack(np.clip(255.0 * a, 0, 255).astype(np.uint8), np.uint8)


# ── The two nodes ────────────────────────────────────────────────────────────

def frame_widgets(**over) -> dict:
    w = {}
    for i in range(1, 17):
        w.update({f"layer{i}_x": 0.0, f"layer{i}_y": 0.0, f"layer{i}_rotation": 0.0, f"layer{i}_scale": 1.0,
                  f"layer{i}_opacity": 1.0, f"layer{i}_blend": "normal", f"layer{i}_z": float(i),
                  f"layer{i}_protect": False, f"layer{i}_cloner": ""})
    w.update({"width": 0, "height": 0, "motion_params": ""})
    w.update(over)
    return w


def run_frame(links: dict, inputs: dict):
    kwargs = frame_widgets(**inputs)
    for name, asset in links.items():
        kwargs[name] = card(asset)
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})), \
            mock.patch.object(nc, "save_live_preview", lambda *_a, **_k: {}):
        out = nc.CompositorNode.execute(**kwargs)
    return out.result[0], out.result[1]


EDITED_URL = "https://provider.test/edited"


def run_blend(model: str, image: torch.Tensor, keep: torch.Tensor, feather: float, edited: str):
    """BlendSceneNode.execute, the provider replaced by a fixed answer; returns (tensor, None) or (None, error)."""
    saved = []

    async def fake_download(url, dest, *_a, **_k):
        assert url == EDITED_URL, url
        dest.write(ASSETS[edited])

    async def fake_fal(*_a, **_k):
        return EDITED_URL

    async def fake_prediction(*_a, **_k):
        return {"output": [EDITED_URL]}

    with mock.patch.object(download_helpers, "download_url_to_bytesio", fake_download), \
            mock.patch.object(nr, "_run_fal_kontext", fake_fal), \
            mock.patch.object(nr, "_run_fal_flux2_edit", fake_fal), \
            mock.patch.object(nr, "_run_prediction", fake_prediction), \
            mock.patch.object(nr, "save_generation_output", lambda t, *_a, **_k: saved.append(t) or {}):
        try:
            out = asyncio.run(nr.BlendSceneNode.execute(
                model=model, image=image, unify_lighting=True, contact_shadows=True, match_camera_look=True,
                preserve_identity=True, keep_subject=keep, keep_feather=feather, prompt="", seed=7, output_format="png",
            ))
        except Exception as e:  # noqa: BLE001 — the node's own failure is the expected result
            return None, f"{type(e).__name__}: {e}"
    result = out.result[0]
    assert saved and saved[0] is result, "save_generation_output must get the result"
    return result, None


# ── Cases ────────────────────────────────────────────────────────────────────

def lay(i: int, **w) -> dict:
    names = {"x": "x", "y": "y", "rot": "rotation", "scale": "scale", "op": "opacity", "protect": "protect", "cloner": "cloner", "z": "z"}
    return {f"layer{i}_{names[k]}": (json.dumps(v) if k == "cloner" else v) for k, v in w.items()}


DISC_ON_LAND = {"links": {"layer1": "land.png", "layer2": "disc.png"},
                "inputs": lay(2, protect=True, scale=0.6, rot=15.0, x=0.1, y=-0.05)}

CASES = [
    {"name": "a protected cut-out, the answer twice the size, feather 2 (Kontext)", "model": "Flux Kontext Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 2.0, "edited": "edit_big.png"},
    {"name": "no feather, the answer the same size (Flux 2 Pro)", "model": "Flux 2 Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 0.0, "edited": "edit_same.png"},
    {"name": "feather 1.5 rounds 4.5 to 4 (9 taps), a smaller JPEG answer (Nano Banana)", "model": "Nano Banana",
     "frames": {"A": {"links": {"layer1": "land.png", "layer2": "disc.png"},
                      "inputs": lay(2, protect=True, op=0.6, scale=0.3,
                                    cloner={"enabled": True, "mode": "linear", "countX": 3, "spacingX": 0.25, "stepOpacity": 0.7})}},
     "image": ["frame", "A"], "mask": "A", "feather": 1.5, "edited": "edit_small.jpg"},
    {"name": "feather 0.5 rounds 1.5 to 2 (5 taps), two protected layers, an RGBA answer", "model": "Flux Kontext Pro",
     "frames": {"A": {"links": {"layer1": "land.png", "layer2": "disc.png", "layer3": "port.png"},
                      "inputs": {**lay(1, protect=True, op=0.4), **lay(2, protect=True, scale=0.5, x=-0.2),
                                 **lay(3, protect=True, scale=0.4, x=0.3, rot=-30.0)}}},
     "image": ["frame", "A"], "mask": "A", "feather": 0.5, "edited": "edit_rgba.png"},
    {"name": "nothing protected: the answer everywhere", "model": "Flux 2 Pro",
     "frames": {"A": {"links": {"layer1": "land.png", "layer2": "disc.png"}, "inputs": lay(2, scale=0.6)}},
     "image": ["frame", "A"], "mask": "A", "feather": 2.0, "edited": "edit_big.png"},
    {"name": "a mask from a smaller Frame is stretched to the picture", "model": "Flux Kontext Pro",
     "frames": {"A": {"links": {"layer1": "land.png"}, "inputs": {}},
                "B": {"links": {"layer1": "port.png", "layer2": "disc.png"},
                      "inputs": {"width": 24, "height": 16, **lay(2, protect=True, scale=0.8)}}},
     "image": ["frame", "A"], "mask": "B", "feather": 1.0, "edited": "edit_big.png"},
    {"name": "the picture straight from an Image card, the mask from a Frame on it", "model": "Nano Banana",
     "frames": {"A": {"links": {"layer1": "wide.png", "layer2": "disc.png"}, "inputs": lay(2, protect=True, scale=0.7, rot=40.0)}},
     "image": ["card", "wide.png"], "mask": "A", "feather": 2.5, "edited": "edit_wide.png"},
    {"name": "feather 7.3: 45 taps", "model": "Flux 2 Pro",
     "frames": {"A": {"links": {"layer1": "tall.png", "layer2": "disc.png"}, "inputs": lay(2, protect=True, scale=0.5, y=0.2)}},
     "image": ["frame", "A"], "mask": "A", "feather": 7.3, "edited": "edit_tall.png"},
    {"name": "feather 30 on a 32-pixel-high picture: the blur's edge padding is refused", "model": "Flux Kontext Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 30.0, "edited": "edit_big.png"},
    {"name": "feather 5 on a 32-pixel-high picture: 15 pixels of padding fits", "model": "Flux Kontext Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 5.0, "edited": "edit_same.png"},
    {"name": "feather 5.2 on a 32-pixel-high picture: 16 pixels of padding fits", "model": "Flux Kontext Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 5.2, "edited": "edit_same.png"},
    {"name": "feather 10.5 on a 32-pixel-high picture: 32 pixels of padding is refused", "model": "Flux Kontext Pro",
     "frames": {"A": DISC_ON_LAND}, "image": ["frame", "A"], "mask": "A", "feather": 10.5, "edited": "edit_same.png"},
]


def run_case(c: dict) -> dict:
    frames = {}
    tensors = {}
    for key, fr in c["frames"].items():
        image, protect = run_frame(fr["links"], fr["inputs"])
        tensors[key] = (image, protect)
        _b, h, w, _c = image.shape
        frames[key] = {"links": fr["links"], "inputs": fr["inputs"], "width": int(w), "height": int(h),
                       "image8": u8_truncated(image[0]), "protect": u16(protect[0])}
    kind, ref = c["image"]
    image = tensors[ref][0] if kind == "frame" else card(ref)
    result, error = run_blend(c["model"], image, tensors[c["mask"]][1], c["feather"], c["edited"])
    out = {k: c[k] for k in ("name", "model", "image", "mask", "feather", "edited")}
    out["frames"] = frames
    if error is not None:
        out["error"] = error
    else:
        _b, h, w, ch = result.shape
        assert ch == 3
        out.update({"width": int(w), "height": int(h), "out8": u8_truncated(result[0])})
    return out


def main() -> None:
    torch.set_num_threads(1)
    cases = [run_case(c) for c in CASES]
    doc = {
        "note": "Written by frontend/scripts/blend_keep_fixtures.py from the real CompositorNode.execute and BlendSceneNode.execute. Do not edit.",
        "assets": {k: base64.b64encode(v).decode("ascii") for k, v in ASSETS.items()},
        "cases": cases,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(cases)} blend keep_subject cases ({sum('error' in c for c in cases)} refusals) → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
