"""Writes frontend/tests/unit/fixtures/runner-effects-<group>.json: what the
REAL still-picture effect nodes (step 3, stage R2) make, for the Sailor
runner's TypeScript ports (frontend/server/runner/effects/) to be measured
against. One file per group; writing one group leaves the others untouched.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_effects_fixtures.py --group machinery

Groups:
  machinery — (R2.1) `synth` itself (10 pictures and the sha256 of their
              bytes, the TypeScript copy must agree); the three pilots
              (AdjustExposure, AdjustInvert, AdjustThreshold) over the
              standard case set; save_live_preview of a 4-channel tensor
              (the preview keeps RGBA).
  kernels   — (R2.2) the kernels the effects share, each on its own against
              torch / torchvision: linspace, arange, remainder, pow, the
              transcendental functions, the area / nearest / bilinear /
              bicubic resizes, grid_sample, affine_grid, the pools, reflect
              padding, conv2d, the gaussian kernel and blur, torchvision's
              colour operations, torch.mean and topk. Inputs are rebuilt from
              `hashed_values` (no stored floats); an exact kernel's output is
              stored as float32 (or its sha256 when large), a library one's
              always (zlib), with its band list at each ε candidate.
  rng       — (R2.3) torch's CPU random numbers on their own: raw mt19937
              draws (random_ over the full int64 range: one random64 each),
              rand, randn (the scalar path below 16 values, normal_fill from
              16), randperm, and calls in a row on one generator (Glitch's
              rand(1) × 50, Voronoi's sites then colours, the double-normal
              cache carried across calls). Each output records its sha256 and
              its first 64 values; randn's are also stored whole, so the spec
              can count draws off by an ulp. It records this Mac's libm
              (logf, __sincosf_stret) too, so the rng fixtures regenerate
              only on macOS.
  tone      — (R2.4) the other 26 tone, colour and light effects over the
              standard case set, plus: every numeric widget "between" at
              once; contrast's mean on one 320×200 picture and on a batch of
              two (torch splits the long sum differently); the colour text
              (parse_stops, parse_duotone, both hex readers) on their own
              and through their nodes; Dither's −0 on black pictures; one
              exact effect into a Frame. An exact class's outputs are
              sha256s; a library class (TONE_LIBRARY_EPS) also keeps its
              small floats (zlib) and its hashed bands at its own ε.
  blur      — (R2.5) the 13 blur and convolution effects over the standard
              case set, plus: radii at the downsampling thresholds; the
              largest radii on pictures too small for their padding (and an
              area resize down to nothing); Blur's motion at four angles and
              five lengths, and its zoom; FrequencySeparation's three
              previews; Sparkle with more peaks than it keeps, tied lumas
              included; `_motion_kernel` on its own; one effect into a Frame.
              Every class is library (BLUR_LIBRARY_EPS): each output keeps
              its sha256s, a small one its float32 (zlib), a hashed one its
              band at the class's ε; the preview tensor is kept the same way
              when it isn't the first output. Where Sparkle's topk had values
              tied at its cut, the case also records what the node makes with
              the lower index kept first among them (the runner's topk).
  cells     — (R2.6) Pixelate, Halftone, Kuwahara and Ascii over the standard
              case set, plus: Pixelate at 1, 2, 3 and 64 (an area resize to
              1 × 1: a mean) and a batch of two; Halftone at odd and even
              cells and four angles; Kuwahara at every radius 1–12 (an odd
              radius makes the picture one pixel larger); Ascii over every
              preset, custom text (short: the default ramp; long; one with a
              character outside the atlas), every colour mode × background ×
              invert × blend × mix, the rolls, gamma and phase, pictures not
              a whole number of cells; ten seeded random settings per class;
              one effect into a Frame. Every class is exact: each output keeps
              its sha256s and a small one its float32 (zlib, in `floats`).
              ALSO WRITES the Ascii glyph atlas,
              frontend/server/runner/effects/asciiGlyphs.bin (every cell 4–64 ×
              character, rendered by the node's own _ascii_bitmaps), and its
              character list, frontend/shared/runner/asciiGlyphSet.generated.ts.
              The whole group runs with the node's _FONT_PATHS pointed at
              DejaVu Sans Mono from matplotlib in this .venv (controller
              ruling (d): Menlo can't be shipped), for the atlas and every
              Ascii case alike.
  warp      — (R2.7) the 15 geometry and coordinate warps over the standard
              case set, plus: Resize at 0.1, 0.33, 0.5, 1, 1.5 and 4 (and
              scales whose side·scale isn't whole) in each mode, a 1-pixel
              result and the blank resized to nothing (Python raises); Rotate
              at ±180, ±90, 45 and 1; Crop at 0.49 on each side; Mirror in
              every mode at seams 0, 0.5 and 1 on odd and even pictures (and
              one row, one column); GodRays from each corner at 4 and 80
              samples; Kaleidoscope at 2 and 20 segments; CRT's steps alone
              and together; ten seeded random settings per class; one
              Resize into a Frame. `kernels`: the resizes' scale_factor path
              (R2.7 ruling (a)) against kernels.ts `scales`. `negzero`: −0
              through each node's last clamp. An exact class keeps its
              sha256s; CRT (library, WARP_LIBRARY_EPS) a small output's float
              (byte-shuffled, zlib, in `floats`) and a hashed one's band; the
              "warp" parity class (WARP_BAND_CLASSES) a small output's float
              and a hashed one's 8-bit bytes and float windows. `--sweep` runs
              the broad sweep, small pictures and up to 8192² (writes nothing).
  noise     — (R2.9) the generators (Perlin noise, Voronoi, Gradient,
              Reaction-diffusion, Fractal: every widget at its min, max and a
              value between on 64², the defaults at 64², at their own size and
              at their largest (hashed), seeds 0, 1 and 2³¹ − 1) and the seeded
              looks and Add noise over the standard case set, plus: Glitch's
              slices past the picture's height; PaletteQuantize batches, colours
              2 / 32, iterations 1 / 20; Stipple batches, invert and its colour
              text; Reaction-diffusion 64² at 50 and 600 iterations; Fractal in
              both types at zoom 1 / 10 000 and max_iter 16 / 512; Add noise under
              torch.manual_seed(7) and (8) (`global_seed`) and its statistics on
              a fixed mid-grey ramp; FilmGrain around size 1; one effect into a
              Frame. `winograd`: F.conv2d's depthwise 3 × 3 on its own (torch's
              Winograd3x3Depthwise path on this Mac), which Reaction-diffusion's
              laplacian takes. Exact classes keep their sha256s; the library
              classes (NOISE_LIBRARY_EPS) a small float or a hashed band;
              FlowField (the "warp" class) as the warp group keeps it. `--sweep`
              measures the library ε and FlowField up to 8192² (writes nothing).

Every picture reaches a node as it does in a real run, through the real
Python loader of its source (as scripts/compositor_fixtures.py):
  rgb      — a picture the runner made and keeps as an 8-bit RGB PNG (a
             Frame's result): the PNG's RGB bytes / 255 in float32;
  provider — a provider node's download (bytesio_to_image_tensor: RGBA);
  card     — an Image card loading its file (Image.process: RGB, or RGBA
             with any transparency; its alpha through 1 − mask);
  blank    — an Image card with nothing loaded: Python's 1×1 black;
  mask     — a mask the runner keeps: a 16-bit greyscale PNG as u / 65535.

THE STANDARD CASE SET, per class: every widget at its default, each numeric
widget at its min, its max and one value between (the others at their
defaults), every COMBO option and both BOOLEAN values, each over four
pictures (rgb 37×23, provider 29×31, card 23×19 with partial alpha, card
23×19 opaque); a batch of two different files and a repeat; the 1×1 blank;
one rgb 320×200 (hashed); and every case where Python raises.

Each node's `execute` is called with `cls.hidden.unique_id` set; the preview
file it writes into temp is read back. Small outputs are recorded as float32
(little-endian, H × W × C, base64) with Python's own 8-bit forms: `round8`,
the hand-off's (tensor.clamp(0, 1) · 255).round() (_image_tensor_to_data_url),
and `trunc8`, np.clip(255·x, 0, 255).astype(uint8) (save_live_preview and
save_images). A hashed case records the sha256 of each, and its band per mode:
the values whose float lies within ε = 2⁻⁸ (in 255-scale) of that mode's
quantisation boundary (an integer for trunc, a half for round), with Python's
bytes there. `chains` (fix round 1): effects in a row, and an effect into a
Frame, each fed the float tensor the one before made, as ComfyUI runs them.

Torch runs at its default thread count, as ComfyUI does (the script refuses
one thread, as compositor_fixtures.py does), and the file records the torch
version, the thread count and the platform. Running a group again gives
identical bytes. The network is blocked before any node module is imported.
"""
import argparse
import atexit
import base64
import hashlib
import io
import json
import math
import os
import platform
import shutil
import socket
import sys
import tempfile
import zlib

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
FIXTURES = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402

WORK = tempfile.mkdtemp(prefix="runner-effects-fixtures-")
# The temp directory goes with the script, however it ends (R2.7 review: one was left behind).
atexit.register(shutil.rmtree, WORK, True)
for _sub in ("input", "temp", "output"):
    os.makedirs(os.path.join(WORK, _sub), exist_ok=True)
folder_paths.set_input_directory(os.path.join(WORK, "input"))
folder_paths.set_temp_directory(os.path.join(WORK, "temp"))
folder_paths.set_output_directory(os.path.join(WORK, "output"))

# The band's ε in 255-scale (R2 rule 10: at most 2⁻⁸).
BAND_EPS = 2.0 ** -8


def check_threads() -> None:
    # torch's own thread count, as ComfyUI runs the nodes (it never sets one). Not 1: some
    # torch kernels change their arithmetic on one thread (FR1: bilinear resize).
    assert torch.get_num_threads() > 1, "Run on a machine with more than one CPU thread: ComfyUI's nodes do"


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ── synth: the same pictures in Python and TypeScript ────────────────────────

def synth(w: int, h: int, channels: int, seed: int) -> bytes:
    """Interleaved 8-bit pixels: gradients, texture, and (4 channels) alpha fully
    see-through, fully opaque and partial. tests/unit/__runner__/effectsParity.ts
    has the same function."""
    s = (seed & 0xFFFFFFFF) or 0x9E3779B9

    def nxt() -> int:
        nonlocal s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        return s

    out = bytearray()
    for y in range(h):
        for x in range(w):
            for k in range(channels):
                if k < 3:
                    out.append(((x * 37 + y * 11 + k * 71) & 255) ^ (nxt() & 31))
                else:
                    r = nxt()
                    out.append(0 if (x + y) % 5 == 0 else 255 if (x * y) % 3 == 0 else r & 255)
    return bytes(out)


SYNTH_PICTURES = [
    (37, 23, 3, 1), (29, 31, 4, 2), (23, 19, 4, 3), (23, 19, 3, 4), (37, 23, 3, 5),
    (320, 200, 3, 6), (1, 1, 3, 7), (5, 4, 4, 8), (64, 1, 4, 0), (3, 7, 3, 0xFFFFFFFF),
]


def synth_png(w: int, h: int, channels: int, seed: int) -> bytes:
    px = np.frombuffer(synth(w, h, channels, seed), dtype=np.uint8).reshape(h, w, channels)
    buf = io.BytesIO()
    PILImage.fromarray(px, "RGBA" if channels == 4 else "RGB").save(buf, format="PNG")
    return buf.getvalue()


def synth_name(w: int, h: int, channels: int, seed: int) -> str:
    return f"synth_{w}x{h}x{channels}_{seed}.png"


# ── The source loaders ───────────────────────────────────────────────────────

def load(source: str, name: str | None, data: bytes | None) -> torch.Tensor:
    """The IMAGE (or MASK) tensor a source of kind `source` hands on for this file."""
    if source == "blank":
        return torch.zeros((1, 1, 1, 3), dtype=torch.float32)
    assert name is not None and data is not None
    if source == "rgb":
        with PILImage.open(io.BytesIO(data)) as im:
            arr = np.array(im.convert("RGB")).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None]
    if source == "provider":
        from comfy_api_nodes.util.conversions import bytesio_to_image_tensor
        return bytesio_to_image_tensor(io.BytesIO(data))
    if source == "card":
        from comfy_extras.nodes_image import Image as ImageCard
        with open(os.path.join(WORK, "input", name), "wb") as f:
            f.write(data)
        return ImageCard().process(
            image=name, export=False, filename_prefix="fixture", format="png", quality=90,
            lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=False,
            batch_index=-1, images=None, prompt=None, extra_pnginfo=None, unique_id="fixture",
        )["result"][0]
    if source == "mask":
        with PILImage.open(io.BytesIO(data)) as im:
            arr = np.array(im).astype(np.float32) / 65535.0
        return torch.from_numpy(arr)[None]
    raise ValueError(source)


def run_node(cls, node_id: str, **inputs):
    """The real node's execute, with its hidden unique_id set; its outputs and ui."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    with mock.patch.object(cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
        res = cls.execute(**inputs)
    return res.args, res.ui


# ── What a case records ──────────────────────────────────────────────────────

def round8(t: torch.Tensor) -> np.ndarray:
    """_image_tensor_to_data_url's bytes: (x.clamp(0, 1) · 255).round() as uint8."""
    return (t.clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()


def trunc8(t: torch.Tensor) -> np.ndarray:
    """save_live_preview / save_images: np.clip(255·x, 0, 255).astype(uint8)."""
    return np.clip(255.0 * t.cpu().numpy(), 0, 255).astype(np.uint8)


def band_list(t: torch.Tensor, eps: float = BAND_EPS) -> dict:
    """Per mode, the values whose float lies within eps (255-scale) of that mode's
    quantisation boundary, with Python's bytes there ([[index, py8], …]): `trunc` —
    an integer (trunc(f32(255·x))); `round` — a half (round(255·x)). Packed per mode:
    `in` one byte per value of the interleaved H × W × C bytes (1 in the band) and `py8`
    Python's bytes at the band's values in order, each zlib-compressed (level 9), base64."""
    v = (t.cpu().numpy().astype(np.float64) * 255.0).reshape(-1)
    z = lambda b: b64(zlib.compress(b, 9))  # noqa: E731
    out = {}
    for mode, edge, py in (("trunc", np.round(v), trunc8(t).reshape(-1)), ("round", np.floor(v) + 0.5, round8(t).reshape(-1))):
        inside = np.abs(v - edge) < eps
        out[mode] = {"count": int(inside.sum()), "in": z(inside.astype(np.uint8).tobytes()), "py8": z(py[inside].tobytes())}
    return out


def record_output(t: torch.Tensor, hashed: bool) -> dict:
    """One output tensor, frame by frame (H × W × C)."""
    items = []
    is_mask = t.dim() == 3
    for i in range(t.shape[0]):
        x = t[i].contiguous()
        f32 = x.cpu().numpy().astype("<f4").tobytes()
        if is_mask:
            item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": 1}
        else:
            item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": int(x.shape[2])}
        if hashed:
            item.update({"f32_sha256": sha(f32), "round8_sha256": sha(round8(x).tobytes()),
                         "trunc8_sha256": sha(trunc8(x).tobytes()), "band": band_list(x)})
        else:
            item.update({"f32": b64(f32), "round8": b64(round8(x).tobytes()), "trunc8": b64(trunc8(x).tobytes())})
        items.append(item)
    return {"kind": "mask" if is_mask else "image", "items": items}


def read_preview(ui: dict, hashed: bool) -> dict:
    im = ui["images"][0]
    with PILImage.open(os.path.join(folder_paths.get_temp_directory(), im["subfolder"], im["filename"])) as p:
        px = np.array(p).tobytes()
        row = {"filename": im["filename"], "mode": p.mode, "w": p.size[0], "h": p.size[1]}
    row.update({"px_sha256": sha(px)} if hashed else {"px": b64(px)})
    return row


class Group:
    """One fixture file: its assets (picture files by name) and cases."""

    def __init__(self) -> None:
        self.assets: dict[str, bytes] = {}
        self.cases: list[dict] = []
        self.seq = 0

    def picture(self, w: int, h: int, channels: int, seed: int) -> str:
        name = synth_name(w, h, channels, seed)
        self.assets.setdefault(name, synth_png(w, h, channels, seed))
        return name

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        """inputs: input name → (source, [file names]) (blank: no files)."""
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            if source == "blank":
                tensors[key] = load("blank", None, None)
            else:
                tensors[key] = torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        row["outputs"] = [record_output(t, hashed) for t in outs]
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, hashed)
        self.cases.append(row)


# ── The standard case set ────────────────────────────────────────────────────

def widget_settings(cls) -> tuple[dict, list[tuple[str, dict]]]:
    """The class's widget defaults, and the standard settings: defaults, each
    numeric widget at min / max / a value between, every COMBO option, each BOOLEAN."""
    types = cls.INPUT_TYPES()
    defaults: dict = {}
    specs: dict = {}
    for section in ("required", "optional"):
        for name, spec in (types.get(section) or {}).items():
            kind, info = spec[0], (spec[1] if len(spec) > 1 else {})
            if kind in ("IMAGE", "MASK"):
                continue
            specs[name] = (kind, info)
            if "default" in info:
                defaults[name] = info["default"]
    settings: list[tuple[str, dict]] = [("defaults", {})]
    for name, (kind, info) in specs.items():
        if kind in ("FLOAT", "INT") and "min" in info and "max" in info:
            lo, hi = info["min"], info["max"]
            mid = lo + (hi - lo) * 0.37
            mid = int(round(mid)) if kind == "INT" else round(mid, 2)
            for label, v in (("min", lo), ("max", hi), ("between", mid)):
                settings.append((f"{name} {label} ({v})", {name: v}))
        elif kind == "COMBO":
            for o in info.get("options", []):
                if o != defaults.get(name):
                    settings.append((f"{name} {o}", {name: o}))
        elif kind == "BOOLEAN":
            settings.append((f"{name} {not defaults.get(name, False)}", {name: not defaults.get(name, False)}))
    return defaults, settings


def standard_cases(g: Group, cls, class_type: str) -> None:
    defaults, settings = widget_settings(cls)
    pictures = [
        ("rgb 37×23", "rgb", g.picture(37, 23, 3, 1)),
        ("provider 29×31", "provider", g.picture(29, 31, 4, 2)),
        ("card 23×19 see-through", "card", g.picture(23, 19, 4, 3)),
        ("card 23×19 opaque", "card", g.picture(23, 19, 3, 4)),
    ]
    image = [n for n, s in cls.INPUT_TYPES()["required"].items() if s[0] == "IMAGE"][0]
    for label, over in settings:
        for pname, source, file in pictures:
            g.case(f"{class_type}: {label}, {pname}", cls, class_type, {**defaults, **over}, {image: (source, [file])})
    a, b = g.picture(37, 23, 3, 1), g.picture(37, 23, 3, 5)
    g.case(f"{class_type}: a batch of two files and a repeat", cls, class_type, dict(defaults), {image: ("rgb", [a, b, a])})
    g.case(f"{class_type}: the 1×1 blank", cls, class_type, dict(defaults), {image: ("blank", [])})
    g.case(f"{class_type}: rgb 320×200", cls, class_type, dict(defaults), {image: ("rgb", [g.picture(320, 200, 3, 6)])}, hashed=True)


# ── Groups ───────────────────────────────────────────────────────────────────

def chain_case(g: Group, name: str, steps: list, source: str, file: str, hashed: bool) -> dict:
    """Effects in a row, each fed the float tensor the one before made (as ComfyUI runs
    them): every step's outputs and preview are recorded."""
    x = load(source, file, g.assets[file])
    row: dict = {"name": name, "inputs": {"image": {"source": source, "files": [file]}}, "steps": []}
    for cls, class_type, widgets in steps:
        g.seq += 1
        node_id = f"fx{g.seq}"
        outs, ui = run_node(cls, node_id, image=x, **widgets)
        row["steps"].append({"class_type": class_type, "node_id": node_id, "widgets": widgets,
                             "outputs": [record_output(t, hashed) for t in outs],
                             "ui": {"images": ui["images"], "animated": list(ui["animated"])},
                             "preview": read_preview(ui, hashed)})
        x = outs[0]
    return row


