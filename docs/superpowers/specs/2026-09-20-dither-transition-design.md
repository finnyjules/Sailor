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

## Addendum (2026-09-20, after Julien tried it): the dither must TRANSFORM the element

Julien, on seeing the three styles: "it's like a mask instead of a transform. I was expecting the dither to transform the element it's transitioning, not just masking it." The three styles above cut holes in an element that stays perfectly sharp — on white text that reads as on/off. He keeps them, but **mainly wants the transform**, and wants to **choose the dither characters, "like on my shader in Shader Studio"**. So the transform does not reimplement a look: it RUNS his Shader Studio **ASCII** effect over the layer, and the bar drives that shader's dials.

It is a fourth Style, **Pixels**, listed first and the default for a new Dither in / Dither out bar.

**What the user sees.** The element is rebuilt out of characters on a grid that refines until it is sharp. Its edges break into the same grid (it is not a crisp silhouette with a texture inside), bright parts arrive before dark parts, and the cells halve in clean steps so every refinement subdivides the last. Dither out is the same in reverse.

**Dials for Pixels:**
- **Characters** — the ASCII effect's shapes: Mixed · Blocks (default) · Circles · Lines · Diagonal · Cross · Diamond · Hash · Matrix · Binary · Braille · Morse · Dots · Slashes · Lego · Cross-stitch · Voxel · Beads · Gems. A set looks exactly as it does in Shader Studio, and a set added to the shader later appears here.
- **Block size** (the Cell size dial, relabelled) — the size of the cells the element starts as. Default 24, three times a mask cell, so the grid reads clearly.
- **Shimmer speed** (the Drift speed dial, relabelled) — how fast the characters re-roll while the element sharpens. 0 is still.
- Angle and Edge softness do not apply and are hidden.

**How.**
1. While the bar plays, the layer is drawn on its own, at full opacity, to a side canvas exactly the size of the frame, exactly as it is drawn today (its own effects, fills, text, letter moves all intact).
2. That canvas goes through the ASCII shader — the same code Shader Studio runs — in a new **matte mode** (below), with: Size = the current block size; Brightness ramped from −0.9 up to +1 over the FIRST HALF of the bar — which is what makes the element condense out of nothing, bright tones first, while the coarsest cells are on screen — then held, so the second half is the full-density mosaic refining; Jitter and Speed from Shimmer speed; Colored on.
3. Block size halves in even stages from the dial down to 2 thousandths of the frame's width (24 → 12 → 6 → 3 → 1.5).
4. Over the last fifth of the bar the real, sharp layer fades in over the characters — most character sets never become a solid picture on their own — so the hand-off to the normal draw at the end of the bar has no pop.
5. The result is stamped back at the frame's position with the layer's own opacity and blend mode (the side canvas was drawn at full opacity, so a half-transparent layer stays evenly half-transparent).

Because the side canvas IS the frame, the grid is anchored to the frame and sized as a fraction of it: square under rotation, identical in preview and export (except that the shader never draws a cell smaller than 2 device pixels, so the very last stage can be a little coarser on a small preview).

**Matte mode — a small, default-off addition to the ASCII shader.** Today the shader writes ink on opaque black and picks density from brightness alone, so it cannot be composited over a backdrop and a black text layer would vanish. In matte mode (a built-in switch the compositor sets; NOT a Shader Studio dial, and every existing use is byte-for-byte unchanged): density = the element's alpha at the cell × (brightness-adjusted tone, compressed to 0.25–0.75 so a black layer does not sit empty while a white one is already full); an empty cell is fully transparent; the ink is the element's true colour; and the output carries real transparency between the characters. The renderer resets the switch to off before every draw, on every path, so it can never leak into Shader Studio.

**Found on the way, fixed here:** the ASCII effect's character shapes (Hash, Matrix, Binary, Braille, Morse, Dots, Slashes) draw NOTHING today when the effect is used as a layer effect in the Frame — that path never loads the shader's glyph sheet or its companion numbers. Loading them is a prerequisite for this work and repairs the existing layer effect too.

**When the shader is not ready** (the catalogue or the glyph sheet still loading — typically the first frames after opening a frame), a Pixels bar draws as the Dissolve mask for those frames rather than flashing the whole layer; it switches to the real thing as soon as the load lands.

**Not in this build:** the shader's **Custom** shape (type your own characters) — its glyph sheet is built inside the Shader Studio screen today and needs moving to a shared place first. The Dither effect's 12 **patterns** (Bayer sizes, clustered, scanline, blue noise…) as a second menu — same mechanism, next slice.

