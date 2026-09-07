"""
Cloner Vary: the cross-language parity gate.

`expandClones` (frontend/app/composables/useCloner.ts, over
frontend/app/lib/vary/index.ts) is the single source of truth for per-copy
variation. `_expand_clones` in comfy_extras/nodes_compositor.py is its mirror, so
a wired server render matches the preview the graph was authored in.

Nothing here is anchored to Python's own output. Every expected value comes from
the TypeScript side:

  * `REFERENCE_HASHES` is read out of frontend/tests/unit/vary.unit.spec.ts at
    test time, not copied, so the two files cannot drift apart silently.
  * The whole-cloner expectations are read from
    frontend/tests/fixtures/cloner-vary-parity.json, which is written by running
    the REAL `expandClones` (see tests/unit/cloner-vary-parity.unit.spec.ts).
    That spec fails if TypeScript changes without regenerating, and regenerating
    fails this file until Python is mirrored.
  * The remaining literals are the exact assertions made in
    frontend/tests/unit/vary.unit.spec.ts, quoted case for case.

Run:  .venv/bin/python -m pytest tests-unit/comfy_extras_test/cloner_vary_test.py -v
"""
import importlib.util
import json
import math
import os
import re
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VARY_SPEC = os.path.join(REPO_ROOT, "frontend", "tests", "unit", "vary.unit.spec.ts")
PARITY_FIXTURE = os.path.join(REPO_ROOT, "frontend", "tests", "fixtures", "cloner-vary-parity.json")

# Every quantity that reaches libm in EITHER language: `Math.pow`/`**` for the
# step falloff (whose exponent is now `k * weight`, and so fractional in random
# and falloff modes) and `Math.cos`/`Math.sin` for the radial ring. V8 and CPython
# do not promise bit-identical results for those, and a byte-for-byte assertion
# would eventually flake on a machine or a runtime we did not test on.
#
# 1e-12 is ~4 orders of magnitude above the few-ULP (~1e-16 relative) disagreement
# libm implementations actually exhibit, and ~9 orders BELOW the smallest
# divergence a real mirroring mistake produces (a wrong weight, a wrong exponent
# or a wrong enumeration order moves these numbers in the third decimal or worse).
# So it absorbs the noise without absorbing a bug.
#
# The integer hash, the weights and the tints are NOT covered by it — they are
# asserted exactly, because they come out of integer and exactly-rounded IEEE
# operations that both languages must reproduce bit for bit.
LIBM_TOL = 1e-12


