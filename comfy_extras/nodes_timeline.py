"""Timeline node — like the Compositor, but each input is a video clip with
its own start frame, length, fade in/out, and transform. Output is a single
composite video on a fixed-size canvas.

Wiring:  LoadVideo → GetVideoComponents → Timeline → CreateVideo → SaveVideo

Frames-of-a-clip are batches `[T, H, W, 3]`. The first connected clip sets
the canvas size (matching the Compositor convention).
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import time
import uuid
from fractions import Fraction

import numpy as np
import torch
from PIL import Image as PILImage
from typing_extensions import override

import folder_paths
from comfy_api.latest import ComfyExtension, Input, IO, InputImpl, Types
from comfy_extras._live_preview import save_live_preview
from comfy_extras.nodes_compositor import _BLEND_MODES, _blend, _fit_to_canvas, _transform


def _valid_effect_id(s: str) -> bool:
    return isinstance(s, str) and re.fullmatch(r"[a-z0-9]+", s) is not None

def _scene_defaults_dir() -> str:
    # comfy_extras/ -> repo root -> custom_nodes/sailor_bridge/scene_defaults
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "custom_nodes", "sailor_bridge", "scene_defaults"))

def _scene_thumbnails_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "custom_nodes", "sailor_bridge", "scene_thumbnails"))


# Maximum clip ports preallocated on the Timeline node. The frontend's
# dynamic-grow logic only renders "connected + 1 trailing empty" so the user
# sees a clean node until they wire more clips.
_MAX_CLIPS = 16

# Composite-time frame batches are float32 [T,H,W,3] — a 30s 4K source is
# ~70GB and kills the server. Refuse with a guided error instead.
_DECODE_BUDGET_BYTES = 8 * 1024**3


def _bounded_dims(w: int, h: int, max_dim: int | None) -> tuple[int, int]:
    """Output dimensions after downscaling so max(W, H) ≤ `max_dim`, aspect
    kept, never upscaled. Even dims keep every pixel format happy."""
    if max_dim is None or max(w, h) <= max_dim:
        return w, h
    scale = max_dim / max(w, h)
    return (max(2, int(w * scale) // 2 * 2),
            max(2, int(h * scale) // 2 * 2))


def _check_decode_budget(v, clip_name: str,
                         max_frames: int | None = None,
                         max_dim: int | None = None) -> None:
    """Estimate the decoded float32 [T,H,W,3] size from container metadata
    (VideoFromFile probes the container without decoding frames), bounded by
    what the timeline will actually decode: at most `max_frames` frames at the
    downscaled (`max_dim`) resolution. If metadata is unavailable, stay
    permissive — decode as before the guard.

    NOTE: trimmed sources (VideoFromFile with start_time/duration) fall back to
    a full-range get_components() decode of the trimmed window, and their
    get_frame_count() can under-report the trimmed range (known upstream bug,
    tracked separately) — the guard still refuses anything estimated over budget."""
    try:
        w, h = v.get_dimensions()
        frames = v.get_frame_count()
    except Exception:
        return
    if max_frames is not None:
        frames = min(frames, max_frames)
    bw, bh = _bounded_dims(w, h, max_dim)
    est_bytes = frames * bh * bw * 3 * 4
    if est_bytes > _DECODE_BUDGET_BYTES:
        est_gb = est_bytes / 1024**3
        budget_gb = _DECODE_BUDGET_BYTES / 1024**3
        raise ValueError(
            f"{clip_name}: video is too large to composite directly "
            f"(~{est_gb:.1f} GB of frames: {frames} frames at {bw}x{bh}; "
            f"budget {budget_gb:.0f} GB). "
            "Use a lower-resolution proxy, trim the source, or wire it through "
            "GetVideoComponents with a downscale before the Timeline.")


def spacetype_source_index(local_frame: int, baked_count: int, loop: bool, in_frame: int = 0) -> int:
    """Map a clip-local frame onto the baked Space Type cycle, honouring the
    clip's in-point the same way the browser does.

    The browser bakes ONE seamless cycle (k whole loops), not the whole clip,
    so a long clip tiles into a short bake. With loop off, hold the last frame
    — matching how a motion clip runs out.

    This is the Python twin of sourceT01() in
    frontend/app/lib/engine/spaceTypeClipRenderer.ts: both must map the same
    (in_frame, local_frame) pair to the same phase, or the export drifts from
    the live preview. Note the two are NOT parameter-for-parameter identical:
    this function takes a clip-local frame and applies in_frame itself (once,
    here); sourceT01's `sourceFrame` argument is expected pre-source-mapped by
    its caller (sourceFrameAt in the browser) and does not read clip.in_frame
    at all — folding it in here AND there was Critical 1's double-apply bug.
    `in_frame` defaults to 0 so existing bake-domain callers (which intentionally
    pass a trim-free view — see spaceTypeClipBake.ts's `{...clip, loop: true}`,
    which no longer needs to force in_frame:0 either, since sourceT01 doesn't
    read it) are unaffected. The golden test covers a frame pair one loop apart
    to catch drift."""
    if baked_count <= 0:
        return 0
    raw = in_frame + local_frame
    if loop:
        return raw % baked_count
    return max(0, min(raw, baked_count - 1))


def _source_frame_at(clip: dict, local_f: int) -> int:
    """Timeline→source frame mapping — the Python twin of
    frontend/shared/timeline/sourceFrame.ts (formulas pinned in types.ts):
        src = in_frame + floor(max(0, eff) * speed)
    where eff mirrors the local frame when reverse is set. The two files must
    change together — the golden gate enforces the pairing."""
    speed = float(clip.get("speed") or 1.0)
    in_frame = int(clip.get("in_frame", 0) or 0)
    length = max(1, int(clip.get("length", 1) or 1))
    eff = max(0, length - 1 - local_f) if clip.get("reverse") else local_f
    return in_frame + int(max(0.0, float(eff)) * speed)


def _max_source_frames(clip: dict) -> int:
    """Highest source index a clip can touch, +1 (a decode bound). Same for
    forward and reverse: both cover in_frame .. in_frame + floor((length-1)*speed)."""
    length = max(1, int(clip.get("length", 30) or 30))
    speed = float(clip.get("speed") or 1.0)
    in_frame = int(clip.get("in_frame", 0) or 0)
    return in_frame + int(max(0.0, (length - 1) * speed)) + 1


def _needed_source_frames(kwargs: dict, state: dict | None, port_idx: int) -> int | None:
    """How many leading source frames the timeline can possibly use from clip
    port `port_idx`. Edit-state clips index `_source_frame_at(...) % src_T`,
    so a clip needs the first `_max_source_frames` frames (wrap ⇒ everything,
    which the caller caps at the source frame count). Legacy widget path: the
    first `clip{i}_length` frames. None ⇒ unknown (decode everything under
    budget). Assumes in_frame ≥ 0."""
    if state is not None:
        needed = 0
        for track in state.get("tracks", []):
            for clip in track.get("clips", []):
                if clip.get("kind") == "workflow" and int(clip.get("port_index", -1) or -1) == port_idx:
                    # default must match _execute_edit_state's clip length default (30)
                    needed = max(needed, _max_source_frames(clip))
        return needed or None
    length = kwargs.get(f"clip{port_idx}_length")
    if length is None:
        return None
    return max(1, int(length))


def _transition_windows(state: dict) -> list[dict]:
    """EditState transitions[] → concrete frame windows. Twin of
    shared/timeline/transitions.ts::resolveTransitionWindows — formulas are
    pinned there (and by the 05-transitions golden fixture); change together.

    Window: d frames centered on the cut (pre = d//2 before, d-pre after),
    head clamped to the outgoing clip's start, tail clamped to the incoming
    clip's end. Stale transitions (clips missing / no longer adjacent) drop."""
    out = []
    tracks = {t.get("id"): t for t in state.get("tracks", [])}
    for tr in state.get("transitions", []) or []:
        track = tracks.get(tr.get("track_id"))
        if not track:
            continue
        clips = {c.get("id"): c for c in track.get("clips", [])}
        frm = clips.get(tr.get("from_clip_id"))
        to = clips.get(tr.get("to_clip_id"))
        if not frm or not to:
            continue
        cut = int(to.get("start_frame", 0))
        if int(frm.get("start_frame", 0)) + int(frm.get("length", 0)) != cut:
            continue
        d = max(1, int(round(float(tr.get("duration", 0) or 0))))
        pre = d // 2
        start_f = max(cut - pre, int(frm.get("start_frame", 0)))
        end_f = min(cut + (d - pre), cut + max(1, int(to.get("length", 0))))
        if end_f <= start_f:
            continue
        out.append({"kind": str(tr.get("kind", "crossfade")), "cut": cut,
                    "start_f": start_f, "end_f": end_f,
                    "from_id": frm.get("id"), "to_id": to.get("id")})
    return out


def _index_transition_windows(windows: list[dict]) -> dict:
    by_clip: dict = {}
    for w in windows or []:
        for cid in (w["from_id"], w["to_id"]):
            by_clip.setdefault(cid, []).append(w)
    return by_clip


def _transition_mod(by_clip: dict, clip_id, start: int, length: int, g: int,
                    naturally_visible: bool) -> dict:
    """Per-frame transition modulation — twin of transitions.ts::transitionModAt.
    Weight w = (g - start_f + 1) / (window_len + 1); incoming clip draws on top
    with the kind's modulation, outgoing keeps rendering with a clamped tail."""
    length = max(1, length)
    local_nat = max(0, min(g - start, length - 1))
    identity = {"visible": naturally_visible, "local": local_nat,
                "alpha_mul": 1.0, "dy": 0.0, "wipe": None, "draw_after": None}
    wins = by_clip.get(clip_id)
    if not wins:
        return identity
    for win in wins:
        if g < win["start_f"] or g >= win["end_f"]:
            continue
        w = (g - win["start_f"] + 1) / (win["end_f"] - win["start_f"] + 1)
        if clip_id == win["to_id"]:
            kind = win["kind"]
            return {
                "visible": True,
                "local": max(0, g - start),
                "alpha_mul": w if kind == "crossfade" else 1.0,
                "dy": (1.0 - w) if kind == "slide_up" else (-(1.0 - w) if kind == "slide_down" else 0.0),
                "wipe": ("left", w) if kind == "wipe_left" else (("right", w) if kind == "wipe_right" else None),
                "draw_after": win["from_id"],
            }
        return {"visible": True, "local": min(length - 1, g - start),
                "alpha_mul": 1.0, "dy": 0.0, "wipe": None, "draw_after": None}
    return identity


def _apply_wipe_np(alpha: "np.ndarray", wipe, W: int) -> "np.ndarray":
    """Zero the incoming layer's alpha outside the wipe reveal. Boundary at
    floor(w*W + 0.5) columns — matches the GL shader's pixel-center rule."""
    if not wipe:
        return alpha
    mode, w = wipe
    boundary = int(np.floor(w * W + 0.5))
    out = alpha.copy()
    if mode == "left":
        out[:, boundary:, :] = 0.0
    else:  # right: show x > 1-w → zero the leftmost W-boundary columns
        out[:, :W - boundary, :] = 0.0
    return out


def _order_for_transitions(items: list, get_id, windows: list[dict]) -> list:
    """Ensure each window's incoming item paints AFTER its outgoing partner,
    regardless of clip array order (twin of the compositor's post-pass)."""
    order = list(items)
    for win in windows or []:
        ids = [get_id(x) for x in order]
        try:
            i = ids.index(win["to_id"])
            p = ids.index(win["from_id"])
        except ValueError:
            continue
        if i < p:
            entry = order.pop(i)
            order.insert(p, entry)  # p shifted left by the pop → lands after partner
    return order


_FILTER_IDENTITY = {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0, "hue": 0.0, "temperature": 0.0}


def _filters_or_none(f) -> dict | None:
    """Normalize a ClipFilters dict; None when absent/identity."""
    if not isinstance(f, dict):
        return None
    vals = {k: float(f.get(k, d)) for k, d in _FILTER_IDENTITY.items()}
    if all(vals[k] == d for k, d in _FILTER_IDENTITY.items()):
        return None
    return vals


def _hue_rotate_matrix(rad: float) -> "np.ndarray":
    """SVG feColorMatrix hueRotate (luma consts 0.213/0.715/0.072) — twin of
    shared/timeline/filters.ts hueRotateMatrix. Row-major, applied to [r,g,b]."""
    c = float(np.cos(rad))
    s = float(np.sin(rad))
    return np.array([
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ], dtype=np.float32)


def _apply_filters_np(rgb: "np.ndarray", filters: dict | None) -> "np.ndarray":
    """Per-clip color adjust on an [..., 3] float32 sRGB array — the Python
    twin of shared/timeline/filters.ts applyFiltersRGB (order, clamps and
    constants pinned there; the 06-filters golden fixture gates parity)."""
    if not filters:
        return rgb
    out = rgb
    b = filters["brightness"]
    if b != 0.0:
        out = np.clip(out + b, 0.0, 1.0)
    k = filters["contrast"]
    if k != 1.0:
        out = np.clip((out - 0.5) * k + 0.5, 0.0, 1.0)
    s = filters["saturation"]
    if s != 1.0:
        luma = out[..., 0:1] * 0.2126 + out[..., 1:2] * 0.7152 + out[..., 2:3] * 0.0722
        out = np.clip(luma + (out - luma) * s, 0.0, 1.0)
    hue = filters["hue"]
    if hue != 0.0:
        m = _hue_rotate_matrix(float(np.deg2rad(hue)))
        out = np.clip(out @ m.T, 0.0, 1.0)
    t = filters["temperature"]
    if t != 0.0:
        out = out.copy()
        out[..., 0] = np.clip(out[..., 0] * (1.0 + 0.2 * t), 0.0, 1.0)
        out[..., 2] = np.clip(out[..., 2] * (1.0 - 0.2 * t), 0.0, 1.0)
    return out.astype(np.float32, copy=False)


def _apply_filters_torch(rgb, filters: dict | None):
    """Torch twin of _apply_filters_np for the graph composite path ([1,3,H,W])."""
    if not filters:
        return rgb
    out = rgb
    b = filters["brightness"]
    if b != 0.0:
        out = (out + b).clamp(0.0, 1.0)
    k = filters["contrast"]
    if k != 1.0:
        out = ((out - 0.5) * k + 0.5).clamp(0.0, 1.0)
    s = filters["saturation"]
    if s != 1.0:
        luma = out[:, 0:1] * 0.2126 + out[:, 1:2] * 0.7152 + out[:, 2:3] * 0.0722
        out = (luma + (out - luma) * s).clamp(0.0, 1.0)
    hue = filters["hue"]
    if hue != 0.0:
        m = torch.tensor(_hue_rotate_matrix(float(np.deg2rad(hue))), device=out.device, dtype=out.dtype)
        out = torch.einsum("ij,bjhw->bihw", m, out).clamp(0.0, 1.0)
    t = filters["temperature"]
    if t != 0.0:
        out = out.clone()
        out[:, 0] = (out[:, 0] * (1.0 + 0.2 * t)).clamp(0.0, 1.0)
        out[:, 2] = (out[:, 2] * (1.0 - 0.2 * t)).clamp(0.0, 1.0)
    return out


def _is_untrimmed_stream_source(video) -> bool:
    """Stream-decode only when the raw container equals what get_components()
    would return: the class overrides get_stream_source (the base impl ENCODES
    in-memory frames — lossy) AND no trim window is set. Trim offsets live in
    VideoFromFile's private fields; absent attributes mean untrimmed. Anything
    else falls back to the exact (trim-honoring) get_components path."""
    if not hasattr(video, "get_stream_source"):
        return False
    base_impl = getattr(Input.Video, "get_stream_source", None)
    if getattr(type(video), "get_stream_source", None) is base_impl:
        return False
    start = getattr(video, "_VideoFromFile__start_time", 0) or 0
    duration = getattr(video, "_VideoFromFile__duration", 0) or 0
    return start == 0 and duration == 0


def _decode_video_bounded(video, max_frames: int | None, max_dim: int | None):
    """Decode a VIDEO object to a float32 [T,H,W,3] tensor, reading at most
    `max_frames` frames and downscaling so max(H, W) ≤ `max_dim` (aspect kept,
    never upscaled). Streams via PyAV when the source exposes a file/stream
    (VideoFromFile.get_stream_source) AND is untrimmed — get_stream_source
    returns the RAW container, so trimmed sources must take the exact
    get_components() path or the untrimmed head would be composited; see
    `_is_untrimmed_stream_source`. In-memory videos (VideoFromComponents)
    are sliced instead."""
    import av

    src = video.get_stream_source() if _is_untrimmed_stream_source(video) else None
    if src is None:
        frames = video.get_components().images
        if max_frames is not None and frames.shape[0] > max_frames:
            frames = frames[:max_frames]
        return frames

    container = av.open(src, mode="r")
    try:
        stream = container.streams.video[0]
        w, h = stream.codec_context.width, stream.codec_context.height
        out_w, out_h = _bounded_dims(w, h, max_dim)
        arrs = []
        for frame in container.decode(stream):
            if out_w != w or out_h != h:
                frame = frame.reformat(width=out_w, height=out_h, format="rgb24")
                arr = frame.to_ndarray()
            else:
                arr = frame.to_ndarray(format="rgb24")
            arrs.append(arr)
            if max_frames is not None and len(arrs) >= max_frames:
                break
        if not arrs:
            raise ValueError("video source contained no decodable frames")
        return torch.from_numpy(np.stack(arrs).astype(np.float32) / 255.0)
    finally:
        container.close()


def _coerce_video_clips(kwargs: dict, state: dict | None = None) -> None:
    """Modern video nodes output VIDEO objects; the Timeline composites frame
    batches. Decode each VIDEO clip input to its frame tensor once, in place —
    both the legacy widget path and the edit-state path then see tensors. The
    decode is BOUNDED: only the frames the timeline references (per
    `_needed_source_frames`), downscaled toward the canvas on the edit-state
    path, with the budget guard applied to that bounded estimate. (Audio
    inside wired videos is dropped here — node-run audio is a later phase;
    the editor's audio tracks are unaffected.)"""
    # Edit-state path: canvas is fixed by the state → downscale big sources to
    # 2× the canvas's larger dimension (headroom for the scale widget, ≤3×,
    # at slight softness beyond 2×). Legacy path: canvas IS clip1's native
    # size — downscaling would change the output resolution, so bound frames only.
    max_dim = None
    if state is not None:
        canvas = state.get("canvas", {})
        max_dim = 2 * max(int(canvas.get("width", 1280) or 1280), int(canvas.get("height", 720) or 720))
    for i in range(1, _MAX_CLIPS + 1):
        v = kwargs.get(f"clip{i}")
        if v is None or isinstance(v, torch.Tensor) or not hasattr(v, "get_components"):
            continue
        needed = _needed_source_frames(kwargs, state, i)
        _check_decode_budget(v, f"clip{i}", max_frames=needed, max_dim=max_dim)
        kwargs[f"clip{i}"] = _decode_video_bounded(v, needed, max_dim)


def _frames_to_video(frames, fps) -> "InputImpl.VideoFromComponents":
    """Wrap rendered frames as a VIDEO object so SaveVideo/CreateVideo-style
    consumers connect directly (mirrors CreateVideo in nodes_video.py)."""
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(images=frames, audio=None, frame_rate=Fraction(fps)))


