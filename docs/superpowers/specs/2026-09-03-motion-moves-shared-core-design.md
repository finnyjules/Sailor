# Motion moves — shared core and per-studio adapters

**Date:** 2026-09-03
**Status:** designed, not built
**Amends:** `2026-09-03-vector-type-motion-moves-design.md` (the Vector Type moves design). Its behaviour stands unchanged; this spec changes WHERE the code lives so other studios can use the same panel.
**Consumers in order:** Vector Type (first, has a plan), Shape Studio (second, new to motion), then Gradient and Shader (convert their existing tracks).

## In plain words

**What is the problem.** Gradient, Shader, and Vector Type already share one track data shape and one easing engine, but each draws its own Motion tab, so the same track rows exist three times. The Vector Type moves redesign is about to rebuild that tab well: one list of moves, one gallery, an ease picker, a band strip. Built inside Vector Type only, it would become a fourth private panel, and Shape Studio, which is about to need motion for blends, would have to copy something again.

**What changes.** The moves design is split in two. A **shared core** holds everything that is not about letters: the move record with tracks as the universal move kind, the ten named eases plus custom curves, play modes, phase windows, the rule for composing tracks, and the panel itself (clip block, move cards, Add-move gallery, ease picker, band strip). A **per-studio adapter** supplies what is specific: Vector Type adds its preset, blink, and scatter move kinds and its gallery tabs; Shape Studio adds only the list of dials that can move.

**What falls out of it.** Shape Studio gets a finished Motion tab by writing an adapter and a frame feed, with no old data to convert. Gradient and Shader later convert their tracks to Custom moves with the exact rule the Vector Type design already wrote for its own tracks. 3D Studio keeps its own motion module for now; its ease type has the same shape and can be pointed at the shared one later.

**What is risky.** The shared panel must not carry Vector Type assumptions. The clear case is letter-by-letter timing (stagger), which is Vector-Type-only and becomes an adapter slot in the clip block. The Vector Type plan (13 tasks) needs its file paths and a few task boundaries revised before it runs.

## 1. Shared core — `frontend/app/lib/studio/moves/`

Lives beside `lib/studio/track.ts` (the easing engine the three stateless studios already share), not in `lib/motion/` (the Frame/Compositor evaluator).

- `types.ts`
  ```ts
  export interface Move {
    id: string
    phase: 'in' | 'loop' | 'out'
    /** 'tracks' is the universal kind. Studios may add kinds through their adapter. */
    kind: string
    presetId?: string          // for 'tracks': the track preset it was made from, or 'custom'
    duration: number
    ease: MoveEase
    play: MovePlay
    params?: Record<string, number>
    tracks?: MoveTrack[]
  }
  export interface MoveTrack {   // the shared track shape minus easing/loops (the move owns those)
    path: string; from: number; to: number
    hold?: number; cycleOffset?: number; delay?: number
    fromColor?: string; toColor?: string; mix?: string
  }
  export type MoveEase = { kind: 'named'; name: MoveEaseName } | { kind: 'bezier'; cps: [number, number, number, number] }
  export type MoveEaseName = 'none' | 'smooth' | 'natural' | 'slowDown' | 'accelerate' | 'overshoot' | 'elastic' | 'bounce' | 'swing' | 'steps'
  export interface MovePlay { mode: 'once' | 'backAndForth' | 'repeat'; times: number }
  export interface MotionClip { moves: Move[]; duration: number; fps: number }
  ```
  These are the Vector Type spec's `VtMove` / `VtEase` / `VtPlay` with the studio prefix dropped and `kind` opened to a string. `VtMove` becomes a type alias with its three extra kinds narrowed.
- `ease.ts` — name → engine ease (`resolveEase` in `lib/motion/easing.ts` gains the `bezier(x1,y1,x2,y2)` form per the Vector Type spec, Task 1), `easeGlyphPath(ease)` for thumbnails, `bezierEase` moved next to the resolver.
- `phase.ts` — `movePhase(move, t, clipLength, longestIn)` and `moveWindows(clip)` for the band strip (Vector Type spec §2, unchanged).
- `tracks.ts` — `applyMoveTracks(cfg, clip, t, io)` clones `cfg` and writes each track's value at `t`, reading ease and play from the owning move; `io` supplies `getByPath` / `setByPath` / `setByIdPath` so id-addressed layer paths work for any studio. `animatableTargetsFromControls(controls, cfg, expandLayerKey)` builds the Custom-tab list from a ControlSpec array the way Gradient's `animatableTargets` does today.
- `merge.ts` — `mergeMove`, `mergeClip`, and `convertLegacyTracks(tracks, presets)` → `Move[]` (Vector Type spec §7 step 2: matching preset → one tracks move; the rest become Custom moves; `linear` → none/once, `easeinout` → natural/once, `pingpong` → none/backAndForth, `loops` → `play.times`, phase loop).
- `adapter.ts`
  ```ts
  export interface MovesAdapter<Cfg> {
    /** Extra move kinds beyond 'tracks': card body renderer + evaluator hook. Empty for Shape Studio. */
    kinds: Record<string, MoveKindDef<Cfg>>
    /** Gallery groups per phase (presets). Empty groups hide the phase's preset tabs, leaving Custom. */
    gallery(cfg: Cfg, phase: 'in' | 'loop' | 'out'): GalleryGroup[]
    /** Dials the Custom tab offers, grouped. */
    animatable(cfg: Cfg): AnimatableGroup[]
    /** null = available; a string is the one-line reason a tile is greyed. */
    availability(cfg: Cfg, candidate: Move): string | null
    /** Optional rows for the clip block (Vector Type: Letter by letter). */
    clipExtras?: Component
  }
  ```