def _mod():
    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)
    spec = importlib.util.spec_from_file_location(
        "nodes_compositor", os.path.join(REPO_ROOT, "comfy_extras", "nodes_compositor.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _reference_hashes():
    """The values the TypeScript side pinned. Read from the spec file itself so
    the two can never drift apart silently."""
    src = open(VARY_SPEC).read()
    m = re.search(r"const REFERENCE_HASHES: number\[\] = \[([^\]]*)\]", src)
    assert m, "REFERENCE_HASHES not found in vary.unit.spec.ts"
    return [float(x) for x in m.group(1).replace("\n", "").split(",") if x.strip()]


def _settings(**over):
    """The shared VarySettings shape, mirroring DEFAULT_VARY in lib/vary."""
    v = {
        "mode": "sequence", "seed": 0, "falloffCenter": 0.0, "falloffRadius": 0.5,
        "colorEnabled": False, "palette": ["#4c6ef5", "#f59f00"],
        "spread": "cycle", "strength": 1.0,
    }
    v.update(over)
    return v


# ── hash32 ────────────────────────────────────────────────────────────────────

def test_hash32_matches_the_pinned_typescript_reference():
    m = _mod()
    ref = _reference_hashes()
    assert len(ref) == 4, "expected four pinned values in vary.unit.spec.ts"
    # The spec pins `Number(hash32(i, 7).toFixed(9))`; round the same way.
    got = [float("%.9f" % m._hash32(i, 7)) for i in range(4)]
    assert got == ref


def test_hash32_is_in_range_and_stable():
    m = _mod()
    for i in range(50):
        h = m._hash32(i, 3)
        assert 0.0 <= h < 1.0
    assert m._hash32(3, 7) == m._hash32(3, 7)


def test_hash32_decorrelates_neighbouring_indexes_and_seeds():
    m = _mod()
    assert m._hash32(3, 7) != m._hash32(4, 7)
    assert m._hash32(3, 7) != m._hash32(3, 8)


def test_hash32_handles_negative_and_fractional_inputs_like_js():
    """`Math.trunc(x) | 0` truncates toward zero then wraps to int32; Python has
    to reach the same 32-bit pattern rather than an arbitrary-precision one."""
    m = _mod()
    assert m._hash32(3.7, 7) == m._hash32(3, 7)          # Math.trunc
    assert 0.0 <= m._hash32(-4, -11) < 1.0               # two's complement, no crash


# ── varyWeights ───────────────────────────────────────────────────────────────

def test_single_copy_is_weight_zero_in_every_mode():
    m = _mod()
    for mode in ("sequence", "random", "falloff"):
        assert m._vary_weights([0], _settings(mode=mode)) == [0]


def test_sequence_ramps_zero_to_one_across_the_step_range():
    m = _mod()
    assert m._vary_weights([0, 1, 2, 3], _settings()) == [0, 1 / 3, 2 / 3, 1]


def test_sequence_gives_mirrored_twins_the_same_weight():
    m = _mod()
    w = m._vary_weights([0, 1, 1, 2], _settings())
    assert w[1] == w[2]
    assert w[3] == 1


def test_random_is_inside_the_unit_range_and_reshuffles_with_the_seed():
    m = _mod()
    a = m._vary_weights([0, 1, 2, 3], _settings(mode="random", seed=1))
    b = m._vary_weights([0, 1, 2, 3], _settings(mode="random", seed=2))
    for x in a:
        assert 0.0 <= x < 1.0
    assert a != b


def test_random_hashes_by_array_position_not_by_step_value():
    """Deliberately unlike the ordered drivers: two mirrored copies share a step
    but must NOT share a draw, or the mode reads as a pattern."""
    m = _mod()
    w = m._vary_weights([0, 1, 1, 2], _settings(mode="random", seed=7))
    assert w[1] != w[2]
    assert w == [m._hash32(i, 7) for i in range(4)]


def test_falloff_peaks_at_the_centre_and_reaches_zero_past_the_radius():
    m = _mod()
    w = m._vary_weights([0, 1, 2, 3], _settings(mode="falloff", falloffCenter=0, falloffRadius=0.5))
    assert w[0] == 1
    assert w[3] == 0
    assert w[1] > w[2]


def test_falloff_centred_mid_array_peaks_in_the_middle():
    m = _mod()
    w = m._vary_weights([0, 1, 2, 3, 4], _settings(mode="falloff", falloffCenter=0.5, falloffRadius=1))
    assert w[2] == 1
    assert w[0] == pytest.approx(w[4], abs=1e-10)
    assert w[0] < w[2]


# ── varyColorAt / varyStepFactor / mixHex ─────────────────────────────────────

PAL = ["#ff0000", "#00ff00", "#0000ff"]


def test_colour_is_none_when_disabled():
    m = _mod()
    assert m._vary_color_at(0.5, 1, _settings(palette=PAL)) is None


def test_colour_is_none_for_an_emptied_palette_even_when_enabled():
    m = _mod()
    assert m._vary_color_at(0.5, 1, _settings(colorEnabled=True, palette=[])) is None


def test_cycle_in_sequence_mode_walks_the_palette_by_index():
    m = _mod()
    v = _settings(colorEnabled=True, palette=PAL, spread="cycle")
    assert m._vary_color_at(0, 0, v) == "#ff0000"
    assert m._vary_color_at(0, 1, v) == "#00ff00"
    assert m._vary_color_at(0, 3, v) == "#ff0000"


def test_cycle_in_random_mode_picks_by_weight_never_out_of_range():
    m = _mod()
    v = _settings(mode="random", colorEnabled=True, palette=PAL, spread="cycle")
    assert m._vary_color_at(0, 0, v) == "#ff0000"
    assert m._vary_color_at(0.999999, 0, v) == "#0000ff"
    assert m._vary_color_at(1, 0, v) == "#0000ff"


def test_blend_hits_the_palette_ends_exactly_and_interpolates_between():
    m = _mod()
    v = _settings(colorEnabled=True, palette=PAL, spread="blend")
    assert m._vary_color_at(0, 0, v) == "#ff0000"
    assert m._vary_color_at(1, 2, v) == "#0000ff"
    assert m._vary_color_at(0.5, 1, v) == "#00ff00"


def test_step_factor_is_one_in_sequence_mode_regardless_of_weight():
    m = _mod()
    assert m._vary_step_factor(0, _settings()) == 1
    assert m._vary_step_factor(0.4, _settings()) == 1


def test_step_factor_is_the_weight_in_the_other_modes():
    m = _mod()
    assert m._vary_step_factor(0.4, _settings(mode="random")) == 0.4
    assert m._vary_step_factor(0.4, _settings(mode="falloff")) == 0.4


def test_mix_hex_endpoints_and_midpoint():
    m = _mod()
    assert m._mix_hex("#ff0000", "#0000ff", 0.0) == "#ff0000"
    assert m._mix_hex("#ff0000", "#0000ff", 1.0) == "#0000ff"
    assert m._mix_hex("#000000", "#ffffff", 0.5) == "#808080"


def test_hex_to_rgb_accepts_short_and_alpha_hex_like_the_client():
    m = _mod()
    assert m._hex_to_rgb("#abc") == (0xAA, 0xBB, 0xCC)
    assert m._hex_to_rgb("#4c6ef580") == (0x4C, 0x6E, 0xF5)   # StudioColor emits 8-digit
    assert m._hex_to_rgb("nonsense") == (0, 0, 0)


# ── varyOf ────────────────────────────────────────────────────────────────────

def test_vary_of_substitutes_the_default_palette_only_for_a_missing_field():
    m = _mod()
    assert m._vary_of({})["palette"] == ["#4c6ef5", "#f59f00"]


def test_vary_of_honours_a_deliberately_emptied_palette():
    m = _mod()
    v = m._vary_of({"varyColor": True, "varyPalette": []})
    assert v["palette"] == []
    assert m._vary_color_at(0.5, 0, v) is None


def test_vary_of_replaces_a_non_finite_number_with_its_default():
    """The client's `finite()` chokepoint: a cleared number field arrives as NaN
    and would otherwise slide straight through clamp01 into the step maths."""
    m = _mod()
    v = m._vary_of({"varyFalloffRadius": float("nan"), "varyColorStrength": None,
                    "varySeed": "not a number"})
    assert v["falloffRadius"] == 0.5
    assert v["strength"] == 1
    assert v["seed"] == 0


# ── _expand_clones: the whole-cloner cross-language fixture ───────────────────

def _base():
    """Identity base layer; only the transform fields matter for cloner maths."""
    return {"image": None, "x": 0.0, "y": 0.0, "rot": 0.0, "scl": 1.0,
            "op": 1.0, "blend": "normal", "z": 1.0}


def _fixture():
    with open(PARITY_FIXTURE) as f:
        return json.load(f)


def _num(v):
    """JSON has no NaN; the generator writes it as a string."""
    return float(v) if isinstance(v, str) else v


def _close(actual, expected, what):
    e = _num(expected)
    if isinstance(e, float) and math.isnan(e):
        assert math.isnan(actual), f"{what}: expected NaN, got {actual}"
        return
    assert actual == pytest.approx(e, rel=LIBM_TOL, abs=LIBM_TOL), what


@pytest.mark.parametrize("case", _fixture()["cases"], ids=lambda c: c["name"])
def test_expand_clones_matches_the_typescript_fixture(case):
    m = _mod()
    out = m._expand_clones(_base(), case["cloner"], case["aspect"])
    exp = case["expected"]
    assert len(out) == len(exp), f"{case['name']}: clone count"

    for i, (got, want) in enumerate(zip(out, exp)):
        where = f"{case['name']} copy {i}"
        # Transcendental-derived: tolerance (see LIBM_TOL).
        _close(got["x"], want["dx"], f"{where} x")
        _close(got["y"], want["dy"], f"{where} y")
        _close(got["rot"], want["drot"], f"{where} rot")
        _close(got["scl"], want["dscale"], f"{where} scl")
        _close(got["op"], want["dopacity"], f"{where} op")
        # Exact: integer hash, exact IEEE arithmetic, string lookup.
        assert got["_weight"] == _num(want["weight"]), f"{where} weight"
        assert got["_tint"] == want["tint"], f"{where} tint"
        assert got["_tint_strength"] == _num(want["tintStrength"]), f"{where} tint strength"


# ── zero-change: an existing workflow must composite exactly as before ────────

def NO_VARY():
    """A cloner saved BEFORE Vary existed: not one vary key in the JSON."""
    return {"enabled": True, "mode": "linear", "countX": 3, "countY": 1,
            "spacingX": 0.2, "spacingY": 0.0, "mirrorX": False, "mirrorY": False,
            "nudgeX": 0.0, "nudgeY": 0.0, "staggerX": 0.0, "staggerY": 0.0,
            "stepRotation": 10.0, "stepScale": 0.5, "stepOpacity": 0.9}


def test_a_disabled_cloner_returns_the_layer_untouched():
    m = _mod()
    base = _base()
    assert m._expand_clones(base, None, 1.0) == [base]
    assert m._expand_clones(base, {"enabled": False, "countX": 3}, 1.0) == [base]


def test_a_pre_vary_cloner_still_produces_its_exact_old_numbers():
    """Literal values, not a comparison against another run of the same code."""
    m = _mod()
    out = m._expand_clones(_base(), NO_VARY(), 1.0)
    # Back-to-front: the original (k=0) is LAST.
    assert [l["scl"] for l in out] == [0.25, 0.5, 1.0]
    assert [l["rot"] for l in out] == [20.0, 10.0, 0.0]
    assert [l["op"] for l in out] == [0.81, 0.9, 1.0]
    assert all(l["_tint"] is None for l in out)


def test_adding_the_explicit_vary_defaults_changes_nothing():
    m = _mod()
    old = m._expand_clones(_base(), NO_VARY(), 1.0)
    defaulted = dict(NO_VARY())
    defaulted.update({"varyMode": "sequence", "varySeed": 0, "varyFalloffCenter": 0.0,
                      "varyFalloffRadius": 0.5, "varyColor": False,
                      "varyPalette": ["#4c6ef5", "#f59f00"],
                      "varyColorSpread": "cycle", "varyColorStrength": 1.0})
    assert m._expand_clones(_base(), defaulted, 1.0) == old


# ── the tint itself ───────────────────────────────────────────────────────────

def test_tint_is_a_straight_srgb_lerp_that_preserves_alpha():
    """Mirrors tintScratch()'s `source-atop` fill at globalAlpha = strength:
    out.rgb = strength*tint + (1-strength)*src.rgb, out.a = src.a."""
    import torch
    m = _mod()
    rgb = torch.tensor([[[[0.0]], [[0.4]], [[1.0]]]])          # [1,3,1,1]
    out = m._tint_rgb(rgb, "#ff0000", 0.25)
    assert out[0, 0, 0, 0] == pytest.approx(0.25 * 1.0 + 0.75 * 0.0)
    assert out[0, 1, 0, 0] == pytest.approx(0.75 * 0.4)
    assert out[0, 2, 0, 0] == pytest.approx(0.75 * 1.0)


def test_tint_is_a_no_op_at_strength_zero_or_without_a_colour():
    import torch
    m = _mod()
    rgb = torch.rand(1, 3, 2, 2)
    assert m._tint_rgb(rgb, "#ff0000", 0.0) is rgb
    assert m._tint_rgb(rgb, "#ff0000", float("nan")) is rgb
    assert m._tint_rgb(rgb, None, 1.0) is rgb


def test_a_tinted_clone_reaches_the_composite():
    """End to end through _prep_layer: the key _expand_clones writes has to be the
    key the paste site reads, or the whole feature is silently inert server-side."""
    import torch
    m = _mod()
    img = torch.ones(1, 4, 4, 3) * 0.5                          # [B,H,W,C] mid grey
    layer = {"image": img, "x": 0.0, "y": 0.0, "rot": 0.0, "scl": 1.0, "op": 1.0,
             "blend": "normal", "z": 1.0}
    plain, _ = m._prep_layer(dict(layer), 4, 4)
    tinted, _ = m._prep_layer({**layer, "_tint": "#ff0000", "_tint_strength": 1.0}, 4, 4)
    assert plain[0, 0, 2, 2] == pytest.approx(0.5)
    assert tinted[0, 0, 2, 2] == pytest.approx(1.0)             # R washed to the tint
    assert tinted[0, 1, 2, 2] == pytest.approx(0.0)


def test_a_non_finite_clone_transform_is_dropped_rather_than_poisoning_the_canvas():
    """JS's Math.pow gives NaN for a negative base under a fractional exponent and
    the copy simply fails to draw. Python must reach the same VISIBLE result: one
    NaN reaching grid_sample would blank the entire composite, not one copy."""
    import torch
    m = _mod()
    img = torch.ones(1, 4, 4, 3)
    good = {"image": img, "x": 0.0, "y": 0.0, "rot": 0.0, "scl": 1.0, "op": 1.0,
            "blend": "normal", "z": 1.0}
    bad = {**good, "scl": float("nan"), "z": 0.0}
    out = m._composite_layers([good, bad], 4, 4)
    assert torch.isfinite(out).all()
    assert out[0, 0, 2, 2] == pytest.approx(1.0)