def _ease(t: float, ease) -> float:
    # Mirror of shared/timeline/interpolate.ts applyEase. Additive: linear and
    # easeInOut (smoothstep) unchanged; power2.in/out added for the lane presets.
    if ease == "power2.in":
        return t * t
    if ease == "power2.out":
        return 1.0 - (1.0 - t) * (1.0 - t)
    if ease == "easeInOut":
        return t * t * (3.0 - 2.0 * t)  # smoothstep (legacy)
    return t  # linear / unknown


def _interp_transform(static: dict, keyframes, local_frame: float) -> dict:
    """Python mirror of shared/timeline/interpolate.ts `interpolateClipAt`.

    `static` supplies x/y/rotation/scale/opacity fallbacks (the clip's static
    scalars). `keyframes` is an optional list of
    {frame, x, y, rotation, scale, opacity, ease}. With no keyframes we return
    the static transform; otherwise we lerp between the bracketing keyframes so
    the editor preview, FFmpeg export, and node run all agree.
    """
    base = {
        "x":        float(static.get("x", 0.0)),
        "y":        float(static.get("y", 0.0)),
        "rotation": float(static.get("rotation", 0.0)),
        "scale":    float(static.get("scale", 1.0)),
        "opacity":  float(static.get("opacity", 1.0)),
    }
    if not keyframes:
        return base

    def _snap(k: dict) -> dict:
        return {
            "x":        float(k.get("x", base["x"])),
            "y":        float(k.get("y", base["y"])),
            "rotation": float(k.get("rotation", base["rotation"])),
            "scale":    float(k.get("scale", base["scale"])),
            "opacity":  float(k.get("opacity", base["opacity"])),
        }

    kfs = sorted(keyframes, key=lambda k: k.get("frame", 0))
    if local_frame <= kfs[0].get("frame", 0):
        return _snap(kfs[0])
    last = kfs[-1]
    if local_frame >= last.get("frame", 0):
        return _snap(last)
    for i in range(len(kfs) - 1):
        a, b = kfs[i], kfs[i + 1]
        fa = a.get("frame", 0)
        fb = b.get("frame", 0)
        if fa <= local_frame <= fb:
            span = fb - fa
            t = _ease((local_frame - fa) / span, a.get("ease")) if span > 0 else 0.0
            sa, sb = _snap(a), _snap(b)
            return {k: sa[k] + (sb[k] - sa[k]) * t for k in sa}
    return _snap(last)


def _hex_rgb(s: str, fallback=(0.0, 0.0, 0.0)) -> tuple[float, float, float]:
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return fallback
    try:
        return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)
    except ValueError:
        return fallback


def _load_pil_image(path):
    """Open an image clip's source as RGB PIL. Resolves bare filenames under
    input/. Returns None if missing/unreadable."""
    if not path:
        return None
    if not os.path.isabs(path):
        path = os.path.join(folder_paths.get_input_directory(), path)
    if not os.path.exists(path):
        return None
    try:
        return PILImage.open(path).convert("RGB")
    except Exception:
        return None


def _pil_to_tensor(pil: "PILImage.Image", device, dtype) -> "torch.Tensor":
    """RGB PIL → [1, H, W, 3] float tensor in [0,1] on the target device/dtype."""
    arr = np.asarray(pil.convert("RGB"), dtype=np.float32) / 255.0  # [H, W, 3]
    return torch.from_numpy(arr).unsqueeze(0).to(device=device, dtype=dtype)


def _render_text_clip_pil(clip: dict, W: int, H: int):
    """Render a text clip's nested config to a PIL image (mirrors the FFmpeg
    export path). Returns None if the text renderer is unavailable."""
    try:
        from comfy_extras.nodes_text import render_text_to_pil
    except Exception:
        return None
    t = clip.get("text") or {}
    try:
        return render_text_to_pil(
            text=str(t.get("text", "")),
            width=int(t.get("width", W)),
            height=int(t.get("height", H)),
            font_size=int(t.get("font_size", 72)),
            color=str(t.get("color", "#ffffff")),
            bg_color=str(t.get("bg_color", "#000000")),
            align=str(t.get("align", "center")),
            v_align=str(t.get("v_align", "middle")),
            padding=float(t.get("padding", 0.06)),
            line_spacing=float(t.get("line_spacing", 1.2)),
        )
    except Exception:
        return None


