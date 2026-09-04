# Seed → Palette Engine

**Date:** 2026-08-31
**Status:** Approved direction, validated in a standalone prototype (`scratchpad/palette-playground.html`)
**Prototype verdict:** Julien likes both the curated results and the mathematical ones — ship both engines behind one shelf.

## The problem

Palette picking in Sailor is weak in three connected places:

1. **Agent-composed palettes** (Gradient recipes) come out generic or muddy.
2. **PalettePicker's "From color" mode** produces mechanical results.
3. Both sit on **`harmonize()`**, which rotates hue at constant lightness and chroma — palettes with no tonal skeleton, which is exactly what "samey" and "flat" feel like.

Browsing is not the answer. The goal is: give Sailor **one or two colors** and get back a small shelf of genuinely good palettes, every one containing the seed color(s) **verbatim**.

## What we're building

A seed engine in `frontend/app/lib/color/` with two candidate sources feeding one shelf:

### Source 1 — Curated (corpus re-anchoring)

- Vendor two MIT datasets as one combined JSON: **nice-color-palettes** (992 five-color palettes from ColourLovers) and **Sanzo Wada's Dictionary of Colour Combinations** (348 combinations of 2–4 colors). 1,340 palettes, ~78 KB. A small script regenerates the combined file from the vendored sources; the sources are committed so the build is offline and reproducible.
- **Retrieval:** for a seed, find the corpus palettes whose nearest member is closest to the seed in OKLab (plain Euclidean distance).
- **Re-anchoring:** transform the whole palette in OKLCH so that nearest member lands exactly on the seed and the rest follow: hue rotated by the seed/member delta, lightness offset by the delta, chroma scaled by the seed/member ratio **clamped to [0.35, 2.8]**. Convert back through `oklchToHexInGamut` (chroma-reducing, hue-preserving). The anchor slot is then set to the literal seed hex. The internal relationships between colors — where the curated taste lives — survive the transform.
- **Ranking:** ascending by "warp" (OKLab distance from seed to the original nearest member, i.e. how far the palette had to bend). Page 1 is the most faithful families; reroll pages deeper.
- **Two seeds:** anchor to seed 1 as above, then hard-set the transformed member nearest to seed 2; warp adds that residual.

### Source 2 — Composed (mathematical recipes)

Six single-seed recipes, each built as a ramp **through** the seed — the lightness skeleton is bent so one slot lands exactly on the seed's lightness, and hue/chroma curves pass through the seed's values, so the anchor holds by construction rather than by swapping a color in afterwards:

- **tonal** — near-single hue, full lightness ramp
- **analogous** — ±40–75° hue drift along the ramp
- **hue-cycle** — 120–290° hue sweep (rampensau-style)
- **complement** — analogous ramp with the far end flipped 180° and chroma-boosted
- **split-tone** — dark slots pushed 150–210° away, lighter and desaturated shadows
- **neutral+pop** — everything desaturated except the seed and one accent at ±120°

All recipes share the lightness skeleton (spread ~0.14 → ~0.9, eased) — this is the structural fix for muddy/flat. Two-seed mode gets **bridge** and **arc** recipes: a curve through both colors in OKLCH (short-way and long-way hue paths), both seeds verbatim at fixed slots.

No new dependencies: the recipes are ~150 lines on top of the existing OKLCH utilities.

### Shared machinery

- **Character filter** (muted / vivid / dark / light / warm / cool), computed on the **transformed** palette, not the source — warm/cool via chroma-weighted circular hue mean.
- **Diversity dedupe:** greedy skip when mean pairwise OKLab distance to an already-picked palette is below a threshold. **Two thresholds** (validated in the prototype): 0.045 for corpus candidates, 0.02 for composed ones — composed variants sit closer together by construction, and the corpus threshold starves the shelf.
- **Determinism:** all randomness through the seeded-PRNG house rule — key is (seed hexes, recipe, variant, page). Same inputs, same shelf, always.
- **Neutral seeds** (chroma < 0.02): hue rotation is skipped for anchoring; composed recipes invent a gentle low-chroma hue deterministically.
- **Shelf assembly:** ~12 candidates, the two sources woven alternately; reroll advances a page counter that pages the corpus ranking deeper and re-rolls the composed variants.
- **Output contract unchanged:** results are `string[]` hexes flowing into the existing `toStops` / `toDuotone`. No consumer changes.

