// The previewing gallery catalog (Slice 4). Data-only: each move maps to a registered
// behaviour kind + params, a group, a small live-preview key, and an optional layer
// capability it needs. The gallery component renders these; clicking one calls
// addBehaviour(kind, params). Pure — zero Vue/compositor coupling.
import { SETTLE_EFFECTS } from './reveal/settle'

export type MoveGroup = 'Letters' | 'In' | 'Loop' | 'Out' | 'Gradient'
export type PreviewKind =
  | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right'
  | 'grow' | 'shrink' | 'spin' | 'pulse' | 'sway' | 'float'
  | 'scroll' | 'morph' | 'dither' | 'assemble' | 'settle'
  | 'letters-cascade' | 'letters-typewriter' | 'letters-mask' | 'letters-scramble'
  | 'letters-decode' | 'letters-slot' | 'letters-wave' | 'letters-bounce' | 'letters-jitter'

export interface GalleryMove {
  id: string
  kind: string                       // a registered behaviour kind
  label: string                      // sentence case
  group: MoveGroup
  preview: PreviewKind
  params?: Record<string, unknown>
  needs?: 'gradient' | 'text'        // layer capability required to offer this move
  /** A composite move: adds SEVERAL single-property behaviours at once (e.g. Slide up =
   *  position + fade). Each part lands in its own property row. Omit for a single kind. */
  recipe?: Array<{ kind: string; params?: Record<string, unknown> }>
  /** Loop moves: the length (seconds) of ONE cycle. The bar is a cycle; it repeats to the end. */
  cycle?: number
}

/** Default length (seconds) a new behaviour of this group gets when placed at the playhead.
 *  In / out are short one-shots; a loop's bar is ONE cycle, which then repeats to the end. */
export function defaultDurationFor(group: MoveGroup): number {
  if (group === 'Letters') return 1.2
  return group === 'Loop' || group === 'Gradient' ? 2 : 0.8
}
export function defaultDurationForMove(m: GalleryMove): number {
  return m.cycle ?? defaultDurationFor(m.group)
}

/** The behaviours a gallery tile adds — its recipe, or its single kind. */
export function behavioursForMove(m: GalleryMove): Array<{ kind: string; params?: Record<string, unknown> }> {
  return m.recipe ?? [{ kind: m.kind, params: m.params }]
}

/** Layer capabilities the gallery filters against. */
export interface LayerCaps { gradient: boolean; text: boolean }

// ── Settle tiles (Addendum 3, Part 4): EACH of the ten `SETTLE_EFFECTS` rows is its OWN pair
// of gallery tiles (In / Out) — Julien's explicit call, no single "Settle" tile with a menu.
// GENERATED from the table so this list can never drift from it; the inspector still offers an
// Effect menu to swap one in place (`settle-effect`, see MotionInspector.vue).
/** Amendment (2026-09-21): a smooth curve defeats a staccato effect — Slice, Glitch and
 *  Pixelate ship with a stepped default instead of the kind's usual Linear. UI-only data: it
 *  belongs to the gallery tile, not to `SETTLE_EFFECTS` (another task owns that table), and the
 *  inspector's Effect swap must never touch a bar's own `ease` once it exists. */
const STEPPED_SETTLE_IDS = new Set(['slice', 'glitch', 'pixelate'])
const STEPPED_SETTLE_EASE = { type: 'steps', count: 6 } as const

function settleTile(effect: { id: string; label: string }, dir: 'in' | 'out'): GalleryMove {
  const params: Record<string, unknown> = { dir, effect: effect.id }
  if (STEPPED_SETTLE_IDS.has(effect.id)) params.ease = STEPPED_SETTLE_EASE
  return {
    id: `settle-${effect.id}-${dir}`,
    kind: 'settle',
    label: `${effect.label} ${dir}`,
    group: dir === 'in' ? 'In' : 'Out',
    preview: 'settle',
    params,
  }
}
const SETTLE_IN_TILES: GalleryMove[] = SETTLE_EFFECTS.map((e) => settleTile(e, 'in'))
const SETTLE_OUT_TILES: GalleryMove[] = SETTLE_EFFECTS.map((e) => settleTile(e, 'out'))

