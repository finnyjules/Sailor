"""Keying maths for the Frame's living-image clip (scripts/clip_key.py)."""
import glob
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
ROSE = (200, 60, 90)


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
    rgb[1, 1] = ROSE
    alpha = ck.key_alpha(rgb, GREEN)
    assert alpha[0, 0] == pytest.approx(0.0)
    assert alpha[1, 1] == pytest.approx(1.0)


def test_key_alpha_is_soft_between_lo_and_hi():
    # A pixel a quarter of the way from green to rose lands strictly between 0 and 1.
    # Lab distance from pure green (0,255,0) to (50,206,22) is ~27.1 — inside the
    # default (KEY_LO=20, KEY_HI=60) ramp. Computed with ck.lab_distance, not guessed.
    rgb = np.zeros((1, 1, 3), dtype=np.uint8)
    rgb[0, 0] = (50, 206, 22)
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
    g = ck.guard_mask(still, (100, 100))   # default GUARD_FRAC 0.025 -> 2 px reach at width 100
    assert g[50, 50] == 1.0
    assert g[50, 61] == 1.0          # within 2 px of the square
    assert g[50, 70] == 0.0          # well outside


def test_guard_mask_resizes_to_the_frame_size():
    still = np.zeros((10, 10), dtype=np.uint8)
    still[:, :] = 255
    g = ck.guard_mask(still, (20, 30), frac=0.0)
    assert g.shape == (30, 20)
    assert g.min() == 1.0


def test_estimate_background_samples_the_far_pixels_and_ignores_the_subject():
    # A 32x32 frame that is (40,200,60) everywhere except a red square where the still
    # is opaque. far_mask (outside the still's silhouette by the 10% sampling margin)
    # excludes the square entirely, so the median is exactly the flat ground colour.
    w = 32
    frame = np.zeros((w, w, 3), dtype=np.uint8)
    frame[:, :] = (40, 200, 60)
    frame[8:24, 8:24] = (220, 30, 30)
    still = np.zeros((w, w, 4), dtype=np.uint8)
    still[8:24, 8:24] = (220, 30, 30, 255)
    far_mask = ck.guard_mask(still[..., 3], (w, w), frac=ck.BG_SAMPLE_FRAC) < 0.5
    bg_rgb, bg_spread = ck.estimate_background(frame, far_mask, GREEN)
    assert bg_rgb == (40, 200, 60)
    assert bg_spread < 1.0           # uniform ground -> tiny spread


def test_estimate_background_falls_back_to_the_requested_key_when_far_mask_is_tiny():
    w = 16
    frame = np.zeros((w, w, 3), dtype=np.uint8)
    far_mask = np.zeros((w, w), dtype=bool)   # 0% coverage, well under the 1% floor
    bg_rgb, bg_spread = ck.estimate_background(frame, far_mask, GREEN)
    assert bg_rgb == GREEN
    assert bg_spread == 0.0


def test_adaptive_tolerance_keys_a_shaded_gradient_ground_fully():
    # A background that shades smoothly from (30,190,50) to (60,220,80) left to right —
    # a "flat" ground the model painted with gentle lighting, not a uniform colour.
    # Sampled bg_rgb/bg_spread computed with ck.estimate_background: (44,204,64), spread
    # ~5.0 -> lo = clamp(5.0*1.2, 6, 28) = 6.0, hi = 20.0. Every background pixel keys
    # below 0.02 and every interior square pixel stays above 0.98 against those bounds.
    w = 64
    x = np.linspace(0.0, 1.0, w, dtype=np.float32)
    c0 = np.array([30, 190, 50], dtype=np.float32)
    c1 = np.array([60, 220, 80], dtype=np.float32)
    row = c0[None, :] * (1.0 - x[:, None]) + c1[None, :] * x[:, None]
    frame = np.tile(row[None, :, :], (w, 1, 1)).astype(np.uint8)
    frame[24:40, 24:40] = ROSE
    still = np.zeros((w, w, 4), dtype=np.uint8)
    still[24:40, 24:40] = (200, 60, 90, 255)

    far_mask = ck.guard_mask(still[..., 3], (w, w), frac=ck.BG_SAMPLE_FRAC) < 0.5
    bg_rgb, bg_spread = ck.estimate_background(frame, far_mask, GREEN)
    lo = ck.clamp(bg_spread * 1.2, ck.TOL_LO_MIN, ck.TOL_LO_MAX)
    hi = lo + ck.TOL_HI_MARGIN
    alpha = ck.key_alpha(frame, bg_rgb, lo, hi)

    bg_mask = np.ones((w, w), dtype=bool)
    bg_mask[24:40, 24:40] = False
    assert alpha[bg_mask].max() < 0.02
    assert alpha[24:40, 24:40].min() > 0.98


