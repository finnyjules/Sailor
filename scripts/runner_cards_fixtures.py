"""Writes frontend/tests/unit/fixtures/runner-cards.json: what the REAL Python
card nodes (step 3, stage R1) make of their settings, for the Sailor runner's
TypeScript ports to be measured against. One top-level key per task; each task
adds its key and regenerates the file (the other keys must come out unchanged).

  moodboard — (R1.1) MoodboardNode.execute(reading_json)'s style block, for
              the three shared fixtures in tests-unit/comfy_api_test/fixtures/
              and the edge cases; `plain: false` marks a reading the moodboard
              window never writes (the runner leaves those to the engine)
  text      — (R1.1) TextNode.execute(text, source)'s value
  wired_text — (R1.2) the first provider call the REAL GenerateImageNode
              (flux-schnell on fal, flux-dev on Replicate), RestyleFromImageNode
              (Nano Banana 2, its taste a Moodboard's style block),
              GenerateVideoNode (veo-3.1) and EditImageNode (Nano Banana 2)
              make for the words a card would wire in, captured with
              runner_builder_fixtures.capture_first_call
  scene3d   — (R1.3) Scene3DStudioNode.execute over good bakes (an RGBA PNG,
              an EXIF-turned JPEG, an RGB PNG), a missing file and blank
              names: each output as the 8-bit RGB a provider is sent
              (_image_tensor_to_data_url, round(255·x)); a flat placeholder
              is stored as its one colour and size
  text_on_path — (R1.3) TextOnPathNode.execute(params): image as 8-bit RGB,
              mask as round(m·65535) little-endian uint16; `error` when the
              node raises
  text_mask — (R1.3) TextMaskNode.execute(params) with no source, as text_on_path
  load_image — (R1.3) nodes.LoadImage().load_image over the R0.7 files
              (runner_values_fixtures.py): image 8-bit, mask 16-bit
  pil_luma  — (R1.3) PIL's convert("L") of 256 seeded random RGB triples
  empty_image — (R1.4) nodes.EmptyImage().generate over sizes, batches and
              colours (0 and 0xFFFFFF included): the tensor's shape and its
              first frame as a provider is sent it (every frame is checked equal)
  get_image_size — (R1.4) GetImageSize.execute on the tensor each loader
              makes (a provider download, an EXIF-turned Image card, LoadImage,
              a two-file batch), with the size text Python sends the node
  image_to_mask — (R1.4) ImageToMask.execute, every channel, on RGB and RGBA
              tensors (LoadImage, a provider download, an Image card, a batch);
              `error` for alpha on a picture with none
  text_mask_source — (R1.4) TextMaskNode.execute(params, source): a 40×20
              render on 64×48 RGB and RGBA sources, a same-size render, a
              two-picture batch and a blank render; each image frame as the 8-bit
              RGB or RGBA a provider is sent, the mask 16-bit; and (fix round 1)
              a 300×90 render on a 1080×1920 source, its outputs as sha256
  save_image — (R1.5) the real SaveImage().save_images (a fresh temp output
              folder per case, metadata on) over LoadImage RGB, provider RGBA,
              Image-card RGBA and batch tensors: png at compression 1 and 9,
              jpeg at 60 and 90, webp lossy 80 and 90 and lossless, scale,
              max_dimension, a prefix with a subfolder and %width%x%height%,
              the counter after files already there, %batch_num%, metadata
              off, a two-frame GIF; each saved file's name, decoded pixels
              (sha256 when lossless and unresized) and PNG text. PreviewImage
              (random.choice patched to the first letter). Text mask with a
              source → Save image (`text_mask`). PIL's LANCZOS resize alone on
              seeded random RGB and RGBA pictures (`lanczos`).
              get_save_image_path over prefixes with `..`, absolute parts and
              the date variables (time.localtime patched)
  smart_layout — (R1.6) nodes_smart_layout's pure functions (_parse_layout,
              _parse_text_layers, _autopopulate_for_template, _resolve_outputs,
              _output_labels) over the starter, v1, v2 (outputs, variations,
              float and bool grid columns), v3 and broken layouts, aspects
              blank, unknown and repeated; and SmartLayoutNode.execute with
              urllib.request.urlopen patched to capture each POST body and
              answer a 2×2 RGBA PNG: the bodies (each image layer's /view URL
              replaced by the saved frame's 8-bit pixels), the outputs' RGB
              pixels, and the live previews' names and pixels

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_cards_fixtures.py

The network is blocked (as in compositor_fixtures.py): every outbound connect
and DNS lookup raises and the provider keys are removed before any node module
is imported. Nothing here needs the network.
"""
import glob
import json
import os
import socket
import sys

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
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-cards.json")

import utils.install_util  # noqa: E402,F401

from comfy_extras.nodes_moodboard import MoodboardNode  # noqa: E402
from comfy_extras.nodes_text import TextNode  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runner_builder_fixtures  # noqa: E402


def _dumps(reading) -> str:
    """As the moodboard window writes it: JSON.stringify (compact)."""
    return json.dumps(reading, separators=(",", ":"), ensure_ascii=False)


# ── moodboard (R1.1) ─────────────────────────────────────────────────────────

def moodboard_cases() -> list[dict]:
    cases: list[tuple[str, str, bool]] = []
    shared = sorted(glob.glob(os.path.join(ROOT, "tests-unit", "comfy_api_test", "fixtures", "moodboard_style_block_*.json")))
    assert len(shared) == 3, shared
    for path in shared:
        with open(path, encoding="utf-8") as f:
            fx = json.load(f)
        cases.append((f"shared: {os.path.basename(path)}", _dumps(fx["reading"]), True))
    palette = [{"name": "Blush", "hex": "#F6C1CB"}, {"name": "Turquoise", "hex": "#67C4C9"}]
    cases += [
        ("blank", "", True),
        ("whitespace only (U+001C, U+00A0)", " \n\t\x1c\xa0 ", True),
        ("a summary ending in a period", _dumps({"summary": "Soft film grain.", "palette": palette, "avoids": ["gloss"]}), True),
        ("a summary of only spaces", _dumps({"summary": "    ", "palette": palette, "avoids": ["gloss"]}), True),
        ("a summary ending in U+001C (Python strips it, JS trim does not)", _dumps({"summary": "Grain\x1c", "palette": [], "avoids": []}), True),
        ("an empty palette", _dumps({"summary": "Riso", "palette": [], "avoids": ["gloss", "neon"]}), True),
        ("palette items with a missing name or hex", _dumps({"summary": "Riso", "palette": [{"hex": "#FFFFFF"}, {"name": "Rose"}], "avoids": []}), True),
        ("null parts", _dumps({"summary": None, "palette": None, "avoids": None}), True),
        ("an empty object", "{}", True),
        # Not what the moodboard window writes: left to the engine.
        ("bad JSON", '{"summary": "Riso",', False),
        ("a JSON list", _dumps([{"summary": "Riso"}]), False),
        ("a numeric avoid", _dumps({"summary": "Riso", "palette": [], "avoids": ["gloss", 3]}), False),
        ("a palette item that is a string", _dumps({"summary": "Riso", "palette": ["#FFFFFF"], "avoids": []}), False),
        ("NaN, which json.loads takes and JSON.parse does not", '{"summary": "Riso", "weight": NaN}', False),
    ]
    out = []
    for name, reading_json, plain in cases:
        style = MoodboardNode.execute(reading_json).args[0]
        row = {"name": name, "reading_json": reading_json, "style": style}
        if not plain:
            row["plain"] = False
        out.append(row)
    return out


