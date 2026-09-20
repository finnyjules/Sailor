# playgrnd.tools: the five new tools (Carve, Culture, Chaff, Strand, Husk)

Decided with the user 2026-09-04 (after reading every generator in full):
- **Carve** is a panel composition → a **Mosaic style** (canvas), beside Modular.
- **Chaff, Strand, Husk** are scatters of thrown marks → a new **Scatter element**
  in the Frame Shapes menu, sibling of Mosaic, with a Style control (Chaff / Strand /
  Husk — the tool names, like the Mosaic styles), each style's dials, a Palette of its
  2–3 roles, New variation.
- **Culture** is a pure per-pixel field → a **Shader Studio generative** (`culture`),
  which also becomes a Frame fill for free through the shader-as-fill path.

## Global Constraints (binding on every task)

1. **Source, not names.** Each tool's full generator is captured READ-ONLY at
   `/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/4fda6bf5-134a-4a65-87b8-1db23c020c83/scratchpad/playgrnd-<tool>-generator-reference.js`
   (`carve`, `culture`, `chaff`, `strand`, `husk`). Read the whole file before writing a
   line. **Never copy code from it** (the site has no license): reimplement every rule in
   your own code with your own hash / RNG / noise / GLSL. The module's header comment
   carries a **rule checklist**: one line per rule of the tool, each mapped to the
   reference's line numbers, so a reviewer can read the port against the source as code.
2. **Fidelity is judged as code, then by eye.** Render character PNGs of the port (the
   default, then each dial at its extremes, then 3 seeds) to the session scratchpad with
   a node script modelled on `scratchpad/modular-render.mjs` / `mosh-render.mjs`
   (canvas via the `canvas` npm package or a headless browser — whichever those scripts
   use), compare them with the tool's own renders (open `https://www.playgrnd.tools/<tool>/`
   in the browser pane at the same seed if you can), and list the differences you can
   see in your report. Parity tests and goldens only prove renderers agree.
3. **Host integration lessons (all bit us before):**
   - Never write an absolute `ctx.globalAlpha` / `ctx.globalCompositeOperation`: capture
     the incoming alpha and SCALE by it; capture the entry op and RESTORE to it.
   - Paint in box space: `(0,0)`–`(boxW,boxH)`, both width-normalized (`layer.w * W`,
     `layer.h * W`). The host clips to the box; tools rely on the canvas edge for
     clipping, so oversized rects are fine, but never assume the box is the frame.
   - Any fixed op-count cap must cover the largest box at bake size.
   - Raw layer objects reach paint un-normalized: derive everything from normalized
     params (`normalizeX(partial)` like `normalizeModular`), never from `layer.x` directly.
   - Sizes in the tools are in units of `√(frame area)`; use `√(boxW·boxH)` so a wide box
     is not a denser box (their comments say why).
   - Per-pixel passes (`getImageData` / `createImageData`) go on an OFFSCREEN canvas at the
     box's paint resolution (`boxW×boxH` in ctx pixels, read the ctx transform's scale to
     size it — see how brush / effected layers size their offscreen canvases), capped at
     6 000 000 pixels (the tools' own max is 2400²), then `drawImage`d into the box.
4. **Seeds.** One seed per element (`grid.gen.seed` on a Mosaic; `seed` on a Scatter);
   New variation re-rolls it; two seeds → two different pictures (test it). Own xorshift /
   hash — never `Math.random` inside paint.
5. **Palettes as roles.** The tools' inks have JOBS (plate / silhouette / fill; ground /
   ink; plate + rings). Keep the roles in order; expose the tool's palette table as named
   Palette presets (`<TOOL>_PALETTE_PRESETS`, names in plain language, no hex in the UI).
6. **UI rules:** plain-language labels (no jargon, no tool internals); Studio components
   only (`StudioSlider` / `StudioSelect` / `StudioButton` — never hand-rolled controls);
   action-blue is the only accent, purple is banned; a select that only STORES its value
   is a dead control — chase it to the code that consumes it.
