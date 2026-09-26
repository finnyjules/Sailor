"""Writes frontend/tests/unit/fixtures/runner-values.json: what the REAL Python
loaders make of small synthetic picture files, for the Sailor runner's
TypeScript helpers (frontend/server/runner/pictures/) to be measured against
(tests/unit/runner-pictures.unit.spec.ts).

  load_mask   — the real nodes.LoadImage().load_image(name)'s MASK (first
                frame), as round(m·65535) little-endian uint16, with its size
  rgb_turned  — ImageOps.exif_transpose(Image.open(p)).convert("RGB") of the
                first frame, as the tensor a Python loader holds, sent through
                the real _image_tensor_to_data_url (nodes_replicate.py) and
                stored as its 8-bit RGB pixels; and whether the file already
                was that picture (an RGB 8-bit single-frame PNG with no EXIF
                orientation, ICC profile or colour key), so the runner may
                hand it on untouched
  refused     — a 16-bit greyscale PNG, a CMYK JPEG, a GIF with a
                transparent colour, a BMP (sharp can't read it) and 32-bit
                integer and float TIFFs (LoadImage divides those by 255), with
                what PIL's .convert("RGB") gives (for the report; the runner
                refuses them all)
  bilinear    — (R1.4) torch.nn.functional.interpolate(t, size=(dh, dw),
                mode='bilinear', align_corners=False) on seeded random float32
                (1, C, H, W) tensors, 1 and 4 channels; input and output stored
                as float32 little-endian, channels last (H, W, C)

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_values_fixtures.py

The network is blocked (as in compositor_fixtures.py): every outbound connect
and DNS lookup raises and the provider keys are removed before any node module
is imported. Nothing here needs the network.
"""
import base64
import io
import json
import os
import socket
import sys
import tempfile

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
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-values.json")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image as PILImage, ImageOps  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402

WORK = tempfile.mkdtemp(prefix="runner-values-fixtures-")
for sub in ("input", "temp", "output"):
    os.makedirs(os.path.join(WORK, sub), exist_ok=True)
folder_paths.set_input_directory(os.path.join(WORK, "input"))
folder_paths.set_temp_directory(os.path.join(WORK, "temp"))
folder_paths.set_output_directory(os.path.join(WORK, "output"))

import nodes  # noqa: E402
from comfy_api_nodes.nodes_replicate import _image_tensor_to_data_url  # noqa: E402


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


def _gradient_alpha(h: int, w: int) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    return np.clip(np.floor((x / max(1, w - 1) * 0.8 + y / max(1, h - 1) * 0.2) * 255 + 0.5), 0, 255).astype(np.uint8)