# ── text (R1.1) ──────────────────────────────────────────────────────────────

def text_cases() -> list[dict]:
    cases = [
        ("typed text wins over the source", "a red fox", "from the source"),
        ("typed text, no source", "a red fox", None),
        ("blank typed text hands on the source", "", "from the source"),
        ("whitespace-only typed text (U+2003) hands on the source", " ", "from the source"),
        ("U+001C typed text hands on the source", "\x1c", "from the source"),
        ("typed text keeps its own spaces", "  padded  ", "from the source"),
        ("blank typed text, no source", "", None),
        ("whitespace typed text, no source", "   ", None),
    ]
    out = []
    for name, text, source in cases:
        res = TextNode.execute(text, source) if source is not None else TextNode.execute(text)
        value = res.args[0]
        assert res.ui == {"text": [value]}, res.ui
        out.append({"name": name, "text": text, "source": source, "value": value})
    return out


# ── wired_text (R1.2) ────────────────────────────────────────────────────────

# A Moodboard reading as the moodboard window writes it; its style block is the taste wired into Restyle.
WIRED_READING = _dumps({"summary": "Soft film grain.", "palette": [{"name": "Blush", "hex": "#F6C1CB"}],
                        "avoids": ["gloss"]})


def wired_text_cases() -> list[dict]:
    import comfy_api_nodes.nodes_replicate as nr
    capture = runner_builder_fixtures.capture_first_call
    out = []

    def case(name: str, node_cls, class_type: str, inputs: dict, links: tuple = (), **extra):
        kwargs = dict(inputs)
        for link in links:  # a picture arrives as its input name (IMG:<name>)
            kwargs[link] = link
        call = capture(node_cls, **kwargs)
        assert not call.get("passthrough"), name
        out.append({"name": name, "class_type": class_type, "inputs": inputs, "links": list(links), **extra,
                    "provider": call["provider"], "endpoint": call["endpoint"], "payload": call["payload"]})

    # Generate an image: prompt_in, style_block and style_in, each blank or not, under a blank and a typed prompt.
    words = {"prompt_in": "a lighthouse at dusk", "style_block": "Muted riso print.", "style_in": "In the style of: soft grain."}
    for model in ("flux-schnell", "flux-dev"):
        for prompt in ("", "a red fox"):
            for mask in range(8):
                inputs = {"model": model, "prompt": prompt, "aspect_ratio": "1:1", "seed": 7, "model_options": "{}"}
                for i, key in enumerate(("prompt_in", "style_block", "style_in")):
                    inputs[key] = words[key] if mask & (1 << i) else "  "
                label = ", ".join(k for i, k in enumerate(words) if mask & (1 << i)) or "all blank"
                case(f"{model}, prompt {prompt!r}: {label}", nr.GenerateImageNode, "GenerateImageNode", inputs)

    # Restyle from image: the taste is a Moodboard's style block.
    style = MoodboardNode.execute(WIRED_READING).args[0]
    assert style, style
    for prompt in ("", "watercolor"):
        case(f"Nano Banana 2 restyle, prompt {prompt!r}, taste from a Moodboard", nr.RestyleFromImageNode,
             "RestyleFromImageNode",
             {"model": "Nano Banana 2", "prompt": prompt, "structure_strength": 0.65, "resolution": "1K",
              "seed": 0, "output_format": "png", "style_in": style},
             links=("content_image",), reading_json=WIRED_READING)

    # Generate a video: the prompt.
    case("veo-3.1, a prompt", nr.GenerateVideoNode, "GenerateVideoNode",
         {"model": "veo-3.1", "prompt": "a fox runs through snow", "aspect_ratio": "16:9", "duration": "8",
          "seed": 7, "model_options": "{}"})

    # Edit an image: the prompt.
    case("Nano Banana 2 edit, a prompt", nr.EditImageNode, "EditImageNode",
         {"model": "Nano Banana 2", "prompt": "make her hair blue", "aspect_ratio": "match_input_image",
          "resolution": "1K", "seed": 0, "safety_tolerance": 2, "prompt_upsampling": False, "output_format": "png"},
         links=("input_image",))
    return out


# ── bake replays and LoadImage (R1.3) ────────────────────────────────────────

def _rv():
    """runner_values_fixtures (R0.7): its synthetic files, encoders and input folder."""
    import runner_values_fixtures as rv
    return rv