7. **Tests:** vitest specs under `frontend/tests/unit/` (run `npx vitest run <file>`); the
   headless-canvas harness in `tests/unit/deal-layer.unit.spec.ts` shows how to drive
   `drawLayerContent` without a browser. `npx nuxi typecheck` error count must stay at the
   baseline (415 at plan time; `npx nuxi typecheck 2>&1 | grep -c "error TS"`).
8. **Commit hygiene (parallel sessions share this checkout):** commit on `main` directly;
   stage ONLY your own files by explicit path (`git add <path> …`); never `git add -A`,
   never `git stash`, never touch files you did not change (other sessions' dirty hunks are
   in the tree). Commit message trailer:
   `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `timeout` does not exist on
   this Mac. Work from `/Users/julien/Documents/GitHub/Sailor/frontend`.
9. **Precedents to copy the SHAPE of (read them first):** `app/lib/compositor/modular.ts`
   (a canvas Mosaic style: params + normalize + presets + pure layout fns + `paintX`),
   `app/lib/compositor/mosaic.ts` (style table, patches), the deal branch of
   `drawLayerContent` and `layerPaints` in `app/composables/useCompositorLayers.ts`, the
   Mosaic inspector block in `app/components/vue-canvas/CompositorModal.vue` (search
   "Mosaic"), the `mosaic` op in `app/lib/agent/surfaces/compositor.ts`,
   `shader_effects/oddgrid.frag` + `static.frag` + their `manifest.json` entries and
   `EFFECT_LOOKS` in `app/lib/shaderstudio/presets.ts`, and the Mosaic element commits
   `e0b9119ba`, `13e9c9142`, `3feff5053` (`git show --stat`) for how an element is added to
   the Shapes menu end to end.

---

## Task 1: Carve as a Mosaic style

**What Carve is (from `playgrnd-carve-generator-reference.js`, read it whole):** one
rectangle recursively SPLIT `cuts` times — each cut picks among the largest few panels,
splits across the long side (18% chance the short side) at `0.5 ± uneven·0.43`
(clamped), sorted top-to-bottom, left-to-right; then every panel gets a TREATMENT in two
palette inks: flat / two-pitch STRIPES (pitch grows ×1.9 past a `brk` boundary, the
"dropped signal") / stacked CHEVRONS (rows off the short side, at least 2) / a
photographic GRAIN RAMP (per-pixel A→B along a seeded angle plus sine streaks and noise
tapered at the ends) / ONE hairline GRID (only once, only on small panels, 18% dots).
`mix` = fraction of panels that are patterned; `gap` inset between panels; palette = 2
neutrals + 4 loud inks; how the two inks a/b are chosen per panel; grain; seed. Every one
of these rules is a checklist line.

**Deliverables**
- `app/lib/compositor/carve.ts`: `CarveParams` (`cuts`, `uneven`, `gap`, `mix`, `grain`,
  plus whatever else the tool exposes as a slider — name them after what they do), `defaultCarve`,
  `normalizeCarve`, `CARVE_PALETTE_PRESETS` (the tool's palette table, 5–6 named presets),
  `carvePresetOf`, pure fns (`carveSplit(...)` → panels, `carveTreatments(...)`), and
  `paintCarve(ctx, params, palette, boxW, boxH, seed)`. Rule checklist in the header.
- `useCompositorLayers.ts`: `DealLayer.cellFill` gains `'carve'`, `carve?: CarveParams`,
  the deal branch paints it (own `else if`), `createDealLayer` normalizes it.
- `mosaic.ts`: style table entry (id `carve`, label `Carve`), `mosaicStylePatch` seeds
  `defaultCarve()`; `dealVocab.ts` `dealVocabDrivesLook` false for carve (it has its own
  palette).
- `CompositorModal.vue`: Carve dials + Palette preset select in the Mosaic inspector,
  same pattern as Modular's block.
- `app/lib/agent/surfaces/compositor.ts`: `carve` tunables in `impliedDealFill`'s precedence
  (explicit cellFill > first tunables pane→modular→parcel→mosh→carve > preset table >
  keep), `palettePreset` scoped to the final style, `describeCompositor` readback.
- Tests: `tests/unit/carve.unit.spec.ts` (split invariants: panel count = cuts+1, panels
  tile the box exactly, long-side rule, uneven range; grid at most once and only small;
  mix ratio; two seeds differ; opacity scaling; every preset normalizes), plus the
  `mosaic-element` / `agent-deal-seams` additions for the new style.
- Character PNGs in the scratchpad: `carve-port-default.png`, `-cuts-1.png`, `-cuts-max.png`,
  `-mix-0.png`, `-mix-1.png`, `-seed{1,2,3}.png`.

---

## Task 2: Culture as a Shader Studio generative

**What Culture is (from `playgrnd-culture-generator-reference.js`, read it whole):**
`count` soft bumps `(1−d²)²` SUMMED into one field (touching cells fuse into colonies;
`fuse` widens every cell without moving it; cells run off the edges, base radius off
`√area`·0.87), coloured by a RING LADDER: the first ink is the plate, each later ink a
ring further in; ring boundaries are placed by RADIUS (even-width rings) — `cover` sets
the plate/first-ring boundary, `spread` tightens the core; `soft` is the crossing width
(the crossing sits at the TOP of each band, smoothstep); grain on the band position AND
on the colour; `tex` fine | stipple (`dot` cell). Motion modes drift / grow / cycle.

**Deliverables**
- `shader_effects/culture.frag` (own GLSL; cell positions from a seeded hash of the cell
  index; loop over `count` ≤ 64 cells; `gradient` param → `u_ramp[8]` as ORDERED INK ROLES
  plate + rings with an `inks` count param like oddgrid/static; `u_seed`; `u_hasInput` /
  `u_mix` like the others; snapped pixel space for stipple; `u_time` drives drift / grow /
  cycle via a `motion` select so Shader Studio's clock animates it).
- `shader_effects/manifest.json` entry (category with the other generatives; params with
  plain-language labels; defaults = the tool's `S`).
- `EFFECT_LOOKS.culture` in `app/lib/shaderstudio/presets.ts`: the tool's 5 palettes as
  Looks (plain-language names); `agentControls.ts` cluster; Shader Studio Look row works
  (it is generic — verify by reading `effectLooks` in `ShaderStudioSurface.vue`).
- Goldens `tests-unit/shaderfx_golden/culture_{128,256}.png` produced the way the oddgrid
  commit `4fdb66e95` produced its own (read `tests/shaderfx-golden.spec.ts` header for the
  harness and env var); the golden spec passes for `culture`.
- Character PNGs in the scratchpad from the harness page or a Frame fill:
  `culture-default.png`, `-fuse-0.png`, `-fuse-1.png`, `-spread-1.png`, `-spread-3.png`,
  `-soft-0.png`, `-stipple.png`, `-seed{1,2,3}.png`.
- Unit test: manifest entry validates (there is a manifest spec — find it), Looks reference
  only params the effect declares.

---

## Task 3: the Scatter element, with Chaff as its first style

**The element.** A new local layer kind `'scatter'` in `useCompositorLayers.ts`:
`ScatterLayer extends LayerCommon { kind: 'scatter'; w; h (both width-normalized);
seed: number; style: 'chaff' | 'strand' | 'husk'; chaff?: ChaffParams; strand?; husk?;
inks?: string[] }`. `createScatterLayer(partial)`, `newScatterLayer(aspect)` (frame-filling,
`h: aspect`, default style `chaff`). A style registry in `app/lib/compositor/scatter.ts`:
`SCATTER_STYLES: { id, label, defaults(), normalize(), palettePresets, paint(ctx, layer,
boxW, boxH, seed) }[]` — Chaff registered now, with two clearly marked placeholder anchors
`// STYLE: strand` and `// STYLE: husk` in the registry, the inspector's dial blocks, and
the agent's style tables, so Tasks 4 and 5 each add ONE module plus one line at each
anchor. `scatterStylePatch`, `scatterSeedPatch`, `freshScatterSeed` like mosaic.ts.