def _clip_inputs(idx: int, optional: bool):
    """Per-clip input declarations. clip1 is required (defines canvas size)."""
    start_default = (idx - 1) * 12   # stagger clips by default so they don't overlap fully
    return [
        IO.MultiType.Input(
            IO.Image.Input(f"clip{idx}", optional=optional,
                           tooltip=f"Clip {idx}" + (" (sets canvas size)" if idx == 1 else "")),
            [IO.Video],
        ),
        IO.Int.Input(f"clip{idx}_start",    default=start_default, min=-1000, max=10000, step=1,
                    tooltip="When this clip begins on the global timeline, in frames."),
        IO.Int.Input(f"clip{idx}_length",   default=30, min=1, max=10000, step=1,
                    tooltip="How many frames of the timeline this clip occupies. Loops if longer than the source."),
        IO.Float.Input(f"clip{idx}_x",      default=0.0, min=-1.5, max=1.5, step=0.01),
        IO.Float.Input(f"clip{idx}_y",      default=0.0, min=-1.5, max=1.5, step=0.01),
        IO.Float.Input(f"clip{idx}_rotation", default=0.0, min=-180.0, max=180.0, step=1.0),
        IO.Float.Input(f"clip{idx}_scale",  default=1.0, min=0.1, max=3.0, step=0.05),
        IO.Float.Input(f"clip{idx}_opacity", default=1.0, min=0.0, max=1.0, step=0.01),
        IO.Combo.Input(f"clip{idx}_blend",  options=_BLEND_MODES, default="normal"),
        IO.Int.Input(f"clip{idx}_fade_in",  default=0, min=0, max=1000, step=1,
                    tooltip="Frames over which opacity ramps up at this clip's start."),
        IO.Int.Input(f"clip{idx}_fade_out", default=0, min=0, max=1000, step=1,
                    tooltip="Frames over which opacity ramps down at this clip's end."),
    ]


class TimelineNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = []
        for i in range(1, _MAX_CLIPS + 1):
            inputs.extend(_clip_inputs(i, optional=(i > 1)))
        # Audio file picker — lists audio files in input/ plus a blank entry
        # so the user can opt out. Used only by the FFmpeg-direct renderer.
        input_dir = folder_paths.get_input_directory()
        try:
            audio_files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
            audio_files = folder_paths.filter_files_content_types(audio_files, ["audio"])
        except Exception:
            audio_files = []
        audio_options = ["(none)"] + sorted(audio_files)

        inputs.extend([
            IO.Int.Input("total_duration", default=0, min=0, max=10000, step=1,
                        tooltip="Output length in frames. 0 = auto (max end across all clips)."),
            IO.Int.Input("output_fps", default=30, min=1, max=120, step=1,
                        tooltip="Frame rate used for time math (s ↔ frames) and rendering."),
            IO.String.Input("bg_color", default="#000000",
                           tooltip="Background color shown when no clip covers a frame."),
            IO.Combo.Input("audio_file", options=audio_options, default="(none)",
                          upload=IO.UploadType.audio,
                          tooltip="Optional soundtrack mixed in on Render."),
            IO.Int.Input("preview_frame", default=-1, min=-1, max=10000, step=1,
                        tooltip="Which frame to save for live preview. -1 = middle of timeline."),
            # Editor state (tracks, clips, keyframes) as a JSON string. The Vue
            # editor stores this on the node and the frontend injects it at
            # submit. When present it DRIVES the render (keyframed transforms,
            # multi-track order); when absent we fall back to the legacy flat
            # clip{i}_* widgets. Never shown on the node — the Timeline body
            # renders the editor button + preview, not the raw widget list.
            IO.String.Input("edit_state", default="", optional=True, multiline=True,
                           tooltip="Editor timeline state (auto-populated at submit)."),
        ])
        return IO.Schema(
            node_id="Timeline",
            display_name="Timeline",
            description="Composite multiple clips on a timeline with per-clip start, transform, opacity, blend, and fades.",
            category="video",
            inputs=inputs,
            outputs=[IO.Image.Output(display_name="frames"), IO.Video.Output(display_name="video")],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, **kwargs) -> IO.NodeOutput:
        # Prefer the editor's rich edit_state (tracks, clips, keyframes) when
        # the frontend injected it at submit. This is what makes node-run agree
        # with the editor preview and the FFmpeg export. Absent/blank → fall
        # back to the legacy flat clip{i}_* widget path below (back-compat for
        # graphs wired without the editor). Parsed BEFORE the video coercion so
        # the bounded decoder knows which source frames the state references
        # and how big the canvas is.
        state = None
        raw_state = kwargs.get("edit_state")
        if raw_state:
            try:
                state = json.loads(raw_state) if isinstance(raw_state, str) else raw_state
            except Exception:
                state = None
            if not _is_edit_state(state):
                state = None
        _coerce_video_clips(kwargs, state)
        if state is not None:
            return cls._execute_edit_state(kwargs, state)

        # Gather connected layers.
        layers = []
        for i in range(1, _MAX_CLIPS + 1):
            clip = kwargs.get(f"clip{i}")
            if clip is None:
                continue
            layers.append({
                "slot":      i,
                "clip":      clip,
                "start":     int(kwargs.get(f"clip{i}_start", 0)),
                "length":    int(kwargs.get(f"clip{i}_length", 30)),
                "x":         float(kwargs.get(f"clip{i}_x", 0.0)),
                "y":         float(kwargs.get(f"clip{i}_y", 0.0)),
                "rot":       float(kwargs.get(f"clip{i}_rotation", 0.0)),
                "scl":       float(kwargs.get(f"clip{i}_scale", 1.0)),
                "op":        float(kwargs.get(f"clip{i}_opacity", 1.0)),
                "blend":     str(kwargs.get(f"clip{i}_blend", "normal")),
                "fade_in":   int(kwargs.get(f"clip{i}_fade_in", 0)),
                "fade_out":  int(kwargs.get(f"clip{i}_fade_out", 0)),
            })

        if not layers:
            blank = torch.zeros(1, 16, 16, 3)
            return IO.NodeOutput(blank, _frames_to_video(blank, 30),
                                 ui=save_live_preview(blank, str(cls.hidden.unique_id)))

        # Canvas size = first connected clip's frame size.
        first = layers[0]["clip"]
        _, ch, cw, _ = first.shape
        device, dtype = first.device, first.dtype

        # Total duration.
        total = int(kwargs.get("total_duration", 0))
        if total <= 0:
            total = max(L["start"] + L["length"] for L in layers)
        total = max(1, total)

        # Initialize output canvas with background color.
        bg_rgb = _hex_rgb(str(kwargs.get("bg_color", "#000000")))
        bg = torch.tensor(bg_rgb, device=device, dtype=dtype).view(1, 1, 1, 3)
        output = bg.expand(total, ch, cw, 3).clone()  # [T, H, W, 3]

        # Per-layer × per-frame composition. Frame-by-frame keeps each
        # grid_sample call to a single image — avoids the MPS batched-grid
        # stall and keeps peak memory bounded.
        for L in layers:
            clip = L["clip"]
            clip_T = clip.shape[0]
            layer_T = max(1, L["length"])
            start = L["start"]
            gt_start = max(0, start)
            gt_end = min(total, start + layer_T)
            if gt_end <= gt_start:
                continue

            fi, fo = L["fade_in"], L["fade_out"]
            for gt in range(gt_start, gt_end):
                local_t = gt - start
                ct = local_t % clip_T

                src = clip[ct:ct + 1].permute(0, 3, 1, 2)
                src = _fit_to_canvas(src, ch, cw)
                rgb, alpha = _transform(src, L["x"], L["y"], L["rot"], L["scl"])

                fade_alpha = 1.0
                if fi > 0 and local_t < fi:
                    fade_alpha *= (local_t + 1) / fi
                if fo > 0 and local_t >= layer_T - fo:
                    fade_alpha *= max(0.0, (layer_T - local_t) / fo)

                a = (alpha * L["op"] * fade_alpha).clamp(0.0, 1.0)
                base = output[gt:gt + 1].permute(0, 3, 1, 2)
                blended = _blend(base, rgb, L["blend"])
                result = base * (1.0 - a) + blended * a
                output[gt] = result.permute(0, 2, 3, 1).squeeze(0)

        output = output.clamp(0.0, 1.0)

        # Save a single preview frame for the canvas in the modal / on the node.
        pf = int(kwargs.get("preview_frame", -1))
        if pf < 0 or pf >= total:
            pf = total // 2
        preview = output[pf:pf + 1]
        # legacy widget path has no fps; 30 matches the editor default
        return IO.NodeOutput(output, _frames_to_video(output, 30),
                             ui=save_live_preview(preview, str(cls.hidden.unique_id), unique=True))

    @classmethod
    def _execute_edit_state(cls, kwargs: dict, state: dict) -> IO.NodeOutput:
        """Render from the editor's EditState (any supported version, see `_is_edit_state`). Resolves each clip
        to a source tensor and composites frame-by-frame with keyframed
        transforms — the same math as the editor preview and FFmpeg export.

        Pixel sources by clip kind:
          • workflow → wired tensor at clip{port_index}
          • image    → file on disk (input/ or absolute path)
          • text     → rendered via nodes_text.render_text_to_pil
        Video/audio asset clips are export-path content (decode-from-disk),
        so they're skipped here; wire them through LoadVideo → port to use
        them on node-run.
        """
        canvas = state.get("canvas", {})
        fps = max(1, int(canvas.get("fps", 30)))
        cw = max(1, int(canvas.get("width", 1280)))
        ch = max(1, int(canvas.get("height", 720)))
        bg_rgb = _hex_rgb(str(canvas.get("bg_color", "#000000")))

        # Composite where the wired data lives (first wired clip's device/dtype);
        # disk/text sources get moved there. Default CPU float32.
        device, dtype = torch.device("cpu"), torch.float32
        for i in range(1, _MAX_CLIPS + 1):
            t = kwargs.get(f"clip{i}")
            if t is not None:
                device, dtype = t.device, t.dtype
                break

        # Resolve renderable clips to source tensors. Track order = paint order
        # (later tracks on top), matching the preview/export.
        layers: list[dict] = []
        skipped = 0
        for track in state.get("tracks", []):
            if track.get("muted") or track.get("kind") == "audio":
                continue
            for clip in track.get("clips", []):
                kind = clip.get("kind")
                src = None
                if kind == "workflow":
                    t = kwargs.get(f"clip{int(clip.get('port_index', 0) or 0)}")
                    if t is not None:
                        src = t.to(device=device, dtype=dtype)
                elif kind == "image":
                    pil = _load_pil_image(clip.get("path") or clip.get("asset_path"))
                    if pil is not None:
                        src = _pil_to_tensor(pil, device, dtype)
                elif kind == "text":
                    pil = _render_text_clip_pil(clip, cw, ch)
                    if pil is not None:
                        src = _pil_to_tensor(pil, device, dtype)
                # else: video/audio asset → export-path only.
                if src is None:
                    skipped += 1
                    continue
                layers.append({
                    "id":        clip.get("id"),
                    "src":       src,
                    "start":     int(clip.get("start_frame", 0)),
                    "length":    max(1, int(clip.get("length", 30))),
                    "in_frame":  int(clip.get("in_frame", 0)),
                    "speed":     float(clip.get("speed") or 1.0),
                    "reverse":   bool(clip.get("reverse")),
                    "filters":   _filters_or_none(clip.get("filters")),
                    "blend":     str(clip.get("blend", "normal")),
                    "fade_in":   int(clip.get("fade_in", 0)),
                    "fade_out":  int(clip.get("fade_out", 0)),
                    "static":    {
                        "x": float(clip.get("x", 0.0)), "y": float(clip.get("y", 0.0)),
                        "rotation": float(clip.get("rotation", 0.0)),
                        "scale": float(clip.get("scale", 1.0)),
                        "opacity": float(clip.get("opacity", 1.0)),
                    },
                    "keyframes": clip.get("keyframes"),
                })

        total = int(state.get("total_frames", 0) or 0)
        if total <= 0:
            total = max((L["start"] + L["length"] for L in layers), default=1)
        total = max(1, total)

        bg = torch.tensor(bg_rgb, device=device, dtype=dtype).view(1, 1, 1, 3)
        output = bg.expand(total, ch, cw, 3).clone()  # [T, H, W, 3]

        # Junction transitions: same shared window/mod math as the export path.
        tr_windows = _transition_windows(state)
        tr_by_clip = _index_transition_windows(tr_windows)
        layers = _order_for_transitions(layers, lambda l: l.get("id"), tr_windows)

        for L in layers:
            src = L["src"]
            src_T = max(1, src.shape[0])
            length, start = L["length"], L["start"]
            # Transition windows extend visibility beyond the clip's own range.
            lo, hi = start, start + length
            for win in tr_by_clip.get(L.get("id"), []):
                if L.get("id") == win["from_id"]:
                    hi = max(hi, win["end_f"])
                else:
                    lo = min(lo, win["start_f"])
            gt_start = max(0, lo)
            gt_end = min(total, hi)
            if gt_end <= gt_start:
                continue
            fi, fo = L["fade_in"], L["fade_out"]
            for gt in range(gt_start, gt_end):
                naturally_visible = start <= gt < start + length
                mod = _transition_mod(tr_by_clip, L.get("id"), start, length, gt, naturally_visible)
                if not mod["visible"]:
                    continue
                local_t = mod["local"]
                ct = _source_frame_at(L, local_t) % src_T

                tf = _interp_transform(L["static"], L["keyframes"], local_t)

                frame = src[ct:ct + 1].permute(0, 3, 1, 2)
                frame = _fit_to_canvas(frame, ch, cw)
                rgb, alpha = _transform(frame, tf["x"], tf["y"] + mod["dy"], tf["rotation"], tf["scale"])
                rgb = _apply_filters_torch(rgb, L.get("filters"))
                if mod["wipe"]:
                    mode, w = mod["wipe"]
                    boundary = int(np.floor(w * cw + 0.5))
                    alpha = alpha.clone()
                    if mode == "left":
                        alpha[..., boundary:] = 0.0
                    else:
                        alpha[..., :cw - boundary] = 0.0

                # Fade math matches the editor preview + FFmpeg export exactly
                # (not the legacy clip{i}_* path's off-by-one), so all three
                # render the same ramp.
                fade = 1.0
                if fi > 0 and local_t < fi:
                    fade *= local_t / fi
                if fo > 0 and local_t > length - fo:
                    fade *= (length - local_t) / fo
                fade = max(0.0, min(1.0, fade))

                a = (alpha * tf["opacity"] * fade * mod["alpha_mul"]).clamp(0.0, 1.0)
                base = output[gt:gt + 1].permute(0, 3, 1, 2)
                blended = _blend(base, rgb, L["blend"])
                result = base * (1.0 - a) + blended * a
                output[gt] = result.permute(0, 2, 3, 1).squeeze(0)

        output = output.clamp(0.0, 1.0)
        pf = total // 2
        return IO.NodeOutput(output, _frames_to_video(output, fps),
                             ui=save_live_preview(output[pf:pf + 1], str(cls.hidden.unique_id), unique=True))


