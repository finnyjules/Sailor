import type { Behaviour, BehaviourTarget, Track, Timing, Ease } from './types'
import type { GradientStop } from '~/lib/color/harmony'

type Compiler = (b: Behaviour, target: BehaviourTarget) => Track[]
const REGISTRY = new Map<string, Compiler>()
export function registerBehaviour(kind: string, fn: Compiler): void { REGISTRY.set(kind, fn) }
export function compileBehaviour(b: Behaviour, target: BehaviourTarget): Track[] {
  let tracks = REGISTRY.get(b.kind)?.(b, target) ?? []
  // `timing.loop` is the ONE loop switch: unset keeps the kind's default (pulse loops, fade
  // doesn't); true / false override it. The bar is one cycle — evaluateTrack repeats it.
  if (typeof b.timing?.loop === 'boolean') tracks = tracks.map((tr) => ({ ...tr, loop: b.timing.loop }))
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
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { type?: unknown; bounce?: unknown; count?: unknown }
    if (o.type === 'spring' && Number.isFinite(o.bounce)) return v as Ease
    if (o.type === 'steps' && Number.isFinite(o.count)) return v as Ease
  }
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

// A REVEAL transition (dither today; more mask looks later): the bar drives ONE number, how
// revealed the layer is. The LOOK is not a track — it stays on the bar's params and the
// painter reads it through the fold (adapter/frame.ts `applyRevealBehaviours`).
registerBehaviour('dither', (b) => {
  const w = window(b.timing)
  // LINEAR by default, unlike the other whole-layer moves: a reveal refines in stages across
  // the bar, and an ease-in-out spends the first quarter of it barely moving — which reads as
  // "nothing happens, then it all happens". The curve editor still overrides it.
  return [b.params?.dir === 'out' ? numTrack('reveal', 1, 0, w, 'linear') : numTrack('reveal', 0, 1, w, 'linear')]
})

// A SETTLE transition (Addendum 3): the same `reveal` band as `dither` — the two families
// share one timeline row — but the look is one of ten Shader Studio effects run over the
// layer's own pixels, driven to rest as the bar plays. Same LINEAR default as `dither`, for the
// same reason; the look itself lives on the bar's params, read through `settleParams` by the
// fold (adapter/frame.ts `applyRevealBehaviours`) and the painter.
registerBehaviour('settle', (b) => {
  const w = window(b.timing)
  return [b.params?.dir === 'out' ? numTrack('reveal', 1, 0, w, 'linear') : numTrack('reveal', 0, 1, w, 'linear')]
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
  // Start / finish size as a PERCENTAGE of the layer's own size (100 = as it sits now). Absent ⇒
  // the direction's default: in grows 0 → 100, out shrinks 100 → 0. After the bar the layer
  // HOLDS the finish size, like every band.
  const pct = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : d)
  const from = pct(b.params?.from, dir === 'out' ? 100 : 0)
  const to = pct(b.params?.to, dir === 'out' ? 0 : 100)
  return [numTrack('scale', (cur * from) / 100, (cur * to) / 100, w)]
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
