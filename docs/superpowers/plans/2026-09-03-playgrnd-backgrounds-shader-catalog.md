# playgrnd Backgrounds → Shader Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the "Backgrounds" and "Textures" looks from playgrnd.tools into Sailor as Shader Studio catalog effects, so each one is also a fill in Frame, Space Type, Shape Studio and Scene3D with no further work.

**Architecture:** Every look is one self-contained GLSL fragment shader in `shader_effects/` plus one entry in `shader_effects/manifest.json`. The manifest is the single source of truth: it drives the Shader Studio panel, the fill-picker controls (via `derivedShaderFillControls`), the server bake, and the golden tests. Playgrnd's "inks read as a ramp" idea maps onto the existing `gradient` param type (`u_ramp[8]`, `u_rampPos[8]`, `u_rampCount`). Three shaders that already exist on disk but are invisible (no manifest entry) are registered first because that is the cheapest win.

**Tech Stack:** GLSL ES 3.00 (`#version 300 es`, output `fragColor0`), JSON manifest validated by `comfy_extras/_shader_effects.py::load_catalog`, vitest for the uniform contract and agent vocabulary, pytest for the server render goldens, Playwright for browser parity and the Frame fill proof.

**This is plan 1 of a series.** The playgrnd mapping has six groups. This plan covers group 1 (Shader Studio). Follow-on plans, not written yet: Gradient Studio presets (Pane, Rise), Pattern Studio families (Weave, Quilt, Warp, plus controls for Vee, Zig, Relief), Shape Studio arrangements (Emblem, Tokens, Oddgrid), the Riso Frame preset, and a Poster surface decision.

## Global Constraints

- **No code from playgrnd.tools may be copied.** The site has no license. Ideas and parameter choices only; every line of GLSL here is original.
- **Frags are self-contained.** There is no `#include`. Every frag repeats the hashing, noise, ramp and dither helpers it needs. That is the existing catalog convention (see `shader_effects/fbm.frag`).
- **Every uniform a frag declares must be reachable from its manifest entry** (or be harness-supplied: `u_image0`, `u_resolution`, `u_time`, `u_seed`, `u_hasInput`, `u_pass`, `u_passCount`). `frontend/tests/unit/shader-manifest-uniforms.unit.spec.ts` enforces this both ways. A frag must therefore NOT declare a helper uniform it does not use.
- **Header is in the file, not prepended:** first lines are `#version 300 es` then `precision highp float;`. Output is `layout(location = 0) out vec4 fragColor0;`. Never `gl_FragColor`.
- **`gradient` params arrive as three uniforms:** `<name>[MAXS]` (vec3), `<name>Pos[MAXS]` (float), `<name>Count` (float), with `#define MAXS 8` and `"maxStops": 8` in the manifest.
- **`color` params arrive as `vec3`.** `enum` and `float` params arrive as `float`; read enums with `int(u_x + 0.5)`.
- **Generative effects set `"category": "generative"` and `"generative": true`** and handle `u_hasInput` so they work both with and without a source image. Convention in this plan: `u_mix` ("Image mix", default 0) blends the connected image over the field.
- **Labels are plain language** (Sailor standing rule). "Inks", "Bands", "Field scale", not "u_steps".
- **Goldens are machine-calibrated.** After adding a manifest entry run `.venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py` on this machine. It regenerates EVERY golden; only the new effect's PNGs should be new, and any pre-existing PNG that shows as modified must be restored with `git checkout --` before committing (GPU drift, not your change).
- **The manifest is re-read per request.** A browser refresh shows a new effect. ComfyUI must be running on `127.0.0.1:8188` for the catalog route and the Playwright specs. The `ShaderEffect` node's combo list needs a ComfyUI restart, which is optional for this plan.
- **Commit hygiene:** stage only the files named in each task, never `git add -A`, never stash. Commit directly on `main`.
- **Manifest edits:** append each new effect object as the LAST element of the `effects` array (after the `distort` entry), adding the comma after `distort`'s closing brace. Compact JSON is fine; the loader does not care about layout.

---

### Task 1: Register the three orphaned filters (Terrain lines, Stipple, Mosh)

Three shaders shipped in commit `cf3b2ab65` but never got manifest entries, so the app cannot see them: `topographic.frag`, `stipple.frag`, `pixel_sort.frag`. They are filters over an input image, not generators. Registering them gives playgrnd's Terrain contour look (over any generator), Stipple, and the Mosh streaking half of "corrupted signal".

