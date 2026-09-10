"""ShaderEffect: Unicorn Studio-style GLSL effects with a live WebGL node preview.

The browser renders the same .frag sources (served by the routes below) in the
node body; this module is the server half that produces real IMAGE output.
Design: docs/plans/2026-06-10-shader-effects-design.md
"""
from __future__ import annotations

import os

import numpy as np
import torch
from typing_extensions import override

from comfy_api.latest import ComfyExtension, IO
from comfy_extras._live_preview import save_live_preview
from comfy_extras._shader_effects import (
    ASSETS_DIR,
    _PARAM_KEY_ALIASES,
    frame_plan,
    load_catalog,
    render_effect,
    resolve_params,
    to_uniforms,
)

LEGACY_EFFECT_IDS = {"filament": "thread_contours"}

# The loader renames camelCase manifest keys to snake_case dataclass fields
# (maxStops→max_stops, showWhen→show_when). Serialising a param straight from
# vars(p) would ship those snake_case names to the browser, which reads the
# camelCase originals (p.maxStops, p.showWhen) — so the values silently vanish
# (p.showWhen === undefined → the visibility gate never fires). Invert the alias
# map to camelCase them back on the way out, keeping parse and serialise
# symmetric. Effect-level fields (centerParam) are already camelCased by hand
# below; this closes the same gap for the nested param dicts.
_PARAM_KEY_TO_MANIFEST = {v: k for k, v in _PARAM_KEY_ALIASES.items()}


def _param_payload(param) -> dict:
    """A catalog param as the frontend expects it: dataclass fields with the
    manifest's camelCase key names restored."""
    return {_PARAM_KEY_TO_MANIFEST.get(k, k): v for k, v in vars(param).items()}


# All output frames are held in RAM before stacking; cap the count so an extreme
# duration*fps cannot exhaust memory (300 ≈ 12.5s @ 24fps).
MAX_OUTPUT_FRAMES = 300

# Output size for generative effects (no source image to inherit from).
# resolution = longest edge; dims forced even.
_ASPECT_RATIOS = {"1:1": (1, 1), "16:9": (16, 9), "9:16": (9, 16), "4:5": (4, 5), "3:2": (3, 2)}


def _aspect_size(resolution: int, aspect: str) -> tuple[int, int]:
    rw, rh = _ASPECT_RATIOS.get(aspect, (1, 1))
    if rw >= rh:
        w, h = resolution, round(resolution * rh / rw)
    else:
        w, h = round(resolution * rw / rh), resolution
    return max(2, w - (w % 2)), max(2, h - (h % 2))


def _effect_ids() -> list[str]:
    try:
        return list(load_catalog().effects.keys())
    except Exception:
        return []


_texture_cache: dict[str, np.ndarray] = {}


def _load_effect_textures(effect) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    """Load catalog texture assets for an effect. Returns (textures, extra_uniforms)."""
    from PIL import Image as PILImage

    textures: dict[str, np.ndarray] = {}
    extra_uniforms: dict[str, float] = {}
    for t in effect.textures:
        fname = t["file"]
        if fname not in _texture_cache:
            path = os.path.join(ASSETS_DIR, fname)
            img = PILImage.open(path).convert("RGBA")
            _texture_cache[fname] = np.asarray(img, dtype=np.float32) / 255.0
        textures[t["uniform"]] = _texture_cache[fname]
        for k, v in t.get("extraUniforms", {}).items():
            extra_uniforms[k] = float(v)
    return textures, extra_uniforms


