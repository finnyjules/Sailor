"""Writes frontend/tests/unit/fixtures/runner-compositor.json: what the REAL
`CompositorNode.execute` (comfy_extras/nodes_compositor.py) makes from small
synthetic pictures, for the Sailor runner's TypeScript port
(frontend/server/runner/compositor/) to be measured against
(tests/unit/runner-compositor.unit.spec.ts).

Every picture reaches the node the way it does in a real run, through the real
Python loader for its source:

  provider   — a provider node's download (bytesio_to_image_tensor: RGBA, no EXIF turn)
  card       — an Image card loading its file (Image.process: RGB, or RGBA when the
               file has any transparency; EXIF turned)
  load       — the LoadImage the Frame editor injects for baked layers (IMAGE: RGB)
  load_mask  — the same LoadImage's MASK output (1 - alpha, or a 64×64 zero mask)

Each case stores the composite (float, as 16-bit), the 8-bit PNG pixels
save_live_preview writes (255·x truncated), and the protect_mask. Each loaded
picture is stored too, so a decode difference shows up on its own.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/compositor_fixtures.py

The network is blocked (as in runner_builder_fixtures.py): every outbound
connect and DNS lookup raises and the provider keys are removed before any
node module is imported. Nothing here needs the network.
"""
import asyncio
import base64
import hashlib
import io
import json
import math
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


if __name__ == "__main__" and "--allow-network" not in sys.argv[1:]:
    block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-compositor.json")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402

WORK = tempfile.mkdtemp(prefix="compositor-fixtures-")
for sub in ("input", "temp", "output"):
    os.makedirs(os.path.join(WORK, sub), exist_ok=True)
folder_paths.set_input_directory(os.path.join(WORK, "input"))
folder_paths.set_temp_directory(os.path.join(WORK, "temp"))
folder_paths.set_output_directory(os.path.join(WORK, "output"))

import nodes  # noqa: E402
from comfy_extras import nodes_compositor as nc  # noqa: E402
from comfy_extras.nodes_image import Image as ImageCard  # noqa: E402
from comfy_api_nodes.util.conversions import bytesio_to_image_tensor  # noqa: E402
from comfy_api.latest._io import HiddenHolder  # noqa: E402


# ── Synthetic pictures ───────────────────────────────────────────────────────

def _pattern(h: int, w: int, seed: int) -> np.ndarray:
    """A busy but deterministic RGB picture: gradients, stripes and a hard block."""
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


def _png(arr: np.ndarray, mode: str, **info) -> bytes:
    buf = io.BytesIO()
    im = PILImage.fromarray(arr, mode)
    for k, v in info.items():
        im.info[k] = v
    im.save(buf, "PNG", **({"transparency": info["transparency"]} if "transparency" in info else {}))
    return buf.getvalue()


