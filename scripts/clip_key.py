#!/usr/bin/env python
"""Key a video model's opaque frames back to transparency for the Frame's living image.

Invoked by frontend/server/api/frame/animate.post.ts. Two subcommands:

  clip_key.py flatten <still.png> <out.png>
      Composite the RGBA still onto a flat key colour (green, or blue when the still
      has visible green in it). Prints  KEY:#rrggbb  on stdout.

  clip_key.py key <in.mp4> <still.png> <#rrggbb> <out_dir> <trim_last 0|1>
      Decode the clip, key every frame against the colour, multiply by a dilated copy of
      the still's own alpha (the guard), resize to the still's longest edge, write
      000000.png … and clip.json into out_dir. Prints one JSON line with frames/fps/size.

Pure functions are module-level so tests-unit/clip_key_test.py can call them directly.
Uses the venv's imageio + imageio_ffmpeg for decoding — no system ffmpeg needed.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
GREEN_SHARE_LIMIT = 0.03      # more visible green than this ⇒ key on blue instead
KEY_LO, KEY_HI = 20.0, 60.0   # chroma distance: fully keyed below LO, fully kept above HI
GUARD_FRAC = 0.04             # guard reach as a fraction of the still's width


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(v) for v in rgb)


def _from_hex(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


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


def _cbcr(rgb: np.ndarray):
    r = rgb[..., 0].astype(np.float32); g = rgb[..., 1].astype(np.float32); b = rgb[..., 2].astype(np.float32)
    cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return cb, cr


def key_alpha(rgb: np.ndarray, key_rgb, lo: float = KEY_LO, hi: float = KEY_HI) -> np.ndarray:
    """Alpha in [0,1] from the chroma distance to the key colour: 0 at/below `lo`, 1 at/above `hi`,
    a smooth ramp between. Luma is ignored on purpose so shading on the flat ground still keys."""
    cb, cr = _cbcr(rgb)
    kcb, kcr = _cbcr(np.asarray(key_rgb, dtype=np.uint8).reshape(1, 1, 3))
    d = np.sqrt((cb - kcb) ** 2 + (cr - kcr) ** 2)
    t = np.clip((d - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def suppress_spill(rgb: np.ndarray, key_rgb, alpha: np.ndarray) -> np.ndarray:
    """On partly transparent pixels, clamp the key channel to the mean of the other two so a
    green (or blue) fringe does not ride into the composite. Opaque pixels are untouched."""
    out = rgb.astype(np.float32).copy()
    kch = int(np.argmax(np.asarray(key_rgb)))
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


def _fit(w, h, max_edge):
    m = max(w, h)
    if m <= max_edge:
        return w, h
    s = max_edge / float(m)
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def key_frames(frames, fps: float, still_rgba: np.ndarray, key_rgb, out_dir: str,
               max_edge: int, trim_last: bool) -> dict:
    """Key every RGB frame, guard it with the still, write PNGs + clip.json. Returns meta."""
    if trim_last and len(frames) > 1:
        frames = frames[:-1]           # first == last on a first/last-frame model: don't hold it twice
    os.makedirs(out_dir, exist_ok=True)
    fh, fw = frames[0].shape[0], frames[0].shape[1]
    ow, oh = _fit(fw, fh, max_edge)
    guard = guard_mask(still_rgba[..., 3], (ow, oh))
    n = 0
    for i, f in enumerate(frames):
        if (f.shape[1], f.shape[0]) != (ow, oh):
            f = np.asarray(Image.fromarray(f, "RGB").resize((ow, oh), Image.LANCZOS))
        a = key_alpha(f, key_rgb) * guard
        rgb = suppress_spill(f, key_rgb, a)
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
        max_edge = max(still.shape[0], still.shape[1])
        meta = key_frames(frames, fps, still, key, argv[5], max_edge, argv[6] == "1")
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
