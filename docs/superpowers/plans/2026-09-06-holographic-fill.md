# Holographic Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generative `holographic_surface` shader effect — foil that is a surface in its own right rather than a treatment applied to a picture — and surface it as a one-click "Holographic" entry in the fill pickers.

**Architecture:** Two pieces. The effect is one `.frag` plus one `manifest.json` entry, which is this repo's whole mechanism for adding an effect (`comfy_extras/_shader_effects.py` loads the manifest at runtime and requires a matching `<id>.frag`). Because it joins the shared catalog it lands everywhere at once: the fill system via `type: 'shader'`, Texture Studio, Shape Studio, Space Type, the 3D `shaderFill` material and the compositor post stack. The picker entry is then a **preset** that writes an ordinary shader fill naming the new effect — no new fill type, no new render path.

**Spec:** `docs/superpowers/specs/2026-09-06-holographic-fill-design.md` — read it before Task 1. It explains why the existing `holographic` effect cannot do this job and why the picker entry is a preset rather than a twelfth `FILL_TYPES` member.

**Tech Stack:** GLSL ES 3.00 fragment shaders, Python (catalog loader + pytest), TypeScript/Vue 3 (fill pickers), pytest, Vitest.

## A deliberate departure from "complete code in every step"

This plan gives **reference GLSL, explicitly marked as a starting point to be validated — not transcribed.**

That is a departure from the usual rule, and the reason is evidence from the immediately preceding piece of work on this repo. A plan supplied a complete, plausible-looking canvas routine; an implementer transcribed it faithfully; it shipped; and it changed **zero pixels** — every blended copy was offset by exactly the canvas width, placing it entirely off-canvas. It survived task review because it looked right, and no test in the repo could execute that code path.

Shader correctness has the same property: it cannot be established by reading, and a shader that compiles, binds and renders a uniformly flat frame passes every "does it run" check. So for this task the honest analogue of complete code is **a precise contract plus executable acceptance criteria**. The implementer writes the GLSL, renders it, and iterates until the variance assertions and the eye both agree. Task 2's assertions are the gate, and they exist specifically to catch the flat-frame no-op.

Everything that is not GLSL — manifest entries, TypeScript, test code — follows the normal rule and is given in full.

## Global Constraints