def test_olive_ring_survives_sampled_lab_key_but_the_tighter_guard_removes_it():
    # This reproduces the paid-run bug: the model painted an olive ring, (207,189,93),
    # around the subject instead of the requested green. Lab distance from the sampled
    # background (0,255,0) to that olive is ~87.7 (computed with ck.lab_distance) — far
    # past KEY_HI, so keying against the sampled colour alone does NOT make it
    # transparent; the ring would key as fully opaque (alpha 1.0) wherever the guard
    # admits it. That's the honest limit of colour-distance keying on its own.
    #
    # What DOES remove it here is guard geometry: GUARD_FRAC shrank from 0.04 to 0.025,
    # so a still that used to admit background out to a 4-px reach (at this 100-wide
    # canvas) now only admits background out to 2 px. A 2-px ring placed at
    # Chebyshev distance 3-4 from the silhouette — inside the OLD guard's reach, outside
    # the NEW one — is guard-excluded outright (guard 0.0), forcing alpha to exactly 0
    # regardless of colour, both before and after the edge erosion/soften pass.
    w = 100
    still = np.zeros((w, w, 4), dtype=np.uint8)
    still[40:60, 40:60] = (200, 60, 90, 255)
    frame = np.zeros((w, w, 3), dtype=np.uint8)
    frame[:, :] = GREEN
    frame[40:60, 40:60] = ROSE

    dr = np.abs(np.arange(w)[:, None] - np.clip(np.arange(w)[:, None], 40, 59))
    dc = np.abs(np.arange(w)[None, :] - np.clip(np.arange(w)[None, :], 40, 59))
    dist = np.maximum(dr, dc)
    ring = (dist >= 3) & (dist <= 4)
    frame[ring] = (207, 189, 93)

    # Sanity: the sampled-bg Lab distance alone would NOT key this ring away.
    ring_lab_d = ck.lab_distance(frame[ring].reshape(-1, 1, 3), GREEN)
    assert ring_lab_d.min() > ck.KEY_HI

    # Document the old, wider guard used to admit this band.
    old_guard = ck.guard_mask(still[..., 3], (w, w), frac=0.04)
    assert np.all(old_guard[ring] == 1.0)

    # The new pipeline's tighter guard excludes it, and the ring keys fully away
    # (see test_key_frames_removes_the_olive_ring_in_practice for the end-to-end check).
    new_guard = ck.guard_mask(still[..., 3], (w, w))
    assert np.all(new_guard[ring] == 0.0)


def test_key_frames_end_to_end_writes_transparent_pngs(tmp_path):
    # Three synthetic frames: a pink square on green, the square drifting right.
    frames = []
    for i in range(3):
        f = np.zeros((32, 32, 3), dtype=np.uint8); f[:, :] = GREEN
        f[8:24, 8 + i:24 + i] = ROSE
        frames.append(f)
    still = np.zeros((32, 32, 4), dtype=np.uint8); still[8:24, 8:24] = (200, 60, 90, 255)
    out = tmp_path / "clip"
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(out), max_edge=32, trim_last=False)
    assert meta == {"frames": 3, "fps": 24.0, "width": 32, "height": 32}
    im = Image.open(out / "000002.png").convert("RGBA")
    px = np.asarray(im)
    assert px[0, 0, 3] == 0            # green corner -> transparent
    assert px[16, 17, 3] == 255        # inside the drifted (16 px) square, survives the 1 px erosion
    assert (out / "clip.json").exists()


def test_key_frames_removes_the_olive_ring_in_practice(tmp_path):
    # Same ring construction as the Lab-distance test above, run through the real
    # key_frames pipeline end to end: the ring pixels come back fully transparent.
    w = 100
    still = np.zeros((w, w, 4), dtype=np.uint8)
    still[40:60, 40:60] = (200, 60, 90, 255)
    frame = np.zeros((w, w, 3), dtype=np.uint8)
    frame[:, :] = GREEN
    frame[40:60, 40:60] = ROSE
    dr = np.abs(np.arange(w)[:, None] - np.clip(np.arange(w)[:, None], 40, 59))
    dc = np.abs(np.arange(w)[None, :] - np.clip(np.arange(w)[None, :], 40, 59))
    dist = np.maximum(dr, dc)
    ring = (dist >= 3) & (dist <= 4)
    frame[ring] = (207, 189, 93)

    out = tmp_path / "clip"
    ck.key_frames([frame], 24.0, still, GREEN, str(out), max_edge=w, trim_last=False)
    im = Image.open(out / "000000.png").convert("RGBA")
    px = np.asarray(im)
    ring_alpha = px[..., 3][ring]
    assert ring_alpha.max() == 0
    assert px[50, 50, 3] == 255       # subject interior stays opaque


def test_key_frames_trim_last_drops_the_returning_frame(tmp_path):
    frames = [np.full((8, 8, 3), 255, dtype=np.uint8) for _ in range(4)]
    still = np.full((8, 8, 4), 255, dtype=np.uint8)
    meta = ck.key_frames(frames, 24.0, still, GREEN, str(tmp_path / "c"), max_edge=8, trim_last=True)
    assert meta["frames"] == 3


def test_key_then_rekey_round_trips_the_same_frame_count(tmp_path):
    import imageio.v2 as iio

    mp4 = tmp_path / "in.mp4"
    writer = iio.get_writer(str(mp4), fps=24)
    for i in range(3):
        f = np.zeros((16, 16, 3), dtype=np.uint8); f[:, :] = GREEN
        f[4:12, 4:12] = ROSE
        writer.append_data(f)
    writer.close()

    still_path = tmp_path / "still.png"
    still = np.zeros((16, 16, 4), dtype=np.uint8); still[4:12, 4:12] = (200, 60, 90, 255)
    Image.fromarray(still, "RGBA").save(still_path)

    out_dir = tmp_path / "out"
    rc = ck.main(["clip_key.py", "key", str(mp4), str(still_path), "#00ff00", str(out_dir), "0"])
    assert rc == 0
    assert (out_dir / "source.mp4").exists()
    frames_before = sorted(glob.glob(str(out_dir / "*.png")))
    assert len(frames_before) == 3

    for p in frames_before:
        os.remove(p)

    rc2 = ck.main(["clip_key.py", "rekey", str(out_dir), str(still_path), "#00ff00", "0"])
    assert rc2 == 0
    frames_after = sorted(glob.glob(str(out_dir / "*.png")))
    assert len(frames_after) == 3
