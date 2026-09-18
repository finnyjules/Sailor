// Pure track editors for the Frame band timeline (Slice 2). Every function returns a
// NEW track/array and never mutates its input — the component emits the result up to
// CompositorModal, which persists it via setMotion({ motionx }). Zero Vue coupling.
import type { Track, Keyframe, PropertyValue, PropertyType, Ease } from '~/lib/motionx'
import { evaluateTrack } from '~/lib/motionx'

const clone = (k: Keyframe): Keyframe => ({ t: k.t, value: k.value, ease: k.ease })
const sortByT = (kfs: Keyframe[]): Keyframe[] => [...kfs].sort((a, b) => a.t - b.t)
const span = (kfs: Keyframe[]) => {
  const ts = kfs.map((k) => k.t)
  return { start: ts.length ? Math.min(...ts) : 0, end: ts.length ? Math.max(...ts) : 0 }
}

/** Move every keyframe by deltaT, clamped so the earliest keyframe t stays >= 0. */
export function shiftTrack(track: Track, deltaT: number): Track {
  const { start } = span(track.keyframes)
  const d = Math.max(deltaT, -start)
  return { ...track, keyframes: track.keyframes.map((k) => ({ ...clone(k), t: k.t + d })) }
}

/** Linearly remap the track's span to [newStart,newEnd]. Single/coincident keyframes → all
 *  moved to newStart. Degenerate newEnd<=newStart → unchanged. */
export function retimeTrack(track: Track, newStart: number, newEnd: number): Track {
  if (!(newEnd > newStart) || !isFinite(newStart) || !isFinite(newEnd)) return track
  const s = Math.max(0, newStart)
  const { start, end } = span(track.keyframes)
  const old = end - start
  if (old < 1e-9) return { ...track, keyframes: track.keyframes.map((k) => ({ ...clone(k), t: s })) }
  const scale = (Math.max(0, newEnd) - s) / old
  return { ...track, keyframes: track.keyframes.map((k) => ({ ...clone(k), t: s + (k.t - start) * scale })) }
}

/** Insert a keyframe at t (value = given, else the interpolated value there; ease from the
 *  preceding keyframe or 'easeInOut'). Returns {track, index} of the inserted point. */
export function addPoint(track: Track, t: number, value?: PropertyValue): { track: Track; index: number } {
  const at = Math.max(0, t)
  const v = value !== undefined ? value : (evaluateTrack(track, at) ?? track.keyframes[0]?.value ?? 0)
  const prior = [...track.keyframes].filter((k) => k.t <= at).sort((a, b) => a.t - b.t).pop()
  const kf: Keyframe = { t: at, value: v, ease: prior?.ease ?? 'easeInOut' }
  const next = sortByT([...track.keyframes.map(clone), kf])
  const index = next.indexOf(kf)
  return { track: { ...track, keyframes: next }, index }
}

/** Change keyframe[index].t to newT (clamped >= 0); re-sorts; returns {track, index} with the
 *  point's new index. */
export function movePoint(track: Track, index: number, newT: number): { track: Track; index: number } {
  const cur = track.keyframes[index]
  if (!cur) return { track, index }
  const moved: Keyframe = { ...clone(cur), t: Math.max(0, newT) }
  const rest = track.keyframes.filter((_, i) => i !== index).map(clone)
  const next = sortByT([...rest, moved])
  return { track: { ...track, keyframes: next }, index: next.indexOf(moved) }
}

/** Replace keyframe[index].value. */
export function setPointValue(track: Track, index: number, value: PropertyValue): Track {
  return { ...track, keyframes: track.keyframes.map((k, i) => (i === index ? { ...clone(k), value } : clone(k))) }
}

/** Replace keyframe[index].ease. */
export function setPointEase(track: Track, index: number, ease: Ease): Track {
  return { ...track, keyframes: track.keyframes.map((k, i) => (i === index ? { ...clone(k), ease } : clone(k))) }
}

/** Remove keyframe[index]. May leave zero keyframes — the caller drops the track then. */
export function removePoint(track: Track, index: number): Track {
  return { ...track, keyframes: track.keyframes.filter((_, i) => i !== index).map(clone) }
}

/** Replace (next Track) / remove (next null) / append (path absent, next given) the track at
 *  `path` within `tracks`. */
export function setBandTrack(tracks: Track[], path: string, next: Track | null): Track[] {
  const idx = tracks.findIndex((t) => t.path === path)
  if (idx === -1) return next ? [...tracks, next] : [...tracks]
  if (next === null) return tracks.filter((_, i) => i !== idx)
  return tracks.map((t, i) => (i === idx ? next : t))
}

/** Seed a property band as a FLAT HOLD: two keyframes at [0, duration], both the property's
 *  current value. Visible and retimeable immediately, a no-op until a point is changed.
 *  Untagged (a plain property band, not behaviour-owned). */
export function seedHoldTrack(path: string, type: PropertyType, value: PropertyValue, duration: number): Track {
  const end = Math.max(0.05, duration)
  return { path, type, keyframes: [{ t: 0, value, ease: 'easeInOut' }, { t: end, value, ease: 'linear' }] }
}
