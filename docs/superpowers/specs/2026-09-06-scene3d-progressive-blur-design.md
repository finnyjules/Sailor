# Progressive blur — 3D Studio Blur treatment

Date: 2026-09-06
Status: approved (design), ready for planning

## What we're building

The Blur treatment currently covers an object evenly. This adds an **option** to ramp the
blur across a direction — sharp at one end, fully blurred at the other, the "progressive
blur" look. It is an option on the existing Blur, not a new treatment kind: one row in the
tree, extra dials in the inspector.

Ramp direction is screen-space and controllable by angle. The ramp can be measured either
across the **object's own on-screen extent** (self-contained: the object ramps over itself
wherever it sits) or across the **whole frame** (lens-like; pairs naturally with the
existing "Everything else" invert).

## Not building

- Depth-driven blur (near sharp, far soft) — that's the compositor's Depth of field.
- Radial / centre-out ramps.
- A mask-texture input. The ramp is analytic; no new sampler on the layer path.
- Any change to Glow, Pixelate or Fade.

## Data model

`BlurTreatment` (`lib/scene3d/treatments.ts`) gains five fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `progressive` | boolean | `false` | Off ⇒ today's even blur, unchanged. |
| `rampSpace` | `'object' \| 'frame'` | `'object'` | What the ramp is measured across. |
| `rampAngle` | number, 0–360 | `90` | Ramp direction in degrees. 0 = left→right, 90 = top→bottom (sharp top, blurred bottom). |
| `rampStart` | number, 0–1 | `0` | Where blur begins. Before this the object is untouched. |
| `rampEnd` | number, 0–1 | `1` | Where blur reaches the full `amount`. |

`TREATMENT_DEFAULTS.blur` grows the same five. `parseTreatment` backfills each from the
defaults and clamps (`rampAngle` wrapped into 0–360, `rampStart`/`rampEnd` clamped 0–1,
`rampSpace` falling back to `'object'` on an unknown string), matching how `glow` already
returns every field on every parse. Documents saved before this change load unchanged;
documents saved after carry the five new keys on any Blur.

**Degenerate range:** `rampEnd <= rampStart` is a hard edge at `rampStart` — untouched on
one side, full blur on the other. Defined explicitly so the shader never divides by zero.

## Controls

Rows added to `treatmentControls('blur')`, after the existing Amount slider:

| Row | Kind | Notes |
| --- | --- | --- |
| Progressive | switch | Hint: "Ramp the blur across the object instead of covering it evenly" |
| Measured across | select | Options `object` / `frame`, labels "The object" / "The whole frame" |
| Angle | slider 0–360, step 1 | Hint: "0° ramps left to right, 90° top to bottom" |
| Start | slider 0–1, step 0.01 | Hint: "Stays sharp up to here" |
| End | slider 0–1, step 0.01 | Hint: "Fully blurred from here on" |

The four ramp rows carry `showIf: { key: 'treatment.progressive', equals: true }` so they
appear only when Progressive is on.

**`showIf` is currently inert in this panel.** `showIfVisible()` (`lib/studio/sections.ts`)
exists and `StudioControlPanel` takes an optional `visible` predicate, but
`Scene3DStudioSurface.vue` does not pass one — so a `showIf` declared today would be
silently always-visible, exactly the trap that file's own comment warns about. Wiring
`:visible` through to `showIfVisible(c, readTreatmentControl)` is part of this work.

Copy follows the house rule: sentence case, no internal identifiers, and the select
carries `optionLabels` because its stored values (`object`/`frame`) are internal.

Because `treatmentControls` is the single source for the inspector, motion targets and the
agent vocabulary, the new rows reach all three for free — including animatable Angle /
Start / End, which is where this gets expressive.

## How the ramp is realised

**Chosen: scale the blur's tap step per pixel.** `BLUR_FRAG` already walks 12 taps a side
along `uDir`. Multiply each pixel's step by its ramp value `r`: at `r = 1` the pixel gets
exactly today's radius, at `r = 0` every tap lands on the same texel and the pixel comes
back untouched. No new render targets, same cost as today's blur.

The decisive property is that **`r = 1` is byte-for-byte today's blur**, so turning
Progressive on cannot change the look of the parts that are meant to be fully blurred.

Rejected alternatives:

- **Pyramid of blur levels, lerped per pixel** (the usual iOS-style build). Exact at steep
  ramps, but wants ~5 full-size targets where the scratch pool holds 3 — and at a 2048²
  export bake that is ~167 MB of HalfFloat targets, in a file that already drops MSAA at
  that size for exactly this reason. Kept as the upgrade path if artifacts ever show.