def _put(name: str, data: bytes) -> str:
    rv = _rv()
    path = os.path.join(rv.WORK, "input", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return name


def _image8(t) -> dict:
    """An IMAGE as a provider is sent it; a flat picture (a placeholder) as its one colour."""
    import numpy as np
    rv = _rv()
    w, h, rgb8 = rv.data_url_rgb8(t)
    px = np.frombuffer(rgb8, dtype=np.uint8).reshape(h, w, 3)
    first = px[0, 0]
    if w * h > 4096 and (px == first).all():
        return {"w": w, "h": h, "fill": [int(v) for v in first]}
    return {"w": w, "h": h, "rgb8": rv.b64(rgb8)}


def _mask16(m) -> dict:
    rv = _rv()
    return {"w": int(m.shape[-1]), "h": int(m.shape[-2]), "mask16": rv.mask16(m)}


def scene3d_cases() -> list[dict]:
    from comfy_extras.nodes_scene3d import Scene3DStudioNode
    rv = _rv()
    rgba = _put("s3d_beauty.png", rv._rgba_png())
    jpeg = _put("s3d_depth.jpg", rv._jpeg(6))
    rgb = _put("s3d_normal.png", rv._rgb_png())
    _put("s3d/sub_rgb.png", rv._rgb_png())
    files = {rgba: rv._rgba_png(), jpeg: rv._jpeg(6), rgb: rv._rgb_png(), "s3d/sub_rgb.png": rv._rgb_png()}
    cases = [
        ("three good bakes: an RGBA PNG, an EXIF-turned JPEG, an RGB PNG", rgba, jpeg, rgb),
        ("a missing file becomes its placeholder", "missing_beauty.png", jpeg, "missing_normal.png"),
        ("blank names are the placeholders", "", "", ""),
        ("a name in a subfolder, annotated [input]", "s3d/sub_rgb.png [input]", "", rgb),
    ]
    out = []
    for name, beauty, depth, normal in cases:
        res = Scene3DStudioNode.execute(scene_state="{}", beauty_image=beauty, depth_image=depth, normal_image=normal)
        assert res.ui is None, res.ui
        out.append({
            "name": name, "beauty_image": beauty, "depth_image": depth, "normal_image": normal,
            "files": {k: rv.b64(v) for k, v in files.items() if k in (beauty, depth, normal) or f"{k} [input]" in (beauty, depth, normal)},
            "outputs": [_image8(t) for t in res.args],
        })
    return out


def _bake_cases(node_cls, renders: list[tuple[str, str, bytes | None]]) -> list[dict]:
    """Each case: its params text; any render file it names; the node's two outputs, or that it raised."""
    rv = _rv()
    out = []
    for name, params, data in renders:
        row: dict = {"name": name, "params": params}
        if data is not None:
            rendered = json.loads(params)["rendered"]
            _put(rendered, data)
            row["file"] = rv.b64(data)
        try:
            res = node_cls.execute(params)
        except RuntimeError:
            row["error"] = True  # the node raises (its words carry a temp path, so only the fact is kept)
            out.append(row)
            continue
        image, mask = res.args
        row["image"] = _image8(image)
        row["mask"] = _mask16(mask)
        out.append(row)
    return out


def text_on_path_cases() -> list[dict]:
    from comfy_extras.nodes_text_on_path import TextOnPathNode
    rv = _rv()
    p = lambda rendered: json.dumps({"text": "HELLO", "path": "arc", "rendered": rendered})  # noqa: E731
    return _bake_cases(TextOnPathNode, [
        ("an RGBA render", p("top_rgba.png"), rv._rgba_png()),
        ("an RGB render (no alpha: a zero mask)", p("top_rgb.png"), rv._rgb_png()),
        ("an LA render", p("top_la.png"), rv._la_png()),
        ("a palette render with a transparent index (no A band: a zero mask)", p("top_pal.png"), rv._palette_png()),
        ("an EXIF-turned JPEG render", p("top_turned.jpg"), rv._jpeg(6)),
        ("blank rendered", p(""), None),
        ("no rendered key", json.dumps({"text": "HELLO"}), None),
        ("params not a dict", json.dumps(["top_rgba.png"]), None),
        ("bad JSON", '{"rendered": "top_rgba.png"', None),
        ("blank params", "", None),
        ("a missing render fails the node", p("top_missing.png"), None),
    ])


def text_mask_cases() -> list[dict]:
    from comfy_extras.nodes_text_mask import TextMaskNode
    rv = _rv()
    p = lambda rendered: json.dumps({"text": "MASK", "rendered": rendered})  # noqa: E731
    return _bake_cases(TextMaskNode, [
        ("an RGBA render with colour", p("tm_rgba.png"), rv._rgba_png()),
        ("a greyscale render", p("tm_grey.png"), rv._grey_png()),
        ("an RGB render", p("tm_rgb.png"), rv._rgb_png()),
        ("an LA render", p("tm_la.png"), rv._la_png()),
        ("a palette render with a transparent index", p("tm_pal.png"), rv._palette_png()),
        ("an EXIF-turned JPEG (not turned: convert(\"L\") only)", p("tm_turned.jpg"), rv._jpeg(6)),
        ("blank rendered", p(""), None),
        ("params not a dict", "7", None),
        ("bad JSON", "{", None),
        ("a missing render fails the node", p("tm_missing.png"), None),
    ])


def load_image_cases() -> list[dict]:
    import nodes
    rv = _rv()
    files = {
        "an RGBA PNG with a gradient alpha": rv._rgba_png(),
        "an RGB PNG (no alpha)": rv._rgb_png(),
        "an LA PNG": rv._la_png(),
        "a palette PNG with a transparent index": rv._palette_png(),
        "an RGB PNG with a tRNS colour key": rv._rgb_trns_png(),
        "a greyscale PNG with a tRNS colour key": rv._grey_trns_png(),
        "a JPEG with EXIF orientation 6": rv._jpeg(6),
        "a JPEG with EXIF orientation 1": rv._jpeg(1),
        "a greyscale PNG": rv._grey_png(),
        "a two-frame GIF": rv._two_frame_gif(),
        "an RGB PNG with an ICC profile": rv._icc_png(),
        "a two-frame animated PNG": rv._apng(),
    }
    out = []
    for i, (label, data) in enumerate(files.items()):
        name = _put(f"li_{i}.{'gif' if 'GIF' in label else 'jpg' if 'JPEG' in label else 'png'}", data)
        image, mask = nodes.LoadImage().load_image(name)
        out.append({"name": label, "image_name": name, "file": rv.b64(data), "image": _image8(image), "mask": _mask16(mask)})
    return out


def pil_luma_cases() -> list[list[int]]:
    import numpy as np
    from PIL import Image as PILImage
    rgb = np.random.default_rng(20260926).integers(0, 256, size=(256, 3), dtype=np.uint8)
    rgb[:4] = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [1, 2, 3]]
    luma = np.array(PILImage.fromarray(rgb.reshape(1, 256, 3), "RGB").convert("L")).reshape(256)
    return [[int(r), int(g), int(b), int(v)] for (r, g, b), v in zip(rgb, luma)]


# ── picture utilities (R1.4) ────────────────────────────────────────────────

def _loaded(name: str, data: bytes, via: str):
    """The IMAGE tensor a source of kind `via` hands on for this file (as scripts/compositor_fixtures.py)."""
    import io
    import nodes
    from comfy_api_nodes.util.conversions import bytesio_to_image_tensor
    from comfy_extras.nodes_image import Image as ImageCard
    _put(name, data)
    if via == "provider":
        return bytesio_to_image_tensor(io.BytesIO(data))
    if via == "card":
        return ImageCard().process(
            image=name, export=False, filename_prefix="fixture", format="png", quality=90,
            lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=False,
            batch_index=-1, images=None, prompt=None, extra_pnginfo=None, unique_id="fixture",
        )["result"][0]
    if via == "load":
        return nodes.LoadImage().load_image(name)[0]
    raise ValueError(via)


