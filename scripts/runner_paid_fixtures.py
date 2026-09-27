"""Writes frontend/tests/unit/fixtures/runner-paid-<group>.json: what the REAL
Python gives for Sailor's paid-node runner (step 3, stage R3), for the
TypeScript ports to be measured against. One file per group, keys sorted,
stable bytes (run it twice: the second time `git diff --stat` shows nothing).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group machinery

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
is imported. Nothing here needs the network.
"""
import json
import os
import random
import socket
import struct
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
FIXTURES = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures")


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
