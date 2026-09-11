#!/usr/bin/env python
"""Key a video model's opaque frames back to transparency for the Frame's living image.

Invoked by frontend/server/api/frame/animate.post.ts. Subcommands:

  clip_key.py flatten <still.png> <out.png>
      Composite the RGBA still onto a flat key colour (green, or blue when the still
      has visible green in it). Prints  KEY:#rrggbb  on stdout.

  clip_key.py key <in.mp4> <still.png> <#rrggbb> <out_dir> <trim_last 0|1>
      Decode the clip, sample the ACTUAL background the model painted per frame (video
      models rarely return the exact key colour requested), key every frame against that
      sampled colour in CIE Lab with an adaptive tolerance, guard it with a dilated copy
      of the still's own alpha, erode + soften the matte edge, resize to the still's
      longest edge, write 000000.png … and clip.json into out_dir. Also copies the source
      clip to out_dir/source.mp4 so tuning the keyer never costs another model call.
      Prints one JSON line with frames/fps/size.

  clip_key.py rekey <clip_dir> <still.png> <#rrggbb> <trim_last 0|1>
      Re-run the `key` step against <clip_dir>/source.mp4 (written by a prior `key`
      call), replacing the PNGs in place. Same JSON line on stdout.

Pure functions are module-level so tests-unit/clip_key_test.py can call them directly.
Uses the venv's imageio + imageio_ffmpeg for decoding — no system ffmpeg needed.
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageFilter

GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
GREEN_SHARE_LIMIT = 0.03      # more visible green than this ⇒ key on blue instead
KEY_LO, KEY_HI = 20.0, 60.0   # default Lab-distance ramp when no adaptive tolerance is given
GUARD_FRAC = 0.025            # guard reach as a fraction of the still's width
BG_SAMPLE_FRAC = 0.10         # how far outside the silhouette counts as "definitely background"
BG_MIN_COVERAGE = 0.01        # below this share of the frame, don't trust the sample
TOL_LO_MIN, TOL_LO_MAX = 6.0, 28.0
TOL_HI_MARGIN = 14.0          # hi = lo + this
EDGE_ERODE_PX = 1


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(v) for v in rgb)


def _from_hex(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def pick_key_colour(rgba: np.ndarray) -> str:
    """Green unless the still's opaque pixels are noticeably green themselves."""
    a = rgba[..., 3] > 128
    if not a.any():
        return _hex(GREEN)
    hsv = np.asarray(Image.fromarray(rgba[..., :3], "RGB").convert("HSV")).astype(np.float32)
    hue = hsv[..., 0] * (360.0 / 255.0)
    sat = hsv[..., 1] / 255.0
    greenish = (np.abs(hue - 120.0) <= 30.0) & (sat > 0.4) & a
    share = greenish.sum() / max(1, a.sum())
    return _hex(BLUE) if share > GREEN_SHARE_LIMIT else _hex(GREEN)


def flatten_onto(rgba: np.ndarray, key_rgb) -> np.ndarray:
    """RGBA → RGB with the key colour behind every transparent pixel (straight alpha)."""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    fg = rgba[..., :3].astype(np.float32)
    bg = np.asarray(key_rgb, dtype=np.float32).reshape(1, 1, 3)
    return np.clip(fg * a + bg * (1.0 - a), 0, 255).astype(np.uint8)


def _lab_f(t: np.ndarray) -> np.ndarray:
    delta = 6.0 / 29.0
    return np.where(t > delta ** 3, np.cbrt(t), t / (3.0 * delta ** 2) + 4.0 / 29.0)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """CIE Lab (D65) from an (..., 3) uint8 sRGB array. Standard sRGB linearisation,
    linear-sRGB → XYZ, XYZ → Lab. No scipy/skimage. Returns float32, same leading shape."""
    srgb = rgb.astype(np.float32) / 255.0
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    r, g, b = linear[..., 0], linear[..., 1], linear[..., 2]
    x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
    y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
    z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041
    xn, yn, zn = 0.95047, 1.0, 1.08883
    fx, fy, fz = _lab_f(x / xn), _lab_f(y / yn), _lab_f(z / zn)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    bb = 200.0 * (fy - fz)
    return np.stack([L, a, bb], axis=-1).astype(np.float32)