def _assets() -> dict[str, bytes]:
    a: dict[str, bytes] = {}
    a["land.png"] = _png(_pattern(32, 48, 1), "RGB")
    a["port.png"] = _png(_pattern(48, 32, 2), "RGB")
    a["wide.png"] = _png(_pattern(36, 64, 3), "RGB")
    a["tiny.png"] = _png(_pattern(8, 8, 4), "RGB")
    a["big.png"] = _png(_pattern(72, 96, 5), "RGB")
    rgb = _pattern(40, 40, 6)
    a["disc.png"] = _png(np.dstack([rgb, _circle_alpha(40, 40)]), "RGBA")
    # A cut-out whose alpha is 255 everywhere: an Image card loads it as RGB.
    a["opaque_rgba.png"] = _png(np.dstack([_pattern(30, 30, 7), np.full((30, 30), 255, np.uint8)]), "RGBA")
    # One pixel at 254: an Image card loads it as RGBA (any transparency at all).
    almost = np.full((30, 30), 255, np.uint8)
    almost[3, 4] = 254
    a["almost.png"] = _png(np.dstack([_pattern(30, 30, 8), almost]), "RGBA")
    # Masks the Frame editor bakes: a rectangle with a soft edge, and a small one to be stretched.
    y, x = np.mgrid[0:32, 0:48].astype(np.float64)
    rect = np.clip(np.minimum(np.minimum(x - 8, 40 - x), np.minimum(y - 6, 26 - y)) / 3 + 0.5, 0, 1)
    a["mask_rect.png"] = _png(np.dstack([_pattern(32, 48, 9), np.floor(rect * 255 + 0.5).astype(np.uint8)]), "RGBA")
    small = np.zeros((12, 20), np.uint8)
    small[2:9, 3:15] = 255
    small[5, :] = 128
    a["mask_small.png"] = _png(np.dstack([np.zeros((12, 20, 3), np.uint8), small]), "RGBA")
    # A baked text/shape layer: colour strokes on transparency.
    ov = np.zeros((32, 48, 4), np.uint8)
    ov[4:10, 5:40] = [250, 240, 20, 255]
    ov[14:28, 30:34] = [20, 30, 200, 180]
    ov[20:23, 2:45] = [230, 20, 90, 90]
    a["overlay.png"] = _png(ov, "RGBA")
    g = _pattern(24, 24, 10)[..., 0]
    a["gray.png"] = _png(g, "L")
    a["graya.png"] = _png(np.dstack([g, _circle_alpha(24, 24, 2.0)]), "LA")
    # A palette picture with a transparent index.
    pal = PILImage.fromarray(_pattern(20, 20, 11), "RGB").quantize(colors=16, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE)
    buf = io.BytesIO()
    pal.save(buf, "PNG", transparency=3)
    a["pal.png"] = buf.getvalue()
    buf = io.BytesIO()
    PILImage.fromarray(_pattern(30, 40, 12), "RGB").save(buf, "JPEG", quality=85)
    a["photo.jpg"] = buf.getvalue()
    # A JPEG shot "sideways": EXIF Orientation 6 (an Image card turns it, a provider download does not).
    im = PILImage.fromarray(_pattern(24, 36, 13), "RGB")
    exif = im.getexif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90, exif=exif.tobytes())
    a["sideways.jpg"] = buf.getvalue()
    # A large RGBA picture for a strong downscale onto a 640×360 artboard:
    # smooth gradients, fine stripes (the aliasing a downscale meets) and a soft oval of alpha.
    y, x = np.mgrid[0:900, 0:1600].astype(np.float64)
    huge = np.stack([x / 1599, y / 899, 0.5 + 0.5 * np.sin(x / 90.0)], axis=-1)
    huge[:, :, 2] = np.where((x.astype(int) // 3) % 2 == 0, huge[:, :, 2], 1 - huge[:, :, 2])
    oval = np.clip(1.5 - np.sqrt(((x - 800) / 700) ** 2 + ((y - 450) / 380) ** 2) * 1.5, 0, 1)
    a["huge.png"] = _png(np.dstack([np.floor(huge * 255 + 0.5).astype(np.uint8), np.floor(oval * 255 + 0.5).astype(np.uint8)]), "RGBA")
    # A large opaque photo-like picture (RGB through every loader), to be scaled down at real sizes.
    a["photo_big.png"] = _png(_pattern(800, 1200, 14), "RGB")
    return a


ASSETS = _assets()
for _name, _bytes in ASSETS.items():
    with open(os.path.join(WORK, "input", _name), "wb") as f:
        f.write(_bytes)


def load(name: str, via: str) -> torch.Tensor:
    """The tensor the node receives for `name` from a source of kind `via`."""
    if via == "provider":
        return bytesio_to_image_tensor(io.BytesIO(ASSETS[name]))
    if via == "card":
        out = ImageCard().process(
            image=name, export=False, filename_prefix="fixture", format="png", quality=90,
            lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=False,
            batch_index=-1, images=None, prompt=None, extra_pnginfo=None, unique_id="fixture",
        )
        return out["result"][0]
    if via == "load":
        return nodes.LoadImage().load_image(name)[0]
    if via == "load_mask":
        return nodes.LoadImage().load_image(name)[1]
    raise ValueError(via)


# ── Encoding ─────────────────────────────────────────────────────────────────

def _pack(arr: np.ndarray, dtype) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr).astype(dtype).tobytes(), 9)).decode("ascii")


def u16(t: torch.Tensor) -> str:
    """Float in [0,1] → round(x·65535) as little-endian uint16."""
    a = t.detach().float().cpu().numpy()
    return _pack(np.floor(np.clip(a, 0.0, 1.0) * 65535.0 + 0.5), "<u2")


def u8_truncated(t: torch.Tensor) -> str:
    """Exactly what save_live_preview writes: clip(255·x).astype(uint8)."""
    a = t.detach().float().cpu().numpy()
    return _pack(np.clip(255.0 * a, 0, 255).astype(np.uint8), np.uint8)


