import type { Behaviour, BehaviourTarget, Track, Timing, Ease } from './types'
import type { GradientStop } from '~/lib/color/harmony'

type Compiler = (b: Behaviour, target: BehaviourTarget) => Track[]
const REGISTRY = new Map<string, Compiler>()
export function registerBehaviour(kind: string, fn: Compiler): void { REGISTRY.set(kind, fn) }
export function compileBehaviour(b: Behaviour, target: BehaviourTarget): Track[] {
  return REGISTRY.get(b.kind)?.(b, target) ?? []
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

registerBehaviour('fade', (b) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  return [numTrack('opacity', dir === 'out' ? 1 : 0, dir === 'out' ? 0 : 1, w)]
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
  return [numTrack(axis, cur + off, cur, w), numTrack('opacity', 0, 1, w)]
})

// Whole-layer transform behaviours (Slice 5). Scale/rotation/opacity are unambiguous;
// they read the layer's current value via the target so they compose with its pose.
registerBehaviour('scale', (b, target) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  const cur = numOr(target.get('scale'), 1)
  return dir === 'out'
    ? [numTrack('scale', cur, 0, w), numTrack('opacity', 1, 0, w)]
    : [numTrack('scale', 0, cur, w), numTrack('opacity', 0, 1, w)]
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
