# Letter behaviours — typographic motion for Frame text layers

Date: 2026-09-19 · Status: approved design (Julien), spec for review · Follows: `2026-09-17-dialkit-motion-ui-design.md`, the 6b plan.

## Why

The band timeline animates a text layer as one block. The old per-letter presets were retired with the legacy Motion UI, and when old frames convert, text loses its letter-by-letter stagger. Julien wants typographic motion back, richer than before, authored on the new timeline.

## What the user gets

When a **text layer** is selected, the Add behaviour popover gains a **Letters** group. Its moves animate the *pieces* of the text — letters, words or lines — one after another.

Programme (each phase ships usable on its own):

| Phase | Contents |
|---|---|
| **1 (this spec)** | The foundation · **Cascade in / out** · **Typewriter** · **Mask slide** · **Scramble** · works on straight, wrapped AND on-a-path text |
| 2 | Loops (wave, bounce, jitter) · **Decode** (letters flicker through random characters) · **Slot slide** (each letter is a slot-machine reel that lands on the real glyph) |
| 3 | Type-property moves as ordinary bands + gallery moves: tracking, weight / width / slant (variable fonts), size, line height — later able to ripple through letters |

### Shared controls (every letter behaviour)

- **Animate by** — Letters · Words · Lines. A word or a line moves as one piece, around its own centre.
- **Stagger** — seconds between one piece starting and the next.
- **Order** — Left to right · Right to left · From the centre · From the edges · Random.
- **Shuffle** — a seed. Random looks are repeatable; preview, bake and export match frame for frame.
- Timing (start, duration) and the easing/spring editor — exactly as on other behaviour bars. **The bar is the whole move:** its end is when the LAST piece finishes. Each piece therefore runs for `duration − (pieces − 1) × stagger` (never less than 0.05s; if the stagger would not fit, it is scaled down to fit and the inspector says so).

### Phase-1 behaviours

