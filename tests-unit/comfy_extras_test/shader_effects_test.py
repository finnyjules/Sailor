"""Catalog loader, param resolution, and frame-plan tests for shader effects."""
import sys
from unittest.mock import MagicMock

sys.modules.setdefault("nodes", MagicMock())

import json

import pytest

from comfy_extras._shader_effects import frame_plan, load_catalog, resolve_params


def test_catalog_loads_and_has_spike_effects():
    cat = load_catalog(refresh=True)
    assert "noise_distortion" in cat.effects
    assert "halftone" in cat.effects
    eff = cat.effects["noise_distortion"]
    assert eff.source.startswith("#version 300 es")
    assert eff.category == "distortion"
    assert eff.params[0].uniform == "u_amount"


def test_resolve_params_defaults_overrides_and_clamps():
    cat = load_catalog(refresh=True)
    eff = cat.effects["noise_distortion"]
    # Defaults
    u = resolve_params(eff, "{}")
    assert u["u_amount"] == pytest.approx(0.06)
    # Override + clamp + unknown key ignored
    u = resolve_params(eff, json.dumps({"u_amount": 99.0, "u_bogus": 1.0}))
    assert u["u_amount"] == pytest.approx(0.3)
    assert "u_bogus" not in u


def test_resolve_params_rejects_bad_json():
    cat = load_catalog(refresh=True)
    with pytest.raises(ValueError, match="params"):
        resolve_params(cat.effects["halftone"], "{not json")


def test_frame_plan_semantics():
    # Still + no duration -> one frame at `time`
    assert frame_plan(1, 2.5, 0.0, 24) == [(0, 2.5)]
    # Still + duration -> duration*fps frames advancing from `time`
    plan = frame_plan(1, 0.0, 1.0, 4)
    assert plan == [(0, 0.0), (0, 0.25), (0, 0.5), (0, 0.75)]
    # Batch input -> one output frame per input frame, duration ignored
    plan = frame_plan(3, 1.0, 99.0, 2)
    assert plan == [(0, 1.0), (1, 1.5), (2, 2.0)]


import numpy as np

from comfy_extras._shader_effects import render_effect

_UNIFORM_MIX_FRAG = """#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_mix;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() {
    vec3 col = texture(u_image0, v_texCoord).rgb;
    fragColor0 = vec4(mix(col, vec3(u_time), u_mix), 1.0);
}
"""


def _img(w=32, h=32, value=0.25):
    return np.full((h, w, 3), value, dtype=np.float32)


def test_render_effect_named_uniforms_and_passthrough():
    # u_mix=0 -> passthrough
    outs = render_effect(_UNIFORM_MIX_FRAG, 32, 32, [{"image": _img(), "uniforms": {"u_mix": 0.0, "u_time": 0.0}}])
    assert len(outs) == 1 and outs[0].shape == (32, 32, 4)
    assert np.abs(outs[0][..., :3] - 0.25).max() < 1.0 / 255.0


def test_render_effect_per_job_uniforms_differ():
    jobs = [
        {"image": _img(), "uniforms": {"u_mix": 1.0, "u_time": 0.0}},
        {"image": _img(), "uniforms": {"u_mix": 1.0, "u_time": 1.0}},
    ]
    outs = render_effect(_UNIFORM_MIX_FRAG, 32, 32, jobs)
    assert np.abs(outs[0][..., :3] - 0.0).max() < 1.0 / 255.0
    assert np.abs(outs[1][..., :3] - 1.0).max() < 1.0 / 255.0


def test_render_effect_compile_error_raises_with_log():
    import pytest
    with pytest.raises(RuntimeError, match="(?i)compil"):
        render_effect("#version 300 es\nvoid main() { bogus }", 8, 8, [{"image": _img(8, 8), "uniforms": {}}])