## 2. Shared panel — `frontend/app/components/vue-canvas/motion/moves/`

`MovesPanel.vue` (clip block + moves list + Add move + empty state), `MoveCard.vue`, `MoveGallery.vue` (tabs In · Loop · Out · Custom; groups from the adapter; duplicate-dial refusal), `EasePicker.vue` (2 × 5 named eases + Custom curve via the existing `CurveEditor.vue`), `MoveBandStrip.vue`. Props: `clip` (v-model), `adapter`, `cfg`. Everything in the Vector Type spec §3–§5 is built here once. Tile thumbnails are adapter-supplied components (`PresetThumb` / `VectorTypeThumb` for Vector Type).

## 3. Vector Type adapter — `frontend/app/lib/vectortype/movesAdapter.ts`

Kinds `preset`, `blink`, `scatter` with their evaluators (`presetMotion.ts`), gallery groups and `VT_PRESET_CAPABILITIES` gating, the slot/blink/scatter conversion (Vector Type spec §7 steps 1 and 3), agent words (§6), Kinetic Type import. `VtMotionConfig.moves: Move[]` uses the shared type. The Vector Type plan's tasks change as follows: Tasks 1, 2 (move/ease/play types and merge), 4 (phase windows), 8, 9, 10 (panel shell), 11 (band strip) build in the shared paths above; Tasks 3, 5, 6, 7, 12, 13 stay Vector-Type-specific. Test files for the shared parts move to `tests/unit/studio-moves-*.spec.ts`.

## 4. Shape Studio — consumer two (its own plan, after the shared core lands)

- `GeoStudioDoc.motion?: MotionClip` — absent = still, exactly today's behaviour.
- `lib/geoshape/motion.ts`: `applyMotion(doc, t)` = `applyMoveTracks` with paths `layers.<layerId>.mark.<key>` and `layers.<layerId>.offset.<x|y|scale|rotate>` (id-addressed like Vector Type's stack; `listRemap` drops tracks of a deleted layer); `animatableTargets(doc)` from `GEO_CONTROLS` sliders per layer plus the offset sliders, labelled by layer name ("Hexagon 2 · Count").
- Adapter: no extra kinds; gallery returns no preset groups (the gallery shows Custom only, with the In/Loop/Out toggle); availability always null.
- Surface: Design | Motion tabs (the Type Studio idiom) with `MovesPanel`; a play/scrub bar drives `renderPreview(applyMotion(doc, t))` on a rAF loop that runs only while playing and respects the occlusion contract.
- `lib/geoshape/frameSource.ts` (Vector Type pattern: own canvas, `duration 0` when there are no moves) registered by `ShapeStudioNode` alongside the still baker, so a wired Frame layer goes live; footer video export via `encodeFrames` (Gradient pattern).
- Cost note: single and pieces fill modes run paper.js booleans per frame; the blend's per-clone outline mode is pure drawing and animates freely.

## 5. Gradient and Shader — later consumers

`config.motion.tracks` → `motion.moves` through `convertLegacyTracks` at load; their surfaces swap the inline track rows for `MovesPanel` with a dials-only adapter. Not in this pass; listed so the shared core is built with them in mind (both have layer-relative paths like Shape Studio).

## 6. Sequencing

1. Shape Blend (stills) — `2026-09-03-shape-blend-design.md`
2. 3D Screen finish — `2026-09-03-scene3d-screen-finish-design.md`
3. Shared core + Vector Type adapter — revise `2026-09-03-vector-type-motion-moves.md` per §3, then run it
4. Shape Studio motion (consumer two) — new plan from §4
5. Gradient and Shader conversion

## 7. Testing

Shared: `studio-moves-phase`, `studio-moves-compose` (two tracks moves on different dials compose; same-dial refusal), `studio-moves-ease`, `studio-moves-play`, `studio-moves-merge` (legacy conversion parity against Gradient, Shader, and Vector Type fixture tracks: three frames before and after within 1e-9). Vector Type keeps its own suites for presets, blink, scatter, slots conversion, and gallery gating. Shape Studio adds `geoshape-motion` (id-addressed paths survive reorder; deleted layer prunes; frame source reports duration 0 without moves).

## 8. Out of scope

- 3D Studio's motion module and Compositor bands (their own systems; the ease type may be shared later).
- A draggable timeline, saving a tuned move as a preset, per-move stagger — all as in the Vector Type spec.