**The price, accepted:** while a Pixels transition plays there is one GPU pass per frame for that layer (what a shader layer effect already costs; nothing outside the bar); effects that read what is BEHIND the layer (background blur, glass, backdrop shaders, the backdrop luminance mask) pause for that layer; a layer still on the old pre-timeline animation engine ignores that animation; and the part of a layer that hangs outside the frame is not drawn (it is not in an export either). All return the instant the bar ends. The three mask styles keep those effects live, which is one reason to keep them.

## Addendum 2 (2026-09-20): Assemble — the blocks never refine, they get wiped, and the wipe assembles

Julien, after Pixels: "I'd love a mix of the pixels and the wipe effect, where the pixels effect never decreases, it just gets wiped"; then, on a first preview with straight wipe lines and flat block colours: "how do you add more colour variation here? can I have a wipe that feels like the dither is assembling instead of the basic wipe?" He approved the second preview ("I love this"): blocks pop in SCATTERED ahead of a travelling front, in DITHERED colours, and a second scattered front turns them into the sharp layer.

A fifth Style, **Assemble**, listed second (Pixels · Assemble · Dissolve · Wipe · Dots). Pixels stays the default.

**What the user sees.** The cells stay ONE size for the whole transition. A front travels across the frame along the Angle. Ahead of it: nothing. Around it, cells appear one by one in dither order — sparse far ahead, solid behind — so the element assembles. A **band** behind the front is the element in block form. A second front, scattered the same way, follows the band and turns each cell into the real, sharp layer. Dither out is the same pass continuing the same way (as Wipe does).

**The block look comes from his shaders** — a **Look** choice:
- **Dither** (default): his Shader Studio **Dither** effect — one colour sample per cell, cut to a few levels per channel against a dither pattern, so neighbouring blocks land on different nearby colours. Dials: **Pattern** (the effect's 12: Coarse 2×2 · Bayer 4×4 · Fine 8×8 · Clustered · Scanline · Diagonal · White noise · Noise 2× · Blue noise · Blue noise 2× · Blue noise 0.5× · R2 noise) and **Colour levels** 2–8 (default 3).
- **Characters**: the ASCII effect at full density, with the same **Characters** menu as Pixels.

**Other dials:** **Block size** (constant; default 16), **Band width** 0–100% of the travel (default 30; 0 ≈ the sharp layer assembling directly, 100 = the whole element is blocks before the second front starts), **Scatter** 0–100% (default 35; how far ahead of a front cells start appearing; 0 is a hard line), **Angle**, **Shimmer speed** (the scatter order drifts in whole cells AND, for the Dither look, the dither pattern slides under the blocks so their colours shimmer — Julien: "I LOVE the colour shimmer"; a SHIMMER build of the Dither shader, the classic effect untouched; 0 is still). Edge softness does not apply.

**How.** Same side-canvas route as Pixels (layer drawn alone at full opacity on a frame-sized canvas; stamped back with its own opacity and blend; same price: backdrop-reading effects pause for the layer during the bar). Then:
1. The look picture: the Dither effect run directly over the side canvas (it already samples one colour per cell on a grid anchored to the frame), or the ASCII effect in matte mode at Brightness +1.
2. Two per-cell masks from pure maths, ON THE SHADER'S OWN GRID (anchored at the frame's bottom-left; 2:3 cells for the ASCII glyph shapes) so a mask edge never cuts a cell: **look** = reached by the first front, not yet by the second, and (Dither look) the layer covers the cell's centre; **sharp** = reached by the second front. With position `s` along the travel (0 → 1, flipped for Out), `soft = max(0.001, scatter × 0.6)` and `lead = amount × (1 + band + 2·soft)`: a cell is reached by the first front when `(lead − s)/soft ≥ 1`, or is above its drifting Bayer threshold while between 0 and 1; by the second front likewise with `lead − soft − band`, against a differently-offset threshold. Nothing at amount 0; everything sharp at amount 1.
3. Result = look picture × look mask + sharp side canvas × sharp mask, stamped.

Falls back to the Dissolve mask while its shader is loading, and exports wait for it, exactly as Pixels.

## Addendum 3 (2026-09-21): Settle transitions — the layer arrives broken by one of his shaders, and settles

