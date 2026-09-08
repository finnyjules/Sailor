# Frame — wavy and zigzag strokes

Date: 2026-09-07
Status: approved (design), ready for planning

Builds directly on `2026-09-07-frame-multi-stroke-design.md`, which landed the same day.

## What we're building

A Frame layer's outlines can each be made **wavy or zigzag**. Three dials sit beside Distance:

| Dial | Meaning |
| --- | --- |
| **Wobble** | Off (default) · Wave · Zigzag |
| **Amount** | how far the line deviates, either side of where it would otherwise run |
| **Every** | one full cycle |
| **Phase** | where the cycle starts around the shape, so two stacked wobbles can sit deliberately out of step |

**Wobble is a property of the LINE, not a third style.** A band strokes the wavy line; marching
shapes walk a guide built from it, so the marks ride the wave and turn with it. One idea, both
consumers, and a future third style inherits it for nothing.

## Not building

- **Wobble on text.** Waviness is a displacement of a path, and the Frame's text layer stores a
  CSS family name with no glyph outlines — the same limit `strokeSupportsShapes` already encodes.
  Multiple strokes and distance keep working on text; the Wobble rows do not appear there.
- A third wobble shape (square / castellated). Two, as asked. Add a third only on request.
- Per-vertex or hand-drawn wobble. This is periodic, driven by four numbers.
- Animating the phase. Layer motion still only produces transform/opacity deltas, so wobble joins
  `radius`, `strokeDash` and the rest of the stroke dials as un-animatable. Not a new gap.

## The maths

`offsetPolyline(pts, closed, distance)` in `lib/compositor/strokeShapes.ts:75` already moves every
vertex of a flattened outline along its angle bisector by a **constant** `distance`. Wobble makes
that distance **vary with arc length**:

```
displacement(s) = distance + amount · f(2π·(s/λ) + phase)
```

- **Wave** — `f = sin`. Smooth.
- **Zigzag** — `f = triangle`. Straight runs meeting at points. Those points are corners, so the
  outline's existing **Corners** dial governs them for free: Sharp gives real spikes, Rounded
  softens them.

`offsetPolyline` has **no callers outside its own module and tests** (verified), so widening its
signature is contained.

### The trap that would have shipped invisibly

**A rectangle's edge flattens to two points. You cannot wave two points.** The flattener emits
points where a curve needs them, so a circle arrives with hundreds and a rect with four — a wobble
applied to the flattened outline as-is would look correct on every rounded shape and do *nothing*
on every rect, polygon and star.

So the outline is **resampled at even arc length** before it is displaced, at a spacing fine
relative to `λ` (target: at least ~16 samples per cycle, and never coarser than the existing
flatten tolerance). This is the first thing the plan builds and the first thing it tests — a rect
is the fixture, not a circle.

### Whole cycles around a closed shape

If the perimeter is not a whole number of wavelengths, the wave meets itself out of step at the
seam and leaves a visible kink. Same problem the marching shapes had, same fix: on a **closed**
outline the cycle count snaps to `round(perimeter / λ)` (minimum 1) and the effective wavelength
becomes `perimeter / count`. The dial reads as "about this often", and the shape closes cleanly.
An **open** outline keeps the requested `λ` — there is no seam to protect, matching the decision
`shapePlacements` already made for spacing.

## Data model

Three optional fields on `StrokeInstance` (`lib/compositor/strokeStack.ts`), absent ⇒ off ⇒ today:

```ts
export const STROKE_WOBBLES = ['wave', 'zigzag'] as const
export type StrokeWobble = typeof STROKE_WOBBLES[number]

  /** Absent ⇒ the line runs straight, exactly as it does today. */
  wobble?: StrokeWobble
  /** Peak deviation either side of the line, in the same units as `width`. */
  wobbleAmount?: number
  /** One full cycle, same units. Non-positive ⇒ treated as off. */
  wobbleLength?: number
  /** Degrees. Where the cycle starts around the outline. */
  wobblePhase?: number
```

