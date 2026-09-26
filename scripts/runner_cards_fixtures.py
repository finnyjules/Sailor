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


def main() -> None:
    data: dict = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)
    data["moodboard"] = moodboard_cases()
    data["text"] = text_cases()
    data["wired_text"] = wired_text_cases()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(data.items())), f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: " + ", ".join(f"{k} {len(v)}" for k, v in sorted(data.items())))


if __name__ == "__main__":
    main()
