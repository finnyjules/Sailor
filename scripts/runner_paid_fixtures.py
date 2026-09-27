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


def _picture_tensor(data: bytes):
    """A picture input as LoadImage hands it on: RGB, float32 /255, [1, H, W, 3]."""
    import io
    import numpy as np
    import torch
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
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
        if isinstance(v, dict):
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
                  pictures: dict | None = None, sounds: dict | None = None, **kwargs) -> dict:
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
    - Every GET (aiohttp, and the download helpers) is recorded in `gets` as
      `{url, status}` and served from `links` (text, or `{status, text}` — a
      404 is served as asked) and `files` (URL → base64 bytes). The real
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
        return f"PNG:{hashlib.sha256(png).hexdigest()}"

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
        return f"{filename_prefix}_{counters[filename_prefix]:05}_.png"

    for pname, data in (pictures or {}).items():
        kwargs[pname] = name(_picture_tensor(data), "input", pname)
    for sname, data in (sounds or {}).items():
        kwargs[sname] = name(_sound_dict(data), "input", sname)

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
    if "error" in result:
        return result
    args = getattr(out, "args", out)
    result["output"] = jsonable(list(args) if isinstance(args, tuple) else args)
    result["ui"] = jsonable(getattr(out, "ui", None))
    return result


def paid_case(name: str, node_cls, widgets: dict, answers: list, pictures=(), sounds=(),
              links: dict | None = None, files: dict | None = None) -> dict:
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
    got = capture_calls(node_cls, answers, links=links, files=files, pictures=pics, sounds=snds, **widgets)
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


GROUPS = {
    "machinery": machinery_group,
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