def _frames8(t) -> list[dict]:
    """Every frame of an IMAGE as the PNG _image_tensor_to_data_url sends: 8-bit RGB or RGBA."""
    import base64
    import io
    import numpy as np
    from PIL import Image as PILImage
    from comfy_api_nodes.nodes_replicate import _image_tensor_to_data_url
    rv = _rv()
    out = []
    for i in range(t.shape[0]):
        url = _image_tensor_to_data_url(t[i:i + 1])
        im = PILImage.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
        assert im.mode in ("RGB", "RGBA"), im.mode
        out.append({"w": im.size[0], "h": im.size[1], "channels": len(im.mode), "px8": rv.b64(np.array(im).tobytes())})
    return out


def _rgba(h: int, w: int, seed: int) -> bytes:
    import numpy as np
    from PIL import Image as PILImage
    rv = _rv()
    return rv._save(PILImage.fromarray(np.dstack([rv._pattern(h, w, seed), rv._gradient_alpha(h, w)]), "RGBA"), "PNG")


def _rgb(h: int, w: int, seed: int) -> bytes:
    from PIL import Image as PILImage
    rv = _rv()
    return rv._save(PILImage.fromarray(rv._pattern(h, w, seed), "RGB"), "PNG")


def _grey(h: int, w: int, seed: int) -> bytes:
    from PIL import Image as PILImage
    rv = _rv()
    return rv._save(PILImage.fromarray(rv._pattern(h, w, seed)[..., 1], "L"), "PNG")


def empty_image_cases() -> list[dict]:
    import nodes
    out = []
    for w, h, batch, color in [(1, 1, 1, 0), (3, 2, 1, 0xFFFFFF), (5, 4, 2, 0x123456), (7, 3, 1, 0xFF8001), (64, 80, 3, 0x7F7F80), (2, 2, 1, 0x010203)]:
        t = nodes.EmptyImage().generate(w, h, batch, color)[0]
        assert all(bool((t[i] == t[0]).all()) for i in range(t.shape[0]))
        out.append({"name": f"{w}x{h}, batch {batch}, colour {color:06X}", "width": w, "height": h, "batch_size": batch, "color": color,
                    "shape": list(t.shape), "image": _image8(t)})
    return out


def get_image_size_cases() -> list[dict]:
    import torch
    from types import SimpleNamespace
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_images as ni
    rv = _rv()
    cases = [
        ("a provider download (RGBA)", [("gis_provider.png", _rgba(20, 30, 31))], "provider"),
        ("an Image card with an EXIF-turned JPEG", [("gis_card.jpg", rv._jpeg(6))], "card"),
        ("a LoadImage with an EXIF-turned JPEG", [("gis_load.jpg", rv._jpeg(6))], "load"),
        ("a two-file batch", [("gis_batch_a.png", _rgba(20, 30, 32)), ("gis_batch_b.png", _rgba(20, 30, 33))], "provider"),
    ]
    out = []
    for name, files, via in cases:
        t = torch.cat([_loaded(n, d, via) for n, d in files], dim=0)
        sent: list[str] = []
        server = SimpleNamespace(instance=SimpleNamespace(send_progress_text=lambda text, _uid: sent.append(text)))
        with mock.patch.object(ni.GetImageSize, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})), mock.patch.object(ni, "PromptServer", server):
            res = ni.GetImageSize.execute(t)
        assert res.ui is None, res.ui
        out.append({"name": name, "via": via, "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files],
                    "values": [int(v) for v in res.args], "progress_text": sent})
    return out


def image_to_mask_cases() -> list[dict]:
    import torch
    from comfy_extras.nodes_mask import ImageToMask
    rv = _rv()
    sources = [
        ("LoadImage, RGB", [("itm_load.png", _rgb(18, 26, 41))], "load"),
        ("a provider download, RGBA", [("itm_provider.png", _rgba(18, 26, 42))], "provider"),
        ("an Image card with alpha, RGBA", [("itm_card.png", _rgba(18, 26, 43))], "card"),
        ("a two-file batch, RGBA", [("itm_batch_a.png", _rgba(12, 16, 44)), ("itm_batch_b.png", _rgba(12, 16, 45))], "provider"),
    ]
    out = []
    for name, files, via in sources:
        t = torch.cat([_loaded(n, d, via) for n, d in files], dim=0)
        for channel in ("red", "green", "blue", "alpha"):
            row: dict = {"name": f"{name}: {channel}", "via": via, "channel": channel, "channels": int(t.shape[-1]),
                         "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files]}
            try:
                mask = ImageToMask.execute(t, channel).args[0]
            except IndexError:
                row["error"] = True  # alpha on a 3-channel tensor
                out.append(row)
                continue
            row["masks"] = [_mask16(mask[i:i + 1]) for i in range(mask.shape[0])]
            out.append(row)
    return out


def text_mask_source_cases() -> list[dict]:
    import torch
    from comfy_extras.nodes_text_mask import TextMaskNode
    rv = _rv()
    small = _put("tms_small.png", _grey(20, 40, 51))
    full = _put("tms_full.png", _grey(48, 64, 52))
    p = lambda rendered: json.dumps({"text": "MASK", "rendered": rendered})  # noqa: E731
    cases = [
        ("a 40×20 render on a 64×48 RGB source (LoadImage)", small, [("tms_rgb.png", _rgb(48, 64, 53))], "load"),
        ("a 40×20 render on a 64×48 RGBA source (a provider download)", small, [("tms_rgba.png", _rgba(48, 64, 54))], "provider"),
        ("a 40×20 render on a 64×48 Image card with alpha", small, [("tms_card.png", _rgba(48, 64, 55))], "card"),
        ("a same-size render on a 64×48 RGB source", full, [("tms_rgb.png", _rgb(48, 64, 53))], "load"),
        ("a 40×20 render on a two-picture batch", small, [("tms_batch_a.png", _rgba(48, 64, 56)), ("tms_batch_b.png", _rgba(48, 64, 57))], "provider"),
        ("a 64×48 render on a 40×20 RGB source (made smaller)", full, [("tms_small_rgb.png", _rgb(20, 40, 58))], "load"),
        ("a blank render ignores the source", "", [("tms_rgb.png", _rgb(48, 64, 53))], "load"),
    ]
    out = []
    for name, rendered, files, via in cases:
        t = torch.cat([_loaded(n, d, via) for n, d in files], dim=0)
        res = TextMaskNode.execute(p(rendered), t)
        image, mask = res.args
        row = {"name": name, "params": p(rendered), "via": via, "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files]}
        if rendered:
            with open(os.path.join(rv.WORK, "input", rendered), "rb") as f:
                row["render"] = rv.b64(f.read())
        row["images"] = _frames8(image)
        row["mask"] = _mask16(mask)
        out.append(row)
    # (fix round 1) At a real size, where torch's resize takes its separable
    # sum (output w + h ≥ 129): a 300×90 render on a 1080×1920 source. The
    # outputs are stored as the sha256 of their 8-bit pixels and 16-bit mask.
    import hashlib
    import numpy as np
    from PIL import Image as PILImage
    y, x = np.mgrid[0:1920, 0:1080].astype(np.float64)
    tall = np.stack([x / 1079, y / 1919, (x + y) / 2998], axis=-1)
    tall_png = rv._save(PILImage.fromarray(np.floor(tall * 255 + 0.5).astype(np.uint8), "RGB"), "PNG")
    wide = _put("tms_wide.png", _grey(90, 300, 59))
    for name, files, via in [("a 300×90 render on a 1080×1920 RGB source (LoadImage)", [("tms_tall.png", tall_png)], "load")]:
        t = torch.cat([_loaded(n, d, via) for n, d in files], dim=0)
        image, mask = TextMaskNode.execute(p(wide), t).args
        frames = _frames8(image)
        with open(os.path.join(rv.WORK, "input", wide), "rb") as f:
            render = rv.b64(f.read())
        m16 = base64_bytes(_mask16(mask)["mask16"])
        out.append({
            "name": name, "params": p(wide), "via": via, "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files],
            "render": render,
            "images": [{"w": fr["w"], "h": fr["h"], "channels": fr["channels"], "px8_sha256": hashlib.sha256(base64_bytes(fr["px8"])).hexdigest()} for fr in frames],
            "mask": {"w": int(mask.shape[-1]), "h": int(mask.shape[-2]), "mask16_sha256": hashlib.sha256(m16).hexdigest()},
        })
    return out


def base64_bytes(s: str) -> bytes:
    import base64
    return base64.b64decode(s)


# ── Save image and Preview image (R1.5) ──────────────────────────────────────

# What the run sends as the hidden PROMPT and EXTRA_PNGINFO: integer-like keys
# (JS orders those first) and text beyond ASCII (json.dumps escapes it).
SAVE_PROMPT = {
    "10": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "ComfyUI"}},
    "3": {"class_type": "Text", "inputs": {"text": "café ☕ \"quoted\" 🦊\nline two", "scale": 1.5, "on": True, "none": None}},
}
SAVE_WORKFLOW = {"nodes": [{"id": 3, "type": "Text", "widgets_values": ["café ☕"]}], "links": [], "extra": {"ds": {"scale": 0.75}}, "version": 0.4}
# The fixed moment `%year%` … `%second%` read (time.localtime patched to it).
SAVE_MOMENT = (2026, 1, 2, 3, 4, 5)


