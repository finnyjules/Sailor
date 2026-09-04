// frontend/app/lib/studio/moves/tracks.ts
/**
 * Flatten a clip's `'tracks'` moves into individual tracks, and apply them
 * to a config at a point in time. PURE, studio-neutral — NOTHING here may
 * import from lib/vectortype.
 *
 * `io.setByPath` vs `io.setByIdPath`: an id-addressed path
 * (`<list>.<id>.<rest>`, see `lib/studio/idPath.ts`) can only be told apart
 * from a plain dotted path by knowing which config lists are id-addressed —
 * information this module deliberately does not have (Vector Type's own
 * `applyMotion` decides with `isStackPath`, a check against its OWN
 * `appearance.` prefix). Per the brief: when this module cannot tell, it
 * writes with `setByPath`. A studio whose config has id-addressed lists
 * (Vector Type's `appearance` stack, Shape Studio's `layers`) is expected to
 * pass an `io` that already resolves those paths itself before falling back
 * to `setByIdPath`, or to post-process — see the open question called out in
 * the task report.
 */
import { easeSample } from './ease'
import type { MoveEase, MoveTrack, MotionClip } from './types'

export type TaggedMoveTrack = MoveTrack & { __ease: MoveEase; __at: number; __duration: number; __loop: boolean; __bounce?: boolean }

/** Flatten every `kind: 'tracks'` move's tracks, tagging each with its OWN move's ease/timing. */
export function moveTracks(clip: MotionClip | null | undefined): TaggedMoveTrack[] {
  const moves = clip?.moves
  if (!Array.isArray(moves)) return []
  const out: TaggedMoveTrack[] = []
  for (const m of moves) {
    if (m.kind !== 'tracks' || !Array.isArray(m.tracks)) continue
    for (const t of m.tracks) out.push({ ...t, __ease: m.ease, __at: m.at, __duration: m.duration, __loop: m.loop, __bounce: m.bounce })
  }
  return out
}

export interface MoveTrackIO {
  getByPath(cfg: unknown, path: string): unknown
  setByPath(cfg: unknown, path: string, value: unknown): void
  setByIdPath(cfg: unknown, path: string, value: unknown): boolean
}

/**
 * Raw (pre-ease) 0..1 progress of one tagged track at time `t`, computed
 * across the OWNING MOVE's own window (`__at`/`__duration`/`__loop`/
 * `__bounce`) the same way `./phase.ts`'s `movePhase` computes a move's own
 * progress, layered with the track's own `delay` (shifts the window start),
 * `cycleOffset` (shifts the raw phase before wrapping/clamping) and `hold`
 * (clips a symmetric dead-zone at both ends of one cycle). Unlike
 * `movePhase`, this never returns `null` — a track always has a value to
 * write, so it clamps to 0 before its window and to 1 past a transition's
 * end (a loop's window is capped to `clipDuration`, mirroring `movePhase`'s
 * `[at, clip]`).
 */
function trackRawProgress(track: TaggedMoveTrack, t: number, clipDuration: number): number {
  const tt = Math.min(t, Math.max(0.001, clipDuration))
  const start = track.__at + (track.delay || 0)
  const dur = Math.max(0.001, track.__duration)
  let cyc: number
  if (track.__loop) {
    if (tt < start) {
      cyc = 0
    } else {
      const raw = (tt - start) / dur + (track.cycleOffset || 0)
      cyc = ((raw % 1) + 1) % 1
    }
  } else {
    const raw = (tt - start) / dur + (track.cycleOffset || 0)
    cyc = Math.min(1, Math.max(0, raw))
  }
  const hold = Math.min(0.5, Math.max(0, track.hold || 0))
  if (hold > 0) {
    const active = 1 - 2 * hold
    cyc = active <= 0 ? 0 : Math.min(1, Math.max(0, (cyc - hold) / active))
  }
  if (track.__bounce) cyc = cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2
  return cyc
}

const isColorTrack = (t: MoveTrack): boolean => typeof t.fromColor === 'string' && typeof t.toColor === 'string'

