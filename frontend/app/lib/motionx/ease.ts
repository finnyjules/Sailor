import type { Ease } from './types'

export function applyEase(p: number, e: Ease): number {
  const t = p < 0 ? 0 : p > 1 ? 1 : p
  switch (e) {
    case 'easeIn': return t * t
    case 'easeOut': return 1 - (1 - t) * (1 - t)
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    default: return t
  }
}
