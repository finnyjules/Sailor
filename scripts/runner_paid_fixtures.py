"""Writes frontend/tests/unit/fixtures/runner-paid-<group>.json: what the REAL
Python gives for Sailor's paid-node runner (step 3, stage R3), for the
TypeScript ports to be measured against. One file per group, keys sorted,
stable bytes (run it twice: the second time `git diff --stat` shows nothing).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group machinery

`--self-check` runs capture_calls on real classes and writes nothing.

Each R3 task adds its group: a list of node cases made by `paid_case`, which
runs the class's real `execute` through `capture_calls` (every provider call,
upload, download, save and JSON-link fetch patched out) and records the calls
Python makes, in order, and what the node returns.

Groups:
  machinery  (R3.1) Python's json module and float repr, for
             frontend/shared/runner/pyJson.ts (tests/unit/py-json.unit.spec.ts):
               bodies  — JSON body texts with json.dumps(json.loads(text)), or
                         `error` where json.loads refuses the text
               scalars — str(json.loads(text)) of every kind of scalar
               floats  — 10,000 seeded doubles (their IEEE-754 bits, big-endian
                         hex) with repr()
  llm        (R3.3) the seven LLM text nodes (Chat with an LLM, Improve a prompt,
             Summarize, Translate, Rewrite in a tone, Brainstorm ideas, Think
             step by step), for frontend/server/runner/generators/llm.ts
             (tests/unit/runner-paid-llm.unit.spec.ts):
               cases          — paid_case of every class × model × text kind
                                (blank, spaces, one line, 2,000 characters,
                                non-ASCII, emoji) and of every setting the
                                brief names, with token-list, string, null,
                                mixed and multi-line answers
               isdigit_ranges — the code points str.isdigit() accepts, as
                                [first, last] ranges (Brainstorm's clean-up)
  repair     (R3.5) Upscale (every engine), Enhance detail (every engine),
             Restore an old photo and Remove background (and their hidden
             twins), for frontend/server/runner/generators/repair.ts
             (tests/unit/runner-paid-repair.unit.spec.ts)
  layers     (R3.6) Separate text from image (Layerize), Layerize an image
             (Seedream) and Expand / outpaint (Flux Fill, Bria Expand), for
             frontend/server/runner/generators/layers.ts
             (tests/unit/runner-paid-layers.unit.spec.ts)
  split      (R3.7) Separate background and foreground: both fill engines,
             mask_grow 0, 1, 12 and 50, RGB and RGBA inputs, cut-outs PIL
             reads its own way (grey + alpha, palette, CMYK, 16-bit grey) and
             one with no alpha (Python still makes two calls: a downloaded
             picture is always read as RGBA), for
             frontend/server/runner/generators/splitLayers.ts; and PIL's
             MaxFilter alone on masks touching every edge and corner, for
             frontend/server/runner/pixels/maxFilter.ts
             (tests/unit/runner-paid-split.unit.spec.ts)
  handoff    (R3.H) the PNG `_image_tensor_to_data_url` sends for a loader's
             tensor: every file kind (EXIF 2–8, RGBA, grey + alpha, palette and
             colour-key transparency, CMYK, 16-bit, WebP, GIF…) through the real
             LoadImage and the real Image card, sent by Edit an image (fal) and
             Remove object (Replicate), for
             frontend/server/runner/pictures/handoffView.ts
             (tests/unit/runner-handoff-parity.unit.spec.ts)

The network is blocked (as in compositor_fixtures.py): every outbound connect
and DNS lookup raises and the provider keys are removed before any node module
is imported. Nothing here needs the network. The node-level helpers of
runner_builder_fixtures.py (its module list and save helpers) are imported
only inside capture_calls, after the block: importing that module loads
comfy_api_nodes.image_models at once.
"""
import asyncio
import contextlib
import json
import os
import random
import socket
import struct
import sys
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
FIXTURES = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures")


# ── capture_calls (R3.2): every provider call a node's execute() makes ──────

class UnservedGet(BaseException):
    """A GET the case didn't serve. A BaseException, so a node's own
    `except Exception` (the HuggingFace look-up, a layer-JSON fetch) can't
    swallow it and quietly take another branch; capture_calls also refuses the
    case after the run if one was ever raised."""


def png_bytes(w: int, h: int, seed: int, mode: str = "RGB") -> bytes:
    """A small deterministic picture (a case's input or answer file)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    channels = len(mode)
    img = Image.frombytes(mode, (w, h), bytes(rng.randrange(256) for _ in range(w * h * channels)))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def cmyk_jpeg_bytes(w: int, h: int, seed: int) -> bytes:
    """A small deterministic CMYK JPEG (R3.6 fix round 1: PIL converts CMYK naively)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    img = Image.frombytes("CMYK", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 4)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def grey16_png_bytes(w: int, h: int, seed: int) -> bytes:
    """A small deterministic 16-bit greyscale PNG (PIL's I;16), with values below and above 255."""
    import io
    import numpy as np
    from PIL import Image
    rng = random.Random(seed)
    arr = np.array([rng.choice((rng.randrange(256), rng.randrange(65536))) for _ in range(w * h)], dtype=np.uint16).reshape(h, w)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def wav_bytes(seconds: float, rate: int, seed: int, channels: int = 1) -> bytes:
    """A small deterministic 16-bit PCM WAV (a case's input or answer sound)."""
    import io
    import wave
    rng = random.Random(seed)
    n = int(seconds * rate) * channels
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(rng.randrange(-20000, 20000).to_bytes(2, "little", signed=True) for _ in range(n)))
    return buf.getvalue()


def _b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    import base64
    return base64.b64decode(text)


def _picture_tensor(data: bytes, mode: str = "RGB"):
    """A picture input as LoadImage (and the Image card) hands it on:
    ImageOps.exif_transpose, then RGB, float32 /255, [1, H, W, 3]; `mode`
    "RGBA" as a node that keeps alpha hands it on (R3.7: [1, H, W, 4]: a
    downloaded picture, read as bytesio_to_image_tensor reads it, not turned)."""
    import io
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(data))
    img = img.convert(mode) if mode == "RGBA" else ImageOps.exif_transpose(img).convert(mode)
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)


def _sound_dict(data: bytes) -> dict:
    """A sound input as Comfy's AUDIO dict, decoded from a 16-bit PCM WAV."""
    import io
    import wave
    import numpy as np
    import torch
    with wave.open(io.BytesIO(data), "rb") as w:
        ch, rate, frames = w.getnchannels(), w.getframerate(), w.readframes(w.getnframes())
    arr = np.frombuffer(frames, dtype="<i2").astype(np.float32).reshape(-1, ch).T / 32768.0
    return {"waveform": torch.from_numpy(np.ascontiguousarray(arr)).unsqueeze(0), "sample_rate": rate}


def _served(links: dict, files: dict) -> dict:
    """URL → (status, body bytes): `links` values are text or {status, text}; `files` values base64."""
    out = {}
    for url, v in (links or {}).items():
        # {"raise": message}: the fetch itself fails (a dropped connection), as ConnectionError(message) (R3.6).
        if isinstance(v, dict) and "raise" in v:
            out[url] = ("raise", str(v["raise"]).encode("utf-8"))
        elif isinstance(v, dict):
            out[url] = (int(v.get("status", 200)), str(v.get("text", "")).encode("utf-8"))
        else:
            out[url] = (200, str(v).encode("utf-8"))
    for url, b in (files or {}).items():
        out[url] = (200, _unb64(b))
    return out


