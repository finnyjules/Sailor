import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("nodes", MagicMock())

import comfy_extras._shader_effects as sfx
from comfy_extras._shader_effects import EffectParam, Effect, resolve_params, load_catalog


def _enum_effect():
    p_enum = EffectParam(
        uniform="u_pattern", label="Pattern", type="enum", default=1.0,
        options=[{"label": "A", "value": 0}, {"label": "B", "value": 1}, {"label": "C", "value": 2}],
    )
    p_float = EffectParam(uniform="u_scale", label="Scale", type="float", min=1.0, max=10.0, default=4.0, step=1.0)
    return Effect(id="t", name="T", category="stylize", animated=False, passes=1,
                  center_param=None, textures=[], params=[p_enum, p_float], source="")


def test_enum_default_when_missing():
    out = resolve_params(_enum_effect(), "{}")
    assert out["u_pattern"] == 1.0
    assert out["u_scale"] == 4.0


def test_enum_keeps_valid_value():
    out = resolve_params(_enum_effect(), '{"u_pattern": 2}')
    assert out["u_pattern"] == 2.0


def test_enum_falls_back_to_default_on_invalid():
    out = resolve_params(_enum_effect(), '{"u_pattern": 99}')
    assert out["u_pattern"] == 1.0


def test_float_still_clamps():
    out = resolve_params(_enum_effect(), '{"u_scale": 999}')
    assert out["u_scale"] == 10.0


# ── load_catalog enum integration tests ────────────────────────────────────────

def test_load_catalog_accepts_bayer_dither_enum():
    """The real manifest's bayer_dither effect has a u_pattern enum — catalog loads cleanly."""
    catalog = load_catalog(refresh=True)
    assert "bayer_dither" in catalog.effects, "bayer_dither not found in catalog"
    effect = catalog.effects["bayer_dither"]
    pattern_param = next((p for p in effect.params if p.uniform == "u_pattern"), None)
    assert pattern_param is not None, "u_pattern param not found on bayer_dither"
    assert pattern_param.type == "enum"
    assert len(pattern_param.options) == 12
    assert pattern_param.default == 1


def _write_catalog(dirpath, param):
    """Write a minimal one-effect manifest + its .frag into dirpath."""
    with open(os.path.join(dirpath, "foo.frag"), "w", encoding="utf-8") as f:
        f.write("#version 300 es\nvoid main(){}\n")
    manifest = {
        "version": 1,
        "effects": [{
            "id": "foo", "name": "Foo", "category": "stylize", "animated": False,
            "passes": 1, "centerParam": None, "textures": [], "params": [param],
        }],
    }
    with open(os.path.join(dirpath, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)


def test_load_catalog_rejects_enum_default_not_in_options(tmp_path, monkeypatch):
    """load_catalog raises when an enum param's default isn't one of its options."""
    _write_catalog(tmp_path, {
        "uniform": "u_pattern", "label": "Pattern", "type": "enum", "default": 99,
        "options": [{"label": "A", "value": 0}, {"label": "B", "value": 1}],
    })
    # monkeypatch restores CATALOG_DIR + the _catalog cache after the test, so the
    # real catalog is intact for other tests in the session.
    monkeypatch.setattr(sfx, "CATALOG_DIR", str(tmp_path))
    monkeypatch.setattr(sfx, "_catalog", None)
    with pytest.raises(ValueError, match="enum default"):
        load_catalog(refresh=True)


def test_load_catalog_accepts_valid_enum_default(tmp_path, monkeypatch):
    """A well-formed enum param (default in options) loads cleanly."""
    _write_catalog(tmp_path, {
        "uniform": "u_pattern", "label": "Pattern", "type": "enum", "default": 1,
        "options": [{"label": "A", "value": 0}, {"label": "B", "value": 1}],
    })
    monkeypatch.setattr(sfx, "CATALOG_DIR", str(tmp_path))
    monkeypatch.setattr(sfx, "_catalog", None)
    catalog = load_catalog(refresh=True)
    assert catalog.effects["foo"].params[0].type == "enum"


# ── catalog_payload camelCase round-trip ────────────────────────────────────────
# The manifest declares camelCase keys (showWhen, maxStops); the loader renames
# them to snake_case dataclass fields; the payload MUST rename them back, or the
# browser (which reads p.showWhen / p.maxStops) silently sees `undefined` and the
# visibility gate never fires. Regression for that serialisation gap.

def test_catalog_payload_camelcases_param_keys():
    from comfy_extras.nodes_shader_effects import catalog_payload

    payload = catalog_payload()
    cp = next(e for e in payload["effects"] if e["id"] == "crystal_prism")
    facet = next(p for p in cp["params"] if p["uniform"] == "u_facetStyle")
    # showWhen restored to camelCase, snake_case NOT leaked
    assert "showWhen" in facet, "payload must emit camelCase showWhen"
    assert "show_when" not in facet, "snake_case show_when must not leak to the client"
    assert facet["showWhen"] == {"uniform": "u_mode", "equals": 1}
    # same guarantee for the sibling alias
    assert "maxStops" in facet and "max_stops" not in facet


def test_catalog_payload_omits_gate_key_shape_for_ungated():
    """An ungated param still round-trips (showWhen present but null), so the
    key name is camelCase regardless of value."""
    from comfy_extras.nodes_shader_effects import catalog_payload

    payload = catalog_payload()
    # u_mode itself (the gate driver) has no showWhen of its own
    cp = next(e for e in payload["effects"] if e["id"] == "crystal_prism")
    mode = next(p for p in cp["params"] if p["uniform"] == "u_mode")
    assert "show_when" not in mode
    assert mode.get("showWhen") is None


# ── ShaderEffect combo accepts legacy effect ids ────────────────────────────────
# ComfyUI validates a COMBO widget's incoming value against its declared `options`
# BEFORE execute() runs, so `LEGACY_EFFECT_IDS.get(effect, effect)` inside execute()
# never gets a chance to run for a saved graph carrying an old id like "filament".
# The declared options list must include the legacy ids too.

def test_node_combo_accepts_legacy_effect_ids():
    from comfy_extras import nodes_shader_effects as m

    opts = m._effect_ids()
    for old, new in m.LEGACY_EFFECT_IDS.items():
        assert new in opts, f"alias target {new} missing from catalog"
        assert old not in opts, f"{old} is still a live id; alias is stale"

    schema = m.ShaderEffect.define_schema()
    effect_input = next(i for i in schema.inputs if getattr(i, "id", None) == "effect")
    for old in m.LEGACY_EFFECT_IDS:
        assert old in effect_input.options, f"combo options must include legacy id {old!r}"