Approved from an interactive preview (slice shift, colour split, blur, pixelate, wave settling to the sharp element). Julien's one change: **"I would show them as separate effects in the transition gallery"** — so there is no single "Settle" tile with a menu: EACH effect is its own pair of tiles, **Slice in / Slice out**, **Blur in / Blur out**, … in the gallery's In and Out groups, each with its own live preview. The inspector still has an **Effect** menu so a bar can be swapped in place (as letter bars can).

**First set (ten), each a Shader Studio effect run over the layer's own pixels with ONE strength dial driven to its rest value:**

| Tile | Effect | Dial(s) driven → rest | Full strength (at Starting strength 100) |
|---|---|---|---|
| Slice | slice_shift | amount → 0 | 0.35 |
| Glitch | rgb_glitch | amount → 0, chroma → 0 | 0.2, 0.03 |
| Colour split | chromatic_aberration | amount → 0 | 0.06 |
| Blur | gaussian_blur | radius → 0 | 0.06 |
| Zoom blur | zoom_blur | strength → 0 | 0.5 |
| Pixelate | pixelate | size → 0 | 0.08 |
| Wave | wave | amplitude → 0 | 0.12 |
| Liquify | liquify | amount → 0 | 0.3 |
| Swirl | swirl | strength → 0 | 6 |
| Ripple | water_ripple | amplitude → 0 | 0.06 |

**Dials:** Effect · Direction (In / Out) · **Starting strength** 0–100 (default 70) · **Fade** switch ("Fade while it settles", default on: opacity ramps over the first quarter of the bar) · Easing (default Linear) · Timing. The strength follows `(1 − amount)²` — most of the settling happens early, the tail is gentle — scaled by Starting strength. Everything else about the effect stays at its Shader Studio default; effects with their own clock (glitch, wave, liquify, ripple, swirl) run on the bar's elapsed time, so preview, bake and export agree.

**How.** A `settle` bar is the same kind of thing as a dither bar: ONE number band on the motion-only property `reveal` (so the two families share a timeline row, "Reveal", and overlapping bars are flagged as the clash they are), and the look rides on the bar. While the bar plays the layer is drawn alone onto the frame-sized side canvas (the Pixels / Assemble route, same accepted price: effects that read the backdrop pause for that layer). Then, because most of these shaders write fully OPAQUE pixels — clipped back to the layer's outline, a slice could never leave the letter it came from — the transparency is recovered exactly:
1. the shader runs over the layer **premultiplied onto black** (colour × coverage, opaque);
2. the SAME shader, same clock and seed, runs over the layer's **coverage** (white where the layer is, on black);
3. a tiny combine pass divides one by the other: colour = (1) ÷ coverage, alpha = coverage (per channel, so a colour split's red fringe keeps its own coverage). Exact for every effect that moves or averages pixels, which is all ten.
Three GPU passes per frame for that layer while its bar plays; nothing outside it. At amount 1 there is no note and the normal draw takes over; at strength ≈ 0 each of the ten is the identity, so there is no pop. While the shader is loading a settle bar draws as a plain fade; exports wait for it.

## Planned next (not in this build)

- **Shader reveal** — a fourth Style, **Shader**, with a picker: any Shader Studio effect that generates a moving field (noise, clouds, heatmap, slice patterns…) is rendered through the existing shader runtime, and its brightness is compared with the amount using the luminance-mask maths that already exists. The layer condenses out of that shader's own motion. It is one more pattern source plus the picker; GPU cost applies only while the bar plays.
- ~~**Shader settle**~~ (now Addendum 3) — a separate transition family: the layer arrives *through* a shader running on its own pixels (slice shift, chromatic aberration, glass, pixelate) whose strength the bar drives to zero. Needs its own small spec: a curated list declaring each shader's strength dial and rest value, and a pass that exists only while the bar is live so no dead effect is left in the Design tab.
- More mask styles on this mechanism as wanted: iris, blinds, clean wipe, pixel blocks.

## Defaults and ranges

| Dial | Range | Default | Notes |
|---|---|---|---|
| Style | Pixels · Dissolve · Wipe · Dots | Pixels | see the addendum; the three others are the mask styles |
| Direction | In · Out | per gallery tile | |
| Cell size | 1–40 | 8 (24 for Pixels, where it reads Block size) | thousandths of the frame's width (8 ≈ 10px on a 1280 frame) |
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
- **Inspector:** Studio rows throughout (a labelled select for Style — four segments do not fit a 228px row — and a labelled segmented row for Direction), Edge softness shown only for Wipe, one undo step per drag.
