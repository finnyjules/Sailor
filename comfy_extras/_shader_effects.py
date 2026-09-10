"""Shader-effects catalog: loading, validation, param resolution, frame planning.

The catalog (shader_effects/ at repo root) is the single source of truth for both
the browser preview (served via /sailor/shader_effects) and server rendering.
Rendering lives in render_effect() (added alongside; reuses nodes_glsl machinery).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import numpy as np

CATALOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shader_effects")
ASSETS_DIR = os.path.join(CATALOG_DIR, "assets")


@dataclass
class EffectParam:
    uniform: str
    label: str
    type: str
    default: float | str | list
    min: float = 0.0
    max: float = 0.0
    step: float = 0.0
    options: list[dict] | None = None
    max_stops: int = 8
    # Frontend-only visibility gate — a single {uniform, equals} dict, or a LIST
    # of them (AND). The server doesn't render UI, so it just carries the value
    # through rather than rejecting it.
    show_when: dict | list | None = None


# Param types whose value is a colour rather than a number. These are NOT
# animatable: motion targets derive from this same list, and a hex string has no
# meaningful interpolation in a float sweep.
COLOR_TYPES = ("color", "gradient")

# Manifest param keys are camelCase; the dataclass fields are snake_case. Only the
# keys that differ need mapping — everything else passes through unchanged.
_PARAM_KEY_ALIASES = {"maxStops": "max_stops", "showWhen": "show_when"}


def parse_hex(hex_str: str) -> tuple[float, float, float]:
    """'#rgb' / '#rrggbb' / '#rrggbbaa' → (r, g, b) in 0..1, alpha dropped.

    The 4- and 8-digit forms are accepted because StudioColor — the picker these
    params render in the browser — emits `#rrggbbaa` the moment a user touches its
    alpha track, which sits directly under the hue track. Rejecting them would send
    the param back to its default, so choosing a colour would appear to do nothing.
    Alpha is discarded rather than honoured: these uniforms are vec3.
    """
    h = hex_str.lstrip("#")
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    if len(h) == 8:
        h = h[:6]
    if len(h) != 6:
        raise ValueError(f"not a hex colour: {hex_str!r}")
    n = int(h, 16)
    return (((n >> 16) & 255) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0)


@dataclass
class Effect:
    id: str
    name: str
    category: str
    animated: bool
    passes: int
    center_param: list[str] | None
    textures: list[dict]
    params: list[EffectParam]
    source: str
    generative: bool = False
    # A lens effect that can take a layer's silhouette from the Frame (u_shape and friends).
    follows_shape: bool = False


@dataclass
class Catalog:
    version: int
    effects: dict[str, Effect] = field(default_factory=dict)


_catalog: Catalog | None = None


def load_catalog(refresh: bool = False) -> Catalog:
    global _catalog
    if _catalog is not None and not refresh:
        return _catalog

    manifest_path = os.path.join(CATALOG_DIR, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    effects: dict[str, Effect] = {}
    for entry in manifest["effects"]:
        eid = entry["id"]
        if eid in effects:
            raise ValueError(f"shader_effects manifest: duplicate effect id {eid!r}")
        frag_path = os.path.join(CATALOG_DIR, f"{eid}.frag")
        if not os.path.isfile(frag_path):
            raise ValueError(f"shader_effects manifest: missing shader file for {eid!r}")
        with open(frag_path, "r", encoding="utf-8") as f:
            source = f.read()
        params = [EffectParam(**{_PARAM_KEY_ALIASES.get(k, k): v for k, v in p.items()})
                  for p in entry["params"]]
        for p in params:
            if p.type == "enum":
                values = [o["value"] for o in (p.options or [])]
                if not values:
                    raise ValueError(f"shader_effects {eid!r}: enum {p.uniform} has no options")
                if p.default not in values:
                    raise ValueError(f"shader_effects {eid!r}: enum default for {p.uniform} not an option")
            elif p.type == "color":
                try:
                    parse_hex(p.default)
                except (ValueError, AttributeError, TypeError):
                    raise ValueError(f"shader_effects {eid!r}: color default for {p.uniform} is not a hex colour")
            elif p.type == "gradient":
                stops = p.default
                if not isinstance(stops, list) or len(stops) < 2:
                    raise ValueError(f"shader_effects {eid!r}: gradient {p.uniform} needs at least 2 stops")
                if len(stops) > p.max_stops:
                    raise ValueError(f"shader_effects {eid!r}: gradient {p.uniform} has more than maxStops={p.max_stops} stops")
                for s in stops:
                    try:
                        parse_hex(s["color"])
                    except (ValueError, AttributeError, TypeError, KeyError):
                        raise ValueError(f"shader_effects {eid!r}: gradient {p.uniform} has a bad stop colour")
                    if not (0.0 <= float(s["pos"]) <= 1.0):
                        raise ValueError(f"shader_effects {eid!r}: gradient {p.uniform} stop pos outside [0, 1]")
            elif not (p.min <= p.default <= p.max):
                raise ValueError(f"shader_effects {eid!r}: default for {p.uniform} outside [min, max]")
        effects[eid] = Effect(
            id=eid,
            name=entry["name"],
            category=entry["category"],
            animated=entry["animated"],
            passes=entry.get("passes", 1),
            generative=entry.get("generative", False),
            follows_shape=entry.get("followsShape", False),
            center_param=entry.get("centerParam"),
            textures=entry.get("textures", []),
            params=params,
            source=source,
        )

    _catalog = Catalog(version=manifest["version"], effects=effects)
    return _catalog


def _clean_stops(raw, max_stops: int, fallback: list) -> list:
    """A gradient value → a sorted, validated stop list, or `fallback` if unusable.

    SORT THEN SLICE, matching cleanStops() in lib/shaderfx/params.ts. Slicing
    first would take the first N in author order, so the same ramp given in a
    different order would yield a different subset — and the two sides of the
    browser/server parity gate would diverge on which stops are live.
    """
    if not isinstance(raw, list) or len(raw) < 2:
        return fallback
    out = []
    for s in raw:
        try:
            parse_hex(s["color"])
            pos = min(max(float(s["pos"]), 0.0), 1.0)
        except (ValueError, AttributeError, TypeError, KeyError):
            return fallback
        out.append({"pos": pos, "color": s["color"]})
    return sorted(out, key=lambda s: s["pos"])[:max_stops]


def resolve_params(effect: Effect, params_json: str) -> dict:
    """Defaults merged with user JSON; clamped to [min, max]; unknown keys dropped.

    Returns the *values* keyed by uniform name — floats for float/enum, a hex
    string for `color`, a stop list for `gradient`. This is the canonical stored
    form; `to_uniforms()` turns it into what the GL layer actually uploads.
    """
    try:
        user = json.loads(params_json) if params_json and params_json.strip() else {}
        if not isinstance(user, dict):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        raise ValueError(f"ShaderEffect {effect.id!r}: params is not a valid JSON object")

    out: dict = {}
    for p in effect.params:
        raw = user.get(p.uniform, p.default)
        if p.type == "color":
            try:
                parse_hex(raw)
                out[p.uniform] = raw
            except (ValueError, AttributeError, TypeError):
                out[p.uniform] = p.default
            continue
        if p.type == "gradient":
            out[p.uniform] = _clean_stops(raw, p.max_stops, p.default)
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            v = p.default
        if p.type == "enum":
            values = [float(o["value"]) for o in (p.options or [])]
            out[p.uniform] = v if v in values else float(p.default)
        else:
            out[p.uniform] = min(max(v, p.min), p.max)
    return out


def to_uniforms(effect: Effect, values: dict) -> dict:
    """Resolved values → the uniform dict the GL layer uploads.

    Floats pass through. A `color` becomes one vec3. A `gradient` expands to
    `u_x[i]` (vec3), `u_xPos[i]` (float) and `u_xCount` — indexed names are
    ordinary uniform locations, so arrays need no extra machinery.
    """
    out: dict = {}
    for p in effect.params:
        v = values.get(p.uniform, p.default)
        if p.type == "color":
            out[p.uniform] = parse_hex(v if isinstance(v, str) else p.default)
        elif p.type == "gradient":
            stops = v if isinstance(v, list) and len(v) >= 2 else p.default
            stops = sorted(stops, key=lambda s: s["pos"])[:p.max_stops]
            out[f"{p.uniform}Count"] = float(len(stops))
            for i, s in enumerate(stops):
                out[f"{p.uniform}[{i}]"] = parse_hex(s["color"])
                out[f"{p.uniform}Pos[{i}]"] = float(s["pos"])
        else:
            out[p.uniform] = v
    return out


def frame_plan(batch_size: int, time: float, duration: float, fps: int) -> list[tuple[int, float]]:
    """(input_frame_index, u_time) per output frame.

    Batch input: u_time advances per input frame, duration ignored.
    Still + duration: duration*fps frames from a single input frame.
    Still + no duration: one frame at `time`.
    """
    fps = max(1, int(fps))
    if batch_size > 1:
        return [(i, time + i / fps) for i in range(batch_size)]
    if duration > 0:
        return [(0, time + i / fps) for i in range(max(1, round(duration * fps)))]
    return [(0, time)]


MAX_RENDER_DIM = 8192


def render_effect(
    fragment_code: str,
    width: int,
    height: int,
    jobs: list[dict],
    extra_textures: dict[str, "np.ndarray"] | None = None,
    passes: int = 1,
) -> list["np.ndarray"]:
    """Render `fragment_code` once per job. Compiles once; per-job image + uniforms.

    jobs: [{"image": (H, W, 3|4) float32 [0,1] or None, "uniforms": {name: float | (r,g,b)}}]
    A 3-tuple uniform is uploaded as a vec3 (colour params); everything else as a float.
    A job with image=None reuses the previously uploaded frame; the FIRST job must
    therefore carry an image (the input texture is otherwise uninitialized).
    extra_textures: {uniform_name: (H, W, 4) float32} — bound NEAREST on units 2+.
    passes: ping-pong passes per job. Pass 0 reads the source via u_image0; pass k>0
    reads the previous pass output. u_source (unit 1) always holds the original input;
    u_pass / u_passCount expose the index/count. Intermediates are RGBA8 to match the
    browser renderer exactly. Returns one (height, width, 4) float32 array per job.
    """
    from comfy_extras.nodes_glsl import (
        GLContext,
        VERTEX_SHADER,
        _convert_es_to_desktop,
        _create_program,
        _import_opengl,
    )

    if not jobs:
        return []
    if width > MAX_RENDER_DIM or height > MAX_RENDER_DIM:
        raise ValueError(f"ShaderEffect: render size {width}x{height} exceeds {MAX_RENDER_DIM}")
    if jobs[0].get("image") is None:
        raise ValueError("ShaderEffect: the first job must include an image")

    n_passes = max(1, int(passes))
    ctx = GLContext()
    ctx.make_current()
    gl = _import_opengl()

    fragment_source = _convert_es_to_desktop(fragment_code)
    extra_textures = extra_textures or {}

    program = None
    fbo = None
    out_tex = None
    in_tex = None
    extra_tex_ids = []
    pp_tex = []
    pp_fbo = []
    try:
        program = _create_program(VERTEX_SHADER, fragment_source)
        gl.glUseProgram(program)

        # Final output FBO (single-pass renders here; RGBA32F for clean readback).
        fbo = gl.glGenFramebuffers(1)
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, fbo)
        out_tex = gl.glGenTextures(1)
        gl.glBindTexture(gl.GL_TEXTURE_2D, out_tex)
        gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA32F, width, height, 0, gl.GL_RGBA, gl.GL_FLOAT, None)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_LINEAR)
        gl.glFramebufferTexture2D(gl.GL_FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.GL_TEXTURE_2D, out_tex, 0)
        gl.glDrawBuffers(1, [gl.GL_COLOR_ATTACHMENT0])
        if gl.glCheckFramebufferStatus(gl.GL_FRAMEBUFFER) != gl.GL_FRAMEBUFFER_COMPLETE:
            raise RuntimeError("ShaderEffect: framebuffer incomplete")

        # Ping-pong RGBA8 textures for multi-pass (match browser 8-bit intermediates).
        if n_passes > 1:
            for _ in range(2):
                t = gl.glGenTextures(1)
                pp_tex.append(t)
                gl.glBindTexture(gl.GL_TEXTURE_2D, t)
                gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA8, width, height, 0, gl.GL_RGBA, gl.GL_UNSIGNED_BYTE, None)
                for pn in (gl.GL_TEXTURE_MIN_FILTER, gl.GL_TEXTURE_MAG_FILTER):
                    gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_LINEAR)
                for pn in (gl.GL_TEXTURE_WRAP_S, gl.GL_TEXTURE_WRAP_T):
                    gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_CLAMP_TO_EDGE)
                f = gl.glGenFramebuffers(1)
                pp_fbo.append(f)
                gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, f)
                gl.glFramebufferTexture2D(gl.GL_FRAMEBUFFER, gl.GL_COLOR_ATTACHMENT0, gl.GL_TEXTURE_2D, t, 0)
                gl.glDrawBuffers(1, [gl.GL_COLOR_ATTACHMENT0])
                if gl.glCheckFramebufferStatus(gl.GL_FRAMEBUFFER) != gl.GL_FRAMEBUFFER_COMPLETE:
                    raise RuntimeError("ShaderEffect: ping-pong framebuffer incomplete")

        # Source texture: unit 0 = u_image0 (pass 0), unit 1 = u_source (persistent).
        in_tex = gl.glGenTextures(1)
        gl.glActiveTexture(gl.GL_TEXTURE0)
        gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)
        for pn in (gl.GL_TEXTURE_MIN_FILTER, gl.GL_TEXTURE_MAG_FILTER):
            gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_LINEAR)
        for pn in (gl.GL_TEXTURE_WRAP_S, gl.GL_TEXTURE_WRAP_T):
            gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_CLAMP_TO_EDGE)
        loc = gl.glGetUniformLocation(program, "u_image0")
        if loc >= 0:
            gl.glUniform1i(loc, 0)
        gl.glActiveTexture(gl.GL_TEXTURE1)
        gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)
        sloc = gl.glGetUniformLocation(program, "u_source")
        if sloc >= 0:
            gl.glUniform1i(sloc, 1)

        # Extra textures on units 2+ (NEAREST: glyph atlases sampled exactly).
        for i, (uname, arr) in enumerate(sorted(extra_textures.items())):
            unit = 2 + i
            tex = gl.glGenTextures(1)
            extra_tex_ids.append(tex)
            gl.glActiveTexture(gl.GL_TEXTURE0 + unit)
            gl.glBindTexture(gl.GL_TEXTURE_2D, tex)
            for pn in (gl.GL_TEXTURE_MIN_FILTER, gl.GL_TEXTURE_MAG_FILTER):
                gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_NEAREST)
            for pn in (gl.GL_TEXTURE_WRAP_S, gl.GL_TEXTURE_WRAP_T):
                gl.glTexParameteri(gl.GL_TEXTURE_2D, pn, gl.GL_CLAMP_TO_EDGE)
            th, tw, _ = arr.shape
            gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA32F, tw, th, 0, gl.GL_RGBA, gl.GL_FLOAT,
                            np.ascontiguousarray(arr[::-1, :, :]))
            uloc = gl.glGetUniformLocation(program, uname)
            if uloc >= 0:
                gl.glUniform1i(uloc, unit)

        loc = gl.glGetUniformLocation(program, "u_resolution")
        if loc >= 0:
            gl.glUniform2f(loc, float(width), float(height))
        pcloc = gl.glGetUniformLocation(program, "u_passCount")
        if pcloc >= 0:
            gl.glUniform1f(pcloc, float(n_passes))
        ploc = gl.glGetUniformLocation(program, "u_pass")

        gl.glViewport(0, 0, width, height)
        gl.glDisable(gl.GL_BLEND)

        outputs = []
        for job in jobs:
            img = job.get("image")
            if img is not None:
                h, w, c = img.shape
                if c == 3:
                    upload = np.empty((h, w, 4), dtype=np.float32)
                    upload[:, :, :3] = img[::-1, :, :]
                    upload[:, :, 3] = 1.0
                else:
                    upload = np.ascontiguousarray(img[::-1, :, :], dtype=np.float32)
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)
                gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA32F, w, h, 0, gl.GL_RGBA, gl.GL_FLOAT, upload)

            for uname, val in job.get("uniforms", {}).items():
                uloc = gl.glGetUniformLocation(program, uname)
                if uloc < 0:
                    continue
                # A 3-tuple is a colour (vec3); anything else is a plain float.
                if isinstance(val, (tuple, list)):
                    gl.glUniform3f(uloc, float(val[0]), float(val[1]), float(val[2]))
                else:
                    gl.glUniform1f(uloc, float(val))

            if n_passes == 1:
                if ploc >= 0:
                    gl.glUniform1f(ploc, 0.0)
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)
                gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, fbo)
                gl.glClearColor(0, 0, 0, 0)
                gl.glClear(gl.GL_COLOR_BUFFER_BIT)
                gl.glDrawArrays(gl.GL_TRIANGLES, 0, 3)
                gl.glBindTexture(gl.GL_TEXTURE_2D, out_tex)
                data = gl.glGetTexImage(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA, gl.GL_FLOAT)
                out = np.frombuffer(data, dtype=np.float32).reshape(height, width, 4)
                outputs.append(out[::-1, :, :].copy())
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)
            else:
                for k in range(n_passes):
                    if ploc >= 0:
                        gl.glUniform1f(ploc, float(k))
                    gl.glActiveTexture(gl.GL_TEXTURE0)
                    src = in_tex if k == 0 else pp_tex[(k - 1) % 2]
                    gl.glBindTexture(gl.GL_TEXTURE_2D, src)
                    gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, pp_fbo[k % 2])
                    gl.glClearColor(0, 0, 0, 0)
                    gl.glClear(gl.GL_COLOR_BUFFER_BIT)
                    gl.glDrawArrays(gl.GL_TRIANGLES, 0, 3)
                final_tex = pp_tex[(n_passes - 1) % 2]
                gl.glBindTexture(gl.GL_TEXTURE_2D, final_tex)
                data = gl.glGetTexImage(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA, gl.GL_FLOAT)
                out = np.frombuffer(data, dtype=np.float32).reshape(height, width, 4)
                outputs.append(out[::-1, :, :].copy())
                gl.glActiveTexture(gl.GL_TEXTURE0)
                gl.glBindTexture(gl.GL_TEXTURE_2D, in_tex)

        return outputs
    finally:
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)
        gl.glUseProgram(0)
        if in_tex is not None:
            gl.glDeleteTextures(int(in_tex))
        if out_tex is not None:
            gl.glDeleteTextures(int(out_tex))
        for tex in extra_tex_ids:
            gl.glDeleteTextures(int(tex))
        for tex in pp_tex:
            gl.glDeleteTextures(int(tex))
        if fbo is not None:
            gl.glDeleteFramebuffers(1, [fbo])
        for f in pp_fbo:
            gl.glDeleteFramebuffers(1, [f])
        if program is not None:
            gl.glDeleteProgram(program)
