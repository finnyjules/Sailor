// frontend/app/lib/studio/moves/merge.ts
/**
 * Merge raw (untrusted, possibly-saved) data into the shared Move/MotionClip
 * shape, and convert pre-moves "legacy tracks" documents (Gradient, Shader,
 * old Vector Type) into a `Move[]`.
 *
 * Ported from the Vector Type moves plan's `VtMove`-typed `mergeMove`
 * (`docs/superpowers/plans/2026-09-03-vector-type-motion-moves.md`, "Write
 * moves.ts" step) with the studio prefix dropped: `kind` here is a plain
 * string, defaulted the same way (`'tracks'` when `o.kind === 'tracks'`,
 * else `'preset'`), with no Vector-Type-specific narrowing.
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
 * Merge one raw move. Returns `undefined` for a move that cannot stand on
 * its own: a `'tracks'` move with no valid tracks, or a `'preset'`-kind move
 * (any `kind` other than the literal string `'tracks'`) with no `presetId`.
 */
export function mergeMove(raw: unknown, mergeTrackFn?: (t: unknown) => MoveTrack | undefined): Move | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const kind: string = o.kind === 'tracks' ? 'tracks' : 'preset'
  const phase: Move['phase'] = o.phase === 'in' || o.phase === 'out' || o.phase === 'loop' ? o.phase : 'loop'
  const id = typeof o.id === 'string' && o.id ? o.id : `move-${Math.random().toString(36).slice(2, 9)}`
  const presetId = typeof o.presetId === 'string' && o.presetId.trim() ? o.presetId.trim() : undefined
  const base: Move = {
    id,
    phase,
    kind,
    duration: clampDur(isNum(o.duration) ? o.duration : 1),
    ease: mergeEase(o.ease),
    play: mergePlay(o.play),
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

/** Merge a raw clip: `{ moves, duration, fps }`, defaulted and clamped. */
export function mergeClip(raw: unknown, mergeTrackFn?: (t: unknown) => MoveTrack | undefined): MotionClip {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const rawMoves = Array.isArray(o.moves) ? o.moves : []
  const moves: Move[] = []
  for (const m of rawMoves) { const mv = mergeMove(m, mergeTrackFn); if (mv) moves.push(mv) }
  const duration = isNum(o.duration) ? Math.max(0.1, Math.min(60, o.duration)) : 4
  const fps = isNum(o.fps) ? Math.max(1, Math.min(60, Math.round(o.fps))) : 30
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

/** Strip a legacy track down to the shared `MoveTrack` shape: `easing`/`loops` are dropped, since the owning Move's `ease`/`play` replace them. */
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

/** `linear` → none/once, `easeinout` → natural/once, `pingpong` → none/backAndForth; `loops` → `play.times` (default 1). */
function legacyTrackEasePlay(easing: unknown, loops: unknown): { ease: MoveEase; play: MovePlay } {
  const times = isNum(loops) ? Math.max(1, Math.round(loops)) : 1
  const NONE: MoveEaseName = 'none'
  if (easing === 'pingpong') return { ease: { kind: 'named', name: NONE }, play: { mode: 'backAndForth', times } }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, play: { mode: 'once', times } }
  return { ease: { kind: 'named', name: NONE }, play: { mode: 'once', times } }
}

/**
 * Vector Type spec §7 step 2: if the legacy tracks match a known preset
 * (`matchPreset` returns its id), they collapse into ONE tracks move with
 * that preset id, `phase: 'loop'`, ease none, play repeat ×1 — the exact
 * timing that reproduces the old loop. Otherwise every track becomes its
 * own Custom move, with ease/play mapped from its own `easing`/`loops`.
 *
 * Phase is always `'loop'`: there is no safe way to tell an entrance from a
 * loop in old data.
 */
export function convertLegacyTracks(
  tracks: readonly LegacyMotionTrack[],
  matchPreset: (tracks: readonly MoveTrack[]) => string | null,
): Move[] {
  if (!tracks.length) return []
  const merged = tracks.map(stripLegacy)
  const presetId = matchPreset(merged)
  if (presetId) {
    return [{
      id: 'move-track-preset',
      phase: 'loop',
      kind: 'tracks',
      presetId,
      duration: 4,
      ease: { kind: 'named', name: 'none' },
      play: { mode: 'repeat', times: 1 },
      tracks: merged,
    }]
  }
  return tracks.map((raw, i) => {
    const { ease, play } = legacyTrackEasePlay(raw.easing, raw.loops)
    return {
      id: `move-${i + 1}`,
      phase: 'loop',
      kind: 'tracks',
      presetId: 'custom',
      duration: 4,
      ease,
      play,
      tracks: [merged[i]!],
    }
  })
}
