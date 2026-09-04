// frontend/app/lib/studio/moves/merge.ts
/**
 * Merge raw (untrusted, possibly-saved) data into the shared Move/MotionClip
 * shape, and convert two OLDER shapes into the current `at`/`loop`/`bounce`
 * model (`./types.ts`) so an old document renders identically:
 *
 *  - a 2026-09-03 document's `phase`/`play` moves — this module's OWN prior
 *    output shape, from before Task 1 moved `Move` onto `at`/`loop`/`bounce`.
 *    Converted inline by `mergeMove` (see `resolvePlacement` below) so a
 *    caller never has to know which shape it loaded.
 *  - a pre-moves "legacy tracks" document (Gradient, Shader, old Vector
 *    Type) — `convertLegacyTracks`, ported from the Vector Type moves plan's
 *    `VtMove`-typed original (`docs/superpowers/plans/2026-09-03-vector-type-motion-moves.md`,
 *    "Write moves.ts" step) with the studio prefix dropped.
 *
 * PURE, studio-neutral. NOTHING here may import from lib/vectortype.
 */
import { mergeEase, mergePlay } from './ease'
import type { Move, MoveEase, MoveEaseName, MovePlay, MoveTrack, MotionClip } from './types'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clampDur = (v: number) => Math.max(0.05, Math.min(60, v))

function mergeParams(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isNum(v)) out[k] = v
  return Object.keys(out).length ? out : undefined
}

/**
 * Default per-track merge used when `mergeMove`/`mergeClip` are called
 * without a `mergeTrackFn` (a studio normally supplies its own so that a
 * stack path can be id-remapped at load — see `lib/vectortype/motion.ts`'s
 * `mergeTrack`). This one only validates shape.
 */
function defaultMergeTrack(raw: unknown): MoveTrack | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.path !== 'string' || !o.path.trim()) return undefined
  const hasColor = typeof o.fromColor === 'string' && typeof o.toColor === 'string'
  const hasNumeric = isNum(o.from) && isNum(o.to)
  if (!hasColor && !hasNumeric) return undefined
  const track: MoveTrack = { path: o.path, from: hasNumeric ? (o.from as number) : 0, to: hasNumeric ? (o.to as number) : 0 }
  if (isNum(o.hold)) track.hold = o.hold
  if (isNum(o.cycleOffset)) track.cycleOffset = o.cycleOffset
  if (isNum(o.delay)) track.delay = o.delay
  if (hasColor) { track.fromColor = o.fromColor as string; track.toColor = o.toColor as string }
  if (typeof o.mix === 'string') track.mix = o.mix
  return track
}

/**
 * Context threaded from `mergeClip` into every `mergeMove` call, so a
 * 2026-09-03 `phase: 'loop'` move can be placed at the document's
 * `longestIn` (see `resolvePlacement`) and a `phase: 'out'` move can be
 * placed against the clip's own duration. A caller that merges one move at a
 * time outside `mergeClip` (Vector Type's own preset-slot conversion in
 * `lib/vectortype/config.ts` does this) gets the defaults below: `longestIn:
 * 0` (a loop starts at the clip start, same as an 'in' would) and
 * `clipDuration` at the same default `mergeClip` itself falls back to when a
 * document has no `duration`.
 */
interface MergeMoveCtx {
  clipDuration: number
  longestIn: number
}
const DEFAULT_CLIP_DURATION = 4
const DEFAULT_CTX: MergeMoveCtx = { clipDuration: DEFAULT_CLIP_DURATION, longestIn: 0 }

/**
 * Place one raw move on the at-anchored timeline (`./types.ts`'s
 * `at`/`loop`/`bounce`). Two input shapes, told apart by whether `at` is a
 * finite number:
 *
 *  - **new** (`at` present) — `at` (clamped >= 0), `loop`, `bounce` are read
 *    straight off the raw object.
 *  - **2026-09-03** (`phase`/`play`, no `at`) — converted so an old document
 *    renders identically:
 *      - `phase: 'in'`   -> `at: 0`
 *      - `phase: 'out'`  -> `at: max(longestIn, clipDuration - duration)`,
 *        with `duration` COMPRESSED to `clipDuration - at`. The old engine
 *        started an out at `max(longestIn, clipDuration - duration)` and
 *        eased it over that compressed window, not over the raw `duration`
 *        — so when an out's raw duration would overlap the longest in, both
 *        the start and the eased span have to shift together, or the exit
 *        blends into the entrance at a moment the old engine never touched.
 *        (Flooring `at` at 0 alone reproduces only the non-overlapping case;
 *        see the regression test in `tests/unit/studio-moves-migrate.unit.spec.ts`.)
 *      - `phase: 'loop'` -> `at: longestIn` — the doc's longest entrance, so
 *        a loop starts exactly where the entrance(s) it followed finish,
 *        matching the old evaluator's implicit in-then-loop ordering.
 *    `loop` is `phase === 'loop'` OR'd with `play.mode === 'repeat'` — the
 *    pre-play-mode meaning of "phase loop" and the later explicit repeat
 *    flag are the same idea told two ways across the format's history, so
 *    either one sets it. `bounce` is `play.mode === 'backAndForth'`.
 */