def lab_distance(rgb: np.ndarray, ref_rgb) -> np.ndarray:
    """Per-pixel Lab distance from an (h,w,3) uint8 array to a single reference colour."""
    lab = srgb_to_lab(rgb)
    ref = srgb_to_lab(np.asarray(ref_rgb, dtype=np.uint8).reshape(1, 1, 3))[0, 0]
    return np.sqrt(((lab - ref) ** 2).sum(axis=-1))


def key_alpha(rgb: np.ndarray, bg_rgb, lo: float = KEY_LO, hi: float = KEY_HI) -> np.ndarray:
    """Alpha in [0,1] from the CIE Lab distance to the sampled background colour: 0 at/below
    `lo`, 1 at/above `hi`, a smooth ramp between. Lab (not luma-blind CbCr) so a background
    that isn't the exact requested key colour still keys cleanly."""
    d = lab_distance(rgb, bg_rgb)
    t = np.clip((d - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def suppress_spill(rgb: np.ndarray, bg_rgb, alpha: np.ndarray) -> np.ndarray:
    """On partly transparent pixels, clamp the sampled background's dominant channel to the
    mean of the other two so a green (or blue) fringe does not ride into the composite.
    Opaque pixels are untouched."""
    out = rgb.astype(np.float32).copy()
    kch = int(np.argmax(np.asarray(bg_rgb)))
    others = [c for c in range(3) if c != kch]
    edge = alpha < 0.999
    mean_other = (out[..., others[0]] + out[..., others[1]]) * 0.5
    out[..., kch] = np.where(edge, np.minimum(out[..., kch], mean_other), out[..., kch])
    return np.clip(out, 0, 255).astype(np.uint8)


def guard_mask(still_alpha: np.ndarray, size_wh, frac: float = GUARD_FRAC) -> np.ndarray:
    """The still's alpha, resized to the frame and grown outward by `frac` of the frame width.
    Returns float32 in [0,1], shape (h, w)."""
    w, h = int(size_wh[0]), int(size_wh[1])
    im = Image.fromarray(still_alpha.astype(np.uint8), "L").resize((w, h), Image.BILINEAR)
    reach = int(round(frac * w))
    if reach > 0:
        im = im.filter(ImageFilter.MaxFilter(2 * reach + 1))
    return (np.asarray(im).astype(np.float32) > 127.0).astype(np.float32)


def estimate_background(rgb: np.ndarray, far_mask: np.ndarray, key_rgb=GREEN):
    """Per-channel median colour of the frame's definitely-background pixels (`far_mask`,
    True outside the still's silhouette by a generous margin), and the 90th-percentile Lab
    distance of those pixels from that median (`bg_spread` — how uniform the ground is).
    Falls back to `key_rgb` with a zero spread when `far_mask` covers under 1% of the frame:
    too few pixels to trust a sampled colour."""
    total = far_mask.size
    if far_mask.sum() < BG_MIN_COVERAGE * total:
        return tuple(int(v) for v in key_rgb), 0.0
    pix = rgb[far_mask]                                    # (N, 3) uint8
    med = np.median(pix.astype(np.float32), axis=0)
    bg_rgb = tuple(int(round(v)) for v in med)
    d = lab_distance(pix.reshape(-1, 1, 3), bg_rgb).reshape(-1)
    bg_spread = float(np.percentile(d, 90)) if d.size else 0.0
    return bg_rgb, bg_spread


def _erode_soften(alpha_u8: np.ndarray, guard: np.ndarray) -> np.ndarray:
    """Erode the 8-bit matte by EDGE_ERODE_PX, soften the edge, then re-clip to the guard so
    the erosion only ever pulls the matte IN, never lets it spread back out."""
    im = Image.fromarray(alpha_u8, "L")
    if EDGE_ERODE_PX > 0:
        im = im.filter(ImageFilter.MinFilter(3))
    im = im.filter(ImageFilter.GaussianBlur(0.8))
    return (np.asarray(im).astype(np.float32) / 255.0) * guard


def _fit(w, h, max_edge):
    m = max(w, h)
    if m <= max_edge:
        return w, h
    s = max_edge / float(m)
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def key_frames(frames, fps: float, still_rgba: np.ndarray, key_rgb, out_dir: str,
               max_edge: int, trim_last: bool) -> dict:
    """Key every RGB frame against its OWN sampled background, guard it with the still,
    erode + soften the edge, write PNGs + clip.json. Returns meta."""
    if trim_last and len(frames) > 1:
        frames = frames[:-1]           # first == last on a first/last-frame model: don't hold it twice
    os.makedirs(out_dir, exist_ok=True)
    fh, fw = frames[0].shape[0], frames[0].shape[1]
    ow, oh = _fit(fw, fh, max_edge)
    still_alpha = still_rgba[..., 3]
    guard = guard_mask(still_alpha, (ow, oh))
    far_mask = guard_mask(still_alpha, (ow, oh), frac=BG_SAMPLE_FRAC) < 0.5
    n = 0
    for i, f in enumerate(frames):
        if (f.shape[1], f.shape[0]) != (ow, oh):
            f = np.asarray(Image.fromarray(f, "RGB").resize((ow, oh), Image.LANCZOS))
        bg_rgb, bg_spread = estimate_background(f, far_mask, key_rgb)
        lo = clamp(bg_spread * 1.2, TOL_LO_MIN, TOL_LO_MAX)
        hi = lo + TOL_HI_MARGIN
        a = key_alpha(f, bg_rgb, lo, hi) * guard
        a_u8 = np.clip(a * 255.0, 0, 255).astype(np.uint8)
        a = _erode_soften(a_u8, guard)
        rgb = suppress_spill(f, bg_rgb, a)
        rgba = np.dstack([rgb, np.clip(a * 255.0, 0, 255).astype(np.uint8)])
        rgba[a <= 0.0, :3] = 0        # zero hidden colour: smaller PNGs, no stray key tint
        Image.fromarray(rgba, "RGBA").save(os.path.join(out_dir, "%06d.png" % i), optimize=True)
        n += 1
    meta = {"frames": n, "fps": float(fps), "width": ow, "height": oh}
    with open(os.path.join(out_dir, "clip.json"), "w") as fh_:
        json.dump({**meta, "key": _hex(key_rgb)}, fh_)
    return meta


def _read_video(path):
    import imageio.v2 as iio
    reader = iio.get_reader(path, "ffmpeg")
    fps = float(reader.get_meta_data().get("fps") or 24.0)
    frames = [np.asarray(fr)[..., :3] for fr in reader]
    reader.close()
    if not frames:
        raise RuntimeError("the clip has no frames")
    return frames, fps


def _rekey_dir(clip_dir):
    """Remove the previous run's PNG frames from a clip dir so a rekey doesn't leave stale
    frames behind if the new run is shorter."""
    for name in os.listdir(clip_dir):
        if name.endswith(".png") and name[:-4].isdigit():
            os.remove(os.path.join(clip_dir, name))


def main(argv):
    if len(argv) >= 4 and argv[1] == "flatten":
        still = np.asarray(Image.open(argv[2]).convert("RGBA"))
        key = pick_key_colour(still)
        Image.fromarray(flatten_onto(still, _from_hex(key)), "RGB").save(argv[3])
        print("KEY:" + key)
        return 0
    if len(argv) >= 7 and argv[1] == "key":
        frames, fps = _read_video(argv[2])
        still = np.asarray(Image.open(argv[3]).convert("RGBA"))
        key = _from_hex(argv[4])
        out_dir = argv[5]
        os.makedirs(out_dir, exist_ok=True)
        shutil.copyfile(argv[2], os.path.join(out_dir, "source.mp4"))
        max_edge = max(still.shape[0], still.shape[1])
        meta = key_frames(frames, fps, still, key, out_dir, max_edge, argv[6] == "1")
        print(json.dumps(meta))
        return 0
    if len(argv) >= 6 and argv[1] == "rekey":
        clip_dir = argv[2]
        frames, fps = _read_video(os.path.join(clip_dir, "source.mp4"))
        still = np.asarray(Image.open(argv[3]).convert("RGBA"))
        key = _from_hex(argv[4])
        _rekey_dir(clip_dir)
        max_edge = max(still.shape[0], still.shape[1])
        meta = key_frames(frames, fps, still, key, clip_dir, max_edge, argv[5] == "1")
        print(json.dumps(meta))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # one line on stderr is what the route surfaces to the panel
        print(f"clip_key failed: {e}", file=sys.stderr)
        sys.exit(1)