Wire the kind into EVERY consumer of a local layer kind: grep `'deal'` in
`useCompositorLayers.ts`, `CompositorModal.vue`, `agent/surfaces/compositor.ts` and mirror
each site (box measure, draw branch with save → translate(−boxW/2,−boxH/2) → clip →
paint → restore, hit test, thumbnail, serialization / normalization on load, layer-list
label + icon, `layerPaints('scatter')` → `[]`, clipboard, undo). Shapes menu: `toolbarMenus.ts`
row `{ id: 'scatter', label: 'Scatter' }` after Mosaic; `SHAPE_ICONS.scatter`,
`SHAPE_STAMP.scatter = addScatter`. Inspector: header "Scatter", **Style** StudioSelect,
the style's dials, Palette preset select, "New variation" StudioButton. Agent: `scatter`
op (create default chaff sized to the frame, restyle by id, dials, `palettePreset`, `seed`),
`describeCompositor` reports `type: 'scatter'` + style / dials / seed.

**What Chaff is (from `playgrnd-chaff-generator-reference.js`, read it whole):** `count`
thrown BLADES, each an ARC (curve → sweep) with a width PROFILE (crescent / leaf / bar;
`taper`, `slim`), size spread SQUARED so a few run huge, the biggest drawn FIRST (at the
back); `apart` = a knockout of a fatter copy so blades stay separate; then a TWO-SCALE
MOTTLE (fine + 7.5× coarse value noise, amplitude `mottle·2.6`, overshooting so flecks land
in open ground and dark specks inside blades) thresholds the sheet → ink or ground. Two
roles (ground, ink). Half-size mask canvas, then the per-pixel pass. Each rule → checklist.