- **Effects are added by exactly two artifacts:** `shader_effects/<id>.frag` and one entry in `shader_effects/manifest.json`. The loader (`comfy_extras/_shader_effects.py:94-106`) rejects a duplicate id and a manifest entry with no matching `.frag`.
- **`test_server_render_matches_goldens` loops the ENTIRE catalog** and asserts a golden PNG exists for every effect at 128 and 256. A new effect therefore **fails that test until goldens are generated**, and goldens are GPU-calibrated: they must be produced on this machine with `.venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py`.
- **`ShaderSpec.params` is keyed WITHOUT the `u_` prefix** (`surface`, not `u_surface`) — see the type's doc in `frontend/app/lib/spacetype/fillTile.ts`.
- **UI copy is sentence case and never exposes an internal identifier.** Every enum option needs a display label.
- **Do NOT add a member to `FILL_TYPES`.** Twelve modules read it, and this repo has had a `FILL_TYPES` leak reach a 3D texture path and draw QR codes. The picker entry is a preset.
- **The existing `holographic` effect keeps its id.** Ids are what saved documents store. Only its label changes.
- **Commit hygiene:** the main checkout has ~34 uncommitted files belonging to a parallel session. **Stage only your own files, by explicit path. Never `git add -A`, never `git stash`.**
- Python tests: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -x -q`
- Frontend tests: `cd frontend && npx vitest run tests/unit/<file>` (pnpm, not npm)
- End every commit message with:
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## File Structure

**New**
- `shader_effects/holographic_surface.frag` — the generative foil effect.
- `tests-unit/shaderfx_golden/holographic_surface_128.png`, `_256.png` — generated, not hand-written.

**Modified**
- `shader_effects/manifest.json` — one new entry; one label change on the existing `holographic` entry.
- `tests-unit/comfy_extras_test/shader_effects_test.py` — the variance guard.
- `frontend/app/components/vue-canvas/compositor/FillControl.vue` — the preset entry.
- `frontend/app/components/vue-canvas/SpaceTypeSurface.vue` — the preset entry in the slot list only.
- `frontend/app/lib/spacetype/fillTile.ts` — the exported preset constant.

---

### Task 1: The generative shader and its manifest entry

**Files:**
- Create: `shader_effects/holographic_surface.frag`
- Modify: `shader_effects/manifest.json`
- Test: `tests-unit/comfy_extras_test/shader_effects_test.py`

**Interfaces:**
- Produces: effect id `holographic_surface`, category `generative`, `generative: true`, `animated: true`, `passes: 1`, `textures: []`, and these uniforms — `u_surface` (enum 0-3), `u_scale`, `u_iridescence`, `u_bands`, `u_angle`, `u_shimmer`, `u_metallic`, `u_sheen`, `u_tint` (color), `u_mix`, plus the harness-supplied `u_image0`, `u_resolution`, `u_time`, `u_seed`, `u_hasInput`.

- [ ] **Step 1: Write the manifest entry first**

Params are keyed by uniform and carry display labels. Insert into the `effects` array of `shader_effects/manifest.json`:

```json
{
  "id": "holographic_surface",
  "name": "Holographic",
  "category": "generative",
  "animated": true,
  "passes": 1,
  "centerParam": null,
  "textures": [],
  "generative": true,
  "params": [
    { "uniform": "u_surface", "label": "Surface", "type": "enum", "default": 0,
      "options": [
        { "label": "Crumple", "value": 0 },
        { "label": "Grating", "value": 1 },
        { "label": "Flakes", "value": 2 },
        { "label": "Slick", "value": 3 }
      ] },
    { "uniform": "u_scale", "label": "Scale", "type": "float", "min": 0.5, "max": 12.0, "default": 4.0, "step": 0.1 },
    { "uniform": "u_iridescence", "label": "Iridescence", "type": "float", "min": 0.0, "max": 1.0, "default": 0.85, "step": 0.01 },
    { "uniform": "u_bands", "label": "Bands", "type": "float", "min": 0.5, "max": 8.0, "default": 3.0, "step": 0.1 },
    { "uniform": "u_angle", "label": "View angle", "type": "float", "min": 0.0, "max": 360.0, "default": 0.0, "step": 1.0 },
    { "uniform": "u_shimmer", "label": "Shimmer", "type": "float", "min": 0.0, "max": 1.0, "default": 0.25, "step": 0.01 },
    { "uniform": "u_metallic", "label": "Metallic", "type": "float", "min": 0.0, "max": 1.0, "default": 0.6, "step": 0.01 },
    { "uniform": "u_sheen", "label": "Sheen", "type": "float", "min": 0.0, "max": 1.0, "default": 0.5, "step": 0.01 },
    { "uniform": "u_tint", "label": "Tint", "type": "color", "default": "#8899aa" },
    { "uniform": "u_mix", "label": "Blend input", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.01 }
  ]
}
```

Check an existing `color`-typed param in the manifest first and match its exact shape — if colours are declared differently there, follow the file, not this snippet.

- [ ] **Step 2: Run the catalog test to watch it fail**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -x -q`
Expected: FAIL — `shader_effects manifest: missing shader file for 'holographic_surface'`, raised by the loader at `_shader_effects.py:105`. That failure proves the manifest entry is live before any GLSL exists.

- [ ] **Step 3: Write the shader**

Create `shader_effects/holographic_surface.frag`.

**The contract.** One pipeline, four height fields:

