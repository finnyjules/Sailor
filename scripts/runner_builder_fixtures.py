"""Writes frontend/tests/unit/fixtures/runner-builders.json: the fal request
Python builds today for every runner model, for a spread of inputs. The
TypeScript builders in frontend/server/runner/generators/ must produce the
same payloads (tests/unit/runner-image-models.unit.spec.ts,
runner-video-models.unit.spec.ts). Re-run after changing a Python builder:

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_builder_fixtures.py

It also writes frontend/tests/unit/fixtures/runner-families.json: for each
runner family (Phase B), the FIRST provider call a node's execute() makes,
captured with the network patched out (capture_first_call). One top-level key
per family; the families add their cases as they land.
"""
import asyncio
import contextlib
import importlib
import json
import os
import sys
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from comfy_api_nodes.image_models import IMAGE_MODELS_BY_ID  # noqa: E402
from comfy_api_nodes.video_models import VIDEO_MODELS_BY_ID  # noqa: E402

IMAGE_IDS = [
    "flux-1.1-pro", "flux-schnell", "nano-banana-pro", "nano-banana-2",
    "ideogram-v3-quality", "ideogram-v3-balanced", "ideogram-v3-turbo",
    "seedream-5-lite", "seedream-4",
]
VIDEO_IDS = ["veo-3.1", "veo-3.1-fast", "flux-3", "seedance-2.0", "hailuo-h3", "hailuo-h3-max"]

COMMON_IMAGE_CASES = [
    {"prompt": "a red fox", "ar": "1:1", "seed": 0, "adv": {}},
    {"prompt": "a red fox", "ar": "16:9", "seed": 42, "adv": {}},
    {"prompt": "wide", "ar": "7:3", "seed": 5, "adv": {}},          # unsupported ratio
    {"prompt": "portrait", "ar": "4:5", "seed": 0, "adv": {"output_format": "jpg"}},
]
EXTRA_IMAGE_CASES = {
    "flux-1.1-pro": [{"prompt": "p", "ar": "3:2", "seed": 1, "adv": {"safety_tolerance": 9}},
                     {"prompt": "p", "ar": "3:2", "seed": 1, "adv": {"safety_tolerance": "0"}}],
    "flux-schnell": [{"prompt": "p", "ar": "9:21", "seed": 3, "adv": {"num_outputs": 3, "num_inference_steps": "6"}},
                     {"prompt": "p", "ar": "1:1", "seed": 3, "adv": {"num_outputs": 9}}],
    "nano-banana-2": [{"prompt": "p", "ar": "4:1", "seed": 2, "adv": {"resolution": "4K", "google_search": True}},
                      {"prompt": "p", "ar": "1:1", "seed": 2, "adv": {"resolution": "huge", "google_search": "yes"}}],
    "nano-banana-pro": [{"prompt": "p", "ar": "21:9", "seed": 0, "adv": {"resolution": "1K"}},
                        {"prompt": "p", "ar": "4:1", "seed": 0, "adv": {"resolution": "0.5K"}}],
    "ideogram-v3-quality": [{"prompt": "p", "ar": "3:1", "seed": 4, "adv": {"magic_prompt": "Off", "style_type": "Design"}},
                            {"prompt": "p", "ar": "3:1", "seed": 4, "adv": {"style_type": "Fancy"}}],
    "seedream-5-lite": [{"prompt": "p", "ar": "2:3", "seed": 9, "adv": {"sequential_image_generation": "auto", "max_images": 9}},
                        {"prompt": "p", "ar": "2:3", "seed": 9, "adv": {"sequential_image_generation": "auto"}}],
    "seedream-4": [{"prompt": "p", "ar": "21:9", "seed": 11, "adv": {}}],
}

COMMON_VIDEO_CASES = [
    {"prompt": "a wave", "ar": "16:9", "dur": 5, "seed": 0, "image": None, "adv": {}},
    {"prompt": "a wave", "ar": "9:16", "dur": 7, "seed": 12, "image": "IMAGE_URL", "adv": {}},
    {"prompt": "a wave", "ar": "4:1", "dur": 100, "seed": 0, "image": None, "adv": {}},
]
EXTRA_VIDEO_CASES = {
    "veo-3.1": [{"prompt": "p", "ar": "16:9", "dur": 6, "seed": 3, "image": None,
                 "adv": {"negative_prompt": "blur", "generate_audio": False, "enhance_prompt": False, "resolution": "1080p"}}],
    "flux-3": [{"prompt": "p", "ar": "1:1", "dur": 12, "seed": 0, "image": None, "adv": {"generate_audio": "off"}}],
    "seedance-2.0": [
        {"prompt": "p", "ar": "3:4", "dur": 14, "seed": 0, "image": None,
         "adv": {"image_urls": ["https://r/1.png"], "generate_audio": True}},
        {"prompt": "p", "ar": "3:4", "dur": 5, "seed": 0, "image": None,
         "adv": {"image_url": "https://r/first.png", "end_image_url": "https://r/last.png"}},
    ],
    "hailuo-h3": [{"prompt": "p", "ar": "21:9", "dur": 10, "seed": 8, "image": None,
                   "adv": {"resolution": "4k", "prompt_expansion_mode": "fast"}}],
    "hailuo-h3-max": [{"prompt": "p", "ar": "21:9", "dur": 6, "seed": 8, "image": "IMAGE_URL",
                       "adv": {"prompt_expansion_mode": "fast", "end_image_url": "https://r/last.png"}}],
}