def test_render_effect_extra_texture_binds():
    frag = """#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_lut;
uniform vec2 u_resolution;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() { fragColor0 = vec4(texture(u_lut, v_texCoord).rgb, 1.0); }
"""
    lut = np.zeros((4, 4, 4), dtype=np.float32)
    lut[..., 1] = 1.0  # green
    lut[..., 3] = 1.0
    outs = render_effect(frag, 16, 16, [{"image": _img(16, 16), "uniforms": {}}], extra_textures={"u_lut": lut})
    assert np.abs(outs[0][..., 1] - 1.0).max() < 1.0 / 255.0
    assert np.abs(outs[0][..., 0]).max() < 1.0 / 255.0


def test_render_effect_none_image_reuses_previous_frame():
    jobs = [
        {"image": _img(value=0.5), "uniforms": {"u_mix": 0.0, "u_time": 0.0}},
        {"image": None, "uniforms": {"u_mix": 0.0, "u_time": 0.0}},
    ]
    outs = render_effect(_UNIFORM_MIX_FRAG, 32, 32, jobs)
    assert np.abs(outs[1][..., :3] - 0.5).max() < 1.0 / 255.0


def test_render_effect_first_job_requires_image():
    import pytest
    with pytest.raises(ValueError, match="first job"):
        render_effect(_UNIFORM_MIX_FRAG, 32, 32, [{"image": None, "uniforms": {}}])


def test_resolve_params_coerces_non_numeric_to_default():
    cat = load_catalog(refresh=True)
    eff = cat.effects["noise_distortion"]
    u = resolve_params(eff, json.dumps({"u_amount": "bad"}))
    assert u["u_amount"] == pytest.approx(0.06)


import torch

from comfy_extras.nodes_shader_effects import ShaderEffect


def _run_node(image, effect="noise_distortion", params="{}", time=0.0, duration=0.0, fps=4, seed=42, resolution=768, aspect="1:1"):
    # Execute the classmethod directly; hidden unique_id is only used for the ui preview.
    class _Hidden:
        unique_id = "test"
    ShaderEffect.hidden = _Hidden
    return ShaderEffect.execute(effect, params, time, duration, fps, seed, resolution, aspect, image=image)


def test_node_still_returns_single_frame():
    img = torch.rand(1, 48, 64, 3)
    out = _run_node(img).args[0]
    assert out.shape == (1, 48, 64, 3)


def test_node_duration_returns_frame_batch_that_animates():
    img = torch.rand(1, 32, 32, 3)
    out = _run_node(img, duration=1.0, fps=4).args[0]
    assert out.shape == (4, 32, 32, 3)
    assert (out[0] - out[3]).abs().max() > 1.0 / 255.0  # noise_distortion is animated


def test_node_batch_input_keeps_frame_count():
    img = torch.rand(3, 32, 32, 3)
    out = _run_node(img, duration=99.0).args[0]  # duration must be ignored
    assert out.shape == (3, 32, 32, 3)


def test_node_unknown_effect_raises():
    import pytest
    with pytest.raises(ValueError, match="bogus"):
        _run_node(torch.rand(1, 16, 16, 3), effect="bogus")


def test_node_frame_cap_guards_memory():
    import pytest
    with pytest.raises(ValueError, match="frames requested"):
        _run_node(torch.rand(1, 16, 16, 3), duration=60.0, fps=60)


from comfy_extras.nodes_shader_effects import catalog_payload


def test_catalog_payload_inlines_sources():
    payload = catalog_payload()
    assert payload["version"] == 1
    by_id = {e["id"]: e for e in payload["effects"]}
    assert by_id["halftone"]["source"].startswith("#version 300 es")
    assert by_id["halftone"]["params"][0]["uniform"] == "u_size"
    assert by_id["noise_distortion"]["animated"] is True


import os


