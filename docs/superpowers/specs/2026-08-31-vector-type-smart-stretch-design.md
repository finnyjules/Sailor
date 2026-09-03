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

## Phase B range policy — decided 2026-09-02

Julien's lab finding: the engine is proven at **single-axis extremes** (Archivo
condensed to 0.5× at height ~1 reads as a cut; squat to 0.5× height at width ~1
reads as a cut) and weak on **diagonal moves** through the (Stretch, Height)
plane (0.7 × 2.41, 1.38 × 2.31 were every troubled case). Everything Phase B
ships is single-axis: fit-to-width moves width only; Spring Up is height only;
Stretch In and Stretch Wave are width only.

Policy: **per-axis ranges, damped when both deviate.** Each dial alone ranges
0.5–2.5×. When both dials deviate from 1 at once, the second axis's effective
deviation is scaled by `1 − 0.5·min(1, |log S|/log 2)` (and symmetrically),
so a strongly condensed letter can still grow taller but not to the frontier
the engine cannot hold. The damping is applied to the values the engine
receives, never to what the user typed — the dial reads what they set, and a
small hint says "eased" when damping is active. The lab keeps undamped dials
(the frontier must stay visible for judgment). The wdth cascade runs before
damping (a real axis is never damped).

k, round coupling, the bell shape and the shape-rules toggle are lab-only
constants; the studio exposes Stretch, Height and Fit — nothing the user must
understand.

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
`axes.<tag>`: per-glyph, staggerable, wave-able. Track values are **absolute**,
exactly like every other track path in the table — a track that says `to: 1`
ends at the drawn width, not at the user's dial. So an entrance preset lands on
1.0 even for a user whose dial reads 1.4, and the dial is the resting value only
while no track claims that path. (Decided 2026-09-02, over a "delta on top of
the base" reading: one rule for all track paths beats a special case for two of
them, and "settles to the drawn width" is the thing an entrance is actually
promising.) Three starter presets: **Stretch In** (letters land expanded → settle, or
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

### Phase B — what shipped, and how it differs from the plan

Written 2026-09-02, after the whole-branch review. The plan above is the
intent; these are the places the build had to disagree with it.

- **Per-glyph planning replaced the residual-ratio shortcut.** A staggered
  stretch wave was to scale each glyph's dial by the run's `residual / dial`.
  That is a line through the origin, and the real relationship passes through
  (1, 1): a trough glyph asking for exactly 1 came out visibly condensed,
  charged a discount for a `wdth` move it never received. Every glyph now runs
  the whole pipeline on its OWN dial — spend the real axis, hand the remainder
  to the remap, damp — and its resting coords carry its own spent `wdth`.
- **Fit solves through the damping, and from the RESTING config.**
  `fitStretch(font, text, axes, target, min, max, SY)` measures at the damped
  width, so a fitted run with a tall height dial still fills the box. Its inputs
  are the un-animated config (text, axes, size, height dial), because fit is a
  composition decision taken at rest: a track on any of them would otherwise
  re-solve ~300 ms of binary search every frame and report a `fitted` that
  shivers. The width is damped against that same resting height dial, so a
  height wave keeps the fitted width; an animated `size` or `axis` keeps the
  fitted dial and may over- or under-fill the box mid-animation — the accepted
  trade. One consequence to know: because the fitted width is damped against
  the resting height, a height track under Fit can hand the engine a diagonal
  the dials could never produce — fitted 2.5 with Spring Up at 1.4 tall is
  (2.5, 1.4) where damping would cap the width at 1.87. It starts above a
  fitted ≈1.8 on a font with no `wdth` axis to absorb the move; a real `wdth`
  shrinks the corner. Accepted for now; revisit if it reads wrong.
- **Dials are clamped at the frame boundary.** `mergeConfig` clamps what is
  stored, but `applyMotion` runs after it and writes raw track values, so the
  frame re-clamps the run's dials and every staggered glyph's into
  [`VT_STRETCH_MIN`, `VT_STRETCH_MAX`]. A non-finite dial is replaced by 1, not
  clamped: NaN has no nearest legal value.
- **Both solves are memoised.** The fit answer and the `wdth` plan are each
  cached in a 64-entry insertion-ordered map keyed on their whole input. Without
  them a fitted, animated studio paid a full solve per frame — and a staggered
  wave paid one plan per glyph per frame.
- **Track presets are absolute** (see Motion above), including Stretch In and
  Spring Up, whose `to: 1` is the drawn width.
- **`prepareSolidExtrudes` passes its box; thumbnails do not.** The solid union
  owns the same `VtBoxOptions` it hands to `vtPlacement`, so it builds its frame
  with `fitBoxWidth` exactly as `drawVectorType` does — otherwise the fused body
  disagrees with the drawn glyph and its cache never hits. `thumbPreview` stays
  inert: a thumbnail is a picture of the config, not a composition inside a box
  the user is fitting to.

## The laws (engine-independent) — added 2026-09-02

Phase A's lab produced fourteen rules. Sorted honestly they are two piles.
**Pile 1 — typographic laws** a type designer would sign: constraints ANY engine
must satisfy, and the acceptance criteria for the 2D-field spike below.
**Pile 2 — slice-model patches**: fixes to how a 1D per-axis profile is shaped.
In a 2D model most of pile 2 should be emergent; if it is not, the model is
wrong. Every law comes with the probe that measures it (all probes exist in
`tests/unit/vectortype-stretch.unit.spec.ts` or the session's scratch probes).

### Pile 1 — laws (keep under any engine)

| # | Law | What it protects | Probe |
|---|---|---|---|
| L1 | **Small marks are rigid.** Dots, periods, diacritics keep their exact shape and ride as one unit. | tittles, punctuation | dot width across scanlines ≤ 1.15× |
| L2 | **Condense follows the order of sacrifice.** Counters close first (floor ~30%), then horizontal ink (~50%), stems thin last (~60%); letters never touch. | condensed cuts | o counter/flank ratios at S 0.5; no-touch test |
| L3 | **One stem weight per run.** Stems thin by one schedule of the run, never per glyph; counter-less letters under-condense. | I vs L | stem ratio l vs o flank within 4% |
| L4 | **Stems follow area, not width.** Stems thin only when S × SY < 1. | tall condensed | l stem at 0.7×2.5 ≥ 0.97 |
| L5 | **Vertical zones are shared, and hard.** Baseline, x-height, cap, ascender, descender land in the same place on every glyph; a band always reaches its target when it has any free ink. | word alignment | i stem top vs a top; Fraunces a at ×2.3 |
| L6 | **Terminals keep their cut, and a cut is never a stroke edge.** | a's terminal; Unbounded S | cut angle Δ < 8°; S profile no mid bands |
| L7 | **Optical weight compensates growth** (Ahrens): extended a hair bolder, compressed lighter. | colour | wght nudge exists; default TBD |
| L8 | **Overshoot is constant.** Rounds overshoot flat lines by a fixed amount regardless of stretch. | o vs x-height | overshoot sliver keeps size |
| L9 | **Straight strokes stay straight; parallel strokes stay parallel; diagonal angles agree across letters.** | A V W X Y K N | X profile uniform; Y arm uniform; (run-level angle test TBD) |
| L10 | **Serifs are furniture, not strokes.** Length and bracket radius change modestly, never proportionally. | Fraunces, Source Serif | serif length ratio (TBD) |
| L11 | **Apertures never close.** The gap between a terminal and its facing stroke stays ≥ ~0.5 stroke width. | c e s a under condense | aperture gap probe (TBD) |
| L12 | **Thin strokes stay thin.** Hairlines never thicken in any direction. | contrast faces, diagonal hairlines | thickness-by-angle on A/V (TBD) |
| L13 | **Joins keep their shape.** Bowl/stem junctions scale with the stroke, not the counter. | a b d n p q h | the a's residual inflections → 6 |
| L14 | **Slant is a design constant.** Italics/obliques are re-sheared to their drawn angle after any stretch. | italics | stem angle Δ < 1° (TBD) |
| L15 | **Monoline stays monoline.** Low-contrast faces thin horizontals and verticals together. | geometric sans under condense | arch vs stem ratio (TBD) |
| L16 | **Spacing follows counters.** Sidebearings track the resulting counter width. | rhythm, fit-to-width | (TBD) |
| L17 | **Junctions don't clog.** Ink density at acute joins never exceeds the drawn density. | v w M k condensed | ink-density probe (TBD), lowest priority |

Half-laws (design choices, exposed as dials, never guessed): how much heavier an
extended cut gets (L7's constant); whether descenders shorten in tall/condensed
cuts; how round a wide o's corners get (round coupling).

### Pile 2 — slice-model patches (should be emergent in a 2D model)

Curves stay smooth · rounds stay round · C1 remap · bell distribution (sine /
cosine) · turn taper · k inert · symmetric solve · the partial-sliver cap. Each
exists because two independent 1D maps cannot see a stroke. Residuals at HEAD
with all of them: a at 8 inflections (drawn 6), Unbounded S at 6 (drawn 4),
wide o at 8 (drawn 0).

### The 2D-field spike (started 2026-09-02, two days, bounded)

Premise: deform the ink as a **body**, not as rows and columns — a lattice over
the glyph with per-cell anisotropic stiffness from the existing tangent
analysis (stiff ACROSS a stroke, free ALONG it, soft in whitespace, rigid on
small marks and terminals), zone rows and the bbox as constraints, solved as a
sparse least-squares; outline control points ride the deformed lattice, so the
command count stays constant. Judged ONLY by the probes above, against the
slice engine, on Inter, Fraunces and Unbounded: inflection counts, thickness by
angle, zone alignment, stem ratios. Exit: if the field clears the pile-2
residuals it becomes the Phase B engine with pile 1 as its constraints; if not,
Phase B ships the slice engine with conservative ranges (≈0.7–1.6× wide, ≤1.8×
tall) and stroke vectors (skeleton + thickness) become the destination.

**Spike verdict (2026-09-02, `docs/superpowers/spikes/2026-09-02-stretch-2d-field-spike.md`): MIXED — the field does not earn Phase B.** It wins where the slice
model is weakest (wide o: 8 → 0 inflections, ring thickness 0.88 = drawn vs
0.78; zone alignment exact; overshoot emergent from stiffness alone) but adds
lattice-scale ripple on S / a / Fraunces (worse with finer lattices), folds
under deep condense (structural: hard width target + linear springs), and its
headline depends on the lattice resolution. 5.6 ms per glyph. **Decision path:
Phase B ships the slice engine with conservative ranges; stroke vectors are the
destination; the spike's advance-box lattice and no-rotation shear carry over.**

## Edge cases (decided)

- **All-rigid profile on an axis** (horizontally: "I", "l", "."): the glyph
  can't widen — horizontal stretch goes into sidebearings only.
  Typographically correct: an extended I *is* barely wider. Vertically the
  case is rare (most glyphs have stem-length to give); if it occurs, the glyph
  passes through unchanged.
- **All-flexible profile** (hairline scripts): degrades to plain scale on that
  axis — least harmful exactly where stroke contrast is lowest, and with
  continuous flex this fallback is gradual rather than a cliff.
- **Condense follows the ORDER OF SACRIFICE** (lab-found catastrophe at S = 0.5,
  2026-09-01: slit counters, pointed arches, folded S spine): empty space
  (counters, gaps) closes first but floors at 30% of natural width — a counter
  thinner than that reads as a crack; ink running parallel to the stretch
  (arches, crossbars, spines) shortens but floors at 50% because a curve needs
  room to turn; only then do stems thin, and they stop at 60% — Compressed cuts
  ARE lighter than Condensed. Leftover deficit is dropped (the glyph
  under-condenses; no zero-width glyphs, no NaNs). Profiles now carry per-bin
  ink occupancy so the floors know space from ink, and `stemWidthOf()` reads a
  glyph's stem width off its rigid runs.
- **One stem weight per run** (lab-found 2026-09-01: an `I` thinned to reach S
  while an `L` reached it through its foot — two stroke weights side by side):
  how much a stem thins under condense depends on S ALONE, via one schedule
  `stemFactor(S)` (1 down to S = 0.85, linear to the 60% floor at S = 0.4),
  identical for every glyph. Counters take exactly the remainder; a
  counter-less letter under-condenses rather than thinning past its
  neighbours. A glyph never condenses PAST S.
- **Letters never touch**: combined sidebearings condense no further than
  0.6 stem widths (fallback 0.09 em for glyphs with no rigid run).
- **Small isolated ink components** (tittles, periods, colons, diacritics —
  found lens-distorted in lab judgment 2026-09-01): components whose larger
  dimension is under `SMALL_FEATURE_EM = 0.22` em are made FULLY rigid by a
  connected-component pass over the ink grid — a dot keeps its exact shape and
  rides the remap as a unit; vertical stretch moves it up instead of deforming
  it. Defense-in-depth beneath it: a resisting (partial-flex) bin may grow at
  most `2·S` × its natural width, with clamped overflow spilling to fully
  flexible bins — so no few slivers can ever absorb a whole glyph's stretch.
- **Shape integrity — three kinds of ink, three rules** (lab-found
  2026-09-01; one exponent k cannot serve all three). *Straight stems* pin
  their slices hard (column min). *Straight diagonals stay straight*: every
  long straight diagonal segment (≥ 12% of the glyph's larger dimension) forces
  a CONSTANT flex across its span, exempting bins a true stem crosses (Y's arms
  bend once at the junction, never mid-stroke) — Inter's X crossing was frozen
  by two 140-unit vertical notch facets and its arms kinked at the wall.
  *Curves flow*: short lines (caps, facets, terminal cuts — the S's real
  freeze) pin only in proportion to the ink they own in a slice, so a
  continuous curved stroke spreads its stretch smoothly instead of dumping it
  into its momentarily-vertical parts (the "5"-shaped S at k = 3.5). Symmetric
  glyphs are detected and their profiles mirrored. k defaults to 1. A
  `shapeRules` switch restores the plain-min model for A/B in the lab.
- **Vertical zones are shared** (lab-found 2026-09-01: at Height 2.5 the `i`'s
  stem rose above the x-height letters because its own bbox — dot included —
  had to reach 2.5× as a whole): the Y remap is solved PER ALIGNMENT BAND
  (descender → baseline → x-height → cap height → ascender, from the font's
  own metrics, now carried on `TextOutlines.metrics`), so every glyph maps
  those lines to the same targets and its flex only decides how the inside of
  a band stretches. An all-rigid sliver band (the overshoot above the
  x-height) keeps its absolute size — the optical-overshoot rule for free.
- **Stems follow AREA, not width** (lab-found 2026-09-01: condense 0.7 ×
  Height 2.5 gave spindly letters): the one-stem-weight schedule is driven by
  `S × SY`, shared by both axes — stems thin only when the letter LOSES area.
  A tall compressed display face keeps its stems heavy.
- **Curves stay smooth** (same session: the o's arches were held exactly and
  its flanks stretched fully — a 9-slice with the drawn corner radius verbatim
  on a 2.5×-taller shape, reading as a rounded rectangle with a kink): the
  profile may not climb away from a rigid plateau faster than one stroke
  width allows (`smoothProfile`, a slope limit that only LOWERS values, on
  ink bins only — empty counters stay fully free), run before the straight-span
  pass so straight arms stay straight. A designer's tall o has a LARGER corner
  radius; now so does ours.
- **Rounds stay round** (lab-found 2026-09-01: condense 0.7 × Height 2.41 grew
  bumps at the o's apex — the arch narrowed while its height was held, and a
  semicircle is half as tall as it is wide): the Y remap's shoulder rows
  (curve-pinned, partially aligned) are scaled by `S^ROUND_COUPLING` on top of
  their normal share, the difference renormalised onto the free bins — an
  identity at S = 1. `ROUND_COUPLING = 0.7` is a taste constant the lab exposes
  (1 = fully round corners on an extended o, 0 = the flat-sided racetrack).
- **Terminals keep their cut angle** (same session: the a's slanted terminal
  cut went far steeper under Height 2.41): a short, non-axis-aligned line
  whose neighbours are near-parallel and perpendicular to it is a terminal cut;
  the ink within its own length of it is rigid in BOTH axes. The X's notch
  facets (diverging neighbours) and the S's axis-aligned construction shelves
  are excluded by construction.
- **The remap is C1** (lab-found: curves read "bumpy" at every k): the
  cumulative widths are interpolated with a monotone cubic (Fritsch–Butland
  slopes) instead of straight lines, so the map's slope no longer jumps at bin
  edges. Measured honestly: this removes the kinks but NOT the inflections —
  a convex o still gains 8 under Height 2.5 — because any smooth, non-affine
  local scale crossing a curve's shoulders makes f″ fight the drawn curvature.
  **Open design, the next step for rounds: turn regions as affine blocks** —
  each curved turn (apex + shoulders) takes ONE local scale (rule 10's
  coupling), and all scale variation lives in the straight runs parallel to
  the stretch axis, where it is invisible. That merges rules 2, 9 and 10 into
  a curve model rather than more slice rules; pure-curve glyphs (S, C) need
  their transitions to sit on their straightest part.
- **Bell distribution — harmony between rigid features** (lab-found
  2026-09-01, the last structural finding of Phase A): the tangent analysis
  keeps its real jobs — what is RIGID (stems, apex bands, tittles, terminals),
  what is a TURN (round coupling), what is a STRAIGHT SPAN (uniformity) — but
  it no longer decides how much each free bin stretches. Between rigid
  features the change spreads as a **bell per free run** — a sine bump under
  growth (linear rise at the plateau edge, so a shoulder opens the moment its
  arch ends; a raised cosine left the shoulder effectively rigid and read as a
  corner) and a raised cosine under condense (a linear rise only smears the
  floor-clipped cliff into two corners) — one bell per bulge
  (runs split at partial waists below 0.5 flex, e.g. the S's spine), anchored
  at the plateau's own scale under condense, with straight spans held uniform
  inside a run and the round-coupling factor tapered so it never steps into
  the flank. Measured: the o at Height 2.5 goes from 8 spurious inflections to
  0; the S returns to its drawn 4 (was 12); the a 16 → 10. Two honest limits:
  under deep condense the floors clip the bell (reaching S wins — the 3-bin
  cliff at a plateau edge is the only transition S allows), and wide stretch
  with round coupling can still step at the turn/flank edge. **Consequence for
  Phase B: `k` no longer shapes anything except the rigid threshold — it
  becomes an internal constant, not a dial.** The old tangent-proportional
  distribution survives as `mode: 'flex'` behind the lab's shape-rules toggle.
- **Zone bands are hard constraints; k is inert under the shape rules**
  (lab-found on Fraunces 2026-09-01: at k = 3.5 the all-curve a reached only
  ×1.18 of Height 2.31 while o/i/l landed — `pow(k)` had pushed every curved
  row below the rigid threshold, the x-height band had nothing left to stretch,
  the cap bound, the leftover was dropped, and the shared x-height broke). Now a
  band always reaches its target whenever it has any non-rigid row (shortfall
  redistributed over them, cap lifted; floors still win under condense; an
  all-rigid sliver keeps its natural size — the overshoot rule), and under the
  shape rules the profile uses exponent 1 whatever k says. The lab greys the k
  slider; the naive column passes `shapeRules: false` explicitly.
- **A terminal cut is never a stroke edge** (lab-found on Unbounded 2026-09-01
  — the first heavy face: its S gained 16 inflections because its flat terminal
  cuts are as long as its stroke is thick, cleared the 12%-of-glyph "straight"
  threshold, hard-pinned a band half a stroke thick at mid-height twice, and
  left only the spine and shoulders to absorb the height). Terminal-cut
  detection (parallel neighbours, perpendicular cut) now runs on every line
  segment regardless of length and a detected cut always pins SOFTLY; the
  rigid angle-keeping patch stays diagonal-only. Unbounded's S: 16 → 6.
  Lesson for Phase B: heavy faces need stroke-relative thresholds, not em- or
  glyph-relative ones.
- **Straightness is stroke-relative; rigidity is ink-aware** (lab-found on
  Inter's a 2026-09-02: its arch terminal was hard-pinned — by a glyph-relative
  straightness threshold and an unconditional terminal-angle patch — leaving a
  three-row sliver under the arch that got its own bell bump; and its bowl-top
  stroke read 0.12 through the soft channel and was treated as free, thickening
  2.2×). A line counts as a stroke edge only when it is ≥ 1.5 × the glyph's
  stroke thickness (measured from the distance field, two-pass); the terminal
  angle patch pins softly (`SOFT_TERMINAL_PIN`); and a bin is rigid for the
  bell when flex < 0.05 OR (flex < 0.15 and ink ≥ 0.7) — a long low-flex band
  that is mostly ink is a horizontal stroke, a short one with little ink is a
  shoulder. Result: bowl-top 2.2× → 1.10×, a 10 → 8 inflections (drawn 6),
  Unbounded S at its drawn 4, Fraunces a at its drawn 7. Shoulders still open.
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
- **Width contract**: stretched run width grows monotonically with S and stays
  ≤ S × natural — ink contributes its rigid width and only whitespace scales
  (the §2 semantics), so stem-heavy text deliberately lands under S×. The fit
  solver solves against MEASURED width, hits its target within epsilon, and
  respects clamps.
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
