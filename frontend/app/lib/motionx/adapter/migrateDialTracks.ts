// One-way conversion of the legacy effect-dial tracks (`sailor_motion.tracks`, F8) into motionx
// bands. Paths are already motionx paths and the interpolation is identical (see the parity
// spec), so a converted frame renders the same. Pure; lives in adapter/ because it knows the
// Frame's legacy shape — the motionx core stays compositor-free.
import { isGradientValue, type DialKeyframe, type EffectDialTrack } from '~/lib/motion/effectTracks'
import type { Keyframe, PropertyType, Track } from '../types'

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function typeOf(kfs: DialKeyframe[]): PropertyType | null {
  if (!kfs.length) return null
  if (kfs.every((k) => typeof k.v === 'number' && Number.isFinite(k.v))) return 'number'
  if (kfs.every((k) => typeof k.v === 'string' && HEX_RE.test(k.v))) return 'color'
  if (kfs.every((k) => isGradientValue(k.v))) return 'gradient'
  return null   // mixed types / non-hex strings STEP in the legacy evaluator — not expressible
}

export function dialTrackToMotionx(tr: EffectDialTrack): Track | null {
  const type = typeOf(tr?.keyframes ?? [])
  if (!type || typeof tr.target !== 'string' || !tr.target) return null
  const keyframes: Keyframe[] = [...tr.keyframes]
    .sort((a, b) => a.t - b.t)
    .map((k) => ({
      t: k.t,
      value: k.v as Keyframe['value'],
      // Mirror the old evaluator: only 'linear' maps to linear, everything else (missing or stray) → easeInOut
      ease: k.ease === 'linear' ? 'linear' : 'easeInOut',
    }))
  const out: Track = { path: tr.target, type, keyframes }
  if (type === 'gradient') {
    if (tr.mode) out.mode = tr.mode
    if (tr.blendSpace) out.space = tr.blendSpace
  } else if (type === 'color') {
    out.space = tr.space ?? 'oklch'
  }
  return out
}

export interface MotionLike { tracks?: EffectDialTrack[]; motionx?: Track[] }

export function migrateDialTracks<M extends MotionLike>(motion: M): { motion: M; converted: number; dropped: number } {
  const legacy = motion?.tracks
  if (!legacy || !legacy.length) return { motion, converted: 0, dropped: 0 }
  const existing = motion.motionx ?? []
  const taken = new Set(existing.map((t) => t.path))

  // Build a map of the LITERAL LAST legacy track for each target (convertible or not): the old
  // fold (applyEffectDialTracks) lets the later track win when there are duplicates, REGARDLESS
  // of whether it is convertible — an unconvertible track still STEPs and still renders, so it
  // is the one that was actually visible, not whichever earlier duplicate happens to convert.
  const lastIndexByTarget = new Map<string, number>()
  for (let i = 0; i < legacy.length; i++) {
    const tr = legacy[i]
    if (!tr || taken.has(tr.target)) continue
    lastIndexByTarget.set(tr.target, i)
  }

  const added: Track[] = [], left: EffectDialTrack[] = []
  let dropped = 0
  for (let i = 0; i < legacy.length; i++) {
    const tr = legacy[i]
    if (!tr) continue
    // motionx folded AFTER dial tracks, so a band on the same path already hid this track.
    if (taken.has(tr.target)) { dropped++; continue }
    if (lastIndexByTarget.get(tr.target) !== i) {
      // An earlier duplicate on the same target: the old fold let the literal last one win, so
      // this one never rendered — drop it, whether or not it would have converted.
      dropped++
      continue
    }
    // The literal last legacy track for this target.
    const conv = dialTrackToMotionx(tr)
    if (conv) {
      added.push(conv)
      // No further legacy track can still target `tr.target` (it was the last), so this can't
      // collide with a later iteration's `taken` check — kept for symmetry with `existing`.
      taken.add(conv.path)
    } else {
      // Doesn't convert: it must stay live in `tracks` — creating a band here would let motionx
      // (which folds AFTER dial tracks) override the one legacy track that actually renders.
      left.push(tr)
    }
  }
  if (!added.length && !dropped) return { motion, converted: 0, dropped: 0 }
  const next = { ...motion, motionx: [...existing, ...added] } as M
  if (left.length) next.tracks = left
  else delete next.tracks
  return { motion: next, converted: added.length, dropped }
}