def _saved_file(folder: str, entry: dict, exact: bool) -> dict:
    """One saved file: its name as ui lists it, its decoded pixels (sha256 when exact, else the bytes) and its PNG text."""
    import hashlib
    import numpy as np
    from PIL import Image as PILImage
    rv = _rv()
    path = os.path.join(folder, entry["subfolder"], entry["filename"])
    with PILImage.open(path) as im:
        im.load()
        px = np.array(im).tobytes()
        row = {**entry, "format": im.format, "mode": im.mode, "w": im.size[0], "h": im.size[1],
               "text": dict(getattr(im, "text", {}) or {})}
    if exact:
        row["px_sha256"] = hashlib.sha256(px).hexdigest()
    else:
        row["px"] = rv.b64(px)
    return row


def save_image_cases() -> dict:
    import shutil
    import tempfile
    import time
    import torch
    from unittest import mock
    import nodes
    import folder_paths
    from comfy.cli_args import args
    assert not args.disable_metadata
    rv = _rv()
    sources = {
        "rgb": ([("si_rgb.png", _rgb(28, 40, 61))], "load"),
        "rgba": ([("si_rgba.png", _rgba(28, 40, 62))], "provider"),
        "card": ([("si_card.png", _rgba(28, 40, 63))], "card"),
        "batch": ([("si_batch_a.png", _rgba(28, 40, 64)), ("si_batch_b.png", _rgba(28, 40, 65))], "provider"),
        "gif": ([("si_two_frames.gif", rv._two_frame_gif())], "load"),
    }
    defaults = {"filename_prefix": "ComfyUI", "format": "png", "quality": 90, "lossless_webp": False,
                "png_compression": 4, "scale": 1.0, "max_dimension": 0, "embed_metadata": True}
    cases = [
        ("png, compression 1, RGB", "rgb", {"png_compression": 1}, []),
        ("png, compression 9, RGB", "rgb", {"png_compression": 9}, []),
        ("png, RGBA (a provider picture)", "rgba", {}, []),
        ("png, an Image card with alpha (its alpha goes through 1 − mask)", "card", {}, []),
        ("jpeg at 60, RGBA (flattened onto white)", "rgba", {"format": "jpeg", "quality": 60}, []),
        ("jpeg at 60, RGB", "rgb", {"format": "jpeg", "quality": 60}, []),
        ("jpeg at 90 (the default quality), RGB", "rgb", {"format": "jpeg"}, []),
        ("jpeg at 90 (the default quality), RGBA", "rgba", {"format": "jpeg"}, []),
        ("webp lossy 90 (the default quality), RGB", "rgb", {"format": "webp"}, []),
        ("webp lossy 90 (the default quality), RGBA", "rgba", {"format": "webp"}, []),
        ("webp lossy 80, RGB", "rgb", {"format": "webp", "quality": 80}, []),
        ("webp lossy 80, RGBA", "rgba", {"format": "webp", "quality": 80}, []),
        ("webp lossless, RGB", "rgb", {"format": "webp", "lossless_webp": True}, []),
        ("webp lossless, RGBA", "rgba", {"format": "webp", "lossless_webp": True}, []),
        ("scale 0.5, RGB", "rgb", {"scale": 0.5}, []),
        ("scale 0.5, RGBA", "rgba", {"scale": 0.5}, []),
        ("scale 1.5, RGB", "rgb", {"scale": 1.5}, []),
        ("max_dimension 30, RGB", "rgb", {"max_dimension": 30}, []),
        ("max_dimension 50 (larger than the picture: unchanged), RGB", "rgb", {"max_dimension": 50}, []),
        ("scale 0.7 then max_dimension 21, RGBA", "rgba", {"scale": 0.7, "max_dimension": 21}, []),
        ("prefix a/b/%width%x%height%, scale 0.5", "rgb", {"filename_prefix": "a/b/%width%x%height%", "scale": 0.5}, []),
        ("two images in one batch, after files already there (the counter)", "batch", {"filename_prefix": "batch"},
         ["batch_00007_.png", "batch_x.png", "batch_00003_.jpg", "batchy_00050_.png", "other_00099_.png", "batch_ 12_.png"]),
        ("%batch_num% in the prefix, two images", "batch", {"filename_prefix": "frame%batch_num%"}, []),
        ("embed_metadata false", "rgb", {"embed_metadata": False}, []),
        ("a LoadImage of a two-frame GIF (a batch of two)", "gif", {}, []),
    ]
    out: dict = {"prompt": SAVE_PROMPT, "workflow": SAVE_WORKFLOW, "moment": list(SAVE_MOMENT), "save": [], "preview": [], "paths": []}
    tensors = {k: torch.cat([_loaded(n, d, via) for n, d in files], dim=0) for k, (files, via) in sources.items()}
    for name, src, over, existing in cases:
        files, via = sources[src]
        settings = {**defaults, **over}
        folder = tempfile.mkdtemp(prefix="runner-save-image-")
        try:
            for e in existing:
                open(os.path.join(folder, e), "wb").close()
            node = nodes.SaveImage()
            node.output_dir = folder
            ui = node.save_images(tensors[src], prompt=SAVE_PROMPT, extra_pnginfo={"workflow": SAVE_WORKFLOW}, **settings)["ui"]
            exact = settings["format"] == "png" and settings["scale"] == 1.0 and not settings["max_dimension"]
            out["save"].append({
                "name": name, "via": via, "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files],
                "settings": settings, "existing": existing, "shape": list(tensors[src].shape),
                "saved": [_saved_file(folder, e, exact) for e in ui["images"]],
            })
        finally:
            shutil.rmtree(folder)
    # PreviewImage: its five random letters fixed at 'a' (random.choice patched to the first letter).
    for name, src in [("Preview image, RGB", "rgb"), ("Preview image, an Image card with alpha", "card")]:
        files, via = sources[src]
        folder = tempfile.mkdtemp(prefix="runner-preview-image-")
        try:
            with mock.patch("random.choice", lambda seq: seq[0]):
                node = nodes.PreviewImage()
            node.output_dir = folder
            res = node.save_images(tensors[src], prompt=SAVE_PROMPT, extra_pnginfo={"workflow": SAVE_WORKFLOW})
            assert res["result"][0] is tensors[src]
            out["preview"].append({
                "name": name, "via": via, "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files],
                "compress_level": node.compress_level, "prefix_append": node.prefix_append,
                "saved": [_saved_file(folder, e, True) for e in res["ui"]["images"]],
            })
        finally:
            shutil.rmtree(folder)
    # (follow-up) Text mask with a source → Save image: the float picture
    # save_images truncates. A 40×20 render on 64×48 sources (LoadImage RGB,
    # an Image card with alpha); the saved PNG's pixels by sha256.
    from comfy_extras.nodes_text_mask import TextMaskNode
    render = _put("si_tms_render.png", _grey(20, 40, 71))
    params = json.dumps({"text": "MASK", "rendered": render})
    with open(os.path.join(rv.WORK, "input", render), "rb") as f:
        render_b64 = rv.b64(f.read())
    out["text_mask"] = []
    for name, files, via in [
        ("Text mask on a LoadImage RGB source → Save image", [("si_tms_rgb.png", _rgb(48, 64, 72))], "load"),
        ("Text mask on an Image card with alpha → Save image", [("si_tms_card.png", _rgba(48, 64, 73))], "card"),
    ]:
        t = torch.cat([_loaded(n, d, via) for n, d in files], dim=0)
        image = TextMaskNode.execute(params, t).args[0]
        folder = tempfile.mkdtemp(prefix="runner-save-text-mask-")
        try:
            node = nodes.SaveImage()
            node.output_dir = folder
            ui = node.save_images(image, prompt=SAVE_PROMPT, extra_pnginfo={"workflow": SAVE_WORKFLOW}, **defaults)["ui"]
            out["text_mask"].append({
                "name": name, "via": via, "params": params, "render": render_b64,
                "files": {n: rv.b64(d) for n, d in files}, "names": [n for n, _ in files],
                "saved": [_saved_file(folder, e, True) for e in ui["images"]],
            })
        finally:
            shutil.rmtree(folder)
    # PIL's Image.resize(LANCZOS) on its own (save_images resizes the 8-bit
    # picture with it): seeded random pictures up and down, RGB and RGBA.
    import hashlib
    import numpy as np
    from PIL import Image as PILImage
    rng = np.random.default_rng(1505)
    out["lanczos"] = []
    for mode, (w, h), (ow, oh) in [
        ("RGB", (7, 5), (3, 2)), ("RGB", (5, 3), (17, 11)), ("RGB", (40, 28), (60, 42)), ("RGB", (97, 61), (13, 9)),
        ("RGB", (1, 1), (4, 3)), ("RGB", (33, 1), (5, 1)), ("RGB", (20, 20), (20, 7)), ("RGB", (120, 80), (207, 133)),
        ("RGBA", (7, 5), (3, 2)), ("RGBA", (5, 3), (17, 11)), ("RGBA", (40, 28), (20, 14)), ("RGBA", (97, 61), (13, 9)),
        ("RGBA", (64, 48), (65, 47)), ("RGBA", (160, 120), (53, 39)),
    ]:
        a = rng.integers(0, 256, (h, w, len(mode)), dtype=np.uint8)
        if mode == "RGBA":
            a[..., 3] = rng.choice(np.array([0, 1, 7, 128, 200, 254, 255], dtype=np.uint8), (h, w))
        res = np.array(PILImage.fromarray(a, mode).resize((ow, oh), PILImage.Resampling.LANCZOS))
        big = w * h > 9000
        out["lanczos"].append({
            "mode": mode, "w": w, "h": h, "ow": ow, "oh": oh, "px": rv.b64(a.tobytes()),
            **({"out_sha256": hashlib.sha256(res.tobytes()).hexdigest()} if big else {"out": rv.b64(res.tobytes())}),
        })
    # folder_paths.get_save_image_path over prefixes, the clock fixed.
    moment = time.struct_time((*SAVE_MOMENT, 4, 2, -1))
    prefixes = [
        "ComfyUI", "a/b/c", "a//b/./c/", "a/../b", "a/b/..", "../x", "a/../../x", "/abs/x", "//abs/x", "..", ".", "",
        "x/../..", "%width%x%height%/img", "%year%-%month%-%day%/%hour%%minute%%second%_x", "no%percent%here",
        "%batch_num%/y", "café/ünï", "a b/c d",
    ]
    folder = tempfile.mkdtemp(prefix="runner-save-paths-")
    try:
        with mock.patch("time.localtime", lambda *a: moment):
            for prefix in prefixes:
                row: dict = {"prefix": prefix, "width": 640, "height": 480}
                try:
                    _full, filename, counter, subfolder, _p = folder_paths.get_save_image_path(prefix, folder, 640, 480)
                    row.update({"subfolder": subfolder, "filename": filename, "counter": counter})
                except Exception:
                    row["error"] = True
                out["paths"].append(row)
    finally:
        shutil.rmtree(folder)
    return out


