# Dither transition — a layer appears (or leaves) through a moving dither

Date: 2026-09-20 · Status: approved design (Julien), spec for review · Follows: `2026-09-19-letter-behaviours-design.md`, the unified motion programme.

## Why

The Motion tab's entrances and exits are Fade, Grow / Shrink and Slide. Julien wants more transitions, starting with a **moving dither**: the layer condenses out of a pattern of hard pixels that keeps sliding while it resolves. He also wants Sailor's own shaders usable as transitions later. This spec builds the dither AND the mechanism the next transitions plug into.

## What the user gets

In Add behaviour, **Dither in** joins the In group and **Dither out** the Out group, each with a live preview tile. They work on **every layer a bar can be added to** — text, images, shapes — and stack with any other bar (a Slide, a letter move). (Wired layers take no behaviour bars of any kind today; that does not change here.)

One behaviour, one inspector:

- **Style** — three looks of the same idea:
  - **Dissolve** — the whole layer resolves at once through an ordered dither.
  - **Wipe** — a dithered edge travels across the layer; solid behind it, empty ahead.
  - **Dots** — halftone dots swell until they merge into the full layer.
- **Direction** — In · Out.
- **Cell size** — how chunky the dither is, from fine grain to big blocks. For Dots it is the spacing of the dots.
- **Drift speed** — how fast the pattern slides while the layer resolves. 0 is a still, classic dither.
- **Angle** — one angle for both the way the pattern drifts and, for Wipe, the way the edge travels.
- **Edge softness** — Wipe only: how wide the dithered band on the travelling edge is. 0 is a hard line.
- **Easing** and **Timing** — exactly as on Fade. The bar is the whole transition.

Every pixel is either fully the layer or fully absent — that is what makes it a dither and not a fade. (Dots have a smooth rim so circles are not jagged.)

Before a Dither in bar the layer is hidden; after a Dither out bar it is hidden — the same rule as Fade in / Fade out.

## How it works

**1. The bar drives one number.** A dither bar is an ordinary whole-layer behaviour. It compiles to ONE number band, "how revealed is this layer", 0 → 1 (or 1 → 0 for Out), on a new property of the layer called `reveal`. So everything the timeline already does applies with no new code: easing and springs, dragging and retiming, undo, the Behaviour inspector, "most recently started bar wins", export. The one exception is **Open into keyframes**, which is hidden for a dither bar: the look lives on the bar, so a bare `reveal` band with the bar removed would have no Style to draw.

`reveal` is a motion-only property: it is not stored on the layer and is not offered in Add property (a bare 0–1 number with no look attached would mean nothing). It shows in the timeline as the dither bar's own row, labelled **Reveal**.

**2. The look rides with the bar.** When a frame is drawn, the step that applies motion to the layers finds the dither bar that owns the winning `reveal` band and attaches a short-lived note to that layer's copy: the amount, the Style and its dials, and how many seconds into the bar we are (the drift needs it). Same contract as the two notes that exist today (the draw-time scale, the letter motion): copies only, never saved.

- Amount 1 → no note at all. A finished entrance costs nothing.
- Amount 0 → the layer is skipped entirely.
- Anything between → the layer is drawn through the mask (below).

**3. The mask is a pure function.** A new folder `lib/motionx/reveal/` holds the maths, with no canvas and no Vue: given the amount, the seconds elapsed, the dials and a cell position, is this cell shown?

- **Dissolve** — an 8×8 ordered (Bayer) threshold table. A cell is shown when the amount is above its threshold. Drift shifts which table entry a cell reads, in whole cells, along the Angle — the stepping shimmer of the preview.
- **Wipe** — each cell has a position along the Angle, 0 at the side the edge starts from and 1 at the far side. The edge sits at the amount; Edge softness is the width of the band in front of it. Inside the band the cell's own share of the way through is compared with the same drifting dither table; behind the band everything shows, ahead of it nothing. For **Out** the sweep keeps going the same way rather than running backwards: the empty side grows from the side the edge starts from, so an In followed by an Out at one Angle reads as one continuous pass.
- **Dots** — dots on a square grid, spaced by Cell size, whose radius grows with the amount until neighbours overlap and the gaps close. The grid drifts smoothly along the Angle.

Because it is a pure function of (amount, elapsed, dials), preview, bake and export match frame for frame, and it is unit-testable without a browser.

**4. Drawing: "draw normally, then put the old picture back where the dither says hidden".** The painter handles a layer carrying the note like this:

1. Copy what is on the canvas so far (the backdrop) to a scratch canvas.
2. Draw the layer exactly as it is drawn today — so blend modes, shadows, and effects that read what is behind the layer (background blur, glass, backdrop shaders) all stay correct.
3. Erase the canvas wherever the mask says *hidden*.
4. Put the saved backdrop back in exactly those places.