def f32_sha256(t: torch.Tensor) -> str:
    """sha256 of the tensor's float32 values, C order, little-endian: equal only when every bit is."""
    return hashlib.sha256(np.ascontiguousarray(t.detach().cpu().numpy().astype("<f4")).tobytes()).hexdigest()


# ── Cases ────────────────────────────────────────────────────────────────────

BLENDS = nc._BLEND_MODES


def layer(i: int, **w) -> dict:
    names = {"x": "x", "y": "y", "rot": "rotation", "scale": "scale", "op": "opacity",
             "blend": "blend", "z": "z", "protect": "protect", "cloner": "cloner"}
    return {f"layer{i}_{names[k]}": (json.dumps(v) if k == "cloner" and isinstance(v, dict) else v)
            for k, v in w.items()}


def case(name: str, links: dict, **inputs) -> dict:
    return {"name": name, "links": links, "inputs": inputs}


def cl(**c) -> dict:
    return {"enabled": True, **c}


CASES = []
# Every blend mode, over a busy base, the top layer letterboxed (transparent bars: a provider picture is RGBA).
for m in BLENDS:
    CASES.append(case(f"blend {m}", {"layer1": ["land.png", "provider"], "layer2": ["port.png", "provider"]},
                      **layer(2, x=0.08, y=-0.05, rot=12.0, scale=1.3, op=0.8, blend=m)))
# Blend modes over a cut-out with soft alpha.
for m in ("overlay", "soft_light", "difference", "screen", "add"):
    CASES.append(case(f"blend {m} over a cut-out", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
                      **layer(2, x=-0.1, scale=0.9, blend=m)))

