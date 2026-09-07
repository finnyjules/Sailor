# Shared ramp — Progressive on every masked treatment

Date: 2026-09-07
Status: approved (design), ready for planning

## What we're building

Blur gained a **Progressive** mode on 2026-09-06: a screen-space ramp with an angle, a start
and an end, measured across the object's own extent or the whole frame. The ramp machinery is
sound but lives entirely inside `BlurTreatment` and `blur()`.

This lifts it into shared infrastructure and gives **Glow, Pixelate and Fade** the same mode.
One refactor, then three effects gain a gradient.

## Not building

- Edge treatments (rim light, outline, x-ray, wireframe). They are geometry shells, not 2D
  passes over the isolated layer; a ramp there needs a different mechanism entirely.
- New effects. Gradient map, halftone, echo and dissolve are the follow-on, not this.
- A shared per-OBJECT ramp. Each treatment keeps its own, which is what the tree's
  independent-rows UX already promises.
- Exposing the pixelate band count as a dial.

## Data model

A shared interface, extended by the four masked kinds:

```ts
/** The Progressive ramp, shared by every masked treatment that can vary across the object. */
export interface RampFields {
  /** Off ⇒ the effect covers the object evenly, exactly as it always has. */
  progressive: boolean
  rampSpace: RampSpace          // 'object' | 'frame'  (was BlurRampSpace)
  /** Degrees. 0 ramps left→right, 90 ramps top→bottom. */
  rampAngle: number
  /** Normalised along the ramp direction. `rampEnd <= rampStart` is a hard edge at start. */
  rampStart: number
  rampEnd: number
}
export interface BlurTreatment extends TreatmentBase, RampFields { kind: 'blur'; amount: number }
export interface GlowTreatment extends TreatmentBase, RampFields { kind: 'glow'; … }
export interface PixelateTreatment extends TreatmentBase, RampFields { kind: 'pixelate'; … }
export interface FadeTreatment extends TreatmentBase, RampFields { kind: 'fade'; … }
```

**Flat fields, not a nested `ramp: {}` object.** Blur already shipped these five flat keys, and
the treatment panel reads a control with a single-level lookup (`t[treatmentField(key)]`). Nesting
would need both a migration for documents saved since yesterday and path support in the panel's
reader; flat costs one shared interface and one shared parser. `BlurRampSpace` is renamed
`RampSpace` with the old name kept as a type alias, since it is exported.

