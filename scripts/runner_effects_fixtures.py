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
save_images). A hashed case records the sha256 of each, and its band: the
pixels whose float lies within ε = 2⁻⁸ (in 255-scale) of a quantisation
boundary, [[index, trunc8, round8], …].

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
    """Pixels whose float lies within eps (255-scale) of a trunc or round boundary, with
    Python's bytes there ([[index, trunc8, round8], …]), packed: `in` one byte per value of
    the interleaved H × W × C bytes (1 in the band), `trunc8` and `round8` Python's bytes
    at the band's values in order; each zlib-compressed (level 9), base64."""
    v = (t.cpu().numpy().astype(np.float64) * 255.0).reshape(-1)
    near_int = np.abs(v - np.round(v)) < eps
    near_half = np.abs(v - (np.floor(v) + 0.5)) < eps
    inside = near_int | near_half
    tr = trunc8(t).reshape(-1)
    ro = round8(t).reshape(-1)
    z = lambda b: b64(zlib.compress(b, 9))  # noqa: E731
    return {"count": int(inside.sum()), "in": z(inside.astype(np.uint8).tobytes()),
            "trunc8": z(tr[inside].tobytes()), "round8": z(ro[inside].tobytes())}


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
    # save_live_preview keeps a 4-channel tensor's alpha: the preview is RGBA.
    t4 = torch.from_numpy(np.frombuffer(synth(5, 4, 4, 8), dtype=np.uint8).reshape(1, 4, 5, 4).astype(np.float32) / 255.0)
    ui = save_live_preview(t4, "rgba_probe")
    rgba = read_preview({"images": ui["images"]}, False)
    return {"synth": synths, "cases": g.cases, "assets": {k: b64(v) for k, v in sorted(g.assets.items())}, "rgba_preview": rgba}


GROUPS = {"machinery": machinery}


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
