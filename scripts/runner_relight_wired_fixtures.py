"""Writes frontend/tests/unit/fixtures/runner-relight-wired.json: the first
provider call the REAL RelightNode.execute makes for a light and instructions
that arrive by wire (step 3, R11.1). A wire hands Python the same string a
typed widget would, so each case is the text a card carries: a gimbal JSON, a
broken JSON, JSON that is not an object, blank text, and wired instructions.
Captured with runner_builder_fixtures.capture_first_call (network patched out).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_relight_wired_fixtures.py

The network is blocked and the provider keys are removed before any node
module is imported.
"""
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


block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-relight-wired.json")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runner_builder_fixtures  # noqa: E402

GIMBAL = '{"azimuth":95,"elevation":50,"intensity":0.9}'

# (name, wired light or None for the typed default, wired instructions or None for typed '').
CASES = [
    ("a gimbal JSON", GIMBAL, None),
    ("a gimbal JSON with spaces and extra keys", '{ "azimuth": -140, "elevation": -60, "intensity": 0.2, "colour": "red" }', None),
    ("a broken JSON", '{"azimuth": 95, "elevation":', None),
    ("plain words, not JSON", "warm light from the left", None),
    ("JSON that is not an object", "[95, 50, 0.9]", None),
    ("blank text", "", None),
    ("an intensity of 0 (Python's `or` reads it as 0.6)", '{"azimuth":30,"elevation":0,"intensity":0}', None),
    ("wired instructions", None, "make it moodier"),
    ("wired instructions with spaces", None, "   add a teal rim light  "),
    ("wired blank instructions", None, "   "),
    ("both wired", GIMBAL, "keep the shadows soft"),
]

TYPED_LIGHT = '{"azimuth":-30,"elevation":20,"intensity":0.6}'


def main() -> None:
    from comfy_extras.nodes_relight import RelightNode
    out = []
    for name, light, instructions in CASES:
        inputs = {"preset": "Golden hour", "light": TYPED_LIGHT if light is None else light,
                  "keep_background": True, "instructions": "" if instructions is None else instructions}
        wired = [k for k, v in (("light", light), ("instructions", instructions)) if v is not None]
        call = runner_builder_fixtures.capture_first_call(RelightNode, image="image", **inputs)
        assert not call.get("passthrough"), name
        out.append({"name": name, "inputs": inputs, "wired": wired,
                    "provider": call["provider"], "endpoint": call["endpoint"], "payload": call["payload"]})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cases": out}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: {len(out)} cases")


if __name__ == "__main__":
    main()