function resolvePlacement(o: Record<string, unknown>, duration: number, ctx: MergeMoveCtx): { at: number; loop: boolean; bounce: boolean; duration: number } {
  if (isNum(o.at)) {
    return { at: Math.max(0, o.at), loop: o.loop === true, bounce: o.bounce === true, duration }
  }
  const phase: 'in' | 'out' | 'loop' = o.phase === 'in' || o.phase === 'out' ? o.phase : 'loop'
  const play: MovePlay = mergePlay(o.play)
  let at: number
  let placedDuration = duration
  if (phase === 'in') {
    at = 0
  } else if (phase === 'out') {
    at = Math.max(ctx.longestIn, ctx.clipDuration - duration)
    placedDuration = Math.max(0.001, ctx.clipDuration - at)
  } else {
    at = ctx.longestIn
  }
  const loop = phase === 'loop' || play.mode === 'repeat'
  const bounce = play.mode === 'backAndForth'
  return { at, loop, bounce, duration: placedDuration }
}

/**
 * Merge one raw move. Returns `undefined` for a move that cannot stand on
 * its own: a `'tracks'` move with no valid tracks, or a `'preset'`-kind move
 * (any `kind` other than the literal string `'tracks'`) with no `presetId`.
 *
 * `ctx` is normally supplied by `mergeClip` (see `MergeMoveCtx`); a direct
 * caller that omits it gets `{ clipDuration: 4, longestIn: 0 }`.
 */
export function mergeMove(raw: unknown, mergeTrackFn?: (t: unknown) => MoveTrack | undefined, ctx: MergeMoveCtx = DEFAULT_CTX): Move | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const kind: string = o.kind === 'tracks' ? 'tracks' : 'preset'
  const id = typeof o.id === 'string' && o.id ? o.id : `move-${Math.random().toString(36).slice(2, 9)}`
  const presetId = typeof o.presetId === 'string' && o.presetId.trim() ? o.presetId.trim() : undefined
  const rawDuration = clampDur(isNum(o.duration) ? o.duration : 1)
  const { at, loop, bounce, duration } = resolvePlacement(o, rawDuration, ctx)
  const base: Move = {
    id,
    kind,
    at,
    duration,
    loop,
    ease: mergeEase(o.ease),
    ...(bounce ? { bounce: true } : {}),
  }
  const mergeTrack = mergeTrackFn ?? defaultMergeTrack
  if (kind === 'tracks') {
    const rawTracks = Array.isArray(o.tracks) ? o.tracks : []
    const tracks: MoveTrack[] = []
    for (const t of rawTracks) { const tk = mergeTrack(t); if (tk) tracks.push(tk) }
    if (!tracks.length) return undefined
    return { ...base, presetId: presetId ?? 'custom', tracks }
  }
  if (!presetId) return undefined
  const params = mergeParams(o.params)
  return { ...base, presetId, ...(params ? { params } : {}) }
}

/**
 * Merge a raw clip: `{ moves, duration, fps }`, defaulted and clamped.
 *
 * Computes `longestIn` — the max `duration` among this doc's raw
 * `phase: 'in'` moves — ONCE, before merging any move, and threads it into
 * every `mergeMove` call as `ctx`, so every `phase: 'loop'` move in the SAME
 * document places itself against the same entrance rather than each
 * re-deriving (or disagreeing on) it.
 */
export function mergeClip(raw: unknown, mergeTrackFn?: (t: unknown) => MoveTrack | undefined): MotionClip {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const rawMoves = Array.isArray(o.moves) ? o.moves : []
  const duration = isNum(o.duration) ? Math.max(0.1, Math.min(60, o.duration)) : DEFAULT_CLIP_DURATION
  const fps = isNum(o.fps) ? Math.max(1, Math.min(60, Math.round(o.fps))) : 30

  let longestIn = 0
  for (const m of rawMoves) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const mo = m as Record<string, unknown>
    if (mo.phase === 'in') {
      const d = clampDur(isNum(mo.duration) ? mo.duration : 1)
      if (d > longestIn) longestIn = d
    }
  }
  const ctx: MergeMoveCtx = { clipDuration: duration, longestIn }

  const moves: Move[] = []
  for (const m of rawMoves) { const mv = mergeMove(m, mergeTrackFn, ctx); if (mv) moves.push(mv) }
  return { moves, duration, fps }
}