# ── Node-level capture (runner families) ─────────────────────────────────

# comfy_extras modules whose nodes dispatch through nodes_replicate; their save
# helpers are patched along with nodes_replicate's own.
EXTRAS_MODULES = [
    "comfy_extras.nodes_edit_actions",
    "comfy_extras.nodes_relight",
    "comfy_extras.nodes_swap_background",
    "comfy_extras.nodes_swap_product",
    "comfy_extras.nodes_person_swap",
    "comfy_extras.nodes_lens_reframe",
    "comfy_extras.nodes_pose_mannequin",
]
SAVE_HELPERS = ("save_live_preview", "save_generation_output", "save_image_to_input")


class _FirstCall(BaseException):
    """Raised by the fake providers once the first call is recorded. A
    BaseException, so the fal → fal → Replicate failover chain's
    `except Exception` cannot swallow it and try the next provider."""


def _node_modules():
    """Import the node modules the way tests-unit/comfy_api_test does."""
    import utils.install_util  # noqa: F401
    import comfy_api_nodes.nodes_replicate as nr
    from comfy_api_nodes import fal_refs
    extras = [importlib.import_module(m) for m in EXTRAS_MODULES]
    return nr, fal_refs, extras


def capture_first_call(node_cls, **kwargs) -> dict:
    """Run `node_cls.execute(**kwargs)` with every network and save step
    patched out, and return the first provider call it makes:
    `{provider: 'fal'|'replicate', endpoint, payload}`, or `{passthrough: True}`
    when it makes none. Pictures are passed as their input name (the "tensor");
    `_image_tensor_to_data_url` turns that into `IMG:<name>`, and moodboard
    files become `BOARD:<file>`."""
    nr, fal_refs, extras = _node_modules()
    seen: dict = {}

    def record(provider: str, endpoint: str, payload: dict):
        seen.update(provider=provider, endpoint=endpoint, payload=json.loads(json.dumps(payload)))
        raise _FirstCall()

    async def fake_fal(app, fn, input_dict, **_kw):
        record("fal", f"{app}/{fn}" if fn else app, input_dict)

    async def fake_replicate(model, input_dict, **_kw):
        record("replicate", model, input_dict)

    async def fake_download(url, cls=None, *_a, **_kw):
        return "TENSOR"

    from comfy_api.latest._io import HiddenHolder
    patches = [
        # What the executor sets before execute(): a node id for live previews.
        mock.patch.object(node_cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})),
        mock.patch.object(nr, "_image_tensor_to_data_url", lambda t: f"IMG:{t}"),
        mock.patch.object(nr, "_run_prediction", fake_replicate),
        mock.patch.object(fal_refs, "run_fal_prediction", fake_fal),
        mock.patch.object(fal_refs, "get_fal_token", lambda: "fixture-token"),
        mock.patch.object(nr, "download_url_to_image_tensor", fake_download),
        mock.patch.object(nr, "_moodboard_ref_data_urls",
                          lambda folder, files, input_dir=None: [f"BOARD:{f}" for f in files]),
    ]
    for mod in [nr, *extras, sys.modules.get(node_cls.__module__)]:
        for name in SAVE_HELPERS:
            if mod is not None and hasattr(mod, name):
                patches.append(mock.patch.object(mod, name, lambda *a, **k: {}))

    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        try:
            asyncio.run(node_cls.execute(**kwargs))
        except _FirstCall:
            return seen
    return {"passthrough": True}


# One top-level key per runner family (shared/runner/families.ts). Each task
# that adds a family fills its list with capture_first_call cases.
FAMILY_KEYS = ["falEdit", "replicateImage", "replicateVideo", "nanoActions", "refEdits", "restyle"]


def family_cases() -> dict:
    return {key: [] for key in FAMILY_KEYS}


def write_json(dest: str, out: dict) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")


def main() -> None:
    out = {"image": [], "video": []}
    for mid in IMAGE_IDS:
        spec = IMAGE_MODELS_BY_ID[mid]
        for c in COMMON_IMAGE_CASES + EXTRA_IMAGE_CASES.get(mid, []):
            payload = spec.fal_build_input(c["prompt"], c["ar"], int(c["seed"] or 0), dict(c["adv"]), None)
            out["image"].append({"model": mid, "args": c, "payload": payload})
    for mid in VIDEO_IDS:
        spec = VIDEO_MODELS_BY_ID[mid]
        for c in COMMON_VIDEO_CASES + EXTRA_VIDEO_CASES.get(mid, []):
            payload = spec.build_input(c["prompt"], c["ar"], int(c["dur"]), int(c["seed"] or 0),
                                       c["image"], None, dict(c["adv"]))
            out["video"].append({"model": mid, "args": c, "payload": payload})
    dest = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-builders.json")
    write_json(dest, out)
    print(f"wrote {len(out['image'])} image and {len(out['video'])} video cases to {dest}")

    families = family_cases()
    fdest = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-families.json")
    write_json(fdest, families)
    counts = ", ".join(f"{k} {len(v)}" for k, v in families.items())
    print(f"wrote runner family cases ({counts}) to {fdest}")


if __name__ == "__main__":
    main()