class ShaderEffect(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ShaderEffect",
            display_name="Shader Effect",
            description="Real-time shader effects (distortion, dither, halftone…) with a live animated preview. Runs locally on the GPU.",
            category="image/effects",
            inputs=[
                IO.Image.Input("image", optional=True),
                IO.Combo.Input(
                    "effect",
                    options=(_effect_ids() or ["noise_distortion"])
                    + [k for k in LEGACY_EFFECT_IDS if k not in _effect_ids()],
                ),
                IO.String.Input("params", default="{}", multiline=True),
                IO.Float.Input("time", default=0.0, min=0.0, max=3600.0, step=0.05),
                IO.Float.Input("duration", default=0.0, min=0.0, max=60.0, step=0.5),
                IO.Int.Input("fps", default=24, min=1, max=60, step=1),
                IO.Int.Input("seed", default=42, min=0, max=2 ** 31 - 1, step=1),
                IO.Int.Input("resolution", default=768, min=256, max=2048, step=64),
                IO.Combo.Input("aspect", options=["1:1", "16:9", "9:16", "4:5", "3:2"], default="1:1"),
            ],
            outputs=[IO.Image.Output(display_name="image")],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, effect, params, time, duration, fps, seed, resolution, aspect, image=None) -> IO.NodeOutput:
        # `image` is an optional input: when unconnected, ComfyUI omits it entirely
        # (doesn't pass None), so it must default. Inputs are passed by keyword, so
        # signature order is free — `image` goes last to satisfy Python defaults.
        catalog = load_catalog()
        effect = LEGACY_EFFECT_IDS.get(effect, effect)
        if effect not in catalog.effects:
            raise ValueError(f"ShaderEffect: unknown effect {effect!r}")
        eff = catalog.effects[effect]

        uniforms = to_uniforms(eff, resolve_params(eff, params))
        textures, extra_uniforms = _load_effect_textures(eff)
        uniforms.update(extra_uniforms)

        if image is not None:
            np_img = image.cpu().numpy().astype(np.float32)
            b, h, w, _ = np_img.shape
        else:
            if not eff.generative:
                raise ValueError(
                    f"ShaderEffect: {effect!r} needs an image input. "
                    f"Connect an image, or choose a generative effect."
                )
            np_img = None
            w, h = _aspect_size(int(resolution), str(aspect))
            b = 1

        plan = frame_plan(b, float(time), float(duration), int(fps))
        if len(plan) > MAX_OUTPUT_FRAMES:
            raise ValueError(
                f"ShaderEffect: {len(plan)} frames requested (duration={duration}, fps={fps}); "
                f"max is {MAX_OUTPUT_FRAMES}. Reduce duration or fps."
            )

        # Base frame per job: the source frame, or a black canvas for generative
        # effects (which ignore u_image0). image=None reuses the previous upload,
        # so only the first job of each distinct source frame uploads.
        def base_for(fi: int):
            return np.ascontiguousarray(np_img[fi]) if np_img is not None else np.zeros((h, w, 3), dtype=np.float32)

        # u_hasInput lets hybrid effects (e.g. fbm) modulate a connected image
        # vs. synthesize from scratch when nothing is wired in.
        has_input = 1.0 if image is not None else 0.0
        jobs = [
            {
                "image": base_for(fi) if (i == 0 or fi != plan[i - 1][0]) else None,
                "uniforms": {**uniforms, "u_time": t, "u_seed": float(seed % 10000), "u_hasInput": has_input},
            }
            for i, (fi, t) in enumerate(plan)
        ]
        outs = render_effect(eff.source, w, h, jobs, extra_textures=textures, passes=eff.passes)
        out = torch.from_numpy(np.stack([o[..., :3] for o in outs])).clamp(0, 1)
        return IO.NodeOutput(out, ui=save_live_preview(out, str(cls.hidden.unique_id), unique=True))


class ShaderEffectsExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [ShaderEffect]


async def comfy_entrypoint() -> ShaderEffectsExtension:
    return ShaderEffectsExtension()


def _texture_version(fname: str) -> str:
    """mtime of an asset file, for cache-busting its URL when it's rebaked."""
    try:
        return str(int(os.path.getmtime(os.path.join(ASSETS_DIR, fname))))
    except OSError:
        return "0"


def catalog_payload() -> dict:
    """Manifest with .frag sources inlined — what the frontend preview consumes.

    Re-reads from disk every call (cheap) so shader iteration only needs a
    browser refresh, not a server restart. Node combo options DO need a restart.
    """
    catalog = load_catalog(refresh=True)
    effects = []
    for eff in catalog.effects.values():
        effects.append({
            "id": eff.id,
            "name": eff.name,
            "category": eff.category,
            "animated": eff.animated,
            "passes": eff.passes,
            "generative": eff.generative,
            "followsShape": eff.follows_shape,
            "centerParam": eff.center_param,
            "textures": [{**t, "v": _texture_version(t["file"])} for t in eff.textures],
            "params": [_param_payload(p) for p in eff.params],
            "source": eff.source,
        })
    return {"version": catalog.version, "effects": effects}


try:
    from aiohttp import web

    from server import PromptServer

    @PromptServer.instance.routes.get("/sailor/shader_effects")
    async def _get_shader_effects(request):
        try:
            return web.json_response(catalog_payload())
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/sailor/shader_effects/assets/{name}")
    async def _get_shader_asset(request):
        name = os.path.basename(request.match_info["name"])  # no traversal
        path = os.path.join(ASSETS_DIR, name)
        if not os.path.isfile(path):
            return web.json_response({"error": "not found"}, status=404)
        # no-cache: the browser must revalidate via ETag/Last-Modified (304 when
        # unchanged, fresh bytes when an asset is rebaked). FileResponse's default
        # max-age=86400 served stale atlases for 24h after a texture rebuild — and a
        # stale atlas of the wrong size makes texelFetch read out of bounds → black.
        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})

except Exception as e:  # imported headless (tests) — pure functions still work
    print(f"[Sailor] shader_effects routes not registered: {e}")
