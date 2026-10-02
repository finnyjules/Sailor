"""Writes frontend/tests/unit/fixtures/runner-video-leftovers.json: the first
provider call the REAL GenerateVideoNode.execute makes (step 3, R11.2) for
  - VEED Fabric 1.0 with a face picture and a sound, over a range of
    `model_options` texts (a wire hands Python the same string a typed
    widget would, so a wired `model_options` is one of these texts);
  - a few other Replicate video models with `model_options` as a text, to
    show a wired value reads exactly as a typed one.
Pictures arrive as `IMG:<name>` (runner_builder_fixtures' patch) and the sound
as `WAV:<name>` (`_audio_dict_to_wav_data_url` patched here: the runner sends
the same WAV, handed off). Fabric's refusals (no picture, no sound) are
recorded with Python's words.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_video_leftovers_fixtures.py

The network is blocked and the provider keys are removed before any node
module is imported.
"""
import json
import os
import socket
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


block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-video-leftovers.json")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runner_builder_fixtures  # noqa: E402

# (name, model, model_options text, image?, audio?)
CASES = [
    ("Fabric, no options", "fabric-1.0", "{}", True, True),
    ("Fabric, 480p", "fabric-1.0", '{"resolution":"480p"}', True, True),
    ("Fabric, 720p with extra keys", "fabric-1.0", '{"resolution":"720p","seed":7,"negative_prompt":"x"}', True, True),
    ("Fabric, a number for the resolution", "fabric-1.0", '{"resolution":480}', True, True),
    ("Fabric, a null resolution", "fabric-1.0", '{"resolution":null}', True, True),
    ("Fabric, broken options", "fabric-1.0", '{"resolution":', True, True),
    ("Fabric, options that are not an object", "fabric-1.0", '["480p"]', True, True),
    ("Fabric, blank options", "fabric-1.0", "", True, True),
    ("Fabric, no sound", "fabric-1.0", "{}", True, False),
    ("Fabric, no picture", "fabric-1.0", "{}", False, True),
    ("Kling 2.5 Turbo Pro, options as text", "kling-v2.5-turbo-pro", '{"negative_prompt":"blur"}', False, False),
    ("Hailuo 2.3, options as text", "hailuo-2.3", '{"resolution":"1080p","prompt_optimizer":false}', True, False),
    ("Wan 2.7 T2V, broken options", "wan-2.7-t2v", "not json", False, False),
]


def main() -> None:
    nr = runner_builder_fixtures._node_modules()[0]
    out = []
    with mock.patch.object(nr, "_audio_dict_to_wav_data_url", lambda a, max_seconds=None: f"WAV:{a}:{max_seconds}"):
        for name, model, options, image, audio in CASES:
            kwargs = {"model": model, "prompt": "a person talking", "aspect_ratio": "16:9", "duration": "5",
                      "seed": 0, "model_options": options}
            if image:
                kwargs["image"] = "image"
            if audio:
                kwargs["audio"] = "audio"
            case = {"name": name, "model": model, "model_options": options, "image": image, "audio": audio}
            try:
                call = runner_builder_fixtures.capture_first_call(nr.GenerateVideoNode, **kwargs)
            except RuntimeError as e:
                case["error"] = str(e)
                out.append(case)
                continue
            assert not call.get("passthrough"), name
            case.update(provider=call["provider"], endpoint=call["endpoint"], payload=call["payload"])
            out.append(case)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cases": out}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: {len(out)} cases")


if __name__ == "__main__":
    main()
