# Vector Type Studio — Smart Stretch (typographic width)

**Date:** 2026-08-31
**Status:** Approved design, pending spec review
**Owner:** Julien

## What this is

A per-glyph stretch/expand system for the Vector Type Studio that reads as a
**width variant the typeface designer could have drawn** — not a geometric
distortion. One user-facing dial that works on variable *and* non-variable
fonts, drives fit-to-width, and animates per glyph through the existing motion
system.

The typographic contract: **white space stretches, ink doesn't.** Counters and
inter-letter spacing absorb the width change; vertical stem thickness stays
put; horizontals keep their weight (Y never moves); rounds flatten their sides
instead of becoming ellipses. Test: the stretched word next to the original
should look like a sibling from the same family.

Both axes are in scope: **horizontal** stretch (`stretch`, the width dial) and
**vertical** stretch (`stretchY`, the height dial) — vertical is the same flex
machinery transposed to Y, and is a primary driver for expressive animation
(letters springing up off the baseline).

Out of scope for v1: lettering-style stroke elongation (extending an E's
crossbar across a layout — a natural sequel on the same flex analysis, noted
below), non-Latin complex scripts (Arabic shaping, etc.).

## Approach chosen

**Stem-aware remap, layered under real variable-font axes.** Rejected
alternatives: (a) scaleX + contour-offset weight compensation — thins the
already-correct horizontals, can self-intersect (breaks the command-count
animation invariant), visibly fake; (b) real axes only — most fonts aren't
variable and `wdth` axes stop around 125%, a wall exactly where the animation
ideas get interesting.

## Architecture: one dial, three mechanisms, pure core

New pure module `frontend/app/lib/vectortype/stretch.ts`, same philosophy as
`outline.ts`: commands in, commands out, no canvas, fully unit-testable.

### 1. Flex profile (tangent-aligned band analysis)

`analyzeFlex(commands, bbox)`: flatten the outline to polylines and build a
**flex profile** for each axis — a 1D array of per-bin stretchiness in [0, 1].
For each histogram bin along the stretch axis, flex is
`min over ink segments crossing the bin of |tangent · stretch-direction|^k`;
bins with no ink get flex 1. A vertical stem under horizontal stretch has
perpendicular tangents → flex ≈ 0 → rigid; counters, gaps, and crossbars →
flex ≈ 1 → stretch freely; **diagonals get partial flex from the mid-range dot
product**, which resolves the rigid-or-flexible dilemma for A/V/W/X
structurally instead of by threshold. The exponent `k` is a quality dial: low
k approaches uniform scaling, high k approaches hard 9-slice behavior — the
binary rigid/flexible band model is the high-k special case, so there is one
system, not two.