export const GALLERY_MOVES: GalleryMove[] = [
  // Letters — text-only, evaluated per-letter at draw time (no compiled tracks)
  { id: 'letters-cascade-in', kind: 'text.cascade', label: 'Cascade in', group: 'Letters', preview: 'letters-cascade', needs: 'text', params: { dir: 'in', style: 'rise' } },
  { id: 'letters-cascade-out', kind: 'text.cascade', label: 'Cascade out', group: 'Letters', preview: 'letters-cascade', needs: 'text', params: { dir: 'out', style: 'rise' } },
  { id: 'letters-typewriter', kind: 'text.typewriter', label: 'Typewriter', group: 'Letters', preview: 'letters-typewriter', needs: 'text', params: { dir: 'type' } },
  { id: 'letters-mask', kind: 'text.maskSlide', label: 'Mask slide', group: 'Letters', preview: 'letters-mask', needs: 'text', params: { dir: 'reveal', from: 'up' } },
  { id: 'letters-scramble', kind: 'text.scramble', label: 'Scramble', group: 'Letters', preview: 'letters-scramble', needs: 'text', params: { mode: 'settle' }, cycle: 2 },
  { id: 'letters-decode', kind: 'text.decode', label: 'Decode', group: 'Letters', preview: 'letters-decode', needs: 'text', params: { dir: 'resolve' }, cycle: 1.5 },
  { id: 'letters-slot', kind: 'text.slot', label: 'Slot slide', group: 'Letters', preview: 'letters-slot', needs: 'text', params: { dir: 'in', roll: 'up' }, cycle: 1.6 },
  { id: 'letters-wave', kind: 'text.wave', label: 'Wave', group: 'Letters', preview: 'letters-wave', needs: 'text', cycle: 3 },
  { id: 'letters-bounce', kind: 'text.bounce', label: 'Bounce', group: 'Letters', preview: 'letters-bounce', needs: 'text', cycle: 3 },
  { id: 'letters-jitter', kind: 'text.jitter', label: 'Jitter', group: 'Letters', preview: 'letters-jitter', needs: 'text', cycle: 3 },
  // In
  { id: 'fade-in', kind: 'fade', label: 'Fade in', group: 'In', preview: 'fade', params: { dir: 'in' } },
  { id: 'scale-in', kind: 'scale', label: 'Grow in', group: 'In', preview: 'grow', params: { dir: 'in' },
    recipe: [{ kind: 'scale', params: { dir: 'in' } }, { kind: 'fade', params: { dir: 'in' } }] },
  { id: 'slide-up', kind: 'slide', label: 'Slide up', group: 'In', preview: 'slide-up', params: { dir: 'up' },
    recipe: [{ kind: 'slide', params: { dir: 'up' } }, { kind: 'fade', params: { dir: 'in' } }] },
  { id: 'slide-down', kind: 'slide', label: 'Slide down', group: 'In', preview: 'slide-down', params: { dir: 'down' },
    recipe: [{ kind: 'slide', params: { dir: 'down' } }, { kind: 'fade', params: { dir: 'in' } }] },
  { id: 'slide-left', kind: 'slide', label: 'Slide left', group: 'In', preview: 'slide-left', params: { dir: 'left' },
    recipe: [{ kind: 'slide', params: { dir: 'left' } }, { kind: 'fade', params: { dir: 'in' } }] },
  { id: 'slide-right', kind: 'slide', label: 'Slide right', group: 'In', preview: 'slide-right', params: { dir: 'right' },
    recipe: [{ kind: 'slide', params: { dir: 'right' } }, { kind: 'fade', params: { dir: 'in' } }] },
  { id: 'dither-in', kind: 'dither', label: 'Dither in', group: 'In', preview: 'dither', params: { dir: 'in' } },
  { id: 'assemble-in', kind: 'dither', label: 'Assemble in', group: 'In', preview: 'assemble', params: { dir: 'in', style: 'assemble' } },
  ...SETTLE_IN_TILES,
  // Loop
  { id: 'spin', kind: 'spin', label: 'Spin', group: 'Loop', preview: 'spin', cycle: 2 },
  { id: 'pulse', kind: 'pulse', label: 'Pulse', group: 'Loop', preview: 'pulse', cycle: 1.2 },
  { id: 'sway', kind: 'sway', label: 'Sway', group: 'Loop', preview: 'sway', cycle: 2 },
  { id: 'float', kind: 'float', label: 'Float', group: 'Loop', preview: 'float', cycle: 2.4 },
  // Out
  { id: 'fade-out', kind: 'fade', label: 'Fade out', group: 'Out', preview: 'fade', params: { dir: 'out' } },
  { id: 'scale-out', kind: 'scale', label: 'Shrink out', group: 'Out', preview: 'shrink', params: { dir: 'out' },
    recipe: [{ kind: 'scale', params: { dir: 'out' } }, { kind: 'fade', params: { dir: 'out' } }] },
  { id: 'dither-out', kind: 'dither', label: 'Dither out', group: 'Out', preview: 'dither', params: { dir: 'out' } },
  { id: 'assemble-out', kind: 'dither', label: 'Assemble out', group: 'Out', preview: 'assemble', params: { dir: 'out', style: 'assemble' } },
  ...SETTLE_OUT_TILES,
  // Gradient
  { id: 'gradient-scroll', kind: 'gradientScroll', label: 'Scroll', group: 'Gradient', preview: 'scroll', needs: 'gradient', cycle: 3 },
]

