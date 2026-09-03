# Vector Type Studio — the Motion tab as a stack of moves

**Date:** 2026-09-03
**Status:** designed, not built
**Scope:** the Motion tab of the Vector Type Studio (`frontend/app/components/vue-canvas/VectorTypeSurface.vue`), the motion part of its config (`frontend/app/lib/vectortype/config.ts`), the preset evaluator (`presetMotion.ts`), the shared ease resolver (`frontend/app/lib/motion/easing.ts`), and one new gallery component. Nothing outside Vector Type changes except one additive ease-name form in the shared resolver.

## In plain words

**What is broken.** The Motion tab stacks five different ways of animating on top of each other, each with its own look: three preset slots that open a modal, a block of sliders called "Motion" that is really Stagger plus two effects, two inline tile galleries, raw track rows with dropdowns and number fields, and clip length at the very bottom. Five paragraphs of explanation try to hold it together. There is no way to see or edit an ease curve, and a preset's ease is hidden. You cannot stack two entrances. Ping-pong is offered as an ease when it is a play direction.

**What changes.** Everything you can add becomes one kind of thing: a **move**. Weight In, Fade In, Stretch Wave, Blink, Light Sweep, a hand-made track: all moves. The tab is a list of the moves you have added, one card each, plus an **Add move** button that opens one gallery. Every card has the same rows: when it plays (In, Loop, Out), how long, its ease curve, how it repeats, and two or three dials of its own. Moves stack without limit, including several In moves and several Out moves. The clip settings (length, frame rate, letter-by-letter timing) sit in one small block at the top. A thin bar under the preview shows where In, Loop and Out fall in the clip.

**What falls out of it.** The engine already composes sources by adding positions and multiplying scale and opacity. That rule is kept and extended from "one preset per slot plus tracks" to "any number of moves". The ease curve editor already exists in 3D Studio and Space Type and is reused. Old saved documents are converted on load and render exactly as before.

**What is risky.** The save format changes (slots and tracks become one list of moves), so the conversion has to be exact and tested against real old configs. Stacking two In moves that both drive opacity or the same axis can look odd; the gallery refuses a second move on the same dial and says why.

## 1. The move

A move is one record in `motion.moves`. Order in the list is the order shown; it does not affect the result, because composition is commutative (add and multiply).

```ts
interface VtMove {
  id: string                       // stable id, like appearance layers
  phase: 'in' | 'loop' | 'out'
  kind: 'preset' | 'tracks' | 'blink' | 'scatter'
  /** kind 'preset': a kinetic-engine id or an axis-preset id. kind 'tracks': the
   *  track-preset id it was made from, or 'custom'. Absent for blink/scatter. */
  presetId?: string
  /** Seconds. In/Out: how long the phase takes. Loop: one cycle. */
  duration: number
  ease: VtEase
  play: VtPlay
  /** Per-preset knobs, numeric only (same shape the engine already reads). */
  params?: Record<string, number>
  /** kind 'tracks' only: the tracks this move owns. Editable in the card. */
  tracks?: VtMotionTrack[]
}

type VtEase =
  | { kind: 'named'; name: VtEaseName }
  | { kind: 'bezier'; cps: [number, number, number, number] }

type VtEaseName =
  | 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate'
  | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'

interface VtPlay {
  mode: 'once' | 'backAndForth' | 'repeat'
  /** repeat only: cycles inside the clip. Default 1. */
  times: number
}
```

**What each kind means.**

- `preset`: evaluated by the shared kinetic engine (Fade, Slide, Grow, Blur, Wave…) or by the axis-preset table (Weight In, Weight Wave, Width Breathe, Grade Pulse, Grade Flicker, Optical Drift). Same as today's slot presets.
- `tracks`: one or more tracks over config dials. Made from a track preset (Stretch In, Stretch Wave, Spring Up, Light Sweep, Misregistration, Colour Cycle) or by hand (`presetId: 'custom'`, exactly one track). A track keeps its `path`, `from`, `to`, `hold`, `cycleOffset`, `delay` and colour fields. Its old `easing` and `loops` fields are dropped; the move's `ease` and `play` replace them.
- `blink` and `scatter`: the two seeded effects. Their settings stay where they are (`motion.blink`, `motion.scatter`) because their evaluators read them there and they are animatable leaves. The move record is a marker that puts a card in the list. Adding the Blink move sets `blink.amount` to 0.3; removing it sets 0. Same for Scatter with `spread` 0.4. There can be at most one of each, and `phase` is always `loop`.