Steps 3–4 use the mask's *hidden* side, drawn straight from a tiny source: for Dissolve and Wipe a bitmap with **one pixel per cell**, scaled up with smoothing off (crisp squares, almost free); for Dots one small dot tile repeated as a pattern (the cost does not grow with the number of dots). The mask is drawn through the frame's own transform, so cells are **aligned to the frame, not the layer**: they stay square when the layer is rotated, stay put when you pan or zoom the modal, and — because Cell size is a fraction of the frame's width — look identical in preview and at export resolution.

Scratch canvases are pooled, not created per frame. The work happens only while a dither bar is actually mid-transition on that layer.

**5. Built for the next transitions.** The draw step does not know about dither. It takes "a pattern source" — something that can paint the hidden side of a mask for this frame. The three dither styles are the first three sources.

## Planned next (not in this build)

- **Shader reveal** — a fourth Style, **Shader**, with a picker: any Shader Studio effect that generates a moving field (noise, clouds, heatmap, slice patterns…) is rendered through the existing shader runtime, and its brightness is compared with the amount using the luminance-mask maths that already exists. The layer condenses out of that shader's own motion. It is one more pattern source plus the picker; GPU cost applies only while the bar plays.
- **Shader settle** — a separate transition family: the layer arrives *through* a shader running on its own pixels (slice shift, chromatic aberration, glass, pixelate) whose strength the bar drives to zero. Needs its own small spec: a curated list declaring each shader's strength dial and rest value, and a pass that exists only while the bar is live so no dead effect is left in the Design tab.
- More mask styles on this mechanism as wanted: iris, blinds, clean wipe, pixel blocks.

## Defaults and ranges

| Dial | Range | Default | Notes |
|---|---|---|---|
| Style | Dissolve · Wipe · Dots | Dissolve | |
| Direction | In · Out | per gallery tile | |
| Cell size | 1–40 | 8 | thousandths of the frame's width (8 ≈ 10px on a 1280 frame) |
| Drift speed | 0–30 | 6 | cells per second |
| Angle | 0–360° | 0 | 0 = towards the right, 90 = downwards |
| Edge softness | 0–1 | 0.35 | share of the travel the dithered band covers; shown for Wipe only |
| Easing | any | the In/Out default | curve editor as on every bar |
| Duration | — | 0.8s | same as the other In / Out moves |

## Edges and rules

- **Outside the bar:** In → hidden before, fully drawn after; Out → fully drawn before, hidden after. No mask work in any of those states.
- **Two dither bars overlapping on one layer:** the most recently started wins, like any other property.
- **Dither + Fade on one layer:** they multiply — the layer fades while it dithers. Nothing special to build.
- **Springs:** a spring can push the amount past 1; the mask treats anything ≥ 1 as fully shown and ≤ 0 as hidden.
- **Non-finite or out-of-range dials** fall back to their defaults (the lesson of the letter-behaviour reviews).
- **Reduced motion:** the gallery preview tile holds a still half-resolved frame.
- **The layer's cached outline** (used by edge effects) must ignore the new note, like the two existing notes.
- **The Frame card on the canvas** plays no timeline motion today (known gap across the programme); this does not change it.
- **Agent:** not in this build. The agent cannot add behaviour bars of any kind today (it writes property bands only); teaching it behaviours is its own piece of work.

## Testing

- **Pure maths (unit):** amount 0 shows nothing and 1 shows everything, for every style; with Drift 0 a shown cell never turns off as the amount rises; about half the cells show at amount 0.5 (Dissolve); Wipe cells behind the edge are all shown and ahead all hidden, at four angles; Softness 0 is a hard edge with no division by zero; Dots close every gap before amount 1; identical inputs give identical output; bad dials fall back.
- **Compile and fold (unit):** Dither in compiles to one tagged `reveal` band 0→1 and Out to 1→0; easing and duration are honoured; the fold attaches the note only between 0 and 1, skips the layer at 0, leaves the layer object untouched at 1; the note carries the owning bar's dials and elapsed time; the winning bar is the one whose band wins.
- **Painter (unit, fake canvas):** with a note, the layer is drawn once, then erase-and-restore run in that order; without one the draw calls are byte-for-byte what they are today.
- **Live (running app):** on the lab frame, each style mid-bar has only fully-on or fully-off pixels over a flat backdrop (Dots: bar the rim); pixels outside the layer are unchanged from the same frame without the bar; the pattern differs between two times at the same amount when Drift > 0 and is identical when Drift = 0; a rotated layer shows axis-aligned square cells; a layer with a blend mode looks the same at amount 0.999 as with no bar; export of one mid-bar frame matches the preview.
- **Inspector:** Studio rows throughout (labelled segmented rows for Style and Direction), Edge softness shown only for Wipe, one undo step per drag.