/**
 * The EASED 0..1 progress of ONE tagged track at time `t` — everything
 * `trackValueAt` knows about timing, with nothing said about `from`/`to`.
 * Split out for a COLOUR track (Vector Type's `trackColor`), which mixes two
 * swatches at this progress rather than lerping a `from`/`to` pair — the same
 * split `~/lib/studio/track`'s `trackProgress`/`trackValue` make, for the
 * same reason (see that module's own doc comment).
 *
 * Honors the track's OWNING MOVE's `ease`/`at`/`duration`/`loop`/`bounce`
 * (the `__ease`/`__at`/`__duration`/`__loop`/`__bounce` tag `moveTracks`
 * attaches) and the track's own `delay`/`cycleOffset`/`hold`.
 */
export function trackProgressAt(track: TaggedMoveTrack, t: number, clipDuration: number): number {
  return easeSample(track.__ease, trackRawProgress(track, t, clipDuration))
}

/**
 * The value of ONE tagged track at time `t` within a clip of `clipDuration`
 * seconds — the exact arithmetic `applyMoveTracks` applies per track, exposed
 * directly for a caller that reads one leaf's animated value without writing
 * a whole cloned config (Vector Type's `vtEmSize`/`blink.ts`/`scatter.ts`,
 * which each read one or three `motion.*` leaves straight off the tagged
 * tracks, on their own hot per-glyph-per-frame paths where cloning the config
 * is the wrong price — same reasoning `applyMoveTracks`'s own doc comment
 * gives for why colour tracks are a studio's own problem).
 */
export function trackValueAt(track: TaggedMoveTrack, t: number, clipDuration: number): number {
  const eased = trackProgressAt(track, t, clipDuration)
  return track.from + (track.to - track.from) * eased
}

/**
 * Clone `cfg` and write every track's value at time `t`. Colour tracks
 * (both `fromColor` and `toColor` present) are OUT OF SCOPE here — passed
 * through unchanged; a studio with colour tracks (Vector Type) keeps its own
 * colour-mixing write in its own `motion.ts`.
 */
export function applyMoveTracks<Cfg>(cfg: Cfg, clip: MotionClip | null | undefined, t: number, io: MoveTrackIO): Cfg {
  const out = structuredClone(cfg)
  const tracks = moveTracks(clip)
  if (!tracks.length) return out
  for (const track of tracks) {
    if (isColorTrack(track)) continue
    const path = track.path.trim()
    if (!path) continue
    io.setByPath(out, path, trackValueAt(track, t, clip?.duration ?? 4))
  }
  return out
}

/** One config dial a `ControlSpec`-like array offers, from `animatableTargetsFromControls`. */
export interface AnimatableTarget {
  path: string
  label: string
  group: string
  min: number
  max: number
}

export interface AnimatableControlLike {
  key: string
  label: string
  group?: string
  min?: number
  max?: number
  /** `false` opts a control out; anything else (including absent) is animatable. */
  animatable?: boolean
}

/**
 * Build the Custom-tab dial list from a `ControlSpec`-like array, the way
 * Gradient's `animatableTargets` does today. Skips a control with no numeric
 * `min`/`max` (nothing to interpolate over) or `animatable === false`.
 * `expandLayerKey`, when given, turns one per-layer control key into one
 * target per layer (Gradient: `layer.<rest>` → one `layers.<i>.<rest>` per
 * `cfg.layers`); a control it does not recognise is emitted as-is.
 */
export function animatableTargetsFromControls(
  controls: readonly AnimatableControlLike[],
  cfg: unknown,
  expandLayerKey?: (key: string, cfg: unknown) => { path: string; label: string }[] | undefined,
): AnimatableTarget[] {
  const out: AnimatableTarget[] = []
  for (const c of controls) {
    if (c.animatable === false) continue
    if (typeof c.min !== 'number' || typeof c.max !== 'number' || !Number.isFinite(c.min) || !Number.isFinite(c.max)) continue
    const expanded = expandLayerKey?.(c.key, cfg)
    if (expanded && expanded.length) {
      for (const e of expanded) out.push({ path: e.path, label: e.label, group: c.group ?? '', min: c.min, max: c.max })
      continue
    }
    out.push({ path: c.key, label: c.label, group: c.group ?? '', min: c.min, max: c.max })
  }
  return out
}