**Files:**
- Modify: `shader_effects/manifest.json` (append three entries)
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts` (`SHADER_LOOK_CLUSTERS`)
- Regenerate: `tests-unit/shaderfx_golden/topographic_{128,256}.png`, `stipple_{128,256}.png`, `pixel_sort_{128,256}.png`
- Test: `tests-unit/comfy_extras_test/shader_effects_test.py`, `frontend/tests/unit/shader-manifest-uniforms.unit.spec.ts`, `frontend/tests/unit/shader-agent-vocab.unit.spec.ts`

**Interfaces:**
- Consumes: the frags' existing uniforms. `topographic.frag`: `u_levels, u_thickness, u_mode (0 over image, 1 ink on paper, 2 glow on dark), u_bands`. `stipple.frag`: `u_density, u_jitter, u_dotSize, u_contrast, u_mode (0 ink on paper, 1 image colour on white, 2 image colour on black)`. `pixel_sort.frag`: `u_direction (0 up, 1 down, 2 left, 3 right), u_low, u_high, u_length, u_mode (0 brighten, 1 darken)`.
- Produces: catalog ids `topographic`, `stipple`, `pixel_sort`, used by Task 8's look clusters.

- [ ] **Step 1: Confirm the uniform contract test currently ignores the orphans**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS. The test filters to manifest entries, so it does not fail on orphans. This is the baseline.

- [ ] **Step 2: Append the three manifest entries**

Append to the `effects` array in `shader_effects/manifest.json`:

```json
    {
      "id": "topographic",
      "name": "Contour Lines",
      "category": "stylize",
      "animated": false,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": false,
      "params": [
        { "uniform": "u_levels", "label": "Levels", "type": "float", "min": 2, "max": 24, "default": 10, "step": 1 },
        { "uniform": "u_thickness", "label": "Line weight", "type": "float", "min": 0.02, "max": 0.6, "default": 0.15, "step": 0.01 },
        { "uniform": "u_mode", "label": "Paper", "type": "enum", "default": 1,
          "options": [
            { "label": "Over the image", "value": 0 },
            { "label": "Ink on paper", "value": 1 },
            { "label": "Glow on dark", "value": 2 }
          ] },
        { "uniform": "u_bands", "label": "Band tint", "type": "float", "min": 0.0, "max": 1.0, "default": 0.6, "step": 0.05 }
      ]
    },
    {
      "id": "stipple",
      "name": "Stipple",
      "category": "stylize",
      "animated": false,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": false,
      "params": [
        { "uniform": "u_density", "label": "Dots across", "type": "float", "min": 12, "max": 200, "default": 72, "step": 1 },
        { "uniform": "u_jitter", "label": "Jitter", "type": "float", "min": 0.0, "max": 1.0, "default": 0.3, "step": 0.05 },
        { "uniform": "u_dotSize", "label": "Dot size", "type": "float", "min": 0.3, "max": 2.0, "default": 1.0, "step": 0.05 },
        { "uniform": "u_contrast", "label": "Contrast", "type": "float", "min": 0.3, "max": 3.0, "default": 1.0, "step": 0.05 },
        { "uniform": "u_mode", "label": "Paper", "type": "enum", "default": 0,
          "options": [
            { "label": "Ink on paper", "value": 0 },
            { "label": "Image colour on white", "value": 1 },
            { "label": "Image colour on black", "value": 2 }
          ] }
      ]
    },
    {
      "id": "pixel_sort",
      "name": "Pixel Sort",
      "category": "distortion",
      "animated": false,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": false,
      "params": [
        { "uniform": "u_direction", "label": "Direction", "type": "enum", "default": 1,
          "options": [
            { "label": "Up", "value": 0 },
            { "label": "Down", "value": 1 },
            { "label": "Left", "value": 2 },
            { "label": "Right", "value": 3 }
          ] },
        { "uniform": "u_low", "label": "Band low", "type": "float", "min": 0.0, "max": 1.0, "default": 0.25, "step": 0.01 },
        { "uniform": "u_high", "label": "Band high", "type": "float", "min": 0.0, "max": 1.0, "default": 0.75, "step": 0.01 },
        { "uniform": "u_length", "label": "Streak length", "type": "float", "min": 0.0, "max": 1.0, "default": 0.5, "step": 0.02 },
        { "uniform": "u_mode", "label": "Carry", "type": "enum", "default": 0,
          "options": [
            { "label": "Lightest", "value": 0 },
            { "label": "Darkest", "value": 1 }
          ] }
      ]
    }
```

- [ ] **Step 3: Run the uniform contract test**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS, and the effect count in the output is 3 higher than the baseline. If it reports a uniform declared in a frag but missing from the manifest, the frag declares something not listed above; add that param rather than deleting the uniform.

- [ ] **Step 4: Run the Python catalog test (goldens will be stale)**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q
```
Expected: `test_catalog_loads_and_has_spike_effects` PASS. `test_server_render_matches_goldens` may FAIL for `topographic`, `stipple`, `pixel_sort` because the existing goldens were rendered with different defaults. That is expected; the next step fixes it.

- [ ] **Step 5: Regenerate goldens and keep only the intended changes**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: ` M` on exactly the six files `topographic_128.png`, `topographic_256.png`, `stipple_128.png`, `stipple_256.png`, `pixel_sort_128.png`, `pixel_sort_256.png`. If any OTHER png is listed as modified, restore it:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff --name-only tests-unit/shaderfx_golden | grep -v -E 'topographic|stipple|pixel_sort' | xargs -r git checkout --
```

- [ ] **Step 6: Run the Python tests again**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q
```
Expected: all PASS.

- [ ] **Step 7: Give the agent words for the three**

In `frontend/app/lib/shaderstudio/agentControls.ts`, in `SHADER_LOOK_CLUSTERS`:

Change the existing glitch line to include `pixel_sort`:
```ts
  { words: 'glitchy / vhs / broken signal / datamosh / corrupted / pixel sort / streaked', ids: ['block_glitch', 'rgb_glitch', 'crt_scanlines', 'post_grain', 'pixel_sort'] },
```
Add two new lines (anywhere in the array before the `BACKGROUND FROM NOTHING` line):
```ts
  { words: 'contour lines / topographic map / isolines / terrain map', ids: ['topographic'] },
  { words: 'stipple / pointillist / dots of light / engraved dots', ids: ['stipple'] },
```

- [ ] **Step 8: Run the vocabulary test**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts
```
Expected: PASS. If the `SHADER_GUIDANCE_CEILING` (8000 chars) test fails, shorten the cluster words you added; do not raise the ceiling.

- [ ] **Step 9: See them in the browser**

With ComfyUI and the frontend dev server running, open `http://127.0.0.1:3000/` (use `127.0.0.1`, not `localhost`), add a Shader Studio, connect any image, open the effect picker. Expected: "Contour Lines" and "Stipple" under Stylize, "Pixel Sort" under Distortion, each renders on the source.

- [ ] **Step 10: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/topographic_128.png tests-unit/shaderfx_golden/topographic_256.png tests-unit/shaderfx_golden/stipple_128.png tests-unit/shaderfx_golden/stipple_256.png tests-unit/shaderfx_golden/pixel_sort_128.png tests-unit/shaderfx_golden/pixel_sort_256.png && git commit -m "feat(shaders): register topographic, stipple, pixel_sort — orphaned frags join the catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `terrain_bands` — layered contour landscape (playgrnd Terrain)

A domain-warped fbm height field quantised into hard bands, each band one ink from the ramp, with per-pixel grain roughening the joins. This is the generator half of Terrain; Task 1's `topographic` over it gives the line version.