# ── Smart Layout (R1.6) ──────────────────────────────────────────────────────

def _sl_layouts() -> dict:
    """The layouts the Smart Layout cases run over, as the node's widget holds them (text)."""
    with open(os.path.join(ROOT, "frontend", "server", "templates", "layouts", "social-post.json"), encoding="utf-8") as f:
        v1 = f.read()
    v2 = json.dumps({
        "version": 2, "id": "v2", "name": "Variations", "master": "1x1",
        "formats": {"1x1": {"w": 1080, "h": 1080, "label": "Square"}, "9x16": {"w": 1080, "h": 1920, "label": "Story"},
                    "300x250": {"w": 300, "h": 250, "label": "Écran à 2"}, "320x50": {"w": 320, "h": 50}},
        "grid": {"columns": 12, "rows": 8, "gutter": 24, "margin": 72},
        "order": ["text_layer_1", "logo"],
        "outputs": [
            {"id": "sq", "format": "1x1"}, {"id": "sq-b", "format": "1x1", "label": "Square"},
            {"id": "st", "format": "9x16", "label": "Story / tall"}, {"format": ""}, "junk", {"id": "no-format"},
            {"id": "mpu", "format": "300x250"}, {"id": "banner", "format": "320x50"},
        ],
        "background": {"fill": "{{ brand.primary }}"},
        "elements": [
            {"id": "logo", "type": "text", "region": {"col": 1, "colSpan": 2, "row": 1, "rowSpan": 1}, "content": "{{ brand.name }}"},
            {"id": "cta", "type": "text", "region": {"col": 1, "colSpan": 3, "row": 7, "rowSpan": 1}, "content": "Buy {{ props.text_layer_2 }} now"},
        ],
    })
    return {
        "starter (empty)": "",
        "starter (blank)": "  \n\t ",
        "v1 (social post)": v1,
        "v2 with outputs and variations": v2,
        "v2, no outputs, grid columns as a float": json.dumps({
            "version": 2, "id": "g", "formats": {"1x1": {"w": 1080, "h": 1080, "label": "Square"}, "16x9": {"w": 1920, "h": 1080}},
            "grid": {"columns": 12.0, "rows": 0}, "elements": [],
        }),
        "v2, grid columns true, content not text": json.dumps({
            "version": 2, "id": "b", "defaultAspect": "16x9", "formats": {"1x1": {"w": 64, "h": 64}, "16x9": {"w": 1920, "h": 1080}},
            "grid": {"columns": True, "rows": 3}, "outputs": [],
            "elements": [{"id": "pic", "type": "image", "content": {"src": "{{ props.image_layer_1 }}"}}],
        }),
        "v3 with sections": json.dumps({
            "version": 3, "id": "s", "formats": {"4x5": {"w": 1080, "h": 1350, "label": "Feed portrait"}},
            "sections": [{"id": "top", "children": [{"id": "t", "type": "text", "content": "{{ props.text_layer_1 }}"}]}, {"id": "empty"}],
            "elements": [],
        }),
        "v1, no formats (aspects only), no default": json.dumps({"id": "a", "aspects": {"b": {"w": 10, "h": 10}, "a": {"w": 20, "h": 20}}, "elements": []}),
        "no formats at all": json.dumps({"version": 2, "formats": {}, "elements": []}),
        "elements null": json.dumps({"version": 2, "formats": {"1x1": {"w": 8, "h": 8}}, "elements": None}),
        "bad JSON": "{\"version\": 2,",
        "a list": "[1, 2]",
        "no aspects or formats": "{\"name\": \"x\"}",
    }