1. Build a height field from `v_texCoord` and `u_seed`, scaled by `u_scale`.
2. Derive a normal from it by central differences — the same shape as the existing effect's `normalize(vec3(-lx, -ly, 0.5))`, but reading the **generated** field rather than an input texture. This is the entire fix: nothing may read `u_image0` to obtain the normal.
3. View vector from `u_angle + u_time * u_shimmer`; fresnel `pow(1 - dot(N, V), 3)` for the glancing sheen.
4. Phase through the cosine palette `0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.66)))` — reuse the existing effect's `iridPalette`, so the two look like siblings.
5. Blend `u_tint` (metal underneath) with the iridescence by `u_iridescence`, and film ↔ metal by `u_metallic`; add a specular term scaled by `u_sheen`.
6. Finally, if `u_hasInput > 0.5 && u_mix > 0.0`, mix the input back in — the convention `shader_effects/mist.frag:98-100` uses. Default `u_mix` is 0, so out of the box this is pure foil.

**Per-surface height fields:**

| `u_surface` | Field |
|---|---|
| 0 Crumple | `fbm(q)` — soft irregular creases |
| 1 Grating | `sin(dot(q, vec2(cos(ang), sin(ang))) * k)` plus a little low-amplitude fbm so it is not mechanically perfect |
| 2 Flakes | **Not a height field.** Per cell of `floor(q)`, assign a normal directly from two hashes, so facets are flat and edges hard. Differencing a cellular field gives soft blobs, which is not what glitter looks like. |
| 3 Slick | low-frequency `fbm(q * 0.35)` — broad soft gradients, no visible texture |

**Reference implementation — a STARTING POINT, not something to transcribe.** Copy `hash21`, `vnoise`, `fbm` and `iridPalette` verbatim from `shader_effects/holographic.frag` (proven, and keeps the siblings consistent). Then:

```glsl
vec3 surfaceNormal(vec2 q, float mode, float ang, out float facet) {
    facet = 1.0;
    if (mode > 1.5 && mode < 2.5) {                    // Flakes: direct per-cell normal
        vec2 cell = floor(q);
        vec2 f = fract(q);
        vec2 tilt = (vec2(hash21(cell + 11.0), hash21(cell + 27.0)) - 0.5) * 1.6;
        facet = smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
        return normalize(vec3(tilt, 0.85));
    }
    float e = 0.06;
    float hx = heightAt(q + vec2(e, 0.0), mode, ang) - heightAt(q - vec2(e, 0.0), mode, ang);
    float hy = heightAt(q + vec2(0.0, e), mode, ang) - heightAt(q - vec2(0.0, e), mode, ang);
    return normalize(vec3(-hx * 6.0, -hy * 6.0, 0.5));
}
```

The constants (`1.6`, `0.85`, `0.06`, `6.0`, and the grating frequency) are guesses. **Tune them against Task 2's assertions and a rendered image.** If a mode renders flat or muddy, the constants are wrong — that is expected iteration, not failure.

- [ ] **Step 4: Confirm it loads and its params match its uniforms**

Add to `tests-unit/comfy_extras_test/shader_effects_test.py`:

```python
def test_holographic_surface_is_generative_and_declares_its_uniforms():
    cat = load_catalog(refresh=True)
    eff = cat.effects["holographic_surface"]
    assert eff.generative is True
    assert eff.category == "generative"
    assert eff.source.startswith("#version 300 es")
    # Every declared param must exist as a uniform in the shader: a param the GLSL
    # never reads is a dead control the UI still shows.
    for p in eff.params:
        assert f"uniform " in eff.source and p.uniform in eff.source, \
            f"{p.uniform} is declared in the manifest but not read by the shader"
    # ...and the four surfaces the manifest advertises must all be reachable.
    surface = next(p for p in eff.params if p.uniform == "u_surface")
    assert [o["value"] for o in surface.options] == [0, 1, 2, 3]
```

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -x -q -k holographic_surface`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shader_effects/holographic_surface.frag shader_effects/manifest.json tests-unit/comfy_extras_test/shader_effects_test.py
git commit -m "feat(shaderfx): generative holographic surface effect"
```