- **Cascade in / Cascade out** — Style: Fade · Rise · Drop · Grow · Spin (styles other than Fade also fade). Amount: distance in letter-heights (Rise/Drop), start scale (Grow), degrees (Spin). A spring easing gives a bouncy landing.
- **Typewriter** — hard cuts, one piece at a time. Direction: Type · Delete. Cursor: None · Bar · Underscore, with a blink rate; the cursor sits after the last visible piece.
- **Mask slide** — each piece slides out from behind its own invisible edge. Direction: Up · Down · Left · Right. In and out variants (a Direction of travel toggle: Reveal · Hide).
- **Scramble** — pieces jump to random spots on the page.
  - Mode: **Settle** (jump around, then land in place — an entrance) · **Scatter** (start in place, then break apart — an exit) · **Keep going** (jump for as long as the bar lasts; loops).
  - **Area** — width and height as a share of the frame, from "around the text" to the whole page (two sliders, 0–100%, centred on the text).
  - **Time per jump** — seconds each piece stays before its next jump.
  - **Move** — Snap (hard cut) · Glide (eased slide between spots; uses the bar's easing).
  - **Spin** — optional random rotation per jump, 0–180°.
  - In Settle mode, Order + Stagger decide which pieces land first; every piece ends EXACTLY on its real position and angle.
  - Keep going runs for the bar's whole length — stretch the bar to cover the time you want. It is not a repeating cycle, so it shows no ghost copies or ∞.

### Where it lives in the timeline

- Letter bars sit in one **Letters** row per text layer (below the layer header, above property rows). Overlapping letter bars **combine** — a cascade in, a scramble and a mask slide can all act on the same layer at once — so the row never shows the amber clash warning.
- Selecting a bar opens the normal behaviour inspector with an extra **Text** section for the shared controls.
- "Open into keyframes" is hidden for letter bars: there are no per-letter bands to open into.
- Whole-layer bands keep working underneath: the layer moves/fades/scales as before and its pieces move relative to it.

## How it works

### Model

A letter behaviour is a `StoredBehaviour` (same list, same undo, same persistence as today) whose `kind` starts with `text.` — `text.cascade`, `text.typewriter`, `text.maskSlide`, `text.scramble`. It does **not** compile to tracks: `compileBehaviour` returns `[]` for `text.*` kinds. Instead it is evaluated per frame.

New pure module `frontend/app/lib/motionx/text/` (no Vue, no canvas):

- `units.ts` — types. `TextCell { char, x, y, w, h, angle, word, line }` (pixels, layer-local, origin = layer centre; `angle` radians, 0 for straight text). `UnitState { dx, dy, scale, rotation, opacity, clip?, glyph? }` — `dx/dy` in cell-heights in the CELL's own rotated frame, except when `space: 'page'` (Scramble) where they are frame fractions; `glyph` is reserved for phase 2. `groupCells(cells, by)` → piece index per cell + each piece's centre.
- `order.ts` — `pieceDelays(pieceCount, centres, order, stagger, seed)` → start delay per piece (seeded shuffle for Random; centre/edges by distance from the text's middle).
- `evaluate.ts` — `evaluateTextBehaviours(behaviours, t, cells, frame) → UnitState[]` (one per cell). Runs every active `text.*` behaviour and **composes**: offsets and rotations add, scales and opacities multiply, clips intersect. Before a bar's start an *entrance* holds its first state (hidden), after its end it holds its last; an *exit* is the mirror; Keep-going loops wrap. A registry `registerTextBehaviour(kind, fn)` mirrors the existing behaviour registry; each behaviour is one small pure function `(progress01, piece, params, rng) → UnitState`.
- `rng.ts` — a seeded PRNG (mulberry32) — no `Math.random()` anywhere in the render path.

### Layout: one cell list for every kind of text

`layoutTextCells(ctx, layer, W, H)` in `frontend/app/lib/motion/animatedText.ts` replaces `layoutTextUnits`' role: straight / wrapped text produces cells as today plus `word` / `line` indices; text with `layer.path` builds cells from `placeGlyphs(...)` (`lib/compositor/textPath.ts`), which already returns per-glyph `x, y, angle, advance`. Per-word "expressive" layouts are out of scope for phase 1 (they keep animating as a whole layer).

### Drawing: inside the normal layer pipeline

Today's per-letter drawing (`drawAnimatedTextLayer`) bypasses layer effects and masks. Letter behaviours must not: the per-frame fold attaches a transient, never-persisted `textUnits: UnitState[]` to the layer CLONE (the same pattern as `motionScale`), and the text branch of `drawLocalLayer` draws per-cell when it is present — so effects, masks, blend modes and the group cascade all apply unchanged. With no active letter bar the field is absent and rendering is byte-identical. Words/lines pivot about the piece centre; path glyphs draw at their `angle`; `clip` is a per-cell rectangle in the cell's frame (Mask slide); the Typewriter cursor is one extra cell-sized rect.

### UI

- `gallery.ts`: a `Letters` group, `needs: 'text'` (the capability filter already exists), CSS previews on the word "Type".
- `MotionBandTimeline.vue`: the Letters row; letter bars reuse the behaviour-bar markup and drags.
- `MotionInspector.vue`: a Text section + per-kind params; hides Open for `text.*`.
- `CompositorModal.vue`: `addBehaviour` skips track compilation for `text.*`; nothing else changes (undo, delete, Space, agent merge all already operate on `behaviours`).

## Phase 2 (approved 2026-09-19) — loops, Decode, Slot slide

- **Wave · Bounce · Jitter** — loops that run for the bar's length with a soft ramp in and out. Controls: Amount, Speed, Offset between pieces (wave/bounce), animate by letters / words / lines, Order, Shuffle (jitter).
- **Decode** — letters flicker through random characters, then lock (Resolve) or the reverse (Dissolve). Characters: Same as the text · Letters · Numbers · Symbols · Mixed; Flicker rate; Stagger + Order decide which lock first. Substitute glyphs are centred in the real letter's slot.
- **Slot slide** — each letter is a window with a reel rolling through it that lands on the real glyph. Direction In · Out; Rolls up · Rolls down; **Steps** = how many characters roll past before it lands (Julien's ask); Filler set; easing (ease-out = deceleration, spring = overshoot and tick back).
- The **Easing** section shows only where easing does something: Cascade, Mask slide, Slot slide, Scramble in Glide mode. Hidden on Typewriter, Decode, loops, Scramble in Snap mode.
- Plan: `docs/superpowers/plans/2026-09-19-letter-behaviours-phase2.md`.

## Out of scope for phase 1

Loops, Decode, Slot slide (phase 2) · type-property moves (phase 3) · expressive per-word layouts · letter behaviours on non-text layers · converting old `layer.animation` text presets into letter behaviours (possible later: the leftovers already show as "Older animation").

## Testing

- Pure units (Vitest): delay/order maths for every Order incl. seeded Random; composition rules; each behaviour at progress 0 / mid / 1; **Settle ends exactly at rest** for every piece; same seed ⇒ same output, different seed ⇒ different; `groupCells` for letters/words/lines incl. wrapped lines and path text.
- Render identity: a text layer with no active letter bar paints pixel-identical to today (straight, wrapped, on a path).
- Pipeline: a letter-animated text layer with a drop shadow and a mask still shows both.
- Live (browser): Cascade on straight text, Mask slide by lines on wrapped text, Scramble → Settle on text on a circle; undo/redo; bake parity (baked frames match the live preview at the same t).

## Risks

- `drawLocalLayer`'s text branch is large and shared; the per-cell path must be a narrow, flagged branch. If threading it through proves too invasive, the fallback is rendering the per-cell text into the layer's own-content buffer before the effect stack — same user-visible result.
- Per-cell drawing costs one transform + fillText per glyph per frame; long paragraphs by Letters may need a cap or a words-only suggestion. Measure before optimising.
- Kerning: cells are placed by prefix measurement (as path text already does), so animated letters at rest sit exactly where static text does — verified by the render-identity test.
