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

registerBehaviour('fade', (b) => {
  const dir = (b.params?.dir as string) ?? 'in'
  const w = window(b.timing)
  return [numTrack('opacity', dir === 'out' ? 1 : 0, dir === 'out' ? 0 : 1, w)]
})

registerBehaviour('slide', (b) => {
  const dir = (b.params?.dir as string) ?? 'up'
  const dist = (b.params?.distance as number) ?? 40
  const w = window(b.timing)
  const axis = dir === 'left' || dir === 'right' ? 'x' : 'y'
  const from = dir === 'up' || dir === 'left' ? dist : -dist
  return [numTrack(axis, from, 0, w), numTrack('opacity', 0, 1, w)]
})

registerBehaviour('gradientScroll', (b) => {
  const w = window(b.timing)
  return [numTrack('fill.phase', 0, 1, w, 'linear')]
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