**Files:**
- Create: `shader_effects/terrain_bands.frag`
- Modify: `shader_effects/manifest.json` (append one entry)
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/terrain_bands_128.png`, `terrain_bands_256.png`
- Test: the three suites named in Task 1, plus `frontend/tests/shaderfx-golden.spec.ts -g terrain_bands`

**Interfaces:**
- Produces: catalog id `terrain_bands` with params `u_ramp (gradient), u_steps, u_scale, u_warp, u_detail, u_contrast, u_grain, u_speed, u_mix`. Task 9 uses this id as the Frame fill under test.

- [ ] **Step 1: Write the manifest entry first (the failing test)**

Append to `effects` in `shader_effects/manifest.json`:
```json
    {
      "id": "terrain_bands",
      "name": "Terrain Bands",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_ramp", "label": "Inks", "type": "gradient", "maxStops": 8,
          "default": [
            { "pos": 0.0, "color": "#1b1f5e" },
            { "pos": 0.2, "color": "#2a6fd6" },
            { "pos": 0.4, "color": "#3fbf7f" },
            { "pos": 0.6, "color": "#f2d94e" },
            { "pos": 0.8, "color": "#f2842b" },
            { "pos": 1.0, "color": "#d9303f" }
          ] },
        { "uniform": "u_steps", "label": "Bands", "type": "float", "min": 2, "max": 12, "default": 6, "step": 1 },
        { "uniform": "u_scale", "label": "Field scale", "type": "float", "min": 0.5, "max": 8.0, "default": 2.6, "step": 0.1 },
        { "uniform": "u_warp", "label": "Warp", "type": "float", "min": 0.0, "max": 3.0, "default": 1.1, "step": 0.05 },
        { "uniform": "u_detail", "label": "Detail", "type": "float", "min": 1, "max": 7, "default": 5, "step": 1 },
        { "uniform": "u_contrast", "label": "Contrast", "type": "float", "min": 0.5, "max": 4.0, "default": 1.7, "step": 0.05 },
        { "uniform": "u_grain", "label": "Grain", "type": "float", "min": 0.0, "max": 1.0, "default": 0.3, "step": 0.05 },
        { "uniform": "u_speed", "label": "Speed", "type": "float", "min": 0.0, "max": 3.0, "default": 0.5, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: Run the Python catalog test to see it fail**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'terrain_bands'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/terrain_bands.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Hashing + value noise, same construction as fbm.frag (frags are self-contained).
uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
// Octave count is a dial ("Detail"); the loop bound is fixed because GLSL ES needs one.
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

// A `gradient` manifest param expands to these three uniforms (see to_uniforms()).
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}
// Quantise 0..1 into `steps` hard bands. Band k lands on ramp position k/(steps-1), so
// when steps equals the ink count every band is exactly one ink, never an in-between mix.
float bandq(float t, float steps) {
    steps = max(steps, 2.0);
    return min(floor(clamp(t, 0.0, 0.9999) * steps), steps - 1.0) / (steps - 1.0);
}

uniform float u_steps;
uniform float u_scale;
uniform float u_warp;
uniform float u_detail;
uniform float u_contrast;
uniform float u_grain;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.15;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);

    // Domain-warped height field: the warp is what makes the contours lean and fold.
    vec2 q = vec2(fbmN(p + vec2(0.0, t), u_seed, oct), fbmN(p + vec2(5.2, 1.3) - t, u_seed + 7.0, oct));
    float h = fbmN(p + u_warp * (q - 0.5) * 2.0, u_seed + 17.0, oct);
    h = clamp((h - 0.5) * u_contrast + 0.5, 0.0, 1.0);

    // Per-pixel grain roughens the joins between bands.
    float g = (hash2(floor(v_texCoord * u_resolution), u_seed + 99.0) - 0.5) * u_grain / max(u_steps, 2.0);
    vec3 col = rampAt(bandq(h + g, u_steps));

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
```

- [ ] **Step 4: Run the uniform contract test**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Generate goldens and check only the new files appeared**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: `?? tests-unit/shaderfx_golden/terrain_bands_128.png` and `?? .../terrain_bands_256.png` only. If it fails with a GLSL compile error, the message names the line; fix the frag and rerun. If any existing png shows as ` M`:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff --name-only tests-unit/shaderfx_golden | xargs -r git checkout --
```

- [ ] **Step 6: Run the Python render test**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q
```
Expected: all PASS.

- [ ] **Step 7: Browser/server parity**

With ComfyUI and the dev server running:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "terrain_bands"
```
Expected: 2 passed (128 and 256).

- [ ] **Step 8: Look at it**

Open `http://127.0.0.1:3000/`, add a Shader Studio with no source, pick "Terrain Bands" under Generative. Expected: six hard-edged colour bands in a folded landscape shape, grainy joins, drifting slowly. Drag "Bands" to 3: three bands. Drag "Warp" to 0: rounder blobs.

- [ ] **Step 9: Agent word**

In `frontend/app/lib/shaderstudio/agentControls.ts`, `SHADER_LOOK_CLUSTERS`: add `'terrain_bands'` to the `ids` of the `BACKGROUND FROM NOTHING` line, and add:
```ts
  { words: 'banded terrain / contour landscape / heat map bands / posterised landscape', ids: ['terrain_bands', 'topographic'] },
```
Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/terrain_bands.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/terrain_bands_128.png tests-unit/shaderfx_golden/terrain_bands_256.png && git commit -m "feat(shaders): terrain_bands — banded contour landscape over an ink ramp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `sonar` — dithered landmasses (playgrnd Sonar)

A thresholded fbm field on a coarse pixel grid: sea below the level, land above, and an ordered-dither shoreline where the field crosses the level. Two colours, no ramp.