def _save(im: PILImage.Image, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    return buf.getvalue()


def _palette_png() -> bytes:
    pal = PILImage.fromarray(_pattern(20, 22, 11), "RGB").quantize(colors=16, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE)
    return _save(pal, "PNG", transparency=3)


def _jpeg(orientation: int) -> bytes:
    im = PILImage.fromarray(_pattern(24, 36, 13), "RGB")
    exif = im.getexif()
    exif[0x0112] = orientation
    return _save(im, "JPEG", quality=90, exif=exif.tobytes())


def _two_frame_gif() -> bytes:
    a = PILImage.fromarray(_pattern(18, 26, 14), "RGB").quantize(colors=32, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE)
    b = PILImage.fromarray(_pattern(18, 26, 15), "RGB").quantize(colors=32, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE)
    return _save(a, "GIF", save_all=True, append_images=[b], duration=100, loop=0)


def _rgba_png() -> bytes:
    return _save(PILImage.fromarray(np.dstack([_pattern(20, 30, 1), _gradient_alpha(20, 30)]), "RGBA"), "PNG")


def _rgb_png() -> bytes:
    return _save(PILImage.fromarray(_pattern(22, 34, 2), "RGB"), "PNG")


def _la_png() -> bytes:
    g = _pattern(16, 24, 3)[..., 0]
    return _save(PILImage.fromarray(np.dstack([g, _gradient_alpha(16, 24)]), "LA"), "PNG")


def _grey_png() -> bytes:
    return _save(PILImage.fromarray(_pattern(16, 20, 4)[..., 1], "L"), "PNG")


def _grey16_png() -> bytes:
    y, x = np.mgrid[0:12, 0:16].astype(np.float64)
    v = np.floor((x / 15 * 0.7 + y / 11 * 0.3) * 65535 + 0.5).astype(np.uint16)
    return _save(PILImage.fromarray(v), "PNG")  # uint16 → mode I;16


def _transparent_gif() -> bytes:
    a = PILImage.fromarray(_pattern(18, 26, 16), "RGB").quantize(colors=32, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE)
    return _save(a, "GIF", transparency=3)


def _rgb_trns_png() -> bytes:
    """An RGB PNG with a tRNS colour key: PIL keeps it mode RGB (no alpha band)."""
    arr = _pattern(24, 36, 17)
    arr[:4, :6] = [10, 20, 30]
    return _save(PILImage.fromarray(arr, "RGB"), "PNG", transparency=(10, 20, 30))


def _grey_trns_png() -> bytes:
    """A greyscale PNG with a tRNS colour key: PIL keeps it mode L."""
    arr = _pattern(18, 22, 18)[..., 0].copy()
    arr[:3, :5] = 7
    return _save(PILImage.fromarray(arr, "L"), "PNG", transparency=7)


def _icc_png() -> bytes:
    """An RGB PNG carrying an ICC profile (Python's data URL carries none)."""
    from PIL import ImageCms
    icc = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    icc[24:36] = bytes([0x07, 0xEA, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0])  # a fixed creation date (2026-01-01), so the fixture is stable
    icc = bytes(icc)
    return _save(PILImage.fromarray(_pattern(20, 28, 19), "RGB"), "PNG", icc_profile=icc)


def _apng() -> bytes:
    """A two-frame animated PNG (acTL): Python sends only its first frame."""
    a = PILImage.fromarray(_pattern(16, 24, 20), "RGB")
    b = PILImage.fromarray(_pattern(16, 24, 21), "RGB")
    return _save(a, "PNG", save_all=True, append_images=[b], duration=100, loop=0)


def _bmp() -> bytes:
    return _save(PILImage.fromarray(_pattern(10, 14, 22), "RGB"), "BMP")


def _tiff_i() -> bytes:
    """A 32-bit integer TIFF (PIL mode I): LoadImage divides it by 255 first."""
    y, x = np.mgrid[0:10, 0:14]
    return _save(PILImage.fromarray((x * 3000 + y * 40).astype(np.int32)), "TIFF")


def _tiff_f() -> bytes:
    """A 32-bit float TIFF (PIL mode F)."""
    y, x = np.mgrid[0:10, 0:14].astype(np.float32)
    return _save(PILImage.fromarray(x * 17.5 + y * 0.25), "TIFF")


def _cmyk_jpeg() -> bytes:
    rgb = _pattern(12, 16, 5).astype(np.float64) / 255
    k = 1 - rgb.max(axis=-1)
    denom = np.where(k < 1, 1 - k, 1)
    c = (1 - rgb[..., 0] - k) / denom
    m = (1 - rgb[..., 1] - k) / denom
    yy = (1 - rgb[..., 2] - k) / denom
    cmyk = np.floor(np.stack([c, m, yy, k], axis=-1) * 255 + 0.5).astype(np.uint8)
    return _save(PILImage.fromarray(cmyk, "CMYK"), "JPEG", quality=95)


# ── Encoding ─────────────────────────────────────────────────────────────────

def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def mask16(m: torch.Tensor) -> str:
    """A MASK (first frame) → round(m·65535) as little-endian uint16."""
    a = m[0].detach().float().cpu().numpy() if m.dim() == 3 else m.detach().float().cpu().numpy()
    return b64(np.clip(np.round(a.astype(np.float64) * 65535), 0, 65535).astype("<u2").tobytes())


def python_view(data: bytes) -> torch.Tensor:
    """The tensor a Python loader holds: EXIF turned, first frame, RGB."""
    im = PILImage.open(io.BytesIO(data))
    im.seek(0)
    im = ImageOps.exif_transpose(im).convert("RGB")
    return torch.from_numpy(np.array(im).astype(np.float32) / 255.0)[None,]


def data_url_rgb8(t: torch.Tensor) -> tuple[int, int, bytes]:
    """The 8-bit RGB pixels of the PNG _image_tensor_to_data_url sends."""
    url = _image_tensor_to_data_url(t)
    png = base64.b64decode(url.split(",", 1)[1])
    im = PILImage.open(io.BytesIO(png))
    assert im.mode == "RGB", im.mode
    return im.size[0], im.size[1], np.array(im).tobytes()


def already_that_picture(data: bytes) -> bool:
    im = PILImage.open(io.BytesIO(data))
    frames = getattr(im, "n_frames", 1)
    orientation = im.getexif().get(0x0112, 1)
    return im.format == "PNG" and im.mode == "RGB" and frames == 1 and orientation == 1 \
        and "icc_profile" not in im.info and "transparency" not in im.info


# ── Cases ────────────────────────────────────────────────────────────────────

def load_mask_cases() -> list[dict]:
    files = {
        "an RGBA PNG with a gradient alpha": ("rgba.png", _rgba_png()),
        "an RGB PNG (no alpha)": ("rgb.png", _rgb_png()),
        "an LA PNG": ("la.png", _la_png()),
        "a palette PNG with a transparent index": ("pal.png", _palette_png()),
        "an RGB PNG with a tRNS colour key": ("rgb_trns.png", _rgb_trns_png()),
        "a greyscale PNG with a tRNS colour key": ("l_trns.png", _grey_trns_png()),
    }
    out = []
    for label, (name, data) in files.items():
        with open(os.path.join(WORK, "input", name), "wb") as f:
            f.write(data)
        mask = nodes.LoadImage().load_image(name)[1]
        h, w = mask.shape[-2], mask.shape[-1]
        out.append({"name": label, "file": b64(data), "w": int(w), "h": int(h), "mask16": mask16(mask)})
    return out


def rgb_turned_cases() -> list[dict]:
    files = {
        "an RGB PNG": _rgb_png(),
        "an RGBA PNG": _rgba_png(),
        "a JPEG with EXIF orientation 6": _jpeg(6),
        "a JPEG with EXIF orientation 1": _jpeg(1),
        "a greyscale PNG": _grey_png(),
        "a palette PNG": _palette_png(),
        "a two-frame GIF": _two_frame_gif(),
        "an RGB PNG with an ICC profile": _icc_png(),
        "a two-frame animated PNG": _apng(),
        "an RGB PNG with a tRNS colour key": _rgb_trns_png(),
    }
    out = []
    for label, data in files.items():
        w, h, rgb8 = data_url_rgb8(python_view(data))
        out.append({"name": label, "file": b64(data), "w": w, "h": h, "rgb8": b64(rgb8), "unchanged": already_that_picture(data)})
    return out


def refused_cases() -> list[dict]:
    out = []
    for label, data in {"a 16-bit greyscale PNG": _grey16_png(), "a CMYK JPEG": _cmyk_jpeg(), "a GIF with a transparent colour": _transparent_gif(),
                        "a BMP": _bmp(), "a 32-bit integer TIFF": _tiff_i(), "a 32-bit float TIFF": _tiff_f()}.items():
        im = PILImage.open(io.BytesIO(data))
        mode = im.mode
        rgb = im.convert("RGB")
        out.append({"name": label, "file": b64(data), "mode": mode, "w": rgb.size[0], "h": rgb.size[1], "pil_rgb8": b64(np.array(rgb).tobytes())})
    return out


def bilinear_cases() -> list[dict]:
    """(sw, sh) → (dw, dh), each with 1 and 4 channels, from a fixed seed."""
    sizes = [((1, 1), (5, 3)), ((7, 5), (3, 2)), ((16, 16), (37, 23)), ((100, 1), (3, 40))]
    gen = torch.Generator().manual_seed(20260926)
    out = []
    for (sw, sh), (dw, dh) in sizes:
        for c in (1, 4):
            t = torch.rand((1, c, sh, sw), generator=gen, dtype=torch.float32)
            r = torch.nn.functional.interpolate(t, size=(dh, dw), mode="bilinear", align_corners=False)
            hwc = lambda x: b64(x[0].permute(1, 2, 0).contiguous().numpy().astype("<f4").tobytes())  # noqa: E731
            out.append({"name": f"{sw}x{sh} to {dw}x{dh}, {c} channel{'s' if c > 1 else ''}",
                        "sw": sw, "sh": sh, "dw": dw, "dh": dh, "channels": c, "src": hwc(t), "out": hwc(r)})
    return out


def main() -> None:
    doc = {
        "bilinear": bilinear_cases(),
        "load_mask": load_mask_cases(),
        "rgb_turned": rgb_turned_cases(),
        "refused": refused_cases(),
        "note": "Written by scripts/runner_values_fixtures.py from the real LoadImage and _image_tensor_to_data_url. Do not edit.",
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {OUT}: {len(doc['bilinear'])} bilinear, {len(doc['load_mask'])} load_mask, {len(doc['rgb_turned'])} rgb_turned, {len(doc['refused'])} refused")


if __name__ == "__main__":
    main()