def test_server_render_matches_goldens():
    """Catches shader regressions; loops the whole catalog so new effects are auto-covered."""
    from PIL import Image

    golden_dir = os.path.join(os.path.dirname(__file__), "..", "shaderfx_golden")
    catalog = load_catalog(refresh=True)
    for size in (128, 256):
        fixture = np.asarray(
            Image.open(os.path.join(golden_dir, f"fixture_{size}.png")).convert("RGB"),
            dtype=np.float32) / 255.0
        for eff in catalog.effects.values():
            golden_path = os.path.join(golden_dir, f"{eff.id}_{size}.png")
            assert os.path.isfile(golden_path), f"missing golden for {eff.id} at {size} — run generate_goldens.py"
            golden = np.asarray(Image.open(golden_path).convert("RGB"), dtype=np.float32) / 255.0
            uniforms = resolve_params(eff, "{}")
            textures = {}
            for t in eff.textures:
                from comfy_extras._shader_effects import ASSETS_DIR
                tex = Image.open(os.path.join(ASSETS_DIR, t["file"])).convert("RGBA")
                textures[t["uniform"]] = np.asarray(tex, dtype=np.float32) / 255.0
                for k, v in t.get("extraUniforms", {}).items():
                    uniforms[k] = float(v)
            jobs = [{"image": fixture, "uniforms": {**uniforms, "u_time": 0.7, "u_seed": 42.0, "u_hasInput": 1.0}}]
            out = render_effect(eff.source, size, size, jobs, extra_textures=textures, passes=eff.passes)[0][..., :3]
            diff = np.abs(out - golden)
            assert diff.max() <= 2.0 / 255.0, f"{eff.id}@{size}: max diff {diff.max() * 255:.2f}/255"


from comfy_extras.nodes_shader_effects import _aspect_size


def test_aspect_size_longest_edge_and_even():
    assert _aspect_size(768, "1:1") == (768, 768)
    assert _aspect_size(768, "16:9") == (768, 432)
    assert _aspect_size(768, "9:16") == (432, 768)
    w, h = _aspect_size(770, "3:2")
    assert w % 2 == 0 and h % 2 == 0


def test_node_no_image_non_generative_raises():
    import pytest
    class _Hidden:
        unique_id = "test"
    ShaderEffect.hidden = _Hidden
    with pytest.raises(ValueError, match="needs an image input"):
        ShaderEffect.execute("halftone", "{}", 0.0, 0.0, 24, 42, 768, "1:1", image=None)


def test_node_generative_no_image_renders_at_aspect():
    """Generative effect with no input image synthesizes at resolution/aspect."""
    class _Hidden:
        unique_id = "test"
    ShaderEffect.hidden = _Hidden
    out = ShaderEffect.execute("aurora", "{}", 0.7, 0.0, 24, 42, 512, "16:9", image=None).args[0]
    assert out.shape == (1, 288, 512, 3)   # 512 longest edge, 16:9


def test_catalog_payload_includes_generative():
    payload = catalog_payload()
    assert all("generative" in e for e in payload["effects"])
    by_id = {e["id"]: e for e in payload["effects"]}
    assert by_id["aurora"]["generative"] is True       # synthesizes, no input needed
    assert by_id["halftone"]["generative"] is False    # image-processing effect


_TWO_PASS_FRAG = """#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() {
    if (u_pass < 0.5) fragColor0 = vec4(vec3(0.5), 1.0);
    else fragColor0 = vec4(texture(u_image0, v_texCoord).rgb + 0.25, 1.0);
}
"""

_SOURCE_FRAG = """#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() {
    if (u_pass < 0.5) fragColor0 = vec4(0.0, 0.0, 0.0, 1.0);
    else fragColor0 = texture(u_source, v_texCoord);
}
"""


def test_render_effect_multipass_pingpong():
    img = _img(16, 16, 0.1)
    outs = render_effect(_TWO_PASS_FRAG, 16, 16, [{"image": img, "uniforms": {}}], passes=2)
    # pass0 -> 0.5; pass1 reads pass0 via u_image0 and adds 0.25 -> ~0.75
    assert np.abs(outs[0][..., :3] - 0.75).max() < 2.0 / 255.0


def test_render_effect_u_source_persists():
    img = _img(16, 16, 0.4)
    outs = render_effect(_SOURCE_FRAG, 16, 16, [{"image": img, "uniforms": {}}], passes=2)
    # pass1 reads u_source (original 0.4), not the black pass0 output
    assert np.abs(outs[0][..., :3] - 0.4).max() < 2.0 / 255.0