**Deliverables**: `app/lib/compositor/chaff.ts` (`ChaffParams`, `defaultChaff`,
`normalizeChaff`, `CHAFF_PALETTE_PRESETS`, pure `chaffBlades(params, boxW, boxH, seed)` →
blade geometry, `chaffMask(...)`, `paintChaff(...)`), the element as above, tests
`tests/unit/scatter-element.unit.spec.ts` (create / stamp / style patch / seed patch /
layerPaints / toolbar row / agent op + readback / serialization round-trip) and
`tests/unit/chaff.unit.spec.ts` (blade count, biggest-first order, size spread, profile
shapes, mottle threshold behaviour at `mottle` 0 vs 1, two seeds differ, opacity scaling),
and `compositor-toolbar-menus` update. Character PNGs: `chaff-port-default.png`,
`-crescent/-leaf/-bar.png`, `-mottle-0/-1.png`, `-apart-0/-1.png`, `-seed{1,2,3}.png`.
Live proof: in the running app at `http://127.0.0.1:3000` (never `localhost`), stamp a
Scatter from the Shapes menu and screenshot it (browser pane `preview_start` / the
`/_nuxt/<path under app/>` import recipe to drive `renderLayerThumbnail` if the UI path is
awkward) — the report says what was seen.

---

## Task 4: Strand as a Scatter style

**What Strand is (from `playgrnd-strand-generator-reference.js`, read it whole):** `count`
random walks that turn by `wander` per step and BRANCH (depth < 3), laying RODS butted with
a NOTCH at every joint (stride `seg + wid + notch·wid·0.95`), steered home when they leave
the paper, capped at 7000 rods; every rod is its own HAND-DRAWN OUTLINE (two independently
noised edges, asymmetric ends, an off-axis nudge; roughness 0 = a capsule); a misregistered
"plate that missed" (fatter by `edge`, offset by `offset` at 135°) behind the fill; `tex`
stipple | drag | screen knocks the fill out where ink "fails to take", measured against an
eroded + blurred DEPTH channel so it pools in the core; grain. Three roles. Half-size mask
canvas (plate pass, fill pass, depth pass) then the per-pixel threshold.