**Files:**
- Create: `shader_effects/sonar.frag`
- Modify: `shader_effects/manifest.json`
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/sonar_128.png`, `sonar_256.png`

**Interfaces:**
- Produces: catalog id `sonar` with params `u_sea (color), u_land (color), u_level, u_edge, u_scale, u_detail, u_cell, u_speed, u_mix`.

- [ ] **Step 1: Manifest entry**

Append to `effects`:
```json
    {
      "id": "sonar",
      "name": "Sonar",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_sea", "label": "Sea", "type": "color", "default": "#0b1d3a" },
        { "uniform": "u_land", "label": "Land", "type": "color", "default": "#e8e2d0" },
        { "uniform": "u_level", "label": "Sea level", "type": "float", "min": 0.0, "max": 1.0, "default": 0.5, "step": 0.01 },
        { "uniform": "u_edge", "label": "Shore width", "type": "float", "min": 0.0, "max": 0.5, "default": 0.12, "step": 0.01 },
        { "uniform": "u_scale", "label": "Field scale", "type": "float", "min": 0.5, "max": 8.0, "default": 2.0, "step": 0.1 },
        { "uniform": "u_detail", "label": "Detail", "type": "float", "min": 1, "max": 7, "default": 5, "step": 1 },
        { "uniform": "u_cell", "label": "Pixel size", "type": "float", "min": 1, "max": 8, "default": 3, "step": 1 },
        { "uniform": "u_speed", "label": "Speed", "type": "float", "min": 0.0, "max": 3.0, "default": 0.4, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: See the catalog test fail**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'sonar'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/sonar.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}
// 4x4 ordered dither threshold (same table as bayer_dither.frag's B4).
const int B4[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
float bayer4(vec2 px) {
    ivec2 p = ivec2(mod(floor(px), 4.0));
    return (float(B4[p.x + p.y * 4]) + 0.5) / 16.0;
}

uniform vec3 u_sea;
uniform vec3 u_land;
uniform float u_level;
uniform float u_edge;
uniform float u_scale;
uniform float u_detail;
uniform float u_cell;
uniform float u_speed;
uniform float u_mix;

void main() {
    // Snap to a coarse pixel grid first so the dither is chunky, not per-device-pixel.
    float cell = max(u_cell, 1.0);
    vec2 px = floor(v_texCoord * u_resolution / cell);
    vec2 uv = (px + 0.5) * cell / u_resolution;
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (uv - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.1;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);

    float h = fbmN(p + vec2(t, -t * 0.7), u_seed, oct);
    // Coastline: the chance of "land" rises across the shore band, and the ordered
    // dither turns that chance into a stippled edge.
    float prob = smoothstep(u_level - u_edge, u_level + u_edge, h);
    float land = step(bayer4(px), prob);
    vec3 col = mix(u_sea, u_land, land);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
```

- [ ] **Step 4: Uniform contract**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Goldens**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: only `?? .../sonar_128.png` and `?? .../sonar_256.png`. Restore any ` M` file with `git checkout -- <file>`.

- [ ] **Step 6: Python render test + parity**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q && cd frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "sonar"
```
Expected: pytest all PASS; Playwright 2 passed.

- [ ] **Step 7: Look at it**

Shader Studio, no source, "Sonar". Expected: cream landmasses on navy with a speckled coastline. "Shore width" to 0: hard coast, no speckle. "Pixel size" to 8: chunky.

- [ ] **Step 8: Agent word + commit**

Add `'sonar'` to the `BACKGROUND FROM NOTHING` ids and add:
```ts
  { words: 'dithered map / landmasses / islands / radar map / sonar', ids: ['sonar'] },
```
Run `npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts` (PASS), then:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/sonar.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/sonar_128.png tests-unit/shaderfx_golden/sonar_256.png && git commit -m "feat(shaders): sonar — dithered landmasses, two inks and a stippled shore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `mist` — sprayed neon washes (playgrnd Mist)

Soft blobs of ramp inks screen-blended onto the first ink (the paper), with per-pixel spray eating into each wash toward its edge.

**Files:**
- Create: `shader_effects/mist.frag`
- Modify: `shader_effects/manifest.json`
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/mist_128.png`, `mist_256.png`

**Interfaces:**
- Produces: catalog id `mist` with params `u_ramp (gradient), u_blobs, u_size, u_soft, u_grain, u_speed, u_mix`.

- [ ] **Step 1: Manifest entry**

```json
    {
      "id": "mist",
      "name": "Mist",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_ramp", "label": "Inks", "type": "gradient", "maxStops": 8,
          "default": [
            { "pos": 0.0, "color": "#0d0b16" },
            { "pos": 0.25, "color": "#ff3fa4" },
            { "pos": 0.5, "color": "#7b5cff" },
            { "pos": 0.75, "color": "#2ee6d6" },
            { "pos": 1.0, "color": "#ffe93b" }
          ] },
        { "uniform": "u_blobs", "label": "Washes", "type": "float", "min": 1, "max": 12, "default": 6, "step": 1 },
        { "uniform": "u_size", "label": "Wash size", "type": "float", "min": 0.1, "max": 1.0, "default": 0.45, "step": 0.05 },
        { "uniform": "u_soft", "label": "Softness", "type": "float", "min": 0.0, "max": 1.0, "default": 0.7, "step": 0.05 },
        { "uniform": "u_grain", "label": "Spray", "type": "float", "min": 0.0, "max": 1.0, "default": 0.35, "step": 0.05 },
        { "uniform": "u_speed", "label": "Drift", "type": "float", "min": 0.0, "max": 3.0, "default": 0.6, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: See the catalog test fail**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'mist'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/mist.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}

#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}

uniform float u_blobs;
uniform float u_size;
uniform float u_soft;
uniform float u_grain;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 uv = v_texCoord * asp;
    vec2 px = floor(v_texCoord * u_resolution);
    float t = u_time * u_speed * 0.2;
    int n = int(clamp(u_blobs, 1.0, 12.0) + 0.5);

    vec3 col = u_ramp[0];                                  // first ink is the paper
    float sharp = mix(6.0, 1.5, clamp(u_soft, 0.0, 1.0));  // softer = wider falloff
    for (int i = 0; i < 12; i++) {
        if (i >= n) break;
        float fi = float(i);
        // Each wash has a seeded home position and drifts gently around it.
        vec2 c = vec2(hash2(vec2(fi, 0.0), u_seed), hash2(vec2(fi, 1.0), u_seed)) * asp;
        c += 0.08 * vec2(sin(t + fi * 1.7), cos(t * 0.8 + fi * 2.3));
        float d = length(uv - c) / max(u_size, 0.05);
        float w = exp(-d * d * sharp);
        // Spray: per-pixel noise eats into the wash more toward its edge.
        float spray = 1.0 - u_grain * hash2(px, u_seed + 31.0 + fi) * (0.3 + 0.7 * min(d, 1.5));
        w = clamp(w * spray, 0.0, 1.0);
        // Skip the paper ink (ramp position 0) so washes are always the bright inks.
        vec3 ink = rampAt(0.15 + 0.85 * fract(fi * 0.618034 + 0.31));
        col = 1.0 - (1.0 - col) * (1.0 - ink * w);         // screen blend: neon adds light
    }

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
```

- [ ] **Step 4: Uniform contract**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Goldens**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: only `?? .../mist_128.png` and `?? .../mist_256.png`. Restore any ` M` file with `git checkout -- <file>`.

- [ ] **Step 6: Python render test + parity**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q && cd frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "mist"
```
Expected: pytest all PASS; Playwright 2 passed.

- [ ] **Step 7: Look at it**

Shader Studio, no source, "Mist". Expected: six glowing neon clouds on near-black, edges speckled like spray paint, drifting. "Spray" to 0: smooth airbrush. "Washes" to 1: a single cloud.

- [ ] **Step 8: Agent word + commit**

Add `'mist'` to the `BACKGROUND FROM NOTHING` ids and add:
```ts
  { words: 'neon wash / spray paint clouds / airbrush glow / mist', ids: ['mist', 'nebula'] },
```
Run `npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts` (PASS), then:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/mist.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/mist_128.png tests-unit/shaderfx_golden/mist_256.png && git commit -m "feat(shaders): mist — sprayed neon washes screen-blended over the paper ink

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `pixel_bloom` — symmetrical pixel fields (playgrnd Bloom and Totem)

Low-resolution value noise on a coarse cell grid, mirrored left-right and/or top-bottom, quantised to a few levels through the ramp. Totem is the same effect at a tall frame ratio, so one shader covers both.

**Files:**
- Create: `shader_effects/pixel_bloom.frag`
- Modify: `shader_effects/manifest.json`
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/pixel_bloom_128.png`, `pixel_bloom_256.png`

**Interfaces:**
- Produces: catalog id `pixel_bloom` with params `u_ramp (gradient), u_cells, u_levels, u_mirror (enum 0 none, 1 left-right, 2 top-bottom, 3 both), u_scale, u_speed, u_mix`.

- [ ] **Step 1: Manifest entry**

```json
    {
      "id": "pixel_bloom",
      "name": "Pixel Bloom",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_ramp", "label": "Inks", "type": "gradient", "maxStops": 8,
          "default": [
            { "pos": 0.0, "color": "#0a0a0f" },
            { "pos": 0.25, "color": "#1d3a8a" },
            { "pos": 0.5, "color": "#3c8dde" },
            { "pos": 0.75, "color": "#8ee1ff" },
            { "pos": 1.0, "color": "#ffffff" }
          ] },
        { "uniform": "u_cells", "label": "Cells across", "type": "float", "min": 8, "max": 96, "default": 24, "step": 1 },
        { "uniform": "u_levels", "label": "Levels", "type": "float", "min": 2, "max": 8, "default": 4, "step": 1 },
        { "uniform": "u_mirror", "label": "Mirror", "type": "enum", "default": 1,
          "options": [
            { "label": "None", "value": 0 },
            { "label": "Left-right", "value": 1 },
            { "label": "Top-bottom", "value": 2 },
            { "label": "Both", "value": 3 }
          ] },
        { "uniform": "u_scale", "label": "Field scale", "type": "float", "min": 0.5, "max": 6.0, "default": 2.0, "step": 0.1 },
        { "uniform": "u_speed", "label": "Speed", "type": "float", "min": 0.0, "max": 3.0, "default": 0.5, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: See the catalog test fail**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'pixel_bloom'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/pixel_bloom.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}
float bandq(float t, float steps) {
    steps = max(steps, 2.0);
    return min(floor(clamp(t, 0.0, 0.9999) * steps), steps - 1.0) / (steps - 1.0);
}

uniform float u_cells;
uniform float u_levels;
uniform float u_mirror;
uniform float u_scale;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    // Coarse cell grid, `u_cells` across the short axis (rounded to whole cells on the long axis); one field sample per cell.
    // Whole cell counts on both axes so a mirrored cell lands exactly on its twin on any
    // frame size; cells are then square to within one part in u_cells, not exactly square.
    vec2 grid = floor(max(u_cells, 2.0) * asp + 0.5);
    vec2 cellId = floor(v_texCoord * grid);
    vec2 uv = (cellId + 0.5) / grid;

    // Mirroring folds the cell centre back onto its twin so the two halves match exactly.
    int m = int(u_mirror + 0.5);
    if (m == 1 || m == 3) uv.x = 0.5 - abs(uv.x - 0.5);
    if (m == 2 || m == 3) uv.y = 0.5 - abs(uv.y - 0.5);

    vec2 p = (uv - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.15;
    float h = fbmN(p + vec2(t, 0.0), u_seed, 5);
    h = clamp((h - 0.5) * 2.2 + 0.5, 0.0, 1.0);
    vec3 col = rampAt(bandq(h, u_levels));

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
```

- [ ] **Step 4: Uniform contract**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Goldens**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: only `?? .../pixel_bloom_128.png` and `?? .../pixel_bloom_256.png`. Restore any ` M` file with `git checkout -- <file>`.

- [ ] **Step 6: Python render test + parity**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q && cd frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "pixel_bloom"
```
Expected: pytest all PASS; Playwright 2 passed.

- [ ] **Step 7: Look at it**

Shader Studio, no source, "Pixel Bloom". Expected: chunky four-level blue pixel field, left half a mirror of the right. "Mirror" to Both: four-way symmetry. Set aspect 9:16: the Totem banner look.

- [ ] **Step 8: Agent word + commit**

Add `'pixel_bloom'` to the `BACKGROUND FROM NOTHING` ids and add:
```ts
  { words: 'symmetrical pixels / mirrored pixel field / pixel banner / totem / kaleidoscope pixels', ids: ['pixel_bloom'] },
```
Run `npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts` (PASS), then:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/pixel_bloom.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/pixel_bloom_128.png tests-unit/shaderfx_golden/pixel_bloom_256.png && git commit -m "feat(shaders): pixel_bloom — mirrored, quantised pixel field over an ink ramp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `filament` — flowing thread fields (playgrnd Filament)

Threads are iso-lines of a heavily domain-warped field, so they flow rather than ripple. Each thread gets its own ink from the ramp and its weight breathes along its length so it reads as fibre, not a contour map.

**Files:**
- Create: `shader_effects/filament.frag`
- Modify: `shader_effects/manifest.json`
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/filament_128.png`, `filament_256.png`

**Interfaces:**
- Produces: catalog id `filament` with params `u_ramp (gradient), u_threads, u_thickness, u_flow, u_scale, u_speed, u_mix`.

- [ ] **Step 1: Manifest entry**

```json
    {
      "id": "filament",
      "name": "Filament",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_ramp", "label": "Inks", "type": "gradient", "maxStops": 8,
          "default": [
            { "pos": 0.0, "color": "#101014" },
            { "pos": 0.25, "color": "#ff6a3d" },
            { "pos": 0.5, "color": "#ffd23f" },
            { "pos": 0.75, "color": "#3dd6ff" },
            { "pos": 1.0, "color": "#c6ff6a" }
          ] },
        { "uniform": "u_threads", "label": "Threads", "type": "float", "min": 4, "max": 40, "default": 14, "step": 1 },
        { "uniform": "u_thickness", "label": "Thread weight", "type": "float", "min": 0.05, "max": 0.6, "default": 0.18, "step": 0.01 },
        { "uniform": "u_flow", "label": "Flow", "type": "float", "min": 0.0, "max": 3.0, "default": 1.5, "step": 0.05 },
        { "uniform": "u_scale", "label": "Field scale", "type": "float", "min": 0.5, "max": 8.0, "default": 2.0, "step": 0.1 },
        { "uniform": "u_speed", "label": "Speed", "type": "float", "min": 0.0, "max": 3.0, "default": 0.8, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: See the catalog test fail**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'filament'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/filament.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}

uniform float u_threads;
uniform float u_thickness;
uniform float u_flow;
uniform float u_scale;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.1;

    // Two-stage warp: the field bends itself so the threads flow instead of ripple.
    vec2 q = vec2(fbmN(p + vec2(t, 0.0), u_seed, 5), fbmN(p + vec2(0.0, -t), u_seed + 5.0, 5));
    float v = fbmN(p + u_flow * (q - 0.5) * 2.5, u_seed + 17.0, 6);

    // Threads are iso-lines of the warped field, `u_threads` of them across 0..1.
    float f = v * u_threads + t * 2.0;
    float dEdge = abs(fract(f + 0.5) - 0.5) * 2.0;   // 0 on a thread, 1 midway between
    float aa = fwidth(f) * 2.0;
    // Thread weight breathes along its length so it reads as fibre, not a contour map.
    float th = u_thickness * (0.5 + fbmN(p * 3.0 + 7.0, u_seed + 41.0, 3));
    float line = 1.0 - smoothstep(th - aa, th + aa, dEdge);

    // Each thread picks its own ink; the first ink is the ground between threads.
    // Round to the NEAREST integer: a thread is centred on integer f and its band straddles
    // it, so floor(f) would change ink halfway across the thread.
    vec3 ink = rampAt(0.2 + 0.8 * fract(floor(f + 0.5) * 0.618034));
    vec3 col = mix(u_ramp[0], ink, line);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
```

- [ ] **Step 4: Uniform contract**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Goldens**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: only `?? .../filament_128.png` and `?? .../filament_256.png`. Restore any ` M` file with `git checkout -- <file>`.

- [ ] **Step 6: Python render test + parity**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q && cd frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "filament"
```
Expected: pytest all PASS; Playwright 2 passed. If the parity test fails only on `filament` with a small mean diff, the cause is `fwidth` differing between GPU and server; widen nothing, instead replace `float aa = fwidth(f) * 2.0;` with `float aa = 2.0 * u_threads / u_resolution.y;` (a resolution-based estimate that is identical on both sides), regenerate goldens, rerun.

- [ ] **Step 7: Look at it**

Shader Studio, no source, "Filament". Expected: many coloured threads sweeping across a dark ground, each thread one colour end to end, weight varying along its length, flowing slowly. "Flow" to 0: smooth contour lines with no swirl. "Threads" to 40: dense.

- [ ] **Step 8: Agent word + commit**

Add `'filament'` to the `BACKGROUND FROM NOTHING` ids and add:
```ts
  { words: 'threads / fibres / flowing lines / string field / filament', ids: ['filament', 'light_beams'] },
```
Run `npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts` (PASS), then:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/filament.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/filament_128.png tests-unit/shaderfx_golden/filament_256.png && git commit -m "feat(shaders): filament — flowing thread field, one ink per thread

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `sear` — smeared thermal fields (playgrnd Sear)

A banded heat field (like Terrain Bands) on a coarse pixel grid, then broken the way a dropped video frame breaks: every row drags sideways by its own amount, a few rows tear a long way, and each row holds its hottest value for a stretch to the left. Single pass; the smear is a horizontal max over a few taps.

**Files:**
- Create: `shader_effects/sear.frag`
- Modify: `shader_effects/manifest.json`
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts`
- Create (generated): `tests-unit/shaderfx_golden/sear_128.png`, `sear_256.png`

**Interfaces:**
- Produces: catalog id `sear` with params `u_ramp (gradient), u_steps, u_scale, u_bend, u_detail, u_streak, u_drag, u_tear, u_grain, u_cell, u_speed, u_mix`.

- [ ] **Step 1: Manifest entry**

```json
    {
      "id": "sear",
      "name": "Sear",
      "category": "generative",
      "animated": true,
      "passes": 1,
      "centerParam": null,
      "textures": [],
      "generative": true,
      "params": [
        { "uniform": "u_ramp", "label": "Inks (cool to hot)", "type": "gradient", "maxStops": 8,
          "default": [
            { "pos": 0.0, "color": "#1a1450" },
            { "pos": 0.2, "color": "#2b4bd6" },
            { "pos": 0.4, "color": "#25b7a0" },
            { "pos": 0.6, "color": "#f0e442" },
            { "pos": 0.8, "color": "#f28c28" },
            { "pos": 1.0, "color": "#e0323c" }
          ] },
        { "uniform": "u_steps", "label": "Steps", "type": "float", "min": 2, "max": 12, "default": 6, "step": 1 },
        { "uniform": "u_scale", "label": "Blob size", "type": "float", "min": 0.5, "max": 8.0, "default": 2.2, "step": 0.1 },
        { "uniform": "u_bend", "label": "Bend", "type": "float", "min": 0.0, "max": 3.0, "default": 1.0, "step": 0.05 },
        { "uniform": "u_detail", "label": "Detail", "type": "float", "min": 1, "max": 6, "default": 4, "step": 1 },
        { "uniform": "u_streak", "label": "Streak", "type": "float", "min": 0.0, "max": 1.0, "default": 0.35, "step": 0.05 },
        { "uniform": "u_drag", "label": "Drag", "type": "float", "min": 0.0, "max": 1.0, "default": 0.22, "step": 0.02 },
        { "uniform": "u_tear", "label": "Tear", "type": "float", "min": 0.0, "max": 1.0, "default": 0.3, "step": 0.05 },
        { "uniform": "u_grain", "label": "Grain", "type": "float", "min": 0.0, "max": 1.0, "default": 0.1, "step": 0.05 },
        { "uniform": "u_cell", "label": "Pixel size", "type": "float", "min": 1, "max": 12, "default": 4, "step": 1 },
        { "uniform": "u_speed", "label": "Speed", "type": "float", "min": 0.0, "max": 3.0, "default": 0.6, "step": 0.05 },
        { "uniform": "u_mix", "label": "Image mix", "type": "float", "min": 0.0, "max": 1.0, "default": 0.0, "step": 0.05 }
      ]
    }
```

- [ ] **Step 2: See the catalog test fail**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q -k catalog_loads
```
Expected: FAIL with `missing shader file for 'sear'`.

- [ ] **Step 3: Write the shader**

Create `shader_effects/sear.frag`:
```glsl
#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}
float bandq(float t, float steps) {
    steps = max(steps, 2.0);
    return min(floor(clamp(t, 0.0, 0.9999) * steps), steps - 1.0) / (steps - 1.0);
}

uniform float u_steps;
uniform float u_scale;
uniform float u_bend;
uniform float u_detail;
uniform float u_streak;
uniform float u_drag;
uniform float u_tear;
uniform float u_grain;
uniform float u_cell;
uniform float u_speed;
uniform float u_mix;

// The heat field: fbm pushed through itself by `u_bend` so blobs lean and fold.
float heat(vec2 uv, float t, int oct) {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (uv - 0.5) * asp * u_scale;
    vec2 q = vec2(fbmN(p + vec2(0.0, t), u_seed, oct), fbmN(p + vec2(4.1, 2.7) - t, u_seed + 7.0, oct));
    return fbmN(p + u_bend * (q - 0.5) * 2.5, u_seed + 17.0, oct);
}

void main() {
    float cell = max(u_cell, 1.0);
    vec2 px = floor(v_texCoord * u_resolution / cell);
    vec2 uv = (px + 0.5) * cell / u_resolution;
    float t = u_time * u_speed * 0.15;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);
    float frame = floor(u_time * 6.0);   // the row breaks re-roll at ~6 fps, like dropped frames

    // Drag: every row slides sideways by its own amount. Tear: a few rows jump a long way.
    float row = px.y;
    float dx = (hash2(vec2(row, 0.0), u_seed + frame) - 0.5) * u_drag * 0.25;
    if (hash2(vec2(row, 1.0), u_seed + frame) < u_tear * 0.12) {
        dx += (hash2(vec2(row, 2.0), u_seed + frame) - 0.5) * 0.8;
    }
    vec2 suv = vec2(uv.x + dx, uv.y);

    // Streak: a row holds its hottest value for a stretch to the left (a horizontal max-smear).
    float h = heat(suv, t, oct);
    for (int k = 1; k <= 4; k++) {
        float off = float(k) * u_streak * 0.04;
        h = max(h, heat(suv - vec2(off, 0.0), t, oct) - float(k) * 0.02);
    }
    h = clamp((h - 0.5) * 2.0 + 0.5, 0.0, 1.0);

    float g = (hash2(px, u_seed + 99.0) - 0.5) * u_grain / max(u_steps, 2.0);
    vec3 col = rampAt(bandq(h + g, u_steps));

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
```

- [ ] **Step 4: Uniform contract**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-manifest-uniforms.unit.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Goldens**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python tests-unit/shaderfx_golden/generate_goldens.py && git status --short tests-unit/shaderfx_golden
```
Expected: only `?? .../sear_128.png` and `?? .../sear_256.png`. Restore any ` M` file with `git checkout -- <file>`.

- [ ] **Step 6: Python render test + parity**

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python -m pytest tests-unit/comfy_extras_test/shader_effects_test.py -q && cd frontend && npx playwright test tests/shaderfx-golden.spec.ts -g "sear"
```
Expected: pytest all PASS; Playwright 2 passed.

- [ ] **Step 7: Look at it and check cost**

Shader Studio, no source, "Sear". Expected: thermal-camera blobs in six hard bands, rows dragged sideways, occasional whole-row tears, hot colours smearing to the left. "Streak", "Drag" and "Tear" all to 0: a clean banded field. Then set the Shader Studio resolution to its largest option and confirm the preview still animates without stutter. If it stutters, lower the default of "Detail" in the manifest from 4 to 3 and regenerate goldens (Step 5 and 6 again).

- [ ] **Step 8: Agent word + commit**

Add `'sear'` to the `BACKGROUND FROM NOTHING` ids and add:
```ts
  { words: 'thermal camera / heat map smear / infrared / dropped frame bands / sear', ids: ['sear', 'terrain_bands'] },
```
Run `npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts` (PASS), then:
```bash
cd /Users/julien/Documents/GitHub/Sailor && git add shader_effects/sear.frag shader_effects/manifest.json frontend/app/lib/shaderstudio/agentControls.ts tests-unit/shaderfx_golden/sear_128.png tests-unit/shaderfx_golden/sear_256.png && git commit -m "feat(shaders): sear — banded thermal field with row drag, tear and streak

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Agent words for the three chain looks (Prism, Atlas, Delta)

Three playgrnd looks need no new shader; they are chains of catalog effects. The agent needs the words so a request like "pixel aurora" resolves to the right stack.

**Files:**
- Modify: `frontend/app/lib/shaderstudio/agentControls.ts` (`SHADER_LOOK_CLUSTERS`)
- Test: `frontend/tests/unit/shader-agent-vocab.unit.spec.ts`

**Interfaces:**
- Consumes: ids `aurora`, `bayer_dither`, `ascii_dither`, `block_glitch` (pre-existing), `terrain_bands` (Task 2), `pixel_sort` (Task 1).

- [ ] **Step 1: Confirm the ids exist in the manifest**

Run:
```bash
cd /Users/julien/Documents/GitHub/Sailor && python3 -c "import json;ids={e['id'] for e in json.load(open('shader_effects/manifest.json'))['effects']};print([i for i in ['aurora','bayer_dither','ascii_dither','block_glitch','terrain_bands','pixel_sort'] if i not in ids])"
```
Expected: `[]`. If any id prints, that task was not completed; finish it first.

- [ ] **Step 2: Add the clusters**

Add to `SHADER_LOOK_CLUSTERS`:
```ts
  { words: 'pixel aurora / retro aurora / dithered northern lights (aurora then bayer_dither)', ids: ['aurora', 'bayer_dither'] },
  { words: 'text-mode map / ascii terrain / character terrain (terrain_bands then ascii_dither)', ids: ['terrain_bands', 'ascii_dither'] },
  { words: 'corrupted satellite / broken map mosaic (terrain_bands then block_glitch and pixel_sort)', ids: ['terrain_bands', 'block_glitch', 'pixel_sort'] },
```

- [ ] **Step 3: Run the vocabulary test**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vitest run tests/unit/shader-agent-vocab.unit.spec.ts
```
Expected: PASS. If the ceiling test fails, shorten the parenthetical hints in the three lines above.

- [ ] **Step 4: Try one in the app**

In a Shader Studio with no source, ask the agent panel "make me a pixel aurora background". Expected: it picks aurora and adds bayer_dither. If it picks aurora only, that is acceptable for this plan; note it in the commit body.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/app/lib/shaderstudio/agentControls.ts && git commit -m "feat(shader-agent): look words for pixel aurora, ascii terrain, corrupted satellite chains

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Prove a new generator renders as a Frame fill (not the fallback gradient)

Shader is already a fill type in Frame: the Compositor fill picker lists it for shape fills and the background, and the Frame card runs the clock. The existing Frame test in `frontend/tests/shader-fill.spec.ts` documents a known gap where the Compositor edit view painted the fallback input gradient instead of the field. This task proves the Frame CARD (not the edit modal) paints `terrain_bands` for real, by diffing against the same layer with a plain gradient fill.

**Files:**
- Modify: `frontend/app/components/vue-canvas/ArtifactFrameNode.vue:1106` (add a test id to the stack canvas)
- Create: `frontend/tests/frame-generative-fill.spec.ts`

**Interfaces:**
- Consumes: catalog id `terrain_bands` (Task 2); the `sailor:addNode` window event with `propertyOverrides.sailor_localLayers` (existing, see `shader-fill.spec.ts`); `waitForBackend` from `frontend/tests/_helpers.ts`.
- Produces: `data-testid="frame-card-stack-canvas"` on the Frame card's preview canvas.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/frame-generative-fill.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { waitForBackend } from './_helpers'

/**
 * A generative catalog effect used as a Frame layer fill must paint the FIELD on the
 * Frame card, not the shader spec's fallback input gradient. Graceful fallback makes a
 * plausible-looking image worthless as evidence, so the assertion is a pixel diff
 * against the same layer painted with that very gradient: if the field ran, the two
 * cards differ; if it fell back, they are identical.
 */

async function openBlankWorkflow(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Comfy.VueNodes.Enabled', 'true') } catch {}
  })
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  const vueFlow = page.locator('.vue-flow').first()
  if (!(await vueFlow.isVisible({ timeout: 3_000 }).catch(() => false))) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: /Start a blank project/i }).first().click()
      const ok = await vueFlow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
      if (ok) break
      if (attempt === 2) throw new Error('openBlankWorkflow: .vue-flow never appeared after 3 attempts')
    }
  }
  const skip = page.getByRole('button', { name: /Skip — start with a blank canvas/i })
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skip.click()
    await skip.waitFor({ state: 'hidden', timeout: 5_000 })
  }
}

