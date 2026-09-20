"""VP9/WebM alpha export from /sailor/spacetype_encode.

Proves two things:
  1. An alpha export genuinely carries transparency through PyAV decode.
  2. The default (no `alpha` flag) path is untouched: still .mp4/h264,
     still flattens RGBA onto black.

Tests call the module-level encode helper directly rather than the aiohttp
route, per the brief's testability note.
"""
import importlib
import os

import numpy as np
import pytest
from PIL import Image

nt = importlib.import_module("comfy_extras.nodes_timeline")

FPS = 10
W, H = 64, 64
# A fully-opaque square in the middle of an otherwise fully-transparent frame.
SQUARE = (16, 16, 48, 48)


def _make_rgba_frame(path):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    x0, y0, x1, y1 = SQUARE
    for y in range(y0, y1):
        for x in range(x0, x1):
            px[x, y] = (200, 40, 40, 255)
    im.save(path)


def _make_frames(tmp_path, n=3):
    paths = []
    for i in range(n):
        p = tmp_path / f"frame_{i:04d}.png"
        _make_rgba_frame(str(p))
        paths.append(str(p))
    return paths


def _probe(path):
    import av
    c = av.open(path)
    s = c.streams.video[0]
    codec = s.codec_context.name
    pix_fmt = s.codec_context.pix_fmt
    frame = next(c.decode(video=0)).to_ndarray(format="rgba")
    c.close()
    return codec, pix_fmt, frame


def _probe_alpha_aware(path):
    """Decode a WebM/VP9-alpha file with the alpha plane intact.

    NOTE: ffmpeg's default demux-then-`container.decode(video=0)` path picks
    the native "vp9" decoder, which does NOT merge the Matroska
    "BlockAdditional" alpha side-channel into the frame — it silently
    reports plain yuv420p with alpha == 255 everywhere, even though the
    alpha data is genuinely present in the file. Forcing the "libvpx-vp9"
    decoder (which does merge it) is required to actually observe alpha.
    A naive probe would produce a false negative here.
    """
    import av
    c = av.open(path)
    s = c.streams.video[0]
    codec = s.codec_context.name
    dec = av.CodecContext.create("libvpx-vp9", "r")
    frame = None
    for packet in c.demux(s):
        if packet.size <= 0:
            continue
        for f in dec.decode(packet):
            frame = f
            break
        if frame is not None:
            break
    c.close()
    assert frame is not None, "no frame decoded"
    pix_fmt = frame.format.name
    rgba = frame.to_ndarray(format="rgba")
    return codec, pix_fmt, rgba


def test_alpha_export_carries_transparency(tmp_path):
    frames = _make_frames(tmp_path)
    out_path = str(tmp_path / "out.webm")

    nt.encode_spacetype_video(frames, FPS, W, H, out_path, alpha=True)

    assert out_path.endswith(".webm")
    codec, pix_fmt, frame = _probe_alpha_aware(out_path)
    assert codec == "vp9"
    assert "a" in pix_fmt  # yuva420p carries an alpha plane

    # Outside the square: transparent.
    outside_alpha = frame[4, 4, 3]
    assert outside_alpha < 10, f"expected ~0 alpha outside the square, got {outside_alpha}"
    # Inside the square: opaque.
    inside_alpha = frame[32, 32, 3]
    assert inside_alpha > 245, f"expected ~255 alpha inside the square, got {inside_alpha}"


def test_default_export_is_unchanged(tmp_path):
    frames = _make_frames(tmp_path)
    out_path = str(tmp_path / "out.mp4")

    nt.encode_spacetype_video(frames, FPS, W, H, out_path, alpha=False)

    assert out_path.endswith(".mp4")
    codec, pix_fmt, frame = _probe(out_path)
    assert codec == "h264"
    assert pix_fmt == "yuv420p"

    # The previously-transparent region must flatten onto BLACK.
    outside_rgb = frame[4, 4, :3]
    assert outside_rgb.max() < 10, f"expected black outside the square, got {outside_rgb}"
    # The opaque square must still be visible.
    inside_rgb = frame[32, 32, :3]
    assert inside_rgb[0] > 150, f"expected the red square to survive, got {inside_rgb}"


def _probe_color_tags(path):
    """Read the stream's signalled color metadata (FFmpeg AVCOL_* enums)."""
    import av
    c = av.open(path)
    cc = c.streams.video[0].codec_context
    tags = (cc.color_range, cc.colorspace, cc.color_primaries, cc.color_trc)
    c.close()
    return tags


@pytest.mark.parametrize(
    "alpha,ext",
    [(False, "out.mp4"), (True, "out.webm")],
)
def test_export_signals_bt709_limited(tmp_path, alpha, ext):
    """Both encoders must tag BT.709 limited range.

    Without this, libswscale converts RGB->YUV with the BT.601 matrix and
    writes no color tags, so color-managed players (QuickTime/Finder/Photos)
    assume BT.709 and decode with a mismatched matrix — the exported video
    looks washed out next to the identical-pixel PNG. Regression guard for
    that fix: range=1 (MPEG/limited), matrix/primaries/trc=1 (BT.709).
    """
    frames = _make_frames(tmp_path)
    out_path = str(tmp_path / ext)

    nt.encode_spacetype_video(frames, FPS, W, H, out_path, alpha=alpha)

    color_range, matrix, primaries, trc = _probe_color_tags(out_path)
    assert color_range == 1, f"expected limited range (1), got {color_range}"
    assert matrix == 1, f"expected BT.709 matrix (1), got {matrix}"
    assert primaries == 1, f"expected BT.709 primaries (1), got {primaries}"
    assert trc == 1, f"expected BT.709 transfer (1), got {trc}"