## Gradient vs palette — one family, three projections

The engine produces a **family**: an ordered set of related hexes plus the seed anchor(s) and facets. "Gradient" and "palette" are not different outputs — they are projections of the same family, and the only transform between them is ordering plus interpolation. There are three:

- **`gradientize(family)`** → smooth `{pos, color}` stops for a ramp consumer. Orders for smoothness; **preserves the family's authored lightness** (this is the corrected `toStops` — see the toStops tax). Feeds Tier A.
- **`paletteize(family)`** → the discrete swatches as-is, for the shelf preview and for any legibility-ordered discrete view.
- **`distribute(family, target)`** → lands the N discrete colors as N separate fills in a studio whose color model is a list of distinct fills (not a ramp). This is the discrete-palette output.

**Intent is a view toggle on the seed shelf**, not a per-studio setting: the shelf flips between "as gradient" and "as swatches," and Apply emits the matching projection. One seed exploration serves both; the user never re-picks a seed to change output shape. The prototype tile's swatch-row-plus-gradient-strip is the seed of this toggle.

### The distribution policy (`distribute`)

N palette colors onto a studio's M fill slots:

- N = M → 1:1 in order.
- N < M → cycle (wrap) or ramp (interpolate to fill). **Reuse GeoShape's existing `fillCycle: 'cycle' | 'ramp'` vocabulary** rather than inventing one.
- N > M → resample down, evenly spaced.
- Role-keyed studios (Texture) → map by the role list's order; each role gets `{type:'solid', color}`.

**First discrete home: GeoShape.** It already has a variable `fills: Paint[]` with add/remove and the cycle/ramp semantic, so `distribute` reuses a native concept instead of imposing a new one — the lowest-risk place to prove the policy. Work required: wrap hex → `Paint`, and flip `fillStrategy` off `'single'` (its default) to `'perClone'`/`'pieces'`, or the write is invisible — the discrete analogue of Scene3D's `paletteMode = 'manual'` flip. **Second: Compositor per-layer fills** (one hex per selected layer). Texture / Space Type / Vector Type stay deferred until the policy is proven on these two.

The **brand kit** (`shared/brand/`) is the natural persistent container for a discrete palette — already a named, ordered, stable-id color object. Out of scope here (one-shot `distribute` only), but it is where saved/reusable palettes would live if that need arises.

## Where it lives

```
frontend/app/lib/color/
  corpus/                 vendored source JSONs + regenerate script (dev-only)
  seedPalette.ts          retrieval, re-anchoring, recipes, facets, dedupe, shelf assembly
frontend/public/data/
  palette-corpus.json     the combined 1,340-palette file, fetched lazily
```