async function addFrame(page: Page, id: string, fill: unknown) {
  await page.evaluate(({ id, fill }) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', {
      detail: {
        nodeType: 'Compositor',
        propertyOverrides: {
          sailor_localLayers: [{
            id, kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.9, h: 0.9, radius: 0,
            fill, stroke: '', strokeWidth: 0,
          }],
        },
      },
    }))
  }, { id, fill })
  await page.waitForTimeout(500)
}

const GRADIENT = { type: 'gradient', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
const SHADER = {
  type: 'shader', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8,
  shader: { effectId: 'terrain_bands', params: {}, anchor: 'object', speed: 0, input: GRADIENT },
}

function diffCount(a: PNG, b: PNG, tol = 12): number {
  let n = 0
  for (let i = 0; i < Math.min(a.data.length, b.data.length); i += 4 * 23) {
    if (Math.abs(a.data[i]! - b.data[i]!) > tol) n++
  }
  return n
}

test('terrain_bands as a Frame layer fill paints the field, not the fallback gradient', async ({ page }) => {
  await waitForBackend(page)
  await openBlankWorkflow(page)
  await page.setViewportSize({ width: 1600, height: 2000 })

  await addFrame(page, 'll-gen-shader', SHADER)
  await addFrame(page, 'll-gen-gradient', GRADIENT)

  const canvases = page.locator('[data-testid="frame-card-stack-canvas"]')
  await expect(canvases).toHaveCount(2, { timeout: 10_000 })
  // Let the catalog fetch land and the static repaint run.
  await page.waitForTimeout(2_500)

  const shaderShot = PNG.sync.read(await canvases.nth(0).screenshot())
  const gradientShot = PNG.sync.read(await canvases.nth(1).screenshot())
  expect(shaderShot.width).toBe(gradientShot.width)
  expect(shaderShot.height).toBe(gradientShot.height)

  // The load-bearing check: a fallback would render the same gradient on both cards.
  expect(diffCount(shaderShot, gradientShot)).toBeGreaterThan(40)
})
```

- [ ] **Step 2: Run it to see it fail**

With ComfyUI and the dev server running:
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/frame-generative-fill.spec.ts
```
Expected: FAIL at `toHaveCount(2)` because the test id does not exist yet.

- [ ] **Step 3: Add the test id**

In `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` line 1106, change:
```html
        <canvas ref="stackCanvas" class="absolute inset-0 pointer-events-none" :style="{ width: box.w + 'px', height: box.h + 'px' }" />
```
to:
```html
        <canvas ref="stackCanvas" data-testid="frame-card-stack-canvas" class="absolute inset-0 pointer-events-none" :style="{ width: box.w + 'px', height: box.h + 'px' }" />
```

- [ ] **Step 4: Run the test again**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx playwright test tests/frame-generative-fill.spec.ts
```
Expected: PASS.

If it FAILS on the diff assertion (both cards look the same), the Frame card is painting the fallback. Do not loosen the threshold. Reproduce at HEAD first: open the app, add a Frame, set a rect's fill to Shader → Terrain Bands, and look. If the card shows a plain white-to-black gradient, the shader-fill path is not running on the card. Stop and report with the screenshot; that is a real bug outside this plan's scope and the user decides.

- [ ] **Step 5: Typecheck the touched Vue file**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend && npx vue-tsc --noEmit 2>&1 | grep -c "ArtifactFrameNode.vue"
```
Expected: `0` (no new errors naming this file; pre-existing errors in other files are the baseline).

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && git add frontend/tests/frame-generative-fill.spec.ts frontend/app/components/vue-canvas/ArtifactFrameNode.vue && git commit -m "test(frame): generative catalog effect renders as a Frame layer fill (diff vs fallback gradient)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Coverage against the mapping:** Terrain (Tasks 1+2), Stipple (1), Mosh (1), Sonar (3), Mist (4), Bloom and Totem (5), Filament (6), Sear (7), Prism/Atlas/Delta (8), Aura needs nothing (already `mesh_gradient` and Gradient Studio's aurora look). Frame fill proof (9). Pane and Rise are Gradient Studio presets and belong to the next plan.
- **Names are consistent across tasks:** `rampAt`, `bandq`, `fbmN`, `hash2`, `bayer4` are defined in every frag that uses them, since frags cannot share code. Catalog ids used in Task 8 and Task 9 are exactly the ids registered in Tasks 1 to 7.
- **Every frag declares only uniforms its manifest entry lists** plus harness-supplied ones. `sonar` and `mist` deliberately omit helpers they do not use so the uniform contract test stays green.