The formulation follows Dave Pagurek's "Tangent-Aligned Text Stretching"
(davepagurek.com/programming/stretch-text/). The min must run over the ink's
INTERIOR, not just the slice's boundary crossings — a slice through the middle
of a stem crosses only the stem's horizontal caps, so boundary crossings alone
would call the stem flexible; what pins it is that interior ink inherits the
tangent of its NEAREST boundary (the stem's vertical side walls). His k-d-tree
sampling implements that but is the source of his admitted artifacts (cusp
misalignment, edge bending). We instead rasterize each glyph onto a small grid
(~96×96), stamp boundary cells with their exact segment tangents, propagate
nearest-boundary tangents inward with a two-pass chamfer distance transform,
mask ink by scanline, and take per-column/row minima — deterministic, cheap
(one cached pass per glyph), no sampling jank.

Along Y, the transpose: crossbars and the arches of rounds are rigid,
stem-lengths and counters flexible. Profiles are cached per
`(fontId, glyphId, quantized axis coords)` — axis coords are part of the key
because a variable glyph's outline moves as axes move.

### 2. The remap

`stretchCommands(commands, flex, S, SY)`: monotone piecewise-linear maps, one
per axis, applied to every point and control point. `S` and `SY` are the
stretch factors (1 = as drawn). Each bin's width scales in proportion to its
flex value (flexbox-style), so rigid bins hold their extent and flexible bins
share the change; the cumulative sum of scaled bins IS the remap. Condensing
floors: flexible bins shrink toward zero first, then rigid bins finally
compress, clamped so no glyph collapses.
Command count never changes — the `gvar` property the studio's whole animation
model rests on, so stretch is animation-legal by construction.

The two maps are independent and each monotone on its own axis, so they
compose safely in either order. The **vertical map is baseline-anchored**:
y = 0 is a fixed point, letters grow upward from the baseline and descenders
grow downward — for animation, letters spring up off a stable baseline rather
than smearing around their centers (the motion system's own scale pivots stay
available for other feels).

Horizontal advances go through the X map. Sidebearings are treated as flexible
space, so word rhythm scales with the counters. Vertical stretch does not
change advances.

### 3. The cascade

One `stretch` value per glyph. If the font declares `wdth`, spend the real
axis first — calibrated by measuring actual outline width at the axis
extremes, since axis units ≠ percent — then the geometric remap carries what
the axis can't reach. Non-variable fonts go straight to the remap. The user
never sees the seam.

**The cascade is horizontal-only**: there is no common "height" variable axis
(Roboto Flex's `YTAS`/`YTLC` are rare and mean something narrower), so
`stretchY` is pure geometric remap on every font — simpler, and uniform
behavior across the whole library.

The dial **composes with** manual axis values rather than replacing them: with
`axes.wdth` set by hand, stretch = 1 changes nothing, and stretching spends
the *remaining* axis headroom before the remap takes over. Raw axis sliders
stay visible; presets referencing `axes.wdth` keep working; nothing
double-drives.

## Phase A — the stretch lab (hard gate)

Dev-only page `/dev/stretch-lab`, importing only `font.ts`, `outline.ts`, and
the `stretch.ts` prototype — zero contact with studio config, controls, or
motion. The one real risk in this design is aesthetic, not technical, and it
is judged by eye here before any studio wiring exists.

- Text input, font picker over deliberately nasty test fonts: a serif, a
  geometric sans, a high-contrast display face, a round-heavy face, and one
  variable font with `wdth` to exercise the cascade seam.
- Two stretch sliders — width and height — each ~0.5×–2.5×.
- **Three renderings side by side**: naive `scaleX`/`scaleY` (the control to
  beat), the flex remap, and — for variable fonts, horizontal only — the real
  axis.
- **Flex overlay toggle**: the flex profiles rendered as a two-channel tint
  over the glyphs (one color channel per axis, rigid → strong tint, after
  Pagurek's red/blue visualization), so a bad result is diagnosable (flex
  detection vs. remap) instead of guessed at.
- **Dev-only `k` slider**: sweep the flex exponent live to find the sweet spot
  between uniform scaling (low k) and hard 9-slice behavior (high k) by eye.
- **Optical weight compensation toggle** (Ahrens): on fonts with a `wght`
  axis, couple a small weight nudge to stretch — a hair bolder when extended,
  lighter when condensed — because constant stem width reads anemic next to
  grown counters (optical color vs. geometry). Judged with/without in the lab;
  Phase A decides whether it ships in Phase B.
- **Artifact watch list** from Pagurek's write-up, checked explicitly in the
  lab: cusp behavior, edge-of-glyph slices (should resolve into sidebearings),
  and self-overlapping outlines (e.g. an ornate W).
- Pre-loaded torture strings: `OQCGS` (rounds), `AVWXY` (diagonals), `MNH`
  (dense stems), `aegs` (two-story lowercase), `gjpqy` (descenders, for the
  baseline-anchored vertical map), plus real words.

**Exit criterion:** Julien looks at it and the stretched words pass the
"sibling, not run-over" test on most fonts. Implementation of Phase B does not
start until this sign-off. If the heuristic falls short (diagonals are the
known soft spot), iteration happens in the lab, where it is throwaway-cheap.

## Phase B — studio surface

Only after Phase A sign-off. Reuses the exact `stretch.ts` the lab validated.

**Controls.** Two sliders in the Layout group next to Size and Tracking:
`stretch` (width) and `stretchY` (height), each range ~0.5–2.5, step 0.01,
default 1.

**Fit-to-width.** `fit` select in Layout: `off | width`. When on, the studio
solves the stretch factor per line so the run fills the canvas width minus a
small margin, clamped to the slider's range; the slider shows the solved value
and goes read-only. Text/font/size/tracking changes re-solve. Fit is only a
solver on the same dial — no new geometry.

**Motion.** `stretch` and `stretchY` become motion-track paths exactly like
`axes.<tag>`: per-glyph, staggerable, wave-able. Track values are a **delta on
top of** the config's base stretch, so animation settles back to what the user
set. Three starter presets: **Stretch In** (letters land expanded → settle, or
the reverse), **Stretch Wave** (a crest of width travels through the word,
sibling of Weight Wave), and **Spring Up** (letters land tall off the baseline
and settle to natural height). The existing geometric `scaleX`/`scaleY` motion
stays untouched — that is cartoon squash, a different tool; both should exist.

**Agent.** `stretch`, `stretchY`, and `fit` join the vocabulary in
`agentControls.ts`, with the description teaching the distinction:
"typographic stretch — counters and stems elongate, stroke weight doesn't
change; use `scaleX`/`scaleY` motion for cartoon squash instead."

**Per-frame cost.** Animated per-glyph stretch = remap + reflow each frame.
Flex analysis (the expensive part) is cached; the remap is a linear pass over
the command list, same order of work as the per-frame axis interpolation the
weight wave already does. Per-glyph advance changes reflow pen positions
through the existing reflow path (the "layout at base weight would make heavy
glyphs collide" machinery in `canvas.ts`). If lab profiling disagrees,
quantize stretch values for caching — not expected.

## Edge cases (decided)

- **All-rigid profile on an axis** (horizontally: "I", "l", "."): the glyph
  can't widen — horizontal stretch goes into sidebearings only.
  Typographically correct: an extended I *is* barely wider. Vertically the
  case is rare (most glyphs have stem-length to give); if it occurs, the glyph
  passes through unchanged.
- **All-flexible profile** (hairline scripts): degrades to plain scale on that
  axis — least harmful exactly where stroke contrast is lowest, and with
  continuous flex this fallback is gradual rather than a cliff.
- **Extreme condense**: flexible floors first, then rigid compresses, clamped
  — no zero-width glyphs, no NaNs.
- **Spaces/blanks**: advance stretches; no outline to remap.
- **Ligatures**: multi-codepoint glyphs flex-analyze like any other outline.

## Testing

Unit tests in the pure core, following the `vectortype-outline` precedent:

- **Animation invariant, pinned**: command count identical across full stretch
  sweeps on both axes.
- **Stroke preservation, measured**: Inter "H" — stem ink width at S = 1 vs
  S = 2, and crossbar ink thickness at SY = 1 vs SY = 2, within tolerance. The
  feature in two numbers.
- **Monotone remaps**: no coordinate crossings from either map.
- **Baseline anchor**: y = 0 is a fixed point of the vertical map at every SY.
- **Width contract**: stretched run width ≈ S × natural; fit solver hits its
  target within epsilon and respects clamps.
- **Seam continuity**: for a `wdth` font, width-vs-dial sampled densely is
  monotone and jump-free across the axis→remap handoff.

Runtime verification after Phase B, honoring two house rules:

- Drive the **live** control in the browser and **pixel-diff the smart path
  against naive scaleX** — a match means the remap silently didn't run
  (graceful-fallback trap) and the check must fail.
- One run with flex analysis deliberately disabled proves the diff catches it
  (verify-with-a-broken-control).

## Future directions (explicitly not v1)

- **Ink mode** (after DJR's Fit): the inverted contract — hold the white
  shapes constant and let the ink absorb the width change, producing
  monumental slab forms instead of airy extended ones. A second aesthetic
  system, not a fix to this one; the lab notes where on the dial the v1 mode
  stops looking good.
- **Lettering-style elongation** (Reading 2): expose flexible bands as
  grabbable, individually extendable segments — the sign-painter move of
  stretching an E's crossbar or an L's base across a layout. The flex analysis
  built here is the prerequisite.
