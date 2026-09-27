"""Writes frontend/tests/unit/fixtures/runner-paid-<group>.json: what the REAL
Python gives for Sailor's paid-node runner (step 3, stage R3), for the
TypeScript ports to be measured against. One file per group, keys sorted,
stable bytes (run it twice: the second time `git diff --stat` shows nothing).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group machinery

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

class FakeTensor:
    """A picture (or other file) a patched download returned: the URL it came from."""
    def __init__(self, url):
        self.url = url

    def __repr__(self):
        return f"FakeTensor({self.url!r})"


class FakeVideo(FakeTensor):
    pass


class FakeAudio(dict):
    """A sound a patched download returned, as Comfy's AUDIO dict: its URL only."""
    def __init__(self, url):
        super().__init__(url=url)
        self.url = url


class _FakeResponse:
    def __init__(self, url, links):
        self.url = url
        if url not in links:
            raise RuntimeError(f"NETWORK BLOCKED: GET {url!r} is not one of the case's links")
        self._text = links[url]
        self.status = 200

    async def text(self, *_a, **_k):
        return self._text

    async def read(self):
        return self._text.encode("utf-8")

    async def json(self, *_a, **_k):
        return json.loads(self._text)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _fake_session(links: dict):
    """aiohttp.ClientSession, answering GETs of the case's JSON links only."""
    class FakeSession:
        def __init__(self, *_a, **_k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        def get(self, url, *_a, **_k):
            return _FakeResponse(url, links)

        def post(self, url, *_a, **_k):
            raise RuntimeError(f"NETWORK BLOCKED: POST {url!r}")

        put = post

        async def close(self):
            pass
    return FakeSession


def _jsonable(v):
    """What a node returned, as JSON: strings verbatim, a downloaded file as the URL it came from."""
    if isinstance(v, FakeVideo):
        return {"video": v.url}
    if isinstance(v, FakeTensor):
        return {"image": v.url}
    if isinstance(v, FakeAudio):
        return {"audio": v.url}
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return {"repr": repr(v)}


def capture_calls(node_cls, answers: list, links: dict | None = None, **kwargs) -> dict:
    """Run `node_cls.execute(**kwargs)` with every provider call, upload,
    download, save and JSON-link fetch patched out. Each provider call
    (Replicate `_run_prediction`, fal `run_fal_prediction`) records
    `{provider, endpoint, payload}` and returns the next of `answers`
    (Replicate: the prediction dict; fal: the result body; `{"__body__":
    text}`: json.loads of that text, so numbers keep their written form on the
    TypeScript side). Pictures are passed
    as their input name and sent as `IMG:<name>`, sounds as `WAV:<name>`,
    uploads as `UPLOAD:<file name>`; a downloaded answer comes back as the URL
    it came from (FakeTensor / FakeVideo / FakeAudio); `links` serves the JSON
    files a node fetches over aiohttp. Returns `{calls, output, ui}`: `output`
    as Python returned it (strings verbatim, files as their URL) and `ui` as
    it would show (a saved picture as `{prefix, image}`), or `error` with the
    exception's type and message when execute raised."""
    if "--allow-network" not in sys.argv[1:]:
        block_network()
    import aiohttp
    from runner_builder_fixtures import SAVE_HELPERS, UNREADABLE_BOARD_PREFIX, _node_modules
    nr, fal_refs, extras = _node_modules()
    from comfy_api.latest._io import HiddenHolder

    calls: list = []
    queue = list(answers)
    counters: dict = {}

    def answer(provider, endpoint, payload):
        # Serialised at once, so a later change to the dict can't alter the record.
        calls.append({"provider": provider, "endpoint": endpoint, "payload": json.loads(json.dumps(payload))})
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

    async def fake_image(url, *_a, **_k):
        return FakeTensor(url)

    async def fake_video(url, *_a, **_k):
        return FakeVideo(url)

    async def fake_audio(url, *_a, **_k):
        return FakeAudio(url)

    def url_of(t):
        return t.url if isinstance(t, FakeTensor) else repr(t)

    def fake_generation(tensor, filename_prefix="generation"):
        return {"images": [{"prefix": filename_prefix, "image": url_of(tensor)}], "animated": [False]}

    def fake_live(tensor, node_id=None, unique=False):
        return {"images": [{"live_preview": url_of(tensor)}]}

    def fake_to_input(tensor, filename_prefix="layer"):
        counters[filename_prefix] = counters.get(filename_prefix, 0) + 1
        return f"{filename_prefix}_{counters[filename_prefix]:05}_.png"

    saves = {"save_generation_output": fake_generation, "save_live_preview": fake_live, "save_image_to_input": fake_to_input}
    patches = [
        mock.patch.object(node_cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})),
        mock.patch.object(nr, "_run_prediction", fake_replicate),
        mock.patch.object(fal_refs, "run_fal_prediction", fake_fal),
        mock.patch.object(fal_refs, "get_fal_token", lambda: "fixture-token"),
        mock.patch.object(nr, "_upload_public_file", fake_upload),
        mock.patch.object(nr, "_lipsync_hosted_media_url", fake_hosted),
        mock.patch.object(nr, "_image_tensor_to_data_url", lambda t: f"IMG:{t}"),
        mock.patch.object(nr, "_audio_dict_to_wav_data_url", lambda a, max_seconds=None: f"WAV:{a}"),
        mock.patch.object(nr, "download_url_to_image_tensor", fake_image),
        mock.patch.object(nr, "download_url_to_video_output", fake_video),
        mock.patch.object(nr, "_download_url_to_audio_dict", fake_audio),
        mock.patch.object(nr, "_moodboard_ref_data_urls",
                          lambda folder, files, input_dir=None: [f"BOARD:{f}" for f in files
                                                                 if not f.startswith(UNREADABLE_BOARD_PREFIX)]),
        mock.patch.object(aiohttp, "ClientSession", _fake_session(dict(links or {}))),
    ]
    for mod in [nr, *extras, sys.modules.get(node_cls.__module__)]:
        for name in SAVE_HELPERS:
            if mod is not None and hasattr(mod, name):
                patches.append(mock.patch.object(mod, name, saves[name]))

    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        try:
            out = asyncio.run(node_cls.execute(**kwargs))
        except Exception as e:  # noqa: BLE001 — the node's own failure is part of the fixture
            return {"calls": calls, "error": {"type": type(e).__name__, "message": str(e)}}
    args = getattr(out, "args", out)
    ui = getattr(out, "ui", None)
    return {"calls": calls, "output": _jsonable(list(args) if isinstance(args, tuple) else args), "ui": _jsonable(ui)}


def paid_case(name: str, node_cls, widgets: dict, answers: list, pictures: list = (), sounds: list = (),
              links: dict | None = None) -> dict:
    """One fixture case (tests/unit/__runner__/paidParity.ts PaidCase): the
    node's widgets, its picture and sound inputs (passed by name), the
    answers, and what capture_calls saw."""
    kwargs = {**widgets, **{p: p for p in pictures}, **{s: s for s in sounds}}
    got = capture_calls(node_cls, answers, links=links, **kwargs)
    case = {"name": name, "class_type": node_cls.define_schema().node_id, "widgets": widgets,
            "pictures": list(pictures), "sounds": list(sounds), "answers": answers, "calls": got["calls"],
            "output": got.get("output"), "ui": got.get("ui")}
    if links:
        case["links"] = links
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


def main(argv: list) -> None:
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
