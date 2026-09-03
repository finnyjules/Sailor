// frontend/app/lib/motion/easing.ts
/** Pure easing math (GSAP-compatible subset). Every fn maps [0,1]→~[0,1]
 *  with f(0)=0, f(1)=1 (back/elastic overshoot in between by design). */
import { bezierEase } from '~/lib/spacetype/motion'

export type EaseFn = (t: number) => number

export const linear: EaseFn = t => t
export function powerOut(p: number): EaseFn { return t => 1 - Math.pow(1 - t, p) }
export function powerIn(p: number): EaseFn { return t => Math.pow(t, p) }
export const easeInOutQuad: EaseFn = t =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
export const sineInOut: EaseFn = t => -(Math.cos(Math.PI * t) - 1) / 2

export function backOut(s = 1.70158): EaseFn {
  return (t) => { const u = t - 1; return 1 + (s + 1) * u * u * u + s * u * u }
}
export function backIn(s = 1.70158): EaseFn {
  return t => (s + 1) * t * t * t - s * t * t
}

export const elasticOut: EaseFn = (t) => {
  if (t === 0 || t === 1) return t
  return Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1
}

export const bounceOut: EaseFn = (t) => {
  if (t < 1 / 2.75) return 7.5625 * t * t
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375
}

/** Quantized ease, CSS `steps(n, jump-none)` convention: n output levels
 *  INCLUDING both endpoints, so f(1)=1 like every other ease here (GSAP's
 *  SteppedEase is jump-end; for the flicker/glitch uses this feeds, the
 *  difference is imperceptible and endpoint consistency wins). */
export function steps(n: number): EaseFn {
  return t => (t >= 1 ? 1 : Math.floor(t * n) / Math.max(1, n - 1))
}

/** GSAP-style name → EaseFn. Handles the names appearing in kinetic-presets.ts:
 *  powerN.out / powerN.in, back.out(s) / back.in(s), elastic.out(...),
 *  bounce.out, sine.inOut, steps(n), none/linear. Unknown → power2.out.
 *  Known approximations: powerN.inOut maps to quad in-out (exact only for
 *  N=2); elastic.* ignores GSAP's amplitude/period params (fixed 1/0.3). */
export function resolveEase(name: string | undefined): EaseFn {
  if (!name || name === 'power2.out') return powerOut(2)
  if (name === 'none' || name === 'linear') return linear
  const bez = /^bezier\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/.exec(name)
  if (bez) { const cps: [number, number, number, number] = [Number(bez[1]), Number(bez[2]), Number(bez[3]), Number(bez[4])]; return (t: number) => bezierEase(t, cps) }
  const power = /^power(\d)\.(out|in|inOut)$/.exec(name)
  if (power) {
    const p = Number(power[1])
    if (power[2] === 'out') return powerOut(p)
    if (power[2] === 'in') return powerIn(p)
    return easeInOutQuad
  }
  const back = /^back\.(out|in)(?:\(([\d.]+)\))?$/.exec(name)
  if (back) {
    const s = back[2] ? parseFloat(back[2]) : 1.70158
    return back[1] === 'out' ? backOut(s) : backIn(s)
  }
  if (name.startsWith('elastic')) return elasticOut
  if (name.startsWith('bounce')) return bounceOut
  if (name === 'sine.inOut') return sineInOut
  const st = /^steps\((\d+)\)$/.exec(name)
  if (st) return steps(Number(st[1]))
  if (name.includes('InOut') || name.includes('inOut')) return easeInOutQuad
  return powerOut(2)
}