**Stagger is not a move.** `motion.stagger` stays as it is: one shared per-glyph clock every move reads. It is shown in the clip block as "Letter by letter", never inside a card. (Jitter puts this per animation; we keep one clock on purpose, so a weight wave and a slide-in ripple across the word together.)

**Ease and play, separated.** Today a track's `easing` mixes a curve (`linear`, `easeinout`) with a direction (`pingpong`). A move has both:

- `ease` shapes one pass. Names map onto functions that already exist in `lib/motion/easing.ts`: none → linear, smooth → power2.out, natural → sine.inOut, slowDown → power3.out, accelerate → power3.in, overshoot → back.out, elastic → elastic.out, bounce → bounce.out, swing → back.inOut (new, trivial), steps → steps(6). A bezier ease is the four control points the existing curve editor already edits.
- `play` says how the pass repeats. `once` plays the pass over `duration`. `backAndForth` plays it forward then backward each cycle (today's ping-pong). `repeat` plays it forward `times` cycles inside the clip.

For In and Out moves, `play` is fixed to `once` and not shown. For Loop moves all three are offered. A kinetic loop preset (Wave, Bounce, Jello…) is periodic on its own, so its `ease` defaults to `none` and `play` to `repeat`; setting an ease on it shapes each cycle's phase.

Blink and Scatter have no ease and no play. Their cards show only their own dials.

## 2. Composition

`vtGlyphMotion` keeps its signature and its rule, generalised to N moves:

- `dx`, `dy`, `rotate`, `blur`: add across moves (identity 0).
- `scale`, `opacity`: multiply (identity 1), opacity clamped to 0..1.
- `scaleX`, `scaleY`: multiply.
- `axes`: add per tag, dropping tags that sum to 0 (the existing `addAxes`).
- `clip`: if several moves clip, the largest `amount` per side wins.

Tracks from every `tracks` move are gathered into one flat list for `applyMotion`, which is unchanged except that each track's ease and play now come from its move.

**Phase windows with several moves.** Each In move runs from `t = 0` for its own `duration`. Each Out move runs from `W − duration` to `W`, where `W` is the clip length. Loop moves run for the whole clip; their phase 0 is at the end of the longest In move, so an entrance hands off cleanly to a loop as it does today. `vtSlotPhase` becomes `vtMovePhase(move, gt, W, longestIn)` and is called once per move. A move whose window is not live contributes identity.

**Same dial twice.** Two `tracks` moves driving the same config path would fight, and the later one would win silently. The gallery refuses to add a move whose tracks target a path another move already drives, and shows one line on the tile: "Weight is already driven by Weight Wave". Preset moves are not checked; two presets that both move opacity compose by the rule above and that is the intended behaviour (fade plus blink, grow plus slide).

## 3. The panel

The Motion tab, top to bottom. Widths and row heights follow the existing studio rows (`StudioSection`, the 28 px control row, `StudioButton`).

**Clip block.** One `StudioSection` titled "Clip", always open, three rows: Length (slider 1–12 s), Frame rate (24 / 30 / 60), Letter by letter (delay slider 0–1 s, with the order select beside it; the shuffle seed row appears only when order is random, as now). Frame count reads in the section badge.

**Moves list.** A `StudioSection` titled "Moves" with an **Add move** button in its badge slot. Each move is a card:

- Collapsed: one 28 px row. Name on the left (Weight In, Stretch Wave, Custom · Slant), a phase tag on the right (In / Loop / Out), a 16 px ease glyph, and a delete icon on hover. Click anywhere to expand. Only one card is open at a time (Jitter shows one animation's settings at a time; a 288 px column cannot hold several open).
- Expanded, in this order: Length (number, seconds); Ease (a row showing the curve thumbnail and name, click opens the ease picker); Play (segmented once / back and forth / repeat, with a small ×N field when repeat is chosen; hidden on In and Out moves); then the move's own dials. For a preset move these are its `params` from the catalog (Slide has distance, Glitch has intensity…). For a `tracks` move made from a preset, the dials are the preset's declared knobs (Stretch Wave has amount and speed; Light Sweep has turns; Colour Cycle has the mix space). For a Custom move: the dial select (grouped as `animatableGroups` today), From and To (or two swatches and a mix space for a colour dial). For Blink and Scatter: exactly the sliders that exist for them in `controls.ts` today, gated the same way.
- A tile-level "Change" button on the expanded card opens the gallery filtered to the same phase, and swaps the move in place keeping `duration`, `ease` and `play` where they still apply.

**Empty state.** When there are no moves the section shows one sentence, "Nothing moves yet.", and the Add move button. No gallery is drawn inline.

**What is removed.** The In / Out / Loop slot buttons, the "Motion" schema section, the Stretch and Stack motion inline tile grids, the raw track rows, the Duration / FPS block at the bottom, the "Both are running" and "presets also running" notes, the "Stagger shifts the clock" note. The two remaining warnings stay, as one line each, inside the card they belong to: "Typewriter needs Letter by letter above 0" on a Typewriter move at delay 0, and "Scatter is not running: this font has no Width axis" on the Scatter card.

**Tab badge.** The Motion tab shows the number of moves. Blink and Scatter count as moves.

**Band strip under the preview.** A 10 px bar between the preview and the prompt bar: amber for the longest In window, green for the loop span, amber for the longest Out window, with the three labels under it. Read-only. Its only job is to show that an entrance is 0.6 s of a 4 s clip. Dragging comes later if wanted.

## 4. The gallery

One modal, replacing `MotionPresetPicker` for this studio, opened by Add move or Change. Anchored to the panel like the current picker. Four tabs across the top: **In · Loop · Out · Custom**. Tiles are the existing `PresetThumb` / `VectorTypeThumb` previews with a label and a one-line pitch. Unavailable tiles are greyed with their one-line reason (font lacks the axis; needs an extrude layer; dial already driven).

Groups within each tab, in this order:

- **In:** Letterform (Weight In, Stretch In, Spring Up), Appear, Slide, Mask, Scale, Blur, Rotate, Physics, Glitch, Text.
- **Loop:** Letterform (Weight Wave, Width Breathe, Grade Pulse, Grade Flicker, Optical Drift, Stretch Wave), Play (Blink, Scatter, Wave, Bounce, Jello, Float, Sway, Tremble, Breathe, Heartbeat, Neon Flicker, Throb), Colour (Colour Cycle from the track table, Color Wave), Layer (Light Sweep, Misregistration), Glitch.
- **Out:** Appear, Slide, Mask, Scale, Blur, Rotate, Physics, Glitch, Text.
- **Custom:** a list of every animatable dial, grouped as the track target select is today (Axes, Glyph, Layout, layers by name). Picking one creates a Custom move in the phase chosen by a small In / Loop / Out toggle at the top of the tab, defaulting to Loop, with From and To set to the dial's range.

Letterform is first in In and Loop on purpose: re-cutting the letters is the only thing in this gallery no other tool has.

The engine-side groups reuse `group` from `kinetic-presets.ts`; the labels above are display names. Only presets this studio can draw are listed, gated by `VT_PRESET_CAPABILITIES` as now.

## 5. The ease picker

A small popover from the Ease row. A 2 × 5 grid of the ten named eases, each tile a curve glyph and its name, the current one highlighted. An eleventh tile, **Custom curve**, expands the existing `CurveEditor.vue` under the grid. Dragging its handles writes a bezier ease; the row then reads "Custom" with the live curve as its glyph. The editor's own quick buttons (ease, in-out, expo, linear) stay.

Ease glyphs are drawn from the same functions the resolver uses, sampled at 24 points into a tiny SVG, so the picture can never disagree with the motion.

## 6. Engine and shared code changes

- `lib/motion/easing.ts`: `resolveEase` learns one more name form, `bezier(x1,y1,x2,y2)`, resolved with the cubic-bezier solver Space Type already has (`bezierEase` in `lib/spacetype/motion.ts`, moved next to the resolver). Additive; nothing else in the Compositor changes.
- `lib/vectortype/ease.ts` (new): the `VtEase` type, the ten names, `vtEaseToName(ease): string` (a named ease → its engine name; a bezier → `bezier(...)`), `vtEaseGlyphPath(ease)` for the thumbnails. 3D Studio's `EaseRef` is the same shape; it is not touched in this pass, and a later pass can point both at one type.
- `lib/vectortype/presetMotion.ts`: `vtPresetSpecs` returns the list of preset moves as engine specs; `vtMovePhase` replaces `vtSlotPhase`; `unitStateFor` loops over moves and composes. Every existing preset-motion test is kept with its config rewritten to the move form, plus new cases below.
- `lib/vectortype/motion.ts`: `applyMotion` takes its tracks from the moves and reads ease and play from the owning move. `animatableTargets`, `pruneStackTracks`, the id-path migration and the colour-track helpers are unchanged apart from where they find the tracks.
- `lib/vectortype/trackPresets.ts`: `build` returns a `VtMove` instead of bare tracks; each preset declares its knobs (label, path within the move, min, max, default) so the card can draw them. `vtTrackPresetActive` and `vtApplyTrackPreset` work on moves.
- `lib/vectortype/config.ts`: `VtMotionConfig` gains `moves` and loses `tracks`, `in`, `out`, `loop`. `mergeMotion` converts the old shape (section 7). `mergeMove` type-checks every field the way `mergeTrack` does today.
- `lib/vectortype/controls.ts`: the `Motion` group keeps only the stagger controls (they draw in the clip block). Blink and scatter sliders keep their keys and `when` gates and are drawn inside their cards through the same schema rows.
- `lib/vectortype/agentControls.ts`: the agent's vocabulary gains three words over the moves list, using the stable-id list addressing the appearance stack already uses: add a move by preset id and phase, remove a move by id, and set a field on a move (`moves.<id>.duration`, `moves.<id>.ease`, `moves.<id>.params.<key>`). Track dials inside a move stay reachable as `moves.<id>.tracks.<i>.from`.
- Renderers, thumbnails, bakes, the node card and the SVG export call `vtGlyphMotion` / `applyMotion` and do not change.

## 7. Loading old documents

`mergeMotion` accepts both shapes. When it sees the old one it builds the moves list:

1. `in`, `out`, `loop` slot specs → one preset move each, `phase` from the slot, `ease` from the spec's `ease` string if it names something the ten names cover, else the preset's default, `play: once` for in/out and `repeat ×1` for loop.
2. Tracks: if the set of tracks matches a track preset (the check `vtTrackPresetActive` already makes), those tracks become one `tracks` move with that preset id. Every remaining track becomes its own Custom move. Track `easing` maps: `linear` → ease none, play once; `easeinout` → ease natural, play once; `pingpong` → ease none, play back and forth. Track `loops` → `play.times`. Phase is always `loop`: there is no safe way to tell an entrance from a loop in old data, and loop reproduces the old timing exactly.
3. `blink.amount > 0` → a Blink move. `scatter.spread > 0` → a Scatter move.

A parity test loads each fixture config in `tests/unit` that carries motion, renders three frames through `vtGlyphMotion` before and after conversion, and requires equality within 1e-9. New documents are written in the new shape only.

`migrateKinetic.ts` (the old Kinetic Type node importer) writes moves directly.

## 8. Errors and edge cases

- A move whose preset id no longer exists is dropped at load, as an unknown slot preset is today.
- A `tracks` move whose layer was deleted is pruned with its tracks (`pruneStackTracks`, unchanged).
- A Custom move on a dial the current font does not have (an axis) is kept and shown greyed with the reason, the same rule the Scatter card follows.
- Ease control points are clamped to the editor's range (x 0..1, y −0.6..1.6).
- `duration` is clamped 0.05..60. An In plus an Out longer than the clip: Out starts at `max(longestIn, W − outDuration)` as today, so it never runs backwards over the entrance.

## 9. Testing

Unit, in `tests/unit`:

- `vectortype-moves-compose`: two In moves (fade-in and slide-up) at three times equal the product/sum of each alone; a preset move plus a Custom track on the same glyph transform compose by the rule; identity when no move is live.
- `vectortype-moves-phase`: windows for two Ins of different length, an Out, and a loop whose phase 0 sits at the longest In's end; cross-checked against real `evaluateAnimation` output as the slot-phase test does today.
- `vectortype-ease`: each named ease resolves to the expected function at t = 0, 0.5, 1; `bezier(...)` parses and matches `bezierEase`; the glyph path is monotone in x.
- `vectortype-play`: back-and-forth is seamless at the cycle boundary; repeat ×3 hits the end value three times.
- `vectortype-moves-migrate`: the parity test in section 7, plus a fixture with every old track easing.
- `vectortype-moves-gallery`: duplicate-dial refusal, availability reasons, Blink and Scatter single-instance rule, phase filtering.
- Existing `vectortype-preset-motion`, `-track-presets`, `-stretch-presets`, `-stagger-presets`, `-color-tracks`, `-config` and `-controls` tests are updated to the move shape and must stay green.

Browser, against the dev server: add Weight In, Fade In, Stretch Wave, Blink and a Custom slant move; confirm the badge reads 5, the band strip shows both amber windows, each card opens alone, the ease picker writes a bezier and the preview visibly changes, deleting Blink sets its amount to 0, and a saved document reopens with the same list. Then load a pre-change document from a fixture and confirm the node card thumbnail is unchanged.

## 10. Out of scope

- A draggable timeline. The band strip is read-only.
- Saving a tuned move as your own preset (Butter's "save this block"). The data shape allows it later.
- Per-move stagger. One clock, on purpose.
- Sharing the `VtEase` type with 3D Studio's `EaseRef`. Same shape, separate files for now.
- Any change to the Compositor's motion panel beyond the additive bezier ease name.