class _FakeResponse:
    def __init__(self, url, status, body):
        self.url = url
        self.status = status
        self._body = body

    async def text(self, *_a, **_k):
        return self._body.decode("utf-8")

    async def read(self):
        return self._body

    async def json(self, *_a, **_k):
        return json.loads(self._body.decode("utf-8"))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _fake_session(get):
    """aiohttp.ClientSession: GETs answered by `get(url)`; anything else refused."""
    class FakeSession:
        def __init__(self, *_a, **_k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        def get(self, url, *_a, **_k):
            status, body = get(str(url))
            return _FakeResponse(str(url), status, body)

        def post(self, url, *_a, **_k):
            raise UnservedGet(f"NETWORK BLOCKED: POST {url!r}")

        put = post

        async def close(self):
            pass
    return FakeSession


def capture_calls(node_cls, answers: list, links: dict | None = None, files: dict | None = None,
                  pictures: dict | None = None, sounds: dict | None = None, picture_modes: dict | None = None,
                  made_pixels: bool = False, tensors: dict | None = None, **kwargs) -> dict:
    """Run `node_cls.execute(**kwargs)` with every provider call, upload,
    download, save and web fetch patched out, and record what it does.

    - Each provider call (Replicate `_run_prediction`, fal
      `run_fal_prediction`) records `{provider, endpoint, payload,
      payload_json}` in `calls` (payload_json: the wire text, keys sorted)
      and returns the next of `answers` (Replicate: the prediction dict; fal:
      the result body; `{"__body__": text}`: json.loads of that text, so the
      TypeScript side keeps the numbers' written form).
    - `pictures` / `sounds` (input name → file bytes) are passed in as the
      real tensors / AUDIO dicts LoadImage and the audio loaders hand on, and
      sent as `IMG:<name>` / `WAV:<name>`. A picture the node made itself (an
      alpha-dropped copy, a crop) is sent as `PNG:<sha256>` of the PNG Python
      encodes; a sound as `WAV:<sha256>`. Uploads become `UPLOAD:<file name>`.
      `picture_modes` (input name → PIL mode, R3.7): a picture handed on in
      that mode ("RGBA": a node upstream kept its alpha). `made_pixels`
      (R3.7): each `PNG:<sha256>` is also described in `made` by its decoded
      pixels (`{shape, sha256}` of the 8-bit array), since the TypeScript
      side's PNG encoder writes other bytes for the same pixels; and each
      picture input by the pixels its tensor holds (`loaded`, R3.7 fix
      round 1: the loader's view, EXIF turned).
    - `tensors` (input name → a tensor a real loader made, R3.H): passed in
      as they are, not named, so `_image_tensor_to_data_url` encodes them as
      it encodes any picture (`PNG:<sha256>`, described in `made`).
    - Every GET (aiohttp, and the download helpers) is recorded in `gets` as
      `{url, status}` and served from `links` (text, or `{status, text}` — a
      404 is served as asked; `{raise: message}` fails the fetch outright
      with ConnectionError, recorded with status 0) and `files` (URL →
      base64 bytes). The real
      decoders run on those bytes, so a node that works on a downloaded
      picture or sound goes on to its next call. A GET the case doesn't serve
      raises UnservedGet, which the node can't swallow, and fails the case.

    Returns `{calls, gets, output, ui}` — `output` as Python returned it:
    strings verbatim, a downloaded file as `{image|video|audio: url}`, an
    input picture as `{image: "IMG:<name>"}`, any other picture as `{tensor:
    {shape, sha256}}` (sha256 of its 8-bit bytes by save_generation_output's
    rule) — or `error` (type and message) when execute raised."""
    if "--allow-network" not in sys.argv[1:]:
        block_network()
    import hashlib
    import aiohttp
    import numpy as np
    import torch
    from runner_builder_fixtures import SAVE_HELPERS, UNREADABLE_BOARD_PREFIX, _node_modules
    nr, fal_refs, extras = _node_modules()
    from comfy_api.latest._io import HiddenHolder
    from comfy_api_nodes.util import download_helpers as dh

    calls: list = []
    gets: list = []
    queue = list(answers)
    counters: dict = {}
    saved_inputs: list = []
    made: dict = {}
    served = _served(links or {}, files or {})
    named: dict = {}  # id(object) → (kind, label); objects kept alive in `keep`
    keep: list = []

    def name(obj, kind, label):
        named[id(obj)] = (kind, label)
        keep.append(obj)
        return obj

    def serve(url):
        if url not in served:
            gets.append({"url": url, "status": None})
            raise UnservedGet(f"GET {url!r} is not served by the case")
        status, body = served[url]
        if status == "raise":
            # A fetch that fails outright (R3.6: Layerize's layer JSON): recorded with status 0.
            gets.append({"url": url, "status": 0})
            raise ConnectionError(body.decode("utf-8"))
        gets.append({"url": url, "status": status})
        return status, body

    def answer(provider, endpoint, payload):
        # Serialised at once, so a later change to the dict can't alter the record.
        # `payload_json`: the wire text (json.dumps, as aiohttp's json= sends it), keys sorted, so 1.0 and 1 differ.
        calls.append({"provider": provider, "endpoint": endpoint, "payload": json.loads(json.dumps(payload)),
                      "payload_json": json.dumps(payload, sort_keys=True)})
        if not queue:
            raise RuntimeError(f"no answer programmed for call {len(calls)} ({endpoint})")
        a = queue.pop(0)
        # A body text given as it is ({"__body__": text}, paidParity.ts RawBody): what json.loads reads of it.
        return json.loads(a["__body__"]) if isinstance(a, dict) and set(a) == {"__body__"} else a

    async def fake_replicate(model, input_dict, **_kw):
        return answer("replicate", model, input_dict)

    async def fake_fal(app, fn, input_dict, **_kw):
        return answer("fal", f"{app}/{fn}" if fn else app, input_dict)

    async def fake_upload(data, filename, content_type="application/octet-stream"):
        return f"UPLOAD:{filename}"

    async def fake_hosted(src, content_type, fallback_name):
        return src if str(src).startswith(("http://", "https://")) or not src else f"UPLOAD:{fallback_name}"

    real_image_url = nr._image_tensor_to_data_url
    real_wav_url = nr._audio_dict_to_wav_data_url

    def image_url(t):
        label = named.get(id(t))
        if label and label[0] == "input":
            return f"IMG:{label[1]}"
        png = _unb64(real_image_url(t).split(",", 1)[1])
        key = f"PNG:{hashlib.sha256(png).hexdigest()}"
        if made_pixels:
            import io as _io
            from PIL import Image as _Image
            arr = np.array(_Image.open(_io.BytesIO(png)))
            made[key] = {"shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}
        return key

    def wav_url(a, max_seconds=None):
        label = named.get(id(a))
        if label and label[0] == "input":
            return f"WAV:{label[1]}"
        wav = _unb64(real_wav_url(a, max_seconds=max_seconds).split(",", 1)[1])
        return f"WAV:{hashlib.sha256(wav).hexdigest()}"

    async def fake_bytesio(url, dest, **_kw):
        status, body = serve(str(url))
        if status != 200:
            raise RuntimeError(f"HTTP {status} for {url}")
        if isinstance(dest, (str, os.PathLike)):
            with open(dest, "wb") as f:
                f.write(body)
        else:
            dest.write(body)
            if hasattr(dest, "seek"):
                dest.seek(0)

    real_image = dh.download_url_to_image_tensor
    real_video = dh.download_url_to_video_output
    real_audio = nr._download_url_to_audio_dict

    async def fake_image(url, *a, **k):
        return name(await real_image(url, *a, **k), "download", ("image", url))

    async def fake_video(url, *a, **k):
        return name(await real_video(url, *a, **k), "download", ("video", url))

    async def fake_audio(url, *a, **k):
        return name(await real_audio(url, *a, **k), "download", ("audio", url))

    def describe(v):
        label = named.get(id(v))
        if label and label[0] == "download":
            return {label[1][0]: label[1][1]}
        if label and label[0] == "input":
            return {"image": f"IMG:{label[1]}"} if isinstance(v, torch.Tensor) else {"audio": f"WAV:{label[1]}"}
        if isinstance(v, torch.Tensor):
            arr = np.clip(255.0 * v.detach().cpu().float().numpy(), 0, 255).astype(np.uint8)
            return {"tensor": {"shape": list(v.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}}
        return None

    def jsonable(v):
        d = describe(v)
        if d is not None:
            return d
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, (list, tuple)):
            return [jsonable(x) for x in v]
        if isinstance(v, dict):
            return {str(k): jsonable(x) for k, x in v.items()}
        return {"repr": type(v).__name__}

    def fake_generation(tensor, filename_prefix="generation"):
        return {"images": [{"prefix": filename_prefix, "image": jsonable(tensor)}], "animated": [False]}

    def fake_live(tensor, node_id=None, unique=False):
        return {"images": [{"live_preview": jsonable(tensor)}]}

    def fake_to_input(tensor, filename_prefix="layer"):
        counters[filename_prefix] = counters.get(filename_prefix, 0) + 1
        file = f"{filename_prefix}_{counters[filename_prefix]:05}_.png"
        # What save_image_to_input writes (R3.6 fix round 1): the 8-bit pixels, by its own rule.
        img = tensor if tensor.ndim == 3 else tensor[0]
        arr = np.clip(255.0 * img.detach().cpu().float().numpy(), 0, 255).astype(np.uint8)
        saved_inputs.append({"file": file, "shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()})
        return file

    loaded: dict = {}
    for pname, data in (pictures or {}).items():
        kwargs[pname] = name(_picture_tensor(data, (picture_modes or {}).get(pname, "RGB")), "input", pname)
        if made_pixels:
            arr = np.clip(255.0 * kwargs[pname][0].numpy(), 0, 255).round().astype(np.uint8)
            loaded[pname] = {"shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}
    for sname, data in (sounds or {}).items():
        kwargs[sname] = name(_sound_dict(data), "input", sname)
    for tname, t in (tensors or {}).items():
        kwargs[tname] = t

    saves = {"save_generation_output": fake_generation, "save_live_preview": fake_live, "save_image_to_input": fake_to_input}
    patches = [
        mock.patch.object(node_cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})),
        mock.patch.object(nr, "_run_prediction", fake_replicate),
        mock.patch.object(fal_refs, "run_fal_prediction", fake_fal),
        mock.patch.object(fal_refs, "get_fal_token", lambda: "fixture-token"),
        mock.patch.object(nr, "_upload_public_file", fake_upload),
        mock.patch.object(nr, "_lipsync_hosted_media_url", fake_hosted),
        mock.patch.object(nr, "_image_tensor_to_data_url", image_url),
        mock.patch.object(nr, "_audio_dict_to_wav_data_url", wav_url),
        mock.patch.object(dh, "download_url_to_bytesio", fake_bytesio),
        mock.patch.object(nr, "download_url_to_image_tensor", fake_image),
        mock.patch.object(nr, "download_url_to_video_output", fake_video),
        mock.patch.object(nr, "_download_url_to_audio_dict", fake_audio),
        mock.patch.object(nr, "_moodboard_ref_data_urls",
                          lambda folder, files, input_dir=None: [f"BOARD:{f}" for f in files
                                                                 if not f.startswith(UNREADABLE_BOARD_PREFIX)]),
        mock.patch.object(aiohttp, "ClientSession", _fake_session(serve)),
    ]
    for mod in [nr, *extras, sys.modules.get(node_cls.__module__)]:
        for helper in SAVE_HELPERS:
            if mod is not None and hasattr(mod, helper):
                patches.append(mock.patch.object(mod, helper, saves[helper]))

    result = {"calls": calls, "gets": gets}
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        try:
            out = asyncio.run(node_cls.execute(**kwargs))
        except UnservedGet:
            raise
        except Exception as e:  # noqa: BLE001 — the node's own failure is part of the fixture
            result["error"] = {"type": type(e).__name__, "message": str(e)}
    # Loud even when something caught the sentinel: a case never takes a branch silently.
    unserved = [g["url"] for g in gets if g["status"] is None]
    if unserved:
        raise RuntimeError(f"{node_cls.__name__}: GETs the case doesn't serve: {unserved}")
    if made_pixels:
        result["made"] = made
        result["loaded"] = loaded
    if "error" in result:
        return result
    args = getattr(out, "args", out)
    result["output"] = jsonable(list(args) if isinstance(args, tuple) else args)
    result["ui"] = jsonable(getattr(out, "ui", None))
    if saved_inputs:
        result["saved_inputs"] = saved_inputs
    return result


def paid_case(name: str, node_cls, widgets: dict, answers: list, pictures=(), sounds=(),
              links: dict | None = None, files: dict | None = None, picture_modes: dict | None = None,
              made_pixels: bool = False) -> dict:
    """One fixture case (tests/unit/__runner__/paidParity.ts PaidCase): the
    node's widgets, its picture and sound inputs, the answers and served
    files, and what capture_calls saw. `pictures` / `sounds`: input names
    (each given a small deterministic file) or name → bytes. The input files
    are written into the case (base64) so the TypeScript side sends the same
    bytes."""
    def files_of(given, make):
        if isinstance(given, dict):
            return dict(given)
        return {n: make(n, i) for i, n in enumerate(given)}
    pics = files_of(pictures, lambda n, i: png_bytes(8, 6, 1000 + i))
    snds = files_of(sounds, lambda n, i: wav_bytes(0.25, 8000, 2000 + i))
    got = capture_calls(node_cls, answers, links=links, files=files, pictures=pics, sounds=snds,
                        picture_modes=picture_modes, made_pixels=made_pixels, **widgets)
    case = {"name": name, "class_type": node_cls.define_schema().node_id, "widgets": widgets,
            "pictures": list(pics), "sounds": list(snds),
            "picture_files": {n: _b64(b) for n, b in pics.items()},
            "sound_files": {n: _b64(b) for n, b in snds.items()},
            "answers": answers, "calls": got["calls"], "gets": got["gets"],
            "output": got.get("output"), "ui": got.get("ui")}
    if links:
        case["links"] = links
    if files:
        case["files"] = files
    if "error" in got:
        case["error"] = got["error"]
    if "saved_inputs" in got:
        case["saved_inputs"] = got["saved_inputs"]
    if picture_modes:
        case["picture_modes"] = picture_modes
    if "made" in got:
        case["made"] = got["made"]
    if "loaded" in got:
        case["loaded"] = got["loaded"]
    return case


# ── machinery (R3.1): json.loads / json.dumps / str / repr ──────────────────

MACHINERY_BODIES = [
    # ints past 2**53, big and negative, and -0 (an int: 0)
    '{"id": 9007199254740993, "big": 123456789012345678901234567890, "neg": -18446744073709551617, "z": -0}',
    '[0, -0, 1, -1, 9007199254740992, 9007199254740993]',
    # floats that are whole, exponents, signed zero, tiny and huge
    '{"a": 1.0, "b": 1e5, "c": 1E-7, "d": -0.0, "e": 2.5e+16, "f": 0.1, "g": 1e400, "h": -1e400}',
    '[1.0, 10.0, 100.0, 1e15, 1e16, 1e17, 0.0001, 0.00001, 123.456, 5e-324, 1.7976931348623157e308]',
    '[3.141592653589793, 2.718281828459045, 1.5, -2.25, 1e-10, 123456789.0, 0.30000000000000004]',
    # NaN and the infinities Python's json reads
    '{"nan": NaN, "inf": Infinity, "ninf": -Infinity}',
    '[NaN, Infinity, -Infinity]',
    # non-ASCII, escapes, astral characters (written raw and as escapes), control escapes
    '{"t": "café", "raw": "café — naïve ☃", "emoji": "\\ud83d\\ude00", "rawEmoji": "😀🎉"}',
    '["\\"quoted\\"", "back\\\\slash", "slash\\/", "\\b\\f\\n\\r\\t", "\\u0000\\u001f\\u007f", "tab\\there"]',
    '"\\u00e9\\u4e2d\\ud800"',
    '"日本語のテキスト"',
    '"a raw lone surrogate \ud800 and a raw pair \ud83d\ude00"',
    # repeated keys: first place, last value
    '{"a": 1, "b": 2, "a": 3}',
    '{"x": {"k": 1, "k": {"deep": [1, 2]}}, "y": [], "x": {"k": 0}}',
    # nesting and empties
    '{"a": {"b": {"c": [[], {}, [{}], [[1.0]]]}}, "empty": "", "t": true, "f": false, "n": null}',
    '[[[[[[[[[["deep"]]]]]]]]]]',
    '{}',
    '[]',
    # blanks around and between tokens
    ' \t\n\r{ "a" :\t[ 1 , 2.0 ]\r\n} \n',
    # top-level scalars
    '"just a string"',
    '42',
    '-3.5',
    'true',
    'null',
    # what a text model answers (a token list, a dict with usage)
    '{"output": ["Hello", ",", " world", "!"], "metrics": {"input_token_count": 12, "output_token_count": 4, "predict_time": 0.53}}',
    '{"objects": [{"label": "cat", "score": 0.98, "box": [10, 20.5, 110, 220]}, {"label": "dog", "score": 1.0, "box": [0, 0, 1e2, 5E1]}]}',
    # refused by json.loads
    '{"a": 1,}',
    '[1, 2',
    '01',
    '1.',
    '.5',
    '+1',
    '"tab\there"',
    '"bad \\x escape"',
    '"\\u12"',
    '{a: 1}',
    '[1] [2]',
    '﻿{"bom": true}',
    '-',
    '-Inf',
    'nan',
    '',
    # int()'s digit limit (4300 digits): refused; 4300 digits: read
    '[' + '9' * 4301 + ']',
    '[' + '9' * 4300 + ']',
]

MACHINERY_SCALARS = [
    '"text"', '""', '"  spaced  "', '"caf\\u00e9 \\ud83d\\ude00"', '"line\\nbreak"',
    '0', '-0', '7', '-12', '9007199254740993', '123456789012345678901234567890',
    '1.0', '-0.0', '1e5', '1E-7', '0.1', '2.5e+16', '1e16', '1e15', '0.0001', '0.00001', '5e-324',
    'NaN', 'Infinity', '-Infinity', 'true', 'false', 'null',
]

_EDGE_FLOATS = [
    0.0, -0.0, 1.0, -1.0, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 0.1 + 0.2, 1e16, 1e15, 9999999999999998.0,
    1e17, 1e22, 1e23, 1e-4, 1e-5, 0.0001, 0.00012345, 1.5e-5, 5e-324, 2.2250738585072014e-308,
    2.225073858507201e-308, 1.7976931348623157e308, float(2 ** 53), float(2 ** 53 + 1), float(2 ** 63),
    123456789012345680.0, 1234567890123456.8, 0.5, 0.25, 100.0, 1e100, 1e-100, 4.35, 2.675, 1.005,
    float("inf"), float("-inf"),
]


def _float_hex(x: float) -> str:
    return struct.pack(">d", x).hex()


def _machinery_floats() -> list:
    rng = random.Random(20260927)
    out = list(_EDGE_FLOATS)
    while len(out) < 10_000:
        kind = len(out) % 4
        if kind == 0:
            # any bit pattern but NaN (its repr is 'nan' whatever the payload)
            x = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
            if x != x:
                continue
        elif kind == 1:
            x = round(rng.uniform(-1e6, 1e6), rng.randint(0, 9))
        elif kind == 2:
            x = rng.choice((1.0, -1.0)) * 10 ** rng.uniform(-25, 25)
        else:
            x = float(rng.randint(-2 ** 62, 2 ** 62)) / rng.choice((1, 2, 4, 10, 100, 1000, 3, 7))
        out.append(x)
    return [{"bits": _float_hex(x), "repr": repr(x)} for x in out]


def machinery_group() -> dict:
    bodies = []
    for text in MACHINERY_BODIES:
        try:
            bodies.append({"text": text, "dumps": json.dumps(json.loads(text))})
        except ValueError as e:  # JSONDecodeError is a ValueError, as is int()'s digit limit
            bodies.append({"text": text, "error": type(e).__name__})
    scalars = [{"text": t, "str": str(json.loads(t))} for t in MACHINERY_SCALARS]
    return {"bodies": bodies, "scalars": scalars, "floats": _machinery_floats()}


# ── llm (R3.3): the seven LLM text nodes ────────────────────────────────────

LLM_TEXTS = {
    "blank": "",
    "spaces": "   \t ",
    "one line": "A red fox jumps over a sleeping dog.",
    "2000 chars": ("The quick brown fox jumps over the lazy dog. " * 45)[:2000],
    "non-ASCII": "Caf\u00e9 na\u00efve \u2014 \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8, \u00fcber \u0161\u0107",
    "emoji": "\U0001f389 party time \U0001f600 with \U0001f98a",
}


def _llm_body(output, metrics=True, raw_output=None) -> dict:
    """A Replicate prediction body as text (numbers keep their written form)."""
    out_text = raw_output if raw_output is not None else json.dumps(output)
    m = ', "metrics": {"input_token_count": 37, "output_token_count": 12, "predict_time": 0.5}' if metrics else ""
    return {"__body__": '{"id": "p1", "status": "succeeded", "output": ' + out_text + m + "}"}


LLM_ANSWERS = {
    "token list": _llm_body(["Hello", ",", " world", "!"]),
    "string with spaces": _llm_body("  \n  A tidy answer.\u3000 \n"),
    "null": _llm_body(None),
    "mixed list": _llm_body(None, raw_output="[1, 2.0, true, null]"),
    "no metrics": _llm_body(["No", " metrics"], metrics=False),
    "list with markers": _llm_body(
        "1. First idea\n\n- Second idea\n  * Third idea\n2) Fourth\n\u2022 Fifth\n\n10. Tenth stays numbered\n1.2.3 nested"),
    "unicode breaks": _llm_body("alpha\u2028- beta\x85gamma\r\ndelta\rep\x0bzeta\x0ceta\x1ctheta\x1diota\x1ekappa\u2029lambda"),
    "full-width digit": _llm_body("\uff11. full width one\n\u00b2) superscript two\n\u2460. circled one\n\U0001d7ce. math zero\n\u0663) arabic three"),
    "numbers": _llm_body(None, raw_output="42"),
    "false": _llm_body(None, raw_output="false"),
    "float": _llm_body(None, raw_output="1e5"),
}


def llm_group() -> dict:
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    answer = [LLM_ANSWERS["token list"]]
    cases: list = []

    def add(name, cls, widgets, answers=None):
        cases.append(paid_case(name, cls, widgets, answers if answers is not None else answer))

    # Every class × model × text kind.
    per_model = [
        ("chat", nr.ChatLLMNode, list(nr._CHAT_LLM_MODELS),
         lambda m, t: {"model": m, "prompt": t, "system_prompt": "", "temperature": 1.0, "max_tokens": 1024}),
        ("improve", nr.ImprovePromptNode, ["GPT-5 nano"], lambda m, t: {"model": m, "idea": t, "target": "image"}),
        ("summarize", nr.SummarizeTextNode, list(nr._SUMMARIZE_MODELS), lambda m, t: {"text": t, "length": "Short", "model": m}),
        ("translate", nr.TranslateTextNode, [None], lambda m, t: {"text": t, "target_language": "French", "custom_language": ""}),
        ("rewrite", nr.RewriteToneNode, list(nr._REWRITE_MODELS), lambda m, t: {"text": t, "tone": "Punchy", "model": m}),
        ("brainstorm", nr.BrainstormIdeasNode, [None], lambda m, t: {"topic": t, "count": 3, "angle": "Variations"}),
        ("reason", nr.ReasonStepByStepNode, list(nr._REASON_MODELS), lambda m, t: {"question": t, "include_reasoning": False, "model": m}),
    ]
    for tag, cls, models, widgets in per_model:
        for m in models:
            for kind, text in LLM_TEXTS.items():
                add(f"{tag} · {m or 'fixed model'} · {kind}", cls, widgets(m, text))

    # Chat: with and without a system prompt, temperature 0, 1 and 2, max tokens 1 and 8192, on each model.
    for m in nr._CHAT_LLM_MODELS:
        for system in ("", "You are a concise copywriter. \u2728"):
            for temp in (0.0, 1.0, 2.0):
                for mx in (1, 8192):
                    add(f"chat · {m} · system {'on' if system else 'off'} · t{temp} · max {mx}", nr.ChatLLMNode,
                        {"model": m, "prompt": "Name a colour.", "system_prompt": system, "temperature": temp, "max_tokens": mx})
    add("chat · spaces-only system prompt is sent", nr.ChatLLMNode,
        {"model": "GPT-5", "prompt": "Hi", "system_prompt": "  ", "temperature": 0.35, "max_tokens": 64})

    # Improve: both targets.
    for target in ("image", "video"):
        add(f"improve · target {target}", nr.ImprovePromptNode, {"model": "GPT-5 nano", "idea": "a cat on a skateboard", "target": target})

    # Summarize: every length.
    for length in nr._SUMMARIZE_LENGTHS:
        add(f"summarize · {length}", nr.SummarizeTextNode, {"text": "Long text here.", "length": length, "model": "Gemini 3 Flash"})

    # Translate: every language, and a custom one with spaces around it (and a blank custom one).
    for lang in nr._TRANSLATE_LANGUAGES:
        add(f"translate · {lang}", nr.TranslateTextNode, {"text": "Good morning", "target_language": lang, "custom_language": ""})
    add("translate · custom with spaces", nr.TranslateTextNode, {"text": "Good morning", "target_language": "German", "custom_language": "  Welsh \u3000"})
    add("translate · custom spaces only", nr.TranslateTextNode, {"text": "Good morning", "target_language": "Korean", "custom_language": " \t "})

    # Rewrite: every tone.
    for tone in nr._REWRITE_TONES:
        add(f"rewrite · {tone}", nr.RewriteToneNode, {"text": "We sell shoes.", "tone": tone, "model": "Claude 4.5 Haiku"})

    # Brainstorm: every angle, counts 2 and 12.
    for angle in nr._BRAINSTORM_ANGLES:
        add(f"brainstorm · {angle}", nr.BrainstormIdeasNode, {"topic": "A poster for a coffee shop", "count": 3, "angle": angle})
    for count in (2, 12):
        add(f"brainstorm · count {count}", nr.BrainstormIdeasNode, {"topic": "Coffee", "count": count, "angle": "Free"})

    # Reason: with and without the reasoning shown.
    for m in nr._REASON_MODELS:
        for inc in (False, True):
            add(f"reason · {m} · reasoning {'shown' if inc else 'hidden'}", nr.ReasonStepByStepNode,
                {"question": "What is 17 * 23?", "include_reasoning": inc, "model": m})

    # Every answer shape, through Chat (no ui), Summarize (ui) and Brainstorm (the clean-up), at counts 2 and 12.
    for aname, ans in LLM_ANSWERS.items():
        add(f"answer · chat · {aname}", nr.ChatLLMNode,
            {"model": "GPT-5", "prompt": "Say hi", "system_prompt": "", "temperature": 0.5, "max_tokens": 64}, [ans])
        add(f"answer · summarize · {aname}", nr.SummarizeTextNode, {"text": "Text", "length": "Short", "model": "GPT-5 nano"}, [ans])
        for count in (2, 12):
            add(f"answer · brainstorm {count} · {aname}", nr.BrainstormIdeasNode, {"topic": "Tea", "count": count, "angle": "Free"}, [ans])

    digits = [c for c in range(0x110000) if chr(c).isdigit()]
    ranges: list = []
    for c in digits:
        if ranges and ranges[-1][1] == c - 1:
            ranges[-1][1] = c
        else:
            ranges.append([c, c])
    return {"cases": cases, "isdigit_ranges": ranges}


# ── describe (R3.4): Describe an image (+ twin), Describe a video, Extract text, Find objects ──

DESCRIBE_PROMPTS = {
    "default": "Describe this image in detail.",
    "empty": "",
    "non-ASCII": "Qu'y a-t-il sur l'étiquette ? 日本語 \U0001f98a",
}

VIDEO_URL = "https://example.test/clip.mp4"


def _body(raw_output: str) -> dict:
    """A Replicate prediction body as text, its `output` written as given (numbers keep their form)."""
    return {"__body__": '{"id": "p1", "status": "succeeded", "output": ' + raw_output + ', "metrics": {"predict_time": 0.4}}'}


TEXT_ANSWERS = {
    "token list": _body('["A ", "red", " fox", ".", "  "]'),
    "string with spaces": _body('"  \\n A tidy caption.\\u3000 \\n"'),
    "null": _body("null"),
    "mixed list": _body("[1, 2.0, true, null, \"x\"]"),
    "empty list": _body("[]"),
    "number": _body("42"),
    "float": _body("1e5"),
    "false": _body("false"),
    "non-ASCII string": _body('"Caf\\u00e9 — \U0001f98a"'),
}

EXTRACT_ANSWERS = {
    "pages list": _body('["# Page 1\\n", "Page 2 \\u2603", 3, 2.0, null, true]'),
    "empty list": _body("[]"),
    "dict text": _body('{"text": "  Hello text  ", "markdown": "ignored"}'),
    "dict markdown": _body('{"markdown": "# Title\\n\\nBody", "transcription": "ignored"}'),
    "dict transcription": _body('{"transcription": "spoken words"}'),
    "dict falsy text": _body('{"text": "", "markdown": 0, "transcription": "third"}'),
    "dict number": _body('{"markdown": 12.0}'),
    "dict none": _body('{"pages": 2, "blocks": []}'),
    "empty dict": _body("{}"),
    "string": _body('"  plain markdown\\n"'),
    "null": _body("null"),
    "number": _body("7"),
    "true": _body("true"),
}

FIND_ANSWERS = {
    "string": _body('"{\\"objects\\": [1.0, 2]}  "'),
    "dict with floats": _body('{"detections": [{"label": "caf\\u00e9", "confidence": 0.9, "x": 12.0, "y": 1e-3, "width": 1E2, '
                              '"height": 5, "big": 123456789012345678901}], "count": 1, "ok": true, "none": null}'),
    "list": _body('[{"label": "person", "box": [0.0, 10.5, -0.0, 2.5e+16]}, "\\u65e5\\u672c", []]'),
    "null": _body("null"),
    "number": _body("3.0"),
    "empty dict": _body("{}"),
    # (No NaN or Infinity: Replicate answers in strict JSON, and the runner's clients read it with JSON.parse.)
    "nested": _body('{"a": {"b": {"c": [[], {}, [1.0, -0.0, 1e300, 1.5e-7]]}}}'),
}


def describe_group() -> dict:
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    cases: list = []

    def add(name, cls, widgets, answers, pictures=("image",)):
        cases.append(paid_case(name, cls, widgets, answers, pictures=list(pictures)))

    caption = [TEXT_ANSWERS["token list"]]
    # Describe an image, its hidden twin and Describe a video: every prompt, then every answer shape.
    for pname, prompt in DESCRIBE_PROMPTS.items():
        add(f"describe · {pname}", nr.DescribeImageNode, {"model": "Moondream 2", "prompt": prompt}, caption)
        add(f"describe twin · {pname}", nr.DescribeImageRemoteNode, {"prompt": prompt}, caption)
        add(f"video · {pname}", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": VIDEO_URL, "prompt": prompt}, caption, pictures=())
    for aname, ans in TEXT_ANSWERS.items():
        add(f"answer · describe · {aname}", nr.DescribeImageNode, {"model": "Moondream 2", "prompt": "What is it?"}, [ans])
        add(f"answer · describe twin · {aname}", nr.DescribeImageRemoteNode, {"prompt": "What is it?"}, [ans])
        add(f"answer · video · {aname}", nr.DescribeVideoNode,
            {"model": "Gemini 2.5 Flash", "video_url": VIDEO_URL, "prompt": "Summarize."}, [ans], pictures=())
    # Describe a video with no address: Python raises before any call.
    add("video · blank address", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": "", "prompt": "Describe."}, [], pictures=())
    # An address of spaces is sent as it is (Python's `if not video_url`).
    add("video · spaces address", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": "   ", "prompt": "Describe."}, caption, pictures=())

    # Extract text: every answer shape.
    for aname, ans in EXTRACT_ANSWERS.items():
        add(f"extract · {aname}", nr.ExtractTextNode, {"model": "ByteDance Dolphin"}, [ans])

    # Find objects: confidence 0, 0.25 and 1; the default query, an empty one, one with spaces and commas, non-ASCII.
    found = [FIND_ANSWERS["dict with floats"]]
    for conf in (0.0, 0.25, 1.0):
        add(f"find · confidence {conf}", nr.FindObjectsNode, {"model": "YOLO-World", "query": "person, car, dog", "confidence": conf}, found)
    for qname, query in {"empty": "", "spaces and commas": "  red car ,, person ,  traffic light,", "non-ASCII": "café, 猫"}.items():
        add(f"find · query {qname}", nr.FindObjectsNode, {"model": "YOLO-World", "query": query, "confidence": 0.25}, found)
    for aname, ans in FIND_ANSWERS.items():
        add(f"answer · find · {aname}", nr.FindObjectsNode, {"model": "YOLO-World", "query": "person", "confidence": 0.25}, [ans])
    return {"cases": cases}


UPSCALE_DEFAULTS = {
    "model": "Clarity", "prompt": "masterpiece, best quality, highres", "scale_factor": 2.0, "creativity": 0.35,
    "resemblance": 0.6, "negative_prompt": "(worst quality, low quality, normal quality:2)", "num_inference_steps": 18,
    "seed": 0, "face_enhance": False, "topaz_enhance_model": "Standard V2", "topaz_upscale_factor": "2x",
    "topaz_subject_detection": "None", "topaz_output_format": "png", "topaz_face_creativity": 0.0,
    "topaz_face_strength": 0.8, "crystal_creativity": 0.0, "crystal_output_format": "png",
}
ENHANCE_DEFAULTS = {
    "model": "Creative", "prompt": "masterpiece, best quality, highres", "detail_strength": 0.4, "resemblance": 0.6,
    "negative_prompt": "(worst quality, low quality, normal quality:2)", "num_inference_steps": 18, "seed": 0,
    "topaz_enhance_model": "Standard V2", "topaz_subject_detection": "None", "topaz_output_format": "png", "refine_steps": 20,
}
REPAIR_OUT = "https://r.test/repaired.png"
REPAIR_OUT_2 = "https://r.test/second.png"


def repair_group() -> dict:
    """R3.5: Upscale (every engine), Enhance detail (every engine), Restore an
    old photo and Remove background, and the hidden twins of the last two.
    Each answers one picture URL; the first of a list is the one downloaded
    (`_first_output_url`)."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgb = _b64(png_bytes(8, 6, 11))
    rgba = _b64(png_bytes(8, 6, 12, "RGBA"))
    cases: list = []

    def add(name, cls, widgets, answer=None, files=None):
        answers = [answer or {"output": [REPAIR_OUT]}]
        cases.append(paid_case(name, cls, widgets, answers, pictures=["image"], files=files or {REPAIR_OUT: rgb}))

    def up(name, **w):
        add(f"upscale · {name}", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, **w})

    def enh(name, **w):
        add(f"enhance · {name}", nr.EnhanceDetailNode, {**ENHANCE_DEFAULTS, **w})

    # Upscale: every engine at its default, then each setting the brief names.
    for engine in ("Clarity", "Crystal", "Real-ESRGAN", "Recraft Crisp", "Topaz"):
        up(f"{engine} default", model=engine)
    for seed in (0, 42):
        up(f"Clarity seed {seed}", seed=seed)
    for scale in (1.0, 10.0, 2.5):
        up(f"Clarity scale {scale}", scale_factor=scale)
    up("Clarity non-ASCII prompt", prompt="caf\u00e9 \u732b, sharp", negative_prompt="")
    for factor in ("None", "2x", "4x", "6x"):
        for face in (False, True):
            up(f"Topaz {factor} face {'on' if face else 'off'}", model="Topaz", topaz_upscale_factor=factor, face_enhance=face,
               topaz_face_creativity=0.25, topaz_face_strength=1.0)
    up("Topaz every other setting", model="Topaz", topaz_enhance_model="Text Refine", topaz_subject_detection="Foreground",
       topaz_output_format="jpg")
    for fmt in ("png", "jpg"):
        up(f"Crystal {fmt}", model="Crystal", crystal_output_format=fmt, crystal_creativity=3.5, scale_factor=4.0)
    for face in (False, True):
        up(f"Real-ESRGAN face {'on' if face else 'off'}", model="Real-ESRGAN", face_enhance=face, scale_factor=3.0)
    # Enhance detail: each engine at detail 0, 0.4 and 1; seeds and the other settings.
    for engine in ("Creative", "Faithful", "Diffusion Refine"):
        for detail in (0.0, 0.4, 1.0):
            enh(f"{engine} detail {detail}", model=engine, detail_strength=detail)
        enh(f"{engine} seed 7", model=engine, seed=7)
    enh("Creative every other setting", resemblance=1.25, negative_prompt="blurry", num_inference_steps=30, prompt="")
    enh("Faithful every other setting", model="Faithful", topaz_enhance_model="CGI", topaz_subject_detection="All", topaz_output_format="jpg")
    enh("Diffusion Refine every other setting", model="Diffusion Refine", refine_steps=50, prompt="a crisp portrait")

    # Restore an old photo and its twin: both formats; the twin's safety as text.
    for fmt in ("png", "jpg"):
        add(f"restore · {fmt}", nr.RestorePhotoNode, {"model": "Flux Kontext \u00b7 Restore", "safety_tolerance": 2, "output_format": fmt})
        add(f"restore twin · {fmt}", nr.RestorePhotoRemoteNode, {"safety_tolerance": "2", "output_format": fmt})
    # Safety 6: the node offers it (1-6); Replicate's schema says 0-2. Python sends it; the live check decides.
    add("restore · safety 6", nr.RestorePhotoNode, {"model": "Flux Kontext \u00b7 Restore", "safety_tolerance": 6, "output_format": "png"})
    for label, text in (("1", "1"), ("text", "strict"), ("empty", ""), ("spaced", " 2"), ("decimal", "2.5"), ("minus", "-1")):
        add(f"restore twin · safety {label}", nr.RestorePhotoRemoteNode, {"safety_tolerance": text, "output_format": "png"})
    # Digits Python's isdigit() takes that aren't 0-9: a superscript (int() raises, no call) and an Arabic-Indic three (sent as 3).
    add("restore twin · safety superscript", nr.RestorePhotoRemoteNode, {"safety_tolerance": "\u00b2", "output_format": "png"})
    add("restore twin · safety arabic-indic", nr.RestorePhotoRemoteNode, {"safety_tolerance": "\u0663", "output_format": "png"})

    # Remove background and its twin: an RGBA cut-out; the answer as a list, a string, and a list of two (the first).
    cut = {REPAIR_OUT: rgba}
    add("remove background · list", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": [REPAIR_OUT]}, cut)
    add("remove background · string", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": REPAIR_OUT}, cut)
    add("remove background · two", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": [REPAIR_OUT, REPAIR_OUT_2]}, cut)
    add("remove background twin · list", nr.RemoveBackgroundRemoteNode, {}, {"output": [REPAIR_OUT]}, cut)
    add("remove background twin · string", nr.RemoveBackgroundRemoteNode, {}, {"output": REPAIR_OUT}, cut)
    # Upscale answering a plain string, and two URLs (the first is the picture).
    add("upscale · answer string", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, "model": "Real-ESRGAN"}, {"output": REPAIR_OUT})
    add("upscale · answer two", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, "model": "Recraft Crisp"}, {"output": [REPAIR_OUT, REPAIR_OUT_2]})
    return {"cases": cases}


LAYERIZE_BG = "https://r.test/layerize/bg.png"
LAYERIZE_JSON = "https://r.test/layerize/layers.json"
# The layer data as Ideogram writes it: non-ASCII, whole floats and an exponent kept as written.
LAYERIZE_BODY = ('{"width": 1024, "height": 768, "layers": [{"type": "text", "text": "Café — SALE", '
                 '"font_size": 48.0, "x": 1e2, "color": "#fff"}]}')
SEEDREAM_FLAT = "https://r.test/seedream/flat.png"


def _seedream_layer(i: int, **over) -> dict:
    layer = {
        "image": {"url": f"https://r.test/seedream/layer_{i}.png", "width": 64, "height": 48, "content_type": "image/png"},
        "z_index": i,
        "bounding_box": {"absolute": [i, i * 2, 32 + i, 24 + i], "normalized": [i * 10, i * 20, 500 + i, 500 + i]},
        "name": f"layer {i}",
        "description": f"element number {i}",
    }
    if i == 0:
        layer.pop("bounding_box")
        layer.pop("name")
        layer.pop("description")
    layer.update(over)
    return layer


def _seedream_answer(layers: list, images: list | None = None) -> dict:
    return {"images": [{"url": SEEDREAM_FLAT, "width": 64, "height": 48}] if images is None else images, "layers": layers}


def layers_group() -> dict:
    """R3.6: Separate text from image (Ideogram Layerize), Layerize an image
    (fal Seedream 5 Pro Layerize) and Expand / outpaint (Flux Fill, Bria
    Expand). Layerize answers a picture and a JSON link (picked by
    extension); Seedream answers its layers (each downloaded and saved to the
    input folder) and a flat preview; Outpaint one picture, alpha dropped."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgba = lambda seed: _b64(png_bytes(8, 6, seed, "RGBA"))  # noqa: E731
    cases: list = []

    # ── Separate text from image (Layerize): prompts and seeds, then every answer shape.
    bg_files = {LAYERIZE_BG: rgba(21)}
    layer_links = {LAYERIZE_JSON: LAYERIZE_BODY}
    pair = {"output": [LAYERIZE_BG, LAYERIZE_JSON]}

    def layerize(name, widgets, answer=None, links=None, files=None):
        w = {"model": "Ideogram Layerize", "prompt": "", "seed": 0, **widgets}
        cases.append(paid_case(f"layerize · {name}", nr.LayerizeGraphicNode, w, [answer or pair], pictures=["image"],
                               links=layer_links if links is None else links, files=files or bg_files))

    for pname, prompt in {"blank": "", "spaces only": "   ", "spaced": "  a summer sale poster \n", "non-ASCII": "affiche été — 猫"}.items():
        layerize(f"prompt {pname}", {"prompt": prompt})
    for seed in (0, 1, 2 ** 31 - 1):
        layerize(f"seed {seed}", {"seed": seed})
    layerize("answer · picture first", {}, pair)
    layerize("answer · JSON first", {}, {"output": [LAYERIZE_JSON, LAYERIZE_BG]})
    noext = "https://r.test/layerize/background"
    layerize("answer · no extension", {}, {"output": [noext, LAYERIZE_JSON]}, files={noext: rgba(22)})
    upper = "https://r.test/layerize/BG.PNG?sig=1.json"
    layerize("answer · upper-case extension and a query", {}, {"output": [LAYERIZE_JSON, upper]}, files={upper: rgba(23)})
    layerize("answer · no JSON link", {}, {"output": [LAYERIZE_BG]}, links={})
    layerize("answer · a string", {}, {"output": LAYERIZE_BG}, links={})
    layerize("answer · JSON link fails", {}, pair, links={LAYERIZE_JSON: {"raise": "Connection reset by peer"}})
    # Python keeps a 404's body text (aiohttp's r.text() reads any status); the runner's error JSON instead (documented).
    layerize("answer · JSON link 404", {}, pair, links={LAYERIZE_JSON: {"status": 404, "text": "Not Found"}})
    layerize("answer · empty JSON body", {}, pair, links={LAYERIZE_JSON: ""})
    layerize("answer · no output", {}, {"output": None}, links={})
    layerize("answer · only the JSON link", {}, {"output": [LAYERIZE_JSON]}, links={})

    # ── Layerize an image (Seedream): every image_size and a bad one; answers of 2 and 17 layers and odd layers.
    def layer_files(layers: list, flat: bool = True) -> dict:
        out = {SEEDREAM_FLAT: rgba(40)} if flat else {}
        for i, layer in enumerate(layers):
            url = (layer.get("image") or {}).get("url") if isinstance(layer, dict) and isinstance(layer.get("image"), dict) else None
            if isinstance(url, str):
                out[url] = rgba(41 + i)
        return out

    def seedream(name, widgets, answer, files=None):
        w = {"prompt": "", "image_size": "auto", **widgets}
        body = {"__body__": json.dumps(answer)} if not isinstance(answer, str) else {"__body__": answer}
        parsed = json.loads(body["__body__"])
        cases.append(paid_case(f"seedream · {name}", nr.SeedreamLayerizeNode, w, [body], pictures=["image"],
                               files=files if files is not None else layer_files(parsed.get("layers") or [], bool(parsed.get("images")))))

    two = _seedream_answer([_seedream_layer(0), _seedream_layer(1)])
    for size in ("auto", "auto_1K", "auto_1.5K", "auto_2K", "8K"):
        seedream(f"image_size {size}", {"image_size": size}, two)
    seedream("prompt", {"prompt": "  keep the logo apart  "}, two)
    seedream("17 layers", {}, _seedream_answer([_seedream_layer(i) for i in range(17)]))
    seedream("a layer without bounding_box", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1, bounding_box=None), _seedream_layer(2)]))
    seedream("a non-dict layer", {}, _seedream_answer([_seedream_layer(0), "not a layer", 7, _seedream_layer(1)]))
    seedream("no images (the input is the preview)", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1)], images=[]))
    # Numbers as fal might write them: a float box, a float z_index, whole floats; non-ASCII names; a layer with no url.
    odd = ('{"images": [{"url": "' + SEEDREAM_FLAT + '", "width": 64.0, "height": 48}], "layers": ['
           '{"image": {"url": "https://r.test/seedream/layer_0.png", "width": 64, "height": 48}, "z_index": 0}, '
           '{"image": {"url": "https://r.test/seedream/layer_1.png"}, "z_index": 1.0, '
           '"bounding_box": {"absolute": [1.5, 2.0, 30, 1e1]}, "name": "Café — 猫", "description": null}, '
           '{"image": {"width": 3}, "z_index": 2}, '
           '{"image": {"url": "https://r.test/seedream/layer_3.png"}, "z_index": "3", "bounding_box": {"absolute": [1, 2, 3]}, '
           '"name": 5, "description": "😀 emoji"}]}')
    seedream("odd numbers and names", {}, odd, files={SEEDREAM_FLAT: rgba(40), "https://r.test/seedream/layer_0.png": rgba(41),
                                                         "https://r.test/seedream/layer_1.png": rgba(42), "https://r.test/seedream/layer_3.png": rgba(44)})
    # The base layer has no width: the size comes from images[0].
    seedream("base without a width", {}, _seedream_answer([_seedream_layer(0, image={"url": "https://r.test/seedream/layer_0.png"}), _seedream_layer(1)]))
    seedream("no layers", {}, {"images": [{"url": SEEDREAM_FLAT, "width": 64, "height": 48}], "layers": None})
    # Fix round 1: layers PIL reads its own way (a CMYK JPEG, 16-bit greyscale), and a Python-only name (a list).
    odd_files = _seedream_answer([_seedream_layer(0), _seedream_layer(1), _seedream_layer(2)])
    seedream("CMYK and 16-bit grey layers", {}, odd_files, files={
        SEEDREAM_FLAT: rgba(40), "https://r.test/seedream/layer_0.png": rgba(41),
        "https://r.test/seedream/layer_1.png": _b64(cmyk_jpeg_bytes(8, 6, 60)),
        "https://r.test/seedream/layer_2.png": _b64(grey16_png_bytes(8, 6, 61))})
    seedream("a name that is a list", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1, name=["a", 1.0, None])]))

    # ── Expand / outpaint: every direction (Flux Fill) and ratio (Bria Expand), seeds, prompts, an RGBA answer.
    out = "https://r.test/outpaint.png"

    def outpaint(name, widgets, answer=None, fill=None):
        w = {"model": "Flux Fill", "prompt": "", "direction": "Zoom out 1.5x", "aspect_ratio": "16:9", "seed": 0, **widgets}
        cases.append(paid_case(f"outpaint · {name}", nr.OutpaintImageNode, w, [answer or {"output": [out]}], pictures=["image"],
                               files={out: fill or _b64(png_bytes(8, 6, 50))}))

    for direction in ("Zoom out 1.5x", "Zoom out 2x", "Make square", "Left outpaint", "Right outpaint", "Top outpaint", "Bottom outpaint"):
        outpaint(f"Flux Fill {direction}", {"direction": direction})
    for ratio in ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"):
        outpaint(f"Bria Expand {ratio}", {"model": "Bria Expand", "aspect_ratio": ratio})
    for model in ("Flux Fill", "Bria Expand"):
        for seed in (0, 42):
            outpaint(f"{model} seed {seed}", {"model": model, "seed": seed})
        outpaint(f"{model} prompt spaced", {"model": model, "prompt": "  a forest clearing, soft daylight \n"})
        outpaint(f"{model} prompt spaces only", {"model": model, "prompt": "   "})
        outpaint(f"{model} RGBA answer", {"model": model}, fill=rgba(51))
    outpaint("Flux Fill answer a string", {}, {"output": out})
    # Fix round 1: answers PIL reads its own way.
    outpaint("Flux Fill CMYK JPEG answer", {}, fill=_b64(cmyk_jpeg_bytes(8, 6, 52)))
    outpaint("Bria Expand 16-bit grey answer", {"model": "Bria Expand"}, fill=_b64(grey16_png_bytes(8, 6, 53)))
    outpaint("Bria Expand seed 2^32-1", {"model": "Bria Expand", "seed": 2 ** 32 - 1})
    return {"cases": cases}


