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
        # Keep the raw payload and stop at once: serialising here could raise
        # a TypeError, which the failover chain would catch and move on to
        # the SECOND provider. It is serialised after the _FirstCall below.
        seen.update(provider=provider, endpoint=endpoint, payload=payload)
        raise _FirstCall()

    async def fake_fal(app, fn, input_dict, **_kw):
        record("fal", f"{app}/{fn}" if fn else app, input_dict)

    async def fake_replicate(model, input_dict, **_kw):
        record("replicate", model, input_dict)

    async def fake_download(url, cls=None, *_a, **_kw):
        return "TENSOR"

    async def fake_upload(data, filename, content_type="application/octet-stream"):
        return f"UPLOAD:{filename}"

    from comfy_api.latest._io import HiddenHolder
    patches = [
        # What the executor sets before execute(): a node id for live previews.
        mock.patch.object(node_cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})),
        mock.patch.object(nr, "_image_tensor_to_data_url", lambda t: f"IMG:{t}"),
        mock.patch.object(nr, "_run_prediction", fake_replicate),
        mock.patch.object(fal_refs, "run_fal_prediction", fake_fal),
        mock.patch.object(fal_refs, "get_fal_token", lambda: "fixture-token"),
        mock.patch.object(nr, "download_url_to_image_tensor", fake_download),
        # Uploads to fal storage over aiohttp with the fal token: never reached.
        mock.patch.object(nr, "_upload_public_file", fake_upload),
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
            return {**seen, "payload": json.loads(json.dumps(seen["payload"]))}
    return {"passthrough": True}


# One top-level key per runner family (shared/runner/families.ts). Each task
# that adds a family fills its list with capture_first_call cases.
FAMILY_KEYS = ["falEdit", "replicateImage", "replicateVideo", "nanoActions", "refEdits", "restyle"]


def _node_case(node_cls, links: list, widgets: dict) -> dict:
    """One captured case: a node's widget values, which picture inputs are
    linked (each is passed as its own input name, so it arrives as
    `IMG:<name>`), and the first provider call execute() makes."""
    kwargs = dict(widgets)
    for name in links:
        kwargs[name] = name
    return {
        "class_type": node_cls.__name__,
        "links": list(links),
        "widgets": widgets,
        "call": capture_first_call(node_cls, **kwargs),
    }


# Seeds: 0 (random), an ordinary one, and the ones either side of 2^32 — Nano
# Banana masks with & 0xFFFFFFFF after its `> 0` check; the Flux editors don't.
_EDIT_SEEDS = [0, 42, 2**32 - 1, 2**32, 2**32 + 5]