def _sl_png(px: list[tuple[int, int, int, int]], w: int, h: int) -> bytes:
    import io
    from PIL import Image as PILImage
    im = PILImage.new("RGBA", (w, h))
    im.putdata(px)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


# What the fake renderer answers every POST with: 2×2 RGBA, one pixel half
# see-through and one fully (convert("RGB") drops the alpha as it is).
SL_RENDER = [(255, 0, 0, 255), (0, 255, 0, 128), (0, 0, 255, 0), (10, 20, 30, 255)]


def smart_layout_cases() -> dict:
    import base64
    import io
    import shutil
    import tempfile
    from unittest import mock
    from urllib.parse import parse_qs, urlparse
    import numpy as np
    from PIL import Image as PILImage
    import torch
    import folder_paths
    import comfy_extras.nodes_smart_layout as sl
    from comfy_api.latest._io import HiddenHolder
    rv = _rv()
    layouts = _sl_layouts()
    out: dict = {"layouts": layouts, "parse_layout": [], "parse_text_layers": [], "autopopulate": [], "resolve_outputs": [], "execute": []}

    for name, raw in layouts.items():
        try:
            out["parse_layout"].append({"layout": name, "out": sl._parse_layout(raw)})
        except Exception as e:
            out["parse_layout"].append({"layout": name, "error": str(e)})

    for text, role in [
        ("", "headline"), ("   \n ", "headline"), ("Spring drop", "headline"), ("  Spring drop  \n", "tagline"),
        ("headline=Spring\n sub = Big sale \n# c=1\nno equals here\n=v\nk=\n\n", "headline"),
        ("a=b=c", "headline"), ("x=1\r\ny=2\rz=3 w=4\x1cv=5\x85u=6", "headline"),
        ("\x1c=\x1d\x1e", "headline"), ("# only=comment", "headline"), ("café=ünï ☕", "headline"),
    ]:
        out["parse_text_layers"].append({"text": text, "default_role": role, "out": sl._parse_text_layers(text, default_role=role)})

    prop_sets = [
        {},
        {"text_layer_1": "Spring drop", "text_layer_2": "Big sale"},
        {"image_layer_1": "/view?a", "image_layer_2": "/view?b", "image_layer_3": "/view?c", "text_layer_1": "Hi"},
        {"text_layer_8": "eight", "image_layer_2": "/view?b", "text_layer_2": "two", "text_layer_3": "three"},
        {"image_layer_1": "/view?a", "text_layer_2": "two"},
    ]
    for name, raw in layouts.items():
        for props in prop_sets:
            row: dict = {"layout": name, "props": props}
            try:
                t = sl._parse_layout(raw)
                sl._autopopulate_for_template(t, dict(props))
                row["out"] = t
            except Exception as e:
                row["error"] = str(e)
            out["autopopulate"].append(row)

    for name, raw in layouts.items():
        for aspects in ["1x1,9x16,16x9", "", " , ", "1x1, 1x1", "nope", "1x1,nope,zz", "16x9", "b"]:
            row = {"layout": name, "aspects": aspects}
            try:
                t = sl._parse_layout(raw)
                outs = sl._resolve_outputs(t, aspects)
                row["out"] = outs
                row["labels"] = sl._output_labels(outs, t)
            except Exception as e:
                row["error"] = str(e)
            out["resolve_outputs"].append(row)

    # execute, the renderer faked: each POST body captured, answered with SL_RENDER.
    render_png = _sl_png(SL_RENDER, 2, 2)
    out["render"] = rv.b64(render_png)
    sources = {
        "load_rgb": ("sl_rgb.png", _rgb(28, 40, 81), "load"),
        "provider_rgba": ("sl_rgba.png", _rgba(24, 36, 82), "provider"),
        "card_rgba": ("sl_card.png", _rgba(20, 30, 83), "card"),
        "batch": ("sl_batch.png", _rgb(16, 16, 84), "load"),
    }
    tensors = {k: _loaded(n, d, via) for k, (n, d, via) in sources.items()}
    tensors["batch"] = torch.cat([tensors["batch"], tensors["load_rgb"][:, :16, :16, :]], dim=0)
    cases = [
        ("the starter, two aspects, a text and an image", {"layout": "", "aspects": "1x1,9x16", "text_layer_1": "Spring drop", "image_layer_1": "load_rgb"}),
        ("v2 outputs and variations, brand over the kit", {
            "layout": layouts["v2 with outputs and variations"], "aspects": "1x1",
            "text_layer_1": "Spring drop", "text_layer_2": "Big sale", "image_layer_1": "provider_rgba", "image_layer_2": "card_rgba",
            "brand": "primary=#ff0000\nfont = Inter\n# note", "brand_kit": "primary=#00ff00\naccent=#0000ff\n# c=1\nempty=\n=novalue\nname = Acme ",
        }),
        ("v1, a blank text layer skipped, a friendly brand", {
            "layout": layouts["v1 (social post)"], "aspects": "16x9",
            "text_layer_1": "   ", "text_layer_3": "Hello", "brand": "Just a word", "brand_kit": "primary = #111 \nforeground=#fff",
        }),
        ("aspects blank: the master format", {"layout": layouts["v2, no outputs, grid columns as a float"], "aspects": "", "image_layer_4": "batch"}),
        ("aspects repeated", {"layout": "", "aspects": "300x250, 300x250", "text_layer_2": "two"}),
        ("an unknown aspect", {"layout": "", "aspects": "1x1,nope", "text_layer_1": "x"}),
        ("bad JSON", {"layout": "{", "aspects": "1x1"}),
        ("no brand, no layers", {"layout": "", "aspects": "728x90", "brand": "", "brand_kit": ""}),
    ]
    temp = tempfile.mkdtemp(prefix="runner-smart-layout-")
    old_temp = folder_paths.get_temp_directory()
    folder_paths.set_temp_directory(temp)
    try:
        for name, inputs in cases:
            bodies: list = []

            class _Answer:
                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

                def read(self):
                    return render_png

            def fake_urlopen(req, timeout=None):
                bodies.append(json.loads(req.data.decode("utf-8")))
                return _Answer()

            kwargs = {k: (tensors[v] if k.startswith("image_layer_") else v) for k, v in inputs.items()}
            row: dict = {"name": name, "inputs": inputs, "node_id": "17"}
            try:
                with mock.patch("urllib.request.urlopen", fake_urlopen), \
                        mock.patch.object(sl.SmartLayoutNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "17"})):
                    res = sl.SmartLayoutNode.execute(**kwargs)
                row["outputs"] = [{"shape": list(t.shape), "rgb8": rv.b64(np.clip(255.0 * t[0].numpy(), 0, 255).astype(np.uint8).tobytes())} for t in res.args[0]]
                ui = res.ui
                row["ui"] = {"images": ui["images"], "animated": list(ui["animated"])}
                row["previews"] = []
                for im in ui["images"]:
                    with PILImage.open(os.path.join(temp, im["filename"])) as p:
                        row["previews"].append({"filename": im["filename"], "mode": p.mode, "px": rv.b64(np.array(p).tobytes())})
            except Exception as e:
                row["error"] = str(e)
            # Each image layer's /view URL → the saved frame's pixels.
            images: dict = {}
            for body in bodies:
                for k, v in list(body["props"].items()):
                    if not k.startswith("image_layer_"):
                        continue
                    q = parse_qs(urlparse(v).query)
                    assert q["type"] == ["temp"], v
                    with PILImage.open(os.path.join(temp, q["filename"][0])) as p:
                        images[k] = {"w": p.size[0], "h": p.size[1], "mode": p.mode, "px": rv.b64(np.array(p).tobytes())}
                    body["props"][k] = {"frame": k}
            row["bodies"] = bodies
            row["frames"] = images
            row["files"] = {sources[v][0]: rv.b64(sources[v][1]) for k, v in inputs.items() if k.startswith("image_layer_")}
            row["via"] = {k: sources[v][2] for k, v in inputs.items() if k.startswith("image_layer_")}
            row["names"] = {k: sources[v][0] for k, v in inputs.items() if k.startswith("image_layer_")}
            out["execute"].append(row)
    finally:
        folder_paths.set_temp_directory(old_temp)
        shutil.rmtree(temp)
    return out


def main() -> None:
    data: dict = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
    data["moodboard"] = moodboard_cases()
    data["text"] = text_cases()
    data["wired_text"] = wired_text_cases()
    data["scene3d"] = scene3d_cases()
    data["text_on_path"] = text_on_path_cases()
    data["text_mask"] = text_mask_cases()
    data["load_image"] = load_image_cases()
    data["pil_luma"] = pil_luma_cases()
    data["empty_image"] = empty_image_cases()
    data["get_image_size"] = get_image_size_cases()
    data["image_to_mask"] = image_to_mask_cases()
    data["text_mask_source"] = text_mask_source_cases()
    data["save_image"] = save_image_cases()
    data["smart_layout"] = smart_layout_cases()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(data.items())), f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: " + ", ".join(f"{k} {len(v)}" for k, v in sorted(data.items())))


if __name__ == "__main__":
    main()
