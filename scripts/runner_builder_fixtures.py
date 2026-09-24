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

To prove no fixture came from a real provider, regenerate with --no-network:
every outbound socket connect and DNS lookup raises, and the provider keys
(FAL_KEY, FAL_API_KEY, NUXT_REPLICATE_TOKEN, REPLICATE_API_TOKEN) are removed
from the environment before any node module is imported:

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_builder_fixtures.py --no-network

Then check `git diff --stat -- frontend/tests/unit/fixtures/runner-builders.json`
prints nothing.
"""
import asyncio
import contextlib
import importlib
import json
import os
import socket
import sys
from unittest import mock

PROVIDER_KEYS = ("FAL_KEY", "FAL_API_KEY", "NUXT_REPLICATE_TOKEN", "REPLICATE_API_TOKEN")


def block_network() -> None:
    """--no-network: refuse every outbound connection and DNS lookup, and drop
    the provider keys, so a capture that slipped past a patch fails loudly
    instead of reaching (and paying) a provider."""
    def refuse(*a, **_k):
        raise RuntimeError(f"NETWORK BLOCKED: {a!r}")
    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    for key in PROVIDER_KEYS:
        os.environ.pop(key, None)


if __name__ == "__main__" and "--no-network" in sys.argv[1:]:
    block_network()

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
    return _capture(node_cls, **kwargs)[0]


def _capture(node_cls, **kwargs) -> tuple:
    """capture_first_call, plus the pictures execute() handed to
    save_live_preview (a pass-through shows its input there)."""
    nr, fal_refs, extras = _node_modules()
    seen: dict = {}
    previews: list = []

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
    def fake_preview(image, *_a, **_k):
        previews.append(image)
        return {}

    for mod in [nr, *extras, sys.modules.get(node_cls.__module__)]:
        for name in SAVE_HELPERS:
            if mod is not None and hasattr(mod, name):
                fake = fake_preview if name == "save_live_preview" else (lambda *a, **k: {})
                patches.append(mock.patch.object(mod, name, fake))

    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        try:
            asyncio.run(node_cls.execute(**kwargs))
        except _FirstCall:
            return {**seen, "payload": json.loads(json.dumps(seen["payload"]))}, previews
    return {"passthrough": True}, previews


# One top-level key per runner family (shared/runner/families.ts). Each task
# that adds a family fills its list with capture_first_call cases.
FAMILY_KEYS = ["falEdit", "replicateImage", "replicateVideo", "nanoActions", "refEdits", "restyle"]


def _node_case(node_cls, links: list, widgets: dict) -> dict:
    """One captured case: a node's widget values, which picture inputs are
    linked (each is passed as its own input name, so it arrives as
    `IMG:<name>`), and the first provider call execute() makes. The
    class_type is the schema's node_id, as the canvas sends it (PersonSwap's
    Python class is PersonSwapNode). A pass-through also records `passes`:
    the input whose picture execute() handed on unchanged."""
    kwargs = dict(widgets)
    for name in links:
        kwargs[name] = name
    call, previews = _capture(node_cls, **kwargs)
    case = {
        "class_type": node_cls.define_schema().node_id,
        "links": list(links),
        "widgets": widgets,
        "call": call,
    }
    if call.get("passthrough"):
        passed = previews[0] if previews else None
        case["passes"] = passed if isinstance(passed, str) else None
    return case


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

    # Only the required inputs, at the schema defaults (B2 review M3): the
    # optional ones are left to execute()'s own defaults, which the runner
    # must match when they are missing from the prompt.
    cases.append(_node_case(nr.EditImageNode, ["input_image"], {
        "model": "Nano Banana 2", "prompt": "", "aspect_ratio": "match_input_image", "resolution": "1K",
        "seed": 0, "safety_tolerance": 2, "prompt_upsampling": False, "output_format": "png"}))
    cases.append(_node_case(nr.DevelopImageNode, ["input_image"], {"resolution": "1K", "seed": 0}))
    cases.append(_node_case(RelightNode, ["image"], {
        "preset": "Custom", "light": '{"azimuth":-30,"elevation":20,"intensity":0.6}'}))
    cases.append(_node_case(nr.BlendSceneNode, ["image"], {
        "model": "Flux Kontext Pro", "unify_lighting": True, "contact_shadows": True, "match_camera_look": True,
        "preserve_identity": True, "keep_feather": 2.0, "seed": 0, "output_format": "png"}))
    return cases


# ── replicateImage (Task B4) ─────────────────────────────────────────────

# The Replicate-primary, priced, non-SVG image models the runner takes
# (shared/runner/eligibility.ts RUNNER_REPLICATE_IMAGE_MODEL_IDS).
REPLICATE_IMAGE_IDS = [
    "flux-1.1-pro-ultra", "flux-pro", "flux-dev",
    "flux-2-max", "flux-2-pro", "flux-2-flex", "flux-2-klein-4b", "flux-2-dev",
    "imagen-4-ultra", "imagen-4", "imagen-4-fast", "imagen-3", "imagen-3-fast",
    "ideogram-v2", "ideogram-v2a-turbo",
    "seedream-4.5", "seedream-3",
    "recraft-v4-pro", "recraft-v4", "recraft-v3",
    "stable-diffusion-3.5-large", "stable-diffusion-3.5-large-turbo", "stable-diffusion-3.5-medium",
    "gpt-image-2", "gpt-image-1.5",
    "qwen-image", "hunyuan-image-3", "grok-imagine",
    "flux-fast", "p-image", "wan-2.2-image-pruna",
    "bria-fibo", "bria-image-3.2",
    "photon", "photon-flash",
    "minimax-image-01",
]

# Values for each kind of `model_options` reader, in range, out of range and of
# the wrong type. Left out on purpose: whole-number floats and lists/dicts for
# string keys (Python's str(1.0) is "1.0", but JSON.parse gives JS the number 1),
# and inf/nan (not valid JSON for the fixture file).
_INT_VALUES = [3, 9, -2, "0", " 7 ", "2.5", "abc", "1_0", True, False, None, 3.7, [1]]
_FLOAT_VALUES = [2.25, 99, -1, "4.2", " 3 ", "1e1", "1_0.5", ".5", "abc", True, None, [2]]
_BOOL_VALUES = [True, False, "yes", "No", "TRUE", "off", 1, 0, None, [], ""]
_STR_VALUES = ["png", "", 5, True, None, 0.25]

# Each Replicate builder's `model_options` keys and how it reads them.
_REPLICATE_ADV_KEYS = {
    "flux-1.1-pro-ultra": {"raw": "bool", "safety_tolerance": "int", "output_format": "str"},
    "flux-pro": {"guidance": "float", "safety_tolerance": "int", "prompt_upsampling": "bool", "output_format": "str"},
    "flux-dev": {"num_inference_steps": "int", "guidance": "float", "megapixels": "str", "go_fast": "bool",
                 "num_outputs": "int", "output_format": "str"},
    "flux-2-max": {"resolution": "str", "safety_tolerance": "int", "output_format": "str"},
    "flux-2-pro": {"resolution": "str", "safety_tolerance": "int", "output_format": "str"},
    "flux-2-flex": {"resolution": "str", "steps": "int", "guidance": "float", "safety_tolerance": "int",
                    "prompt_upsampling": "bool", "output_format": "str"},
    "flux-2-klein-4b": {"output_megapixels": "str", "go_fast": "bool", "output_format": "str"},
    "flux-2-dev": {"resolution": "str", "steps": "int", "guidance": "float", "safety_tolerance": "int",
                   "prompt_upsampling": "bool", "output_format": "str"},
    "imagen-4-ultra": {"output_format": "str", "safety_filter_level": "str"},
    "imagen-4": {"output_format": "str", "safety_filter_level": "str"},
    "imagen-4-fast": {"output_format": "str", "safety_filter_level": "str"},
    "imagen-3": {"output_format": "str", "safety_filter_level": "str"},
    "imagen-3-fast": {"output_format": "str", "safety_filter_level": "str"},
    "ideogram-v2": {"style_type": "str", "magic_prompt": "str"},
    "ideogram-v2a-turbo": {"style_type": "str", "magic_prompt": "str"},
    "seedream-4.5": {"size": "str"},
    "seedream-3": {"guidance_scale": "float"},
    "recraft-v4-pro": {},
    "recraft-v4": {},
    "recraft-v3": {"style": "str"},
    "stable-diffusion-3.5-large": {"cfg": "float", "output_format": "str", "negative_prompt": "str"},
    "stable-diffusion-3.5-large-turbo": {"cfg": "float", "output_format": "str", "negative_prompt": "str"},
    "stable-diffusion-3.5-medium": {"cfg": "float", "output_format": "str", "negative_prompt": "str"},
    "gpt-image-2": {"quality": "str", "background": "str", "output_format": "str"},
    "gpt-image-1.5": {"quality": "str", "background": "str", "input_fidelity": "str", "output_format": "str"},
    "qwen-image": {"guidance": "float", "num_inference_steps": "int", "enhance_prompt": "bool",
                   "output_format": "str", "negative_prompt": "str"},
    "hunyuan-image-3": {"go_fast": "bool", "output_format": "str"},
    "grok-imagine": {},
    "flux-fast": {"guidance": "float", "num_inference_steps": "int", "speed_mode": "str", "output_format": "str"},
    "p-image": {"prompt_upsampling": "bool"},
    "wan-2.2-image-pruna": {"megapixels": "int", "juiced": "bool", "output_format": "str"},
    "bria-fibo": {"guidance_scale": "int", "negative_prompt": "str"},
    "bria-image-3.2": {"guidance_scale": "float", "prompt_enhancement": "bool", "enhance_image": "bool",
                       "negative_prompt": "str"},
    "photon": {},
    "photon-flash": {},
    "minimax-image-01": {"prompt_optimizer": "bool"},
}
_VALUES_BY_KIND = {"int": _INT_VALUES, "float": _FLOAT_VALUES, "bool": _BOOL_VALUES, "str": _STR_VALUES}
# Keys that change the payload beyond their own value (negative_prompt is left out when blank).
_STR_EXTRA = {"negative_prompt": ["a blur", "  "], "size": ["4K"], "resolution": ["2 MP"],
              "megapixels": ["0.25"], "output_megapixels": ["0.25"], "style_type": ["Design", "None"]}
_MOODBOARD = json.dumps({"folder": "moodboard_1727", "files": ["a.png", "b.jpg"]})


def _replicate_image_cases() -> list:
    """Task B4 (replicate-image): GenerateImageNode on every Replicate-primary
    runner model — the four common cases, every model_options key the builder
    reads (in range, out of range, wrong type), every ratio of the node's list,
    and the moodboard / prompt-composition inputs (ignored or folded as Python
    does)."""
    nr, _fal_refs, _extras = _node_modules()
    from comfy_api_nodes.image_models import ALL_ASPECT_RATIOS
    cases = []

    def gen(mid, prompt="a red fox", ar="1:1", seed=0, adv=None, options=None, **extra):
        widgets = {"model": mid, "prompt": prompt, "aspect_ratio": ar, "seed": seed,
                   "model_options": options if options is not None else json.dumps(adv or {}), **extra}
        cases.append(_node_case(nr.GenerateImageNode, [], widgets))

    for mid in REPLICATE_IMAGE_IDS:
        for c in COMMON_IMAGE_CASES:
            gen(mid, prompt=c["prompt"], ar=c["ar"], seed=c["seed"], adv=c["adv"])
        for key, kind in _REPLICATE_ADV_KEYS[mid].items():
            for v in _VALUES_BY_KIND[kind] + (_STR_EXTRA.get(key, []) if kind == "str" else []):
                gen(mid, seed=7, adv={key: v})
        # Every ratio the node offers: each model keeps its own and falls back to 1:1.
        for ar in ALL_ASPECT_RATIOS:
            gen(mid, prompt="p", ar=ar, seed=1)
        gen(mid, seed=2**32 - 1)
        # Moodboard pictures are ignored (no model here is 'multi-image'), and so is
        # their style-only instruction; the style block and the Idea text fold in.
        gen(mid, prompt="a fox", seed=3, style_refs=_MOODBOARD)
        gen(mid, prompt="a fox", seed=3, style_block=" soft light ", prompt_in="idea", style_in="taste",
            style_refs=_MOODBOARD)

    # model_options Python can't read as an object are empty.
    for options in ("", "{not json", "[1, 2]", "null", "7"):
        gen("flux-2-pro", options=options)
    gen("flux-dev", adv={"num_outputs": 3, "guidance": "2", "megapixels": "0.25", "go_fast": "false"})
    gen("stable-diffusion-3.5-large", prompt="", adv={"negative_prompt": "blur", "cfg": 3})
    return cases


# ── nanoActions (Task B5) ────────────────────────────────────────────────

# Blank (pass-through) and non-blank text, including the characters where
# Python's str.strip() and JS trim() disagree: U+FEFF is not space to Python,
# U+001F is.
_ACTION_TEXTS = ["the red car", "  the red car  ", "", "   ", "\ufeff", "\x1f"]
_ACTION_INSTRUCTIONS = ["", "   ", "match the brick texture", "  padded, with a \x1f  "]


def _nano_actions_cases() -> list:
    """Task B5 (nano-actions): the three edit actions, Swap Background, Swap
    Product, Person Swap and BlendSceneNode's Nano Banana mode, over the text
    and toggle combinations that call and every pass-through combination."""
    nr, _fal_refs, _extras = _node_modules()
    from comfy_extras.nodes_edit_actions import RemoveObjectNode, TextEditNode, RecolorObjectNode
    from comfy_extras.nodes_swap_background import SwapBackgroundNode
    from comfy_extras.nodes_swap_product import SwapProductNode
    from comfy_extras.nodes_person_swap import PersonSwapNode
    cases = []

    def case(cls, links, widgets):
        cases.append(_node_case(cls, links, widgets))

    # Remove Object: target × instructions; instructions missing (optional).
    for target in _ACTION_TEXTS:
        for ins in _ACTION_INSTRUCTIONS:
            case(RemoveObjectNode, ["image"], {"target": target, "instructions": ins})
    case(RemoveObjectNode, ["image"], {"target": "the cup"})

    # Edit Text: find × replace, then the instructions on a calling pair.
    for find in ["SALE", " SALE ", "", "  ", "\ufeff"]:
        for replace in ["50% OFF", "", " \x1f ", " it's "]:
            case(TextEditNode, ["image"], {"find": find, "replace": replace, "instructions": ""})
    for ins in _ACTION_INSTRUCTIONS:
        case(TextEditNode, ["image"], {"find": "SALE", "replace": "50% OFF", "instructions": ins})
    case(TextEditNode, ["image"], {"find": "SALE", "replace": "NEW"})

    # Recolor Object: target × color, then the instructions.
    for target in ["the shirt", " the shirt ", "", "  ", "\x1f"]:
        for color in ["forest green (#2d6a4f)", "", "  #ff0000  ", "\ufeff"]:
            case(RecolorObjectNode, ["image"], {"target": target, "color": color, "instructions": ""})
    for ins in _ACTION_INSTRUCTIONS:
        case(RecolorObjectNode, ["image"], {"target": "the mug", "color": "#ff0000", "instructions": ins})
    case(RecolorObjectNode, ["image"], {"target": "the mug", "color": "red"})

    # Swap Background: reference or not × scene prompt × the three toggles × instructions.
    for links in (["product"], ["product", "background_reference"]):
        for scene in ["", "   ", "marble bathroom counter, soft morning light", "  padded scene  ", "\ufeff"]:
            for mask in range(8):
                for ins in ("", "  warmer tone  "):
                    case(SwapBackgroundNode, links, {
                        "scene_prompt": scene, "relight_to_scene": bool(mask & 1),
                        "ground_with_shadow": bool(mask & 2), "keep_scale_and_placement": bool(mask & 4),
                        "instructions": ins})
        # Only the required inputs (the toggles at their defaults; no scene prompt, no instructions).
        case(SwapBackgroundNode, links, {"relight_to_scene": True, "ground_with_shadow": True,
                                         "keep_scale_and_placement": True})
    case(SwapBackgroundNode, ["product"], {"scene_prompt": "a beach", "relight_to_scene": 0,
                                           "ground_with_shadow": 1, "keep_scale_and_placement": ""})

    # Swap Product: both pictures, or the scene only (pass-through).
    for links in (["scene_reference", "product"], ["scene_reference"]):
        for ins in _ACTION_INSTRUCTIONS:
            case(SwapProductNode, links, {"instructions": ins})
        case(SwapProductNode, links, {})

    # Person Swap: both pictures, or the scene only (pass-through); outfit on, off, missing.
    for links in (["scene", "person"], ["scene"]):
        for outfit in (True, False):
            for ins in _ACTION_INSTRUCTIONS:
                case(PersonSwapNode, links, {"keep_original_outfit": outfit, "instructions": ins})
        case(PersonSwapNode, links, {})

    # Blend Scene · Nano Banana: the 16 toggle sets, a custom prompt, a blank
    # one, and the dials Nano Banana ignores (seed, output_format, keep_feather).
    blend_base = {"model": "Nano Banana", "unify_lighting": True, "contact_shadows": True,
                  "match_camera_look": True, "preserve_identity": True, "keep_feather": 2.0,
                  "prompt": "", "seed": 0, "output_format": "png"}
    for mask in range(16):
        case(nr.BlendSceneNode, ["image"], {**blend_base, "unify_lighting": bool(mask & 1),
                                            "contact_shadows": bool(mask & 2), "match_camera_look": bool(mask & 4),
                                            "preserve_identity": bool(mask & 8)})
    for over in ({"prompt": "  make it one cosy photo  "}, {"prompt": "   ", "unify_lighting": False},
                 {"prompt": "\ufeff"}, {"seed": 2**32 + 5, "output_format": "jpg", "keep_feather": 0.0}):
        case(nr.BlendSceneNode, ["image"], {**blend_base, **over})
    case(nr.BlendSceneNode, ["image"], {k: v for k, v in blend_base.items() if k != "prompt"})
    return cases


# ── replicateVideo (Task B6) ─────────────────────────────────────────────

# The Replicate-provider video models the runner takes: every one but
# fabric-1.0, which needs sound (shared/runner/eligibility.ts
# RUNNER_REPLICATE_VIDEO_MODEL_IDS).
REPLICATE_VIDEO_IDS = [
    "sora-2", "sora-2-pro", "runway-gen-4.5", "kling-v3", "kling-v2.5-turbo-pro",
    "seedance-2.0-fast", "hailuo-2.3", "wan-2.7-t2v", "wan-2.5-i2v-fast",
    "luma-ray-2-720p", "ltx-video", "pixverse-v6",
]

# Each Replicate video builder's `model_options` keys and how it reads them.
_REPLICATE_VIDEO_ADV_KEYS = {
    "sora-2": {},
    "sora-2-pro": {},
    "runway-gen-4.5": {"motion": "int"},
    "kling-v3": {"generate_audio": "bool", "cfg_scale": "float", "negative_prompt": "str"},
    "kling-v2.5-turbo-pro": {"negative_prompt": "str"},
    "seedance-2.0-fast": {"resolution": "str", "camera_fixed": "bool"},
    "hailuo-2.3": {"resolution": "str", "prompt_optimizer": "bool"},
    "wan-2.7-t2v": {"resolution": "str", "num_frames": "int", "negative_prompt": "str"},
    "wan-2.5-i2v-fast": {"resolution": "str", "negative_prompt": "str"},
    "luma-ray-2-720p": {"loop": "bool"},
    "ltx-video": {"guidance_scale": "float", "num_inference_steps": "int", "negative_prompt": "str"},
    "pixverse-v6": {"resolution": "str", "generate_audio": "bool", "style": "str", "negative_prompt": "str"},
}
_VIDEO_STR_EXTRA = {"negative_prompt": ["a blur", "  "], "resolution": ["1080p"], "style": ["none", "anime"]}
# Durations and ratios off every model's list, as well as on it.
_VIDEO_DURATIONS_EXTRA = [0, 1, 2, 7, 9, 12, 100, -3]
_VIDEO_RATIOS_EXTRA = ["4:1", "2:3", ""]


def _replicate_video_cases() -> list:
    """Task B6 (replicate-video): VIDEO_MODELS_BY_ID[id].build_input for every
    Replicate-provider runner model — the three common video cases, every
    model_options key the builder reads (in range, out of range, wrong type),
    a first frame present and absent, and durations and ratios on and off the
    model's list. A builder that raises (Wan 2.5 I2V Fast with no first frame)
    records the message as `error`."""
    from comfy_api_nodes.video_models import ALL_VIDEO_ASPECT_RATIOS, ALL_VIDEO_DURATIONS
    cases = []

    def build(mid, prompt="a wave", ar="16:9", dur=5, seed=0, image=None, adv=None):
        spec = VIDEO_MODELS_BY_ID[mid]
        args = {"prompt": prompt, "ar": ar, "dur": dur, "seed": seed, "image": image, "adv": adv or {}}
        case = {"model": mid, "provider": spec.provider, "slug": spec.replicate_slug,
                "modes": list(spec.modes), "default_duration": spec.default_duration, "args": args}
        try:
            payload = spec.build_input(prompt, ar, int(dur), int(seed or 0), image, None, dict(args["adv"]))
            case["payload"] = json.loads(json.dumps(payload))
        except RuntimeError as e:
            case["error"] = str(e)
        cases.append(case)

    for mid in REPLICATE_VIDEO_IDS:
        needs_image = "t2v" not in VIDEO_MODELS_BY_ID[mid].modes
        frame = "IMAGE_URL" if needs_image else None
        for c in COMMON_VIDEO_CASES:
            build(mid, prompt=c["prompt"], ar=c["ar"], dur=c["dur"], seed=c["seed"], image=c["image"], adv=c["adv"])
        for key, kind in _REPLICATE_VIDEO_ADV_KEYS[mid].items():
            for v in _VALUES_BY_KIND[kind] + (_VIDEO_STR_EXTRA.get(key, []) if kind == "str" else []):
                build(mid, seed=7, image=frame, adv={key: v})
        # A first frame present and absent, with and without options.
        for image in (None, "IMAGE_URL"):
            build(mid, prompt="p", ar="9:16", dur=5, seed=3, image=image)
        # Every duration the node offers, and some none does.
        for dur in ALL_VIDEO_DURATIONS + _VIDEO_DURATIONS_EXTRA:
            build(mid, prompt="p", dur=dur, seed=1, image=frame)
        # Every ratio the node offers, and some none does.
        for ar in ALL_VIDEO_ASPECT_RATIOS + _VIDEO_RATIOS_EXTRA:
            build(mid, prompt="p", ar=ar, seed=1, image=frame)
            build(mid, prompt="p", ar=ar, seed=1, image="IMAGE_URL")
        for seed in (2**32 - 1, -1):
            build(mid, prompt="p", seed=seed, image=frame)
        build(mid, prompt="", seed=0, image=frame)
    return cases


def family_cases() -> dict:
    out = {key: [] for key in FAMILY_KEYS}
    out["falEdit"] = _fal_edit_cases()
    out["replicateImage"] = _replicate_image_cases()
    out["replicateVideo"] = _replicate_video_cases()
    out["nanoActions"] = _nano_actions_cases()
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