# ── split (R3.7): Separate background and foreground ────────────────────────

SPLIT_CUTOUT = "https://r.test/split/cutout.png"
SPLIT_BACKGROUND = "https://r.test/split/background.png"
SPLIT_FILLS = {"LaMa (fast)": "LaMa", "Bria Eraser (quality)": "Bria"}


def split_mask(w: int, h: int, seed: int) -> bytes:
    """A deterministic 8-bit mask (w × h, raw L bytes) that touches every edge
    and corner: distinct corner values, about a third of the border set, a
    few interior points and a solid block (a subject), so a max filter's edge
    rule shows wherever it differs."""
    rng = random.Random(seed)
    px = bytearray(w * h)
    for x in range(w):
        for y in (0, h - 1):
            if rng.random() < 0.35:
                px[y * w + x] = rng.randrange(1, 256)
    for y in range(h):
        for x in (0, w - 1):
            if rng.random() < 0.35:
                px[y * w + x] = rng.randrange(1, 256)
    for i in range(w * h):
        if rng.random() < 0.03:
            px[i] = rng.randrange(1, 256)
    bw, bh = max(1, w // 4), max(1, h // 4)
    bx, by = rng.randrange(0, max(1, w - bw)), rng.randrange(0, max(1, h - bh))
    for y in range(by, by + bh):
        for x in range(bx, bx + bw):
            px[y * w + x] = 255
    # Distinct corners (a 1-pixel side shares them: the last write wins).
    px[0] = 201
    px[w - 1] = 157
    px[(h - 1) * w] = 113
    px[(h - 1) * w + w - 1] = 67
    return bytes(px)


def _split_cutout(w: int, h: int, seed: int, kind: str = "RGBA") -> bytes:
    """The remover's cut-out, alpha from split_mask, in the file kind asked:
    RGBA, LA (grey + alpha), P (palette, alpha by tRNS), RGB (no alpha),
    CMYK (a JPEG) or I;16 (16-bit grey)."""
    import io
    from PIL import Image
    rng = random.Random(seed + 7)
    alpha = split_mask(w, h, seed)
    if kind == "CMYK":
        return cmyk_jpeg_bytes(w, h, seed)
    if kind == "I;16":
        return grey16_png_bytes(w, h, seed)
    buf = io.BytesIO()
    if kind == "P":
        img = Image.frombytes("P", (w, h), alpha)
        img.putpalette(bytes(rng.randrange(256) for _ in range(768)))
        img.save(buf, format="PNG", transparency=bytes(range(256)))
        return buf.getvalue()
    # The colours don't reach the mask: a smooth gradient keeps the fixture small.
    base = rng.randrange(256)
    grey = bytes((base + x + 3 * y) % 256 for y in range(h) for x in range(w))
    rgb = Image.merge("RGB", (Image.frombytes("L", (w, h), grey), Image.frombytes("L", (w, h), grey[::-1]),
                              Image.frombytes("L", (w, h), bytes((v + 85) % 256 for v in grey))))
    if kind == "LA":
        img = Image.merge("LA", (Image.frombytes("L", (w, h), grey), Image.frombytes("L", (w, h), alpha)))
    elif kind == "RGB":
        img = rgb
    else:
        img = rgb.convert("RGBA")
        img.putalpha(Image.frombytes("L", (w, h), alpha))
    img.save(buf, format="PNG")
    return buf.getvalue()


def _exif_picture(w: int, h: int, seed: int, orientation: int, fmt: str) -> bytes:
    """A deterministic RGB picture stored w × h with an EXIF orientation tag
    (R3.7 fix round 1: a phone photo), as a JPEG or a PNG (its eXIf chunk)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    img = Image.frombytes("RGB", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 3)))
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    img.save(buf, format=fmt, exif=exif, **({"quality": 95} if fmt == "JPEG" else {}))
    return buf.getvalue()


def split_group() -> dict:
    """R3.7: Separate background and foreground (SplitPhotoLayersNode). The
    remover's cut-out (alpha → the mask, grown by PIL's MaxFilter), then the
    fill engine on the picture without its alpha and the mask. Every case
    records the mask Python sends (its PNG in the payload: the TypeScript side
    compares its pixels) and each alpha-dropped picture's pixels (`made`).
    `maxfilter`: MaxFilter alone, the edge rule, on masks touching every edge
    and corner."""
    import hashlib
    from PIL import Image, ImageFilter
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    cases: list = []
    W, H = 48, 36

    def split(name, fill="LaMa (fast)", grow=12, mode="RGB", size=(W, H), cutout=None, background=None,
              answers=None, seed=300, picture=None):
        w, h = size
        pic = picture if picture is not None else png_bytes(w, h, seed, mode)
        files = {SPLIT_CUTOUT: _b64(cutout if cutout is not None else _split_cutout(w, h, seed + 1)),
                 SPLIT_BACKGROUND: _b64(background if background is not None else png_bytes(w, h, seed + 2, "RGBA"))}
        cases.append(paid_case(f"split · {name}", nr.SplitPhotoLayersNode, {"background_fill": fill, "mask_grow": grow},
                               answers or [{"output": SPLIT_CUTOUT}, {"output": [SPLIT_BACKGROUND]}],
                               pictures={"image": pic}, files=files,
                               picture_modes={"image": "RGBA"} if mode == "RGBA" else None, made_pixels=True))

    for fill, short in SPLIT_FILLS.items():
        for grow in (0, 1, 12, 50):
            for mode in ("RGB", "RGBA"):
                split(f"{short} · mask_grow {grow} · {mode} input", fill, grow, mode, seed=300 + grow * 3 + (mode == "RGBA"))
    split("a picture 50 px wide, mask_grow 50", grow=50, size=(50, 20), seed=400)
    split("a picture 50 px wide, mask_grow 50, Bria", fill="Bria Eraser (quality)", grow=50, size=(50, 20), mode="RGBA", seed=401)
    # A downloaded picture is always read as RGBA (bytesio_to_image_tensor): with no alpha the mask is all 255
    # and the remover's matte ('map') is never asked for. Two calls, as every other case.
    split("a cut-out with no alpha (no matte call)", cutout=_split_cutout(W, H, 411, "RGB"), seed=410)
    for kind, label in (("LA", "grey and alpha"), ("P", "palette with transparency"), ("CMYK", "CMYK JPEG"), ("I;16", "16-bit grey")):
        split(f"a cut-out in {label}", cutout=_split_cutout(W, H, 421, kind), seed=420)
    split("a cut-out larger than the picture", cutout=_split_cutout(60, 45, 431), seed=430)
    split("a cut-out 1 px tall, mask_grow 1", size=(W, 1), grow=1, cutout=_split_cutout(W, 1, 436), seed=435)
    for kind, label, data in (("RGB", "RGB", png_bytes(W, H, 441, "RGB")), ("CMYK", "CMYK JPEG", cmyk_jpeg_bytes(W, H, 442)),
                              ("I;16", "16-bit grey", grey16_png_bytes(W, H, 443))):
        split(f"a background in {label}", background=data, seed=440)
    split("answers the other way round (a list, then a string)", answers=[{"output": [SPLIT_CUTOUT]}, {"output": SPLIT_BACKGROUND}], seed=455)
    # Fix round 1: phone photos, EXIF turned by the loader (Python's picture is the turned one; the remover
    # answers in that shape). Stored 36 × 48 with orientation 6 (turned to 48 × 36), and 48 × 36 with 3 (180°).
    split("an EXIF-6 JPEG from the loader", picture=_exif_picture(H, W, 480, 6, "JPEG"), seed=480)
    split("an EXIF-3 PNG from the loader", fill="Bria Eraser (quality)", grow=1, picture=_exif_picture(W, H, 485, 3, "PNG"), seed=485)
    split("a cut-out answer with no output", answers=[{"output": None}], seed=460)
    split("a background answer with no output", answers=[{"output": SPLIT_CUTOUT}, {"output": []}], seed=470)

    # MaxFilter alone: PIL expands the image by size // 2 before its rank filter; the fixture says how it fills.
    # Each mask is written once (`masks`, raw L bytes by "<w>x<h>"), then filtered at each size.
    masks: dict = {}
    maxfilter = []
    for (w, h) in ((37, 23), (320, 200), (1, 7), (9, 1), (1, 1)):
        raw = split_mask(w, h, 500 + w * 7 + h)
        masks[f"{w}x{h}"] = _b64(raw)
        for size in (3, 25, 101):
            out = Image.frombytes("L", (w, h), raw).filter(ImageFilter.MaxFilter(size)).tobytes()
            row = {"w": w, "h": h, "size": size, "sha256": hashlib.sha256(out).hexdigest()}
            if w * h <= 37 * 23:
                row["out"] = _b64(out)
            maxfilter.append(row)
    return {"cases": cases, "maxfilter": maxfilter, "masks": masks}


# ── handoff (R3.H): the picture a loader's tensor is handed to a provider as ──

def _raw_png(w: int, h: int, colour_type: int, depth: int, pixels: bytes) -> bytes:
    """A PNG written by hand (PIL can't write 16-bit colour): filter 0 rows of `pixels`."""
    import zlib
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour_type]
    row = w * channels * depth // 8

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + pixels[y * row:(y + 1) * row] for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, colour_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def handoff_files() -> dict:
    """The loader files of the handoff group, by case name: every kind the
    brief names (EXIF 2–8 JPEG, RGBA PNG, palette PNG with transparency, CMYK
    JPEG, 16-bit PNG, WebP, a plain RGB JPEG) and the kinds that decide RGB
    against RGBA on the Image card (grey + alpha, a colour-keyed RGB PNG, an
    RGBA PNG that is opaque everywhere) or that carry chunks Python drops."""
    import io
    from PIL import Image
    W, H = 23, 15
    rng = random.Random(9100)

    def noise(n: int) -> bytes:
        return bytes(rng.randrange(256) for _ in range(n))

    def save(img, fmt: str, **kw) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format=fmt, **kw)
        return buf.getvalue()

    def exif(orientation: int):
        e = Image.Exif()
        e[0x0112] = orientation
        return e

    rgb = Image.frombytes("RGB", (W, H), noise(W * H * 3))
    alpha = bytes(rng.choice((0, 255, rng.randrange(256))) for _ in range(W * H))
    rgba = rgb.convert("RGBA")
    rgba.putalpha(Image.frombytes("L", (W, H), alpha))
    out = {
        "a plain RGB JPEG": save(rgb, "JPEG", quality=95),
        "a plain RGB PNG": save(rgb, "PNG"),
        "an RGB PNG with a text chunk": save(rgb, "PNG", pnginfo=_png_text()),
        "a grey PNG": save(Image.frombytes("L", (W, H), noise(W * H)), "PNG"),
        "an RGBA PNG, partly see-through": save(rgba, "PNG"),
        "an RGBA PNG, opaque everywhere": save(rgb.convert("RGBA"), "PNG"),
        "an RGBA PNG with one pixel at 254": None,
        "a grey + alpha PNG": save(Image.merge("LA", (Image.frombytes("L", (W, H), noise(W * H)), Image.frombytes("L", (W, H), alpha))), "PNG"),
        "an RGB PNG with a colour key": None,
        "a palette PNG with transparency": None,
        "a palette PNG, no transparency": None,
        "a CMYK JPEG": cmyk_jpeg_bytes(W, H, 9101),
        "a CMYK JPEG, EXIF 6": None,
        "a 16-bit grey PNG": grey16_png_bytes(W, H, 9102),
        "a 16-bit RGB PNG": _raw_png(W, H, 2, 16, noise(W * H * 6)),
        "a 16-bit RGBA PNG, partly see-through": _raw_png(W, H, 6, 16, noise(W * H * 8)),
        "a lossy WebP": save(rgb, "WEBP", quality=90),
        "a lossless WebP with alpha": save(rgba, "WEBP", lossless=True),
        "a WebP, EXIF 6": save(rgb, "WEBP", quality=90, exif=exif(6)),
        "a PNG with EXIF 6 (eXIf)": save(rgb, "PNG", exif=exif(6)),
        "an RGBA PNG, EXIF 8, partly see-through": save(rgba, "PNG", exif=exif(8)),
        "a GIF, no transparency": save(rgb.convert("P", palette=Image.Palette.ADAPTIVE, colors=64), "GIF"),
    }
    for o in range(2, 9):
        out[f"a JPEG, EXIF {o}"] = save(rgb, "JPEG", quality=95, exif=exif(o))
    one = bytearray(b"\xff" * (W * H))
    one[W * H // 2] = 254
    nearly = rgb.convert("RGBA")
    nearly.putalpha(Image.frombytes("L", (W, H), bytes(one)))
    out["an RGBA PNG with one pixel at 254"] = save(nearly, "PNG")
    out["an RGB PNG with a colour key"] = save(rgb, "PNG", transparency=rgb.getpixel((3, 2)))
    pal = Image.frombytes("P", (W, H), bytes(rng.randrange(32) for _ in range(W * H)))
    pal.putpalette(noise(32 * 3))
    out["a palette PNG with transparency"] = save(pal, "PNG", transparency=bytes(rng.randrange(256) for _ in range(32)))
    out["a palette PNG, no transparency"] = save(pal, "PNG")
    cmyk = Image.open(io.BytesIO(out["a CMYK JPEG"]))
    out["a CMYK JPEG, EXIF 6"] = save(cmyk, "JPEG", quality=95, exif=exif(6))
    return out


def _png_text():
    from PIL import PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text("prompt", '{"1": {"class_type": "KSampler"}}')
    return info


def _loader_tensor(loader: str, data: bytes, filename: str):
    """What a real loader hands on for this file: LoadImage (nodes.py) or the
    Image card (comfy_extras/nodes_image.py, which keeps the alpha of a file
    that has any as a 4th channel), from a temporary input folder."""
    import tempfile
    import folder_paths
    import nodes
    from comfy_extras import nodes_image
    with tempfile.TemporaryDirectory() as tmp:
        before = folder_paths.get_input_directory()
        folder_paths.set_input_directory(tmp)
        try:
            with open(os.path.join(tmp, filename), "wb") as f:
                f.write(data)
            if loader == "LoadImage":
                return nodes.LoadImage().load_image(filename)[0]
            none = lambda *_a, **_k: {"ui": {"images": []}}  # noqa: E731 — the previews are not part of the fixture
            with mock.patch.object(nodes_image.Image, "_preview_to_temp", none), \
                    mock.patch.object(nodes_image, "save_live_preview", none), \
                    mock.patch.object(folder_paths, "get_temp_directory", lambda: tmp):
                card = nodes_image.Image()
                got = card.process(image=filename, export=False, filename_prefix="ComfyUI", format="png", quality=90,
                                   lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=True)
            return got["result"][0]
        finally:
            folder_paths.set_input_directory(before)


HANDOFF_EDITED = "https://f.test/handoff/edited.png"
HANDOFF_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}