**Deliverables**: `app/lib/compositor/strand.ts` (`StrandParams`, `defaultStrand`,
`normalizeStrand`, `STRAND_PALETTE_PRESETS`, pure `strandWalks(...)` → rods, `strandRodPath(...)`,
`strandMasks(...)`, `paintStrand(...)`), registered at the `// STYLE: strand` anchors
(registry, inspector dials, agent tables), `tests/unit/strand.unit.spec.ts` (walk count and
cap, branch depth ≤ 3, notch stride, rods stay inside the paper margin rule, roughness 0 =
symmetric capsule, plate offset direction, texture dropout only inside the fill, two seeds
differ, opacity scaling), scatter-element spec additions for the style. Character PNGs:
`strand-port-default.png`, `-rough-0/-1.png`, `-notch-0/-1.png`, `-stipple/-drag/-screen.png`,
`-seed{1,2,3}.png`.

---

## Task 5: Husk as a Scatter style

**What Husk is (from `playgrnd-husk-generator-reference.js`, read it whole):** `count`
ovals (axes 0.78–1.28) warped by THREE sine harmonics (2–3 / 4–6 / 7–9 lobes, weights
.5/.33/.2, `lump`), each dropping "how deep inside" into a DEPTH field on a 560-wide grid
where the deeper husk wins (max), sized off `√area`; three roles ground / silhouette /
fill; the fill is EATEN by `bite` = crumble (3-octave fbm pushed to its extremes:
`keep = dep > 0.02 + eat·(0.06 + 1.5·noise)`, measured in PIXELS not frames, so it breaks
the fill into islands) or dots (a screen whose dot radius grows with depth); grain.
Motion drift / turn / eat is out of scope (a Frame element is still).

**Deliverables**: `app/lib/compositor/husk.ts` (`HuskParams`, `defaultHusk`, `normalizeHusk`,
`HUSK_PALETTE_PRESETS`, pure `huskShapes(...)`, `huskDepthField(...)` → Float32Array,
`paintHusk(...)`), registered at the `// STYLE: husk` anchors, `tests/unit/husk.unit.spec.ts`
(count, axis / lobe ranges, depth max-combine, crumble keeps more at eat 0 than eat 1,
dots radius grows with depth, roles in order, two seeds differ, opacity scaling),
scatter-element additions. Character PNGs: `husk-port-default.png`, `-lump-0/-1.png`,
`-crumble/-dots.png`, `-eat-0/-1.png`, `-seed{1,2,3}.png`.

---

## Task 6: Totem as a Mosaic style (added 2026-09-05 on Julien's "go for it")