def _fal_edit_cases() -> list:
    """Task B2 (fal-edit): EditImageNode ×3 models, DevelopImageNode,
    RelightNode, BlendSceneNode (Flux Kontext Pro / Flux 2 Pro)."""
    nr, _fal_refs, _extras = _node_modules()
    from comfy_extras.nodes_relight import RelightNode
    from comfy_extras._relight_prompts import PRESETS
    cases = []

    edit_base = {"model": "Nano Banana 2", "prompt": "make her hair blue", "aspect_ratio": "match_input_image",
                 "resolution": "1K", "seed": 0, "safety_tolerance": 2, "prompt_upsampling": False,
                 "output_format": "png"}

    def edit(**over):
        cases.append(_node_case(nr.EditImageNode, ["input_image"], {**edit_base, **over}))

    # Nano Banana 2
    for seed in _EDIT_SEEDS:
        for fmt in ("png", "jpg"):
            edit(seed=seed, output_format=fmt)
    for res in ("1K", "2K", "4K"):
        edit(resolution=res, seed=7)
    # Kontext dials are ignored by Nano Banana 2.
    edit(aspect_ratio="16:9", safety_tolerance=5, prompt_upsampling=True)

    # Flux Kontext Pro
    for ar in nr._FLUX_KONTEXT_ASPECT_RATIOS:
        edit(model="Flux Kontext Pro", aspect_ratio=ar)
    for safety in (1, 2, 5, 6):
        edit(model="Flux Kontext Pro", safety_tolerance=safety)
    for up in (False, True):
        edit(model="Flux Kontext Pro", prompt_upsampling=up, seed=11)
    for seed in _EDIT_SEEDS:
        edit(model="Flux Kontext Pro", seed=seed, output_format="jpg")
    edit(model="Flux Kontext Pro", resolution="4K", output_format="png")

    # Flux 2 Pro
    for seed in _EDIT_SEEDS:
        for fmt in ("png", "jpg"):
            edit(model="Flux 2 Pro", seed=seed, output_format=fmt)
    edit(model="Flux 2 Pro", aspect_ratio="9:16", safety_tolerance=6, prompt_upsampling=True, resolution="4K")

    # Develop
    for res in ("1K", "2K", "4K"):
        for seed in (0, 9, 2**32 - 1, 2**32 + 3):
            cases.append(_node_case(nr.DevelopImageNode, ["input_image"], {"resolution": res, "seed": seed}))

    # Relight
    relight_base = {"preset": "Custom", "light": '{"azimuth":-30,"elevation":20,"intensity":0.6}',
                    "keep_background": True, "instructions": ""}

    def relight(links=("image",), **over):
        cases.append(_node_case(RelightNode, list(links), {**relight_base, **over}))

    for preset in PRESETS:
        relight(preset=preset)
    relight(preset="Not a preset")
    for az in (0, 22.4, 22.5, -22.5, 67.4, 67.5, -67.5, 112.4, 112.5, -112.5, 157.5, 157.6, -157.6,
               180, -180, 360, -270, 540):
        relight(light=json.dumps({"azimuth": az, "elevation": 0, "intensity": 0.6}))
    for el in (14.9, 15, -14.9, -15, 44.9, 45, 74.9, 75, -45, -75, 90, -90, 120, -120):
        relight(light=json.dumps({"azimuth": 0, "elevation": el, "intensity": 0.6}))
    for it in (0, 0.1, 0.24, 0.25, 0.49, 0.5, 0.74, 0.75, 1, 1.5, -1):
        relight(light=json.dumps({"azimuth": 45, "elevation": 30, "intensity": it}))
    # Tolerant parsing: unreadable → defaults; falsy values → defaults; numeric strings and booleans read as numbers.
    for light in ("", "{}", "not json", "[1, 2]", "null", '"text"', "7",
                  '{"azimuth": null, "elevation": null, "intensity": null}',
                  '{"azimuth": "95", "elevation": " 50 ", "intensity": "0.3"}',
                  '{"azimuth": true, "elevation": false, "intensity": true}',
                  '{"azimuth": -100}'):
        relight(light=light)
    relight(keep_background=False)
    relight(links=("image", "reference"))
    relight(links=("image", "reference"), preset="Golden hour", keep_background=False,
            instructions="  warmer please  ")
    relight(instructions="   ")
    relight(instructions="a touch of haze")

    # BlendScene (Flux Kontext Pro / Flux 2 Pro)
    blend_base = {"model": "Flux Kontext Pro", "unify_lighting": True, "contact_shadows": True,
                  "match_camera_look": True, "preserve_identity": True, "keep_feather": 2.0,
                  "prompt": "", "seed": 0, "output_format": "png"}

    def blend(**over):
        cases.append(_node_case(nr.BlendSceneNode, ["image"], {**blend_base, **over}))

    for model in ("Flux Kontext Pro", "Flux 2 Pro"):
        for mask in range(16):
            blend(model=model, unify_lighting=bool(mask & 1), contact_shadows=bool(mask & 2),
                  match_camera_look=bool(mask & 4), preserve_identity=bool(mask & 8))
        for seed in _EDIT_SEEDS:
            blend(model=model, seed=seed, output_format="jpg")
        blend(model=model, prompt="  make it one cosy photo  ")
        blend(model=model, prompt="   ", unify_lighting=False)
    return cases


def family_cases() -> dict:
    out = {key: [] for key in FAMILY_KEYS}
    out["falEdit"] = _fal_edit_cases()
    return out


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