const GROUP_ORDER: MoveGroup[] = ['Letters', 'In', 'Loop', 'Out', 'Gradient']

/** Filter the catalog to what a layer supports (gradient moves need a gradient fill;
 *  text-only moves need a text layer). Transform/opacity moves are always offered. */
export function movesForLayer(caps: LayerCaps): GalleryMove[] {
  return GALLERY_MOVES.filter((m) => {
    if (m.needs === 'gradient') return caps.gradient
    if (m.needs === 'text') return caps.text
    return true
  })
}

/** Bucket moves into groups in canonical order, dropping empty groups. */
export function groupedMoves(moves: GalleryMove[]): Array<{ group: MoveGroup; moves: GalleryMove[] }> {
  return GROUP_ORDER
    .map((group) => ({ group, moves: moves.filter((m) => m.group === group) }))
    .filter((g) => g.moves.length > 0)
}

// ── Swapping a Letters bar for another move, in place ─────────────────────────
/** The params EVERY Letters move reads (the inspector's Text block, the curve, the hide
 *  switch). They survive a swap; everything else belonged to the old move and is dropped —
 *  a Slot's `dir: 'in'` must not become a Mask slide's direction. */
const SHARED_LETTER_PARAMS = ['by', 'stagger', 'order', 'seed', 'ease', 'hideBefore'] as const

export function letterMoves(): GalleryMove[] {
  return GALLERY_MOVES.filter((m) => m.group === 'Letters')
}

/** The gallery move a stored Letters bar reads as. Two moves can share a kind (Cascade in /
 *  Cascade out), told apart by `dir`; with no match on `dir` the kind's first move stands. */
export function letterMoveOf(b: { kind: string; params?: Record<string, unknown> }): GalleryMove | undefined {
  const same = letterMoves().filter((m) => m.kind === b.kind)
  return same.find((m) => m.params?.dir !== undefined && m.params.dir === b.params?.dir) ?? same[0]
}

/** The `kind` + the WHOLE new params for turning `b` into `move`. */
export function swapLetterMove(
  b: { kind: string; params?: Record<string, unknown> }, move: GalleryMove,
): { kind: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { ...(move.params ?? {}) }
  for (const k of SHARED_LETTER_PARAMS) if (b.params?.[k] !== undefined) params[k] = b.params[k]
  return { kind: move.kind, params }
}
