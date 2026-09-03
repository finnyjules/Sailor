// frontend/app/lib/studio/moves/adapter.ts
/**
 * TYPES ONLY — no logic lives here. The shared moves panel
 * (`components/vue-canvas/motion/moves/`, not yet built) is driven entirely
 * through a `MovesAdapter<Cfg>` a studio supplies; this module is the
 * contract between the two.
 *
 * Studio-agnostic by construction: NOTHING here may import from
 * lib/vectortype (or any other studio). A component reference is typed as
 * `import('vue').Component` rather than importing `vue` at module scope, so
 * this file costs nothing to import from a place that must not pull in the
 * Vue runtime (e.g. a headless bake).
 *
 * Spec: docs/superpowers/specs/2026-09-03-motion-moves-shared-core-design.md
 * §1 (the adapter interface) and §2 (gallery / animatable types, described
 * in prose there — the panel that consumes them is a later task).
 */
import type { Move } from './types'

type MovesComponent = import('vue').Component

/** One phase the gallery/band strip and a move's timing windows are keyed by. */
export type MovePhase = 'in' | 'loop' | 'out'

/**
 * One dial a Custom move can be pointed at: a config path, its label, the
 * section it groups under (an `AnimatableGroup.label`), and the range a
 * From/To pair or a timeline scrubber should offer.
 */
export interface DialDef {
  path: string
  label: string
  min: number
  max: number
}

/** A labelled section of dials in the Custom tab (e.g. "Axes", "Glyph", or a layer's name). */
export interface AnimatableGroup {
  label: string
  dials: DialDef[]
}

/**
 * One gallery tile: a move a studio is offering to add. `build` returns the
 * partial `Move` the gallery installs (minus `id`, which the panel mints);
 * `MovesAdapter.availability` is called with a candidate built this way to
 * decide whether the tile is enabled.
 */
export interface MoveOffer {
  id: string
  label: string
  /** One-line pitch shown on the tile. */
  pitch: string
  kind: string
  presetId?: string
  phase: MovePhase
  thumb?: MovesComponent
  build: () => Partial<Move>
}

/** A labelled row of tiles in one gallery tab (In / Loop / Out / Custom). */
export interface GalleryGroup {
  label: string
  offers: MoveOffer[]
}

/**
 * A move kind a studio adds beyond the universal `'tracks'` kind (Vector
 * Type: `preset`, `blink`, `scatter`). Supplies the card body and, when the
 * kind needs one, the evaluator that folds it into the rendered config —
 * `'tracks'` moves need no entry here since the shared `applyMoveTracks`
 * (`./tracks.ts`) already knows how to apply them.
 */
export interface MoveKindDef<Cfg> {
  label: string
  /** Renders the move's own dials inside its card. */
  cardBody?: MovesComponent
  /**
   * True for a kind with no ease/play of its own — Vector Type's Blink and
   * Scatter, which run continuously rather than playing once through a
   * phase window (design spec `2026-09-03-vector-type-motion-moves-design
   * .md`: "Blink and Scatter have no ease and no play. Their cards show
   * only their own dials."). `MoveCard.vue` hides the Ease and Play rows
   * when this is true; Length stays (a marker move still carries one, even
   * though it is cosmetic for these two kinds — see `movesAdapter.ts`'s
   * `derivedMoves` doc). Absent/false for every kind with real timing.
   */
  noTiming?: boolean
  /**
   * Applies this move at its own local progress (0..1, already phase- and
   * play-resolved by `movePhase`/`moveWindows` — see `./phase.ts`) to `cfg`,
   * returning the updated config. Absent for a marker-only kind whose
   * settings live and animate elsewhere (Vector Type's Blink/Scatter toggle
   * a leaf the seeded-effect evaluator already reads).
   */
  evaluate?: (cfg: Cfg, move: Move, localProgress: number) => Cfg
}

/**
 * What a studio supplies to drive the shared moves panel over its own
 * config type `Cfg`.
 */
export interface MovesAdapter<Cfg> {
  /** Extra move kinds beyond 'tracks': card body renderer + evaluator hook. Empty for Shape Studio. */
  kinds: Record<string, MoveKindDef<Cfg>>
  /** Gallery groups per phase (presets). Empty groups hide the phase's preset tabs, leaving Custom. */
  gallery(cfg: Cfg, phase: MovePhase): GalleryGroup[]
  /** Dials the Custom tab offers, grouped. */
  animatable(cfg: Cfg): AnimatableGroup[]
  /** null = available; a string is the one-line reason a tile is greyed. */
  availability(cfg: Cfg, candidate: Move): string | null
  /** Optional rows for the clip block (Vector Type: Letter by letter). */
  clipExtras?: MovesComponent
  /**
   * Synthetic marker moves the panel should show ALONGSIDE the stored ones
   * (`clip.moves`), for a studio whose effect lives outside the move list —
   * Vector Type's Blink and Scatter, which read `cfg.motion.blink`/
   * `cfg.motion.scatter` directly rather than being entries in
   * `clip.moves`. `MovesPanel` renders `[...clip.moves,
   * ...(adapter.derivedMoves?.(cfg) ?? [])]` as its card list, so a derived
   * move gets a real card — collapsed row, expanded settings, remove — like
   * any stored one.
   *
   * A derived move's `patch`/`remove` still flow up through the panel's
   * normal `patch-move`/`remove-move` events; this module has no way to
   * write them back (it cannot know `cfg`'s shape), so the SURFACE owns
   * translating them — e.g. a `remove-move` for Vector Type's `__blink`
   * marker becomes `cfg.motion.blink.amount = 0`, not an attempt to splice
   * a `clip.moves` entry that was never there.
   *
   * Optional and additive: an adapter that omits it (Shape Studio, and
   * every existing adapter/test as of this addition) is unaffected — the
   * panel treats a missing `derivedMoves` as "no derived moves".
   */
  derivedMoves?(cfg: Cfg): Move[]
}