- **Blur once, cross-fade sharp↔blurred by the ramp** (what `tilt_shift.frag` and Shader
  Studio's `EffectMask` do). Cheapest, but a half-ramp gives a 50/50 blend of sharp and
  fully-blurred, which reads as a ghosted double image rather than a half blur.
- **Golden-angle disc with per-pixel radius**, copying gradientfx's Focus
  (`lib/gradientfx/shaders.ts` `BLUR_FS`) — the one true varying-radius blur already in the
  repo. Rejected only because a disc kernel is a different look from the current separable
  Gaussian, so toggling Progressive would visibly change the blur's character.

**Known imprecision, accepted:** a separable Gaussian with a spatially varying step is not
a mathematically exact varying-radius blur — each pass uses the local ramp value, and
across the chained passes a pixel pulls from neighbours blurred at their own ramp. The
ramp varies slowly by construction, so this is a soft effect on a soft effect. If a steep
ramp ever shows banding, the pyramid above is the fix.

## Ramp geometry

Per-pixel ramp value, in the blur shader:

```
t = dot(uv - origin, vec2(cos(angle), -sin(angle))) / extent   // -sin: screen Y is down
r = clamp((t - rampStart) / max(rampEnd - rampStart, 1e-4), 0, 1)
```

- **Frame space:** `origin` = frame centre, `extent` = the frame's support width along the
  ramp direction, `|w·cos θ| + |h·sin θ|` for a w×h rectangle — so a diagonal ramp spans
  corner to corner rather than clipping. Uniform across every object.
- **Object space:** `origin` and `extent` come from the object's screen-space bounding box,
  computed on the CPU by projecting the eight corners of its world AABB through the camera
  and taking the min/max of their projections **along the ramp direction** (so `extent` is
  that span directly, not a rectangle support width). `Box3.setFromObject` + camera
  projection; the same shape of maths `fitGlb` already does.

**Degenerate box** — object behind the camera, or zero screen area — falls back to `r = 1`
everywhere, i.e. today's even blur. Never a divide-by-zero, never an invisible object.

**Invert ("Everything else") always uses frame space.** The treated area for an inverted
group is the rest of the scene, so "the object's own extent" has no meaning there; an
inverted group with `rampSpace: 'object'` silently ramps across the frame instead. The
stored value is left alone, so unticking the invert switch restores object-space behaviour.

**Glow's internal blur never ramps.** `blur()` is also called by the glow effect to spread
its bright pass; it takes the ramp as an explicit argument and glow passes none.

`blurPasses()` and the halo radius handed to the composite are unchanged: the halo must
still cover the widest reach in the frame, which is the `r = 1` region.

## Testing

1. **Unit, pure function.** Extract `blurRampAt(t, start, end)` (and the screen-box helper)
   as pure exports alongside `blurPasses`/`pixelateCellPx`, which are already unit-tested
   that way. Cases: `r` at both ends, the clamp outside `[start, end]`, `end == start` and
   `end < start` both giving a hard edge, and angle 0 / 90 / 270 mapping to the expected
   axis and sign.
2. **Unit, parser.** `parseTreatment` backfills all five fields; out-of-range angle wraps;
   an unknown `rampSpace` falls back; an old Blur with none of the fields still parses.
3. **End to end** (`tests/scene3d-treatments.spec.ts`). A progressive blur at angle 90 on
   the left sphere makes the **bottom band of that sphere measurably softer than its top
   band**, using the file's existing gradient-energy metric and comparing bands *within one
   frame* — the comparison discipline that spec already relies on, which cancels the
   composer path's background shift. Paired with `__scene3dTreatmentStats()` so a stage
   that silently fell back fails loudly rather than passing on sharp/sharp.
4. **Regression.** With Progressive off, the existing blur test's numbers must not move.

## Risks

- **A dead control.** Five new rows all have to reach the shader; a row that only stores
  its value is the failure mode this repo has hit repeatedly. Each row gets traced to the
  uniform that consumes it, and the E2E test is what proves the ramp actually fires.
- **`showIf` silently inert.** Declaring `showIf` without wiring `:visible` looks correct
  and does nothing. The wiring is a task, not an assumption.
- **Object-space ramp and motion.** The screen box is recomputed per frame, so an animated
  object keeps its own ramp — intended, but it means the ramp moves with the object, which
  is worth seeing before calling it done.
