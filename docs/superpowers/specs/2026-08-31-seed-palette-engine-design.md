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
- Emits the same `apply-duotone` / `apply-stops` events, so all four consumers (Gradient studio, Shader studio, and both node widgets) inherit the new mode with zero changes.
- The curated-gallery pane (19 hand-tuned palettes) stays as-is.

### 2. Agent recipes (Gradient compose-and-pick)

`buildRecipesPrompt` currently offers the model a static palette menu. Instead:

- Derive seed(s): the active brand kit / taste profile's key colors when present. Otherwise the recipes schema gains one menu field — the model picks a seed from a fixed menu of ~24 named hexes (a hue wheel at two lightness levels), the same picks-from-menus contract as everything else in recipes.
- Run the engine, put ~12–20 candidates in the menu (hexes plus short character labels), and the model picks **by index** — same philosophy as eye-pick: the model never invents hexes.
- `salvageRecipes` / `materializeRecipe` unchanged, including the mesh-points recoloring path.

## Testing

- **Unit** (`frontend/tests/unit/seed-palette.unit.spec.ts`): anchor exactness (every result contains the seed hex(es) verbatim — including with variation applied), gamut safety (every output parses as valid 6-digit hex), determinism (same inputs → identical shelf), two-seed fitting, neutral-seed handling, character-facet classification on known palettes, dedupe thresholds (a shelf never contains two near-identical palettes), corpus loader (shape + count).
- **Component:** the rebuilt From-color pane renders a shelf, emits the same events with engine output, reroll changes the shelf deterministically.
- **Agent path:** prompt-builder test that the palette menu comes from the engine and stays within the token budget; salvage still accepts model output.
- **Live browser verification** (house rule): apply a seeded palette in Gradient and Shader studios and in a node widget; confirm the seed color is visibly present in the applied result.

## Not in scope

- Presentation treatments (fan deck, torn paper, etc. — `scratchpad/palette-presentations.html`) — deliberately parked; the shelf ships with the existing tile look for now.
- Studio spawn defaults, the curated-gallery pane, `harmonize()` removal (it stays for the Shape/Scene3D harmony sliders until those are migrated deliberately).
- The color-system unification cleanups (hexToRgb clones, luma formulas, stop-shape naming) — separate track, already inventoried.

## Risks and mitigations

- **Corpus licensing:** both datasets are MIT-licensed; vendor the license files alongside the data.
- **Embed size:** covered above — lazy fetch, never a static import. Add the corpus path to the embed prune-check if one exists.
- **Chroma-ratio wash-out:** a vivid seed against a muted family can desaturate companions. The clamp bounds it; if it still reads washed out in practice, the fix is raising the lower clamp — a one-constant change, flagged for the live-verification pass.