def handoff_group() -> dict:
    """R3.H: the bytes Python hands a provider for a picture from a loader.
    Every paid node the runner takes encodes its IMAGE input with
    `_image_tensor_to_data_url` (a PNG of the first frame, 8-bit, as many
    channels as the tensor); for each file kind and each loader (LoadImage,
    the Image card), the real loader makes the tensor and a real node sends
    it: Edit an image on FLUX.2 [pro] (fal), and Remove object on Nano Banana 2
    (Replicate, comfy_extras) for a few. Each case records the calls (the
    picture as `PNG:<sha256>` of Python's PNG) and `made`: that PNG's decoded
    pixels (shape and sha256), which the runner's hand-off must equal."""
    import io
    from PIL import Image
    import runner_builder_fixtures as rbf
    nr, _fal, extras = rbf._node_modules()
    edit_actions = next(m for m in extras if hasattr(m, "RemoveObjectNode"))
    files = handoff_files()
    edited = _b64(png_bytes(8, 6, 9200, "RGBA"))
    cases: list = []
    for fname, data in files.items():
        ext = HANDOFF_EXT[Image.open(io.BytesIO(data)).format]
        filename = f"handoff.{ext}"
        runs = [("EditImageNode", nr.EditImageNode, "input_image",
                 {"model": "Flux 2 Pro", "prompt": "make it dusk", "aspect_ratio": "match_input_image", "resolution": "1K",
                  "seed": 7, "safety_tolerance": 2, "prompt_upsampling": False, "output_format": "png"},
                 [{"images": [{"url": HANDOFF_EDITED}]}])]
        if fname in ("a JPEG, EXIF 6", "an RGBA PNG, partly see-through", "a CMYK JPEG"):
            runs.append(("RemoveObjectNode", edit_actions.RemoveObjectNode, "image", {"target": "the lamp", "instructions": ""},
                         [{"output": HANDOFF_EDITED}]))
        for loader in ("LoadImage", "Image"):
            for cls_name, cls, input_name, widgets, answers in runs:
                tensor = _loader_tensor(loader, data, filename)
                got = capture_calls(cls, answers, files={HANDOFF_EDITED: edited}, made_pixels=True,
                                    tensors={input_name: tensor}, **widgets)
                case = {"name": f"handoff · {fname} · {loader} → {cls_name}", "file": fname, "filename": filename,
                        "loader": loader, "class_type": cls.define_schema().node_id, "input": input_name,
                        "widgets": widgets, "answers": answers, "calls": got["calls"], "made": got.get("made", {}),
                        "tensor_shape": list(tensor.shape)}
                if "error" in got:
                    case["error"] = got["error"]
                cases.append(case)
    return {"cases": cases, "files": {n: _b64(b) for n, b in files.items()}}