/** A legacy (pre-moves) track: the shared track fields plus the old per-track `easing`/`loops`. */
export interface LegacyMotionTrack {
  path: string
  from: number
  to: number
  hold?: number
  cycleOffset?: number
  delay?: number
  fromColor?: string
  toColor?: string
  mix?: string
  easing?: string
  loops?: number
}

/** Strip a legacy track down to the shared `MoveTrack` shape: `easing`/`loops` are dropped, since the owning Move's `loop`/`bounce` replace them. */
function stripLegacy(t: LegacyMotionTrack): MoveTrack {
  const track: MoveTrack = { path: t.path, from: t.from, to: t.to }
  if (isNum(t.hold)) track.hold = t.hold
  if (isNum(t.cycleOffset)) track.cycleOffset = t.cycleOffset
  if (isNum(t.delay)) track.delay = t.delay
  if (typeof t.fromColor === 'string') track.fromColor = t.fromColor
  if (typeof t.toColor === 'string') track.toColor = t.toColor
  if (typeof t.mix === 'string') track.mix = t.mix
  return track
}

/** `linear`/anything-but-`easeinout` -> none, `easeinout` -> natural. `pingpong` also gets none (its motion comes from `bounce`, not the ease curve). */
function legacyTrackEase(easing: unknown): MoveEase {
  const NONE: MoveEaseName = 'none'
  if (easing === 'easeinout') return { kind: 'named', name: 'natural' }
  return { kind: 'named', name: NONE }
}

/**
 * `pingpong` -> `loop: true, bounce: true` — a continuous ping-pong cycle is
 * the closest the new (count-less) `loop` boolean can get to the old
 * "backAndForth ×N" play mode; a finite repeat count has no home in the
 * `at`/`loop`/`bounce` shape, so this loses the exact count and keeps the
 * motion.
 *
 * Otherwise: the OLD evaluator WRAPPED (an N-cycle sawtooth across the clip)
 * once `loops > 1`, and CLAMPED (ran once, froze) at `loops <= 1` — the same
 * split `loop`/one-shot already draws, so a non-pingpong track becomes
 * `loop: true` when `loops > 1`, `loop: false` (a one-shot transition) when
 * `loops <= 1`.
 */
function legacyTrackPlacement(easing: unknown, loops: unknown): { loop: boolean; bounce: boolean } {
  if (easing === 'pingpong') return { loop: true, bounce: true }
  const times = isNum(loops) ? Math.max(1, Math.round(loops)) : 1
  return { loop: times > 1, bounce: false }
}

/**
 * Vector Type spec §7 step 2: if the legacy tracks match a known preset
 * (`matchPreset` returns its id), they collapse into ONE tracks move
 * starting at the clip start and looping forever (`at: 0, loop: true`) —
 * the exact timing that reproduces the old loop. Otherwise every track
 * becomes its own Custom move, each starting at `at: 0` with `loop`/`bounce`
 * mapped from its own `easing`/`loops` (see `legacyTrackPlacement`).
 *
 * Every converted move starts at `at: 0`: there is no safe way to tell an
 * entrance from a loop in old (pre-moves) data, so — same as the old
 * `phase: 'loop'` default this replaces — everything starts at the clip
 * start.
 *
 * `clipDuration` is the converted move's `duration` — i.e. its cycle length.
 * A pre-moves loop ran ONE cycle over the whole clip (there was no per-track
 * cycle count separate from the clip length), so reproducing that old
 * behaviour means the converted move's cycle must equal the CLIP's duration,
 * not a hardcoded guess. Getting this wrong is a real parity bug: a move
 * whose `duration` disagrees with the clip's plays the old loop at the wrong
 * speed (Task 3 review carry-forward).
 */
export function convertLegacyTracks(
  tracks: readonly LegacyMotionTrack[],
  matchPreset: (tracks: readonly MoveTrack[]) => string | null,
  clipDuration: number,
): Move[] {
  if (!tracks.length) return []
  const duration = clampDur(isNum(clipDuration) ? clipDuration : 4)
  const merged = tracks.map(stripLegacy)
  const presetId = matchPreset(merged)
  if (presetId) {
    return [{
      id: 'move-track-preset',
      kind: 'tracks',
      presetId,
      at: 0,
      duration,
      loop: true,
      ease: { kind: 'named', name: 'none' },
      tracks: merged,
    }]
  }
  return tracks.map((raw, i) => {
    const { loop, bounce } = legacyTrackPlacement(raw.easing, raw.loops)
    return {
      id: `move-${i + 1}`,
      kind: 'tracks',
      presetId: 'custom',
      at: 0,
      duration,
      loop,
      ease: legacyTrackEase(raw.easing),
      ...(bounce ? { bounce: true } : {}),
      tracks: [merged[i]!],
    }
  })
}
