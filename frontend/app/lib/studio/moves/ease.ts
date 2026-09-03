// frontend/app/lib/studio/moves/ease.ts
/**
 * A move's ease and play mode, and the ease's picture. PURE, studio-neutral.
 *
 * One ease per move. `easeToEngineName` turns it into a string `resolveEase`
 * (lib/motion/easing.ts) already reads — the ten named eases map onto
 * functions that exist there, and a bezier becomes `bezier(a,b,c,d)`.
 * `easeGlyphPath` samples the SAME function the motion uses, so a tile can
 * never disagree with the movement.
 *
 * Lives in lib/studio/moves (not lib/vectortype) so Gradient, Shape Studio
 * and Shader can share one ease/play vocabulary. NOTHING here may import
 * from lib/vectortype.
 */
import { resolveEase } from '~/lib/motion/easing'
import type { MoveEase, MoveEaseName, MovePlay } from './types'

export const EASE_NAMES: readonly MoveEaseName[] =
  Object.freeze(['smooth', 'none', 'natural', 'slowDown', 'accelerate', 'overshoot', 'elastic', 'bounce', 'swing', 'steps'])

export const DEFAULT_EASE: MoveEase = { kind: 'named', name: 'smooth' }

export const EASE_LABELS: Record<MoveEaseName, string> = {
  none: 'None', smooth: 'Smooth', natural: 'Natural', slowDown: 'Slow down',
  accelerate: 'Speed up', overshoot: 'Overshoot', elastic: 'Elastic',
  bounce: 'Bounce', swing: 'Swing', steps: 'Steps',
}

const ENGINE_NAME: Record<MoveEaseName, string> = {
  none: 'none', smooth: 'power2.out', natural: 'sine.inOut', slowDown: 'power3.out',
  accelerate: 'power3.in', overshoot: 'back.out', elastic: 'elastic.out',
  bounce: 'bounce.out', swing: 'back.inOut', steps: 'steps(6)',
}

export function easeToEngineName(ease: MoveEase): string {
  if (ease.kind === 'bezier') { const [a, b, c, d] = ease.cps; return `bezier(${a},${b},${c},${d})` }
  return ENGINE_NAME[ease.name] ?? 'power2.out'
}

export function easeSample(ease: MoveEase, t: number): number {
  return resolveEase(easeToEngineName(ease))(t)
}

export function easeGlyphPath(ease: MoveEase, w: number, h: number): string {
  const N = 24
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  let d = ''
  for (let i = 0; i <= N; i++) {
    const x = i / N
    const y = clamp(easeSample(ease, x))
    d += `${i === 0 ? 'M' : 'L'} ${(x * w).toFixed(2)} ${((1 - y) * h).toFixed(2)} `
  }
  return d.trim()
}

const clampX = (v: number) => Math.max(0, Math.min(1, v))
const clampY = (v: number) => Math.max(-0.6, Math.min(1.6, v))
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function mergeEase(raw: unknown): MoveEase {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EASE }
  const o = raw as Record<string, unknown>
  if (o.kind === 'bezier' && Array.isArray(o.cps) && o.cps.length === 4 && o.cps.every(isNum)) {
    const [x1, y1, x2, y2] = o.cps as number[]
    return { kind: 'bezier', cps: [clampX(x1!), clampY(y1!), clampX(x2!), clampY(y2!)] }
  }
  if (o.kind === 'named' && typeof o.name === 'string' && (EASE_NAMES as readonly string[]).includes(o.name)) {
    return { kind: 'named', name: o.name as MoveEaseName }
  }
  return { ...DEFAULT_EASE }
}

const PLAY_MODES: readonly MovePlay['mode'][] = Object.freeze(['once', 'backAndForth', 'repeat'])

export const DEFAULT_PLAY: MovePlay = { mode: 'once', times: 1 }

export function mergePlay(raw: unknown): MovePlay {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAY }
  const o = raw as Record<string, unknown>
  const mode = (PLAY_MODES as readonly string[]).includes(o.mode as string) ? o.mode as MovePlay['mode'] : 'once'
  const times = isNum(o.times) ? Math.max(1, Math.min(20, Math.round(o.times))) : 1
  return { mode, times }
}