# ---------------------------------------------------------------------------
# FFmpeg-direct render endpoint
#
# The Comfy graph path (LoadVideoFrames → Timeline → SaveVideo) decodes every
# source clip into a torch tensor batch up front — fine for graph composability,
# but wasteful when the user just wants to export their edit. This endpoint
# accepts the same edit state and renders it via PyAV (FFmpeg under the hood),
# streaming one composited frame at a time. No frame-tensor batch lives in RAM.
# Supports video AND image sources, plus optional audio mux.
# ---------------------------------------------------------------------------


def _blend_np(base: np.ndarray, top: np.ndarray, mode: str) -> np.ndarray:
    """Element-wise blend in float32 [0,1]. base/top: [H,W,3]."""
    a, b = base, top
    if mode == "normal":     return b
    if mode == "multiply":   return a * b
    if mode == "screen":     return 1.0 - (1.0 - a) * (1.0 - b)
    if mode == "overlay":    return np.where(a < 0.5, 2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b))
    if mode == "soft_light": return (1.0 - 2.0 * b) * a * a + 2.0 * b * a
    if mode == "hard_light": return np.where(b < 0.5, 2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b))
    if mode == "difference": return np.abs(a - b)
    if mode == "lighten":    return np.maximum(a, b)
    if mode == "darken":     return np.minimum(a, b)
    if mode == "add":        return np.clip(a + b, 0.0, 1.0)
    return b


def _hex_rgb_safe(s, fallback=(0.0, 0.0, 0.0)):
    return _hex_rgb(str(s or ""), fallback)


