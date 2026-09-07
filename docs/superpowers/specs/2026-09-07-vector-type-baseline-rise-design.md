# Vector Type Studio — per-letter vertical position

**Date:** 2026-09-07
**Status:** approved, ready to plan

## The gap

The studio can lean a run (`skewX` / `skewY`), bend it (`arc`) and stretch it
(`stretch` / `stretchY`), but it cannot move ONE LETTER up or down. Skew is a
whole-run shear by design — `config.ts`'s own note says so and gives the reason
— so there is nothing today between "the word tilts as one piece" and "every
letter sits exactly on the baseline".

What is wanted: each character at its own height, either randomly or on a
mathematical curve across the word.

## What the user gets

A **Baseline** block in the Layout panel. Five controls.

| Control | Key | Kind | Range | Default |
|---|---|---|---|---|
| Baseline shape | `riseShape` | select | Off · Random · Wave · Ramp · Arch · Zigzag | Off |
| Rise | `rise` | slider | −1 … 1, step 0.01 | 0 |
| Cycles | `riseCycles` | slider | 0.25 … 8, step 0.25 | 1 |
| Phase | `risePhase` | slider | 0 … 360, step 1 | 0 |
| Baseline seed | `riseSeed` | slider | 0 … 999, step 1 | 0 |

**Rise** is a fraction of the em, not a pixel count, so it holds its proportion
when Size changes — 0.25 is a quarter of the type size at every size. Negative
flips the pattern: a bowl instead of an arch, a fall instead of a rise.

**Cycles** and **Phase** are shown for Wave only. **Baseline seed** for Random
only. Everything is hidden when the shape is Off. This is the same relevance
gating the scatter's mode-specific knobs already use, and for the same stated
reason: a slider sitting next to the select that makes it dead reads as the
select being broken.

`rise`, `riseCycles` and `risePhase` are ANIMATABLE — they are sliders, and the
studio admits any slider that does not opt out, so a track from 0 to 0.3 is
letters springing off the baseline. `riseShape` and `riseSeed` opt out
(`animatable: false`): a shape is a mode, and interpolating a seed is nonsense.

### The five shapes

`u` is the glyph's position across the word, `i / (n − 1)`, running 0 → 1. `A`
is `rise`. Every shape returns a value in −A … A, in em, POSITIVE MEANING UP.

| Shape | Offset |
|---|---|
| Off | 0 — and it returns before any arithmetic |
| Random | `A · (2r − 1)`, `r = glyphRandom(i, riseSeed, 'rise')` |
| Wave | `A · sin(2π · (u · cycles + phase/360))` |
| Ramp | `A · (2u − 1)` — first letter at −A, last at +A |
| Arch | `A · (1 − 2·(2u − 1)²)` — ends at −A, middle at +A |
| Zigzag | `A · (i even ? 1 : −1)` |

A single glyph (`n = 1`) has no span to walk, so `u = 0` for the four
mathematical shapes; Random still varies (it is keyed on the index, not on `u`).

Each shape is centred on zero across the word, so switching one on does not
shift the word's visual centre.

## Where it plugs in

### One new pure module

`frontend/app/lib/vectortype/rise.ts`. Arithmetic only — imports `./random` and
nothing else, the bar `scatter.ts` holds itself to. Exports:

```ts
vtRiseActive(cfg): boolean          // shape !== 'off' && rise !== 0
vtRiseDy(cfg, index, count, em): number   // OUTPUT PIXELS, y-DOWN
```

`vtRiseDy` returns `-(offsetInEm) * em`: the table above is written up-positive
because that is how a user thinks about a letter rising, and `dy` is y-DOWN
because that is canvas. The negation happens once, here, at the boundary.

### One consuming line

`vtGlyphMotion` in `presetMotion.ts` (~line 836) is the single function every
renderer calls, and the single place blink and axis scatter already plug in. The
rise is added into `dy` there:

```ts
dy: tr.dy + pr.dy + riseDy
```

That one line buys the canvas preview, the PNG bake, the video bake, the SVG
export and the node thumbnail, because all five read `dy` off the same frame.

`vtRiseActive` is the cheap gate, checked before any hashing, exactly as
`vtBlinkActive` and `vtScatterActive` are.

### Two properties that fall out of choosing `dy`

**It respects the arc.** `dy` is measured along the glyph's OWN axes
(`vtGlyphOffset`), so on an arc'd run a risen letter moves off its own baseline
— outward from the ring — rather than straight down the screen. That is the
typographically correct reading of "raise this letter", and it is free.

**Off is byte-identical.** Shape Off (the shipped default) returns 0 before
touching the hash, and 0 added to `dy` changes nothing, so every config saved
before this feature renders exactly the pixels it rendered before.

### Its own random channel

Random reads `glyphRandom(i, riseSeed, 'rise')` on a channel named `'rise'`,
declared as a named constant in `rise.ts` beside `blink.ts`'s and `scatter.ts`'s.
Not a detail: the scatter spec measured two effects sharing a stream at r = 1.000
— the letter that blinks off is the letter that rises highest, on every word,
every time — where separate channels measure r ≈ 0. No time bucket is passed: a
letter's height is FIXED, it is not a flicker.

## Schema

Five flat top-level keys on `VectorTypeConfig`, beside `skewX` / `arc` /
`stretch` / `fit` — its Layout neighbours are all flat, and a nested block would
need a name that is not also one of its own fields.

`mergeConfig` gains five lines: `oneOf(o.riseShape, VT_RISE_SHAPES, d.riseShape)`
and four `num(...)`. `rise` is NOT clamped in the merge, for the reason
`skewX`/`arc` are not: a motion track's `from`/`to` never pass through the merge,
so a guarantee only one entrance honours is not a guarantee. `rise.ts` clamps at
the render choke point instead, which both entrances go through.

`VT_RISE_SHAPES = ['off','random','wave','ramp','arch','zigzag'] as const`, with
`optionLabels` on the control so the panel reads Off / Random / Wave / Ramp /
Arch / Zigzag rather than the raw identifiers.

## What it deliberately does not do

Letters move and nothing else does. Spacing, letterforms, the run's measured
width and the fit solve are all untouched — this is a baseline shift, not a
layout change. Risen letters may overhang the output frame the same way a large
Size already can; the shapes being zero-centred keeps that symmetric.

No per-word or per-line unit (blink has one; this was asked for per character).
No free-text formula field. No smooth/coherent noise — Random is independent
per-letter jitter, decided explicitly.

## Tests

`frontend/tests/unit/vectortype-rise.unit.spec.ts`:

1. **Golden offsets** for all five shapes over a fixed word length, pinned to
   literal numbers — a future edit cannot quietly reshuffle every saved design.
2. **Off emits nothing**: `vtRiseDy` is exactly `0` and `vtGlyphMotion`'s `dy`
   for a default config is unchanged from the pre-feature value.
3. **Determinism**: the same `(index, seed)` gives the same value across calls,
   and two different seeds give different arrangements at the same spread.
4. **Channel independence**: Random rise against blink and against scatter over
   the same glyphs correlates at |r| < 0.2 — measured in the test, not assumed.
5. **Zero-centred**: the mean offset over a word is ~0 for Ramp, Arch and Wave.
6. **Edge cases**: `n = 1`, `n = 0`, non-finite `rise`, and a `rise` past the
   slider bound all return finite numbers.
7. **Merge**: an unknown `riseShape` falls back to Off; absent keys take the
   defaults; a saved config round-trips.

## Live verification

The dev server renders a word with each shape at a visible Rise, screenshotted,
plus one with Arc on to confirm the letters leave their own baseline rather than
the screen's.