_FLAG_BAND = 8  # pixels sampled at each edge; s stays < 0.04 there so env ~ 0


def _flag_edge_diffs(anchor, anchored_band, free_band):
    """Render `flag` on the 256 fixture and return (anchored, free) mean abs diffs."""
    from PIL import Image

    golden_dir = os.path.join(os.path.dirname(__file__), "..", "shaderfx_golden")
    fixture = np.asarray(
        Image.open(os.path.join(golden_dir, "fixture_256.png")).convert("RGB"),
        dtype=np.float32) / 255.0
    eff = load_catalog(refresh=True).effects["flag"]
    uniforms = resolve_params(eff, json.dumps({"u_anchor": anchor}))
    jobs = [{"image": fixture, "uniforms": {**uniforms, "u_time": 0.7, "u_seed": 42.0}}]
    out = render_effect(eff.source, 256, 256, jobs, passes=eff.passes)[0][..., :3]
    diff = np.abs(out - fixture)
    return float(diff[anchored_band].mean()), float(diff[free_band].mean())


@pytest.mark.parametrize("anchor,anchored_band,free_band", [
    pytest.param(3, np.s_[:_FLAG_BAND, :], np.s_[-_FLAG_BAND:, :], id="top"),
    pytest.param(4, np.s_[-_FLAG_BAND:, :], np.s_[:_FLAG_BAND, :], id="bottom"),
    pytest.param(1, np.s_[:, :_FLAG_BAND], np.s_[:, -_FLAG_BAND:], id="left"),
    pytest.param(2, np.s_[:, -_FLAG_BAND:], np.s_[:, :_FLAG_BAND], id="right"),
])
def test_flag_anchor_pins_the_anchored_edge(anchor, anchored_band, free_band):
    """Regression for 2cd3ee3bd: the pipeline y-flip (img[::-1] on upload and
    readback) had Top/Bottom anchors inverted. Output rows are image-convention
    (row 0 = visual top), so anchor=Top must leave the TOP rows undistorted and
    displace the bottom; the golden gate only bakes the default anchor (Left)
    and would not catch this reappearing."""
    anchored, free = _flag_edge_diffs(anchor, anchored_band, free_band)
    assert anchored < 0.005, f"anchored edge moved: mean diff {anchored:.5f}"
    assert free > 0.01, f"free edge barely moved: mean diff {free:.5f}"


def test_holographic_surface_is_generative_and_declares_its_uniforms():
    """The generative twin of `holographic`. Its whole reason to exist is that it
    needs no input, so `generative` being True is load-bearing, not decoration."""
    cat = load_catalog(refresh=True)
    eff = cat.effects["holographic_surface"]
    assert eff.generative is True
    assert eff.category == "generative"
    assert eff.source.startswith("#version 300 es")
    # Every declared param must exist as a uniform in the shader: a param the GLSL
    # never reads is a dead control the UI still shows.
    for p in eff.params:
        assert f"uniform float {p.uniform};" in eff.source or f"uniform vec3  {p.uniform};" in eff.source \
            or f"uniform vec3 {p.uniform};" in eff.source, \
            f"{p.uniform} is declared in the manifest but not read by the shader"
    # ...and the four surfaces the manifest advertises must all be reachable.
    surface = next(p for p in eff.params if p.uniform == "u_surface")
    assert [o["value"] for o in surface.options] == [0, 1, 2, 3]


def test_holographic_surface_never_samples_the_input_for_its_normal():
    """The bug this effect exists to fix: `holographic` builds its normal from the
    input's luminance gradient, so a flat fill renders flat. The only permitted
    read of u_image0 here is the final optional blend-back."""
    eff = load_catalog(refresh=True).effects["holographic_surface"]
    assert eff.source.count("texture(u_image0") == 1
    tail = eff.source.split("texture(u_image0")[0]
    assert "u_hasInput > 0.5 && u_mix > 0.0" in tail[-200:], \
        "the sole u_image0 read is not gated on u_hasInput and u_mix"
