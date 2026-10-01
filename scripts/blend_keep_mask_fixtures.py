"""Writes frontend/tests/unit/fixtures/runner-blend-keep-mask.json: what the
REAL `BlendSceneNode.execute` (comfy_api_nodes/nodes_replicate.py, its
keep_subject step) makes when keep_subject is Image to mask's mask of a
loaded picture: Product shot's "keep the product exact" (step 3, R8.1).

Every picture reaches the node through the real Python loader:

  composite — LoadImage (IMAGE: RGB), the picture blended;
  mask      — LoadImage of the app's mask PNG (black, the product's silhouette
              in grey) → ImageToMask (channel red);
  answer    — the provider's picture, through the real download decode
              (bytesio_to_image_tensor), the provider call replaced.

Cases: the mask at the picture's size and at another size (resized
bilinear), keep_feather 0 and 4, and the silhouette's grey at 0, 0.7 and 1.
Each stores the 8-bit result as save_generation_output writes it (255·x
truncated, RGB).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/blend_keep_mask_fixtures.py

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


if __name__ == "__main__":
    block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-blend-keep-mask.json")

import numpy as np  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402

WORK = tempfile.mkdtemp(prefix="blend-keep-mask-fixtures-")
for sub in ("input", "temp", "output"):
    os.makedirs(os.path.join(WORK, sub), exist_ok=True)
folder_paths.set_input_directory(os.path.join(WORK, "input"))
folder_paths.set_temp_directory(os.path.join(WORK, "temp"))
folder_paths.set_output_directory(os.path.join(WORK, "output"))

import nodes  # noqa: E402
from comfy_extras.nodes_mask import ImageToMask  # noqa: E402
from comfy_api_nodes import nodes_replicate as nr  # noqa: E402
from comfy_api_nodes.util.conversions import bytesio_to_image_tensor  # noqa: E402

W, H = 48, 40


def png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    PILImage.fromarray(arr.astype(np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


def composite() -> bytes:
    y, x = np.mgrid[0:H, 0:W]
    r = (x * 5 + y * 3) % 256
    g = (x * 11 + 40) % 256
    b = (y * 13 + x * 2 + 90) % 256
    return png(np.stack([r, g, b], -1))


def answer() -> bytes:
    """The provider's picture: another size than the composite (Python resizes it back)."""
    h, w = 44, 52
    y, x = np.mgrid[0:h, 0:w]
    return png(np.stack([(x * 4) % 256, (y * 6 + 30) % 256, ((x + y) * 3) % 256], -1))


def mask(w: int, h: int, grey: float) -> bytes:
    """The app's keep-mask: black, the product's silhouette (an ellipse) at round(grey·255), opaque RGBA."""
    y, x = np.mgrid[0:h, 0:w]
    inside = ((x - w * 0.5) / (w * 0.3)) ** 2 + ((y - h * 0.55) / (h * 0.32)) ** 2 <= 1
    v = round(grey * 255)
    rgb = np.where(inside[..., None], v, 0) * np.ones(3)
    return png(np.concatenate([rgb, np.full((h, w, 1), 255)], -1))


def b64(raw: bytes) -> str:
    return base64.b64encode(zlib.compress(raw, 9)).decode()


def run_case(comp_name: str, mask_name: str, feather: float, answer_png: bytes) -> np.ndarray:
    image = nodes.LoadImage().load_image(comp_name)[0]
    mpic = nodes.LoadImage().load_image(mask_name)[0]
    keep = ImageToMask.execute(mpic, "red").result[0]

    async def kontext(*_a, **_k):
        return "https://fixture.invalid/answer.png"

    async def download(_url, **_k):
        return bytesio_to_image_tensor(io.BytesIO(answer_png))

    with mock.patch.object(nr, "_run_fal_kontext", kontext), \
            mock.patch.object(nr, "download_url_to_image_tensor", download), \
            mock.patch.object(nr, "_image_tensor_to_data_url", lambda *_a, **_k: "data:image/png;base64,"), \
            mock.patch.object(nr, "save_generation_output", lambda *_a, **_k: None):
        out = asyncio.run(nr.BlendSceneNode.execute(
            model="Flux Kontext Pro", image=image, keep_subject=keep, keep_feather=feather,
            prompt="relight", seed=7, output_format="png"))
    t = out.result[0][0]
    # save_generation_output: 255·x, clipped, truncated to 8 bits.
    return np.clip(255.0 * t.cpu().numpy(), 0, 255).astype(np.uint8)


def main() -> None:
    comp = composite()
    ans = answer()
    with open(os.path.join(WORK, "input", "composite.png"), "wb") as f:
        f.write(comp)
    assets = {"composite.png": base64.b64encode(comp).decode(), "answer.png": base64.b64encode(ans).decode()}
    cases = []
    for size_name, (mw, mh) in (("equal size", (W, H)), ("other size", (30, 25))):
        for feather in (0.0, 4.0):
            for grey in (0.0, 0.7, 1.0):
                name = f"mask {size_name}, feather {feather:g}, grey {grey:g}"
                mname = f"mask_{mw}x{mh}_{round(grey * 255)}.png"
                mbytes = mask(mw, mh, grey)
                with open(os.path.join(WORK, "input", mname), "wb") as f:
                    f.write(mbytes)
                assets[mname] = base64.b64encode(mbytes).decode()
                out8 = run_case("composite.png", mname, feather, ans)
                assert out8.shape == (H, W, 3), out8.shape
                cases.append({"name": name, "mask": mname, "feather": feather, "grey": grey,
                              "width": W, "height": H, "out8": b64(out8.tobytes())})
    with open(OUT, "w") as f:
        json.dump({"composite": "composite.png", "answer": "answer.png", "assets": assets, "cases": cases}, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