GROUPS = {
    "handoff": handoff_group,
    "machinery": machinery_group,
    "llm": llm_group,
    "describe": describe_group,
    "repair": repair_group,
    "layers": layers_group,
    "split": split_group,
}


def self_check() -> None:
    """capture_calls on real classes (R3.2 fix round 1), nothing written:
    a node that works on a downloaded picture makes every call; GETs are
    recorded, a 404 is served as asked, an unserved GET fails the case even
    where the node catches every Exception; the wire text keeps 1.0."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgba = {"https://r.test/subject.png": _b64(png_bytes(8, 6, 7, "RGBA")), "https://r.test/bg.png": _b64(png_bytes(8, 6, 8, "RGBA"))}
    split = paid_case("split", nr.SplitPhotoLayersNode, {"background_fill": "LaMa (fast)", "mask_grow": 2},
                      [{"output": "https://r.test/subject.png"}, {"output": ["https://r.test/bg.png"]}],
                      pictures=["image"], files=rgba)
    assert "error" not in split, split.get("error")
    assert [c["endpoint"] for c in split["calls"]] == ["851-labs/background-remover", "zylim0702/remove-object"], split["calls"]
    assert split["calls"][1]["payload"]["image"] == "IMG:image"
    assert split["calls"][1]["payload"]["mask"].startswith("data:image/png;base64,")
    assert [g["status"] for g in split["gets"]] == [200, 200]
    assert split["output"][0] == {"image": "https://r.test/subject.png"} and "tensor" in split["output"][1]
    # The other fill engine. (A downloaded picture is always read as RGBA, bytesio_to_image_tensor, so the
    # remover's matte branch is never taken, even for an RGB answer: two calls either way.)
    rgb = {**rgba, "https://r.test/subject.png": _b64(png_bytes(8, 6, 7, "RGB"))}
    bria = paid_case("split, RGB answer", nr.SplitPhotoLayersNode, {"background_fill": "Bria Eraser (quality)", "mask_grow": 0},
                     [{"output": "https://r.test/subject.png"}, {"output": ["https://r.test/bg.png"]}],
                     pictures=["image"], files=rgb)
    assert [c["endpoint"] for c in bria["calls"]] == ["851-labs/background-remover", "bria/eraser"], bria["calls"]
    layer = {"model": "Ideogram Layerize", "prompt": "", "seed": 0}
    answer = [{"output": ["https://r.test/bg.png", "https://r.test/l.json"]}]
    gone = paid_case("layerize 404", nr.LayerizeGraphicNode, layer, answer, pictures=["image"], files=rgba,
                     links={"https://r.test/l.json": {"status": 404, "text": "gone"}})
    assert gone["gets"] == [{"url": "https://r.test/bg.png", "status": 200}, {"url": "https://r.test/l.json", "status": 404}], gone["gets"]
    try:
        paid_case("layerize unserved", nr.LayerizeGraphicNode, layer, answer, pictures=["image"], files=rgba)
    except UnservedGet:
        pass
    else:
        raise AssertionError("an unserved GET was not refused")
    music = paid_case("music", nr.GenerateMusicNode, {"model": "MusicGen", "prompt": "lofi", "duration": 8, "model_version": "stereo-large",
                                                      "temperature": 1.0, "top_p": 0.0, "seed": 3},
                      [{"__body__": '{"output": "https://r.test/m.wav"}'}], files={"https://r.test/m.wav": _b64(wav_bytes(0.1, 8000, 5))})
    assert '"temperature": 1.0' in music["calls"][0]["payload_json"], music["calls"][0]
    assert music["output"] == [{"audio": "https://r.test/m.wav"}], music["output"]
    print("self-check passed: split makes both calls (both engines), 404 served, unserved GET refused, wire text keeps 1.0")


def main(argv: list) -> None:
    if "--self-check" in argv:
        self_check()
        return
    if "--group" not in argv:
        raise SystemExit(f"usage: runner_paid_fixtures.py --group <{'|'.join(GROUPS)}>")
    group = argv[argv.index("--group") + 1]
    if group not in GROUPS:
        raise SystemExit(f"unknown group {group!r}; one of {', '.join(GROUPS)}")
    data = GROUPS[group]()
    path = os.path.join(FIXTURES, f"runner-paid-{group}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True, ensure_ascii=True)
        f.write("\n")
    print(f"wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1:])