Defaults are blur's, unchanged: `progressive false, rampSpace 'object', rampAngle 90,
rampStart 0, rampEnd 1`. `TREATMENT_DEFAULTS` gains them for the three new kinds.

`parseTreatment` gains one shared `parseRamp(r)` returning the five validated fields (angle
wrapped into 0–360, stops clamped 0–1, unknown space falling back to `'object'`, non-boolean
progressive false), spread into each of the four arms.

## Controls

One shared `rampRows(group)` in `treatmentControls.ts` returns the five rows Blur has today —
Progressive, Measured across, Angle, Start, End — with the four ramp rows carrying
`showIf: { key: 'treatment.progressive', equals: true }`. Each of the four kinds appends
`...rampRows(g)` after its own dials and before the "Everything else" switch.

Copy is unchanged from Blur's, except the Progressive hint, which currently says "Ramp the blur
across the object" and becomes effect-neutral: **"Ramp the effect across the object instead of
covering it evenly."**

Because `treatmentControls` is the one source for inspector, motion targets and agent
vocabulary, all three gain the rows for free — and motion targets already evaluate `showIf`
(landed 2026-09-06), so a ramp row offers itself as an animatable target only while that
treatment's Progressive is actually on.

## How each effect consumes the ramp

The ramp yields a per-pixel 0–1. Each effect consumes it in the way that is *exact* for that
effect rather than cross-fading, because a cross-fade of sharp and fully-affected reads as a
ghosted double image — the reason the progressive blur rejected that approach originally.

| Effect | Consumption |
| --- | --- |
| **Blur** | Tap step × r. Unchanged. r = 1 is byte-for-byte today's blur. |
| **Glow** | The added light scales by r, in `GLOW_MERGE_FRAG` — both the additive `rgb` term and the alpha term. Additive, so exact and free. |
| **Fade** | In `COMPOSITE_FRAG`, `a = s.a * mix(1.0, uOpacity, r)`. r = 0 leaves the object solid, r = 1 applies the dialled opacity: a sweep from solid to faded. |
| **Pixelate** | The ramp is quantised into **5 bands**; every pixel in a band shares one cell size, so the grid stays consistent inside a band and steps at the boundary. Band 0 is a 1-device-px cell, i.e. untouched. |

**Why Pixelate is different.** Its parameter is a spatial quantisation, not an intensity. Scaling
cell size per pixel makes neighbouring pixels snap to *different* grids, which is noise, not a
gradient. Banding keeps each region internally coherent and reads as a deliberate graphic step.

```glsl
const float PIXELATE_BANDS = 5.0;
float band = min(floor(r * PIXELATE_BANDS), PIXELATE_BANDS - 1.0) / (PIXELATE_BANDS - 1.0);
float cell = mix(1.0, uCell, band);   // band 0 → 1px → untouched
```

## Shared pieces

Three, all in `treatmentStage.ts`:

1. **`RAMP_GLSL`** — a string constant carrying the ramp uniform block and `float rampAt(vec2 uv)`,
   concatenated into `BLUR_FRAG`, `PIXELATE_FRAG`, `GLOW_MERGE_FRAG` and `COMPOSITE_FRAG`. It
   already exists inline in `BLUR_FRAG` and `COMPOSITE_FRAG`; this is a lift, not a rewrite.
2. **`resolveRamp(t, root, camera)`** — generalised from `BlurTreatment` to any `RampFields`
   carrier. Its existing rules hold: an inverted group always uses frame space (its treated area
   IS the frame); a degenerate object box falls through to the frame ramp; corners are clamped
   at the near plane so the ramp cannot pop during camera motion.
3. **`setRampUniforms(mat, ramp)`** — writes the six uniforms, with `uProgressive` 0 when the
   ramp is null, so a material cannot inherit a previous object's ramp within a frame.

The pure maths (`blurRampAt`, `rampDirection`, `rampSupport`) is already extracted and
unit-tested; it does not move. `blurRampAt` is renamed `rampValueAt` — it was never blur-specific
— with no behaviour change.

**Glow's internal blur still takes no ramp.** `blur()` is called twice: once for the blur
treatment (ramped) and once to spread glow's bright pass (never ramped — glow's own ramp scales
the merged result instead). The existing `ramp: BlurRamp | null` argument already expresses this.

## The one risky interaction

`COMPOSITE_FRAG` currently selects its display-space blend path with `uDisplayBlend`, set on the
CPU from `opacity < 1`. Once fade's opacity varies per pixel that test is wrong: an object at
opacity 1.0 with a ramp still needs the display path. The gate becomes
`progressive || opacity < 1`.

The HDR cross-fade added the same day (`smoothstep(FADE_HDR_LO, FADE_HDR_HI, hdr)`, thresholds
in post-exposure units) must keep working underneath it. This is the only place this work touches
code changed on 09-06/07, so it gets its own test rather than relying on the existing fade case.

## Testing

1. **Unit, pure.** `rampValueAt` keeps its existing cases (renamed). New: the pixelate band
   quantiser — band 0 at r = 0, the top band at r = 1, exactly 5 distinct values across the
   range, and monotonicity.
2. **Unit, parser.** Each of the four kinds backfills all five fields; angle wraps; stops clamp;
   unknown space falls back; a document saved before this parses unchanged.
3. **Unit, controls.** Each of the four kinds exposes the five rows in order, with the four ramp
   rows gated on `treatment.progressive` and the select carrying `optionLabels`.
4. **Browser.** One case per newly-ramped effect (glow, pixelate, fade), measuring **attenuation
   against a control frame that runs the same composer path with the ramp ramping to nothing**
   (`rampStart = rampEnd = 1`). That metric is what survived the probe-band asymmetry in the blur
   tests — the two probe bands differ ~13× in natural detail, so no single absolute threshold
   serves both ends. Plus the fade-at-opacity-1-with-a-ramp case for the gate above.
5. **Regression.** The two existing progressive-blur cases and the `[blur]`/`[fade]` numbers must
   not move: `[blur] left=0.854 right=26.655`, `[fade] fraction=0.497 peakFraction=0.500`,
   `[progressive 90] atten top=0.294 bottom=0.040`, `[progressive 270] atten top=0.046 bottom=0.106`.

## Risks

- **A dead control.** Fifteen new rows across three kinds; each must reach a uniform. The browser
  cases per effect are what prove it, not the row tests.
- **Silent regression on blur.** Guarded by the four established numbers above.
- **Pixelate band seams at low band counts.** Intended, but worth seeing before calling it done.