def frame_chain(g: Group, file: str) -> dict:
    """An effect (Invert 0.37 on a see-through card picture: 4 channels) into a Frame's
    layer 1: the Frame gets the float tensor; its 8-bit result as save_live_preview writes it."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_compositor as nc
    from comfy_extras.nodes_color_filters import InvertNode
    x = load("card", file, g.assets[file])
    g.seq += 1
    node_id = f"fx{g.seq}"
    outs, _ui = run_node(InvertNode, node_id, image=x, amount=0.37)
    widgets = {"layer1_x": 0.0, "layer1_y": 0.0, "layer1_rotation": 10.0, "layer1_scale": 0.8, "layer1_opacity": 1.0,
               "layer1_blend": "normal", "layer1_z": 1.0, "layer1_protect": False, "layer1_cloner": "",
               "width": 0, "height": 0, "motion_params": ""}
    previews = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "frame"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        res = nc.CompositorNode.execute(layer1=outs[0], **widgets)
    image = res.result[0]
    assert previews and previews[0] is image
    return {"name": "Invert 0.37 → Frame, card", "inputs": {"image": {"source": "card", "files": [file]}},
            "effect": {"class_type": "AdjustInvert", "node_id": node_id, "widgets": {"amount": 0.37}},
            "frame": {"widgets": widgets, "w": int(image.shape[2]), "h": int(image.shape[1]), "image8": b64(trunc8(image[0]).tobytes())}}


def machinery() -> dict:
    from comfy_extras.nodes_adjust_exposure import AdjustExposureNode
    from comfy_extras.nodes_color_filters import InvertNode, ThresholdNode
    from comfy_extras._live_preview import save_live_preview
    g = Group()
    synths = [{"w": w, "h": h, "channels": c, "seed": s, "sha256": sha(synth(w, h, c, s))} for w, h, c, s in SYNTH_PICTURES]
    standard_cases(g, AdjustExposureNode, "AdjustExposure")
    standard_cases(g, InvertNode, "AdjustInvert")
    standard_cases(g, ThresholdNode, "AdjustThreshold")
    # torch compares a tensor with a Python float in float32: a threshold a quarter of an ulp
    # under a luma the picture holds rounds up to it, so that pixel is NOT above it.
    from comfy_extras.nodes_color_filters import _luma
    rgb = g.picture(37, 23, 3, 1)
    luma = _luma(load("rgb", rgb, g.assets[rgb])).reshape(-1)
    at = np.float32(float(luma.sort().values[luma.numel() // 2]))
    t = float(at) - float(np.spacing(at)) / 4
    assert np.float32(t) == at and t < float(at)
    g.case("AdjustThreshold: a threshold just under a luma the picture holds", ThresholdNode, "AdjustThreshold", {"threshold": t}, {"image": ("rgb", [rgb])})
    # Chains (fix round 1 ruling): Python hands the float32 tensor straight to the next node.
    chains = []
    big, small = g.picture(320, 200, 3, 6), g.picture(23, 19, 4, 3)
    for label, steps in (
        ("Exposure 0.3 → Invert 0.37", [(AdjustExposureNode, "AdjustExposure", {"exposure": 0.3}), (InvertNode, "AdjustInvert", {"amount": 0.37})]),
        ("Invert 0.37 → Exposure −0.7", [(InvertNode, "AdjustInvert", {"amount": 0.37}), (AdjustExposureNode, "AdjustExposure", {"exposure": -0.7})]),
        ("Exposure 0.3 → Threshold 0.5", [(AdjustExposureNode, "AdjustExposure", {"exposure": 0.3}), (ThresholdNode, "AdjustThreshold", {"threshold": 0.5})]),
    ):
        for source, file, hashed in (("rgb", big, True), ("card", small, False)):
            chains.append(chain_case(g, f"{label}, {source}", steps, source, file, hashed))
    chains.append(frame_chain(g, small))
    # save_live_preview keeps a 4-channel tensor's alpha: the preview is RGBA.
    t4 = torch.from_numpy(np.frombuffer(synth(5, 4, 4, 8), dtype=np.uint8).reshape(1, 4, 5, 4).astype(np.float32) / 255.0)
    ui = save_live_preview(t4, "rgba_probe")
    rgba = read_preview({"images": ui["images"]}, False)
    return {"synth": synths, "cases": g.cases, "chains": chains, "assets": {k: b64(v) for k, v in sorted(g.assets.items())}, "rgba_preview": rgba}


# ── Group `kernels` (R2.2): the sampling, pooling and convolution kernels ────

# ε candidates for the library kernels' bands (255-scale; R2 rule 10: at most 2⁻⁸).
KERNEL_EPS = {"2^-12": 2.0 ** -12, "2^-10": 2.0 ** -10, "2^-8": 2.0 ** -8}
# Outputs of at most this many values are stored as float32; larger exact ones as a sha256.
KERNEL_STORE_MAX = 4096


def hashed_values(n: int, seed: int, lo: float = 0.0, hi: float = 1.0, levels: int = 0) -> np.ndarray:
    """n float32 values from a multiplicative hash of the index (as runner_values_fixtures.py
    `hashed_src`): u = k / 2²⁴, then lo + (hi − lo)·u in double, rounded to float32 once; with
    `levels`, u is first quantised to floor(u·levels) / (levels − 1) (ties for max/min and hue).
    tests/unit/runner-effects-kernels.unit.spec.ts rebuilds the same."""
    i = np.arange(n, dtype=np.uint64)
    k = ((i * np.uint64(2654435761) + np.uint64(seed * 40503)) & np.uint64(0xFFFFFFFF)) >> np.uint64(8)
    u = k.astype(np.float64) / 16777216.0
    if levels:
        u = np.floor(u * levels) / (levels - 1)
    return (lo + (hi - lo) * u).astype(np.float32)


def kernel_input(spec: dict) -> torch.Tensor:
    """A (1, C, H, W) tensor from its spec: planar values (every `neg_zero_every`-th set to
    −0, every `nan_every`-th to NaN), then the memory format."""
    c, h, w = spec["shape"]
    v = hashed_values(c * h * w, spec["seed"], spec.get("lo", 0.0), spec.get("hi", 1.0), spec.get("levels", 0))
    if spec.get("neg_zero_every"):
        v[:: spec["neg_zero_every"]] = -0.0
    if spec.get("nan_every"):
        v[:: spec["nan_every"]] = np.nan
    t = torch.from_numpy(v.reshape(1, c, h, w).copy())
    if spec.get("memory") == "channels-last":
        t = t.contiguous(memory_format=torch.channels_last)
    return t


def planar_bytes(t: torch.Tensor) -> bytes:
    return t.detach().contiguous().cpu().numpy().astype("<f4").tobytes()


def kernel_bands(t: torch.Tensor) -> dict:
    """band_list at each ε candidate (a library kernel's float against the 8-bit boundaries)."""
    flat = t.detach().reshape(-1)
    return {name: band_list(flat, eps) for name, eps in KERNEL_EPS.items()}


def kernel_out(t: torch.Tensor, library: bool) -> dict:
    """A kernel's output, planar (C, H, W) float32 bytes: stored (library: always, zlib'd) or
    hashed (a large exact one)."""
    raw = planar_bytes(t)
    row: dict = {"shape": list(t.shape), "f32_sha256": sha(raw)}
    if library:
        row["f32z"] = b64(zlib.compress(raw, 9))
        row["bands"] = kernel_bands(t)
    elif t.numel() <= KERNEL_STORE_MAX:
        row["f32"] = b64(raw)
    return row


class KernelCases:
    def __init__(self) -> None:
        self.cases: list[dict] = []
        self.seed = 0

    def inp(self, c: int, h: int, w: int, lo: float = 0.0, hi: float = 1.0, memory: str = "contiguous", levels: int = 0,
            neg_zero_every: int = 0, nan_every: int = 0) -> dict:
        self.seed += 1
        spec = {"shape": [c, h, w], "seed": self.seed, "lo": lo, "hi": hi, "memory": memory}
        if levels:
            spec["levels"] = levels
        if neg_zero_every:
            spec["neg_zero_every"] = neg_zero_every
        if nan_every:
            spec["nan_every"] = nan_every
        return spec

    def add(self, name: str, fn: str, cls: str, inputs: list, args: dict, run) -> None:
        row = {"name": name, "fn": fn, "class": cls, "inputs": inputs, "args": args}
        try:
            outs = run(*[kernel_input(s) for s in inputs])
        except Exception as e:  # torch raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        if not isinstance(outs, (list, tuple)):
            outs = [outs]
        row["outputs"] = [kernel_out(o, cls == "library") for o in outs]
        self.cases.append(row)


def kernels() -> dict:
    import torch.nn.functional as F
    from torchvision.transforms import _functional_tensor as TF
    g = KernelCases()

    # ── linspace, arange, remainder ──
    for a, b, n in ((0.0, 1.0, 1), (0.0, 1.0, 2), (-1.0, 1.0, 5), (-1.0, 1.0, 37), (-1.0, 1.0, 320), (-2.5, 7.3, 23),
                    (-15.0, 15.0, 31), (-90.0, 90.0, 181), (-150.0, 150.0, 301), (0.0, 1.0, 1000), (0.1, 0.7, 64000), (3.0, -1.7, 77)):
        g.add(f"linspace({a}, {b}, {n})", "linspace", "exact", [], {"a": a, "b": b, "n": n},
              lambda a=a, b=b, n=n: torch.linspace(a, b, n, dtype=torch.float32).view(1, 1, n))
    for n in (1, 7, 320, 70000):
        g.add(f"arange({n})", "arange", "exact", [], {"n": n}, lambda n=n: torch.arange(n, dtype=torch.float32).view(1, 1, n))
    for d in (1.0, 0.37, -0.5, 6.0):
        g.add(f"remainder(t, {d})", "remainder", "exact", [g.inp(1, 23, 37, -3.0, 3.0)], {"b": d}, lambda t, d=d: t[0] % d)
    g.add("remainder(t, t2)", "remainder", "exact", [g.inp(1, 23, 37, -3.0, 3.0), g.inp(1, 23, 37, -2.0, 2.0)], {},
          lambda t, u: torch.remainder(t[0], u[0]))

    # ── pow and the transcendental functions ──
    for e in (2.0, 3.0, 0.5, -0.5, -1.0, -2.0, 0.0, 1.0, 2.2, 1 / 2.2, 1.7, -1.3):
        special = e in (2.0, 3.0, 0.5, -0.5, -1.0, -2.0, 0.0, 1.0)
        g.add(f"pow(t, {e})", "powScalar", "exact" if special else "library", [g.inp(1, 23, 37, 0.0, 2.0)], {"e": e},
              lambda t, e=e: t[0].pow(e))
    g.add("pow(t, 2) over −2…2", "powScalar", "exact", [g.inp(3, 23, 37, -2.0, 2.0)], {"e": 2.0}, lambda t: t[0].pow(2.0))
    g.add("pow(t, -1) at 0", "powScalar", "exact", [g.inp(1, 1, 3, 0.0, 0.0)], {"e": -1.0}, lambda t: t[0].pow(-1.0))
    for op, lo, hi in (("exp", -10.0, 10.0), ("sin", -7.0, 7.0), ("cos", -7.0, 7.0), ("tan", -1.5, 1.5), ("log", 0.001, 4.0)):
        g.add(f"{op}(t)", "unary", "library", [g.inp(1, 23, 37, lo, hi)], {"op": op}, lambda t, op=op: getattr(torch, op)(t[0]))
    g.add("atan2(t, t2)", "unary", "library", [g.inp(1, 23, 37, -1.0, 1.0), g.inp(1, 23, 37, -1.0, 1.0)], {"op": "atan2"},
          lambda t, u: torch.atan2(t[0], u[0]))

    # ── resizes ──
    for size, scale in ((320, 0.666), (200, 0.25), (37, 1.5), (23, 0.1), (7, 3.3), (1, 0.5), (213, 1 / 3), (100, 0.29)):
        g.add(f"area size {size} × {scale}", "areaOutSize", "exact", [g.inp(1, 1, size)], {"in": size, "scale": scale},
              lambda t, scale=scale: torch.tensor([[[float(F.interpolate(t, scale_factor=(1.0, scale), mode="area").shape[-1])]]]))
    area = [((320, 200), (213, 133)), ((320, 200), (80, 50)), ((320, 200), (1, 1)), ((37, 23), (17, 9)),
            ((37, 23), (37, 23)), ((7, 5), (14, 10)), ((2, 3), (5, 7)), ((1, 1), (3, 2)), ((37, 23), (1, 1))]
    for (sw, sh), (dw, dh) in area:
        for c, memory in ((1, "contiguous"), (3, "contiguous"), (4, "contiguous"), (3, "channels-last"), (4, "channels-last")):
            g.add(f"area {sw}×{sh} → {dw}×{dh}, {c} ch {memory}", "resizeArea", "exact", [g.inp(c, sh, sw, memory=memory)],
                  {"oh": dh, "ow": dw}, lambda t, dh=dh, dw=dw: F.interpolate(t, size=(dh, dw), mode="area")[0])
    nearest = [((37, 23), (74, 46)), ((7, 5), (21, 15)), ((320, 200), (213, 133)), ((37, 23), (37, 23)), ((37, 23), (50, 31)),
               ((2, 3), (5, 7)), ((1, 1), (3, 2)), ((320, 200), (640, 400))]
    for (sw, sh), (dw, dh) in nearest:
        for c, memory in ((1, "contiguous"), (3, "channels-last"), (4, "channels-last")):
            g.add(f"nearest {sw}×{sh} → {dw}×{dh}, {c} ch {memory}", "resizeNearest", "exact", [g.inp(c, sh, sw, memory=memory)],
                  {"oh": dh, "ow": dw}, lambda t, dh=dh, dw=dw: F.interpolate(t, size=(dh, dw), mode="nearest")[0])
    for (sw, sh), (dw, dh) in (((37, 23), (64, 48)), ((320, 200), (213, 133)), ((7, 5), (3, 2))):
        for c, memory in ((1, "contiguous"), (3, "channels-last"), (4, "channels-last"), (4, "contiguous")):
            g.add(f"bilinear {sw}×{sh} → {dw}×{dh}, {c} ch {memory}", "resizeBilinear", "exact", [g.inp(c, sh, sw, memory=memory)],
                  {"oh": dh, "ow": dw}, lambda t, dh=dh, dw=dw: F.interpolate(t, size=(dh, dw), mode="bilinear", align_corners=False)[0])
    bicubic = [((17, 13), (64, 48)), ((37, 23), (17, 9)), ((320, 200), (213, 133)), ((7, 5), (7, 5)), ((1, 1), (3, 2)),
               ((2, 3), (5, 7)), ((37, 23), (74, 46))]
    for (sw, sh), (dw, dh) in bicubic:
        for c, memory in ((1, "contiguous"), (3, "contiguous"), (4, "contiguous"), (3, "channels-last"), (4, "channels-last")):
            g.add(f"bicubic {sw}×{sh} → {dw}×{dh}, {c} ch {memory}", "resizeBicubic", "exact", [g.inp(c, sh, sw, memory=memory)],
                  {"oh": dh, "ow": dw}, lambda t, dh=dh, dw=dw: F.interpolate(t, size=(dh, dw), mode="bicubic", align_corners=False)[0])

    # ── grid_sample, affine_grid ──
    def grid_of(gx: torch.Tensor, gy: torch.Tensor) -> torch.Tensor:
        # Every 7th value exactly on an edge (±1) and every 11th at 0, so "on" the border is covered.
        gx, gy = gx[0, 0].clone(), gy[0, 0].clone()
        for t in (gx, gy):
            flat = t.view(-1)
            flat[::7] = torch.where(torch.arange(flat[::7].numel()) % 2 == 0, 1.0, -1.0)
            flat[3::11] = 0.0
        return torch.stack((gx, gy), dim=-1)[None]

    for c in (1, 3, 4):
        for lo, hi in ((-0.9, 0.9), (-1.6, 1.6), (-4.3, 4.3)):
            for padding in ("zeros", "border", "reflection"):
                for ac in (False, True):
                    src, gxs, gys = g.inp(c, 23, 37), g.inp(1, 17, 29, lo, hi), g.inp(1, 17, 29, lo, hi)
                    g.add(f"grid_sample {c} ch, grid {lo}…{hi}, {padding}, align_corners {ac}", "gridSample", "exact", [src, gxs, gys],
                          {"padding": padding, "alignCorners": ac, "edges": True},
                          lambda t, gx, gy, padding=padding, ac=ac: F.grid_sample(t, grid_of(gx, gy), mode="bilinear", padding_mode=padding, align_corners=ac)[0])
    for w, h in ((1, 1), (2, 3), (7, 5)):
        for padding in ("zeros", "border", "reflection"):
            for ac in (False, True):
                src, gxs, gys = g.inp(3, h, w), g.inp(1, 5, 6, -1.6, 1.6), g.inp(1, 5, 6, -1.6, 1.6)
                g.add(f"grid_sample {w}×{h} 3 ch, {padding}, align_corners {ac}", "gridSample", "exact", [src, gxs, gys],
                      {"padding": padding, "alignCorners": ac, "edges": True},
                      lambda t, gx, gy, padding=padding, ac=ac: F.grid_sample(t, grid_of(gx, gy), mode="bilinear", padding_mode=padding, align_corners=ac)[0])
    src, gxs, gys = g.inp(4, 200, 320), g.inp(1, 200, 320, -1.2, 1.2), g.inp(1, 200, 320, -1.2, 1.2)
    g.add("grid_sample 4 ch 320×200, reflection", "gridSample", "exact", [src, gxs, gys], {"padding": "reflection", "alignCorners": False, "edges": True},
          lambda t, gx, gy: F.grid_sample(t, grid_of(gx, gy), mode="bilinear", padding_mode="reflection", align_corners=False)[0])
    for theta in ([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], [[0.7071, -0.7071, 0.1], [0.7071, 0.7071, -0.25]],
                  [[1.2, 0.3, -0.4], [-0.1, 0.8, 0.33]]):
        for w, h in ((37, 23), (1, 1), (2, 3), (320, 200)):
            g.add(f"affine_grid {theta} {w}×{h}", "affineGrid", "library", [], {"theta": theta, "h": h, "w": w},
                  lambda theta=theta, h=h, w=w: tuple(F.affine_grid(torch.tensor([theta], dtype=torch.float32), [1, 1, h, w], align_corners=False)[0].permute(2, 0, 1)[None, i] for i in (0, 1)))

    # ── pools, reflect padding ──
    for k in (1, 2, 3, 13):
        for pad in sorted({0, k // 2}):
            for (w, h), c, memory in (((37, 23), 3, "contiguous"), ((37, 23), 4, "channels-last"), ((7, 5), 1, "contiguous"), ((320, 200), 3, "channels-last"),
                                      ((1, 1), 3, "contiguous"), ((2, 3), 4, "channels-last")):
                g.add(f"avg_pool2d k {k} pad {pad}, {w}×{h} {c} ch {memory}", "avgPool2d", "exact", [g.inp(c, h, w, memory=memory)], {"k": k, "pad": pad},
                      lambda t, k=k, pad=pad: F.avg_pool2d(t, k, stride=1, padding=pad, count_include_pad=True, ceil_mode=False)[0])
                g.add(f"max_pool2d k {k} pad {pad}, {w}×{h} {c} ch {memory}", "maxPool2d", "exact", [g.inp(c, h, w, memory=memory)], {"k": k, "pad": pad},
                      lambda t, k=k, pad=pad: F.max_pool2d(t, k, stride=1, padding=pad)[0])
    # torch refuses a pad of more than half the window.
    for k, pad in ((3, 2), (2, 2), (1, 1)):
        g.add(f"avg_pool2d k {k} pad {pad} (over half)", "avgPool2d", "exact", [g.inp(3, 23, 37)], {"k": k, "pad": pad},
              lambda t, k=k, pad=pad: F.avg_pool2d(t, k, stride=1, padding=pad)[0])
        g.add(f"max_pool2d k {k} pad {pad} (over half)", "maxPool2d", "exact", [g.inp(3, 23, 37)], {"k": k, "pad": pad},
              lambda t, k=k, pad=pad: F.max_pool2d(t, k, stride=1, padding=pad)[0])
    for k in (1, 2, 3, 8, 13):
        for (w, h), c, memory in (((37, 23), 3, "contiguous"), ((37, 23), 4, "channels-last"), ((320, 200), 3, "channels-last")):
            g.add(f"avg_pool2d stride k {k}, {w}×{h} {c} ch {memory}", "avgPool2dStrided", "exact", [g.inp(c, h, w, memory=memory)], {"k": k},
                  lambda t, k=k: F.avg_pool2d(t, kernel_size=k)[0])
    for (w, h), pads in (((7, 5), [(6, 6, 4, 4), (1, 2, 3, 0), (0, 0, 0, 0), (7, 0, 0, 0), (0, 0, 0, 5), (0, 6, 0, 4)]),
                         ((2, 3), [(1, 1, 2, 2), (2, 0, 0, 0)]), ((1, 1), [(1, 0, 0, 0), (0, 0, 0, 0)]), ((37, 23), [(36, 36, 22, 22)])):
        for l, r, top, bottom in pads:
            g.add(f"pad reflect {w}×{h} ({l}, {r}, {top}, {bottom})", "padReflect", "exact", [g.inp(3, h, w)], {"l": l, "r": r, "top": top, "bottom": bottom},
                  lambda t, l=l, r=r, top=top, bottom=bottom: F.pad(t, [l, r, top, bottom], mode="reflect")[0])

    # ── conv2d ──
    # Fix round 2: the runner convolves only the kernel classes the R2 effects pass (kernels.ts
    # CONV_CLASS_EPS): integer3 (Sobel, laplacian), scaled3 (Emboss × depth) and normalised (Blur's
    # motion line, Bokeh's disk); anything else is refused. `conv_class` names the class a case's
    # kernel is in (None: the runner refuses it; Python's output is still recorded).
    from comfy_extras.nodes_blur import _motion_kernel
    sobel_x = [[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]]
    sobel_y = [[-1.0, -2.0, -1.0], [0.0, 0.0, 0.0], [1.0, 2.0, 1.0]]
    laplacian = [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]]
    emboss = [[-2.0, -1.0, 0.0], [-1.0, 1.0, 1.0], [0.0, 1.0, 2.0]]

    def bokeh_disk(r: float) -> torch.Tensor:
        """nodes_glsl_lens.py Bokeh's disk kernel, as it builds it."""
        k = int(2 * math.ceil(r) + 1)
        yy, xx = torch.meshgrid(torch.arange(k, dtype=torch.float32) - k // 2, torch.arange(k, dtype=torch.float32) - k // 2, indexing="ij")
        d = (torch.sqrt(xx * xx + yy * yy) <= r).to(torch.float32)
        return d / d.sum()

    def conv_kernel(cls: str, rng) -> torch.Tensor:
        """One kernel of a class, drawn as the effects draw their settings."""
        if cls == "integer3":
            return torch.tensor((sobel_x, sobel_y, laplacian, emboss)[int(rng.integers(4))], dtype=torch.float32)
        if cls == "scaled3":
            step = int(rng.integers(1, 80))
            # Whole depths below 4 make an integer kernel (class integer3): step past them.
            depth = 4.0 if rng.random() < 0.5 else float(np.float32((step + (step % 20 == 0)) * 0.05))
            return torch.tensor(emboss, dtype=torch.float32) * depth
        if rng.random() < 0.5:
            return _motion_kernel(int(rng.integers(2, 16)), float(rng.integers(0, 361)))[0, 0].to(torch.float32)
        return bokeh_disk(9.5 if rng.random() < 0.5 else float(rng.integers(1, 20) * 0.5))

    # The sweep: 20 fresh seeds per class, 400 × 400 × 3, values in [0, 1] and [−0.1, 1.1], reflect
    # padded then depthwise (and Sobel's zero-padded one-channel form): torch's float32 against its
    # own float64, the largest |Δ| (255-scale). The runner's double sums sit on the float64 side.
    conv_sweep = {}
    for cls in ("integer3", "scaled3", "normalised"):
        worst = 0.0
        for seed in range(20):
            rng = np.random.default_rng(20260926 + seed)
            kt = conv_kernel(cls, rng)
            kh, kw = kt.shape
            for lo, hi in ((0.0, 1.0), (-0.1, 1.1)):
                x = torch.from_numpy(rng.uniform(lo, hi, (1, 3, 400, 400)).astype(np.float32))
                xp = F.pad(x, [kw // 2, kw // 2, kh // 2, kh // 2], mode="reflect")
                a32 = F.conv2d(xp, kt.expand(3, 1, kh, kw).contiguous(), groups=3)
                a64 = F.conv2d(xp.double(), kt.double().expand(3, 1, kh, kw).contiguous(), groups=3).float()
                worst = max(worst, float((a32 - a64).abs().max()) * 255)
                if cls == "integer3":
                    b32 = F.conv2d(x[:, :1], kt[None, None], padding=1)
                    b_64 = F.conv2d(x[:, :1].double(), kt.double()[None, None], padding=1).float()
                    worst = max(worst, float((b32 - b_64).abs().max()) * 255)
        conv_sweep[cls] = {"worst": worst, "seeds": 20, "picture": [3, 400, 400], "ranges": [[0.0, 1.0], [-0.1, 1.1]]}

    # Per class, 10 seeds as fixture cases (40 × 32 × 3, reflect padded as the effects pad).
    for cls in ("integer3", "scaled3", "normalised"):
        for seed in range(10):
            rng = np.random.default_rng(7000 + seed + 100 * len(cls))
            kt = conv_kernel(cls, rng)
            kh, kw = kt.shape
            flat = [float(v) for v in kt.reshape(-1)]
            lo, hi = ((0.0, 1.0), (-0.1, 1.1))[seed % 2]
            g.add(f"conv2d {cls} seed {seed}, {kh}×{kw}, 40×32 3 ch reflect padded", "conv2dDepthwise", "library", [g.inp(3, 32, 40, lo, hi)],
                  {"kernel": flat, "kh": kh, "kw": kw, "reflect": [kh // 2, kw // 2], "conv_class": cls},
                  lambda t, kt=kt, kh=kh, kw=kw: F.conv2d(F.pad(t, [kw // 2, kw // 2, kh // 2, kh // 2], mode="reflect"), kt.expand(3, 1, kh, kw).contiguous(), groups=3)[0])
    for name, kern in (("sobel x", sobel_x), ("sobel y", sobel_y)):
        kt = torch.tensor(kern, dtype=torch.float32)
        g.add(f"conv2d same {name}, 64×48 (Outline)", "conv2dSame", "library", [g.inp(1, 48, 64)],
              {"kernel": [float(v) for v in kt.reshape(-1)], "kh": 3, "kw": 3, "pad": 1, "conv_class": "integer3"},
              lambda t, kt=kt: F.conv2d(t, kt[None, None], padding=1)[0])

    # The brief's named kernels: Sobel, emboss, a 17 × 17 motion line (_motion_kernel(17, 33°)), a 21 × 21 disk.
    motion17 = _motion_kernel(17, 33.0)[0, 0].to(torch.float32)
    for name, kt, cls in (("sobel", torch.tensor(sobel_x), "integer3"), ("emboss", torch.tensor(emboss), "integer3"),
                          ("motion 17", motion17, "normalised"), ("disk 21", bokeh_disk(10.0), "normalised")):
        kh, kw = kt.shape
        flat = [float(v) for v in kt.reshape(-1)]
        for c, (w, h) in ((3, (37, 23)), (4, (64, 48))):
            g.add(f"conv2d depthwise {name}, {w}×{h} {c} ch", "conv2dDepthwise", "library", [g.inp(c, h, w)], {"kernel": flat, "kh": kh, "kw": kw, "conv_class": cls},
                  lambda t, kt=kt, c=c: F.conv2d(t, kt.expand(c, 1, *kt.shape), groups=c)[0])
        g.add(f"conv2d same {name}, 64×48", "conv2dSame", "library", [g.inp(1, 48, 64)], {"kernel": flat, "kh": kh, "kw": kw, "pad": kh // 2, "conv_class": cls},
              lambda t, kt=kt: F.conv2d(t, kt[None, None], padding=kt.shape[0] // 2)[0])

    # Random kernels (fix round 1): normalised ones are in the class; unnormalised (−2…2) are
    # refused (they drift to 10⁻² against torch's float sums: R2.2 re-review).
    for size in (5, 11, 21):
        for label, lo, hi in (("normalised", 0.0, 1.0), ("unnormalised", -2.0, 2.0)):
            g.seed += 1
            kv = hashed_values(size * size, g.seed, lo, hi)
            if label == "normalised":
                kv = (kv / kv.sum(dtype=np.float32)).astype(np.float32)
            kt = torch.from_numpy(kv.reshape(size, size).copy())
            flat = [float(x) for x in kv]
            cls = "normalised" if label == "normalised" else None
            g.add(f"conv2d depthwise random {label} {size}×{size}, 64×48 3 ch", "conv2dDepthwise", "library", [g.inp(3, 48, 64)],
                  {"kernel": flat, "kh": size, "kw": size, "conv_class": cls}, lambda t, kt=kt: F.conv2d(t, kt.expand(3, 1, *kt.shape), groups=3)[0])
            g.add(f"conv2d same random {label} {size}×{size}, 64×48", "conv2dSame", "library", [g.inp(1, 48, 64)],
                  {"kernel": flat, "kh": size, "kw": size, "pad": size // 2, "conv_class": cls},
                  lambda t, kt=kt: F.conv2d(t, kt[None, None], padding=kt.shape[0] // 2)[0])

    # ── gaussian ──
    # The blur's proven range is ksize ≤ 181 (σ ≤ 30, every Python caller): (301, 50) measured
    # outside ε = 2⁻⁸ (review of R2.2), so the runner refuses it and only its 1-D kernel is here.
    for ksize, sigma in ((3, 0.3), (7, 1.0), (31, 5.0), (61, 10.0), (181, 30.0), (301, 50.0)):
        g.add(f"gaussian kernel ({ksize}, {sigma})", "gaussianKernel1d", "library", [], {"ksize": ksize, "sigma": sigma},
              lambda ksize=ksize, sigma=sigma: TF._get_gaussian_kernel1d(ksize, sigma, torch.float32, torch.device("cpu")).view(1, 1, ksize))
        if ksize > 181:
            continue
        g.add(f"gaussian_blur ({ksize}, {sigma}), 64×48 4 ch", "gaussianBlur", "library", [g.inp(4, 48, 64)], {"ksize": ksize, "sigma": sigma},
              lambda t, ksize=ksize, sigma=sigma: TF.gaussian_blur(t, [ksize, ksize], [sigma, sigma])[0])
    # ksize 181 raises on 64×48: the blur itself on a picture it fits.
    g.add("gaussian_blur (181, 30.0), 100×96 4 ch", "gaussianBlur", "library", [g.inp(4, 96, 100)], {"ksize": 181, "sigma": 30.0},
          lambda t: TF.gaussian_blur(t, [181, 181], [30.0, 30.0])[0])
    g.add("gaussian_blur (7, 1.0), 37×23 3 ch channels-last", "gaussianBlur", "library", [g.inp(3, 23, 37, memory="channels-last")], {"ksize": 7, "sigma": 1.0},
          lambda t: TF.gaussian_blur(t, [7, 7], [1.0, 1.0])[0])

    # ── torchvision's colour operations ──
    for c, memory in ((3, "contiguous"), (3, "channels-last"), (1, "contiguous"), (4, "contiguous")):
        g.add(f"rgb_to_grayscale {c} ch {memory}", "rgbToGrayscale", "exact", [g.inp(c, 23, 37, memory=memory)], {},
              lambda t: TF.rgb_to_grayscale(t)[0])
    for r in (0.0, 0.3, 1.0, 1.5):
        g.add(f"blend {r}", "blend", "exact", [g.inp(3, 23, 37), g.inp(3, 23, 37)], {"ratio": r}, lambda a, b, r=r: TF._blend(a, b, r)[0])
    adjust = (("adjustBrightness", TF.adjust_brightness, (0.0, 0.5, 1.0, 1.7, 3.0), "exact"),
              ("adjustSaturation", TF.adjust_saturation, (0.0, 0.3, 1.0, 2.5), "exact"),
              ("adjustContrast", TF.adjust_contrast, (0.0, 0.5, 1.0, 1.8), "exact"),
              ("adjustHue", TF.adjust_hue, (-0.5, -0.25, 0.0, 0.13, 0.5), "exact"))
    for fn, op, factors, cls in adjust:
        for fac in factors:
            for (w, h), c, memory, levels in (((37, 23), 3, "contiguous", 0), ((37, 23), 3, "channels-last", 8), ((37, 23), 1, "contiguous", 0),
                                              ((1, 1), 3, "contiguous", 0), ((2, 3), 3, "channels-last", 4)):
                g.add(f"{fn} {fac}, {w}×{h} {c} ch {memory}{' levels' if levels else ''}", fn, cls, [g.inp(c, h, w, memory=memory, levels=levels)], {"f": fac},
                      lambda t, op=op, fac=fac: op(t, fac)[0])
        g.add(f"{fn} {factors[1]}, 4 ch", fn, cls, [g.inp(4, 23, 37)], {"f": factors[1]}, lambda t, op=op, fac=factors[1]: op(t, fac)[0])
        g.add(f"{fn} {factors[-1]}, 320×200 3 ch channels-last", fn, cls, [g.inp(3, 200, 320, memory="channels-last", levels=64)], {"f": factors[-1]},
              lambda t, op=op, fac=factors[-1]: op(t, fac)[0])
    for n in (1, 15, 16, 17, 31, 64, 65, 4096, 4099, 64000, 70001, 1_000_003):
        g.add(f"mean of {n}", "meanAll", "exact", [g.inp(1, 1, n)], {}, lambda t: torch.mean(t[0, 0], dim=(-1,)).view(1, 1, 1))
    for n in (1024 * 1024,):
        g.add(f"mean of {n}, 0…1/255 steps", "meanAll", "exact", [g.inp(1, 1, n, levels=256)], {}, lambda t: torch.mean(t[0, 0], dim=(-1,)).view(1, 1, 1))

    # −0 (fix round 1): torch's clamp gives +0 in its vector loop and keeps −0 in each chunk's
    # scalar tail (the last n mod 8 values of a chunk of the tensor's memory).
    for (w, h), memory in (((7, 3), "contiguous"), ((7, 3), "channels-last"), ((117, 200), "contiguous"), ((117, 200), "channels-last")):
        spec = lambda: g.inp(3, h, w, memory=memory, neg_zero_every=5)  # noqa: E731
        g.add(f"blend 0.3 with −0, {w}×{h} {memory}", "blend", "exact", [spec(), spec()], {"ratio": 0.3}, lambda a, b: TF._blend(a, b, 0.3)[0])
        for fn, op, fac in (("adjustBrightness", TF.adjust_brightness, 1.5), ("adjustSaturation", TF.adjust_saturation, 1.3),
                            ("adjustContrast", TF.adjust_contrast, 1.2)):
            g.add(f"{fn} {fac} with −0, {w}×{h} 3 ch {memory}", fn, "exact", [spec()], {"f": fac}, lambda t, op=op, fac=fac: op(t, fac)[0])

    # Batches (fix round 1): with two or more pictures torch splits a long sum over the batch,
    # each picture's sum on one thread. Each output is one picture's.
    for n in (64000, 70001, 1_000_003):
        g.add(f"mean of {n}, batch of 2", "meanAll", "exact", [g.inp(1, 1, n), g.inp(1, 1, n)], {"batch": 2},
              lambda a, b: tuple(torch.mean(torch.cat([a, b]), dim=(-3, -2, -1)).view(2, 1, 1, 1)))
    for memory in ("contiguous", "channels-last"):
        spec = lambda: g.inp(3, 200, 320, memory=memory, levels=64)  # noqa: E731
        g.add(f"adjustContrast 1.8, batch of 2, 320×200 3 ch {memory}", "adjustContrast", "exact", [spec(), spec()], {"f": 1.8, "batch": 2},
              lambda a, b: tuple(TF.adjust_contrast(torch.cat([a, b]), 1.8)))
        g.add(f"adjustBrightness 1.5 with −0, batch of 2, 117×200 3 ch {memory}", "adjustBrightness", "exact",
              [g.inp(3, 200, 117, memory=memory, neg_zero_every=5), g.inp(3, 200, 117, memory=memory, neg_zero_every=7)], {"f": 1.5, "batch": 2},
              lambda a, b: tuple(TF.adjust_brightness(torch.cat([a, b]), 1.5)))
    for c, memory in ((1, "contiguous"), (3, "contiguous"), (3, "channels-last")):
        g.add(f"area 320×200 → 1×1, batch of 2, {c} ch {memory}", "resizeArea", "exact", [g.inp(c, 200, 320, memory=memory), g.inp(c, 200, 320, memory=memory)],
              {"oh": 1, "ow": 1, "batch": 2}, lambda a, b: tuple(F.interpolate(torch.cat([a, b]), size=(1, 1), mode="area")))

    # ── topk ──
    topk = []
    for n, levels, k, largest, nan in ((50, 6, 1, True, 0), (50, 6, 5, True, 0), (50, 6, 17, False, 0), (50, 6, 50, True, 0), (200, 0, 13, True, 0),
                                       (64, 3, 20, False, 0), (64, 3, 12, True, 9), (64, 3, 30, False, 9)):
        spec = g.inp(1, 1, n, levels=levels, nan_every=nan)
        v = kernel_input(spec)[0, 0, 0]
        vals, idx = torch.topk(v, k, largest=largest)
        assert not torch.isnan(vals[-1]), "the cut must be a number (JSON)"
        topk.append({"name": f"topk {n} values ({levels or 'no'} levels{', NaN' if nan else ''}), k {k}, largest {largest}", "input": spec, "k": k, "largest": largest,
                     "values": b64(vals.numpy().astype("<f4").tobytes()), "indices": [int(i) for i in idx], "cut": float(vals[-1])})

    return {"cases": g.cases, "topk": topk, "conv_sweep": conv_sweep, "eps_candidates": KERNEL_EPS, "store_max": KERNEL_STORE_MAX}


# ── rng: torch's CPU generator (R2.3) ────────────────────────────────────────

RNG_SEEDS = [0, 1, 42, 123456789, 2 ** 31 - 1]
RNG_HEAD = 64


def rng_call(g: torch.Generator, call: dict) -> dict:
    """One call on generator `g`, recorded as the spec replays it."""
    op = call["op"]
    if op == "raw":
        # random_(int64 min, None): random_full_64_bits_range_kernel, one random64 per element
        # (two mt19937 draws, the first in the high word).
        t = torch.empty(call["n"], dtype=torch.int64).random_(-2 ** 63, None, generator=g)
        data = t.numpy().view("<u8")
        return {"dtype": "u64", "n": int(data.size), "sha256": sha(data.tobytes()),
                "head": [str(int(v)) for v in data[:RNG_HEAD]]}
    if op == "rand":
        t = torch.rand(*call["shape"], generator=g, dtype=torch.float32)
    elif op == "randn":
        state = g.get_state()
        t = torch.randn(*call["shape"], generator=g, dtype=torch.float32)
    elif op == "randperm":
        t = torch.randperm(call["n"], generator=g)
        data = t.numpy().astype("<i8")
        return {"dtype": "i64", "n": int(data.size), "sha256": sha(data.tobytes()),
                "head": [int(v) for v in data[:RNG_HEAD]]}
    else:
        raise ValueError(op)
    data = t.contiguous().numpy().astype("<f4").ravel()
    out = {"dtype": "f32", "n": int(data.size), "sha256": sha(data.tobytes()),
           "head": [float(v) for v in data[:RNG_HEAD]]}
    if op == "randn":
        out["f32"] = b64(data.tobytes())
        if data.size >= 16:
            out["libm"] = normal_fill_libm(state, data)
    return out


def _libm():
    """This Mac's libm, as torch's normal_fill_16 calls it: logf, and sinf / cosf of one
    angle fused by the compiler into __sincosf_stret (libtorch_cpu imports both)."""
    import ctypes

    class SinCos(ctypes.Structure):
        _fields_ = [("s", ctypes.c_float), ("c", ctypes.c_float)]
    lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    lib.logf.restype, lib.logf.argtypes = ctypes.c_float, [ctypes.c_float]
    sincos = getattr(lib, "__sincosf_stret")
    sincos.restype, sincos.argtypes = SinCos, [ctypes.c_float]
    return lib.logf, sincos


def normal_fill_libm(state: torch.Tensor, want: np.ndarray) -> dict:
    """Where this Mac's float logf / sincosf are not the correctly rounded value (the
    double function rounded to float) on an argument normal_fill used: those arguments
    and libm's results, as float32 bits. normal_fill is replayed here from the same
    uniforms with libm's own functions and must give torch's bytes, so the record is
    exactly what torch computed with."""
    logf, sincos = _libm()
    f32 = np.float32
    n = want.size
    g2 = torch.Generator(device="cpu")
    g2.set_state(state)
    u = torch.rand(n + (16 if n % 16 else 0), generator=g2, dtype=torch.float32).numpy()
    d = u[:n].copy()
    bits = lambda x: int(np.array(x, dtype="<f4").view("<u4"))  # noqa: E731
    logs: dict[int, int] = {}
    trig: dict[int, list[int]] = {}

    def fill16(o: int) -> None:
        for j in range(8):
            u1 = f32(1) - d[o + j]
            lg = f32(logf(float(u1)))
            if lg != f32(math.log(float(u1))):
                logs[bits(u1)] = bits(lg)
            radius = f32(math.sqrt(float(f32(-2) * lg)))
            theta = f32(2 * math.pi * float(d[o + j + 8]))
            sc = sincos(float(theta))
            c, s = f32(sc.c), f32(sc.s)
            if c != f32(math.cos(float(theta))) or s != f32(math.sin(float(theta))):
                trig[bits(theta)] = [bits(c), bits(s)]
            d[o + j] = f32(radius * c) + f32(0)
            d[o + j + 8] = f32(radius * s) + f32(0)
    for i in range(0, n - 15, 16):
        fill16(i)
    if n % 16:
        d[n - 16:] = u[n:]
        fill16(n - 16)
    assert d.view("<u4").tolist() == want.view("<u4").tolist(), "normal_fill replayed with libm must give torch's bytes"
    return {"log": [[k, v] for k, v in sorted(logs.items())], "sincos": [[k, *v] for k, v in sorted(trig.items())]}


def rng() -> dict:
    if platform.system() != "Darwin":
        sys.exit("The rng fixtures record this Mac's libm (logf, __sincosf_stret): regenerate them on macOS.")
    cases = []

    def case(name: str, seed: int, calls: list, global_seed: bool = False) -> None:
        # torch.manual_seed (Add noise) seeds the default generator; the others make their own.
        g = torch.manual_seed(seed) if global_seed else torch.Generator(device="cpu").manual_seed(seed)
        cases.append({"name": name, "seed": str(seed), "global": global_seed, "calls": calls,
                      "outputs": [rng_call(g, c) for c in calls]})

    for seed in RNG_SEEDS:
        case(f"raw 10000 draws, seed {seed}", seed, [{"op": "raw", "n": 5000}])
        for n in (1, 7, 15, 16, 17, 100, 10000):
            case(f"rand({n}), seed {seed}", seed, [{"op": "rand", "shape": [n]}])
        for n in (1, 2, 15, 16, 17, 31, 33, 10000):
            case(f"randn({n}), seed {seed}", seed, [{"op": "randn", "shape": [n]}])
        for n in (2, 10, 9216):
            case(f"randperm({n}), seed {seed}", seed, [{"op": "randperm", "n": n}])
        # Glitch (nodes_glsl_distortion.py): one rand(1).item() per slice, up to 60.
        case(f"rand(1) × 50, seed {seed}", seed, [{"op": "rand", "shape": [1]}] * 50)
        # Voronoi (nodes_glsl_generative.py): sites, then colours, from one generator.
        for points in (4, 40, 400):
            case(f"Voronoi rand({points}, 2) then rand({points}, 3), seed {seed}", seed,
                 [{"op": "rand", "shape": [points, 2]}, {"op": "rand", "shape": [points, 3]}])
        # State and the cached double normal carried across calls: randn(15) leaves one
        # normal cached, randn(16) and rand don't touch it, randn(1) takes it.
        case(f"rand → randn(15) → randn(16) → rand → randn(1) → randn(2), seed {seed}", seed,
             [{"op": "rand", "shape": [3]}, {"op": "randn", "shape": [15]}, {"op": "randn", "shape": [16]},
              {"op": "rand", "shape": [5]}, {"op": "randn", "shape": [1]}, {"op": "randn", "shape": [2]}])

    # FilmGrain (nodes_glsl_atmosphere.py): randn(1, 1, gh, gw), gh, gw = max(2, int(side / size)).
    for gh, gw in ((2, 2), (3, 5), (4, 4), (5, 9), (19, 23), (23, 37), (200, 320)):
        case(f"FilmGrain randn(1, 1, {gh}, {gw}), seed 1", 1, [{"op": "randn", "shape": [1, 1, gh, gw]}])
    # Only the seed's low 32 bits reach mt19937; torch.manual_seed (Add noise) is the same engine.
    case("rand(16), seed 2^40 + 42 (low bits 42)", 2 ** 40 + 42, [{"op": "rand", "shape": [16]}])
    case("randn(20) on torch.manual_seed(42)", 42, [{"op": "randn", "shape": [20]}], global_seed=True)
    case("randn(5) on torch.manual_seed(2^32 + 1)", 2 ** 32 + 1, [{"op": "randn", "shape": [5]}], global_seed=True)
    # A seed whose normal_fill meets one of libm's rare logf misses (about 5 in 1M draws), so the
    # spec's logf half of the libm proof runs on real data.
    case("randn(256), seed 1719 (a logf miss)", 1719, [{"op": "randn", "shape": [256]}])
    # The edges of what manual_seed accepts: [−2^63, 2^64 − 1]; past them torch raises.
    case("rand(16), seed 2^64 − 1", 2 ** 64 - 1, [{"op": "rand", "shape": [16]}])
    case("rand(16), seed −2^63", -2 ** 63, [{"op": "rand", "shape": [16]}])
    for bad in (2 ** 64, -2 ** 63 - 1):
        try:
            torch.Generator(device="cpu").manual_seed(bad)
        except (ValueError, RuntimeError):
            continue
        raise AssertionError(f"torch accepted seed {bad}: the port's bounds are wrong")
    return {"cases": cases, "seeds": RNG_SEEDS, "head": RNG_HEAD}


# ── Group `tone` (R2.4): the tone, colour and light effects ─────────────────

# (module, node_id) of the 26 classes R2.4 ports (the three pilots are the machinery group's).
TONE_CLASSES = [
    ("nodes_adjust_brightness_contrast", "AdjustBrightnessContrast"), ("nodes_adjust_color", "AdjustColor"),
    ("nodes_adjust_curves", "AdjustCurves"), ("nodes_adjust_levels", "AdjustLevels"),
    ("nodes_color_filters", "AdjustTemperature"), ("nodes_color_filters", "AdjustVibrance"),
    ("nodes_color_filters", "AdjustColorBalance"), ("nodes_color_filters", "AdjustBlackWhite"),
    ("nodes_color_filters", "AdjustPhotoFilter"), ("nodes_color_filters", "AdjustGradientMap"),
    ("nodes_color_filters", "AdjustChannelMixer"), ("nodes_color_filters", "AdjustPosterize"),
    ("nodes_tone_extras", "AdjustVignette"), ("nodes_tone_extras", "AdjustShadowsHighlights"),
    ("nodes_glsl_grading", "Duotone"), ("nodes_glsl_grading", "SplitToning"),
    ("nodes_glsl_unicorn", "GradientMap"), ("nodes_glsl_unicorn", "Posterize"),
    ("nodes_glsl_unicorn", "Hologram"), ("nodes_glsl_unicorn", "TwoDLight"),
    ("nodes_glsl_atmosphere", "LightLeak"), ("nodes_glsl_atmosphere", "LensFlare"),
    ("nodes_glsl_lab", "Caustics"), ("nodes_glsl_lab", "Blinds"),
    ("nodes_glsl_stylize", "CrossHatch"), ("nodes_glsl_stylize", "Dither"),
]

# The library classes' ε (255-scale; R2 rule 10: at most 2⁻⁸), each at least twice the worst
# |Δ| measured against the TypeScript port over this group (R2.4 report). The worst depends on
# the inputs (Hologram: 3.04e-5 here, 4.56e-5 on the R2.4 reviewer's fresh inputs). A hashed case's band
# is recorded at its class's ε; tests/unit/runner-effects-tone.unit.spec.ts holds the same table.
TONE_LIBRARY_EPS = {
    "AdjustBrightnessContrast": 2.0 ** -12, "AdjustCurves": 2.0 ** -12, "AdjustLevels": 2.0 ** -12,
    "SplitToning": 2.0 ** -12, "Posterize": 2.0 ** -12, "Hologram": 2.0 ** -12, "TwoDLight": 2.0 ** -12,
    "LightLeak": 2.0 ** -12, "LensFlare": 2.0 ** -12, "Caustics": 2.0 ** -12,
}


def node_class(module: str, node_id: str):
    """The real node class whose schema is `node_id` (two modules both have a GradientMapNode)."""
    import importlib
    mod = importlib.import_module(f"comfy_extras.{module}")
    for v in vars(mod).values():
        if isinstance(v, type) and hasattr(v, "define_schema") and v.__module__ == mod.__name__:
            try:
                if v.define_schema().node_id == node_id:
                    return v
            except Exception:  # noqa: BLE001 — helpers and bases without a schema
                continue
    raise LookupError(node_id)


def record_tone_output(t: torch.Tensor, hashed: bool, eps: float | None) -> dict:
    """One output tensor, frame by frame (H × W × C): the sha256 of its float32 and of Python's
    round8 and trunc8. A library class (eps set) also keeps a small frame's float32, zlib'd
    (`f32z`: the spec derives the 8-bit forms from it, checks them against the hashes, and
    measures its ε), and a hashed frame's band at the class's ε. An exact class's float is
    checked by its hash alone (bit for bit), which keeps the file small."""
    items = []
    for i in range(t.shape[0]):
        x = t[i].contiguous()
        f32 = x.cpu().numpy().astype("<f4").tobytes()
        item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": int(x.shape[2]), "f32_sha256": sha(f32),
                "round8_sha256": sha(round8(x).tobytes()), "trunc8_sha256": sha(trunc8(x).tobytes())}
        if eps is not None and hashed:
            item["band"] = band_list(x, eps)
        elif eps is not None:
            item["f32z"] = b64(zlib.compress(f32, 9))
        items.append(item)
    return {"kind": "image", "items": items}


class ToneGroup(Group):
    """The tone group's cases: outputs as record_tone_output keeps them, the preview as a sha256."""

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            tensors[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        row["outputs"] = [record_tone_output(t, hashed, TONE_LIBRARY_EPS.get(class_type)) for t in outs]
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        self.cases.append(row)

    def solid(self, name: str, w: int, h: int, rgb: tuple) -> str:
        """A one-colour RGB picture (an asset of its own name)."""
        px = np.zeros((h, w, 3), dtype=np.uint8)
        px[:, :] = rgb
        buf = io.BytesIO()
        PILImage.fromarray(px, "RGB").save(buf, format="PNG")
        self.assets.setdefault(name, buf.getvalue())
        return name


# Colour text for parse_stops, parse_duotone and the two hex readers (R2.4 brief: malformed
# JSON, an empty list, one stop, unsorted stops, out-of-range positions, bad colours; a
# non-dict duotone; "#abc", " #a1b2c3 ", "zz0000", ""), each also run through its node.
TONE_STOPS = [
    '[{"pos":0,"color":"#06283d"},{"pos":0.5,"color":"#256d85"},{"pos":1,"color":"#47b5ff"}]',
    '[{"pos":0,"color":"#06283d"},{"pos":0.5,"color":',
    'not json', '', '[]', '{}', '"#ff0000"', '42', 'null',
    '[{"pos":0.4,"color":"#ff8800"}]',
    '[{"pos":0.9,"color":"#ffffff"},{"pos":0.1,"color":"#000000"},{"pos":0.5,"color":"#ff0000"}]',
    '[{"pos":-0.5,"color":"#00ff00"},{"pos":1.7,"color":"#0000ff"}]',
    '[{"pos":0.2,"color":"#12345"},{"pos":0.3,"color":"zzzzzz"},{"pos":0.6,"color":"#abc"},{"pos":0.8,"color":" #A1B2C3 "}]',
    '[{"pos":0.1,"color":"+f-f0f"},{"pos":0.7,"color":"#1_2_3_"},{"pos":0.75,"color":"# abc"},{"pos":0.9,"color":"##c0ffee"}]',
    '[{"pos":"0.25","color":"#102030"},{"pos":" 0.5 ","color":"#405060"},{"pos":"x","color":"#708090"},{"pos":true,"color":"#a0b0c0"}]',
    '[{"pos":null,"color":"#111111"},{"color":"#222222"},{"pos":0.5},["pos",0.5],"#333333",7,{"pos":0.6,"color":null},{"pos":0.65,"color":true},{"pos":0.7,"color":["#444444"]}]',
    '[{"pos":"nan","color":"#551100"},{"pos":"inf","color":"#005511"},{"pos":"-inf","color":"#110055"}]',
    '[{"pos":0.5,"color":"#aa0000"},{"pos":0.5,"color":"#00aa00"},{"pos":0.5,"color":"#0000aa"}]',
    '[{"pos":0.3,"color":"#303030"},{"pos":0.3,"color":"#909090"}]',
    ' [ {"pos": 1, "color": "\\t#FfF\\n"} , {"pos": 0, "color": "000"} ] ',
    '[{"pos":0,"color":"#000000"},{"pos":1e-9,"color":"#ffffff"}]',
]
TONE_DUOTONE = [
    '{"shadow":"#1a1a2e","highlight":"#f5f5f5"}', '{"shadow":"#223344"}', '{"highlight":"#aabbcc"}', '{}',
    '["#000000","#ffffff"]', '"#ff0000"', '12', 'null', 'not json', '',
    '{"shadow":"zz","highlight":"#abc"}', '{"shadow":null,"highlight":true}', '{"shadow":["#000000"],"highlight":{"a":1}}',
    '{"shadow":" #102030 ","highlight":"-1+2+3"}',
]
TONE_HEX = ["#abc", " #a1b2c3 ", "zz0000", "", "#ffe8c4", "ABC", "#12345", "#1234567", "##abcdef", "# abcdef", "+1-2+3",
            "0x0x0x", "1_2_3_", "\t#0f0f0f\n", "\x1c#abcdef", "#ab c12", "a b c"]


def tone_frame_chain(g: Group, cls, class_type: str, widgets: dict, file: str) -> dict:
    """A tone effect on a see-through card picture (4 channels) into a Frame's layer 1, as
    machinery's frame_chain: the Frame gets the effect's float tensor; its 8-bit result as
    save_live_preview writes it."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_compositor as nc
    x = load("card", file, g.assets[file])
    g.seq += 1
    node_id = f"fx{g.seq}"
    outs, _ui = run_node(cls, node_id, image=x, **widgets)
    frame = {"layer1_x": 0.0, "layer1_y": 0.0, "layer1_rotation": 10.0, "layer1_scale": 0.8, "layer1_opacity": 1.0,
             "layer1_blend": "normal", "layer1_z": 1.0, "layer1_protect": False, "layer1_cloner": "",
             "width": 0, "height": 0, "motion_params": ""}
    previews = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "frame"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        res = nc.CompositorNode.execute(layer1=outs[0], **frame)
    image = res.result[0]
    assert previews and previews[0] is image
    return {"name": f"{class_type} → Frame, card", "inputs": {"image": {"source": "card", "files": [file]}},
            "effect": {"class_type": class_type, "node_id": node_id, "widgets": widgets},
            "frame": {"widgets": frame, "w": int(image.shape[2]), "h": int(image.shape[1]), "image8": b64(trunc8(image[0]).tobytes())}}


def tone() -> dict:
    from comfy_extras import _gradient_map as gm
    from comfy_extras.nodes_glsl_unicorn import _hex_to_rgb
    g = ToneGroup()
    classes = {node_id: node_class(module, node_id) for module, node_id in TONE_CLASSES}
    for node_id, cls in classes.items():
        standard_cases(g, cls, node_id)
    rgb = g.picture(37, 23, 3, 1)
    # Every numeric widget away from its default at once (the standard set moves one at a time,
    # which leaves a sum of several settings' terms untried).
    for node_id, cls in classes.items():
        defaults, settings = widget_settings(cls)
        mixed = dict(defaults)
        for label, over in settings:
            if " between (" in label:
                mixed.update(over)
        for pname, source, file in (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", g.picture(23, 19, 4, 3))):
            g.case(f"{node_id}: every setting between, {pname}", cls, node_id, mixed, {"image": (source, [file])})
    big, big2 = g.picture(320, 200, 3, 6), g.picture(320, 200, 3, 9)
    # Contrast's mean: a long sum torch splits between threads for one picture, and sums on one
    # thread per picture in a batch of two (kernels.ts TorchLayout).
    bc = classes["AdjustBrightnessContrast"]
    g.case("AdjustBrightnessContrast: contrast 1.5, brightness 0.8, rgb 320×200", bc, "AdjustBrightnessContrast",
           {"brightness": 0.8, "contrast": 1.5}, {"image": ("rgb", [big])}, hashed=True)
    g.case("AdjustBrightnessContrast: contrast 1.5, a batch of two rgb 320×200", bc, "AdjustBrightnessContrast",
           {"brightness": 1.0, "contrast": 1.5}, {"image": ("rgb", [big, big2])}, hashed=True)
    g.case("AdjustBrightnessContrast: contrast 0.4, a batch of two files and a repeat", bc, "AdjustBrightnessContrast",
           {"brightness": 1.0, "contrast": 0.4}, {"image": ("rgb", [rgb, g.picture(37, 23, 3, 5), rgb])})
    # The colour text, through the nodes.
    stops_default = classes["AdjustGradientMap"]
    for i, s in enumerate(TONE_STOPS):
        g.case(f"AdjustGradientMap: stops {i}, rgb 37×23", stops_default, "AdjustGradientMap", {"stops": s, "mix": 0.8}, {"image": ("rgb", [rgb])})
    for i, s in enumerate(TONE_DUOTONE):
        g.case(f"Duotone: duotone {i}, rgb 37×23", classes["Duotone"], "Duotone", {"duotone": s}, {"image": ("rgb", [rgb])})
    gmap = classes["GradientMap"]
    gdef = {"dark_color": "#1a0a2e", "light_color": "#f5dbd1", "midpoint": 0.5, "contrast": 1.0, "mix": 1.0}
    light = classes["TwoDLight"]
    ldef = {"x": 0.3, "y": 0.3, "radius": 0.7, "falloff": 2.0, "color": "#ffe8c4", "intensity": 1.0, "blend": "screen"}
    for i, h in enumerate(TONE_HEX):
        g.case(f"GradientMap: dark colour {i}, rgb 37×23", gmap, "GradientMap", {**gdef, "dark_color": h}, {"image": ("rgb", [rgb])})
        g.case(f"GradientMap: light colour {i}, rgb 37×23", gmap, "GradientMap", {**gdef, "light_color": h}, {"image": ("rgb", [rgb])})
        g.case(f"TwoDLight: colour {i}, rgb 37×23", light, "TwoDLight", {**ldef, "color": h}, {"image": ("rgb", [rgb])})
    # Dither rounds below zero to −0, which torch's clamp keeps only in its scalar tails.
    black = g.solid("black_67x5.png", 67, 5, (0, 0, 0))
    g.case("Dither: black 67×5", classes["Dither"], "Dither", {"levels": 2}, {"image": ("rgb", [black])})
    dark = g.solid("dark_67x5.png", 67, 5, (3, 3, 3))
    g.case("Dither: levels 3, a batch of black and dark 67×5", classes["Dither"], "Dither", {"levels": 3}, {"image": ("rgb", [black, dark])})
    # A pow with torch's special exponents (exact) and a light over the whole range.
    g.case("AdjustCurves: midtones 0.5 (pow 2), rgb 37×23", classes["AdjustCurves"], "AdjustCurves", {"blacks": 0.1, "midtones": 0.5, "whites": 1.2}, {"image": ("rgb", [rgb])})
    g.case("TwoDLight: falloff 3, overlay, rgb 37×23", light, "TwoDLight", {**ldef, "falloff": 3.0, "blend": "overlay"}, {"image": ("rgb", [rgb])})
    # The readers on their own.
    stops = [{"raw": s, "parsed": [[p, list(c)] for p, c in gm.parse_stops(s)]} for s in TONE_STOPS]
    duo = []
    for s in TONE_DUOTONE:
        sh, hi = gm.parse_duotone(s)
        duo.append({"raw": s, "pair": [sh, hi], "rgb": [list(gm.hex_to_rgb(sh, (0.1, 0.1, 0.3))), list(gm.hex_to_rgb(hi, (1.0, 0.8, 0.4)))]})
    hexes = []
    for h in TONE_HEX:
        a = gm.hex_to_rgb(h, None)
        b = _hex_to_rgb(h, None)
        hexes.append({"text": h, "gradient_map": list(a) if a is not None else None, "unicorn": list(b) if b is not None else None})
    # Nesting (fix round 1): json.loads raises RecursionError past Python's recursion limit
    # (parse_stops / parse_duotone don't catch it); the runner reads at most 1,000 levels.
    nesting = []
    for depth in (1000, 1001, 9997, 9998):
        for kind, text in (("stops", "[" * depth + "]" * depth), ("duotone", '{"a":' * depth + "1" + "}" * depth)):
            row: dict = {"kind": kind, "depth": depth}
            try:
                if kind == "stops":
                    row["parsed"] = [[p, list(c)] for p, c in gm.parse_stops(text)]
                else:
                    row["pair"] = list(gm.parse_duotone(text))
            except RecursionError:
                row["raises"] = "RecursionError"
            nesting.append(row)
    # An exact effect on a see-through picture into a Frame (it reads the effect's float).
    balance = {"shadows_cr": 0.26, "shadows_mg": -0.4, "shadows_yb": 0.1, "midtones_cr": 0.0, "midtones_mg": 0.3,
               "midtones_yb": -0.2, "highlights_cr": -0.5, "highlights_mg": 0.0, "highlights_yb": 0.7}
    frame = tone_frame_chain(g, classes["AdjustColorBalance"], "AdjustColorBalance", balance, g.picture(23, 19, 4, 3))
    return {"cases": g.cases, "assets": {k: b64(v) for k, v in sorted(g.assets.items())},
            "library_eps": TONE_LIBRARY_EPS, "stops": stops, "duotone": duo, "hex": hexes, "nesting": nesting, "frame": frame}


# ── Group `blur` (R2.5): the blur and convolution effects ─────────────────

# (module, node_id) of the 13 classes R2.5 ports.
BLUR_CLASSES = [
    ("nodes_sharpen_noise", "Sharpen"), ("nodes_sharpen_noise", "Denoise"), ("nodes_tone_extras", "AdjustGlow"),
    ("nodes_stylize", "HighPass"), ("nodes_stylize", "Emboss"), ("nodes_stylize", "FindEdges"), ("nodes_blur", "Blur"),
    ("nodes_glsl_lens", "Bokeh"), ("nodes_glsl_lab", "TiltShift"), ("nodes_glsl_lab", "FrequencySeparation"),
    ("nodes_glsl_lab", "HeightmapRelief"), ("nodes_glsl_unicorn", "Outline"), ("nodes_glsl_unicorn", "Sparkle"),
]

# Every class is library (conv2d or a transcendental function). Each ε (255-scale; R2 rule 10: at
# most 2⁻⁸) is pinned at about 4× the worst |Δ| measured against the TypeScript port over this
# group's cases and its ε sweep (R2.5 fix round 1), Outline capped at 2⁻⁸ (2.7× its worst: a
# threshold of 0.01 divides its edge by 0.01); tests/unit/runner-effects-blur.unit.spec.ts holds the
# same table and measures it again. A hashed case's band (and a kept preview's) is recorded at it.
BLUR_LIBRARY_EPS = {
    "Sharpen": 7.3e-4,  # worst 1.82e-4
    "Denoise": 2.5e-4,  # worst 6.08e-5
    "AdjustGlow": 2.5e-4,  # worst 6.08e-5
    "HighPass": 4.3e-4,  # worst 1.06e-4
    "Emboss": 9.2e-4,  # worst 2.28e-4
    "FindEdges": 6.1e-4,  # worst 1.52e-4
    "Blur": 3.1e-4,  # worst 7.60e-5
    "Bokeh": 1.9e-4,  # worst 4.56e-5
    "TiltShift": 1.9e-4,  # worst 4.56e-5
    "FrequencySeparation": 1.9e-4,  # worst 4.56e-5
    "HeightmapRelief": 1.8e-3,  # worst 4.33e-4
    "Outline": 2.0 ** -8,  # worst 1.47e-3
    "Sparkle": 1.2e-3,  # worst 2.89e-4
}


def record_blur_preview(t: torch.Tensor, hashed: bool, eps: float) -> dict:
    """The tensor a node handed save_live_preview, when it isn't its first output's first picture
    (FrequencySeparation's high or side-by-side preview): as record_tone_output keeps a library item."""
    return record_tone_output(t[:1] if t.dim() == 4 else t[None], hashed, eps)["items"][0]


class BlurGroup(Group):
    """The blur group's cases: outputs as record_tone_output keeps a library class's, the preview
    file as a sha256 and, when it isn't output 0's first picture, its tensor too. Sparkle's topk is
    watched: where values tied at its cut, the case also records what the node makes with the lower
    index first among them (`stable`), and both kept sets."""

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        import sys
        from unittest import mock
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            tensors[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        eps = BLUR_LIBRARY_EPS[class_type]
        mod = sys.modules[cls.__module__]
        real_preview = mod.save_live_preview
        shown: list = []
        chosen: list = []
        real_topk = torch.topk

        def preview(t, *a, **k):
            shown.append(t)
            return real_preview(t, *a, **k)

        def topk(x, k, dim=-1, *a, **kw):
            r = real_topk(x, k, dim, *a, **kw)
            chosen.append((x.clone(), k, r.values.clone(), r.indices.clone()))
            return r
        try:
            with mock.patch.object(mod, "save_live_preview", preview), mock.patch.object(torch, "topk", topk):
                outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        row["outputs"] = [record_tone_output(t, hashed, eps) for t in outs]
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        if not torch.equal(shown[0][0], outs[0][0]):
            row["preview"]["tensor"] = record_blur_preview(shown[0], hashed, eps)
        if chosen:
            row["peaks"] = self.sparkle_peaks(cls, node_id, tensors, widgets, chosen[0], hashed, eps, row)
        self.cases.append(row)

    def sparkle_peaks(self, cls, node_id, tensors, widgets, chosen, hashed, eps, row) -> list:
        """Sparkle's kept peaks per picture: torch's, and the lower-index-first choice (the
        runner's) among values tied at the cut; where they differ, the node's outputs with that
        choice (`stable_outputs`)."""
        from unittest import mock
        flat, k, values, indices = chosen
        thr = torch.tensor(widgets["threshold"], dtype=flat.dtype)
        out = []
        differs = False
        for b in range(flat.shape[0]):
            got = sorted(int(i) for i, v in zip(indices[b].tolist(), values[b]) if v > thr)
            order = torch.sort(flat[b], descending=True, stable=True).indices[:k]
            stable = sorted(int(i) for i in order.tolist() if flat[b, i] > thr)
            cut = float(values[b, -1]) if k > 0 else None
            tied = int((flat[b] == values[b, -1]).sum()) if k > 0 else 0
            out.append({"torch": got, "stable": stable, "cut": cut, "tied_at_cut": tied})
            differs = differs or got != stable
        if differs:
            real_topk = torch.topk

            def stable_topk(x, k, dim=-1, *a, **kw):
                s = torch.sort(x, dim=dim, descending=True, stable=True)
                return torch.return_types.topk((s.values.narrow(dim, 0, k), s.indices.narrow(dim, 0, k)))
            with mock.patch.object(torch, "topk", stable_topk):
                outs, _ui = run_node(cls, node_id + "s", **tensors, **widgets)
            assert real_topk is torch.topk
            row["stable_outputs"] = [record_tone_output(t, hashed, eps) for t in outs]
        return out

    def dots(self, name: str, w: int, h: int, spots: list) -> str:
        """A dark RGB picture with bright one-pixel spots [(x, y, (r, g, b)), …] (an asset of its own name)."""
        px = np.full((h, w, 3), 12, dtype=np.uint8)
        for x, y, rgb in spots:
            px[y, x] = rgb
        buf = io.BytesIO()
        PILImage.fromarray(px, "RGB").save(buf, format="PNG")
        self.assets.setdefault(name, buf.getvalue())
        return name


# Blur's motion angles and lengths (R2.5 brief), and `_motion_kernel` on its own over every
# length a case reaches (a length past 8 works on a copy at 1 / int(length / 8)).
BLUR_MOTION_ANGLES = [0.0, 33.0, 90.0, 271.0]
BLUR_MOTION_LENGTHS = [1.0, 2.0, 15.0, 16.0, 80.0]
BLUR_KERNEL_ANGLES = [0.0, 33.0, 45.0, 90.0, 133.2, 180.0, 271.0, 360.0]


def blur_frame_chain(g: Group, cls, class_type: str, widgets: dict, file: str) -> dict:
    """A blur effect on a see-through card picture (4 channels) into a Frame's layer 1, as
    tone_frame_chain; the Frame's float32 is kept too (zlib), so the spec can put a band on the
    8-bit result (the effect is library)."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_compositor as nc
    x = load("card", file, g.assets[file])
    g.seq += 1
    node_id = f"fx{g.seq}"
    outs, _ui = run_node(cls, node_id, image=x, **widgets)
    frame = {"layer1_x": 0.0, "layer1_y": 0.0, "layer1_rotation": 10.0, "layer1_scale": 0.8, "layer1_opacity": 1.0,
             "layer1_blend": "normal", "layer1_z": 1.0, "layer1_protect": False, "layer1_cloner": "",
             "width": 0, "height": 0, "motion_params": ""}
    previews = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "frame"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        res = nc.CompositorNode.execute(layer1=outs[0], **frame)
    image = res.result[0]
    assert previews and previews[0] is image
    f32 = image[0].contiguous().cpu().numpy().astype("<f4").tobytes()
    return {"name": f"{class_type} → Frame, card", "inputs": {"image": {"source": "card", "files": [file]}},
            "effect": {"class_type": class_type, "node_id": node_id, "widgets": widgets},
            "frame": {"widgets": frame, "w": int(image.shape[2]), "h": int(image.shape[1]), "c": int(image.shape[3]),
                      "image8": b64(trunc8(image[0]).tobytes()), "f32z": b64(zlib.compress(f32, 9))}}


# ── The ε sweep (R2.5 fix rounds 1 and 2) ───────────────────────────────────
#
# `--group blur --sweep` runs the whole sweep, hands it to the spec (BLUR_SWEEP_FILE, a file in
# this run's temp directory) and prints each class's worst |Δ|: it writes nothing into the repo.
# The committed fixture keeps only its probes (BLUR_PROBES: each class's worst case, and a slice
# of the reviewer's cases). server/runner/effects/core/blur.ts records the sweep's result.
#
# Each class's ε is pinned at about 4× the worst |Δ| measured over a broad set of inputs the
# standard set doesn't reach: BLUR_SWEEP_SEEDS seeds per class, each a picture of its own
# (`sweep_pixels`: a textured, smooth or dotted field, 3 or 4 channels, sometimes a batch of two,
# sized so the drawn settings fit it) with every widget drawn over its range (its max one time in
# four, its min one in ten); and the R2.5 reviewer's probe cases (/private/tmp/r25probe/gen.py:
# the same pictures from the same seed, the same settings), whose worst differences were above the
# fixture's. Inputs reach the node as u8 / 255 in float32 (no loader). A seed's pictures are
# rebuilt by the spec from integer arithmetic (their sha256 recorded); a review case's are kept
# (zlib). Each output keeps its float32 over a window of at most BLUR_SWEEP_WINDOW² pixels (a
# corner, the far corner or the middle, by seed), byte-shuffled and zlib'd (`f32s`).

BLUR_SWEEP_SEEDS = 24
BLUR_SWEEP_SIZES = [(41, 29), (37, 31), (29, 37), (48, 36), (53, 41), (36, 48), (61, 45)]
BLUR_SWEEP_WINDOW = 32


def shuffled_f32(t: torch.Tensor) -> str:
    """A tensor's float32 (H × W × C, little-endian) byte-shuffled (every value's byte 0, then byte 1…)
    and zlib'd, base64: neighbouring floats share their high bytes, which packs about twice as small."""
    b = np.frombuffer(t.contiguous().cpu().numpy().astype("<f4").tobytes(), dtype=np.uint8).reshape(-1, 4)
    return b64(zlib.compress(b.T.copy().tobytes(), 9))


def sweep_pixels(w: int, h: int, c: int, seed: int, kind: str) -> np.ndarray:
    """An 8-bit H × W × C field from integers alone (the spec rebuilds it): `tex` a triangle-wave
    gradient with a step edge and xorshift noise; `smooth` the gradient alone; `dots` dark noise
    with up to 40 bright spots of distinct levels."""
    s = (seed & 0xFFFFFFFF) or 0x9E3779B9

    def nxt() -> int:
        nonlocal s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        return s

    def tri(t: int) -> int:
        t %= 512
        return t if t < 256 else 511 - t
    a = 1 + (seed % 7) * 3
    b = 5 + (seed % 11) * 2
    edge = w * (3 + seed % 5) // 10
    out = np.zeros((h, w, c), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            for k in range(c):
                if kind == "dots":
                    v = 12 + (nxt() & 15)
                elif kind == "smooth":
                    v = tri(x * a + y * b + k * 40)
                else:
                    v = tri(x * a * 3 + y * b + k * 71) ^ (nxt() & 31)
                    if x > edge:
                        v = min(255, v + 60)
                out[y, x, k] = v
    if kind == "dots":
        for j in range(min(40, w * h)):
            p = nxt() % (w * h)
            out[p // w, p % w, :] = min(255, 128 + 3 * j)
    return out


def sweep_need(class_type: str, w: dict) -> int:
    """The smallest side the drawn settings work on (a reflect pad under the side, of the copy
    a blur past its threshold works on)."""
    ceil = math.ceil

    def scaled(radius: float, step: float, pad_of) -> int:
        scale = max(1, int(radius / step))
        return (pad_of(radius / scale) + 1) * scale
    if class_type in ("Sharpen", "HighPass", "FrequencySeparation"):
        return ceil(3.0 * w["radius"]) + 1
    if class_type == "Denoise":
        return ceil(3.0 * w["strength"]) + 1
    if class_type == "AdjustGlow":
        return scaled(w["radius"], 4, lambda sg: ceil(3.0 * sg)) if w["radius"] > 0 else 2
    if class_type == "TiltShift":
        return scaled(w["blur"], 4, lambda sg: ceil(3.0 * sg))
    if class_type == "Blur":
        if w["type"] == "gaussian" and w["radius"] > 0:
            return scaled(w["radius"], 4, lambda sg: ceil(3.0 * sg))
        if w["type"] == "motion" and w["length"] > 0:
            length = int(round(w["length"]))
            scale = max(1, int(length / 8))
            line = max(2, int(round(length / scale))) if scale > 1 else length
            return ((line if line % 2 else line + 1) // 2 + 1) * scale
        return 2
    if class_type == "Bokeh":
        return scaled(w["radius"], 5, lambda r: ceil(r)) if w["radius"] > 0 else 2
    return 2


def sweep_window(rs: np.random.Generator, w: int, h: int) -> list:
    ww, wh = min(BLUR_SWEEP_WINDOW, w), min(BLUR_SWEEP_WINDOW, h)
    where = int(rs.integers(3))
    x0, y0 = ((0, 0), (w - ww, h - wh), ((w - ww) // 2, (h - wh) // 2))[where]
    return [int(x0), int(y0), int(ww), int(wh)]


class BlurSweep:
    """The sweep's cases: each run on the real node (Sparkle's topk watched as the group does:
    where torch kept other values tied at its cut, the outputs are the node's with the lower
    index first, `stable`)."""

    def __init__(self, keep=None) -> None:
        self.cases: list[dict] = []
        # Which cases to run and keep (by name); None: all of them.
        self.keep = keep

    def case(self, name: str, cls, class_type: str, widgets: dict, u8s: list, window: list, gen: dict | None) -> None:
        from unittest import mock
        if self.keep is not None and not self.keep(name):
            return
        row: dict = {"name": name, "class_type": class_type, "widgets": widgets, "window": window}
        if gen is not None:
            row["gen"] = gen
            row["inputs"] = [{"w": int(u.shape[1]), "h": int(u.shape[0]), "c": int(u.shape[2]), "sha256": sha(np.ascontiguousarray(u).tobytes())} for u in u8s]
        else:
            row["inputs"] = [{"w": int(u.shape[1]), "h": int(u.shape[0]), "c": int(u.shape[2]), "u8z": b64(zlib.compress(np.ascontiguousarray(u).tobytes(), 9))} for u in u8s]
        x = torch.stack([torch.from_numpy(u.astype(np.float32) / np.float32(255.0)) for u in u8s])
        chosen: list = []
        real_topk = torch.topk

        def topk(t, k, dim=-1, *a, **kw):
            r = real_topk(t, k, dim, *a, **kw)
            chosen.append((t.clone(), k, r.values.clone(), r.indices.clone()))
            return r
        try:
            with mock.patch.object(torch, "topk", topk):
                outs, _ui = run_node(cls, "sweep", image=x, **widgets)
        except Exception as e:  # noqa: BLE001 — Python raises: the spec maps it to the runner's message
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        if chosen:
            flat, k, values, indices = chosen[0]
            thr = torch.tensor(widgets["threshold"], dtype=flat.dtype)
            differs = False
            for b in range(flat.shape[0]):
                got = sorted(int(i) for i, v in zip(indices[b].tolist(), values[b]) if v > thr)
                order = torch.sort(flat[b], descending=True, stable=True).indices[:k]
                differs = differs or got != sorted(int(i) for i in order.tolist() if flat[b, i] > thr)
            if differs:
                def stable_topk(t, k, dim=-1, *a, **kw):
                    srt = torch.sort(t, dim=dim, descending=True, stable=True)
                    return torch.return_types.topk((srt.values.narrow(dim, 0, k), srt.indices.narrow(dim, 0, k)))
                with mock.patch.object(torch, "topk", stable_topk):
                    outs, _ui = run_node(cls, "sweep", image=x, **widgets)
                row["stable"] = True
        x0, y0, ww, wh = window
        row["outputs"] = [[{"w": int(o.shape[2]), "h": int(o.shape[1]), "c": int(o.shape[3]), "f32s": shuffled_f32(o[i, y0:y0 + wh, x0:x0 + ww, :])}
                           for i in range(o.shape[0])] for o in outs]
        self.cases.append(row)


def sweep_widgets(rs: np.random.Generator, cls, class_type: str) -> dict:
    """Every widget drawn over its range: its max one time in four, its min one in ten, else between."""
    types = cls.INPUT_TYPES()
    out: dict = {}
    for section in ("required", "optional"):
        for name, spec in (types.get(section) or {}).items():
            kind, info = spec[0], (spec[1] if len(spec) > 1 else {})
            if kind in ("FLOAT", "INT"):
                lo, hi = info["min"], info["max"]
                u = rs.random()
                v = hi if u < 0.25 else lo if u < 0.35 else lo + (hi - lo) * rs.random()
                out[name] = int(round(v)) if kind == "INT" else float(round(v, 2))
            elif kind == "COMBO":
                opts = info.get("options", [])
                out[name] = opts[int(rs.integers(len(opts)))]
            elif kind == "BOOLEAN":
                out[name] = bool(rs.integers(2))
            elif kind == "STRING":
                out[name] = info.get("default", "")
    if class_type == "Outline":
        out["line_color"] = ["#3a7fc2", "f0e", "#000000", " #ffe8c4 "][int(rs.integers(4))]
        out["fill_color"] = ["#ffffff", "#102030", "abc"][int(rs.integers(3))]
    return out


def blur_sweep(classes: dict, keep=None) -> list:
    sw = BlurSweep(keep)
    for ci, (node_id, cls) in enumerate(classes.items()):
        for seed in range(BLUR_SWEEP_SEEDS):
            if keep is not None and not any(n.startswith(f"{node_id}: sweep seed {seed},") for n in BLUR_WORST_SEEDS):
                continue
            rs = np.random.default_rng(900_000 + 1000 * ci + seed)
            widgets = sweep_widgets(rs, cls, node_id)
            need = sweep_need(node_id, widgets)
            bw, bh = BLUR_SWEEP_SIZES[int(rs.integers(len(BLUR_SWEEP_SIZES)))]
            w, h = max(bw, need + int(rs.integers(0, 12))), max(bh, need + int(rs.integers(0, 12)))
            c = 3 if node_id == "Outline" else int(rs.choice([3, 4]))
            kind = str(rs.choice(["dots", "tex"] if node_id == "Sparkle" else ["tex", "tex", "smooth", "dots"]))
            n = 2 if rs.random() < 0.2 else 1
            base = int(rs.integers(1, 2 ** 31))
            gens = [base + i for i in range(n)]
            pics = [sweep_pixels(w, h, c, g, kind) for g in gens]
            sw.case(f"{node_id}: sweep seed {seed}, {kind} {w}×{h}×{c}{' ×2' if n == 2 else ''}", cls, node_id, widgets, pics,
                    sweep_window(rs, w, h), {"seeds": gens, "kind": kind})
    review_cases(sw, classes)
    return sw.cases


# Each class's worst case in the full sweep (R2.5 fix round 1, `--sweep`): kept in the fixture.
BLUR_WORST_SEEDS = [
    "Sharpen: sweep seed 14,", "Denoise: sweep seed 2,", "AdjustGlow: sweep seed 18,", "HighPass: sweep seed 13,",
    "Emboss: sweep seed 23,", "FindEdges: sweep seed 4,", "Bokeh: sweep seed 20,", "TiltShift: sweep seed 10,",
    "FrequencySeparation: sweep seed 3,", "HeightmapRelief: sweep seed 3,", "Outline: sweep seed 11,", "Sparkle: sweep seed 20,",
]


def blur_probe(name: str) -> bool:
    """The fixture's probes: each class's worst seed; of the reviewer's cases every one but the 45-case
    motion grid (its 271° row kept), Outline's 15-case grid (solid at each thickness, and every fill
    at 2.5 kept) and the 97 × 83 ones (Blur's worst, 'BIG blur g r17.5', kept)."""
    if any(name.startswith(w) for w in BLUR_WORST_SEEDS):
        return True
    if ": review " not in name:
        return False
    what = name.split(": review ", 1)[1]
    if what.startswith("BIG"):
        return what == "BIG blur g r17.5"
    if what.startswith("motion a"):
        return what.startswith("motion a271.0 ")
    if what.startswith("outline t"):
        return what.endswith(" solid") or what.startswith("outline t2.5 ")
    return True


def review_cases(sw: BlurSweep, classes: dict) -> None:
    """The R2.5 reviewer's probe cases (/private/tmp/r25probe/gen.py), rebuilt: the same pictures
    from the same generator and seed, in the same order, and the same settings."""
    rng = np.random.default_rng(7351)

    def pic(w, h, c, kind="tex"):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
        a = np.zeros((h, w, c))
        for ch in range(c):
            base = 0.5 + 0.35 * np.sin(xx * (0.21 + 0.07 * ch) + yy * 0.13 * (ch + 1)) * np.cos(yy * 0.09 - xx * 0.05 * ch)
            base += (xx > w * 0.6) * 0.25 - (yy < h * 0.3) * 0.2
            base += rng.normal(0, 0.06, (h, w))
            a[..., ch] = base
        if kind == "dots":
            a[...] = 0.05 + rng.random((h, w, c)) * 0.1
            pts = rng.choice(h * w, size=40, replace=False)
            for j, p in enumerate(pts):
                y, x = divmod(int(p), w)
                a[y, x, :] = 0.5 + j * 0.012
        return np.clip(np.rint(np.clip(a, 0, 1) * 255), 0, 255).astype(np.uint8)

    wrs = np.random.default_rng(7352)

    def case(name, cls_name, widgets, imgs):
        imgs = imgs if isinstance(imgs, list) else [imgs]
        h, w = imgs[0].shape[:2]
        sw.case(f"{cls_name}: review {name}", classes[cls_name], cls_name, widgets, imgs, sweep_window(wrs, w, h), None)

    def blurw(**k):
        return {"type": "gaussian", "radius": 0.0, "angle": 0.0, "length": 0.0, "strength": 0.0, **k}
    A = pic(41, 29, 3); B = pic(37, 31, 4); C = pic(41, 29, 3); _D = pic(64, 48, 3); _D2 = pic(64, 48, 3)
    S5 = pic(5, 4, 3); S9 = pic(9, 9, 4); S20 = pic(20, 14, 3); ONE5 = pic(5, 1, 3); TWO = pic(2, 2, 4)
    case("sharpen a", "Sharpen", {"amount": 2.35, "radius": 3.7}, A)
    case("sharpen 4ch max", "Sharpen", {"amount": 4.0, "radius": 0.3}, B)
    case("sharpen r10", "Sharpen", {"amount": 1.15, "radius": 10.0}, B)
    case("denoise 4ch", "Denoise", {"strength": 2.2}, B)
    case("denoise max", "Denoise", {"strength": 5.0}, pic(29, 37, 3))
    case("denoise small", "Denoise", {"strength": 5.0}, S20)
    for r in (3.5, 4.0, 7.9, 8.0, 23.5):
        case(f"glow r{r} 4ch", "AdjustGlow", {"threshold": 0.4, "intensity": 1.3, "radius": r}, B)
    case("glow batch r12.5", "AdjustGlow", {"threshold": 0.33, "intensity": 0.85, "radius": 12.5}, [A, C])
    case("glow area 0", "AdjustGlow", {"threshold": 0.1, "intensity": 1.0, "radius": 50.0}, S5)
    case("glow small pad", "AdjustGlow", {"threshold": 0.1, "intensity": 1.0, "radius": 8.0}, S9)
    case("highpass 4ch", "HighPass", {"radius": 7.5}, B)
    case("highpass small", "HighPass", {"radius": 30.0}, A)
    case("emboss 2.65", "Emboss", {"depth": 2.65}, B)
    case("emboss .35", "Emboss", {"depth": 0.35}, A)
    case("emboss 2x2", "Emboss", {"depth": 1.7}, TWO)
    case("emboss 1-row", "Emboss", {"depth": 1.0}, ONE5)
    case("findedges 4ch inv", "FindEdges", {"intensity": 2.7, "invert": True}, B)
    case("findedges 3ch", "FindEdges", {"intensity": 0.65, "invert": False}, A)
    for r in (3.5, 4.0, 7.9, 8.0, 17.5):
        case(f"blur g r{r}", "Blur", blurw(radius=r), B)
    case("blur g batch 11", "Blur", blurw(radius=11.0), [A, C])
    case("blur g small", "Blur", blurw(radius=50.0), A)
    for ang in (17.0, 123.5, 200.0, 333.0, 271.0):
        for L in (0.4, 2.5, 3.0, 7.0, 9.0, 23.0, 47.0, 64.0, 79.0):
            case(f"motion a{ang} L{L}", "Blur", blurw(type="motion", angle=ang, length=L), B if L in (9.0, 47.0) else A)
    case("motion batch", "Blur", blurw(type="motion", angle=58.0, length=31.0), [A, C])
    case("motion small", "Blur", blurw(type="motion", angle=58.0, length=13.0), S5)
    for s in (0.23, 0.77, 1.0, 0.01):
        case(f"zoom {s}", "Blur", blurw(type="zoom", strength=s), B)
    case("zoom batch", "Blur", blurw(type="zoom", strength=0.61), [A, C])
    for r, bo in ((3.5, 2.35), (4.9, 1.0), (5.0, 4.0), (7.5, 1.7), (9.5, 1.5), (12.5, 2.0), (30.0, 3.1)):
        case(f"bokeh r{r} b{bo}", "Bokeh", {"radius": r, "highlight_boost": bo}, B if r != 30.0 else pic(97, 83, 4))
    case("bokeh batch", "Bokeh", {"radius": 11.0, "highlight_boost": 1.9}, [A, C])
    case("bokeh small", "Bokeh", {"radius": 9.5, "highlight_boost": 1.5}, S9)
    case("tilt a", "TiltShift", {"position": 0.31, "width": 0.47, "blur": 13.5}, B)
    case("tilt 1", "TiltShift", {"position": 0.93, "width": 0.02, "blur": 1.0}, A)
    case("tilt batch", "TiltShift", {"position": 0.5, "width": 0.2, "blur": 7.5}, [A, C])
    case("tilt small", "TiltShift", {"position": 0.5, "width": 0.2, "blur": 40.0}, S20)
    for sh in ("low", "high", "combined"):
        case(f"freq {sh}", "FrequencySeparation", {"radius": 2.5, "show": sh}, B)
    case("relief keep 4ch", "HeightmapRelief", {"angle": 211.0, "elevation": 0.07, "depth": 9.3, "ambient": 0.13, "keep_color": True}, B)
    case("relief gray", "HeightmapRelief", {"angle": 17.0, "elevation": 0.93, "depth": 0.4, "ambient": 0.71, "keep_color": False}, A)
    case("relief 1-row", "HeightmapRelief", {"angle": 17.0, "elevation": 0.5, "depth": 1.0, "ambient": 0.3, "keep_color": False}, ONE5)
    for th in (0.5, 1.5, 2.5, 3.4, 4.0):
        for mode in ("solid", "source", "transparent_black"):
            case(f"outline t{th} {mode}", "Outline", {"thickness": th, "threshold": 0.07 if th < 2 else 0.6, "line_color": "#3a7fc2",
                                                      "fill_color": "f0e", "fill_mode": mode, "mix": 0.63}, A)
    case("outline batch", "Outline", {"thickness": 2.0, "threshold": 0.2, "line_color": "#ff8800", "fill_color": "#102030", "fill_mode": "solid", "mix": 1.0}, [A, C])
    case("outline 4ch", "Outline", {"thickness": 1.0, "threshold": 0.15, "line_color": "#000000", "fill_color": "#ffffff", "fill_mode": "source", "mix": 1.0}, B)
    DOTS = pic(64, 48, 3, "dots"); DOTS2 = pic(64, 48, 3, "dots"); DOTS4 = pic(64, 48, 4, "dots")
    case("sparkle maxn untied", "Sparkle", {"threshold": 0.3, "size": 11.0, "intensity": 1.7, "points": 5, "angle": -37.0, "max_density": 0.002}, DOTS)
    case("sparkle maxn ks161", "Sparkle", {"threshold": 0.3, "size": 80.0, "intensity": 0.6, "points": 8, "angle": 123.0, "max_density": 0.0015}, DOTS)
    case("sparkle 4ch batch", "Sparkle", {"threshold": 0.45, "size": 3.0, "intensity": 3.9, "points": 3, "angle": 11.0, "max_density": 0.004}, [DOTS4, pic(64, 48, 4, "dots")])
    case("sparkle batch", "Sparkle", {"threshold": 0.3, "size": 6.0, "intensity": 1.0, "points": 4, "angle": 0.0, "max_density": 0.0025}, [DOTS, DOTS2])
    case("sparkle tex", "Sparkle", {"threshold": 0.7, "size": 9.0, "intensity": 2.0, "points": 6, "angle": 45.0, "max_density": 0.05}, _D)
    L1 = pic(97, 83, 4); L2 = pic(97, 83, 3); L3 = pic(97, 83, 3)
    case("BIG glow r23.5 4ch", "AdjustGlow", {"threshold": 0.4, "intensity": 1.3, "radius": 23.5}, L1)
    case("BIG glow batch r12.5", "AdjustGlow", {"threshold": 0.33, "intensity": 0.85, "radius": 12.5}, [L2, L3])
    case("BIG blur g r17.5", "Blur", blurw(radius=17.5), L1)
    case("BIG blur g batch 11", "Blur", blurw(radius=11.0), [L2, L3])
    for ang in (17.0, 271.0, 333.0):
        for L in (64.0, 79.0, 16.0, 80.0):
            case(f"BIG motion a{ang} L{L}", "Blur", blurw(type="motion", angle=ang, length=L), L1)
    case("BIG motion batch", "Blur", blurw(type="motion", angle=99.5, length=41.0), [L2, L3])
    case("BIG tilt a", "TiltShift", {"position": 0.31, "width": 0.47, "blur": 13.5}, L1)
    case("BIG tilt batch 40", "TiltShift", {"position": 0.62, "width": 0.11, "blur": 40.0}, [L2, L3])
    case("BIG zoom batch", "Blur", blurw(type="zoom", strength=0.93), [L2, L3])
    case("BIG bokeh batch 23", "Bokeh", {"radius": 23.0, "highlight_boost": 2.7}, [L2, L3])


def blur() -> dict:
    import comfy_extras.nodes_blur as nb
    g = BlurGroup()
    classes = {node_id: node_class(module, node_id) for module, node_id in BLUR_CLASSES}
    for node_id, cls in classes.items():
        standard_cases(g, cls, node_id)
    rgb, card4, card3, prov = g.picture(37, 23, 3, 1), g.picture(23, 19, 4, 3), g.picture(23, 19, 3, 4), g.picture(29, 31, 4, 2)
    mid = g.picture(80, 60, 3, 11)
    tiny = g.picture(5, 4, 4, 8)
    four = (("rgb 37×23", "rgb", rgb), ("provider 29×31", "provider", prov), ("card 23×19 see-through", "card", card4), ("card 23×19 opaque", "card", card3))
    defaults = {node_id: widget_settings(cls)[0] for node_id, cls in classes.items()}

    def run(cls_name: str, label: str, over: dict, pics, hashed: bool = False) -> None:
        for pname, source, file in pics:
            g.case(f"{cls_name}: {label}, {pname}", classes[cls_name], cls_name, {**defaults[cls_name], **over}, {"image": (source, [file])}, hashed=hashed)

    # Every numeric widget "between" at once (the standard set moves one at a time).
    for node_id, cls in classes.items():
        _d, settings = widget_settings(cls)
        mixed = dict(defaults[node_id])
        for label, over in settings:
            if " between (" in label:
                mixed.update(over)
        run(node_id, "every setting between", {k: v for k, v in mixed.items() if k not in defaults[node_id] or v != defaults[node_id][k]},
            (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4)))
    # Radii at the downsampling thresholds, on a picture large enough for the small copy's blur.
    at80 = (("rgb 80×60", "rgb", mid), ("rgb 37×23", "rgb", rgb))
    for r in (3.5, 4.0, 7.9, 8.0):
        run("AdjustGlow", f"radius {r}", {"radius": r}, at80)
        run("Blur", f"gaussian radius {r}", {"type": "gaussian", "radius": r}, at80)
        run("TiltShift", f"blur {r}", {"blur": r}, at80)
    for r in (4.9, 5.0, 10.0):
        run("Bokeh", f"radius {r}", {"radius": r}, at80)
    # Blur by each type on the standard pictures (its defaults blur nothing).
    for over in ({"type": "gaussian", "radius": 2.5}, {"type": "gaussian", "radius": 12.0}, {"type": "motion", "length": 9.0, "angle": 33.0},
                 {"type": "motion", "length": 2.5, "angle": 120.0}, {"type": "motion", "length": 0.5, "angle": 10.0},
                 {"type": "zoom", "strength": 0.01}, {"type": "zoom", "strength": 0.37}, {"type": "zoom", "strength": 1.0}):
        run("Blur", ", ".join(f"{k} {v}" for k, v in over.items()), over, four)
    # Motion at four angles and five lengths.
    for a in BLUR_MOTION_ANGLES:
        for length in BLUR_MOTION_LENGTHS:
            run("Blur", f"motion angle {a} length {length}", {"type": "motion", "angle": a, "length": length}, (("rgb 80×60", "rgb", mid),))
    # The largest radii on pictures too small for their padding, and an area resize down to nothing.
    run("HighPass", "radius 30 (too wide)", {"radius": 30.0}, (("rgb 37×23", "rgb", rgb),))
    run("FrequencySeparation", "radius 30 (too wide)", {"radius": 30.0}, (("rgb 37×23", "rgb", rgb),))
    for pics in ((("provider 5×4", "provider", tiny),), (("rgb 37×23", "rgb", rgb),)):
        run("AdjustGlow", "radius 50", {"radius": 50.0}, pics)
        run("Blur", "gaussian radius 50", {"type": "gaussian", "radius": 50.0}, pics)
        run("Blur", "motion length 80", {"type": "motion", "length": 80.0, "angle": 45.0}, pics)
        run("Bokeh", "radius 30", {"radius": 30.0}, pics)
        run("TiltShift", "blur 40", {"blur": 40.0}, pics)
    # Outline at each rounding of its thickness.
    for t in (1.5, 2.5, 3.5):
        run("Outline", f"thickness {t}", {"thickness": t}, (("rgb 37×23", "rgb", rgb),))
    for mode in ("solid", "source", "transparent_black"):
        run("Outline", f"fill {mode}, colours", {"fill_mode": mode, "line_color": "#3a7", "fill_color": " #102030 ", "mix": 0.63}, (("rgb 37×23", "rgb", rgb),))
    # Sparkle: more peaks than it keeps; tied lumas at the cut; distinct ones.
    spots = [(3 + 10 * (i % 6), 3 + 10 * (i // 6), (255, 255, 255)) for i in range(18)]
    tied = g.dots("dots_tied_64x48.png", 64, 48, spots)
    graded = g.dots("dots_graded_64x48.png", 64, 48, [(x, y, (250 - 5 * i, 250 - 5 * i, 250 - 5 * i)) for i, (x, y, _c) in enumerate(spots)])
    mixed_spots = [(x, y, (255, 255, 255) if i % 3 else (240, 240, 240)) for i, (x, y, _c) in enumerate(spots)]
    mixed = g.dots("dots_mixed_64x48.png", 64, 48, mixed_spots)
    for density in (0.0001, 0.0017, 0.004, 0.05):
        for pname, file in (("tied dots 64×48", tied), ("graded dots 64×48", graded), ("mixed dots 64×48", mixed)):
            g.case(f"Sparkle: max_density {density}, {pname}", classes["Sparkle"], "Sparkle",
                   {**defaults["Sparkle"], "max_density": density, "threshold": 0.5, "size": 6.0}, {"image": ("rgb", [file])})
    # Below torch's large-input path, its topk keeps its own choice among tied values.
    small_tied = g.dots("dots_tied_40x30.png", 40, 30, [(3 + 10 * (i % 4), 3 + 10 * (i // 4), (255, 255, 255)) for i in range(12)])
    block = g.dots("block_40x30.png", 40, 30, [(x, y, (255, 255, 255)) for y in range(5, 15) for x in range(5, 15)])
    # Outline's dilation on sparse edges (the synthetic texture has edges everywhere, which the
    # max-pool saturates): each rounding of the thickness, on the block and the dots.
    for t in (1.5, 2.5, 3.5, 4.0):
        for pname, file in (("a white block 40×30", block), ("graded dots 64×48", graded)):
            g.case(f"Outline: thickness {t}, {pname}", classes["Outline"], "Outline", {**defaults["Outline"], "thickness": t}, {"image": ("rgb", [file])})
    for density in (0.003, 0.03, 0.05):
        g.case(f"Sparkle: max_density {density}, a white block 40×30 (100 tied peaks)", classes["Sparkle"], "Sparkle",
               {**defaults["Sparkle"], "max_density": density, "threshold": 0.5, "size": 6.0}, {"image": ("rgb", [block])})
    for density in (0.0017, 0.004, 0.006):
        g.case(f"Sparkle: max_density {density}, tied dots 40×30", classes["Sparkle"], "Sparkle",
               {**defaults["Sparkle"], "max_density": density, "threshold": 0.5, "size": 6.0}, {"image": ("rgb", [small_tied])})
    g.case("Sparkle: max_density 0.0017, a batch of tied and graded dots", classes["Sparkle"], "Sparkle",
           {**defaults["Sparkle"], "max_density": 0.0017, "threshold": 0.5, "size": 6.0}, {"image": ("rgb", [tied, graded, tied])})
    run("Sparkle", "threshold 0.3, max_density 0.0001", {"threshold": 0.3, "max_density": 0.0001}, four)
    # The large cases (hashed): each class's defaults are the standard set's; here the blurs that
    # otherwise stay small.
    big = (("rgb 320×200", "rgb", g.picture(320, 200, 3, 6)),)
    run("Blur", "gaussian radius 10", {"type": "gaussian", "radius": 10.0}, big, hashed=True)
    run("Blur", "motion length 16, angle 33", {"type": "motion", "length": 16.0, "angle": 33.0}, big, hashed=True)
    run("Blur", "zoom 0.5", {"type": "zoom", "strength": 0.5}, big, hashed=True)
    run("HighPass", "radius 30", {"radius": 30.0}, big, hashed=True)
    run("Sparkle", "threshold 0.5, size 80", {"threshold": 0.5, "size": 80.0}, big, hashed=True)
    run("FrequencySeparation", "show high", {"show": "high"}, big, hashed=True)
    # `_motion_kernel` on its own.
    kernels = []
    for length in range(0, 21):
        for a in BLUR_KERNEL_ANGLES:
            kk = nb._motion_kernel(length, a).reshape(-1).contiguous()
            kernels.append({"length": length, "angle": a, "side": int(round(kk.numel() ** 0.5)), "f32": b64(kk.numpy().astype("<f4").tobytes())})
    frame = blur_frame_chain(g, classes["Sharpen"], "Sharpen", {"amount": 1.3, "radius": 1.5}, card4)
    # A small output's float is kept once, by the sha256 of its bytes (many settings leave the
    # picture as it was, or make the same picture): `floats`, and the item keeps its sha256.
    floats: dict = {}
    for c in g.cases:
        items = [it for key in ("outputs", "stable_outputs") for o in c.get(key) or [] for it in o["items"]]
        if c.get("preview", {}).get("tensor"):
            items.append(c["preview"]["tensor"])
        for it in items:
            if "f32z" in it:
                floats[it["f32_sha256"]] = it.pop("f32z")
    return {"cases": g.cases, "floats": floats, "assets": {k: b64(v) for k, v in sorted(g.assets.items())},
            "library_eps": BLUR_LIBRARY_EPS, "motion_kernels": kernels, "frame": frame, "probes": blur_sweep(classes, blur_probe)}


# ── Group `cells` (R2.6): cells and glyphs ───────────────────────────────

# (module, node_id) of the 4 classes R2.6 ports. Every one is exact.
CELLS_CLASSES = [
    ("nodes_stylize", "Pixelate"), ("nodes_glsl_lens", "Halftone"),
    ("nodes_glsl_stylize", "Kuwahara"), ("nodes_glsl_stylize", "Ascii"),
]

# The Ascii glyph atlas (controller ruling (d)): rendered with DejaVu Sans Mono (a free licence;
# Menlo is Apple's and can't be shipped), for the atlas AND every Ascii case, by pointing the
# node module's _FONT_PATHS at this file for the whole run (the engine itself is not edited).
# A hosted ComfyUI with another FreeType could rasterise slightly differently: the shipped atlas
# is the reference.
CELLS_FONT = os.path.join(ROOT, ".venv", "lib", "python3.12", "site-packages", "matplotlib", "mpl-data", "fonts", "ttf", "DejaVuSansMono.ttf")
ASCII_ATLAS = os.path.join(ROOT, "frontend", "server", "runner", "effects", "asciiGlyphs.bin")
ASCII_GLYPH_SET = os.path.join(ROOT, "frontend", "shared", "runner", "asciiGlyphSet.generated.ts")
ASCII_CELLS = (4, 64)


def cells_use_dejavu() -> None:
    import comfy_extras.nodes_glsl_stylize as st
    assert os.path.isfile(CELLS_FONT), CELLS_FONT
    st._FONT_PATHS = [CELLS_FONT]
    st._ascii_bitmap_cache.clear()
    assert getattr(st._load_mono_font(20), "path", None) == CELLS_FONT


def ascii_characters() -> str:
    """The atlas's characters: the union of the eight presets and printable ASCII 32–126, by code point."""
    import comfy_extras.nodes_glsl_stylize as st
    chars = set(chr(o) for o in range(32, 127))
    for ramp in st._ASCII_PRESETS.values():
        chars.update(ramp)
    chars.update(st._ASCII_DEFAULT)
    return "".join(sorted(chars))


def ascii_atlas() -> dict:
    """Renders every (cell, character) with the node's own _ascii_bitmaps (each character alone, as
    it renders them) and writes asciiGlyphs.bin: gzip (level 9, no mtime) of 'SAG1', a u32 LE index
    length, the index (JSON), then for each cell 4–64 and each character in order its cell × cell
    uint8 bitmap (np.array of the Lanczos-shrunk render: the float the node uses is u / 255). Also
    writes the character list the eligibility check reads, with the node's preset ramps and default
    (asciiGlyphSet.generated.ts)."""
    import gzip
    import struct
    import PIL
    from PIL import features
    import comfy_extras.nodes_glsl_stylize as st
    chars = ascii_characters()
    with open(CELLS_FONT, "rb") as fh:
        font_sha = sha(fh.read())
    index = {
        "format": "SAG1: per cell (cell_min…cell_max), per character (in `characters` order), cell × cell uint8, row-major",
        "characters": chars, "cell_min": ASCII_CELLS[0], "cell_max": ASCII_CELLS[1],
        "font": os.path.basename(CELLS_FONT), "font_sha256": font_sha,
        "pillow": PIL.__version__, "freetype": features.version("freetype2"),
        "note": "Written by scripts/runner_effects_fixtures.py --group cells with the Ascii node's own _ascii_bitmaps. Do not edit.",
    }
    data = bytearray()
    per_cell = []
    for cell in range(ASCII_CELLS[0], ASCII_CELLS[1] + 1):
        st._ascii_bitmap_cache.clear()
        b = st._ascii_bitmaps(cell, chars, "cpu", torch.float32)
        u8 = torch.round(b * 255.0).to(torch.uint8)
        assert torch.equal(u8.float() / 255.0, b), cell
        data += u8.numpy().tobytes()
        per_cell.append({"cell": cell, "f32_sha256": sha(b.contiguous().numpy().astype("<f4").tobytes())})
    st._ascii_bitmap_cache.clear()
    head = json.dumps(index, sort_keys=True, ensure_ascii=True).encode("ascii")
    raw = b"SAG1" + struct.pack("<I", len(head)) + head + bytes(data)
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    with open(ASCII_ATLAS, "wb") as fh:
        fh.write(packed)
    ts = (
        "// Written by scripts/runner_effects_fixtures.py --group cells. Do not edit.\n"
        "/**\n"
        " * The characters the Ascii glyph atlas holds (server/runner/effects/asciiGlyphs.bin, step 3 R2.6):\n"
        " * the union of the node's eight presets and printable ASCII 32–126, by code point. A custom\n"
        " * `characters` ramp with any other character leaves the node to the engine.\n"
        " */\n"
        f"export const ASCII_GLYPH_CHARACTERS = {json.dumps(chars, ensure_ascii=True)}\n"
        "\n"
        "/** The node's preset ramps (nodes_glsl_stylize.py _ASCII_PRESETS), light to dark. */\n"
        f"export const ASCII_PRESETS: Readonly<Record<string, string>> = {json.dumps(st._ASCII_PRESETS, ensure_ascii=True)}\n"
        "\n"
        "/** The ramp a custom text shorter than two characters falls back to (_ASCII_DEFAULT). */\n"
        f"export const ASCII_DEFAULT = {json.dumps(st._ASCII_DEFAULT, ensure_ascii=True)}\n"
    )
    with open(ASCII_GLYPH_SET, "w", encoding="utf-8") as fh:
        fh.write(ts)
    return {"characters": chars, "entries": len(chars) * (ASCII_CELLS[1] - ASCII_CELLS[0] + 1), "file_sha256": sha(packed),
            "file_bytes": len(packed), "raw_sha256": sha(raw), "index": index, "cells": per_cell}


class CellsGroup(Group):
    """The cells group's cases: every class is exact, so each output is its sha256s (float32, round8,
    trunc8), and a small one's float32 too, zlib'd (`f32z`, kept once per distinct float in
    `floats`: a failing test can then name the first value that differs)."""

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            tensors[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        row["outputs"] = [record_tone_output(t, hashed, None) for t in outs]
        if not hashed:
            for t, o in zip(outs, row["outputs"]):
                for i, item in enumerate(o["items"]):
                    item["f32z"] = b64(zlib.compress(t[i].contiguous().cpu().numpy().astype("<f4").tobytes(), 9))
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        self.cases.append(row)


# A few settings drawn at random (seeded) per class, on top of the standard set: combinations the
# one-at-a-time set leaves untried.
CELLS_RANDOM = 10


def cells() -> dict:
    cells_use_dejavu()
    import comfy_extras.nodes_glsl_stylize as st
    atlas = ascii_atlas()
    cells_use_dejavu()
    g = CellsGroup()
    classes = {node_id: node_class(module, node_id) for module, node_id in CELLS_CLASSES}
    for node_id, cls in classes.items():
        standard_cases(g, cls, node_id)
    rgb, card4, card3, prov = g.picture(37, 23, 3, 1), g.picture(23, 19, 4, 3), g.picture(23, 19, 3, 4), g.picture(29, 31, 4, 2)
    four = (("rgb 37×23", "rgb", rgb), ("provider 29×31", "provider", prov), ("card 23×19 see-through", "card", card4), ("card 23×19 opaque", "card", card3))
    defaults = {node_id: widget_settings(cls)[0] for node_id, cls in classes.items()}

    def run(cls_name: str, label: str, over: dict, pics, hashed: bool = False) -> None:
        for pname, source, file in pics:
            g.case(f"{cls_name}: {label}, {pname}", classes[cls_name], cls_name, {**defaults[cls_name], **over}, {"image": (source, [file])}, hashed=hashed)

    # Every numeric widget "between" at once.
    for node_id, cls in classes.items():
        _d, settings = widget_settings(cls)
        mixed = dict(defaults[node_id])
        for label, over in settings:
            if " between (" in label:
                mixed.update(over)
        run(node_id, "every setting between", {k: v for k, v in mixed.items() if v != defaults[node_id].get(k)},
            (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4)))
    # Pixelate: 1 (a clamp), 2, and 64 (bigger than the picture: an area resize to 1 × 1, a mean).
    for size in (1, 2, 3, 64):
        run("Pixelate", f"size {size}", {"size": size}, four)
    wide = g.picture(150, 70, 3, 12)
    run("Pixelate", "size 64 (a 2 × 1 area)", {"size": 64}, (("rgb 150×70", "rgb", wide),))
    b1, b2 = g.picture(120, 90, 3, 13), g.picture(120, 90, 3, 14)
    for size in (64, 7):
        g.case(f"Pixelate: size {size}, a batch of two rgb 120×90", classes["Pixelate"], "Pixelate", {"size": size}, {"image": ("rgb", [b1, b2])})
        g.case(f"Pixelate: size {size}, rgb 120×90", classes["Pixelate"], "Pixelate", {"size": size}, {"image": ("rgb", [b1])})
    g.case("Pixelate: size 64, a batch of two provider 29×31", classes["Pixelate"], "Pixelate", {"size": 64},
           {"image": ("provider", [prov, g.picture(29, 31, 4, 15)])})
    # Halftone: an odd and an even cell at angles 0, 15 and 90; and a few more.
    for cell in (7, 8, 2, 3):
        for angle in (0.0, 15.0, 90.0, 45.0):
            run("Halftone", f"cell {cell}, angle {angle}", {"cell_size": cell, "angle": angle}, (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4)))
    # Kuwahara: radius 1–12 on 37×23 (an odd radius makes the picture one pixel larger each way).
    for r in range(1, 13):
        run("Kuwahara", f"radius {r}", {"radius": r}, (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4)))
    # Ascii: every preset (the standard set), custom text short and long, the modes and their mixes.
    ascii_d = defaults["Ascii"]
    whole = g.picture(40, 30, 3, 16)
    whole4 = g.picture(40, 30, 4, 17)
    pics_a = (("rgb 37×23", "rgb", rgb), ("rgb 40×30", "rgb", whole), ("provider 40×30", "provider", whole4), ("card 23×19 see-through", "card", card4))
    customs = ["x", "", "ab", "@%#*+=-:. ", " .:-=+*#%@abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!?",
               " ░▒▓█·•●≡⠁⠇⠿⣿", "⠀⠁", "  ..", "é"]
    for i, text in enumerate(customs):
        run("Ascii", f"custom {i} ({len(text)} characters)", {"preset": "custom", "characters": text, "cell_size": 6}, pics_a[:2])
    for preset in list(st._ASCII_PRESETS) + ["custom"]:
        run("Ascii", f"preset {preset}, cell 5", {"preset": preset, "cell_size": 5}, pics_a[:2])
    for mode in ("monochrome", "texture"):
        for bg in (True, False):
            for inv in (False, True):
                for blend in ("normal", "multiply", "screen", "overlay"):
                    for mix in (1.0, 0.5):
                        run("Ascii", f"{mode}, background {bg}, invert {inv}, {blend}, mix {mix}",
                            {"color_mode": mode, "background": bg, "invert_order": inv, "blend_mode": blend, "mix": mix, "cell_size": 5}, pics_a)
    for px_, py_ in ((32, 0), (-32, 0), (0, 32), (0, -32), (7, -3), (-37, 23), (32, 32)):
        run("Ascii", f"pos {px_}, {py_}", {"pos_x": max(-32, min(32, px_)), "pos_y": max(-32, min(32, py_)), "cell_size": 5}, pics_a[:3])
    for gamma in (0.1, 3.0, 2.0, 0.5, 1.0005, 1.002, 0.37, 2.71):
        for phase in (0.0, 1.0, 0.33):
            run("Ascii", f"gamma {gamma}, phase {phase}", {"gamma": gamma, "phase": phase, "cell_size": 4}, pics_a[:1])
    run("Ascii", "mix 0.999 (not mixed)", {"mix": 0.999, "cell_size": 5}, pics_a)
    run("Ascii", "mix 0.9989 (mixed)", {"mix": 0.9989, "cell_size": 5}, pics_a)
    for cell in (4, 9, 19, 23, 24, 37, 40):
        run("Ascii", f"cell {cell}", {"cell_size": cell}, pics_a)
    g.case("Ascii: texture, a batch of two files and a repeat", classes["Ascii"], "Ascii", {**ascii_d, "color_mode": "texture", "cell_size": 4},
           {"image": ("rgb", [rgb, g.picture(37, 23, 3, 5), rgb])})

    # Ties. Kuwahara on two flat halves: next to the edge, a quadrant wholly in each half has
    # variance 0 (argmin takes the first). Ascii on black: the index lands on a half
    # ((1 − 0)·2 + 0.25·2 = 2.5), which rounds to even.
    def flat(name: str, w: int, h: int, fill) -> str:
        arr = np.zeros((h, w, 3), dtype=np.uint8)
        fill(arr)
        buf = io.BytesIO()
        PILImage.fromarray(arr, "RGB").save(buf, format="PNG")
        g.assets.setdefault(name, buf.getvalue())
        return name
    halves = flat("halves_40x24.png", 40, 24, lambda a: a.__setitem__((slice(None), slice(20, None)), 255))
    stripes = flat("stripes_40x24.png", 40, 24, lambda a: a.__setitem__((slice(None), slice(None, None, 4)), 200))
    black = flat("black_40x30.png", 40, 30, lambda a: None)
    for r in (2, 3, 4, 7):
        for pname, file in (("two halves 40×24", halves), ("stripes 40×24", stripes)):
            g.case(f"Kuwahara: radius {r}, {pname}", classes["Kuwahara"], "Kuwahara", {"radius": r}, {"image": ("rgb", [file])})
    for inv in (False, True):
        for phase in (0.25, 0.75):
            g.case(f"Ascii: binary, phase {phase}, invert {inv}, black 40×30", classes["Ascii"], "Ascii",
                   {**ascii_d, "preset": "binary", "phase": phase, "invert_order": inv, "cell_size": 10}, {"image": ("rgb", [black])})
    # Settings drawn at random (seeded), every class.
    rs = np.random.default_rng(2606)
    presets = list(st._ASCII_PRESETS) + ["custom"]
    for node_id, cls in classes.items():
        for i in range(CELLS_RANDOM):
            if node_id == "Pixelate":
                over = {"size": int(rs.integers(1, 65))}
            elif node_id == "Halftone":
                over = {"cell_size": int(rs.integers(2, 49)), "angle": float(round(rs.uniform(0, 90), 2))}
            elif node_id == "Kuwahara":
                over = {"radius": int(rs.integers(1, 13))}
            else:
                over = {"preset": presets[int(rs.integers(0, len(presets)))], "characters": "".join(rs.choice(list(atlas["characters"]), int(rs.integers(1, 30)))),
                        "cell_size": int(rs.integers(4, 12)), "gamma": float(round(rs.uniform(0.1, 3.0), 2)), "phase": float(round(rs.uniform(0, 1), 2)),
                        "mix": float(round(rs.uniform(0, 1), 2)), "color_mode": ["monochrome", "texture"][int(rs.integers(0, 2))],
                        "background": bool(rs.integers(0, 2)), "invert_order": bool(rs.integers(0, 2)),
                        "pos_x": int(rs.integers(-32, 33)), "pos_y": int(rs.integers(-32, 33)),
                        "blend_mode": ["normal", "multiply", "screen", "overlay"][int(rs.integers(0, 4))]}
            pname, source, file = (("rgb 80×60", "rgb", g.picture(80, 60, 3, 11)), ("rgb 37×23", "rgb", rgb), ("card 23×19 opaque", "card", card3))[i % 3]
            g.case(f"{node_id}: random {i}, {pname}", cls, node_id, {**defaults[node_id], **over}, {"image": (source, [file])})
    # The large cases (hashed): settings that do the most work.
    big = (("rgb 320×200", "rgb", g.picture(320, 200, 3, 6)),)
    run("Pixelate", "size 3", {"size": 3}, big, hashed=True)
    run("Halftone", "cell 13, angle 33", {"cell_size": 13, "angle": 33.0}, big, hashed=True)
    run("Kuwahara", "radius 7", {"radius": 7}, big, hashed=True)
    run("Ascii", "texture, overlay, mix 0.6, pos 5, -9", {"color_mode": "texture", "blend_mode": "overlay", "mix": 0.6, "pos_x": 5, "pos_y": -9, "cell_size": 7}, big, hashed=True)
    run("Ascii", "blocks, gamma 0.37, phase 0.5", {"preset": "blocks", "gamma": 0.37, "phase": 0.5, "cell_size": 12}, big, hashed=True)
    frame = tone_frame_chain(g, classes["Kuwahara"], "Kuwahara", {"radius": 3}, card4)
    floats: dict = {}
    for c in g.cases:
        for o in c.get("outputs") or []:
            for it in o["items"]:
                if "f32z" in it:
                    floats[it["f32_sha256"]] = it.pop("f32z")
    return {"cases": g.cases, "floats": floats, "assets": {k: b64(v) for k, v in sorted(g.assets.items())},
            "atlas": atlas, "frame": frame, "font": {"path": os.path.relpath(CELLS_FONT, ROOT), "sha256": atlas["index"]["font_sha256"]}}


# ── Group `warp` (R2.7): geometry and coordinate warps ──────────────────────

# (module, node_id) of the 15 classes R2.7 ports.
WARP_CLASSES = [
    ("nodes_geometry", "CropImage"), ("nodes_geometry", "ResizeImage"), ("nodes_geometry", "RotateImage"), ("nodes_geometry", "FlipImage"),
    ("nodes_distortion", "Pinch"), ("nodes_distortion", "Twirl"), ("nodes_distortion", "Wave"), ("nodes_distortion", "LensCorrection"),
    ("nodes_glsl_distortion", "Kaleidoscope"), ("nodes_glsl_distortion", "PolarCoords"), ("nodes_glsl_distortion", "Fisheye"),
    ("nodes_glsl_lens", "ChromaticAberration"), ("nodes_glsl_lens", "CRT"),
    ("nodes_glsl_unicorn", "Mirror"), ("nodes_glsl_atmosphere", "GodRays"),
]
# CRT, a library class: its ε (255-scale); its one transcendental (sin of arange·3.14159) matched
# Python's float on every case measured, fixture and sweep (to 8192²). tests/unit/runner-effects-warp
# .unit.spec.ts holds the same table.
WARP_LIBRARY_EPS = {"CRT": 2.0 ** -12}
# The "warp" parity class (controller ruling, R2.7 round 2): grids built from torch's float sin, cos,
# tan, atan2 or pow (SLEEF u10 on this Mac, not correctly rounded), whose ulp differences move the
# sample by ulp · side / 2 pixels, so the error grows with the picture. Each 8-bit value within ±1 of
# Python's, the share of ±1 values and the float |Δ|·255 within bounds pinned per class in the spec.
# A small case keeps its float (`f32s`); a hashed one Python's round8 bytes (`round8z`, zlib), where
# trunc8 is one lower (`trunc8_off`, packed bits, zlib) and its float over three windows (`windows`).
WARP_BAND_CLASSES = ("Pinch", "Twirl", "Wave", "Kaleidoscope", "PolarCoords", "Fisheye")
WARP_WINDOW = 32
WARP_RESIZE_SCALES = [0.1, 0.33, 0.5, 1.0, 1.5, 4.0]
WARP_RANDOM = 10


class WarpGroup(Group):
    """The warp group's cases: each output its sha256s (float32, round8, trunc8); a small output of a
    library class its float32 too, byte-shuffled and zlib'd (`f32s`, kept once per distinct float in
    `floats`), a hashed one its band at the class's ε. An exact class is checked by its hashes."""

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            tensors[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        # A warp-class node left at its no-op setting hands on its input clamped: kept by its hashes alone.
        img = next(iter(tensors.values()))
        same = [t.shape == img.shape and torch.equal(t, img.clamp(0, 1)) for t in outs]
        row["outputs"] = [warp_output(t, hashed, class_type, sm) for t, sm in zip(outs, same)]
        if any(same) and class_type in WARP_BAND_CLASSES:
            row["unchanged"] = True
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        self.cases.append(row)


def warp_windows(x: torch.Tensor) -> list:
    """A hashed output's float over three WARP_WINDOW² windows: the top-left corner, the middle, the
    bottom-right corner ([x0, y0, w, h, f32s])."""
    h, w = int(x.shape[0]), int(x.shape[1])
    ww, wh = min(WARP_WINDOW, w), min(WARP_WINDOW, h)
    out = []
    for x0, y0 in ((0, 0), ((w - ww) // 2, (h - wh) // 2), (w - ww, h - wh)):
        out.append([x0, y0, ww, wh, shuffled_f32(x[y0:y0 + wh, x0:x0 + ww])])
    return out


def warp_output(t: torch.Tensor, hashed: bool, class_type: str, unchanged: bool = False) -> dict:
    eps = WARP_LIBRARY_EPS.get(class_type)
    band = class_type in WARP_BAND_CLASSES and not unchanged
    items = []
    for i in range(t.shape[0]):
        x = t[i].contiguous()
        f32 = x.cpu().numpy().astype("<f4").tobytes()
        item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": int(x.shape[2]), "f32_sha256": sha(f32),
                "round8_sha256": sha(round8(x).tobytes()), "trunc8_sha256": sha(trunc8(x).tobytes())}
        if band and hashed:
            r8, t8 = round8(x), trunc8(x)
            off = (r8.astype(np.int16) - t8.astype(np.int16)).reshape(-1)
            assert off.min() >= 0 and off.max() <= 1
            item["round8z"] = b64(zlib.compress(r8.tobytes(), 9))
            # trunc8 = round8 − 1 where this bit is set (the two never differ by more).
            item["trunc8_off"] = b64(zlib.compress(np.packbits(off.astype(np.uint8)).tobytes(), 9))
            item["windows"] = warp_windows(x)
        elif band:
            item["f32s"] = shuffled_f32(x)
        elif eps is not None:
            # CRT: its band at ε, small or hashed (its float matched Python's on every case measured).
            item["band"] = band_list(x, eps)
        items.append(item)
    return {"kind": "image", "items": items}


def warp_negzero_input(spec: dict) -> torch.Tensor:
    """A (B, H, W, C) picture from `hashed_values` in memory order, every `neg_zero_every`-th value −0
    (as a Dither upstream leaves them): the spec rebuilds it."""
    b, h, w, c = spec["shape"]
    v = hashed_values(b * h * w * c, spec["seed"])
    v[:: spec["neg_zero_every"]] = -0.0
    return torch.from_numpy(v.reshape(b, h, w, c).copy())


def warp_kernels() -> list:
    """The resizes' scale_factor path (R2.7 ruling (a)): F.interpolate(scale_factor=s) of a
    channels-last (movedim'd) picture, as ResizeImage calls it, against kernels.ts with `scales`:
    the brief's scales, scales whose in·s is not whole, 1, 3 and 4 channels, and a batch of two."""
    import torch.nn.functional as F
    g = KernelCases()
    g.seed = 5000
    sizes = [(37, 23), (29, 31), (7, 5), (10, 12), (320, 200), (64, 1), (1, 1)]
    # 1.004 and 1.02 keep one side (or both) its size: torch's bilinear leaves that side alone.
    scales = [0.1, 0.33, 0.5, 1.5, 4.0, 0.37, 1.05, 2.3, 0.15, 0.999, 1.004, 1.02]
    for mode in ("bilinear", "bicubic", "nearest", "area"):
        kw = {"align_corners": False} if mode in ("bilinear", "bicubic") else {}
        for (w, h) in sizes:
            for s in scales:
                if (w, h) == (320, 200) and s > 1.5:
                    continue
                for c, memory in ((3, "channels-last"), (4, "channels-last"), (1, "contiguous")):
                    if (w, h) == (320, 200) and c != 4:
                        continue
                    g.add(f"{mode} scale_factor {s}, {w}×{h} {c} ch {memory}", f"resize-{mode}", "exact", [g.inp(c, h, w, memory=memory)],
                          {"scale": s}, lambda t, s=s, mode=mode, kw=kw: F.interpolate(t, scale_factor=s, mode=mode, **kw)[0])
        # A batch of two (channels-last, as ResizeImage's permuted batch): each picture its own output.
        for (w, h), s in (((37, 23), 0.33), ((29, 31), 1.5), ((320, 200), 0.37)):
            for c in (3, 4):
                a, b = g.inp(c, h, w), g.inp(c, h, w)
                g.add(f"{mode} scale_factor {s}, a batch of two {w}×{h} {c} ch channels-last", f"resize-{mode}", "exact", [a, b], {"scale": s, "batch": 2},
                      lambda t, u, s=s, mode=mode, kw=kw: tuple(F.interpolate(torch.cat([t, u]).contiguous(memory_format=torch.channels_last), scale_factor=s, mode=mode, **kw)[i] for i in (0, 1)))
    # Exact: each output's sha256 alone (its float is 928 cases' worth of fixture; a miss names the case).
    for c in g.cases:
        for o in c.get("outputs") or []:
            o.pop("f32", None)
    return g.cases


def warp_cases(g: WarpGroup, classes: dict) -> None:
    rgb, card4, card3, prov = g.picture(37, 23, 3, 1), g.picture(23, 19, 4, 3), g.picture(23, 19, 3, 4), g.picture(29, 31, 4, 2)
    four = (("rgb 37×23", "rgb", rgb), ("provider 29×31", "provider", prov), ("card 23×19 see-through", "card", card4), ("card 23×19 opaque", "card", card3))
    two = (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4))
    defaults = {node_id: widget_settings(cls)[0] for node_id, cls in classes.items()}

    def run(cls_name: str, label: str, over: dict, pics, hashed: bool = False) -> None:
        for pname, source, file in pics:
            g.case(f"{cls_name}: {label}, {pname}", classes[cls_name], cls_name, {**defaults[cls_name], **over}, {"image": (source, [file])}, hashed=hashed)

    # Every numeric widget "between" at once.
    for node_id, cls in classes.items():
        _d, settings = widget_settings(cls)
        mixed = dict(defaults[node_id])
        for label, over in settings:
            if " between (" in label:
                mixed.update(over)
        run(node_id, "every setting between", {k: v for k, v in mixed.items() if v != defaults[node_id].get(k)}, two)
    # Resize: the brief's scales in each mode, a 1-pixel result, and nothing left (Python raises).
    tiny = g.picture(10, 12, 3, 18)
    for mode in ("bilinear", "bicubic", "nearest", "area"):
        for s in WARP_RESIZE_SCALES:
            run("ResizeImage", f"{mode} × {s}", {"mode": mode, "scale": s}, four)
        run("ResizeImage", f"{mode} × 0.1 to one pixel", {"mode": mode, "scale": 0.1}, (("rgb 10×12", "rgb", tiny),))
        for s in (0.37, 1.05, 2.3):
            run("ResizeImage", f"{mode} × {s}", {"mode": mode, "scale": s}, two)
        g.case(f"ResizeImage: {mode} × 0.5, the 1×1 blank", classes["ResizeImage"], "ResizeImage", {"mode": mode, "scale": 0.5}, {"image": ("blank", [])})
        g.case(f"ResizeImage: {mode} × 1.5, a batch of two files and a repeat", classes["ResizeImage"], "ResizeImage", {"mode": mode, "scale": 1.5},
               {"image": ("rgb", [rgb, g.picture(37, 23, 3, 5), rgb])})
        run("ResizeImage", f"{mode} × 0.37, hashed", {"mode": mode, "scale": 0.37}, (("rgb 320×200", "rgb", g.picture(320, 200, 3, 6)),), hashed=True)
        run("ResizeImage", f"{mode} × 1.3, hashed", {"mode": mode, "scale": 1.3}, (("card 160×100 see-through", "card", g.picture(160, 100, 4, 19)),), hashed=True)
    # Rotate: ±180, ±90, 45 and 1.
    for a in (180.0, -180.0, 90.0, -90.0, 45.0, 1.0, -33.3):
        run("RotateImage", f"angle {a}", {"angle": a}, four)
    # Crop: 0.49 on each side (the max(x0 + 1, …) guard), all four, and the full-width and full slices.
    for side in ("left", "right", "top", "bottom"):
        run("CropImage", f"{side} 0.49", {side: 0.49}, four)
    run("CropImage", "0.49 on every side", {"left": 0.49, "right": 0.49, "top": 0.49, "bottom": 0.49}, four)
    run("CropImage", "top 0.2, bottom 0.1", {"top": 0.2, "bottom": 0.1}, two)
    g.case("CropImage: left 0.1, top 0.3, the 1×1 blank", classes["CropImage"], "CropImage", {**defaults["CropImage"], "left": 0.1, "top": 0.3}, {"image": ("blank", [])})
    # Flip: every combination.
    for hz in (False, True):
        for vt in (False, True):
            run("FlipImage", f"horizontal {hz}, vertical {vt}", {"horizontal": hz, "vertical": vt}, two)
    # Mirror: every mode, seam 0, 0.5 and 1, an odd and an even picture.
    even = g.picture(40, 30, 3, 20)
    for mode in ("left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top", "quadrant_tl", "quadrant_tr"):
        for seam in (0.0, 0.5, 1.0, 0.33, 0.77):
            run("Mirror", f"{mode}, seam {seam}", {"mode": mode, "seam": seam},
                (("rgb 37×23", "rgb", rgb), ("rgb 40×30", "rgb", even), ("card 23×19 see-through", "card", card4)))
    one_col, one_row = g.picture(1, 9, 3, 21), g.picture(9, 1, 3, 22)
    for mode in ("left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top", "quadrant_tl", "quadrant_tr"):
        run("Mirror", f"{mode}, seam 0.5, one column and one row", {"mode": mode, "seam": 0.5}, (("rgb 1×9", "rgb", one_col), ("rgb 9×1", "rgb", one_row)))
    # GodRays: centres at the corners, samples 4 and 80.
    for cx, cy in ((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)):
        for n in (4, 80):
            run("GodRays", f"centre {cx}, {cy}, samples {n}", {"center_x": cx, "center_y": cy, "samples": n, "threshold": 0.4}, two)
    # Kaleidoscope: 2 and 20 segments.
    for n in (2, 20):
        for rot in (0.0, 45.0, 359.0):
            run("Kaleidoscope", f"segments {n}, rotation {rot}", {"segments": n, "rotation": rot}, four)
    # Pinch at torch's special exponents (1 + amount: 0, 0.5, 2) and others.
    for amt in (-1.0, -0.5, 1.0, 0.25, -0.73):
        run("Pinch", f"amount {amt}", {"amount": amt}, two)
    # CRT: each step alone and together, on 3 and 4 channels (a 4-channel picture meets the stripes).
    crt_steps = [{"scanlines": 0.0, "rgb_mask": 0.0, "chroma": 0.0, "curvature": 0.0}, {"scanlines": 0.7, "rgb_mask": 0.0, "chroma": 0.0, "curvature": 0.0},
                 {"scanlines": 0.0, "rgb_mask": 0.6, "chroma": 0.0, "curvature": 0.0}, {"scanlines": 0.0, "rgb_mask": 0.0, "chroma": 0.013, "curvature": 0.0},
                 {"scanlines": 0.0, "rgb_mask": 0.0, "chroma": 0.0, "curvature": 0.15}, {"scanlines": 0.4, "rgb_mask": 0.5, "chroma": 0.0, "curvature": 0.1},
                 {"scanlines": 0.4, "rgb_mask": 0.5, "chroma": 0.02, "curvature": 0.1}]
    for i, over in enumerate(crt_steps):
        run("CRT", f"steps {i}", over, four)
    # Settings drawn at random (seeded), every class.
    rs = np.random.default_rng(2607)
    for node_id, cls in classes.items():
        types = cls.INPUT_TYPES()["required"]
        for i in range(WARP_RANDOM):
            over = {}
            for name, spec in types.items():
                kind, info = spec[0], (spec[1] if len(spec) > 1 else {})
                if kind == "FLOAT":
                    over[name] = float(round(rs.uniform(info["min"], info["max"]), 3))
                elif kind == "INT":
                    over[name] = int(rs.integers(info["min"], info["max"] + 1))
                elif kind == "BOOLEAN":
                    over[name] = bool(rs.integers(0, 2))
                elif kind == "COMBO":
                    opts = info.get("options") or spec[0]
                    over[name] = opts[int(rs.integers(0, len(opts)))]
                elif isinstance(kind, list):
                    over[name] = kind[int(rs.integers(0, len(kind)))]
            pname, source, file = (("rgb 41×29", "rgb", g.picture(41, 29, 3, 23)), ("rgb 37×23", "rgb", rgb), ("card 23×19 opaque", "card", card3))[i % 3]
            g.case(f"{node_id}: random {i}, {pname}", cls, node_id, {**defaults[node_id], **over}, {"image": (source, [file])})
    # The large cases (hashed): settings that do something.
    big = (("rgb 320×200", "rgb", g.picture(320, 200, 3, 6)),)
    big4 = (("card 160×100 see-through", "card", g.picture(160, 100, 4, 19)),)
    heavy = {
        "CropImage": {"left": 0.13, "right": 0.21, "top": 0.05, "bottom": 0.3}, "RotateImage": {"angle": 33.0}, "FlipImage": {"horizontal": True, "vertical": True},
        "Pinch": {"amount": 0.45}, "Twirl": {"angle": 170.0}, "Wave": {"amplitude": 0.07, "wavelength": 0.13, "axis": "both"}, "LensCorrection": {"distortion": -0.3},
        "Kaleidoscope": {"segments": 7, "rotation": 20.0}, "PolarCoords": {"direction": "polar_to_rect"}, "Fisheye": {"amount": 1.1},
        "ChromaticAberration": {"amount": 0.03}, "CRT": {"scanlines": 0.5, "rgb_mask": 0.4, "chroma": 0.01, "curvature": 0.12},
        "Mirror": {"mode": "quadrant_tr", "seam": 0.5}, "GodRays": {"threshold": 0.5, "intensity": 1.3, "center_x": 0.2, "center_y": 0.8, "samples": 40},
    }
    for node_id, over in heavy.items():
        run(node_id, "heavy", over, big, hashed=True)
        if node_id not in ("CRT",):
            run(node_id, "heavy", over, big4, hashed=True)
    run("PolarCoords", "rect_to_polar", {"direction": "rect_to_polar"}, big, hashed=True)


# −0 through the last clamp (as a Dither upstream leaves it): torch keeps it only in its loop's scalar
# tails, which depend on how the clamped tensor sits in memory.
WARP_NEGZERO = [
    ("CropImage", {"left": 0.1, "right": 0.2, "top": 0.05, "bottom": 0.1}), ("CropImage", {"left": 0.0, "right": 0.0, "top": 0.1, "bottom": 0.2}),
    ("CropImage", {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}), ("CropImage", {"left": 0.3, "right": 0.0, "top": 0.0, "bottom": 0.0}),
    ("ResizeImage", {"scale": 1.0, "mode": "bilinear"}), ("ResizeImage", {"scale": 2.0, "mode": "nearest"}), ("ResizeImage", {"scale": 1.5, "mode": "bilinear"}),
    ("FlipImage", {"horizontal": True, "vertical": False}), ("Mirror", {"mode": "left_to_right", "seam": 0.4}), ("Mirror", {"mode": "quadrant_tl", "seam": 0.5}),
    ("RotateImage", {"angle": 0.0}), ("RotateImage", {"angle": 90.0}), ("LensCorrection", {"distortion": 0.2}), ("ChromaticAberration", {"amount": 0.01}),
    ("CRT", {"scanlines": 0.3, "rgb_mask": 0.0, "chroma": 0.0, "curvature": 0.0}), ("CRT", {"scanlines": 0.3, "rgb_mask": 0.2, "chroma": 0.005, "curvature": 0.05}),
    ("GodRays", {"threshold": 0.75, "intensity": 0.0, "center_x": 0.5, "center_y": 0.3, "samples": 24}),
]


def warp_negzero(classes: dict) -> list:
    rows = []
    seed = 7000
    for class_type, widgets in WARP_NEGZERO:
        for shape in ((1, 23, 37, 3), (2, 23, 37, 3), (1, 120, 110, 3), (2, 61, 90, 4), (1, 61, 90, 4)):
            seed += 1
            spec = {"shape": list(shape), "seed": seed, "neg_zero_every": 3}
            x = warp_negzero_input(spec)
            outs, _ui = run_node(classes[class_type], f"nz{seed}", image=x, **widgets)
            t = outs[0]
            items = []
            for i in range(t.shape[0]):
                y = t[i].contiguous()
                f32 = y.cpu().numpy().astype("<f4").tobytes()
                neg = int((torch.signbit(y) & (y == 0)).sum())
                items.append({"w": int(y.shape[1]), "h": int(y.shape[0]), "c": int(y.shape[2]), "f32_sha256": sha(f32), "neg_zeros": neg})
            rows.append({"name": f"{class_type} {widgets}, {'×'.join(map(str, shape))}", "class_type": class_type, "widgets": widgets, "input": spec, "items": items})
    return rows


def warp_classes() -> dict:
    return {node_id: node_class(module, node_id) for module, node_id in WARP_CLASSES}


def warp() -> dict:
    g = WarpGroup()
    classes = warp_classes()
    for node_id, cls in classes.items():
        standard_cases(g, cls, node_id)
    warp_cases(g, classes)
    # Resize into a Frame: the Frame sizes its canvas from the resized picture (its first layer).
    frame = tone_frame_chain(g, classes["ResizeImage"], "ResizeImage", {"scale": 1.5, "mode": "bicubic"}, g.picture(23, 19, 4, 3))
    floats: dict = {}
    for c in g.cases:
        for o in c.get("outputs") or []:
            for it in o["items"]:
                if "f32s" in it:
                    floats[it["f32_sha256"]] = it.pop("f32s")
    return {"cases": g.cases, "floats": floats, "assets": {k: b64(v) for k, v in sorted(g.assets.items())},
            "library_eps": WARP_LIBRARY_EPS, "band_classes": list(WARP_BAND_CLASSES), "kernels": warp_kernels(), "negzero": warp_negzero(classes), "frame": frame}


# `--group warp --sweep`: writes nothing into the repo. Two parts, each measured by the spec against
# the TypeScript port (files handed over in this run's temp directory):
#  1. small — each library and warp-class class (and Rotate, exact) over WARP_SWEEP_SEEDS fresh
#     pictures (synth, sizes 29–511 drawn) with every widget drawn over its range;
#  2. large — each warp-class class (and CRT, and Rotate) at WARP_SWEEP_LARGE sizes up to 8192², the
#     largest the runner takes: every widget at its max, then drawn. The picture is `big_pixels`
#     (numpy here, the same integer arithmetic in the spec); Python's float is handed over raw, one
#     class at a time, and deleted after.
# The spec prints each case's worst |Δ|·255, its share of ±1 values and its largest 8-bit difference.
WARP_SWEEP_SEEDS = 40
WARP_SWEEP_SIZES = [(41, 29), (37, 31), (29, 37), (64, 48), (97, 61), (160, 100), (320, 200), (511, 257)]
# (side, seeds): the first seed of each size has every widget at its max. A class the runner caps below
# 8192² (shared/runner/effects.ts EFFECT_CLASS_MAX_PIXELS: Kaleidoscope, 4096²) is swept up to its cap,
# with more seeds there.
WARP_SWEEP_LARGE = [(2048, 3), (4096, 2), (8192, 1)]
WARP_SWEEP_CAPPED = {"Kaleidoscope": [(2048, 3), (4096, 4)]}


def big_pixels(w: int, h: int, c: int, seed: int) -> np.ndarray:
    """An 8-bit H × W × C picture from integer arithmetic (the spec rebuilds it): a diagonal gradient
    per channel, xor'd with 5 bits of a multiplicative hash of the value's index, brighter past a
    vertical edge at 40% of the width."""
    y, x, k = np.meshgrid(np.arange(h, dtype=np.uint64), np.arange(w, dtype=np.uint64), np.arange(c, dtype=np.uint64), indexing="ij")
    i = (y * np.uint64(w) + x) * np.uint64(c) + k
    hsh = ((i * np.uint64(2654435761) + np.uint64(seed * 40503)) & np.uint64(0xFFFFFFFF)) >> np.uint64(27)
    v = ((x * np.uint64(37) + y * np.uint64(11) + k * np.uint64(71) + np.uint64(seed)) & np.uint64(255)) ^ hsh
    edge = x > np.uint64(w * 4 // 10)
    v = np.where(edge, np.minimum(v + np.uint64(60), np.uint64(255)), v)
    return v.astype(np.uint8)


def sweep_widgets(rs: np.random.Generator, types: dict, at_max: bool = False) -> dict:
    widgets = {}
    for name, spec in types.items():
        kind, info = spec[0], (spec[1] if len(spec) > 1 else {})
        if kind == "FLOAT":
            r = rs.uniform(0, 1)
            widgets[name] = float(info["max"] if at_max or r < 0.15 else info["min"] if r < 0.25 else round(rs.uniform(info["min"], info["max"]), 3))
        elif kind == "INT":
            widgets[name] = int(info["max"] if at_max else rs.integers(info["min"], info["max"] + 1))
        elif kind == "COMBO":
            opts = info.get("options") or []
            widgets[name] = opts[int(rs.integers(0, len(opts)))]
        elif isinstance(kind, list):
            widgets[name] = kind[int(rs.integers(0, len(kind)))]
    return widgets


def warp_spec_run(env_key: str, path: str, title: str, extra_env: dict | None = None) -> tuple[int, list]:
    import subprocess
    env = {k: v for k, v in os.environ.items() if k not in PROVIDER_KEYS}
    env[env_key] = path
    env.update(extra_env or {})
    r = subprocess.run(["npx", "vitest", "run", "tests/unit/runner-effects-warp.unit.spec.ts", "-t", title, "--testTimeout=1800000", "--reporter=verbose"],
                       cwd=os.path.join(ROOT, "frontend"), env=env, capture_output=True, text=True)
    lines = [ln for ln in (r.stdout + r.stderr).splitlines() if "warp ε" in ln or "warp large" in ln or "Tests " in ln or "FAIL" in ln or "Error" in ln]
    return r.returncode, lines


def warp_sweep_run() -> int:
    classes = warp_classes()
    rs = np.random.default_rng(9127)
    cases = []
    for node_id, cls in classes.items():
        if node_id not in WARP_LIBRARY_EPS and node_id not in WARP_BAND_CLASSES and node_id != "RotateImage":
            continue
        types = cls.INPUT_TYPES()["required"]
        for i in range(WARP_SWEEP_SEEDS):
            w, h = WARP_SWEEP_SIZES[int(rs.integers(0, len(WARP_SWEEP_SIZES)))]
            c = 3 if node_id == "CRT" or rs.integers(0, 3) else 4
            seed = int(rs.integers(1, 2 ** 31))
            widgets = sweep_widgets(rs, types)
            px = np.frombuffer(synth(w, h, c, seed), dtype=np.uint8).reshape(1, h, w, c)
            x = torch.from_numpy(px.astype(np.float32) / 255.0)
            row = {"class_type": node_id, "widgets": widgets, "w": w, "h": h, "c": c, "seed": seed}
            try:
                outs, _ui = run_node(cls, f"sw{len(cases)}", image=x, **widgets)
                t = outs[0][0]
                row.update({"ow": int(t.shape[1]), "oh": int(t.shape[0]), "oc": int(t.shape[2]), "f32s": shuffled_f32(t)})
            except Exception as e:  # noqa: BLE001
                row["error"] = str(e)
            cases.append(row)
    path = os.path.join(WORK, "warp-sweep.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    print(f"warp ε sweep, small: {len(cases)} cases, {sum(1 for c in cases if 'error' in c)} Python raises")
    code, lines = warp_spec_run("WARP_SWEEP_FILE", path, "the warp ε sweep")
    print("\n".join(lines))
    # Large: one class at a time (its raw floats run to 1.4 GB), deleted after.
    rs = np.random.default_rng(9128)
    for node_id, cls in classes.items():
        if node_id not in WARP_BAND_CLASSES and node_id not in ("CRT", "RotateImage"):
            continue
        types = cls.INPUT_TYPES()["required"]
        rows = []
        files = []
        for side, seeds in WARP_SWEEP_CAPPED.get(node_id, WARP_SWEEP_LARGE):
            for j in range(seeds):
                seed = int(rs.integers(1, 2 ** 31))
                widgets = sweep_widgets(rs, types, at_max=(j == 0))
                x = torch.from_numpy(big_pixels(side, side, 3, seed).astype(np.float32)[None] / np.float32(255.0))
                outs, _ui = run_node(cls, f"big{len(files)}", image=x, **widgets)
                t = outs[0][0].contiguous()
                fpath = os.path.join(WORK, f"warp-large-{node_id}-{len(files)}.f32")
                t.cpu().numpy().astype("<f4").tofile(fpath)
                files.append(fpath)
                rows.append({"class_type": node_id, "widgets": widgets, "w": side, "h": side, "c": 3, "seed": seed, "file": fpath,
                             "ow": int(t.shape[1]), "oh": int(t.shape[0]), "oc": int(t.shape[2])})
                del outs, t, x
        lpath = os.path.join(WORK, f"warp-large-{node_id}.json")
        with open(lpath, "w", encoding="utf-8") as f:
            json.dump({"cases": rows}, f)
        c2, lines = warp_spec_run("WARP_SWEEP_LARGE_FILE", lpath, "the warp large sweep")
        print("\n".join(lines))
        code = code or c2
        for fp in files:
            os.remove(fp)
    return code


# ── Group `mask` (R2.8): masks, blends and Painter ───────────────────────────

MASK_CLASSES = [
    ("nodes_composite", "Blend"), ("nodes_composite", "ApplyMask"), ("nodes_composite", "ThresholdMask"),
    ("nodes_composite", "ColorRangeMask"), ("nodes_matte", "MatteGrowShrink"), ("nodes_matte", "MergeAlpha"),
    ("nodes_painter", "Painter"),
]
# MatteGrowShrink's feather (torchvision gaussian_blur) is LIBRARY; every other step of the group is exact.
# A case that feathers keeps its float (byte-shuffled, zlib) so the spec can measure it.
BLEND_MODES = ["normal", "multiply", "screen", "overlay", "soft_light", "hard_light", "difference", "lighten", "darken", "add", "subtract"]


def quantise16(m: torch.Tensor) -> np.ndarray:
    """A float mask (H × W) as the runner keeps it (pixels/core.ts mask16Of): floor(clip(v, 0, 1) · 65535 + 0.5)
    in double, 16 bits."""
    v = np.clip(m.contiguous().cpu().numpy().astype(np.float64), 0.0, 1.0)
    return np.floor(v * 65535.0 + 0.5).astype(np.uint16)


def mask_png(q: np.ndarray) -> bytes:
    """A 16-bit greyscale PNG of these values (the kept mask a runner node hands on)."""
    buf = io.BytesIO()
    PILImage.fromarray(np.ascontiguousarray(q.astype(np.uint16))).save(buf, format="PNG")
    return buf.getvalue()


def synth_mask(w: int, h: int, seed: int, kind: str) -> np.ndarray:
    """A 16-bit mask from `synth`'s bytes: 'soft' every level (with exact 0 and 65535 spots), 'hard' 0 / 65535 blocks."""
    v = np.frombuffer(synth(w, h, 1, seed), dtype=np.uint8).reshape(h, w).astype(np.uint32)
    y, x = np.meshgrid(np.arange(h, dtype=np.uint32), np.arange(w, dtype=np.uint32), indexing="ij")
    if kind == "hard":
        return np.where(((x // 4 + y // 3 + np.uint32(seed)) % 3 == 0) | (v < 40), 65535, 0).astype(np.uint16)
    q = np.minimum(v * 257 + ((x * y * 31 + np.uint32(seed)) & 255), 65535)
    q = np.where((x + y) % 7 == 0, 0, q)
    q = np.where((x * 3 + y) % 11 == 0, 65535, q)
    return q.astype(np.uint16)


def record_mask_output(t: torch.Tensor, hashed: bool, library: bool) -> dict:
    """A MASK output, frame by frame: the sha256 of its float32 and of the 16 bits the runner keeps
    (little-endian uint16, H × W); a library case its float too (byte-shuffled, zlib)."""
    items = []
    for i in range(t.shape[0]):
        x = t[i].contiguous()
        f32 = x.cpu().numpy().astype("<f4").tobytes()
        item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": 1, "f32_sha256": sha(f32),
                "u16_sha256": sha(quantise16(x).astype("<u2").tobytes())}
        if library:
            item["f32s"] = shuffled_f32(x)
        items.append(item)
    return {"kind": "mask", "items": items}


class MaskGroup(Group):
    """The mask group's cases. Inputs by source, as the other groups, plus 'mask' (a kept 16-bit mask,
    u / 65535). An exact output keeps its sha256s (float32, and round8 / trunc8 or the kept 16 bits);
    a library one (a feathered MatteGrowShrink) its float too, byte-shuffled and zlib'd (`f32s`). A
    Painter case names its painter file in its widgets (`mask`), an asset written into the input folder."""

    def __init__(self) -> None:
        super().__init__()
        self.masks: dict[str, tuple[int, int]] = {}

    def mask(self, w: int, h: int, seed: int, kind: str) -> str:
        name = f"mask_{w}x{h}_{kind}_{seed}.png"
        if name not in self.assets:
            self.assets[name] = mask_png(synth_mask(w, h, seed, kind))
        return name

    def mask_of(self, name: str, q: np.ndarray) -> str:
        """A kept mask of these 16 bits (a producer's output as the runner keeps it)."""
        self.assets.setdefault(name, mask_png(q))
        return name

    def painter_file(self, name: str, im: PILImage.Image, **save) -> str:
        buf = io.BytesIO()
        im.save(buf, format="PNG", **save)
        self.assets.setdefault(name, buf.getvalue())
        with open(os.path.join(WORK, "input", name), "wb") as f:
            f.write(self.assets[name])
        return name

    def tensors_of(self, inputs: dict) -> dict:
        out = {}
        for key, (source, files) in inputs.items():
            out[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        return out

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False) -> None:
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = self.tensors_of(inputs)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        library = class_type == "MatteGrowShrink" and float(widgets.get("feather", 0)) > 0
        if library:
            row["library"] = True
        import random
        random.seed(self.seq)  # Painter's preview name (UI.PreviewImage's five random letters)
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            # (this run's temp folder, named at random, kept out of the file: Painter's missing file names it)
            row["error"] = {"type": type(e).__name__, "message": str(e).replace(WORK, "<work>")}
            self.cases.append(row)
            return
        if hasattr(ui, "as_dict"):  # Painter's UI.PreviewImage
            ui = ui.as_dict()
        row["outputs"] = [record_mask_output(t, hashed, library) if t.dim() == 3 else record_tone_output(t, hashed, None) for t in outs]
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        self.cases.append(row)


def mask_standard_pictures(g: MaskGroup) -> list:
    return [
        ("rgb 37×23", "rgb", g.picture(37, 23, 3, 1)),
        ("provider 29×31", "provider", g.picture(29, 31, 4, 2)),
        ("card 23×19 see-through", "card", g.picture(23, 19, 4, 3)),
        ("card 23×19 opaque", "card", g.picture(23, 19, 3, 4)),
    ]


def mask_cases(g: MaskGroup, classes: dict) -> None:
    pics = mask_standard_pictures(g)
    defaults = {node_id: widget_settings(cls)[0] for node_id, cls in classes.items()}
    rgb, rgb_b, big = g.picture(37, 23, 3, 1), g.picture(37, 23, 3, 5), g.picture(320, 200, 3, 6)
    prov, card4, card3 = g.picture(29, 31, 4, 2), g.picture(23, 19, 4, 3), g.picture(23, 19, 3, 4)
    # A second picture of each standard picture's size and kind (Blend's top).
    tops = {rgb: ("rgb", rgb_b), prov: ("provider", g.picture(29, 31, 4, 12)), card4: ("card", g.picture(23, 19, 4, 13)), card3: ("card", g.picture(23, 19, 3, 14))}
    # A mask of each standard picture's size.
    masks = {rgb: g.mask(37, 23, 1, "soft"), prov: g.mask(29, 31, 2, "hard"), card4: g.mask(23, 19, 3, "soft"), card3: g.mask(23, 19, 4, "hard")}

    # ── The standard set, each class with its own inputs ──
    for node_id in ("Blend", "ApplyMask", "ThresholdMask", "ColorRangeMask", "MergeAlpha"):
        cls = classes[node_id]
        _d, settings = widget_settings(cls)

        def ins(source, file):
            if node_id == "Blend":
                ts, tf = tops[file]
                return {"base": (source, [file]), "top": (ts, [tf])}
            if node_id in ("ApplyMask", "MergeAlpha"):
                return {"image": (source, [file]), "mask": ("mask", [masks[file]])}
            return {"image": (source, [file])}
        for label, over in settings:
            for pname, source, file in pics:
                g.case(f"{node_id}: {label}, {pname}", cls, node_id, {**defaults[node_id], **over}, ins(source, file))
        # A batch of two different files and a repeat; the 1×1 blank; one 320×200 (hashed).
        if node_id == "Blend":
            g.case("Blend: a batch of two files and a repeat", cls, node_id, dict(defaults[node_id], mode="overlay", opacity=0.37),
                   {"base": ("rgb", [rgb, rgb_b, rgb]), "top": ("rgb", [rgb_b, rgb, rgb_b])})
            g.case("Blend: the 1×1 blank", cls, node_id, dict(defaults[node_id], mode="screen"), {"base": ("blank", []), "top": ("rgb", [rgb])})
            g.case("Blend: the 1×1 blank on top", cls, node_id, dict(defaults[node_id], mode="multiply", opacity=0.37), {"base": ("rgb", [rgb]), "top": ("blank", [])})
            g.case("Blend: rgb 320×200", cls, node_id, dict(defaults[node_id], mode="soft_light", opacity=0.6),
                   {"base": ("rgb", [big]), "top": ("card", [g.picture(160, 100, 3, 19)])}, hashed=True)
        elif node_id in ("ApplyMask", "MergeAlpha"):
            ma, mb = g.mask(37, 23, 5, "soft"), g.mask(37, 23, 6, "hard")
            g.case(f"{node_id}: a batch of two files and a repeat", cls, node_id, dict(defaults[node_id]), {"image": ("rgb", [rgb, rgb_b, rgb]), "mask": ("mask", [ma, mb, ma])})
            g.case(f"{node_id}: the 1×1 blank", cls, node_id, dict(defaults[node_id]), {"image": ("blank", []), "mask": ("mask", [ma])})
            g.case(f"{node_id}: rgb 320×200", cls, node_id, dict(defaults[node_id]), {"image": ("rgb", [big]), "mask": ("mask", [g.mask(320, 200, 7, "soft")])}, hashed=True)
            g.case(f"{node_id}: rgb 320×200, a mask of another size", cls, node_id, dict(defaults[node_id]),
                   {"image": ("rgb", [big]), "mask": ("mask", [g.mask(97, 61, 8, "soft")])}, hashed=True)
        else:
            g.case(f"{node_id}: a batch of two files and a repeat", cls, node_id, dict(defaults[node_id]), {"image": ("rgb", [rgb, rgb_b, rgb])})
            g.case(f"{node_id}: the 1×1 blank", cls, node_id, dict(defaults[node_id]), {"image": ("blank", [])})
            over = {"softness": 0.2, "threshold": 0.45} if node_id == "ThresholdMask" else {"target_r": 0.3, "target_g": 0.5, "target_b": 0.2, "tolerance": 0.4}
            g.case(f"{node_id}: rgb 320×200", cls, node_id, dict(defaults[node_id], **over), {"image": ("rgb", [big])}, hashed=True)

    # ── Blend: every mode × opacity 0, 0.37, 1, a top of another size; batches 1:2, 2:1, 2:2, 2:3 ──
    blend = classes["Blend"]
    other = g.picture(29, 17, 3, 15)
    for mode in BLEND_MODES:
        for op in (0.0, 0.37, 1.0):
            g.case(f"Blend: {mode}, opacity {op}, a top of another size", blend, "Blend", {"mode": mode, "opacity": op}, {"base": ("rgb", [rgb]), "top": ("card", [other])})
            g.case(f"Blend: {mode}, opacity {op}, see-through base and top", blend, "Blend", {"mode": mode, "opacity": op},
                   {"base": ("card", [card4]), "top": ("provider", [g.picture(41, 27, 4, 16)])})
    g.case("Blend: batches 1:2", blend, "Blend", {"mode": "difference", "opacity": 0.8}, {"base": ("rgb", [rgb]), "top": ("card", [other, g.picture(29, 17, 3, 17)])})
    g.case("Blend: batches 2:1", blend, "Blend", {"mode": "hard_light", "opacity": 0.8}, {"base": ("rgb", [rgb, rgb_b]), "top": ("card", [other])})
    g.case("Blend: batches 2:2", blend, "Blend", {"mode": "add", "opacity": 0.5}, {"base": ("rgb", [rgb, rgb_b]), "top": ("rgb", [rgb_b, rgb])})
    g.case("Blend: batches 2:3", blend, "Blend", {"mode": "add", "opacity": 0.5}, {"base": ("rgb", [rgb, rgb_b]), "top": ("rgb", [rgb_b, rgb, rgb])})
    g.case("Blend: an RGB base under a see-through top", blend, "Blend", {"mode": "normal", "opacity": 1.0}, {"base": ("rgb", [rgb]), "top": ("provider", [prov])})
    g.case("Blend: a see-through base under an RGB top", blend, "Blend", {"mode": "lighten", "opacity": 0.5}, {"base": ("card", [card4]), "top": ("rgb", [rgb])})
    g.case("Blend: the blank under a see-through top", blend, "Blend", {"mode": "normal", "opacity": 1.0}, {"base": ("blank", []), "top": ("provider", [prov])})

    # ── ApplyMask / MergeAlpha: masks of another size, mask batches ──
    for node_id in ("ApplyMask", "MergeAlpha"):
        cls = classes[node_id]
        inv = "invert" if node_id == "ApplyMask" else "invert_mask"
        for label, m in (("a larger mask", g.mask(61, 40, 9, "soft")), ("a smaller mask", g.mask(11, 7, 10, "hard")), ("a 1×1 mask", g.mask(1, 1, 11, "soft"))):
            for iv in (False, True):
                for pname, source, file in (("rgb 37×23", "rgb", rgb), ("card 23×19 see-through", "card", card4)):
                    g.case(f"{node_id}: {label}, {inv} {iv}, {pname}", cls, node_id, {inv: iv}, {"image": (source, [file]), "mask": ("mask", [m])})
        ma, mb, mc = g.mask(37, 23, 5, "soft"), g.mask(37, 23, 6, "hard"), g.mask(37, 23, 12, "soft")
        g.case(f"{node_id}: one picture, two masks", cls, node_id, {inv: False}, {"image": ("rgb", [rgb]), "mask": ("mask", [ma, mb])})
        g.case(f"{node_id}: two pictures, one mask", cls, node_id, {inv: False}, {"image": ("rgb", [rgb, rgb_b]), "mask": ("mask", [ma])})
        g.case(f"{node_id}: two pictures, three masks", cls, node_id, {inv: False}, {"image": ("rgb", [rgb, rgb_b]), "mask": ("mask", [ma, mb, mc])})

    # ── MatteGrowShrink: the standard set over four masks, then amounts × feathers ──
    matte = classes["MatteGrowShrink"]
    _d, settings = widget_settings(matte)
    mpics = [("mask 37×23 soft", masks[rgb]), ("mask 29×31 hard", masks[prov]), ("mask 23×19 soft", masks[card4]), ("mask 23×19 hard", masks[card3])]
    for label, over in settings:
        for pname, m in mpics:
            g.case(f"MatteGrowShrink: {label}, {pname}", matte, "MatteGrowShrink", {**defaults["MatteGrowShrink"], **over}, {"mask": ("mask", [m])})
    ma, mb = g.mask(37, 23, 5, "soft"), g.mask(37, 23, 6, "hard")
    g.case("MatteGrowShrink: a batch of two files and a repeat", matte, "MatteGrowShrink", {"amount": 3.0, "feather": 1.5}, {"mask": ("mask", [ma, mb, ma])})
    g.case("MatteGrowShrink: a 1×1 mask", matte, "MatteGrowShrink", {"amount": 2.0, "feather": 0.0}, {"mask": ("mask", [g.mask(1, 1, 11, "soft")])})
    g.case("MatteGrowShrink: 320×200", matte, "MatteGrowShrink", {"amount": 4.0, "feather": 2.5}, {"mask": ("mask", [g.mask(320, 200, 7, "soft")])}, hashed=True)
    g.case("MatteGrowShrink: 320×200 hard, shrink", matte, "MatteGrowShrink", {"amount": -6.0, "feather": 0.0}, {"mask": ("mask", [g.mask(320, 200, 13, "hard")])}, hashed=True)
    wide = g.mask(200, 190, 14, "hard")
    for amount in (-50.0, -1.0, 0.0, 1.0, 50.0, 0.4, -0.4, 2.5, -2.5):
        for feather in (0.0, 0.5, 30.0):
            for pname, m in (("mask 37×23 soft", ma), ("mask 29×31 hard", masks[prov]), ("mask 200×190 hard", wide)):
                if pname.startswith("mask 200") and feather == 0.5 and amount not in (-50.0, 50.0, 1.0):
                    continue
                g.case(f"MatteGrowShrink: amount {amount}, feather {feather}, {pname}", matte, "MatteGrowShrink", {"amount": amount, "feather": feather}, {"mask": ("mask", [m])})

    # ── Painter ──
    painter_cases(g, classes["Painter"])


def painter_image(w: int, h: int, seed: int, mode: str) -> PILImage.Image:
    px = np.frombuffer(synth(w, h, 4, seed), dtype=np.uint8).reshape(h, w, 4)
    im = PILImage.fromarray(px, "RGBA")
    if mode == "RGBA":
        return im
    if mode == "RGB":
        return im.convert("RGB")
    if mode == "LA":
        return im.convert("LA")
    if mode == "P":
        p = im.convert("RGB").quantize(colors=16)
        p.info["transparency"] = 3
        return p
    raise ValueError(mode)


def painter_cases(g: MaskGroup, painter) -> None:
    pics = mask_standard_pictures(g)
    rgb, card3 = g.picture(37, 23, 3, 1), g.picture(23, 19, 3, 4)
    d = {"mask": "", "width": 512, "height": 512, "bg_color": "#000000"}
    f64 = g.painter_file("painter_64x64_rgba.png", painter_image(64, 64, 32, "RGBA"))
    f37 = g.painter_file("painter_37x23_rgba.png", painter_image(37, 23, 31, "RGBA"))
    f5070 = g.painter_file("painter_50x70_rgba.png", painter_image(50, 70, 33, "RGBA"))
    frgb = g.painter_file("painter_40x30_rgb.png", painter_image(40, 30, 34, "RGB"))
    fla = g.painter_file("painter_30x20_la.png", painter_image(30, 20, 35, "LA"))
    p = painter_image(24, 24, 36, "P")
    fp = g.painter_file("painter_24x24_p_trns.png", p, transparency=3)
    ex = PILImage.Exif()
    ex[0x0112] = 6
    fexif = g.painter_file("painter_64x128_exif6.png", painter_image(64, 128, 37, "RGBA"), exif=ex.tobytes())
    # Every widget at its default (no picture, no file: the canvas filled with bg_color).
    g.case("Painter: defaults", painter, "Painter", dict(d), {}, hashed=True)
    for name, lo, hi in (("width", 64, 4096), ("height", 64, 4096)):
        mid = int(round(lo + (hi - lo) * 0.37))
        for label, v in (("min", lo), ("max", hi), ("between", mid)):
            g.case(f"Painter: {name} {label} ({v})", painter, "Painter", {**d, name: v, "bg_color": "#3c5a78"}, {}, hashed=v * 512 > 64 * 64 * 4)
    for colour in ("#ff8000", "FF8000", "##c0ffee", "#abc", "", "#1234567", " #102030", "#A1b2C3", "#12345G", "+f-f0f", "zzzzzz", "#ff 00 0"):
        g.case(f"Painter: bg_color {colour!r}, 64×64", painter, "Painter", {**d, "width": 64, "height": 64, "bg_color": colour}, {})
    # A picture wired in, no file: the picture (its first) handed on, the mask all zero.
    for pname, source, file in pics:
        g.case(f"Painter: no file, {pname}", painter, "Painter", dict(d), {"image": (source, [file])})
    g.case("Painter: no file, a batch of two: the first", painter, "Painter", dict(d), {"image": ("rgb", [g.picture(37, 23, 3, 5), rgb])})
    g.case("Painter: no file, the 1×1 blank", painter, "Painter", dict(d), {"image": ("blank", [])})
    # A painter file, no picture.
    g.case("Painter: a file the canvas size", painter, "Painter", {**d, "mask": f64, "width": 64, "height": 64, "bg_color": "#2040ff"}, {})
    g.case("Painter: a file of another size (Lanczos)", painter, "Painter", {**d, "mask": f5070, "width": 64, "height": 64, "bg_color": "#ffffff"}, {})
    g.case("Painter: a file of another size, larger canvas", painter, "Painter", {**d, "mask": f37, "width": 128, "height": 64, "bg_color": "#808000"}, {})
    for label, f in (("RGB", frgb), ("grey and alpha", fla), ("palette with a see-through colour", fp), ("EXIF orientation 6, not turned", fexif)):
        g.case(f"Painter: a {label} file, the canvas its size", painter, "Painter", {**d, "mask": f, "width": 64, "height": 64, "bg_color": "#102030"}, {})
    g.case("Painter: an EXIF orientation 6 file of the canvas size, not turned", painter, "Painter", {**d, "mask": fexif, "width": 64, "height": 128}, {})
    # A painter file over a picture.
    g.case("Painter: a file over an rgb picture its size", painter, "Painter", {**d, "mask": f37}, {"image": ("rgb", [rgb])})
    g.case("Painter: a file over an rgb picture of another size", painter, "Painter", {**d, "mask": f64}, {"image": ("rgb", [rgb])})
    g.case("Painter: a file over an opaque card picture", painter, "Painter", {**d, "mask": f5070}, {"image": ("card", [card3])})
    g.case("Painter: a file over a see-through card picture", painter, "Painter", {**d, "mask": f5070}, {"image": ("card", [g.picture(23, 19, 4, 3)])})
    g.case("Painter: a file over a provider picture", painter, "Painter", {**d, "mask": f37}, {"image": ("provider", [g.picture(29, 31, 4, 2)])})
    g.case("Painter: a file over a batch of two: the first", painter, "Painter", {**d, "mask": f37}, {"image": ("rgb", [rgb, g.picture(37, 23, 3, 5)])})
    g.case("Painter: a file over the 1×1 blank", painter, "Painter", {**d, "mask": f37}, {"image": ("blank", [])})
    g.case("Painter: a file that isn't there", painter, "Painter", {**d, "mask": "not_there.png", "width": 64, "height": 64}, {})
    g.case("Painter: rgb 320×200 under a file (Lanczos up)", painter, "Painter", {**d, "mask": f64}, {"image": ("rgb", [g.picture(320, 200, 3, 6)])}, hashed=True)


def mask_negzero(classes: dict) -> list:
    """−0 through each node's clamps (as a Dither upstream leaves it), for the classes whose picture or mask is
    handed on as a float: every third input value −0 (every value for Threshold's soft branch, whose luma is −0
    only where all three channels are), the mask from hashed_values (with −0s of its own for Matte grow / shrink
    and one Merge alpha probe: R2.8 fix round 2)."""
    rows = []
    seed = 8000
    probes = [("Blend", {"mode": "multiply", "opacity": 0.37}, {}), ("Blend", {"mode": "normal", "opacity": 1.0}, {}), ("Blend", {"mode": "subtract", "opacity": 0.5}, {}),
              ("ApplyMask", {"invert": False}, {}), ("ApplyMask", {"invert": True}, {}), ("MergeAlpha", {"invert_mask": False}, {}),
              ("MergeAlpha", {"invert_mask": False}, {"mask_neg_zero_every": 3}),
              ("ThresholdMask", {"threshold": 0.2, "softness": 0.2, "invert": False}, {"neg_zero_every": 1}),
              ("MatteGrowShrink", {"amount": 0.0, "feather": 0.0}, {"mask_only": True}), ("MatteGrowShrink", {"amount": -1.0, "feather": 0.0}, {"mask_only": True}),
              ("MatteGrowShrink", {"amount": 2.0, "feather": 0.0}, {"mask_only": True})]
    for class_type, widgets, extra in probes:
        shapes = ((1, 23, 37, 3), (2, 23, 37, 3), (1, 120, 110, 3), (2, 61, 90, 4), (1, 61, 90, 4))
        if extra.get("mask_only"):
            shapes = ((1, 23, 37, 1), (2, 23, 37, 1), (1, 200, 190, 1), (2, 120, 160, 1))
        for shape in shapes:
            seed += 1
            spec = {"shape": list(shape), "seed": seed, "neg_zero_every": extra.get("neg_zero_every", 3)}
            b, h, w, _c = shape
            if extra.get("mask_only"):
                spec["mask_only"] = True
                v = hashed_values(b * h * w, seed)
                v[::spec["neg_zero_every"]] = -0.0
                inputs = {"mask": torch.from_numpy(v.reshape(b, h, w).copy())}
            else:
                x = warp_negzero_input(spec)
                if class_type == "Blend":
                    other = {"shape": list(shape), "seed": seed + 5000, "neg_zero_every": 3}
                    inputs = {"base": x, "top": warp_negzero_input(other)}
                    spec["top"] = other
                elif class_type == "ThresholdMask":
                    inputs = {"image": x}
                else:
                    mv = hashed_values(b * h * w, seed + 7000)
                    if extra.get("mask_neg_zero_every"):
                        mv[:: extra["mask_neg_zero_every"]] = -0.0
                        spec["mask_neg_zero_every"] = extra["mask_neg_zero_every"]
                    inputs = {"image": x, "mask": torch.from_numpy(mv.reshape(b, h, w).copy())}
                    spec["mask_seed"] = seed + 7000
            outs, _ui = run_node(classes[class_type], f"nz{seed}", **inputs, **widgets)
            t = outs[0]
            items = []
            for i in range(t.shape[0]):
                y = t[i].contiguous()
                c = 1 if y.dim() == 2 else int(y.shape[2])
                items.append({"w": int(y.shape[1]), "h": int(y.shape[0]), "c": c, "f32_sha256": sha(y.cpu().numpy().astype("<f4").tobytes()),
                              "neg_zeros": int((torch.signbit(y) & (y == 0)).sum())})
            rows.append({"name": f"{class_type} {widgets} {extra}, {'×'.join(map(str, shape))}", "class_type": class_type, "widgets": widgets, "input": spec, "items": items})
    return rows


def mask_effect_chains(g: MaskGroup, classes: dict) -> list:
    """An effect's picture read by the picture utilities that work on its float (R2.8 fix round 2): Blend →
    Image to mask → Merge alpha (or Apply mask), and Blend → Text mask's source, as ComfyUI runs them (each
    node fed the float the one before made). Each records the last node's outputs."""
    from comfy_extras.nodes_mask import ImageToMask
    from comfy_extras.nodes_text_mask import TextMaskNode
    rows = []
    rgb, rgb_b, other = g.picture(37, 23, 3, 1), g.picture(37, 23, 3, 5), g.picture(29, 17, 3, 15)
    card4, card4b = g.picture(23, 19, 4, 3), g.picture(23, 19, 4, 13)
    render = g.picture(37, 23, 3, 22)
    with open(os.path.join(WORK, "input", render), "wb") as f:
        f.write(g.assets[render])

    def blend(base, top, widgets):
        (x,), _ = run_node(classes["Blend"], "blend", base=load("card", base, g.assets[base]), top=load("card", top, g.assets[top]), **widgets)
        return x

    def row(name, blend_spec, reader, consumer, outs, ui):
        return {"name": name, "blend": blend_spec, "reader": reader, "consumer": consumer,
                "outputs": [record_mask_output(t, False, False) if t.dim() == 3 else record_tone_output(t, False, None) for t in outs],
                **({"ui": {"images": ui["images"], "animated": list(ui["animated"])}, "preview": read_preview(ui, True)} if ui else {})}

    for bw, base, top, channel, consumer, cw, pic in (
        ({"mode": "multiply", "opacity": 0.7}, rgb, rgb_b, "red", "MergeAlpha", {"invert_mask": False}, rgb),
        ({"mode": "soft_light", "opacity": 0.45}, rgb, other, "green", "ApplyMask", {"invert": True}, other),
        ({"mode": "screen", "opacity": 0.6}, card4, card4b, "alpha", "ApplyMask", {"invert": False}, rgb),
    ):
        x = blend(base, top, bw)
        m = ImageToMask.execute(x, channel).args[0]
        g.seq += 1
        node_id = f"fx{g.seq}"
        outs, ui = run_node(classes[consumer], node_id, image=load("rgb", pic, g.assets[pic]), mask=m, **cw)
        rows.append(row(f"Blend {bw['mode']} {bw['opacity']} → Image to mask ({channel}) → {consumer}", {"base": base, "top": top, "widgets": bw},
                        {"class_type": "ImageToMask", "channel": channel}, {"class_type": consumer, "node_id": node_id, "widgets": cw, "image": pic}, outs, ui))
    for bw, base, top in (({"mode": "overlay", "opacity": 0.8}, rgb, rgb_b), ({"mode": "difference", "opacity": 0.5}, card4, card4b)):
        x = blend(base, top, bw)
        res = TextMaskNode.execute(params=json.dumps({"rendered": render}), source=x)
        rows.append(row(f"Blend {bw['mode']} {bw['opacity']} → Text mask's source", {"base": base, "top": top, "widgets": bw},
                        {"class_type": "TextMask", "rendered": render}, None, list(res.args), None))
    return rows


def mask_chains(g: MaskGroup, classes: dict) -> list:
    """A mask from each producer the runner has (LoadImage's MASK, Image to mask, Threshold mask, Color
    range mask, Text mask, Painter), sometimes through Matte grow / shrink, into Apply mask and Merge alpha,
    at the picture's size and at another. As ComfyUI runs them: each node fed the float mask the one before
    made (the runner hands a mask on as its float32 tensor, R2.8 fix round 1). `kept` records the
    producer's mask (its float32 and the 16 bits it is saved as); `quantised` counts how far the old 16-bit
    hand-off (the mask fed as u / 65535) would land from Python's chain."""
    from nodes import LoadImage
    from comfy_extras.nodes_mask import ImageToMask
    from comfy_extras.nodes_text_mask import TextMaskNode
    rows = []
    same, other = g.picture(37, 23, 3, 1), g.picture(29, 17, 3, 15)
    see = g.picture(37, 23, 4, 21)
    # A 4-channel picture file for LoadImage (its MASK is 1 − alpha).
    load_file = synth_name(37, 23, 4, 21)
    with open(os.path.join(WORK, "input", load_file), "wb") as f:
        f.write(g.assets[see])
    render = g.picture(37, 23, 3, 22)
    with open(os.path.join(WORK, "input", render), "wb") as f:
        f.write(g.assets[render])
    card_file = g.picture(37, 23, 4, 3)
    painter_file = g.painter_file("painter_37x23_rgba.png", painter_image(37, 23, 31, "RGBA"))
    card = lambda: load("card", card_file, g.assets[card_file])  # noqa: E731
    producers = [
        ("LoadImage", {"class_type": "LoadImage", "file": load_file}, lambda: LoadImage().load_image(load_file)[1]),
        ("Image to mask (alpha)", {"class_type": "ImageToMask", "channel": "alpha", "image": {"source": "card", "files": [card_file]}},
         lambda: ImageToMask.execute(card(), "alpha").args[0]),
        ("Image to mask (red)", {"class_type": "ImageToMask", "channel": "red", "image": {"source": "card", "files": [card_file]}},
         lambda: ImageToMask.execute(card(), "red").args[0]),
        ("Threshold mask (soft)", {"class_type": "ThresholdMask", "widgets": {"threshold": 0.45, "softness": 0.15, "invert": False}, "image": {"source": "card", "files": [card_file]}},
         lambda: run_node(classes["ThresholdMask"], "producer", image=card(), threshold=0.45, softness=0.15, invert=False)[0][0]),
        ("Color range mask", {"class_type": "ColorRangeMask", "widgets": {"target_r": 0.6, "target_g": 0.3, "target_b": 0.5, "tolerance": 0.35, "invert": True},
                              "image": {"source": "card", "files": [same]}},
         lambda: run_node(classes["ColorRangeMask"], "producer", image=load("card", same, g.assets[same]), target_r=0.6, target_g=0.3, target_b=0.5, tolerance=0.35, invert=True)[0][0]),
        ("Text mask", {"class_type": "TextMask", "rendered": render}, lambda: TextMaskNode.execute(params=json.dumps({"rendered": render})).args[1]),
        ("Painter", {"class_type": "Painter", "widgets": {"mask": painter_file, "width": 64, "height": 64, "bg_color": "#000000"}},
         lambda: run_node(classes["Painter"], "producer", mask=painter_file, width=64, height=64, bg_color="#000000")[0][1]),
    ]
    middles = {"Threshold mask (soft)": [None, {"amount": -2.0, "feather": 0.0}], "Text mask": [None, {"amount": 3.0, "feather": 0.0}], "LoadImage": [None, {"amount": 1.0, "feather": 0.0}]}
    consumers = [("ApplyMask", {"invert": False}), ("MergeAlpha", {"invert_mask": True})]

    def chain_row(name, producer, middle, m_prod, m, consumer, widgets, pic, hashed):
        img = load("rgb", pic, g.assets[pic])
        q = quantise16(m[0])
        g.seq += 1
        node_id = f"fx{g.seq}"
        outs, ui = run_node(classes[consumer], node_id, image=img, mask=m, **widgets)
        fed = torch.from_numpy(q.astype(np.float32) / np.float32(65535.0))[None]
        old, _ = run_node(classes[consumer], f"{node_id}q", image=img, mask=fed, **widgets)
        a, b = outs[0][0], old[0][0]
        pq = quantise16(m_prod[0])
        return {"name": name, "producer": producer, "middle": middle,
                "kept": {"f32_sha256": sha(m_prod[0].contiguous().cpu().numpy().astype("<f4").tobytes()), "u16_sha256": sha(pq.astype("<u2").tobytes()),
                         "w": int(pq.shape[1]), "h": int(pq.shape[0])},
                "class_type": consumer, "node_id": node_id, "widgets": widgets, "inputs": {"image": {"source": "rgb", "files": [pic]}},
                "outputs": [record_tone_output(outs[0], hashed, None)], "ui": {"images": ui["images"], "animated": list(ui["animated"])},
                "preview": read_preview(ui, True),
                "quantised": {"values": int(a.numel()), "f32": int((a != b).sum()), "round8": int((round8(a) != round8(b)).sum()), "trunc8": int((trunc8(a) != trunc8(b)).sum())}}

    for label, producer, make in producers:
        m_prod = make()
        for middle in middles.get(label, [None]):
            m = m_prod if middle is None else run_node(classes["MatteGrowShrink"], "middle", mask=m_prod, **middle)[0][0]
            via = "" if middle is None else f" → Matte grow / shrink {middle['amount']}"
            for consumer, widgets in consumers:
                for size, pic in (("same size", same), ("another size", other)):
                    if consumer == "MergeAlpha" and size == "another size" and label not in ("Text mask", "Painter"):
                        continue
                    rows.append(chain_row(f"{label}{via} → {consumer}, {size}", producer, middle, m_prod, m, consumer, widgets, pic, False))
    # Threshold mask → Apply mask, the brief's chain, on the 320×200 picture too (hashed).
    big = g.picture(320, 200, 3, 6)
    x = load("rgb", big, g.assets[big])
    for soft in (0.0, 0.2):
        (m,), _ = run_node(classes["ThresholdMask"], "producer", image=x, threshold=0.5, softness=soft, invert=False)
        producer = {"class_type": "ThresholdMask", "widgets": {"threshold": 0.5, "softness": soft, "invert": False}, "image": {"source": "card", "files": [big]}}
        rows.append(chain_row(f"Threshold mask (softness {soft}) → ApplyMask, rgb 320×200", producer, None, m, m, "ApplyMask", {"invert": False}, big, True))
    return rows


def mask_classes() -> dict:
    return {node_id: node_class(module, node_id) for module, node_id in MASK_CLASSES}


def mask() -> dict:
    g = MaskGroup()
    classes = mask_classes()
    mask_cases(g, classes)
    chains = mask_chains(g, classes)
    # An effect into a Frame: Blend's float tensor on the Frame's layer 1.
    frame = mask_frame_chain(g, classes["Blend"])
    effect_chains = mask_effect_chains(g, classes)
    return {"cases": g.cases, "chains": chains, "effect_chains": effect_chains, "negzero": mask_negzero(classes), "frame": frame,
            "assets": {k: b64(v) for k, v in sorted(g.assets.items())}}


def mask_frame_chain(g: MaskGroup, blend) -> dict:
    """Blend (overlay 0.6, see-through card base, a see-through card top of another size) into a Frame's layer 1: the Frame
    gets the float tensor; its 8-bit result as save_live_preview writes it."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_compositor as nc
    base, top = g.picture(23, 19, 4, 3), g.picture(41, 27, 4, 16)
    widgets = {"mode": "overlay", "opacity": 0.6}
    g.seq += 1
    node_id = f"fx{g.seq}"
    outs, _ui = run_node(blend, node_id, base=load("card", base, g.assets[base]), top=load("card", top, g.assets[top]), **widgets)
    fw = {"layer1_x": 0.0, "layer1_y": 0.0, "layer1_rotation": 10.0, "layer1_scale": 0.8, "layer1_opacity": 1.0,
          "layer1_blend": "normal", "layer1_z": 1.0, "layer1_protect": False, "layer1_cloner": "", "width": 0, "height": 0, "motion_params": ""}
    previews = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "frame"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        res = nc.CompositorNode.execute(layer1=outs[0], **fw)
    image = res.result[0]
    return {"name": "Blend overlay 0.6 → Frame, card", "inputs": {"base": {"source": "card", "files": [base]}, "top": {"source": "card", "files": [top]}},
            "effect": {"class_type": "Blend", "node_id": node_id, "widgets": widgets},
            "frame": {"widgets": fw, "w": int(image.shape[2]), "h": int(image.shape[1]), "image8": b64(trunc8(image[0]).tobytes())}}


# `--group mask --sweep`: MatteGrowShrink's feather (the group's one library step) over fresh masks,
# measured by the spec against the TypeScript port (the file handed over lives in this run's temp
# directory). Writes nothing into the repo.
MASK_SWEEP_SEEDS = 60


def mask_sweep_run() -> int:
    import subprocess
    matte = mask_classes()["MatteGrowShrink"]
    rs = np.random.default_rng(2808)
    cases = []
    sizes = [(41, 29), (64, 48), (97, 61), (160, 100), (200, 190), (320, 200), (400, 380)]
    for i in range(MASK_SWEEP_SEEDS):
        w, h = sizes[int(rs.integers(0, len(sizes)))]
        seed = int(rs.integers(1, 2 ** 31))
        kind = "hard" if rs.integers(0, 2) else "soft"
        feather = float(round(rs.uniform(0.5, min(30.0, (min(w, h) - 1) / 3.0 - 0.34)), 2))
        amount = float(round(rs.uniform(-50, 50), 1)) if rs.integers(0, 3) else 0.0
        q = synth_mask(w, h, seed, kind)
        m = torch.from_numpy(q.astype(np.float32) / np.float32(65535.0))[None]
        row = {"w": w, "h": h, "seed": seed, "kind": kind, "widgets": {"amount": amount, "feather": feather}}
        try:
            (out,), _ui = run_node(matte, f"sw{i}", mask=m, amount=amount, feather=feather)
            row["f32s"] = shuffled_f32(out[0])
        except Exception as e:  # noqa: BLE001
            row["error"] = str(e)
        cases.append(row)
    # The widest feather (σ 30, a 181-tap kernel) on large masks, hard and soft: torch's conv2d sums 181² taps a value.
    for i, (w, h, kind, amount) in enumerate(((640, 640, "hard", 0.0), (800, 600, "soft", -7.0), (1024, 1024, "hard", 12.0))):
        seed = int(rs.integers(1, 2 ** 31))
        q = synth_mask(w, h, seed, kind)
        m = torch.from_numpy(q.astype(np.float32) / np.float32(65535.0))[None]
        (out,), _ui = run_node(matte, f"swl{i}", mask=m, amount=amount, feather=30.0)
        cases.append({"w": w, "h": h, "seed": seed, "kind": kind, "widgets": {"amount": amount, "feather": 30.0}, "f32s": shuffled_f32(out[0])})
    path = os.path.join(WORK, "mask-sweep.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    print(f"mask ε sweep: {len(cases)} cases, {sum(1 for c in cases if 'error' in c)} Python raises")
    env = {k: v for k, v in os.environ.items() if k not in PROVIDER_KEYS}
    env["MASK_SWEEP_FILE"] = path
    r = subprocess.run(["npx", "vitest", "run", "tests/unit/runner-effects-mask.unit.spec.ts", "-t", "the mask ε sweep", "--testTimeout=600000", "--reporter=verbose"],
                       cwd=os.path.join(ROOT, "frontend"), env=env, capture_output=True, text=True)
    for line in (r.stdout + r.stderr).splitlines():
        if "mask ε" in line or "Tests " in line or "FAIL" in line or "Error" in line:
            print(line)
    return r.returncode


# ── Group `noise` (R2.9): generators, seeded looks and Add noise ─────────────

NOISE_CLASSES = [
    ("nodes_glsl_atmosphere", "FilmGrain"), ("nodes_glsl_distortion", "Glitch"),
    ("nodes_glsl_generative", "PerlinNoise"), ("nodes_glsl_generative", "Voronoi"), ("nodes_glsl_generative", "GradientGenerator"),
    ("nodes_glsl_lab", "PaletteQuantize"), ("nodes_glsl_fractal", "ReactionDiffusion"), ("nodes_glsl_fractal", "Fractal"),
    ("nodes_glsl_unicorn", "Stipple"), ("nodes_glsl_unicorn", "FlowField"), ("nodes_sharpen_noise", "AddNoise"),
]
NOISE_GENERATORS = ("PerlinNoise", "Voronoi", "GradientGenerator", "ReactionDiffusion", "Fractal")
# The library classes: their ε (255-scale), measured (fixture and `--sweep`), at most 2⁻⁸. A small output keeps its
# float (`f32s`, byte-shuffled, zlib), a hashed one its band at the class's ε. tests/unit/runner-effects-noise
# .unit.spec.ts holds the same table.
# Measured worst |Δ|·255 (R2.9 report, fixture and --sweep): FilmGrain 3.0e-5, AddNoise 1.5e-5, Fractal 1.5e-5, PaletteQuantize 0
# (bit-exact on every case measured; kept library for its means).
NOISE_LIBRARY_EPS = {"FilmGrain": 2.0 ** -13, "Fractal": 2.0 ** -13, "PaletteQuantize": 2.0 ** -13, "AddNoise": 2.0 ** -13}
# The "warp" parity class (R2.7 amendment): FlowField's flow is torch's float cos / sin (SLEEF u10) into grid_sample.
NOISE_WARP_CLASSES = ("FlowField",)
# Add noise draws from torch's global generator: each fixture case seeds it just before execute.
NOISE_GLOBAL_SEED = 7
# The fixed picture Add noise's statistics are measured on: 256 × 256 RGB, a smooth mid-grey ramp
# 96 + floor(64·(x + y) / 510) on every channel (the spec rebuilds it).
NOISE_STATS_SIDE = 256
NOISE_STATS_SEED = 11
# Store every small float (not only the library classes'): for debugging a port, never committed.
NOISE_DEBUG_FLOATS = bool(os.environ.get("NOISE_DEBUG_FLOATS"))


def noise_output(t: torch.Tensor, hashed: bool, class_type: str) -> dict:
    """One output, frame by frame: its sha256s (float32, round8, trunc8); a library class's small float (`f32s`) or
    hashed band at its ε; the warp class as warp_output keeps it (small: `f32s`; hashed: round8z, trunc8_off, windows)."""
    eps = NOISE_LIBRARY_EPS.get(class_type)
    warp = class_type in NOISE_WARP_CLASSES
    items = []
    for i in range(t.shape[0]):
        x = t[i].contiguous()
        f32 = x.cpu().numpy().astype("<f4").tobytes()
        item = {"w": int(x.shape[1]), "h": int(x.shape[0]), "c": int(x.shape[2]), "f32_sha256": sha(f32),
                "round8_sha256": sha(round8(x).tobytes()), "trunc8_sha256": sha(trunc8(x).tobytes())}
        if warp and hashed:
            r8, t8 = round8(x), trunc8(x)
            off = (r8.astype(np.int16) - t8.astype(np.int16)).reshape(-1)
            assert off.min() >= 0 and off.max() <= 1
            item["round8z"] = b64(zlib.compress(r8.tobytes(), 9))
            item["trunc8_off"] = b64(zlib.compress(np.packbits(off.astype(np.uint8)).tobytes(), 9))
            item["windows"] = warp_windows(x)
        elif eps is not None and hashed:
            item["band"] = band_list(x, eps)
        elif warp or eps is not None or (NOISE_DEBUG_FLOATS and not hashed):
            item["f32s"] = shuffled_f32(x)
        items.append(item)
    return {"kind": "image", "items": items}


class NoiseGroup(Group):
    """The noise group's cases (noise_output). A generator case has no inputs. Add noise's cases name the global
    seed torch was given just before execute (`global_seed`)."""

    def case(self, name: str, cls, class_type: str, widgets: dict, inputs: dict, hashed: bool = False, global_seed: int | None = None) -> None:
        self.seq += 1
        node_id = f"fx{self.seq}"
        tensors = {}
        for key, (source, files) in inputs.items():
            tensors[key] = load("blank", None, None) if source == "blank" else torch.cat([load(source, f, self.assets[f]) for f in files], dim=0)
        row: dict = {"name": name, "class_type": class_type, "node_id": node_id, "widgets": widgets,
                     "inputs": {k: {"source": s, "files": list(f)} for k, (s, f) in inputs.items()}}
        if hashed:
            row["hashed"] = True
        if class_type == "AddNoise":
            global_seed = NOISE_GLOBAL_SEED if global_seed is None else global_seed
            row["global_seed"] = global_seed
            torch.manual_seed(global_seed)
        try:
            outs, ui = run_node(cls, node_id, **tensors, **widgets)
        except Exception as e:  # Python raises: the runner's plain message is checked against it
            row["error"] = {"type": type(e).__name__, "message": str(e)}
            self.cases.append(row)
            return
        row["outputs"] = [noise_output(t, hashed, class_type) for t in outs]
        row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
        row["preview"] = read_preview(ui, True)
        self.cases.append(row)


def generator_cases(g: NoiseGroup, cls, class_type: str) -> None:
    """Every widget at its min, its max and one value between (the others at their defaults, on a 64² picture); the
    defaults at 64², at the node's own size and at the largest (hashed); seeds 0, 1 and 2³¹ − 1."""
    defaults, settings = widget_settings(cls)
    small = {"width": 64, "height": 64}
    top = cls.INPUT_TYPES()["required"]["width"][1]["max"]
    for label, over in settings:
        if label == "defaults":
            continue
        sized = {**defaults, **small, **over}
        g.case(f"{class_type}: {label}, 64²", cls, class_type, sized, {})
    g.case(f"{class_type}: defaults, 64²", cls, class_type, {**defaults, **small}, {})
    g.case(f"{class_type}: defaults, {defaults['width']}×{defaults['height']}", cls, class_type, dict(defaults), {})
    g.case(f"{class_type}: defaults, {top}²", cls, class_type, {**defaults, "width": top, "height": top}, {}, hashed=True)
    g.case(f"{class_type}: 64 × {top}", cls, class_type, {**defaults, "width": 64, "height": top}, {})
    if "seed" in defaults:
        for s in (0, 1, 2 ** 31 - 1):
            g.case(f"{class_type}: seed {s}, 64²", cls, class_type, {**defaults, **small, "seed": s}, {})


def noise_frame_chain(g: NoiseGroup, cls, class_type: str, widgets: dict, file: str) -> dict:
    """An effect on a see-through card picture into a Frame's layer 1 (tone_frame_chain)."""
    return tone_frame_chain(g, cls, class_type, widgets, file)


def noise_stats(cls) -> list:
    """Add noise on the fixed mid-grey ramp, each type, mono and colour, under NOISE_STATS_SEED: per-channel means of
    the output and the standard deviation of (output − input), in double."""
    s = NOISE_STATS_SIDE
    y, x = np.meshgrid(np.arange(s), np.arange(s), indexing="ij")
    v = (96 + (64 * (x + y)) // 510).astype(np.uint8)
    img = torch.from_numpy(np.repeat(v[:, :, None], 3, axis=2).astype(np.float32) / np.float32(255.0))[None]
    rows = []
    for type_ in ("gaussian", "uniform"):
        for mono in (False, True):
            torch.manual_seed(NOISE_STATS_SEED)
            (out,), _ui = run_node(cls, "stats", image=img, amount=0.1, type=type_, monochromatic=mono)
            o = out[0].double().numpy()
            d = (out[0] - img[0]).double().numpy()
            rows.append({"type": type_, "monochromatic": mono, "amount": 0.1, "global_seed": NOISE_STATS_SEED,
                         "means": [float(o[..., k].mean()) for k in range(3)], "std": float(d.std())})
    return rows


def winograd_cases() -> list:
    """F.conv2d of a depthwise 3 × 3 kernel on its own (torch's Winograd3x3Depthwise path on this Mac): the laplacian
    and random kernels, odd sizes, padding 0 and 1, three channels grouped, a batch of two. Inputs (B, C, H, W) from
    `hashed_values`, kernels as listed; outputs planar float32 (stored when small, else a sha256)."""
    import torch.nn.functional as F
    lap = [0.0, 1.0, 0.0, 1.0, -4.0, 1.0, 0.0, 1.0, 0.0]
    out = []
    specs = [
        ((1, 1, 3, 3), 0), ((1, 1, 4, 4), 1), ((1, 1, 5, 7), 0), ((1, 1, 5, 7), 1), ((1, 1, 21, 18), 0), ((1, 1, 21, 18), 1),
        ((1, 1, 66, 66), 1), ((1, 3, 19, 23), 1), ((1, 3, 19, 23), 0), ((2, 3, 13, 17), 1), ((2, 1, 64, 80), 1), ((1, 1, 130, 257), 1),
    ]
    n = 0
    for shape, pad in specs:
        for kname in ("laplacian", "random"):
            for lo, hi in ((0.0, 1.0), (-2.0, 3.0)):
                n += 1
                b, c, h, w = shape
                v = hashed_values(b * c * h * w, 100 + n, lo, hi)
                # Signed zeros (the bias add of +0 turns a −0 product into +0) and a flat run of zeros.
                if lo < 0:
                    v[:: 5] = -0.0
                    v[: min(len(v), 2 * w)] = 0.0
                x = torch.from_numpy(v.reshape(b, c, h, w).copy())
                kern = [lap] * c if kname == "laplacian" else [[float(v) for v in hashed_values(9, 900 + n * 7 + j, -3.0, 3.0)] for j in range(c)]
                wt = torch.tensor(kern, dtype=torch.float32).view(c, 1, 3, 3)
                backend = torch._C._select_conv_backend(x, wt, None, [1, 1], [pad, pad], [1, 1], False, [0, 0], c, None)
                assert "Winograd3x3Depthwise" in str(backend), backend
                y = F.conv2d(x, wt, padding=pad, groups=c)
                raw = planar_bytes(y)
                row = {"name": f"{kname} {b}×{c}×{h}×{w} pad {pad} [{lo}, {hi}]", "shape": list(shape), "seed": 100 + n, "lo": lo, "hi": hi, "zeros": lo < 0,
                       "pad": pad, "kernels": kern, "out_shape": list(y.shape), "f32_sha256": sha(raw)}
                if y.numel() <= KERNEL_STORE_MAX:
                    row["f32"] = b64(raw)
                out.append(row)
    return out


def noise_classes() -> dict:
    return {node_id: node_class(module, node_id) for module, node_id in NOISE_CLASSES}


def noise() -> dict:
    g = NoiseGroup()
    classes = noise_classes()
    for node_id, cls in classes.items():
        if node_id in NOISE_GENERATORS:
            generator_cases(g, cls, node_id)
        else:
            standard_cases(g, cls, node_id)
    pics = {"rgb": g.picture(37, 23, 3, 1), "rgb_b": g.picture(37, 23, 3, 5), "prov": g.picture(29, 31, 4, 2),
            "card4": g.picture(23, 19, 4, 3), "big": g.picture(320, 200, 3, 6)}
    # Glitch: slices past the picture's height (slice_h = 1).
    short = g.picture(40, 9, 3, 21)
    for s in (2, 60):
        g.case(f"Glitch: slices {s} on 40×9", classes["Glitch"], "Glitch", {"intensity": 0.8, "slices": s, "seed": 3}, {"image": ("rgb", [short])})
    g.case("Glitch: a batch of two (the same shifts)", classes["Glitch"], "Glitch", {"intensity": 0.6, "slices": 7, "seed": 9}, {"image": ("rgb", [pics["rgb"], pics["rgb_b"]])})
    # PaletteQuantize: a batch of two (one k-means over both pictures' samples), colours 2 and 32, iterations 1 and 20.
    mid_a, mid_b = g.picture(120, 100, 3, 31), g.picture(120, 100, 3, 32)
    for colors in (2, 32):
        for its in (1, 20):
            w = {"colors": colors, "iterations": its, "seed": 5}
            g.case(f"PaletteQuantize: batch of two 37×23, colours {colors}, iterations {its}", classes["PaletteQuantize"], "PaletteQuantize", w, {"image": ("rgb", [pics["rgb"], pics["rgb_b"]])})
            g.case(f"PaletteQuantize: 37×23, colours {colors}, iterations {its}", classes["PaletteQuantize"], "PaletteQuantize", w, {"image": ("rgb", [pics["rgb"]])})
            g.case(f"PaletteQuantize: 37×23 (b), colours {colors}, iterations {its}", classes["PaletteQuantize"], "PaletteQuantize", w, {"image": ("rgb", [pics["rgb_b"]])})
    g.case("PaletteQuantize: batch of two 120×100", classes["PaletteQuantize"], "PaletteQuantize", {"colors": 12, "iterations": 8, "seed": 2}, {"image": ("rgb", [mid_a, mid_b])})
    g.case("PaletteQuantize: see-through card, colours 32", classes["PaletteQuantize"], "PaletteQuantize", {"colors": 32, "iterations": 6, "seed": 1}, {"image": ("card", [pics["card4"]])})
    # Stipple: a batch of two (rand over (b, sh, sw)), invert off and on; its colour text.
    for inv in (False, True):
        g.case(f"Stipple: batch of two, invert {inv}", classes["Stipple"], "Stipple",
               {"density": 9, "dot_size": 1.4, "gamma": 1.0, "dot_color": "#000000", "bg_color": "#ffffff", "seed": 4, "invert": inv},
               {"image": ("rgb", [pics["rgb"], pics["rgb_b"]])})
    for dc, bc in (("#f00", "zz"), (" #102030 ", "#abcdef"), ("", "#0000ff"), ("12345", "#ffe8c4")):
        g.case(f"Stipple: colours {dc!r} on {bc!r}", classes["Stipple"], "Stipple",
               {"density": 12, "dot_size": 2.0, "gamma": 0.6, "dot_color": dc, "bg_color": bc, "seed": 8, "invert": False}, {"image": ("rgb", [pics["rgb"]])})
    g.case("Stipple: 320×200, density 80, gamma 2.2", classes["Stipple"], "Stipple",
           {"density": 80, "dot_size": 3.0, "gamma": 2.2, "dot_color": "#224466", "bg_color": "#fafafa", "seed": 77, "invert": True}, {"image": ("rgb", [pics["big"]])}, hashed=True)
    # ReactionDiffusion 64² at 50 and 600 iterations, other feeds.
    rd = classes["ReactionDiffusion"]
    for its in (50, 600):
        for feed, kill in ((0.04, 0.06), (0.035, 0.065), (0.022, 0.051)):
            g.case(f"ReactionDiffusion: 64², {its} iterations, feed {feed}, kill {kill}", rd, "ReactionDiffusion",
                   {"width": 64, "height": 64, "feed": feed, "kill": kill, "iterations": its, "seed": 1}, {})
    g.case("ReactionDiffusion: 72 × 136, 3000 iterations", rd, "ReactionDiffusion", {"width": 72, "height": 136, "feed": 0.03, "kill": 0.062, "iterations": 3000, "seed": 9}, {})
    # Fractal in both types, zoom 1 and 10 000, max_iter 16 and 512.
    fr = classes["Fractal"]
    fd = widget_settings(fr)[0]
    for type_ in ("mandelbrot", "julia"):
        for zoom in (1.0, 10000.0):
            for mi in (16, 512):
                g.case(f"Fractal: {type_}, zoom {zoom}, max_iter {mi}, 64²", fr, "Fractal", {**fd, "width": 64, "height": 64, "type": type_, "zoom": zoom, "max_iter": mi}, {})
    g.case("Fractal: julia, 200 × 120, zoom 3", fr, "Fractal", {**fd, "type": "julia", "width": 200, "height": 120, "zoom": 3.0, "center_x": 0.1}, {})
    # Add noise under manual_seed(7) and (8), each type, mono and colour.
    an = classes["AddNoise"]
    for s in (7, 8):
        for type_ in ("gaussian", "uniform"):
            for mono in (False, True):
                for pname, src, f in (("rgb 37×23", "rgb", pics["rgb"]), ("provider 29×31", "provider", pics["prov"])):
                    g.case(f"AddNoise: seed {s}, {type_}, mono {mono}, {pname}", an, "AddNoise", {"amount": 0.3, "type": type_, "monochromatic": mono},
                           {"image": (src, [f])}, global_seed=s)
            g.case(f"AddNoise: seed {s}, {type_}, a batch of two and a repeat", an, "AddNoise", {"amount": 0.2, "type": type_, "monochromatic": False},
                   {"image": ("rgb", [pics["rgb"], pics["rgb_b"], pics["rgb"]])}, global_seed=s)
    # FilmGrain: sizes around 1, and a batch.
    fg = classes["FilmGrain"]
    for size in (0.99, 1.0, 1.01, 2.5):
        for pname, src, f in (("rgb 37×23", "rgb", pics["rgb"]), ("the 1×1 blank", "blank", None)):
            g.case(f"FilmGrain: size {size}, {pname}", fg, "FilmGrain", {"amount": 0.5, "size": size, "seed": 3}, {"image": (src, [f] if f else [])})
    g.case("FilmGrain: size 0.97 on 23×19", fg, "FilmGrain", {"amount": 0.5, "size": 0.97, "seed": 3}, {"image": ("card", [pics["card4"]])})
    # FlowField: a batch (the same field for each picture).
    g.case("FlowField: a batch of two", classes["FlowField"], "FlowField", {"strength": 0.3, "scale": 9.0, "rotation": 45.0, "seed": 6}, {"image": ("rgb", [pics["rgb"], pics["rgb_b"]])})
    frame = noise_frame_chain(g, classes["Glitch"], "Glitch", {"intensity": 0.7, "slices": 5, "seed": 2}, pics["card4"])
    return {"cases": g.cases, "library_eps": NOISE_LIBRARY_EPS, "warp_classes": list(NOISE_WARP_CLASSES), "winograd": winograd_cases(),
            "stats": noise_stats(an), "frame": frame, "assets": {k: b64(v) for k, v in sorted(g.assets.items())}}


# `--group noise --sweep`: the library classes' ε and FlowField's warp bounds over fresh pictures and settings,
# then FlowField up to 8192², measured by the spec against the TypeScript port. Writes nothing into the repo.
NOISE_SWEEP_SEEDS = 40
NOISE_SWEEP_SIZES = [(41, 29), (37, 31), (29, 37), (64, 48), (97, 61), (160, 100), (320, 200), (511, 257)]
NOISE_SWEEP_LARGE = [(2048, 3), (4096, 2), (8192, 1)]


def noise_spec_run(env_key: str, path: str, title: str) -> tuple[int, list]:
    import subprocess
    env = {k: v for k, v in os.environ.items() if k not in PROVIDER_KEYS}
    env[env_key] = path
    r = subprocess.run(["npx", "vitest", "run", "tests/unit/runner-effects-noise.unit.spec.ts", "-t", title, "--testTimeout=1800000", "--reporter=verbose"],
                       cwd=os.path.join(ROOT, "frontend"), env=env, capture_output=True, text=True)
    lines = [ln for ln in (r.stdout + r.stderr).splitlines() if "noise ε" in ln or "noise large" in ln or "Tests " in ln or "FAIL" in ln or "Error" in ln]
    return r.returncode, lines


def noise_sweep_run() -> int:
    classes = noise_classes()
    rs = np.random.default_rng(2909)
    cases = []
    for node_id in ("FilmGrain", "PaletteQuantize", "AddNoise", "FlowField", "Fractal"):
        cls = classes[node_id]
        types = cls.INPUT_TYPES()["required"]
        for i in range(NOISE_SWEEP_SEEDS):
            w, h = NOISE_SWEEP_SIZES[int(rs.integers(0, len(NOISE_SWEEP_SIZES)))]
            c = 3 if rs.integers(0, 3) else 4
            seed = int(rs.integers(1, 2 ** 31))
            widgets = sweep_widgets(rs, {k: v for k, v in types.items() if v[0] != "IMAGE"})
            for k, v in types.items():
                if v[0] == "BOOLEAN":
                    widgets[k] = bool(rs.integers(0, 2))
                elif v[0] == "STRING":
                    widgets[k] = v[1].get("default", "")
            if "seed" in widgets:
                widgets["seed"] = int(rs.integers(0, 2 ** 31))
            row = {"class_type": node_id, "widgets": widgets, "w": w, "h": h, "c": c, "seed": seed}
            inputs = {}
            if node_id == "Fractal":
                widgets.update({"width": w, "height": h})
                row["c"] = 3
            else:
                px = np.frombuffer(synth(w, h, c, seed), dtype=np.uint8).reshape(1, h, w, c)
                inputs["image"] = torch.from_numpy(px.astype(np.float32) / 255.0)
            if node_id == "FilmGrain":
                widgets["size"] = max(1.0, widgets["size"])
            if node_id == "AddNoise":
                row["global_seed"] = int(rs.integers(0, 2 ** 31))
                torch.manual_seed(row["global_seed"])
            try:
                outs, _ui = run_node(cls, f"sw{len(cases)}", **inputs, **widgets)
                t = outs[0][0]
                row.update({"ow": int(t.shape[1]), "oh": int(t.shape[0]), "oc": int(t.shape[2]), "f32s": shuffled_f32(t)})
            except Exception as e:  # noqa: BLE001
                row["error"] = str(e)
            cases.append(row)
    path = os.path.join(WORK, "noise-sweep.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    print(f"noise ε sweep, small: {len(cases)} cases, {sum(1 for c in cases if 'error' in c)} Python raises")
    code, lines = noise_spec_run("NOISE_SWEEP_FILE", path, "the noise ε sweep")
    print("\n".join(lines))
    # Large: FlowField up to 8192² (the largest picture an effect takes), one file at a time.
    rs = np.random.default_rng(2910)
    cls = classes["FlowField"]
    types = {k: v for k, v in cls.INPUT_TYPES()["required"].items() if v[0] != "IMAGE"}
    rows, files = [], []
    for side, seeds in NOISE_SWEEP_LARGE:
        for j in range(seeds):
            seed = int(rs.integers(1, 2 ** 31))
            widgets = sweep_widgets(rs, types, at_max=(j == 0))
            widgets["seed"] = int(rs.integers(0, 2 ** 31))
            x = torch.from_numpy(big_pixels(side, side, 3, seed).astype(np.float32)[None] / np.float32(255.0))
            outs, _ui = run_node(cls, f"big{len(files)}", image=x, **widgets)
            t = outs[0][0].contiguous()
            fpath = os.path.join(WORK, f"noise-large-{len(files)}.f32")
            t.cpu().numpy().astype("<f4").tofile(fpath)
            files.append(fpath)
            rows.append({"class_type": "FlowField", "widgets": widgets, "w": side, "h": side, "c": 3, "seed": seed, "file": fpath})
            del outs, t, x
    lpath = os.path.join(WORK, "noise-large.json")
    with open(lpath, "w", encoding="utf-8") as f:
        json.dump({"cases": rows}, f)
    c2, lines = noise_spec_run("NOISE_SWEEP_LARGE_FILE", lpath, "the noise large sweep")
    print("\n".join(lines))
    for fp in files:
        os.remove(fp)
    return code or c2


GROUPS = {"machinery": machinery, "kernels": kernels, "rng": rng, "tone": tone, "blur": blur, "cells": cells, "warp": warp, "mask": mask, "noise": noise}


def blur_sweep_run() -> int:
    """`--group blur --sweep`: the whole ε sweep, measured by the spec against the TypeScript port
    (the file handed over lives in this run's temp directory); prints each class's worst |Δ| and ε.
    Writes nothing into the repo."""
    import subprocess
    classes = {node_id: node_class(module, node_id) for module, node_id in BLUR_CLASSES}
    cases = blur_sweep(classes)
    path = os.path.join(WORK, "blur-sweep.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f)
    seeds = sum(1 for c in cases if "gen" in c)
    print(f"ε sweep: {len(cases)} cases ({seeds} seeds, {len(cases) - seeds} of the reviewer's), {sum(1 for c in cases if 'error' in c)} Python raises")
    env = {k: v for k, v in os.environ.items() if k not in PROVIDER_KEYS}
    env["BLUR_SWEEP_FILE"] = path
    r = subprocess.run(["npx", "vitest", "run", "tests/unit/runner-effects-blur.unit.spec.ts", "-t", "the ε sweep|each class's ε", "--testTimeout=60000", "--reporter=verbose"],
                       cwd=os.path.join(ROOT, "frontend"), env=env, capture_output=True, text=True)
    out = r.stdout + r.stderr
    for line in out.splitlines():
        if line.startswith("  ") and ": ε " in line or "Tests " in line or " × " in line or "blur ε" in line:
            print(line)
    return r.returncode


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", required=True, choices=sorted(GROUPS))
    ap.add_argument("--sweep", action="store_true", help="blur, warp, mask and noise only: run the whole ε sweep, print each class's worst |Δ|; writes nothing")
    args = ap.parse_args()
    check_threads()
    if args.sweep:
        if args.group not in ("blur", "warp", "mask", "noise"):
            ap.error("--sweep is the blur, warp, mask and noise groups'")
        runs = {"blur": blur_sweep_run, "warp": warp_sweep_run, "mask": mask_sweep_run, "noise": noise_sweep_run}
        sys.exit(runs[args.group]())
    body = GROUPS[args.group]()
    doc = {
        "note": f"Written by scripts/runner_effects_fixtures.py --group {args.group} from the real nodes. Do not edit.",
        "torch": torch.__version__,
        "threads": torch.get_num_threads(),
        "platform": f"{platform.system()} {platform.machine()}",
        "band_eps": BAND_EPS,
        **body,
    }
    out = os.path.join(FIXTURES, f"runner-effects-{args.group}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(body.get('cases', []))} cases → {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
