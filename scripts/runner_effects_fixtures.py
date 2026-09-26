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
import base64
import hashlib
import io
import json
import math
import os
import platform
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
# most 2⁻⁸) is at least twice the worst |Δ| measured against the TypeScript port over this group
# (R2.5 report); tests/unit/runner-effects-blur.unit.spec.ts holds the same table. A hashed case's
# band (and a kept preview's) is recorded at its class's ε.
BLUR_LIBRARY_EPS = {
    "Sharpen": 2.0 ** -8, "Denoise": 2.0 ** -8, "AdjustGlow": 2.0 ** -8, "HighPass": 2.0 ** -8, "Emboss": 2.0 ** -8,
    "FindEdges": 2.0 ** -8, "Blur": 2.0 ** -8, "Bokeh": 2.0 ** -8, "TiltShift": 2.0 ** -8, "FrequencySeparation": 2.0 ** -8,
    "HeightmapRelief": 2.0 ** -8, "Outline": 2.0 ** -8, "Sparkle": 2.0 ** -8,
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
    return {"cases": g.cases, "assets": {k: b64(v) for k, v in sorted(g.assets.items())},
            "library_eps": BLUR_LIBRARY_EPS, "motion_kernels": kernels, "frame": frame}


GROUPS = {"machinery": machinery, "kernels": kernels, "rng": rng, "tone": tone, "blur": blur}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", required=True, choices=sorted(GROUPS))
    args = ap.parse_args()
    check_threads()
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