**The corpus must not enter the client bundle eagerly.** The Gradient embed has a ~140 KB ceiling (see the embed post-stack slimming work); a statically imported 78 KB JSON would blow through it. The engine fetches the corpus on first use and caches it in module state; composed recipes work synchronously without it, so the shelf can paint composed candidates immediately and fill in curated ones when the corpus arrives (same progressive pattern as compose-and-pick's local-rank-then-eye-pick).

OKLCH per corpus color is computed lazily at runtime and memoized — the full 1,340-palette rank ran in ~20 ms in the prototype, so there is no build-time precompute step.

## Consumers

### 1. PalettePicker "From color" pane (rebuilt)

- Seed swatch (StudioColor) plus an optional second seed.
- Shelf of ~12 tiles with the existing apply-preview behavior (`preview()` shows the result of `toDuotone`/`toStops`, not the raw palette).
- Character chips and a reroll button. No engine toggle in the app — the woven shelf **is** the product; the toggle was a prototype-comparison tool.
- The curated-gallery pane (19 hand-tuned palettes) stays as-is.

**The `toStops` tax — the one thing that must change in the picker.** `PalettePicker.apply()` currently launders *every* palette through `toStops`/`toDuotone` before emitting. `toStops` overwrites every input lightness with `lerp(0.22, 0.92, t)` and damps chroma at the extremes; `toDuotone` reads only the first two hexes and re-lights both to fixed lightness values. That is correct for the existing flow — a `harmonize()` palette has no tonal structure of its own, so the ramp supplies one — but it would destroy exactly what the seed engine produces. A curated Sanzo Wada palette handed to today's picker comes back as a generic dark→light ramp wearing that palette's hues, and it would *look plausible*, which is how this kind of failure escapes review.

So the picker gains a third emit path: seed-engine results are emitted **literally** (hexes in their own order and lightness, evenly spaced `pos`), never through `toStops`. The gallery and harmony panes keep the existing cooked path unchanged.

### 2. Per-studio integration — three tiers

Studios do **not** consume palettes uniformly. Scope this build to Tier A, with Scene3D (Tier B) as a stretch.

**Tier A — stores literal hex lists of variable length. Drop-in.**

| Surface | Where | Note |
|---|---|---|
| Gradient studio | `applyPaletteStops`, `GradientStudioSurface.vue:569` | Also recolor `layer.mesh.points` — the mesh layout renders from points, not stops (the "Molten Rust came out blue" bug). `materializeRecipe`'s redistribute-onto-existing-count logic is the pattern to reuse. |
| Shader studio | 3 picker mounts: duotone `:1074`, gradient map `:1083`, per-effect gradient params `:975` | Apply must flip the feature on, as the existing handlers already do (`duotone.enabled`, `gradientMap.enabled`). Gradient map caps at 8 stops. |
| `WidgetGradientEditor.vue` | `:110` | Serializes to a JSON string widget value. |
| `ShaderFillEditor.vue` | `:286` | Handler is an inline arrow; give it a named function while we're here. |
| Compositor post-FX gradient map | `PostEffectsControls.vue:151` | `{pos, color}` variable list — same shape, no picker mounted today. Cheap to add. |

**Tier B — palette is DERIVED from sliders. Needs a state-model change.**

- **Scene3D** carries both models on one object: authored `gradientStops`, and a `paletteMode: 'manual' | 'harmony'` that regenerates 5 stops from `paletteHue/Sat/Light/Harmony` at render time (`config.ts:652`). Writing a seed palette into `gradientStops` while `paletteMode === 'harmony'` renders **nothing** — the authored stops are silently shadowed. Any apply path must set `paletteMode = 'manual'`. Clamp to the 2..8 parser bounds. If applying to the opalescent ramp instead, re-append the first color: `opalStopsOf` expects a cyclic list whose first and last match, or it seams.
- **Shape studio (`lib/shapefx/`)** stores *no hexes at all* — only `baseHue`/`saturation`/`lightness`/`harmony`, with every color manufactured at draw time. An arbitrary palette is not representable, and there is no inverse (three arbitrary hues do not solve back to one base hue plus a harmony type). It would need a discriminated `{mode:'derived'} | {mode:'explicit', colors}` field. **Out of scope:** the engine is declared retired in favor of Scene3D (`lib/scene3d/gem.ts:5`) and is only reachable from two `pages/dev/` harnesses.

**Tier C — discrete-fill studios, reached via `distribute` (see the distribution policy above).**

*In scope, in order:*

- **GeoShape** (first discrete home): three parallel `Paint[]` per mark plus a stack-level list; `fills` is the target. Cardinality is free-form and it already has the `fillCycle: 'cycle' | 'ramp'` semantic `distribute` reuses. The one hazard is routing: applying to `fills` is invisible while `fillStrategy === 'single'` (the default), so `distribute` must flip the strategy — the discrete analogue of the Scene3D `paletteMode` flip.
- **Compositor per-layer fills** (second): one `Paint` per layer, one hex each, across the selected layers. Note stops there are keyed `offset` not `pos` — a converter is needed if a distributed color is itself a gradient (it is not, for `distribute`).

*Deferred — need a per-effect mapping policy we have not designed:*

- **Texture / Pattern**: colors keyed by *role name* (`FillsByRole`), role set varies with family (`checker` 2, `weave` 3, `chips` 3); each value is a `Fill` union, not a hex, and stops use a third key naming (`{c, p}`). `distribute`'s role-order mapping is the intended approach but is unproven; wait until GeoShape validates it.
- **Space Type / Vector Type**: each fill-list entry is a *three-color* object (`a`, `b`, `textColor`), list length is a per-effect constant, and the list round-trips through a serialized JSON string param. Vector Type keeps `strokeColor` deliberately outside `Paint` — writing a color onto the `Paint` survives in memory and is dropped on next load.

### 3. Agent recipes (Gradient compose-and-pick)

`buildRecipesPrompt` currently offers the model a static palette menu. Instead:

- Derive seed(s): the active brand kit / taste profile's key colors when present. Otherwise the recipes schema gains one menu field — the model picks a seed from a fixed menu of ~24 named hexes (a hue wheel at two lightness levels), the same picks-from-menus contract as everything else in recipes.
- Run the engine, put ~12–20 candidates in the menu (hexes plus short character labels), and the model picks **by index** — same philosophy as eye-pick: the model never invents hexes.
- `salvageRecipes` / `materializeRecipe` unchanged, including the mesh-points recoloring path. Keep `RECIPES_SCHEMA` free of `minItems`/`maxItems` (the API rejects length keywords, and only on a live call) — counts stay enforced in `salvageRecipes`.

**Respect the existing refusals.** Two surfaces deliberately forbid agent color writes: Shader's gradient-map ramp ("ramp colours picker-only; only mix is tunable") and Scene3D's entire gradient-material palette block (`agent: false`). The engine does not route around these. Where a studio refuses, the adapter returns a **reason string** rather than silently offering a key that `validatePatch` would drop — the pattern `MovesAdapter.availability()` already uses.

**Structural note for later, not this build.** The recipe pipeline (`RECIPES_SCHEMA`, `buildRecipesPrompt`, `salvageRecipes`, `materializeRecipe`, `eyePick`) currently lives *inside* `lib/gradientfx/` and is imported by two server routes. Extending compose-and-pick to a second studio means lifting it to a studio-neutral `lib/studio/palette/` with per-studio adapters, following `lib/studio/moves/` — generic over the studio's config type, a header-stated ban on importing any studio, no Vue at module scope, and availability-as-reason-string. The existing `compose: { summarize, materialize }` seam in `useStudioAgent.ts:126` is already the right shape; only the `GradientRecipe` type and the two route imports are studio-bound. **This build keeps recipes where they are** and does the lift when a second studio actually needs it.

## Testing

- **Unit** (`frontend/tests/unit/seed-palette.unit.spec.ts`): anchor exactness (every result contains the seed hex(es) verbatim — including with variation applied), gamut safety (every output parses as valid 6-digit hex), determinism (same inputs → identical shelf), two-seed fitting, neutral-seed handling, character-facet classification on known palettes, dedupe thresholds (a shelf never contains two near-identical palettes), corpus loader (shape + count).
- **Component:** the rebuilt From-color pane renders a shelf, emits the same events with engine output, reroll changes the shelf deterministically.
- **Agent path:** prompt-builder test that the palette menu comes from the engine and stays within the token budget; salvage still accepts model output.
- **The literal-emit assertion.** A test that would fail if the seed-engine path were wired through `toStops`: apply a palette with a deliberately non-monotonic lightness order and assert the applied stops keep those exact hexes in that exact order. Without this, the `toStops` tax reappears as a silent regression that still looks fine on screen.
- **Live browser verification** (house rule): apply a seeded palette in Gradient and Shader studios and in a node widget; confirm the seed color is visibly present in the applied result, and that the applied colors match the shelf tile pixel-for-pixel rather than merely sharing its hues.

## Not in scope

- Presentation treatments (fan deck, torn paper, etc. — `scratchpad/palette-presentations.html`) — deliberately parked; the shelf ships with the existing tile look for now.
- Studio spawn defaults, the curated-gallery pane, `harmonize()` removal (it stays for the Shape/Scene3D harmony sliders until those are migrated deliberately).
- The color-system unification cleanups (hexToRgb clones, luma formulas, stop-shape naming) — separate track, already inventoried.

## Risks and mitigations

- **Corpus licensing:** both datasets are MIT-licensed; vendor the license files alongside the data.
- **Embed size:** covered above — lazy fetch, never a static import. Add the corpus path to the embed prune-check if one exists.
- **Chroma-ratio wash-out:** a vivid seed against a muted family can desaturate companions. The clamp bounds it; if it still reads washed out in practice, the fix is raising the lower clamp — a one-constant change, flagged for the live-verification pass.
