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
    """A (1, C, H, W) tensor from its spec: planar values, then the memory format."""
    c, h, w = spec["shape"]
    v = hashed_values(c * h * w, spec["seed"], spec.get("lo", 0.0), spec.get("hi", 1.0), spec.get("levels", 0))
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

    def inp(self, c: int, h: int, w: int, lo: float = 0.0, hi: float = 1.0, memory: str = "contiguous", levels: int = 0) -> dict:
        self.seed += 1
        spec = {"shape": [c, h, w], "seed": self.seed, "lo": lo, "hi": hi, "memory": memory}
        if levels:
            spec["levels"] = levels
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
    sobel = [[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]]
    emboss = [[-2.0, -1.0, 0.0], [-1.0, 1.0, 1.0], [0.0, 1.0, 2.0]]
    motion = [[(1.0 / 17 if y == 8 or (y == x) else 0.0) for x in range(17)] for y in range(17)]
    disk = [[1.0 if (x - 10) ** 2 + (y - 10) ** 2 <= 100 else 0.0 for x in range(21)] for y in range(21)]
    ndisk = sum(map(sum, disk))
    disk = [[v / ndisk for v in row] for row in disk]
    for name, kern in (("sobel", sobel), ("emboss", emboss), ("motion 17", motion), ("disk 21", disk)):
        kt = torch.tensor(kern, dtype=torch.float32)
        kh, kw = kt.shape
        flat = kt.reshape(-1).tolist()
        for c, (w, h) in ((3, (37, 23)), (4, (64, 48))):
            g.add(f"conv2d depthwise {name}, {w}×{h} {c} ch", "conv2dDepthwise", "library", [g.inp(c, h, w)], {"kernel": flat, "kh": kh, "kw": kw},
                  lambda t, kt=kt, c=c: F.conv2d(t, kt.expand(c, 1, *kt.shape), groups=c)[0])
        g.add(f"conv2d same {name}, 64×48", "conv2dSame", "library", [g.inp(1, 48, 64)], {"kernel": flat, "kh": kh, "kw": kw, "pad": kh // 2},
              lambda t, kt=kt: F.conv2d(t, kt[None, None], padding=kt.shape[0] // 2)[0])

    # ── gaussian ──
    for ksize, sigma in ((3, 0.3), (7, 1.0), (31, 5.0), (61, 10.0), (181, 30.0), (301, 50.0)):
        g.add(f"gaussian kernel ({ksize}, {sigma})", "gaussianKernel1d", "library", [], {"ksize": ksize, "sigma": sigma},
              lambda ksize=ksize, sigma=sigma: TF._get_gaussian_kernel1d(ksize, sigma, torch.float32, torch.device("cpu")).view(1, 1, ksize))
        g.add(f"gaussian_blur ({ksize}, {sigma}), 64×48 4 ch", "gaussianBlur", "library", [g.inp(4, 48, 64)], {"ksize": ksize, "sigma": sigma},
              lambda t, ksize=ksize, sigma=sigma: TF.gaussian_blur(t, [ksize, ksize], [sigma, sigma])[0])
    # ksize 181 raises on 64×48: the blur itself on a picture it fits (301 needs > 150 a side: its
    # im2col would be 8 GB, so it is covered by its kernel and the failure only).
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

    # ── topk ──
    topk = []
    for n, levels, k, largest in ((50, 6, 1, True), (50, 6, 5, True), (50, 6, 17, False), (50, 6, 50, True), (200, 0, 13, True), (64, 3, 20, False)):
        spec = g.inp(1, 1, n, levels=levels)
        v = kernel_input(spec)[0, 0, 0]
        vals, idx = torch.topk(v, k, largest=largest)
        topk.append({"name": f"topk {n} values ({levels or 'no'} levels), k {k}, largest {largest}", "input": spec, "k": k, "largest": largest,
                     "values": b64(vals.numpy().astype("<f4").tobytes()), "indices": [int(i) for i in idx], "cut": float(vals[-1])})

    return {"cases": g.cases, "topk": topk, "eps_candidates": KERNEL_EPS, "store_max": KERNEL_STORE_MAX}


GROUPS = {"machinery": machinery, "kernels": kernels}


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