**What Totem is (from `playgrnd-totem-generator-reference.js`, read it whole — 296 lines,
captured in the same scratchpad):** a matted, framed, MIRRORED screenprint panel with a core.
Ink ROLES by luminance: the darkest ink prints the rules and the panel ground; the rest keep
their swatch ORDER — first = the mat, second-to-last = the mark, all = the motif inks (six
five-ink palettes). One grid unit `u = max(2, round(min(W,H)/grain))`, everything snapped to
it, image smoothing OFF. MAT: the sheet filled with the mat ink; a border band
`bw = snap(min(W,H)·border)`; a coarse random field on cells of `u·matGrain` at density `mat`,
smoothed by TWO majority passes (sum of the 3×3 neighbourhood, out-of-range cells counting as
the centre: >4 → on, <4 → off, 4 → unchanged), printed in the mark ink and ONLY in the border
band. PANEL: a dark rect inset by `bw`, then a keyline inset `keyline·u` giving the composition
box. MOTIF BAG: `n = max(2, round(2 + variety·9))` kinds drawn without replacement from eleven
two-colour cell rules (solid, check, hline, vline, diag, diagB, brick, dash, grid, rings,
noise — each exactly as the reference defines it, with the `phase` term). COMPOSITION: the
LEFT HALF (`halfW = ceil(cw/u/2)·u`) carved into `regions` rectangles by repeatedly cutting
the largest (both sides must allow ≥ 6u; orientation by aspect > 1.1 else a coin; cut at
0.3–0.7 snapped to u, at least 2u; a 400-iteration guard); each region dealt a kind (solid
re-rolled 55% of the time), ink `a` from the inks, ground `b` from inks + dark twice minus
`a`, cell size u or 2u (30%); drawn, then its MIRROR twin on the right half (the twin keeps
the same deal with probability `mirror`, else its own), clipped at the half line, the left
repainted over the reflection. CORE: `kw = snap(min(cw,ch)·core)`, `kh = snap(kw·(1.2 +
0.6·((seed % 5)/5)))`, both clamped into the box; `coreRings` concentric rects alternating
dark / `inks[(i+1) % n]`, shrinking by u per ring; then a dealt motif inside on dark. Motion
(shuffle / weave phase) is out of scope for a still element. The tool page also has a dither
stage outside the generator: out of scope, record it.

**Deliverables**
- `app/lib/compositor/totem.ts`: `TotemParams` (`border`, `mat`, `matGrain`, `keyline`,
  `regions`, `grain`, `mirror`, `variety`, `core`, `coreRings`, `inks`) with `TOTEM_LIMITS`
  from the tool page's sliders (border 0–0.4, mat 0–0.7, matGrain 1–6, keyline 0–10, regions
  1–30, grain 16–220, mirror 0–1, variety 0–1, core 0–0.6, coreRings 0–8; defaults .15 / .36 /
  2 / 3 / 14 / 110 / 1 / .7 / .22 / 3), `defaultTotem`, `normalizeTotem`,
  `TOTEM_PALETTE_PRESETS` (six, plain-language names), `totemPresetOf`, `totemPresetPatch`,
  `totemRoles(inks)`, pure `totemMatField`, `totemCarve`, `totemDeal`, `totemMotifOn`, and
  `paintTotem(ctx, params, boxW, boxH, seed)` painting in box space with `fillRect` only
  (own RNG; the smoothing flag is set on the caller's ctx only inside a save/restore pair, or
  — better — never needed because every rect is snapped to whole units). Rule checklist in the
  header mapped to reference lines; comments in your own voice (shingle check 0; no
  structural paraphrase — the reference's images "inks that fight", "salt and pepper", "clot
  together", "one corner shattering", "read as an object rather than a scatter", "the navy
  showing through is what reads as depth" are banned).
- Mosaic wiring exactly as Carve's (`8c7754c0f`): `DealLayer.cellFill` + `totem?`, the deal
  branch, `mosaic.ts` style row + `mosaicStylePatch`, `dealVocabDrivesLook` false, the
  inspector block (ten dials + **the five inks as swatches in order**, like Pane's new Inks
  row `73925df87`, + Palette select), the `mosaic` agent op (tunables in the precedence
  order after carve, `palettePreset` scoped, readback), tests `tests/unit/totem.unit.spec.ts`
  (roles by luminance and order; carve count / min side / snap; mirror twin footprint; motif
  rules pinned per kind; core ring colours; two seeds differ; opacity scaling) plus
  mosaic-element / agent-deal-seams additions.
- Character PNGs `totem-port-{default,mirror-0,mirror-1,variety-0,variety-1,core-0,
  core-max,regions-1,regions-30,grain-16,grain-220,seed1,seed2,seed3}.png`, compared with
  https://www.playgrnd.tools/totem/ at the same settings.
- Live proof: Mosaic → Style Totem in the running app; move a dial, change an ink, New
  variation.
- NOT in scope (record as a follow-up): a true SVG export of a Totem by replaying the paint
  into a rectangle recorder (the tool does this; our Frame SVG writer flattens rich layers).