CASES += [
    # Transforms.
    case("an RGB card turned 90° paints its letterbox bars", {"layer1": ["wide.png", "card"], "layer2": ["land.png", "card"]},
         **layer(2, rot=90.0)),
    case("turned -45°, small, offset", {"layer1": ["land.png", "provider"], "layer2": ["port.png", "provider"]},
         **layer(2, rot=-45.0, scale=0.35, x=0.3, y=0.2)),
    case("turned 180°, large, offset, half opacity", {"layer1": ["land.png", "card"], "layer2": ["wide.png", "card"]},
         **layer(2, rot=180.0, scale=2.2, x=-0.6, y=0.4, op=0.6)),
    case("the limits: offset 1.5, scale 3, -180°", {"layer1": ["big.png", "provider"], "layer2": ["tiny.png", "provider"]},
         **layer(2, rot=-180.0, scale=3.0, x=1.5, y=-1.5)),
    case("the smallest scale", {"layer1": ["land.png", "provider"], "layer2": ["wide.png", "card"]},
         **layer(2, scale=0.1, x=-0.2)),
    case("scale below the floor clamps to 0.01", {"layer1": ["land.png", "provider"], "layer2": ["wide.png", "card"]},
         **layer(2, scale=0.001)),
    case("opacity 0 and 0.37", {"layer1": ["land.png", "provider"], "layer2": ["port.png", "card"], "layer3": ["disc.png", "provider"]},
         **layer(2, op=0.0), **layer(3, op=0.37, rot=33.0)),
    case("layer 1 offset and turned too", {"layer1": ["land.png", "card"]}, **layer(1, x=0.2, y=0.1, rot=7.5, scale=0.9)),
    case("a same-size layer (no fit)", {"layer1": ["land.png", "provider"], "layer2": ["mask_rect.png", "provider"]},
         **layer(2, x=0.013, y=-0.021, blend="multiply")),
    # Stacking order.
    case("z reversed", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"], "layer3": ["disc.png", "card"]},
         **layer(1, z=3.0), **layer(2, z=2.0, x=0.2), **layer(3, z=1.0, x=-0.2)),
    case("equal z keeps slot order", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"], "layer3": ["disc.png", "card"]},
         **layer(1, z=0.0), **layer(2, z=0.0, x=0.2), **layer(3, z=0.0, x=-0.2)),
    case("negative and fractional z", {"layer1": ["wide.png", "provider"], "layer2": ["disc.png", "card"], "layer3": ["port.png", "provider"]},
         **layer(2, z=-2.5, blend="screen"), **layer(3, z=1.5, scale=0.6)),
    # Per-layer masks.
    case("a layer mask", {"layer1": ["land.png", "provider"], "layer2": ["wide.png", "provider"], "layer2_mask": ["mask_rect.png", "load_mask"]},
         **layer(2, rot=20.0)),
    case("a small mask is stretched to the canvas", {"layer1": ["land.png", "card"], "layer2": ["port.png", "card"], "layer2_mask": ["mask_small.png", "load_mask"]}),
    case("an opaque file's 64×64 zero mask", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"], "layer2_mask": ["land.png", "load_mask"]},
         **layer(2, op=0.7)),
    case("a mask on layer 1 with opacity", {"layer1": ["land.png", "provider"], "layer1_mask": ["mask_rect.png", "load_mask"]},
         **layer(1, op=0.5)),
    case("a baked local layer between wired ones", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"],
                                                   "layer3": ["overlay.png", "load"], "layer3_mask": ["overlay.png", "load_mask"]},
         **layer(1, z=0.0), **layer(3, z=1.0), **layer(2, z=2.0, scale=0.5, x=0.25)),
    case("a baked local layer with a blend mode", {"layer1": ["land.png", "card"], "layer2": ["overlay.png", "load"], "layer2_mask": ["overlay.png", "load_mask"]},
         **layer(2, blend="hard_light")),
    # Artboard size.
    case("an explicit artboard fits every layer", {"layer1": ["land.png", "provider"], "layer2": ["port.png", "card"]},
         width=80, height=45, **layer(2, x=0.1)),
    case("an explicit artboard with no layers is black", {}, width=40, height=24),
    case("no layers and no size: 16×16 black", {}),
    case("width without height sizes from layer 1", {"layer1": ["port.png", "card"], "layer2": ["land.png", "provider"]}, width=50, height=0),
    # No layer 1 (ComfyUI's validation refuses these prompts; execute() itself renders them).
    case("only the overlay, no size: 16×16 black, the overlay not laid", {"overlay": ["overlay.png", "load"], "overlay_mask": ["overlay.png", "load_mask"]}),
    case("only the overlay on an explicit artboard", {"overlay": ["overlay.png", "load"], "overlay_mask": ["overlay.png", "load_mask"]}, width=48, height=32),
    case("only baked local layers, on slots 3 and 5", {"layer3": ["overlay.png", "load"], "layer3_mask": ["overlay.png", "load_mask"],
                                                     "layer5": ["disc.png", "load"], "layer5_mask": ["disc.png", "load_mask"]},
         **layer(5, z=0.0, x=0.2)),
    case("the lowest connected slot sets the size", {"layer2": ["wide.png", "card"], "layer3": ["disc.png", "provider"]}),
    # Overlay.
    case("overlay with its mask", {"layer1": ["land.png", "card"], "overlay": ["overlay.png", "load"], "overlay_mask": ["overlay.png", "load_mask"]}),
    case("overlay without a mask covers everything", {"layer1": ["land.png", "card"], "overlay": ["wide.png", "load"]}),
    case("an RGBA overlay folds its own alpha (stretched)", {"layer1": ["land.png", "card"], "overlay": ["disc.png", "provider"]}),
    case("an RGBA overlay with a mask too", {"layer1": ["wide.png", "provider"], "overlay": ["disc.png", "card"], "overlay_mask": ["mask_small.png", "load_mask"]}),
    # Protect.
    case("one protected layer", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"]},
         **layer(2, protect=True, rot=25.0, scale=0.7)),
    case("the union of two protected layers", {"layer1": ["land.png", "card"], "layer2": ["port.png", "provider"], "layer3": ["disc.png", "card"]},
         **layer(1, protect=True, op=0.5), **layer(3, protect=True, x=0.3)),
    case("a protected masked layer", {"layer1": ["land.png", "card"], "layer2": ["wide.png", "provider"], "layer2_mask": ["mask_rect.png", "load_mask"]},
         **layer(2, protect=True)),
    case("protect as the text 'false' is still on", {"layer1": ["land.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, protect="false")),
    # Cloner.
    case("cloner linear with steps", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.4, x=-0.3, cloner=cl(mode="linear", countX=4, countY=1, spacingX=0.2, spacingY=0.2,
                                                   stepRotation=15, stepScale=0.85, stepOpacity=0.8))),
    case("cloner grid, mirrored, nudged, staggered", {"layer1": ["big.png", "provider"], "layer2": ["tiny.png", "provider"]},
         **layer(2, scale=0.2, cloner=cl(mode="linear", countX=3, countY=2, spacingX=0.2, spacingY=0.25, mirrorX=True,
                                           mirrorY=True, nudgeX=0.01, nudgeY=-0.02, staggerX=0.5, staggerY=0.3))),
    case("cloner radial ring facing the centre", {"layer1": ["big.png", "card"], "layer2": ["port.png", "provider"]},
         **layer(2, scale=0.25, cloner=cl(mode="radial", count=6, radius=0.3, faceCenter=True, stepScale=0.9, sweepAngle=360))),
    case("cloner radial arc", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, cloner=cl(mode="radial", count=5, radius=0.25, sweepAngle=180, startAngle=-90))),
    case("cloner vary falloff, blended colour", {"layer1": ["big.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, x=-0.35, cloner=cl(mode="linear", countX=5, spacingX=0.17, stepScale=0.8, stepRotation=20,
                                                    varyMode="falloff", varyFalloffCenter=0.5, varyFalloffRadius=0.4,
                                                    varyColor=True, varyPalette=["#ff0044", "#22cc88", "#3344ff"],
                                                    varyColorSpread="blend", varyColorStrength=0.7))),
    case("cloner vary random, cycled colour, mirrored grid", {"layer1": ["big.png", "provider"], "layer2": ["disc.png", "provider"]},
         **layer(2, scale=0.2, cloner=cl(mode="linear", countX=3, countY=3, spacingX=0.2, spacingY=0.3, mirrorX=True, mirrorY=True,
                                           stepScale=0.9, stepOpacity=0.9, varyMode="random", varySeed=7, varyColor=True,
                                           varyPalette=["#f80", "#11223380", "#abcdef", "nope"], varyColorSpread="cycle"))),
    case("cloner sequence colour at half strength", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.35, x=-0.3, cloner=cl(mode="linear", countX=4, spacingX=0.2, varyColor=True,
                                                    varyPalette=["#000000", "#ffffff", "#ff00ff"], varyColorStrength=0.5))),
    case("cloner stepScale 0 and stepOpacity 0 read as 1 (Python's `or`)", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, x=-0.3, cloner=cl(mode="linear", countX=3, spacingX=0.25, stepScale=0, stepOpacity=0))),
    case("cloner of one copy: no tint", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.5, cloner=cl(mode="linear", countX=1, countY=1, spacingX=0.3, varyColor=True, varyMode="random"))),
    case("cloner radial of one copy facing the centre", {"layer1": ["wide.png", "card"], "layer2": ["port.png", "provider"]},
         **layer(2, scale=0.4, cloner=cl(mode="radial", count=1, radius=0.2, startAngle=30, faceCenter=True))),
    case("cloner random with a negative stepScale drops the NaN copies", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, cloner=cl(mode="linear", countX=4, spacingX=0.15, stepScale=-0.8, varyMode="random", varySeed=3))),
    case("cloner switched off", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.5, cloner={"enabled": False, "mode": "linear", "countX": 5, "spacingX": 0.2})),
    case("cloner JSON that doesn't parse", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **{"layer2_cloner": "{not json", "layer2_scale": 0.5}),
    case("cloner with an emptied palette", {"layer1": ["wide.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, x=-0.2, cloner=cl(mode="linear", countX=3, spacingX=0.2, varyColor=True, varyPalette=[]))),
    case("cloner on a protected layer", {"layer1": ["big.png", "card"], "layer2": ["disc.png", "card"]},
         **layer(2, scale=0.3, protect=True, cloner=cl(mode="linear", countX=3, spacingX=0.25, stepOpacity=0.6))),
    # Mixed sizes and the loaders.
    case("four sizes and aspects", {"layer1": ["wide.png", "provider"], "layer2": ["port.png", "card"], "layer3": ["disc.png", "card"], "layer4": ["tiny.png", "provider"]},
         **layer(2, x=-0.25, scale=0.6, rot=-10.0), **layer(3, x=0.2, y=0.1, blend="overlay"), **layer(4, scale=0.5, y=-0.3, op=0.8)),
    case("a big canvas", {"layer1": ["big.png", "card"], "layer2": ["land.png", "provider"], "layer3": ["disc.png", "card"]},
         **layer(2, scale=0.5, rot=5.0, x=0.2), **layer(3, blend="soft_light")),
    case("a grey card", {"layer1": ["land.png", "card"], "layer2": ["gray.png", "card"]}, **layer(2, scale=0.8)),
    case("a grey card with alpha", {"layer1": ["land.png", "card"], "layer2": ["graya.png", "card"]}),
    case("a grey+alpha LoadImage (RGB only)", {"layer1": ["land.png", "card"], "layer2": ["graya.png", "load"]}),
    case("a palette card with a transparent index", {"layer1": ["land.png", "card"], "layer2": ["pal.png", "card"]}),
    case("a palette LoadImage and its mask", {"layer1": ["land.png", "card"], "layer2": ["pal.png", "load"], "layer2_mask": ["pal.png", "load_mask"]}),
    case("a JPEG from a provider", {"layer1": ["photo.jpg", "provider"], "layer2": ["disc.png", "card"]}, **layer(2, scale=0.6)),
    case("a JPEG card", {"layer1": ["land.png", "card"], "layer2": ["photo.jpg", "card"]}, **layer(2, rot=10.0)),
    case("an EXIF-turned JPEG card sets the size", {"layer1": ["sideways.jpg", "card"], "layer2": ["disc.png", "card"]}, **layer(2, scale=0.5)),
    case("an EXIF JPEG from a provider is not turned", {"layer1": ["sideways.jpg", "provider"], "layer2": ["disc.png", "card"]}, **layer(2, scale=0.5)),
    case("640×360: a 1600×900 RGBA picture downscaled 2.5×, turned, over a card",
         {"layer1": ["wide.png", "card"], "layer2": ["huge.png", "provider"], "layer3": ["huge.png", "card"]},
         width=640, height=360, **layer(2, rot=7.0, scale=0.9, blend="screen"), **layer(3, scale=0.3, x=0.3, y=-0.2, op=0.8)),
    # Real sizes (output width + height well above 128, where torch's bilinear resize is separable, x first;
    # a 4-channel picture movedim'd from ComfyUI's (B, H, W, C) keeps its channels-last sum at every size).
    # The mask and the RGB overlay are stretched to exactly the artboard: 80 + 48 = 128, 81 + 48 = 129.
    *[case(f"real size: either side of torch's kernel switch, {w}×48 (w + h = {w + 48})",
           {"layer1": ["land.png", "card"], "layer2": ["disc.png", "provider"], "layer2_mask": ["mask_small.png", "load_mask"],
            "overlay": ["wide.png", "load"], "overlay_mask": ["overlay.png", "load_mask"]},
           width=w, height=48, **layer(2, scale=0.8)) for w in (80, 81)],
    case("real size: small RGB and RGBA layers scaled up onto 640×360",
         {"layer1": ["wide.png", "card"], "layer2": ["land.png", "provider"], "layer3": ["port.png", "card"], "layer4": ["disc.png", "card"]},
         width=640, height=360, **layer(2, x=-0.2, scale=0.6, rot=8.0), **layer(3, x=0.25, scale=0.7, blend="multiply"),
         **layer(4, y=0.1, scale=0.5, blend="overlay")),
    case("real size: large RGB and RGBA layers scaled down onto 320×180",
         {"layer1": ["photo_big.png", "load"], "layer2": ["huge.png", "card"], "layer3": ["photo_big.png", "provider"], "layer4": ["photo_big.png", "card"]},
         width=320, height=180, **layer(2, scale=0.8, rot=-6.0), **layer(3, scale=0.4, x=0.3, y=0.2, blend="screen"),
         **layer(4, scale=0.3, x=-0.3, y=-0.25, op=0.7)),
    case("real size: large layers scaled down, the canvas from layer 1 (1200×800 → 1600×900 fit)",
         {"layer1": ["photo_big.png", "card"], "layer2": ["huge.png", "provider"]}, **layer(2, scale=0.5, x=0.1, blend="soft_light")),
    case("real size: masks stretched onto 512×384",
         {"layer1": ["photo_big.png", "load"], "layer1_mask": ["mask_rect.png", "load_mask"],
          "layer2": ["land.png", "provider"], "layer2_mask": ["mask_small.png", "load_mask"],
          "layer3": ["wide.png", "card"], "layer3_mask": ["land.png", "load_mask"]},
         width=512, height=384, **layer(1, op=0.9), **layer(2, rot=15.0, scale=0.9, protect=True), **layer(3, scale=0.5, x=0.2)),
    case("real size: an RGB overlay stretched onto 640×360", {"layer1": ["photo_big.png", "card"], "overlay": ["wide.png", "load"],
                                                             "overlay_mask": ["overlay.png", "load_mask"]}, width=640, height=360),
    case("real size: an RGBA overlay stretched onto 640×360, with a mask", {"layer1": ["photo_big.png", "provider"], "overlay": ["disc.png", "provider"],
                                                                           "overlay_mask": ["mask_small.png", "load_mask"]}, width=640, height=360),
    case("real size: clones on 640×360", {"layer1": ["photo_big.png", "card"], "layer2": ["disc.png", "card"], "layer3": ["port.png", "card"]},
         width=640, height=360,
         **layer(2, scale=0.25, x=-0.35, protect=True, cloner=cl(mode="linear", countX=4, countY=2, spacingX=0.2, spacingY=0.35,
                                                                  stepScale=0.9, stepRotation=10, varyColor=True,
                                                                  varyPalette=["#ff0044", "#22cc88"], varyColorStrength=0.4)),
         **layer(3, scale=0.3, x=0.25, cloner=cl(mode="radial", count=5, radius=0.2, faceCenter=True, stepOpacity=0.85))),
    case("an all-opaque RGBA card loads as RGB", {"layer1": ["wide.png", "card"], "layer2": ["opaque_rgba.png", "card"]}, **layer(2, rot=30.0)),
    case("one pixel at 254 makes the card RGBA", {"layer1": ["wide.png", "card"], "layer2": ["almost.png", "card"]}, **layer(2, rot=30.0)),
]


def run_case(c: dict) -> dict:
    kwargs = dict(c["inputs"])
    used = []
    for name, (asset, via) in c["links"].items():
        kwargs[name] = load(asset, via)
        used.append((asset, via))
    previews = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        out = nc.CompositorNode.execute(**kwargs)
    image, protect = out.result[0], out.result[1]
    assert previews and previews[0] is image, "save_live_preview must get the composite"
    _b, h, w, ch = image.shape
    assert ch == 3
    out = {
        "name": c["name"],
        "links": c["links"],
        "inputs": c["inputs"],
        "width": int(w),
        "height": int(h),
        "image8": u8_truncated(image[0]),
        "protect": u16(protect[0]),
        # The float32 composite and protect_mask, bit for bit (HWC, little-endian), for every case.
        "image_f32_sha256": f32_sha256(image[0]),
        "protect_f32_sha256": f32_sha256(protect[0]),
    }
    # The float composite of a large case is left out to keep the file small:
    # its 8-bit PNG pixels (the deliverable) are still compared exactly.
    if w * h <= LARGE:
        out["image"] = u16(image[0])
    return out


# Pictures and composites bigger than this many pixels are stored only as their 8-bit PNG pixels.
LARGE = 200_000


# ── ComfyUI's whole-prompt rule (execution.validate_prompt) ────────────────

VALIDATE_OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-validate-prompt.json")


def _first_option(class_type: str, name: str):
    it = nodes.NODE_CLASS_MAPPINGS[class_type].INPUT_TYPES()
    spec = it.get("required", {}).get(name) or it.get("optional", {}).get(name)
    opts = spec[0] if isinstance(spec[0], list) else spec[1].get("options")
    return opts[0]


def _frame(**over) -> dict:
    w = {}
    for i in range(1, 17):
        w.update({f"layer{i}_x": 0.0, f"layer{i}_y": 0.0, f"layer{i}_rotation": 0.0, f"layer{i}_scale": 1.0,
                  f"layer{i}_opacity": 1.0, f"layer{i}_blend": "normal", f"layer{i}_z": float(i),
                  f"layer{i}_protect": False, f"layer{i}_cloner": ""})
    w.update({"width": 0, "height": 0, "motion_params": ""})
    w.update(over)
    return {"class_type": "Compositor", "inputs": w}


def _card(image="land.png", **links) -> dict:
    return {"class_type": "Image", "inputs": {"image": image, "export": False, "filename_prefix": "ComfyUI", "format": "png",
                                              "quality": 90, "lossless_webp": False, "png_compression": 4, "scale": 1.0,
                                              "max_dimension": 0, "embed_metadata": True, "batch_index": -1, **links}}


def validate_cases() -> list:
    gen = {"class_type": "GenerateImageNode", "inputs": {"model": "flux-schnell", "prompt": "a fox", "aspect_ratio": "1:1", "seed": 0, "model_options": "{}"}}
    vid = {"class_type": "GenerateVideoNode", "inputs": {"model": "veo-3.1", "prompt": "it runs", "aspect_ratio": "16:9",
                                                         "duration": _first_option("GenerateVideoNode", "duration"), "seed": 0,
                                                         "model_options": "{}", "image": ["2", 0]}}
    gate = {"class_type": "ComfyGateNode", "inputs": {"data_in": ["1", 0], "bypass": False}}
    video = {"class_type": "Video", "inputs": {"file": "", "export": False, "filename_prefix": "video/ComfyUI", "source": ["3", 0]}}
    no_rot = _frame(layer1=["1", 0])
    del no_rot["inputs"]["layer9_rotation"]
    return [
        ("the blank project: an empty Frame, a Frame on it, an Image card (history c7690393)",
         {"1": _card(), "3": _frame(), "5": _frame(layer1=["3", 0])}),
        ("image → Gate → video, and a stray empty Frame",
         {"1": gen, "2": gate, "3": vid, "4": video, "9": _frame()}),
        ("only an empty Frame", {"3": _frame()}),
        ("an empty Frame and a Frame on it", {"3": _frame(), "5": _frame(layer1=["3", 0])}),
        ("a Frame with a scale over its max, a good Frame, an Image card",
         {"1": _card(), "3": _frame(layer1=["1", 0], layer1_scale=5.0), "4": _frame(layer1=["1", 0])}),
        ("a Frame with a blend not in the list, read by an Image card",
         {"1": _card(), "3": _frame(layer1=["1", 0], layer2_blend="lighter"), "6": _card("", images=["3", 0])}),
        ("a Frame missing a required widget", {"1": _card(), "3": no_rot}),
        ("everything valid: Image → Frame → Image",
         {"1": _card(), "3": _frame(layer1=["1", 0]), "6": _card("", images=["3", 0])}),
    ]


def run_validate_cases() -> list:
    import execution
    # The whole node registry, as the server builds it (no custom nodes; the network is blocked).
    asyncio.run(nodes.init_extra_nodes(init_custom_nodes=False, init_api_nodes=True))
    out = []
    for name, prompt in validate_cases():
        ok, err, good, node_errors = asyncio.run(execution.validate_prompt("fixture", json.loads(json.dumps(prompt)), None))
        out.append({
            "name": name,
            "prompt": prompt,
            "ok": bool(ok),
            "error": None if ok else err["type"],
            "goodOutputs": sorted(good),
            "nodeErrors": {k: {"types": [e["type"] for e in v["errors"]], "dependent_outputs": sorted(v["dependent_outputs"]),
                               "class_type": v["class_type"]} for k, v in node_errors.items()},
        })
    return out


def main() -> None:
    # torch's own thread count, as ComfyUI runs the node (it never sets one). Not 1: on one
    # thread, torch's bilinear resize of a 3-channel picture in channels-last memory (every
    # RGB layer, `image.permute(0, 3, 1, 2)`) keeps its small-size sum at every size, where
    # on two or more threads (any thread count, measured 2–8) it is separable above output
    # width + height 128, as the runner's port is.
    assert torch.get_num_threads() > 1, "Run on a machine with more than one CPU thread: ComfyUI's Frame does"
    decoded = {}
    for c in CASES:
        for asset, via in c["links"].values():
            key = f"{asset}|{via}"
            if key in decoded:
                continue
            t = load(asset, via)
            if via != "load_mask" and t.shape[1] * t.shape[2] > LARGE:
                continue  # a large picture's decode is checked end to end instead
            t = t[0] if t.dim() >= 3 and via != "load_mask" else t
            if via == "load_mask":
                t = t[0]
                decoded[key] = {"height": int(t.shape[0]), "width": int(t.shape[1]), "channels": 1, "data": u16(t)}
            else:
                decoded[key] = {"height": int(t.shape[0]), "width": int(t.shape[1]), "channels": int(t.shape[2]), "data": u16(t)}
    cases = [run_case(c) for c in CASES]
    doc = {
        "note": "Written by scripts/compositor_fixtures.py from the real CompositorNode.execute. Do not edit.",
        "assets": {k: base64.b64encode(v).decode("ascii") for k, v in ASSETS.items()},
        "decoded": decoded,
        "cases": cases,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(cases)} compositor cases, {len(decoded)} decoded pictures → {os.path.relpath(OUT, ROOT)}")
    vcases = run_validate_cases()
    with open(VALIDATE_OUT, "w") as f:
        json.dump({"note": "Written by scripts/compositor_fixtures.py from the real execution.validate_prompt. Do not edit.",
                   "cases": vcases}, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(vcases)} validate_prompt cases → {os.path.relpath(VALIDATE_OUT, ROOT)}")


if __name__ == "__main__":
    main()
