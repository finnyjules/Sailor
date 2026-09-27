// app/lib/sketch/cleanup/types.ts
// Clean up (pen stage 5): the shared vocabulary of the detectors, the staged
// solve and the pen's preview — strengths, tolerances (screen px at the zoom
// Clean up opened at, × the strength), fix kinds and their plain names, the
// candidate a detector proposes and the result the pen previews.
import type { EntityId, SketchDoc } from '../model'
import type { Vec2 } from '../geom'
import type { RuleSpec } from '../tangency'

export type CleanupStrength = 'gentle' | 'normal' | 'strong'
export const STRENGTH_FACTOR: Record<CleanupStrength, number> = { gentle: 0.5, normal: 1, strong: 1.75 }
export const STRENGTHS: CleanupStrength[] = ['gentle', 'normal', 'strong']

/** The spec's detector tolerances: screen px (× unitsPerPx), degrees and
 *  fractions — every one of them × the strength factor. */
export const TOL = {
  JOIN_PX: 6,
  JOIN_SHORT_FRAC: 0.25,   // a gap may be at most this share of the shorter piece
  ON_CURVE_PX: 5,
  KINK_DEG: 8,
  HV_DEG: 4,
  PAR_DEG: 4,
  CONC_PX: 6,
  CONC_FRAC: 0.04,
  LEN_FRAC: 0.04,
  LEN_PX: 4,
  RAD_FRAC: 0.05,
  RAD_PX: 3,
  GAP_FRAC: 0.06,
  MIRROR_PX: 6,
  ROUND_FRAC: 0.02,
} as const

/** Guards on an accepted fix — not scaled by the strength. */
export const GUARD = {
  MOVE_PX: 8,            // no point moves further than this…
  MOVE_FRAC: 0.1,        // …or this share of the smallest piece it belongs to, whichever is larger
  ARC_MIN_PX: 2,         // no arc ends shorter than this (length or radius); no line under it is looked at
  MAX_PIECES: 150,       // above this Clean up refuses (select a part)
  ROUND_MIN_UNIT_PX: 4,  // round sizes only when one drawing unit is at least this big on screen
  BUDGET_MS: 400,        // one run stops trying fixes after this long (keeps what it accepted)
} as const

export type FixKind =
  | 'join' | 'onCurve' | 'tangent'
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'
  | 'concentric' | 'mirror'
  | 'equalLength' | 'equalRadius' | 'evenSpacing'
  | 'round'

/** A kind's plain name — a collapsed badge reads "<name> ×<count>". */
export const FIX_KIND_NAME: Record<FixKind, string> = {
  join: 'Joined', onCurve: 'On curve', tangent: 'Tangent',
  horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Square',
  concentric: 'Same centre', mirror: 'Mirror pair',
  equalLength: 'Same length', equalRadius: 'Same radius', evenSpacing: 'Evenly spaced',
  round: 'Rounded',
}

/** "Parallel", "Parallel ×3": the count shows once a group is bigger than a pair. */
export function countLabel(name: string, n: number): string {
  return n > 2 ? `${name} ×${n}` : name
}

/** One proposed fix. Refs are the working drawing's ids at detection time. */
export interface Candidate {
  id: string                    // stable: kind + the point ids it ties
  kind: FixKind
  label: string
  score: number                 // higher first, within a pass
  anchor: EntityId[]            // the badge sits at the mean of these points
  /** points that become one, placed at `at` (unless one of them may not move) */
  merges?: { points: EntityId[]; at: Vec2 }
  rules?: RuleSpec[]
  /** adds guide pieces (construction points / lines) to the working drawing and
   *  returns the rules that use them; `guides` shares a guide between fixes */
  prepare?: (doc: SketchDoc, guides: Map<string, EntityId>) => RuleSpec[]
  /** a one-off size change: solved with a temporary rule that is then removed */
  nudge?: { refs: [EntityId, EntityId]; value: number } | { circle: EntityId; value: number }
}

export interface CleanupScope { entities: EntityId[]; segments: { pathId: EntityId; segIndex: number }[] }

export interface CleanupOptions {
  unitsPerPx: number            // drawing units per screen px, at the zoom Clean up opened at
  strength: CleanupStrength
  scope?: CleanupScope | null   // null: the whole drawing
  off?: ReadonlySet<string>     // fix ids switched off
  openOnly?: boolean            // a join may not close a path
  /** **Ruling (final review):** a run stops trying candidates once this many
   *  ms have passed (default `GUARD.BUDGET_MS`), keeps what it accepted and
   *  says `stopped`. A stop makes the answer depend on the machine's speed —
   *  the same switches can give a different answer on a slower run — so
   *  tests pass a huge budget, or a fake `now`. */
  budgetMs?: number
  /** the clock the budget reads (default `performance.now`) */
  now?: () => number
}

export interface CleanupFix { id: string; kind: FixKind; label: string; on: boolean; at: Vec2 }

export interface CleanupResult {
  doc: SketchDoc
  fixes: CleanupFix[]
  refused?: 'conflict' | 'tooBig'
  /** the time budget ran out: candidates after that point were not tried */
  stopped?: boolean
}
