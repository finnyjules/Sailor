import type { Behaviour, BehaviourTarget, Track, Timing, Ease } from './types'
import type { GradientStop } from '~/lib/color/harmony'

type Compiler = (b: Behaviour, target: BehaviourTarget) => Track[]
const REGISTRY = new Map<string, Compiler>()
export function registerBehaviour(kind: string, fn: Compiler): void { REGISTRY.set(kind, fn) }
export function compileBehaviour(b: Behaviour, target: BehaviourTarget): Track[] {
  const tracks = REGISTRY.get(b.kind)?.(b, target) ?? []
  // `params.ease` (a named ease or bézier handles, set from the curve editor) overrides the
  // kind's default on every segment. The last keyframe eases nothing, so it is left alone.
  const ease = asEase(b.params?.ease)
  if (!ease) return tracks
  return tracks.map((tr) => ({
    ...tr, keyframes: tr.keyframes.map((k, i) => (i < tr.keyframes.length - 1 ? { ...k, ease } : k)),
  }))
}
function asEase(v: unknown): Ease | null {
  if (v === 'linear' || v === 'easeIn' || v === 'easeOut' || v === 'easeInOut') return v
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: unknown }).type === 'spring'
    && Number.isFinite((v as { bounce?: unknown }).bounce)) return v as Ease
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (v as Ease) : null
}

function window(timing: Timing): [number, number] {
  const start = timing.start + (timing.delay ?? 0)
  return [start, start + Math.max(1e-4, timing.duration)]
}
function numTrack(path: string, a: number, b: number, [t0, t1]: [number, number], ease: Ease = 'easeInOut'): Track {
  return { path, type: 'number', keyframes: [{ t: t0, value: a, ease }, { t: t1, value: b, ease: 'linear' }] }
}
/** A looping number track from evenly-spaced values across the window (there-and-back
 *  oscillations, or a linear ramp). `loop:true` so evaluateTrack wraps t into the span. */
function loopTrack(path: string, values: number[], [t0, t1]: [number, number], ease: Ease = 'easeInOut'): Track {
  const n = Math.max(2, values.length)
  const keyframes = values.map((value, i) => ({ t: t0 + ((t1 - t0) * i) / (n - 1), value, ease }))
  return { path, type: 'number', keyframes, loop: true }
}
const numOr = (v: unknown, d: number) => (typeof v === 'number' ? v : d)

// ONE BEHAVIOUR = ONE PROPERTY. Every compiler below emits exactly one track, so a
// behaviour bar always sits in a single property row and a clash is always visible
// as two bars in the same row. Composite moves (slide + fade) are gallery RECIPES
// that add several single-property behaviours.
registerBehaviour('fade', (b, target) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  const cur = numOr(target.get('opacity'), 1)   // fade to/from the layer's CURRENT opacity
  return [dir === 'out' ? numTrack('opacity', cur, 0, w) : numTrack('opacity', 0, cur, w)]
})

registerBehaviour('slide', (b, target) => {
  // Relative to the layer's CURRENT position (x/y are normalized 0..1), so the layer
  // slides IN to where it already sits — not to an absolute 0. `distance` is a fraction
  // of the frame (default 0.15). up/left enter from the +offset side; down/right from -.
  const dir = (b.params?.dir as string) ?? 'up'
  const dist = numOr(b.params?.distance, 0.15)
  const w = window(b.timing)
  const axis = dir === 'left' || dir === 'right' ? 'x' : 'y'
  const cur = numOr(target.get(axis), 0.5)
  const off = dir === 'up' || dir === 'left' ? dist : -dist
  return [numTrack(axis, cur + off, cur, w)]
})

// Whole-layer transform behaviours (Slice 5). Scale/rotation/opacity are unambiguous;
// they read the layer's current value via the target so they compose with its pose.
registerBehaviour('scale', (b, target) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  const cur = numOr(target.get('scale'), 1)
  return [dir === 'out' ? numTrack('scale', cur, 0, w) : numTrack('scale', 0, cur, w)]
})

registerBehaviour('spin', (b, target) => {
  const w = window(b.timing)
  const cur = numOr(target.get('rotation'), 0)
  const turns = numOr(b.params?.turns, 1)
  return [{ ...numTrack('rotation', cur, cur + 360 * turns, w, 'linear'), loop: b.timing.loop ?? true }]
})

registerBehaviour('pulse', (b, target) => {
  const w = window(b.timing)
  const cur = numOr(target.get('scale'), 1)
  const amt = numOr(b.params?.amount, 0.12)
  return [loopTrack('scale', [cur, cur * (1 + amt), cur], w)]
})

registerBehaviour('sway', (b, target) => {
  const w = window(b.timing)
  const cur = numOr(target.get('rotation'), 0)
  const deg = numOr(b.params?.degrees, 8)
  return [loopTrack('rotation', [cur, cur + deg, cur, cur - deg, cur], w)]
})

registerBehaviour('float', (b, target) => {
  const w = window(b.timing)
  const cur = numOr(target.get('y'), 0.5)
  const amt = numOr(b.params?.amount, 0.03)   // fraction of frame height
  return [loopTrack('y', [cur, cur - amt, cur], w)]
})

registerBehaviour('gradientScroll', (b) => {
  const w = window(b.timing)
  const track = numTrack('fill.phase', 0, 1, w, 'linear')
  return [{ ...track, loop: b.timing.loop ?? false }]
})

registerBehaviour('gradientMorph', (b, target) => {
  const from = (b.params?.from as GradientStop[]) ?? (target.get('fill') as GradientStop[] | undefined)
  const to = b.params?.to as GradientStop[] | undefined
  if (!from || !to) return []
  const [t0, t1] = window(b.timing)
  return [{
    path: 'fill', type: 'gradient',
    mode: (b.params?.mode as 'crossfade' | 'travel') ?? 'crossfade',
    space: (b.params?.space as 'oklab' | 'hybrid') ?? 'oklab',
    keyframes: [{ t: t0, value: from, ease: 'easeInOut' }, { t: t1, value: to, ease: 'linear' }],
  }]
})
