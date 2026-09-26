"""Writes frontend/tests/unit/fixtures/runner-cards.json: what the REAL Python
card nodes (step 3, stage R1) make of their settings, for the Sailor runner's
TypeScript ports to be measured against. One top-level key per task; each task
adds its key and regenerates the file (the other keys must come out unchanged).

  moodboard — (R1.1) MoodboardNode.execute(reading_json)'s style block, for
              the three shared fixtures in tests-unit/comfy_api_test/fixtures/
              and the edge cases; `plain: false` marks a reading the moodboard
              window never writes (the runner leaves those to the engine)
  text      — (R1.1) TextNode.execute(text, source)'s value

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


def main() -> None:
    data: dict = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
    data["moodboard"] = moodboard_cases()
    data["text"] = text_cases()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(data.items())), f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: " + ", ".join(f"{k} {len(v)}" for k, v in sorted(data.items())))


if __name__ == "__main__":
    main()