def _transform_and_alpha(src_pil: "PILImage.Image", canvas_w: int, canvas_h: int,
                        x: float, y: float, rotation: float, scale: float,
                        preserve_alpha: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Aspect-fit + translate + rotate + scale a source PIL image to a
    canvas-sized RGBA buffer. Returns (rgb [H,W,3] float32, alpha [H,W,1] float32)."""
    sw, sh = src_pil.size
    if sw == 0 or sh == 0:
        return np.zeros((canvas_h, canvas_w, 3), dtype=np.float32), np.zeros((canvas_h, canvas_w, 1), dtype=np.float32)
    # Aspect-fit inside canvas (matches backend `_fit_to_canvas`).
    cAspect = canvas_w / canvas_h
    sAspect = sw / sh
    if sAspect > cAspect:
        fit_w = canvas_w
        fit_h = max(1, int(round(canvas_w / sAspect)))
    else:
        fit_h = canvas_h
        fit_w = max(1, int(round(canvas_h * sAspect)))
    # preserve_alpha: keep the source's per-pixel alpha (baked overlays). Default:
    # flatten to RGB then opaque RGBA (correct for photo/video clips that fill
    # their fitted rect). The later `.convert("RGBA")` is a no-op if already RGBA.
    fitted = src_pil.convert("RGBA" if preserve_alpha else "RGB").resize((fit_w, fit_h), PILImage.BILINEAR)
    # Scale
    s = max(0.01, float(scale))
    if s != 1.0:
        fitted = fitted.resize(
            (max(1, int(round(fit_w * s))), max(1, int(round(fit_h * s)))),
            PILImage.BILINEAR,
        )
    # Rotate (with expand to avoid clipping during rotation). Rotate in RGBA so
    # the expanded corners are TRANSPARENT — rotating in RGB fills them opaque
    # black, which then composites as a black bounding box around the layer
    # (the bug that made rotated clips export with black boxes; the editor
    # preview never had it, and the WebGL engine's parity gate caught it).
    rgba = fitted.convert("RGBA")
    if rotation != 0.0:
        rgba = rgba.rotate(-float(rotation), resample=PILImage.BILINEAR, expand=True)
    fw, fh = rgba.size

    # Paste fitted on a transparent RGBA canvas at center + offset.
    canvas = PILImage.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    cx = canvas_w // 2 + int(round(float(x) * canvas_w)) - fw // 2
    cy = canvas_h // 2 + int(round(float(y) * canvas_h)) - fh // 2
    canvas.paste(rgba, (cx, cy), rgba)
    rgba_np = np.asarray(canvas, dtype=np.float32) / 255.0
    return rgba_np[..., :3], rgba_np[..., 3:4]


def _decoded_frame_at(av_container, video_stream, target_sec: float):
    """Decode the source frame closest to `target_sec`. Caller manages container lifetime."""
    import av
    tb = video_stream.time_base
    target_pts = int(target_sec / tb)
    av_container.seek(max(0, target_pts), stream=video_stream, any_frame=False, backward=True)
    last = None
    for frame in av_container.decode(video_stream):
        if frame.pts is None:
            last = frame
            continue
        last = frame
        if frame.pts >= target_pts:
            break
    return last


_EDIT_STATE_VERSIONS = (1, 2)


def _is_edit_state(state) -> bool:
    """True when `state` is the editor's EditState (shared/timeline/types.ts),
    any supported version. v2 adds transitions[], per-clip speed/reverse/filters,
    captions, mattes — fields this renderer doesn't draw yet (Phase 2+); it must
    still accept v2 and render the parts it knows."""
    return (
        isinstance(state, dict)
        and state.get("version") in _EDIT_STATE_VERSIONS
        and isinstance(state.get("tracks"), list)
    )


def _adapt_edit_state(state: dict) -> dict:
    """If `state` is an EditState (any supported version, see `_is_edit_state`)
    with tracks[], flatten it into the legacy `{fps, canvas_*, clips: [...]}`
    shape that render_timeline_to_file expects. Pass-through anything else.

    Audio clips are extracted: the first audio clip becomes `audio_path` for
    compatibility with the existing single-track audio mux. Multi-track audio
    mixing is a future improvement.
    """
    if not _is_edit_state(state):
        return state

    canvas = state.get("canvas", {})
    out = {
        "fps":           int(canvas.get("fps", 30)),
        "canvas_width":  int(canvas.get("width", 1280)),
        "canvas_height": int(canvas.get("height", 720)),
        "bg_color":      canvas.get("bg_color", "#000000"),
        "total_frames":  int(state.get("total_frames", 0)),
        "output_basename": state.get("output_basename") or "timeline",
        "clips":         [],
    }

    audio_path = state.get("audio_path")
    audio_speed = 1.0
    audio_reverse = False
    for track in state.get("tracks", []):
        if track.get("muted"):
            continue
        for clip in track.get("clips", []):
            kind = clip.get("kind")
            if kind == "workflow":
                # WorkflowClip pixels come from graph ports — only the
                # in-graph execute() path can render them. Skip for the
                # FFmpeg render.
                continue
            if kind == "audio":
                if not audio_path:
                    audio_path = clip.get("path") or clip.get("asset_path")
                    audio_speed = float(clip.get("speed") or 1.0)
                    audio_reverse = bool(clip.get("reverse"))
                continue
            if kind == "caption":
                # v2 captions have no export rendering yet (Phase 3 adds it).
                continue
            out["clips"].append({
                "id":          clip.get("id"),
                "kind":        kind,
                "path":        clip.get("path") or clip.get("asset_path"),
                "start_frame": int(clip.get("start_frame", 0)),
                "length":      int(clip.get("length", 30)),
                "in_frame":    int(clip.get("in_frame", 0)),
                "speed":       float(clip.get("speed") or 1.0),
                "reverse":     bool(clip.get("reverse")),
                "filters":     clip.get("filters"),
                "x":           float(clip.get("x", 0)),
                "y":           float(clip.get("y", 0)),
                "rotation":    float(clip.get("rotation", 0)),
                "scale":       float(clip.get("scale", 1)),
                "opacity":     float(clip.get("opacity", 1)),
                "blend":       str(clip.get("blend", "normal")),
                "fade_in":     int(clip.get("fade_in", 0)),
                "fade_out":    int(clip.get("fade_out", 0)),
                "text":        clip.get("text"),
                "keyframes":   clip.get("keyframes"),
                "motion_frames": clip.get("motion_frames"),
                "spacetype_frames": clip.get("spacetype_frames"),
                "spacetype_loop": clip.get("spacetype_loop", True),
            })

    if audio_path:
        out["audio_path"] = audio_path
        if audio_speed != 1.0:
            out["audio_speed"] = audio_speed
        if audio_reverse:
            out["audio_reverse"] = True

    # Junction transitions: resolve to concrete windows while the track
    # structure is still available, and order the flat clips so each window's
    # incoming clip composites after its outgoing partner.
    windows = _transition_windows(state)
    if windows:
        out["transition_windows"] = windows
        out["clips"] = _order_for_transitions(out["clips"], lambda c: c.get("id"), windows)
    return out


def _prepare_render_clips(state: dict) -> list[dict]:
    """Open per-clip decoders / pre-load images / pre-render text for
    render_frame_np. The caller owns the returned containers — close with
    _close_render_clips()."""
    import av

    W = int(state.get("canvas_width", 1280))
    H = int(state.get("canvas_height", 720))
    clips: list[dict] = []
    for c in state.get("clips", []):
        kind = str(c.get("kind") or ("image" if c.get("is_image") else "video"))
        entry = {
            "id":       c.get("id"),
            "kind":     kind,
            "start":    int(c.get("start_frame", 0)),
            "length":   int(c.get("length", 30)),
            "in_frame": int(c.get("in_frame", 0)),
            "speed":    float(c.get("speed") or 1.0),
            "reverse":  bool(c.get("reverse")),
            "filters":  _filters_or_none(c.get("filters")),
            "x":        float(c.get("x", 0)),
            "y":        float(c.get("y", 0)),
            "rot":      float(c.get("rotation", 0)),
            "scl":      float(c.get("scale", 1)),
            "op":       float(c.get("opacity", 1)),
            "blend":    str(c.get("blend", "normal")),
            "fade_in":  int(c.get("fade_in", 0)),
            "fade_out": int(c.get("fade_out", 0)),
            "keyframes": c.get("keyframes"),
        }
        if kind == "text":
            # Text clips have no file backing — pre-render once into a PIL image.
            from comfy_extras.nodes_text import render_text_to_pil
            t = c.get("text") or {}
            entry["pil"] = render_text_to_pil(
                text=str(t.get("text", "")),
                width=int(t.get("width", W)),
                height=int(t.get("height", H)),
                font_size=int(t.get("font_size", 72)),
                color=str(t.get("color", "#ffffff")),
                bg_color=str(t.get("bg_color", "#000000")),
                align=str(t.get("align", "center")),
                v_align=str(t.get("v_align", "middle")),
                padding=float(t.get("padding", 0.06)),
                line_spacing=float(t.get("line_spacing", 1.2)),
            )
            entry["duration"] = None
            clips.append(entry)
            continue

        if kind == "spacetype":
            # Baked alpha PNG sequence from the browser's three.js engine — but
            # unlike motion, only ONE seamless cycle is baked (k whole loops),
            # not the whole clip, so a 6s loop on a 60s clip is 180 files rather
            # than 1800. render_frame_np tiles it via spacetype_source_index.
            frames = c.get("spacetype_frames") or []
            resolved = []
            for fn in frames:
                p = fn if os.path.isabs(fn) else os.path.join(folder_paths.get_input_directory(), fn)
                if os.path.exists(p):
                    resolved.append(p)
            if not resolved:
                logging.warning(
                    "timeline: spacetype clip @frame %s has no baked frames (stale/un-baked) — skipping",
                    c.get("start_frame", "?"),
                )
                continue
            if len(resolved) < len(frames):
                logging.warning(
                    "timeline: spacetype clip @frame %s baked %d/%d frames — the cycle will tile short",
                    c.get("start_frame", "?"), len(resolved), len(frames),
                )
            entry["frame_paths"] = resolved
            entry["spacetype_loop"] = bool(c.get("spacetype_loop", True))
            entry["duration"] = None
            clips.append(entry)
            continue

        if kind == "motion":
            # Baked alpha PNG sequence (one file per clip-local frame). Resolve
            # filenames against input/ like other clip paths; skip (warn) if the
            # bake is missing/stale so a kinetic clip never silently crashes.
            frames = c.get("motion_frames") or []
            resolved = []
            for fn in frames:
                p = fn if os.path.isabs(fn) else os.path.join(folder_paths.get_input_directory(), fn)
                if os.path.exists(p):
                    resolved.append(p)
            if not resolved:
                logging.warning("timeline: motion clip @frame %s has no baked frames (stale/un-baked) — skipping", c.get("start_frame", "?"))
                continue
            if len(resolved) < len(frames):
                logging.warning("timeline: motion clip @frame %s baked %d/%d frames — missing frames will repeat the last available", c.get("start_frame", "?"), len(resolved), len(frames))
            entry["frame_paths"] = resolved
            entry["duration"] = None
            clips.append(entry)
            continue

        path = c.get("path")
        # The export payload carries bare filenames ("filenames, not URLs" —
        # the editor's export contract), so resolve them against input/ exactly
        # as the spacetype/motion bake paths above do. Without this, video and
        # image clips added from the media rail silently vanished from exports
        # while the browser preview composited them correctly.
        if path and not os.path.isabs(path):
            cand = os.path.join(folder_paths.get_input_directory(), path)
            if os.path.exists(cand):
                path = cand
        if not path or not os.path.exists(path):
            logging.warning(
                "timeline: %s clip @frame %s source missing (%s) — skipping",
                kind, c.get("start_frame", "?"), path,
            )
            continue
        if kind == "image":
            entry["pil"] = PILImage.open(path).convert("RGB")
            entry["duration"] = None
        else:  # video
            container = av.open(path, mode="r")
            vs = container.streams.video[0]
            entry["container"] = container
            entry["stream"] = vs
            entry["duration"] = float(vs.duration * vs.time_base) if vs.duration else None
        clips.append(entry)
    return clips


def _close_render_clips(clips: list[dict]) -> None:
    for L in clips:
        if "container" in L:
            try:
                L["container"].close()
            except Exception:
                pass


def render_frame_np(state: dict, clips: list[dict], f: int) -> np.ndarray:
    """Composite output frame `f` of the flat timeline `state` (the
    render_timeline_to_file shape) over its bg color. Returns float32 [H,W,3]
    in [0,1]. Single source of export-path pixel math: the FFmpeg export loop,
    the golden-frame harness, and /sailor/timeline/render_frame all call
    this — divergence between them is impossible by construction."""
    fps = int(state.get("fps", 30))
    W = int(state.get("canvas_width", 1280))
    H = int(state.get("canvas_height", 720))
    bg_rgb = _hex_rgb_safe(state.get("bg_color"), (0.0, 0.0, 0.0))
    bg = np.array(bg_rgb, dtype=np.float32).reshape(1, 1, 3)
    canvas = np.broadcast_to(bg, (H, W, 3)).copy()
    tw_by_clip = _index_transition_windows(state.get("transition_windows") or [])

    for L in clips:
        start, length = L["start"], max(1, L["length"])
        naturally_visible = start <= f < start + length
        mod = _transition_mod(tw_by_clip, L.get("id"), start, length, f, naturally_visible)
        if not mod["visible"]:
            continue
        local_f = mod["local"]

        # Fade alpha
        fade = 1.0
        if L["fade_in"] > 0 and local_f < L["fade_in"]:
            fade *= local_f / L["fade_in"]
        if L["fade_out"] > 0 and local_f > length - L["fade_out"]:
            fade *= (length - local_f) / L["fade_out"]
        fade = max(0.0, min(1.0, fade))

        # Get source PIL for this frame.
        if L["kind"] in ("image", "text"):
            src_pil = L["pil"]
        elif L["kind"] == "motion":
            fp = L["frame_paths"]
            idx = local_f if local_f < len(fp) else len(fp) - 1
            with PILImage.open(fp[idx]) as _mf:
                src_pil = _mf.convert("RGBA")  # forces decode + releases the fd; alpha preserved below
        elif L["kind"] == "spacetype":
            fp = L["frame_paths"]
            idx = spacetype_source_index(local_f, len(fp), L.get("spacetype_loop", True), in_frame=L.get("in_frame", 0))
            with PILImage.open(fp[idx]) as _sf:
                src_pil = _sf.convert("RGBA")  # alpha preserved below, same as motion
        else:  # video
            vs = L["stream"]
            container = L["container"]
            # speed/reverse-aware source frame (twin of the WebGL compositor).
            src_sec = _source_frame_at(L, local_f) / fps
            clip_dur = L.get("duration")
            if clip_dur is not None and clip_dur > 0:
                src_sec = src_sec % clip_dur
            try:
                frame = _decoded_frame_at(container, vs, src_sec)
            except Exception:
                frame = None
            if frame is None:
                continue
            src_pil = PILImage.fromarray(frame.to_ndarray(format="rgb24"))

        # Keyframed transform at this clip-local frame (static if none).
        static = {"x": L["x"], "y": L["y"], "rotation": L["rot"], "scale": L["scl"], "opacity": L["op"]}
        tf = _interp_transform(static, L.get("keyframes"), local_f)
        rgb, alpha = _transform_and_alpha(
            src_pil, W, H, tf["x"], tf["y"] + mod["dy"], tf["rotation"], tf["scale"],
            # motion AND spacetype bakes are transparent RGBA PNG sequences —
            # both load with `.convert("RGBA")  # alpha preserved below` above.
            # spacetype was missing here, so its transparent pixels flattened
            # to opaque black and buried every layer beneath the title.
            preserve_alpha=(L["kind"] in ("motion", "spacetype")),
        )
        rgb = _apply_filters_np(rgb, L.get("filters"))
        alpha = _apply_wipe_np(alpha, mod["wipe"], W)
        a = alpha * tf["opacity"] * fade * mod["alpha_mul"]
        blended = _blend_np(canvas, rgb, L["blend"])
        canvas = canvas * (1.0 - a) + blended * a

    return np.clip(canvas, 0.0, 1.0)


def _atempo_factors(speed: float) -> list[float]:
    """Split a tempo factor into a chain of factors each within atempo's
    supported [0.5, 2.0] range (e.g. 4.0 → [2.0, 2.0]; 0.2 → [0.5, 0.4])."""
    s = max(0.1, min(5.0, float(speed)))
    out: list[float] = []
    while s > 2.0:
        out.append(2.0)
        s /= 2.0
    while s < 0.5:
        out.append(0.5)
        s /= 0.5
    if abs(s - 1.0) > 1e-6:
        out.append(round(s, 6))
    return out


def _build_audio_filter_graph(in_stream, speed: float, reverse: bool):
    """abuffer → [areverse] → atempo chain → abuffersink. Returns the
    configured Graph — drive it with graph.push()/graph.pull() ONLY (the
    per-node context push segfaults in PyAV 17). areverse buffers the whole
    stream before emitting — acceptable for timeline-length audio; the caller
    falls back to unfiltered on failure."""
    import av
    graph = av.filter.Graph()
    src = graph.add_abuffer(template=in_stream)
    node = src
    if reverse:
        rev = graph.add("areverse")
        node.link_to(rev)
        node = rev
    for f in _atempo_factors(speed):
        t = graph.add("atempo", str(f))
        node.link_to(t)
        node = t
    sink = graph.add("abuffersink")
    node.link_to(sink)
    graph.configure()
    return graph


# BT.709 limited-range color signaling for every exported video ----------------
#
# Our source pixels are full-range sRGB (the same array the PNG export writes).
# Left alone, PyAV/libswscale converts RGB->YUV with the BT.601 matrix and
# writes *no* color tags. Color-managed players (QuickTime, Finder, Photos)
# then see an untagged HD stream, assume BT.709, and decode with a mismatched
# matrix — which desaturates the picture, so the video looks washed out next to
# the identical-pixel PNG. Tagging BT.709 makes the conversion matrix and the
# container's signaling agree, so the video matches what's on screen.
#
# Integer values are FFmpeg's AVCOL_* enums: color_range 1 = MPEG/limited;
# colorspace (matrix) / color_primaries / color_trc 1 = BT.709.
_BT709_RANGE = 1
_BT709 = 1


def _apply_bt709(codec_context) -> None:
    codec_context.color_range = _BT709_RANGE
    codec_context.colorspace = _BT709
    codec_context.color_primaries = _BT709
    codec_context.color_trc = _BT709


def _tag_frame_bt709(frame):
    frame.color_range = _BT709_RANGE
    frame.colorspace = _BT709
    frame.color_primaries = _BT709
    frame.color_trc = _BT709
    return frame


def render_timeline_to_file(state: dict, output_dir: str, progress=None) -> dict:
    """Render the edit `state` to a video file in `output_dir`. Returns metadata.

    `state` shape:
      {
        "fps": 30,
        "total_frames": 120,
        "canvas_width": 1280, "canvas_height": 720,
        "bg_color": "#000000",
        "output_basename": "timeline",  # optional
        "audio_path": "/abs/path.mp3",  # optional
        "clips": [
          { "path": "/abs/path.mp4", "is_image": false,
            "start_frame": 0, "length": 60,
            "x": 0, "y": 0, "rotation": 0, "scale": 1,
            "opacity": 1, "blend": "normal",
            "fade_in": 0, "fade_out": 0 },
          ...
        ]
      }
    """
    import av

    fps = int(state.get("fps", 30))
    total_frames = int(state.get("total_frames", 0))
    if total_frames <= 0:
        total_frames = max((int(c.get("start_frame", 0)) + int(c.get("length", 0)) for c in state.get("clips", [])), default=1)
    total_frames = max(1, total_frames)
    W = int(state.get("canvas_width", 1280))
    H = int(state.get("canvas_height", 720))

    # Build a sane output filename in output_dir.
    base = (str(state.get("output_basename") or "timeline") + "_").rstrip(".")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_name = f"{base}{stamp}.mp4"
    out_path = os.path.join(output_dir, out_name)
    os.makedirs(output_dir, exist_ok=True)

    # Open per-clip containers / pre-load images / pre-render text. Containers
    # are lazy decoders so we can seek per output frame.
    clips = _prepare_render_clips(state)

    # Output container + video stream.
    out = av.open(out_path, mode="w")
    out_stream = out.add_stream("h264", rate=Fraction(fps, 1))
    out_stream.width = W
    out_stream.height = H
    out_stream.pix_fmt = "yuv420p"
    # Reasonable defaults; user can re-encode externally if they want more control.
    out_stream.options = {"preset": "veryfast", "crf": "20"}
    _apply_bt709(out_stream.codec_context)

    # Audio: if provided, copy/transcode from source while we render video.
    audio_in_container = None
    audio_in_stream = None
    audio_out_stream = None
    resampler = None
    audio_path = state.get("audio_path")
    if audio_path and os.path.exists(audio_path):
        try:
            audio_in_container = av.open(audio_path, mode="r")
            audio_in_stream = audio_in_container.streams.audio[0]
            audio_out_stream = out.add_stream("aac", rate=audio_in_stream.rate)
            audio_out_stream.layout = "stereo"
        except Exception:
            audio_in_container = None
            audio_in_stream = None
            audio_out_stream = None

    # Frame-by-frame composite + encode.
    for f in range(total_frames):
        # .round() matches the golden CLI and /timeline/render_frame exactly —
        # truncation here would put exported video ±1 off every other surface.
        out_frame_arr = (render_frame_np(state, clips, f) * 255.0).round().astype(np.uint8)
        av_frame = av.VideoFrame.from_ndarray(out_frame_arr, format="rgb24")
        _tag_frame_bt709(av_frame)
        for packet in out_stream.encode(av_frame):
            out.mux(packet)

        if progress is not None:
            try:
                progress(f + 1, total_frames)
            except Exception:
                pass

    # Flush encoder.
    for packet in out_stream.encode():
        out.mux(packet)

    # Mux audio (length-clamped to the video duration). When the muxed audio
    # clip carries speed/reverse, run frames through an FFmpeg filter graph
    # (areverse + chained atempo); any filter failure falls back to the
    # unfiltered mux — audio must never fail the render.
    if audio_in_container is not None and audio_out_stream is not None:
        try:
            target_dur = total_frames / float(fps)
            speed = float(state.get("audio_speed") or 1.0)
            reverse = bool(state.get("audio_reverse"))
            graph = None
            if speed != 1.0 or reverse:
                try:
                    graph = _build_audio_filter_graph(audio_in_stream, speed, reverse)
                except Exception:
                    logging.warning("timeline: audio filter graph (speed=%s reverse=%s) failed — muxing unfiltered",
                                    speed, reverse, exc_info=True)
                    graph = None

            rate = int(audio_in_stream.rate or 44100)
            encoded_sec = 0.0

            def _encode_audio(frame) -> bool:
                """Encode one frame; False once the video duration is filled."""
                nonlocal encoded_sec
                if encoded_sec > target_dur:
                    return False
                encoded_sec += frame.samples / float(frame.sample_rate or rate)
                frame.pts = None
                for packet in audio_out_stream.encode(frame):
                    out.mux(packet)
                return True

            def _drain(g) -> bool:
                """Pull every ready frame from the graph sink. False = clamp hit."""
                while True:
                    try:
                        f = g.pull()
                    except (BlockingIOError, EOFError):  # need more input / flushed
                        return True
                    if not _encode_audio(f):
                        return False

            if graph is None:
                for frame in audio_in_container.decode(audio_in_stream):
                    if not _encode_audio(frame):
                        break
            else:
                clamped = False
                for frame in audio_in_container.decode(audio_in_stream):
                    graph.push(frame)
                    if not _drain(graph):
                        clamped = True
                        break
                if not clamped:
                    graph.push(None)  # EOF — areverse emits its buffer here
                    _drain(graph)
            for packet in audio_out_stream.encode():
                out.mux(packet)
        except Exception:
            pass

    # Close inputs + output.
    _close_render_clips(clips)
    if audio_in_container is not None:
        try: audio_in_container.close()
        except Exception: pass
    out.close()

    size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    return {
        "filename": out_name,
        "type": "output",
        "subfolder": "",
        "size_bytes": size,
        "duration_sec": total_frames / float(fps),
        "frames": total_frames,
    }


def encode_spacetype_video(frames_list, fps, width, height, out_path, alpha=False):
    """Encode a sequence of frame image files (PNGs) into a video file.

    Default (alpha=False): h264/yuv420p in an .mp4 container. RGBA source
    frames are flattened onto black, since yuv420p has no alpha channel —
    this is the original, unchanged behaviour.

    alpha=True: libvpx-vp9/yuva420p in a .webm container, preserving the
    frames' alpha channel. VP9 in WebM is the only alpha-capable combination
    that plays in Chrome/Firefox/Edge; Safari will not play it (the UI says
    so).

    Module-level (rather than nested in the route handler) so it can be
    exercised directly in tests without going through aiohttp.
    """
    import av

    input_dir = folder_paths.get_input_directory()

    out = av.open(out_path, mode="w")
    try:
        if alpha:
            stream = out.add_stream("libvpx-vp9", rate=Fraction(fps, 1))
            stream.pix_fmt = "yuva420p"
            # b:v 0 selects constant-quality mode, where crf actually governs.
            stream.options = {"crf": "30", "b:v": "0"}
        else:
            stream = out.add_stream("h264", rate=Fraction(fps, 1))
            stream.pix_fmt = "yuv420p"
            stream.options = {"preset": "veryfast", "crf": "20"}
        stream.width = width
        stream.height = height
        _apply_bt709(stream.codec_context)

        for fn in frames_list:
            # Resolve filename: try annotated filepath first, then input_dir
            try:
                abs_path = folder_paths.get_annotated_filepath(fn)
            except Exception:
                abs_path = os.path.join(input_dir, fn)

            im = PILImage.open(abs_path)

            # Resize if dimensions don't match (normally they already match)
            if im.size != (width, height):
                im = im.resize((width, height), PILImage.LANCZOS)

            if alpha:
                im = im.convert("RGBA")
                arr = np.array(im, dtype=np.uint8)
                av_frame = av.VideoFrame.from_ndarray(arr, format="rgba")
                _tag_frame_bt709(av_frame)
            else:
                # Flatten RGBA onto black — h264/yuv420p has no alpha channel
                if im.mode == "RGBA":
                    bg = PILImage.new("RGB", im.size, (0, 0, 0))
                    bg.paste(im, mask=im.split()[-1])
                    im = bg
                else:
                    im = im.convert("RGB")
                arr = np.array(im, dtype=np.uint8)
                av_frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                _tag_frame_bt709(av_frame)

            for packet in stream.encode(av_frame):
                out.mux(packet)

        # Flush encoder
        for packet in stream.encode():
            out.mux(packet)
    finally:
        out.close()


# Font subsetting for the Space Type web-embed export ------------------------
#
# A Space Type export inlines its font as a data: URI. The full Google Fonts
# TTF carries thousands of glyphs (~296 KB) when a piece typically uses
# maybe twenty. Subsetting to *only* the characters used would get this to
# ~20-40 KB, but the export could then never render a character it wasn't
# built with — closing the door on reactive/data-driven embeds where the
# text changes at runtime.
#
# The chosen compromise: subset to the characters the piece uses UNION the
# full basic-Latin range U+0020-U+007E (~100 glyphs instead of thousands).
# That lands around 40-60 KB and guarantees any English text still renders
# even if it's not the text the piece shipped with. Only accented and
# non-Latin characters are dropped. See
# docs/superpowers/plans/2026-08-04-embed-font-subsetting.md.

_BASIC_LATIN_CODEPOINTS = range(0x20, 0x7F)  # space .. tilde

# Generous cap on the *decoded* font size a /sailor/font_subset request will
# accept. This guards against a malformed or hostile request body exhausting
# memory before parsing even starts. Real webfonts — even heavy variable
# families — are a few MB at most; 20 MB leaves headroom without being
# effectively unbounded.
MAX_FONT_SUBSET_BYTES = 20 * 1024 * 1024


def subset_font_bytes(font_bytes: bytes, text: str) -> bytes:
    """Subset a TTF/OTF to `text`'s characters UNION basic Latin.

    Module-level (rather than nested in the route handler) so it can be
    exercised directly in tests without going through aiohttp, matching
    `encode_spacetype_video` above.

    fontTools.subset options, and why:
      - `layout_features = ["*"]`: keep every GSUB/GPOS layout feature
        (kerning, ligatures, contextual alternates, mark attachment, ...)
        rather than fontTools' own curated default list. A subset that
        renders *differently* from the source font — e.g. missing kerning
        pairs or a broken ligature — is a wrong export, not a small one;
        keeping every feature (dead ones are simply pruned along with their
        now-unreferenced lookups) is the conservative choice.
      - `hinting` is left at its default (True): dropping it trades fidelity
        for a further size cut we don't need here — glyph count, not
        hinting data, is what takes this from ~300 KB to tens of KB.
      - Everything else (glyph_names=False, drop_tables' bitmap/Graphite
        tables, etc.) is left at fontTools' defaults, which already drop
        data that has no effect on how the kept glyphs render.

    Raises on a missing, empty, oversized, or undecodable font — callers
    (the HTTP route) are expected to turn that into a 4xx and the export
    path is expected to fall back to the un-subsetted font rather than
    propagate the error.
    """
    if not font_bytes:
        raise ValueError("subset_font_bytes: no font bytes given")
    if len(font_bytes) > MAX_FONT_SUBSET_BYTES:
        raise ValueError(
            f"subset_font_bytes: font is {len(font_bytes)} bytes, over the "
            f"{MAX_FONT_SUBSET_BYTES}-byte cap"
        )

    from fontTools import subset as ftsubset
    from fontTools.ttLib import TTFont

    # TTFont() raises (TTLibError / struct.error / etc.) on bytes that
    # aren't a font at all — that's the "undecodable font" rejection path.
    font = TTFont(io.BytesIO(font_bytes))

    unicodes = {ord(c) for c in text}
    unicodes.update(_BASIC_LATIN_CODEPOINTS)

    options = ftsubset.Options()
    options.layout_features = ["*"]

    subsetter = ftsubset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)

    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


# Register HTTP endpoint on Comfy's PromptServer if available.
try:
    from server import PromptServer
    from aiohttp import web
    import asyncio

    # Streaming variant: NDJSON progress events while the render runs, plus
    # a final "result" line with the file metadata. Same JSON body as the
    # non-streaming endpoint.
    @PromptServer.instance.routes.post("/sailor/render_timeline_stream")
    async def _render_timeline_stream_route(request):
        try:
            state = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)

        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        if _is_edit_state(state):
            state = _adapt_edit_state(state)
        for c in state.get("clips", []):
            p = c.get("path")
            if p and not os.path.isabs(p):
                c["path"] = os.path.join(input_dir, p)
        if state.get("audio_path") and not os.path.isabs(state["audio_path"]):
            state["audio_path"] = os.path.join(input_dir, state["audio_path"])

        loop = asyncio.get_event_loop()
        q: asyncio.Queue = asyncio.Queue()

        def progress(current: int, total: int):
            # Called from the executor thread — bounce to the event loop.
            loop.call_soon_threadsafe(q.put_nowait, {"type": "progress", "current": current, "total": total})

        async def run_render():
            try:
                result = await loop.run_in_executor(
                    None, lambda: render_timeline_to_file(state, output_dir, progress)
                )
                # `result` already contains `type: "output"` (asset listing
                # convention). Use a distinct wrapper key so the frontend can
                # tell apart a progress tick from the final payload.
                await q.put({"type": "result", "result": result})
            except Exception as e:
                import traceback
                await q.put({"type": "error", "error": str(e), "trace": traceback.format_exc()})
            finally:
                await q.put({"type": "done"})

        resp = web.StreamResponse(
            status=200,
            headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-store"},
        )
        await resp.prepare(request)
        render_task = asyncio.create_task(run_render())
        try:
            while True:
                msg = await q.get()
                if msg.get("type") == "done":
                    break
                await resp.write((json.dumps(msg) + "\n").encode("utf-8"))
        finally:
            await render_task  # ensure cleanup
        await resp.write_eof()
        return resp

    @PromptServer.instance.routes.post("/sailor/render_timeline")
    async def _render_timeline_route(request):
        try:
            state = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)

        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()

        # Accept the editor's EditState (any supported version) by flattening to
        # the legacy shape before path resolution + render.
        if _is_edit_state(state):
            state = _adapt_edit_state(state)

        # Resolve clip paths: accept either absolute paths or filenames under input/.
        for c in state.get("clips", []):
            p = c.get("path")
            if p and not os.path.isabs(p):
                c["path"] = os.path.join(input_dir, p)
        if state.get("audio_path") and not os.path.isabs(state["audio_path"]):
            state["audio_path"] = os.path.join(input_dir, state["audio_path"])

        # Run the (CPU-bound) render off the event loop so it doesn't block aiohttp.
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(None, render_timeline_to_file, state, output_dir)
        except Exception as e:
            import traceback
            return web.json_response(
                {"error": str(e), "trace": traceback.format_exc()},
                status=500,
            )
        return web.json_response(result)

    @PromptServer.instance.routes.post("/sailor/spacetype_encode")
    async def _spacetype_encode_route(request):
        """Encode a sequence of PNG frames (from input/) into a video.

        Body JSON:
          { "frames": ["spacetype_..._0000.png", ...], "fps": 30,
            "width": 1920, "height": 1080, "alpha": false }
        Response JSON:
          { "filename": "spacetype_<ms>.mp4" }   // written into input/
          // or "spacetype_<ms>.webm" when "alpha": true

        With no "alpha" flag (or alpha=false), behaviour is unchanged:
        h264/yuv420p in an .mp4, RGBA frames flattened onto black. With
        "alpha": true, encodes libvpx-vp9/yuva420p in a .webm, preserving
        transparency.
        """
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)

        frames_list = data.get("frames", [])
        if not frames_list:
            return web.json_response({"error": "frames list is empty"}, status=400)

        fps = int(data.get("fps", 30))
        width = int(data.get("width", 1920))
        height = int(data.get("height", 1080))
        alpha = bool(data.get("alpha", False))

        # yuv420p/yuva420p both require even dimensions
        width = width - (width % 2)
        height = height - (height % 2)

        input_dir = folder_paths.get_input_directory()
        ext = "webm" if alpha else "mp4"
        out_name = f"spacetype_{int(time.time() * 1000)}.{ext}"
        out_path = os.path.join(input_dir, out_name)

        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, encode_spacetype_video, frames_list, fps, width, height, out_path, alpha)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

        return web.json_response({"filename": out_name})

    @PromptServer.instance.routes.post("/sailor/font_subset")
    async def _font_subset_route(request):
        """Subset an embedded TTF/OTF down to the characters a piece needs.

        Body JSON: { "font": "<base64 ttf/otf>", "text": "<the piece's text>" }
        Response JSON:
          { "font": "<base64 subsetted font>", "before": <bytes>, "after": <bytes> }

        Subsets to `text`'s characters UNION the full basic-Latin range
        (U+0020-U+007E) — see subset_font_bytes for the reasoning.

        Any failure here is a 4xx/5xx, never a partial/garbage font. The
        export path (frontend) is expected to fall back to the original,
        un-subsetted font on any non-200 response rather than fail the
        export outright — subsetting is a size optimization, not a
        correctness requirement.
        """
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)

        font_b64 = data.get("font")
        if not font_b64 or not isinstance(font_b64, str):
            return web.json_response({"error": "missing 'font'"}, status=400)
        # Reject before decoding: base64 inflates size by ~4/3, so bound the
        # raw string too rather than only checking after inflating it into bytes.
        if len(font_b64) > MAX_FONT_SUBSET_BYTES * 2:
            return web.json_response({"error": "font is too large"}, status=400)

        text = data.get("text", "")
        if not isinstance(text, str):
            text = ""

        try:
            font_bytes = base64.b64decode(font_b64, validate=True)
        except Exception as e:
            return web.json_response({"error": f"undecodable font: {e}"}, status=400)

        try:
            loop = asyncio.get_event_loop()
            subsetted = await loop.run_in_executor(None, subset_font_bytes, font_bytes, text)
        except Exception as e:
            # subset_font_bytes only fails on bad/oversized/unparseable font
            # bytes — a caller-fixable input problem, not a server error.
            return web.json_response({"error": str(e)}, status=400)

        return web.json_response({
            "font": base64.b64encode(subsetted).decode("ascii"),
            "before": len(font_bytes),
            "after": len(subsetted),
        })

    @PromptServer.instance.routes.get("/sailor/space_defaults")
    async def _space_defaults_list(request):
        out = {}
        d = _scene_defaults_dir()
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.endswith(".json") and _valid_effect_id(fn[:-5]):
                    try:
                        with open(os.path.join(d, fn), "r", encoding="utf-8") as f:
                            out[fn[:-5]] = json.load(f)
                    except Exception:
                        pass
        return web.json_response(out)

    @PromptServer.instance.routes.post("/sailor/space_default/{effect_id}")
    async def _space_default_save(request):
        effect_id = request.match_info.get("effect_id", "")
        if not _valid_effect_id(effect_id):
            return web.json_response({"error": "invalid effect id"}, status=400)
        try:
            scene = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)
        if not isinstance(scene, dict):
            return web.json_response({"error": "scene must be an object"}, status=400)
        d = _scene_defaults_dir()
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{effect_id}.json"), "w", encoding="utf-8") as f:
            json.dump(scene, f, indent=2)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/sailor/space_thumbnails")
    async def _space_thumbnails_list(request):
        out = {}
        d = _scene_thumbnails_dir()
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.endswith(".png") and _valid_effect_id(fn[:-4]):
                    eid = fn[:-4]
                    mtime = int(os.path.getmtime(os.path.join(d, fn)))
                    out[eid] = f"/sailor/space_thumbnail/{eid}?v={mtime}"
        return web.json_response(out)

    @PromptServer.instance.routes.post("/sailor/space_thumbnail/{effect_id}")
    async def _space_thumbnail_save(request):
        effect_id = request.match_info.get("effect_id", "")
        if not _valid_effect_id(effect_id):
            return web.json_response({"error": "invalid effect id"}, status=400)
        data = await request.read()
        if not data:
            return web.json_response({"error": "empty body"}, status=400)
        d = _scene_thumbnails_dir()
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{effect_id}.png"), "wb") as f:
            f.write(data)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/sailor/space_thumbnail/{effect_id}")
    async def _space_thumbnail_get(request):
        effect_id = request.match_info.get("effect_id", "")
        if not _valid_effect_id(effect_id):
            return web.json_response({"error": "invalid effect id"}, status=400)
        p = os.path.join(_scene_thumbnails_dir(), f"{effect_id}.png")
        if not os.path.isfile(p):
            return web.json_response({"error": "not found"}, status=404)
        with open(p, "rb") as f:
            return web.Response(body=f.read(), content_type="image/png")

    @PromptServer.instance.routes.post("/sailor/timeline/render_frame")
    async def _render_frame_route(request):
        """Render one composited frame of an edit state to PNG. Harness/debug
        surface: the browser golden harness compares PreviewRenderer output
        against this — the same render_frame_np the export uses."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        state = body.get("state")
        try:
            frame = int(body.get("frame", 0))
        except (TypeError, ValueError):
            return web.json_response({"error": "invalid frame"}, status=400)
        if _is_edit_state(state):
            state = _adapt_edit_state(state)
        if not isinstance(state, dict) or not isinstance(state.get("clips"), list):
            return web.json_response({"error": "not an edit state"}, status=400)

        def _render() -> bytes:
            from io import BytesIO
            clips = _prepare_render_clips(state)
            try:
                arr = render_frame_np(state, clips, frame)
            finally:
                _close_render_clips(clips)
            buf = BytesIO()
            PILImage.fromarray((arr * 255.0).round().astype(np.uint8)).save(buf, format="PNG")
            return buf.getvalue()

        data = await asyncio.get_event_loop().run_in_executor(None, _render)
        return web.Response(body=data, content_type="image/png")

    # ── Media listing endpoint ──────────────────────────────────────────────
    #
    # Comfy's /history is in-memory and lost on every server restart, and
    # files written through side-channel endpoints (like /sailor/render_
    # timeline) never enter it. The Assets tab calls this endpoint to get a
    # complete listing of media files actually on disk in output/.

    _MEDIA_EXTS = {
        ".png", ".jpg", ".jpeg", ".webp", ".gif",          # images
        ".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v",   # video
        ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac",   # audio
    }

    @PromptServer.instance.routes.get("/sailor/output_listing")
    async def _output_listing_route(_request):
        output_dir = folder_paths.get_output_directory()
        items: list[dict] = []
        try:
            for root, _dirs, files in os.walk(output_dir):
                for fname in files:
                    if fname.startswith("."):
                        continue
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in _MEDIA_EXTS:
                        continue
                    full = os.path.join(root, fname)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    rel_sub = os.path.relpath(root, output_dir)
                    subfolder = "" if rel_sub == "." else rel_sub
                    items.append({
                        "filename": fname,
                        "subfolder": subfolder,
                        "type": "output",
                        "size": st.st_size,
                        "mtime": st.st_mtime,
                    })
        except Exception as e:
            return web.json_response({"error": str(e), "items": []}, status=500)
        # Newest first.
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return web.json_response({"items": items})

    # ── Asset library ──────────────────────────────────────────────────────
    #
    # Asset records live in user/timeline_assets.json. Each asset points at a
    # path on disk (typically under input/) along with cached metadata (kind,
    # duration, dimensions). The new TimelineEditor drags from this library.

    def _assets_file() -> str:
        user_dir = folder_paths.get_user_directory()
        os.makedirs(user_dir, exist_ok=True)
        return os.path.join(user_dir, "timeline_assets.json")

    def _load_assets() -> list:
        p = _assets_file()
        if not os.path.exists(p):
            return []
        try:
            with open(p, "r") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_assets(assets: list):
        with open(_assets_file(), "w") as f:
            json.dump(assets, f, indent=2)

    def _probe_media(path: str) -> dict:
        ext = os.path.splitext(path)[1].lower()
        info = {"duration_sec": None, "width": None, "height": None}
        video_exts = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}
        image_exts = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
        audio_exts = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
        if ext in video_exts:
            info["kind"] = "video"
            try:
                import av
                c = av.open(path, mode="r")
                vs = c.streams.video[0]
                info["width"], info["height"] = vs.width, vs.height
                if vs.duration and vs.time_base:
                    info["duration_sec"] = float(vs.duration * vs.time_base)
                c.close()
            except Exception:
                pass
        elif ext in image_exts:
            info["kind"] = "image"
            try:
                img = PILImage.open(path)
                info["width"], info["height"] = img.size
                img.close()
            except Exception:
                pass
        elif ext in audio_exts:
            info["kind"] = "audio"
            try:
                import av
                c = av.open(path, mode="r")
                a = c.streams.audio[0]
                if a.duration and a.time_base:
                    info["duration_sec"] = float(a.duration * a.time_base)
                c.close()
            except Exception:
                pass
        else:
            info["kind"] = "video"
        return info

    @PromptServer.instance.routes.get("/sailor/assets")
    async def _assets_list_route(_request):
        return web.json_response({"assets": _load_assets()})

    @PromptServer.instance.routes.post("/sailor/asset_import")
    async def _asset_import_route(request):
        try:
            body = await request.json()
        except Exception as e:
            return web.json_response({"error": f"bad json: {e}"}, status=400)
        path = body.get("path")
        if not path:
            return web.json_response({"error": "missing 'path'"}, status=400)
        input_dir = folder_paths.get_input_directory()
        if not os.path.isabs(path):
            path = os.path.join(input_dir, path)
        if not os.path.exists(path):
            return web.json_response({"error": f"not found: {path}"}, status=404)

        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, _probe_media, path)

        assets = _load_assets()
        existing = next((a for a in assets if a["path"] == path), None)
        if existing:
            return web.json_response({"asset": existing, "created": False})

        asset = {
            "id": str(uuid.uuid4()),
            "path": path,
            "kind": info["kind"],
            "name": os.path.basename(path),
            "duration_sec": info["duration_sec"],
            "width":  info["width"],
            "height": info["height"],
            "thumbnail_path": None,
            "waveform_path":  None,
        }
        assets.append(asset)
        _save_assets(assets)
        return web.json_response({"asset": asset, "created": True})

    @PromptServer.instance.routes.delete("/sailor/assets/{asset_id}")
    async def _asset_delete_route(request):
        asset_id = request.match_info["asset_id"]
        assets = [a for a in _load_assets() if a["id"] != asset_id]
        _save_assets(assets)
        return web.json_response({"ok": True})

    # ── Thumbnails ─────────────────────────────────────────────────────────
    #
    # Generates N evenly-spaced thumbnails for a video asset (or one
    # thumbnail for an image). Returned as base64 PNG strings the frontend
    # can drop straight into a CSS background-image. Cached on disk in
    # user/timeline_thumbs/<asset_id>/<count>.json so repeated requests are
    # cheap.

    def _thumb_cache_dir() -> str:
        user_dir = folder_paths.get_user_directory()
        d = os.path.join(user_dir, "timeline_thumbs")
        os.makedirs(d, exist_ok=True)
        return d

    def _thumb_height_px() -> int:
        return 48  # source-strip thumbnail height in px; width derived from aspect

    def _gen_thumbnails(asset_path: str, count: int) -> list[str]:
        """Return `count` base64 PNG thumbnails. For images, returns one entry."""
        import base64
        from io import BytesIO

        ext = os.path.splitext(asset_path)[1].lower()
        thumb_h = _thumb_height_px()

        if ext in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            try:
                img = PILImage.open(asset_path).convert("RGB")
                w, h = img.size
                tw = max(1, int(round(w * thumb_h / h)))
                img = img.resize((tw, thumb_h), PILImage.BILINEAR)
                buf = BytesIO()
                img.save(buf, format="PNG", optimize=True)
                return ["data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()]
            except Exception:
                return []

        # Video path: seek to evenly-spaced timestamps.
        try:
            import av
            c = av.open(asset_path, mode="r")
            vs = c.streams.video[0]
            tb = vs.time_base
            dur_pts = vs.duration or 0
            dur_sec = float(dur_pts * tb) if tb else 0.0
            if dur_sec <= 0:
                # Try container duration as fallback (in microseconds).
                dur_sec = float((c.duration or 0) / 1_000_000.0)
            if dur_sec <= 0:
                c.close()
                return []

            out: list[str] = []
            step = dur_sec / max(1, count)
            for i in range(count):
                t = step * (i + 0.5)  # center each thumb in its slice
                target_pts = int(t / float(tb))
                try:
                    c.seek(max(0, target_pts), stream=vs, any_frame=False, backward=True)
                except Exception:
                    pass
                frame = None
                for f in c.decode(vs):
                    frame = f
                    if f.pts is not None and f.pts >= target_pts:
                        break
                if frame is None:
                    continue
                pil = PILImage.fromarray(frame.to_ndarray(format="rgb24"))
                w, h = pil.size
                tw = max(1, int(round(w * thumb_h / h)))
                pil = pil.resize((tw, thumb_h), PILImage.BILINEAR)
                buf = BytesIO()
                pil.save(buf, format="PNG", optimize=True)
                out.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
            c.close()
            return out
        except Exception:
            return []

    @PromptServer.instance.routes.get("/sailor/input_thumbnail")
    async def _input_thumbnail_route(request):
        """One small PNG thumbnail for a file in input/, addressable by its
        listing filename so <img loading="lazy"> can fetch rows on demand.
        Disk-cached by (filename, mtime); audio/undecodable files 404 and the
        client keeps its icon fallback."""
        import base64
        import hashlib

        filename = request.query.get("filename", "")
        input_dir = os.path.abspath(folder_paths.get_input_directory())
        p = os.path.abspath(os.path.normpath(os.path.join(input_dir, filename)))
        if not filename or not p.startswith(input_dir + os.sep) or not os.path.isfile(p):
            return web.Response(status=404)

        key = hashlib.sha1(f"{filename}:{int(os.path.getmtime(p))}".encode()).hexdigest()
        cache_png = os.path.join(_thumb_cache_dir(), f"input_{key}.png")
        if not os.path.exists(cache_png):
            loop = asyncio.get_event_loop()
            thumbs = await loop.run_in_executor(None, _gen_thumbnails, p, 1)
            if not thumbs:
                return web.Response(status=404)
            try:
                with open(cache_png, "wb") as f:
                    f.write(base64.b64decode(thumbs[0].split(",", 1)[1]))
            except Exception:
                return web.Response(status=404)
        with open(cache_png, "rb") as f:
            body = f.read()
        # mtime is baked into the cache key server-side; input files are
        # practically immutable, so let the browser cache hard for a day.
        return web.Response(body=body, content_type="image/png",
                            headers={"Cache-Control": "max-age=86400"})

    @PromptServer.instance.routes.get("/sailor/asset_thumbnails")
    async def _asset_thumbs_route(request):
        asset_id = request.query.get("asset_id")
        try:
            count = max(1, min(20, int(request.query.get("count", "5"))))
        except ValueError:
            count = 5
        if not asset_id:
            return web.json_response({"error": "missing asset_id"}, status=400)

        cache_dir = _thumb_cache_dir()
        cache_file = os.path.join(cache_dir, f"{asset_id}.{count}.json")
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r") as f:
                    return web.json_response(json.load(f))
            except Exception:
                pass

        asset = next((a for a in _load_assets() if a["id"] == asset_id), None)
        if not asset:
            return web.json_response({"error": "asset not found"}, status=404)

        loop = asyncio.get_event_loop()
        thumbs = await loop.run_in_executor(None, _gen_thumbnails, asset["path"], count)
        payload = {"thumbnails": thumbs, "asset_id": asset_id, "count": count}
        try:
            with open(cache_file, "w") as f:
                json.dump(payload, f)
        except Exception:
            pass
        return web.json_response(payload)

    # ── Waveforms ─────────────────────────────────────────────────────────
    #
    # One-shot peak generator for audio assets. Returns N normalized peaks
    # in [0, 1], one per pixel-bucket. Cached on disk like thumbnails.

    def _gen_waveform_peaks(asset_path: str, bucket_count: int) -> list[float]:
        try:
            import av
            c = av.open(asset_path, mode="r")
            a = c.streams.audio[0]
            # Decode all samples into a flat ndarray, take absolute max per bucket.
            samples = []
            for frame in c.decode(a):
                arr = frame.to_ndarray()
                # Mix to mono if multi-channel.
                if arr.ndim == 2:
                    arr = arr.mean(axis=0) if arr.shape[0] <= 8 else arr.mean(axis=1)
                samples.append(np.abs(arr).astype(np.float32))
            c.close()
            if not samples:
                return []
            flat = np.concatenate(samples)
            # Normalize.
            peak = float(flat.max()) or 1.0
            flat /= peak
            # Bucket.
            n = max(1, bucket_count)
            chunk = max(1, len(flat) // n)
            buckets = []
            for i in range(n):
                start = i * chunk
                end = (i + 1) * chunk if i < n - 1 else len(flat)
                if start >= len(flat):
                    buckets.append(0.0)
                    continue
                buckets.append(float(flat[start:end].max()))
            return buckets
        except Exception:
            return []

    @PromptServer.instance.routes.get("/sailor/asset_waveform")
    async def _asset_waveform_route(request):
        asset_id = request.query.get("asset_id")
        try:
            buckets = max(16, min(2048, int(request.query.get("buckets", "256"))))
        except ValueError:
            buckets = 256
        if not asset_id:
            return web.json_response({"error": "missing asset_id"}, status=400)

        cache_file = os.path.join(_thumb_cache_dir(), f"wave_{asset_id}.{buckets}.json")
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r") as f:
                    return web.json_response(json.load(f))
            except Exception:
                pass

        asset = next((a for a in _load_assets() if a["id"] == asset_id), None)
        if not asset:
            return web.json_response({"error": "asset not found"}, status=404)

        loop = asyncio.get_event_loop()
        peaks = await loop.run_in_executor(None, _gen_waveform_peaks, asset["path"], buckets)
        payload = {"peaks": peaks, "asset_id": asset_id, "buckets": buckets}
        try:
            with open(cache_file, "w") as f:
                json.dump(payload, f)
        except Exception:
            pass
        return web.json_response(payload)

    # ── Input dir listing ──────────────────────────────────────────────────
    #
    # The "Input Files" pane in the editor uses this to enumerate media files
    # the user can drag into the timeline as assets.

    @PromptServer.instance.routes.get("/sailor/input_listing")
    async def _input_listing_route(_request):
        input_dir = folder_paths.get_input_directory()
        items: list[dict] = []
        try:
            for fname in os.listdir(input_dir):
                if fname.startswith("."):
                    continue
                full = os.path.join(input_dir, fname)
                if not os.path.isfile(full):
                    continue
                ext = os.path.splitext(fname)[1].lower()
                if ext not in _MEDIA_EXTS:
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                items.append({
                    "filename": fname,
                    "path": full,
                    "type": "input",
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                })
        except Exception as e:
            return web.json_response({"error": str(e), "items": []}, status=500)
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return web.json_response({"items": items})

    # File deletion for AssetsPanel cards. Two separate routes (not one
    # generic "delete file" with a `type` param) so a malicious caller can't
    # cross a boundary by smuggling a different type — each route only ever
    # resolves under its own root.
    def _safe_resolve(root: str, subfolder: str, filename: str) -> str | None:
        # Reject anything that could escape `root` (absolute paths, '..').
        # commonpath check covers symlink and case-insensitive-FS edge cases.
        if not filename or os.path.isabs(filename) or os.path.isabs(subfolder or ""):
            return None
        candidate = os.path.normpath(os.path.join(root, subfolder or "", filename))
        try:
            if os.path.commonpath([os.path.realpath(candidate), os.path.realpath(root)]) != os.path.realpath(root):
                return None
        except ValueError:
            return None
        return candidate

    @PromptServer.instance.routes.delete("/sailor/input_file")
    async def _input_file_delete_route(request):
        filename = request.query.get("filename", "")
        target = _safe_resolve(folder_paths.get_input_directory(), "", filename)
        if target is None:
            return web.json_response({"error": "invalid filename"}, status=400)
        if not os.path.isfile(target):
            return web.json_response({"ok": True, "missing": True})
        try:
            os.remove(target)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.delete("/sailor/output_file")
    async def _output_file_delete_route(request):
        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        target = _safe_resolve(folder_paths.get_output_directory(), subfolder, filename)
        if target is None:
            return web.json_response({"error": "invalid filename"}, status=400)
        if not os.path.isfile(target):
            return web.json_response({"ok": True, "missing": True})
        try:
            os.remove(target)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"ok": True})
except Exception:
    # Module imported outside the server context (e.g., a syntax-check import) — skip.
    pass


class TimelineExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [TimelineNode]


async def comfy_entrypoint() -> TimelineExtension:
    return TimelineExtension()
