"""Keying maths for the Frame's living-image clip (scripts/clip_key.py)."""
import importlib.util
import os

import numpy as np
import pytest
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("clip_key", os.path.join(ROOT, "scripts", "clip_key.py"))
ck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ck)

GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


def rgba(w=8, h=8, colour=(200, 60, 90, 255)):
    a = np.zeros((h, w, 4), dtype=np.uint8)
    a[:, :] = colour
    return a


def test_pick_key_colour_prefers_green_for_a_pink_rose():
    assert ck.pick_key_colour(rgba()) == "#00ff00"


def test_pick_key_colour_switches_to_blue_when_leaves_are_green():
    a = rgba()
    a[0:2, :] = (30, 200, 40, 255)   # 25 % green pixels, well past the 3 % line
    assert ck.pick_key_colour(a) == "#0000ff"


def test_pick_key_colour_ignores_transparent_pixels():
    a = rgba()
    a[0:4, :] = (30, 200, 40, 0)     # green but fully transparent
    assert ck.pick_key_colour(a) == "#00ff00"


def test_flatten_onto_puts_key_behind_transparent_pixels():
    a = rgba()
    a[0, 0] = (0, 0, 0, 0)
    out = ck.flatten_onto(a, GREEN)
    assert out.shape == (8, 8, 3)
    assert tuple(out[0, 0]) == GREEN
    assert tuple(out[4, 4]) == (200, 60, 90)


def test_key_alpha_green_is_transparent_and_rose_is_opaque():
    rgb = np.zeros((2, 2, 3), dtype=np.uint8)
    rgb[0, 0] = GREEN
    rgb[1, 1] = (200, 60, 90)
    alpha = ck.key_alpha(rgb, GREEN)
    assert alpha[0, 0] == pytest.approx(0.0)
    assert alpha[1, 1] == pytest.approx(1.0)


def test_key_alpha_is_soft_between_lo_and_hi():
    # A pixel part-way between green and pink lands strictly between 0 and 1.
    rgb = np.zeros((1, 1, 3), dtype=np.uint8)
    # chroma distance from pure green ≈ 32, inside the (KEY_LO=20, KEY_HI=60) ramp → alpha ≈ 0.31
    rgb[0, 0] = (40, 230, 40)
    alpha = ck.key_alpha(rgb, GREEN)
    assert 0.0 < alpha[0, 0] < 1.0


def test_suppress_spill_pulls_green_out_of_edge_pixels_only():
    rgb = np.zeros((1, 2, 3), dtype=np.uint8)
    rgb[0, 0] = (120, 220, 120)   # spilled edge pixel
    rgb[0, 1] = (120, 220, 120)   # same colour, but fully opaque interior
    alpha = np.array([[0.5, 1.0]])
    out = ck.suppress_spill(rgb, GREEN, alpha)
    assert out[0, 0, 1] == 120       # G clamped to (R+B)/2 on the edge
    assert out[0, 1, 1] == 220       # interior untouched


def test_guard_mask_dilates_the_still_alpha_by_a_fraction_of_width():
    still = np.zeros((100, 100), dtype=np.uint8)
    still[40:60, 40:60] = 255
    g = ck.guard_mask(still, (100, 100), frac=0.04)   # 4 px reach
    assert g[50, 50] == 1.0
    assert g[50, 63] == 1.0          # within 4 px of the square
    assert g[50, 70] == 0.0          # well outside


def test_guard_mask_resizes_to_the_frame_size():
    still = np.zeros((10, 10), dtype=np.uint8)
    still[:, :] = 255
    g = ck.guard_mask(still, (20, 30), frac=0.0)
    assert g.shape == (30, 20)
    assert g.min() == 1.0


def test_key_frames_end_to_end_writes_transparent_pngs(tmp_path):
    # Three synthetic frames: a pink square on green, the square drifting right.
    frames = []
    for i in range(3):
        f = np.zeros((32, 32, 3), dtype=np.uint8); f[:, :] = GREEN
        f[8:24, 8 + i:24 + i] = (200, 60, 90)
        frames.append(f)
    still = np.zeros((32, 32, 4), dtype=np.uint8); still[8:24, 8:24] = (200, 60, 90, 255)
    out = tmp_path / "clip"
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(out), max_edge=32, trim_last=False)
    assert meta == {"frames": 3, "fps": 24.0, "width": 32, "height": 32}
    im = Image.open(out / "000002.png").convert("RGBA")
    px = np.asarray(im)
    assert px[0, 0, 3] == 0            # green corner → transparent
    assert px[16, 17, 3] == 255        # inside the drifted square → opaque
    assert (out / "clip.json").exists()


def test_key_frames_trim_last_drops_the_returning_frame(tmp_path):
    frames = [np.full((8, 8, 3), 255, dtype=np.uint8) for _ in range(4)]
    still = np.full((8, 8, 4), 255, dtype=np.uint8)
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(tmp_path / "c"), max_edge=8, trim_last=True)
    assert meta["frames"] == 3