`strokeStackOf` normalises them the way it already normalises `shapes`: a `wobble` naming an
unknown shape, or carrying a non-positive `wobbleLength`, reads as off rather than as a broken
stroke. Non-finite numbers read as 0, matching `strokeDistancePx` and `strokeReachPx`.

## How each consumer takes it

**Marching shapes — free.** `shapeStrokeGuideFit` (`strokeShapes.ts:155`) already does
flatten → offset → guide. It gains the wobble arguments and passes them to `offsetPolyline`.
Nothing in `paintShapeStroke` changes.

**A band — a new route, and this is the one risk.** Today a band at a distance is the difference of
two raster **dilations**, which can only be a constant radius; a wavy band cannot be expressed that
way. A wobbled band instead flattens the outline, displaces it, builds a `Path2D` from the result
and strokes it at `width`. That is simpler and gives it real joins and caps — but it means a
wobbled band and a straight one are built by different code, so **the straight one must stay
provably untouched**: wobble absent ⇒ not one statement of today's path changes, and the
byte-identity fixture proves it.

All three `paintStrokeStack` call sites — rect (`useCompositorLayers.ts:2761`), ellipse (`:2767`)
and `drawPath` (`:3461`) — already supply `outline` and `outlineTolerance`, so a wobbled band needs
**no new plumbing at any call site**.

## The consumer that fails silently

**`strokeReachPx` and `cornerPinPadPx` must grow by the amplitude.** A wobbled stroke deviates
`amount` beyond where a straight one would reach, so without this it is clipped at a corner-pin or
DOF offscreen edge and cut by the torn-edge silhouette — a slightly wrong shape, never an error.
This is the third time this exact consumer has needed updating in this feature family; it gets a
test that fails without the term, not just a code change.

## Controls

Four rows in the stroke inspector, after Distance and before Style, all gated in
`lib/compositor/strokeInspector.ts` alongside the existing gates:

- **Wobble** shows on any stroke whose layer kind has an outline — i.e. not on text.
- **Amount**, **Every** and **Phase** show only when Wobble is not Off.
- `optionLabels` are `['Off', 'Wave', 'Zigzag']`. No internal identifier reaches the DOM.

The **Corners** row currently shows only at `distance !== 0`, because `strokeAligned` never sets
`lineJoin`. A wobbled band strokes a path and therefore *does* honour the join, so Corners must
also show when Wobble is on — otherwise a zigzag's points would be governed by a hidden control.

## Testing

1. **Pure, and a rect is the fixture.** Resampling puts ≥ 16 points per cycle on a rectangle's
   straight edge; the displacement follows `sin`/`triangle` at the right amplitude and frequency;
   a closed outline's cycle count snaps and the last sample meets the first in phase; an open one
   keeps the requested wavelength; degenerate input (zero or non-finite amount, length or phase)
   returns the un-wobbled polyline rather than NaN.
2. **Byte-identity.** The existing 14-layer fixture must stay green and byte-unchanged. Wobble
   absent must not alter one statement of the straight path.
3. **Pixels.** A wavy band on a rect deviates by the amount at the expected frequency, measured
   from the canvas — with the probe points derived, not guessed. A zigzag's points are sharp under
   Sharp and blunted under Rounded. Marching shapes on a wobbled line sit off the straight line by
   the amount.
4. **Reach.** A wobbled stroke inside a corner-pin is not clipped. Run red by removing the
   amplitude term.
5. **Rows.** The gates: no Wobble on text; Amount/Every/Phase hidden when Off; Corners visible when
   Wobble is on. Asserted from the live DOM, not only from the pure gate function — a pure-gate
   test is blind to the prop wiring, which is how a row went missing last time.

## Risks

- **The resampling trap above.** A wobble that silently does nothing on rects is the likeliest way
  this ships broken and looks fine in a demo.
- **Two band constructions.** Guarded by byte-identity.
- **The reach helpers.** Guarded by a test that fails without the term.
- **Shared-file staging.** `useCompositorLayers.ts` and `CompositorModal.vue` are the two files
  parallel sessions collide on; every commit stages its own hunks under a private `GIT_INDEX_FILE`
  and resyncs the shared index afterwards.