---

### Task 1b: The look — make it read as metal, not as a rainbow

Added after Task 1 shipped and its four surfaces were rendered and shown to the user. The
mechanism is right — creases, hard-edged facets and grating lines are all genuinely present, and
the field is correctly independent of any input. **The look is not right.** At picker defaults
all four modes read as high-chroma rainbow noise rather than foil.

The diagnosis is one thing: **there is no light/dark structure.** Real foil is a *metal* — bright
specular hits and genuinely dark regions — with iridescence riding on top of that structure.
Here the rainbow is the whole image at near-maximum chroma, so the eye reads "rainbow", not
"metal". Measured at defaults: mean saturation 0.56–0.68 in a narrow luminance band
(Crumple's p1–p99 is only 0.365–0.759).

This lives in the shader's **composition** step — how tint, iridescence, key light and specular
combine — not in field generation. Do not touch the height fields, the normals, or the seed fold.

**This task must land before Tasks 2, 3 and 5**, or goldens and picker defaults bake in a look
we have already agreed to change.

**Files:** Modify `shader_effects/holographic_surface.frag`.

- [ ] **Step 1: Render the current state and look at it**

Render all four modes at 320px on a flat 0.5 grey input, defaults, seed 42, and view them.
Record for each: mean saturation, luminance p1/p50/p99, and the fraction of pixels above 0.9 and
below 0.1. These are your before-numbers.

- [ ] **Step 2: Give the surface a luminance structure**

Direction, not prescription — you are tuning by eye against the targets in Step 3:

- Establish a dominant light/dark term (a key-light `dot(N, L)` plus a tight specular lobe) and
  let the iridescence *modulate* it rather than replace it.
- Drop baseline chroma. Iridescence should be strongest near highlights and glancing angles, and
  fall away in the body of the surface, rather than sitting at full strength everywhere.
- Let `u_tint` genuinely read as the metal underneath — at `u_iridescence = 0` the surface should
  look like tinted metal, not flat grey.
- **Flakes specifically:** most facets should sit dark, with a minority catching the light
  brilliantly. That distribution is what makes glitter read as glitter; equal-brightness cells
  read as a mosaic. Currently measured luminance min is 0.163 — nothing is actually dark.
- **Slick specifically:** thinner, higher-contrast banding. Petrol-on-water is not a soft blur.

- [ ] **Step 3: Hit these targets, then confirm by eye**

Numeric guardrails, at defaults on flat grey — necessary but NOT sufficient:

| Measure | Now | Target |
|---|---|---|
| Luminance p1 | 0.365 (Crumple) | ≤ 0.12 in every mode |
| Luminance p99 | 0.759 (Crumple) | ≥ 0.90 in every mode |
| Mean saturation | 0.56–0.68 | 0.25–0.50 |
| Flakes: fraction of pixels below 0.25 luminance | ~0 | ≥ 0.30 |

**The existing acceptance thresholds must still hold** — `std() > 0.02`, `max|R−B| > 0.10`, and
bit-identical output with a black input, in all four modes.

Then render the 2×2 contact sheet again and look. The numbers can be met by an ugly image; they
are a floor, not the goal. It should read as foil.

- [ ] **Step 4: Confirm the dials still all do something**

Sweep each of the ten params min→max in every mode and confirm each visibly changes the output.
An earlier revision of this shader had a dead `Metallic` because the film and metal branches came
out near-identical; a composition rewrite is exactly where that recurs.

- [ ] **Step 5: Commit**

```bash
git add shader_effects/holographic_surface.frag
git commit -m "feat(shaderfx): holographic surface reads as metal, not as a rainbow"
```

---

### Task 2: The variance guard

The gate that catches the flat-frame no-op. Written as its own task because it is the acceptance criterion Task 1 iterates against, and because a reviewer should be able to reject it independently.

**Files:**
- Modify: `tests-unit/comfy_extras_test/shader_effects_test.py`

**Interfaces:**
- Consumes: `load_catalog`, `resolve_params`, `render_effect` — already imported by that module.

- [ ] **Step 1: Write the test**

```python
def test_holographic_surface_renders_varied_foil_in_every_mode():
    """A shader that compiles, binds and renders a FLAT frame passes every 'does it
    run' check. These assertions are what fail in that case — per surface mode."""
    cat = load_catalog(refresh=True)
    eff = cat.effects["holographic_surface"]
    flat = np.full((64, 64, 3), 0.5, dtype=np.float32)  # a deliberately featureless input
    for mode, name in enumerate(["crumple", "grating", "flakes", "slick"]):
        # to_uniforms is REQUIRED: u_tint is a colour param, and resolve_params leaves it a
        # hex string that render_effect rejects with
        # "ValueError: could not convert string to float". Import it alongside resolve_params.
        uniforms = to_uniforms(eff, resolve_params(eff, json.dumps({"u_surface": mode})))
        jobs = [{"image": flat, "uniforms": {**uniforms, "u_time": 0.7, "u_seed": 42.0, "u_hasInput": 1.0}}]
        out = render_effect(eff.source, 64, 64, jobs, passes=eff.passes)[0][..., :3]
        # 1. Not a constant frame.
        assert out.std() > 0.02, f"{name}: frame is essentially flat (std {out.std():.4f})"
        # 2. Actually iridescent — the channels must diverge somewhere, or it is a
        #    greyscale bump map wearing a rainbow's name.
        spread = np.abs(out[..., 0] - out[..., 2])
        assert spread.max() > 0.10, f"{name}: no hue separation (max R-B {spread.max():.4f})"
        # 3. Independent of the input, which is the whole point of a generative effect.
        dark = [{"image": np.zeros_like(flat), "uniforms": jobs[0]["uniforms"]}]
        out_dark = render_effect(eff.source, 64, 64, dark, passes=eff.passes)[0][..., :3]
        assert np.abs(out - out_dark).max() < 2.0 / 255.0, \
            f"{name}: output changed with the input — u_mix defaults to 0, so it must not"
```

`json` is already imported by this module; confirm before adding an import.

- [ ] **Step 2: Run it**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -x -q -k varied_foil`
Expected: PASS. If a mode fails assertion 1 or 2, the shader needs tuning — go back to Task 1 Step 3. **That is the loop this test exists to drive.**

- [ ] **Step 3: Prove the guard can fail**

Temporarily replace the shader's final colour with a constant (`fragColor0 = vec4(u_tint, 1.0);`), re-run, and confirm the test FAILS on assertion 1. Restore. Paste both outputs in your report — a guard nobody has seen fail is not yet a guard.

- [ ] **Step 4: Commit**

```bash
git add tests-unit/comfy_extras_test/shader_effects_test.py
git commit -m "test(shaderfx): holographic surface must render varied, input-independent foil"
```

---

### Task 3: Goldens

**Files:**
- Create: `tests-unit/shaderfx_golden/holographic_surface_128.png`, `holographic_surface_256.png`

- [ ] **Step 1: Understand the two pre-existing problems before touching anything**

Task 1's investigation found this task's original premise was wrong. The golden test does NOT
fail with "missing golden for holographic_surface", and generating goldens alone will NOT make
it pass. Two independent pre-existing faults sit in front of us:

**(a) The suite is already red at HEAD.** `crystal_prism`, `oil_paint` and `blinds` fail the
golden comparison at pristine HEAD, verified by rendering a `git archive` of HEAD in a scratch
directory with identical numbers. The test is a single looping function with a plain `assert`,
so it stops at the FIRST mismatch — `crystal_prism@128: max diff 54.16/255` — and never reaches
our effect at all. **These are not ours and are out of scope.** Do not fix them; do not let them
be attributed to this work.

**(b) The test and the generator disagree about colour params.** The generator
(`generate_goldens.py:53`) does `to_uniforms(eff, resolve_params(eff, "{}"))`, converting a hex
colour into a vec3. The test (`shader_effects_test.py:213`) calls `resolve_params` alone, leaving
a hex string that `render_effect` rejects — verified directly:
`ValueError: could not convert string to float: '#1a1a2e'`. Three existing effects
(`duotone`, `oddgrid`, `static`) already carry colour params and would hit this; they simply sit
after `crystal_prism` in the loop, so nothing has ever reached them.

`holographic_surface` has a colour param (`u_tint`), so this bug blocks it. Fixing it is in
scope — it is the one thing standing between our effect and a passing comparison.

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k goldens`
Expected: FAIL at `crystal_prism@128`, exactly as described above. Record the number.

- [ ] **Step 1b: Make the test agree with the generator**

In `tests-unit/comfy_extras_test/shader_effects_test.py:213`, change

```python
            uniforms = resolve_params(eff, "{}")
```

to match how the goldens were actually produced:

```python
            # to_uniforms converts a hex colour param into the vec3 the shader wants;
            # resolve_params alone leaves it a string and render_effect rejects it. The
            # generator (generate_goldens.py) has always done this — the test had drifted,
            # and no colour-param effect was ever reached to expose it.
            uniforms = to_uniforms(eff, resolve_params(eff, "{}"))
```

Add `to_uniforms` to that module's import on line 11.

This should make `duotone`, `oddgrid` and `static` render the way their goldens were generated,
so it fixes rather than breaks them. Confirm that: after the change, those three must compare
clean. If any of them now mismatches, stop and report — that would mean their goldens were
generated under different conditions and the story is more complicated than this.

- [ ] **Step 2: Generate**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py`

Goldens are GPU-calibrated, so they must be generated on this machine. The script regenerates the whole catalog; check `git status` afterwards and **commit only the two `holographic_surface_*.png` files**. If other goldens changed, that is a pre-existing drift unrelated to this work — report it, do not commit it.

- [ ] **Step 3: Verify what you can, and be precise about what still fails**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q`

The golden test will STILL FAIL at `crystal_prism` — that is pre-existing and out of scope. What
you must establish is that **our effect is no longer among the reasons it fails.** Prove it
directly rather than inferring it, by rendering just our effect against its fresh goldens:

```python
# scratch, not committed
import sys, os, numpy as np
from unittest.mock import MagicMock
sys.modules.setdefault("nodes", MagicMock())
from PIL import Image
from comfy_extras._shader_effects import load_catalog, render_effect, resolve_params, to_uniforms
g = "tests-unit/shaderfx_golden"
cat = load_catalog(refresh=True)
eff = cat.effects["holographic_surface"]
for size in (128, 256):
    fixture = np.asarray(Image.open(f"{g}/fixture_{size}.png").convert("RGB"), np.float32) / 255.0
    golden = np.asarray(Image.open(f"{g}/holographic_surface_{size}.png").convert("RGB"), np.float32) / 255.0
    u = to_uniforms(eff, resolve_params(eff, "{}"))
    jobs = [{"image": fixture, "uniforms": {**u, "u_time": 0.7, "u_seed": 42.0, "u_hasInput": 1.0}}]
    out = render_effect(eff.source, size, size, jobs, passes=eff.passes)[0][..., :3]
    print(size, "max diff", np.abs(out - golden).max() * 255)
```

Both sizes must be at or under `2.0/255`. Also confirm `duotone`, `oddgrid` and `static` compare
clean the same way — they are the effects Step 1b's fix newly reaches.

Report the full list of remaining golden failures BY NAME, and state plainly that they are the
three pre-existing ones and nothing else.

```bash
git add tests-unit/shaderfx_golden/holographic_surface_128.png tests-unit/shaderfx_golden/holographic_surface_256.png tests-unit/comfy_extras_test/shader_effects_test.py
git commit -m "test(shaderfx): goldens for the holographic surface, and let the golden test render colour params"
```

---

### Task 4: Relabel the existing effect

Two holographic effects now coexist and do different jobs. The labels should say which is which.

**Files:**
- Modify: `shader_effects/manifest.json`

- [ ] **Step 1: Change the label only**

In the `holographic` entry, `"name": "Holographic Foil"` becomes `"name": "Holographic Overlay"`.

**Do not touch its `id`.** Ids are what saved documents store; a change there breaks every document referencing it. The label is display text only.

- [ ] **Step 2: Verify nothing resolved by name**

Run: `grep -rn "Holographic Foil" --include=*.ts --include=*.vue --include=*.py . | grep -v node_modules`
Expected: no hits outside the manifest. If anything matches a label rather than an id, report it — that is a latent bug this change would expose.

- [ ] **Step 3: Commit**

```bash
git add shader_effects/manifest.json
git commit -m "docs(shaderfx): the stylize holographic effect is an overlay, and says so"
```

---

### Task 5: The fill-picker preset

**Files:**
- Modify: `frontend/app/lib/spacetype/fillTile.ts` (export the preset)
- Modify: `frontend/app/components/vue-canvas/compositor/FillControl.vue`
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue`
- Test: `frontend/tests/unit/` — a new spec for the preset constant

**Interfaces:**
- Produces: `HOLOGRAPHIC_FILL_PRESET: Fill` exported from `fillTile.ts`.

- [ ] **Step 1: Export the preset**

In `frontend/app/lib/spacetype/fillTile.ts`, beside `DEFAULT_FILL` / `DEFAULT_SHADER_SPEC`:

```ts
/** The "Holographic" fill-picker entry. Deliberately a PRESET, not a FILL_TYPES member:
 *  canvas-painted fill types cannot do per-pixel iridescence, and a shader fill in that
 *  path already degrades to its input (see fills.ts's fillTexture). Twelve modules read
 *  FILL_TYPES, and one leak from it has already reached a 3D texture path. */
export const HOLOGRAPHIC_FILL_PRESET: Fill = {
  ...DEFAULT_FILL,
  type: 'shader',
  shader: {
    effectId: 'holographic_surface',
    // Keyed WITHOUT the `u_` prefix — see ShaderSpec's doc above.
    // These MUST match the manifest's current defaults — verify against
    // shader_effects/manifest.json before writing them, do not trust this snippet.
    // `metallic` is the GLSL name; its label is "Silver wash" since the look changed
    // from diffraction foil to sticker vinyl (see the spec's Controls table).
    params: { surface: 0, scale: 4, iridescence: 0.78, bands: 3, angle: 0,
              shimmer: 0.25, metallic: 0.6, sheen: 0.5, glow: 0.5, tint: '#aab0b8', mix: 0 },
    anchor: 'object',
    speed: 1,
    seed: 42,
    // Required by ShaderSpec and ignored by a generative effect, exactly as the other
    // twenty generative effects behave inside a shader fill.
    input: DEFAULT_SHADER_SPEC.input,
  },
}
```

Check `DEFAULT_FILL`'s real shape before spreading it — match the file.

- [ ] **Step 2: Write the failing test**

Create `frontend/tests/unit/holographic-fill-preset.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { HOLOGRAPHIC_FILL_PRESET, FILL_TYPES } from '~/lib/spacetype/fillTile'

describe('holographic fill preset', () => {
  it('is a shader fill naming the generative effect', () => {
    expect(HOLOGRAPHIC_FILL_PRESET.type).toBe('shader')
    expect(HOLOGRAPHIC_FILL_PRESET.shader?.effectId).toBe('holographic_surface')
  })

  it('keys its params without the u_ prefix', () => {
    const keys = Object.keys(HOLOGRAPHIC_FILL_PRESET.shader!.params)
    expect(keys).toContain('surface')
    expect(keys.some((k) => k.startsWith('u_'))).toBe(false)
  })

  it('does NOT add a member to FILL_TYPES', () => {
    // The whole point of a preset. Twelve modules read this constant.
    expect(FILL_TYPES).not.toContain('holographic' as never)
    expect(FILL_TYPES).toHaveLength(11)
  })

  it('carries an input, because ShaderSpec requires one even generatively', () => {
    expect(HOLOGRAPHIC_FILL_PRESET.shader?.input).toBeDefined()
  })
})
```

Run it and watch it fail before Step 1's export exists.

- [ ] **Step 3: Add the entry to the two pickers that should have it — and only those**

The four call sites are not uniform. From the spec:

| Call site | Entry? |
|---|---|
| `compositor/FillControl.vue` | **Yes** — and hidden when `nested`, exactly as `shader` already is (`availableTypes` at line ~46 filters it out). It *is* a shader fill, so the depth-1 rule applies to it too. |
| `SpaceTypeSurface.vue` slot list (`FILL_TYPES`, ~line 2011) | **Yes** |
| `SpaceTypeSurface.vue` `WORD_FILL_TYPES` / card kinds | **No** — curated subsets that already exclude `shader` |
| `VectorTypeSurface.vue` (`FILL_TYPES.filter(paintIsVector)`) | **No, and this is correct.** `paintIsVector` → `exportTier`; a generative shader field cannot be expressed as geometry, so it exports as `raster`. Its absence is the system working. |

Render it as a labelled preset after the eleven types, selecting it assigns `HOLOGRAPHIC_FILL_PRESET`. Label: "Holographic".

- [ ] **Step 4: Run the frontend suites**

Run: `cd frontend && npx vitest run tests/unit/holographic-fill-preset.unit.spec.ts`
Then: `cd frontend && npx vitest run tests/unit/` and name every failing file. This repo has pre-existing failures unrelated to this work; compare by NAME, never by count.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/spacetype/fillTile.ts frontend/app/components/vue-canvas/compositor/FillControl.vue frontend/app/components/vue-canvas/SpaceTypeSurface.vue frontend/tests/unit/holographic-fill-preset.unit.spec.ts
git commit -m "feat(fills): one-click Holographic preset in the fill pickers"
```

---

### Task 6: Close-out

- [ ] **Step 1: Full Python shader suite**

Run: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q`
Expected: PASS, including the catalog-wide golden loop.

- [ ] **Step 2: Frontend suite and typecheck**

Run: `cd frontend && npx vitest run tests/unit/` and `cd frontend && npx nuxt typecheck`
Name every failing test file and compare by name against what fails before this work. Typecheck has ~415 pre-existing errors in `shared/template-grid/*` and `shared/timeline/*`; what matters is zero in files this work touched.

- [ ] **Step 3: Live verification**

Start the app (`cd frontend && pnpm exec nuxt dev --port 3000 --host 127.0.0.1` — NOT `npm run dev`, whose `predev` shells out to a `vite` that is not on PATH). Then:
- In the compositor's fill picker, choose **Holographic** and confirm convincing foil appears with no further tuning — the one-click promise.
- Step through all four Surfaces and confirm each reads as its referent: Crumple as crinkled sticker, Grating as CD/prismatic, Flakes as glitter with hard-edged facets, Slick as broad oil-slick.
- Confirm the entry is absent from Vector Type's picker, and that this is understood as correct.
- Screenshot each surface mode.

- [ ] **Step 4: Commit any close-out fixes**

```bash
git add <only files you changed>
git commit -m "fix(shaderfx): holographic surface close-out"
```
