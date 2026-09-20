import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { GOLDEN_ANGLE, loopRatesOf, pmod, smoothstep, travel } from './util'

// The near mouth sits in front of the origin so the closest cards fill the frame.
export const TUNNEL_NEAR_Z = 6

const controls: ControlSpec[] = [
  { key: 'tunnelDepth', label: 'Depth', kind: 'slider', min: 5, max: 40, step: 0.5, default: 18, group: 'Layout' },
  { key: 'tunnelSpread', label: 'Spread', kind: 'slider', min: 0, max: 4, step: 0.05, default: 2.8, group: 'Layout' },
]
export const tunnelLayout: ShowcaseLayout = {
  id: 'tunnel', label: 'Card tunnel', family: 'Stacks and decks', controls,
  place(i, n, p, t01): TileTransform {
    const depth = Number(p.tunnelDepth), spread = Number(p.tunnelSpread)
    const frac = pmod(i / Math.max(1, n) - travel(p, t01, n), 1)
    const a = i * GOLDEN_ANGLE
    // `frac` 0 is the near mouth, 1 the far end; a card leaving one re-enters at the other,
    // so both ends fade (the far end over a longer run — it reads as distance haze).
    const opacity = smoothstep(0, 0.08, frac) * smoothstep(0, 0.3, 1 - frac)
    return { x: Math.cos(a) * spread, y: Math.sin(a) * spread, z: TUNNEL_NEAR_Z - frac * depth, rotY: 0, scale: Number(p.cardSize), opacity }
  },
  loopRates: loopRatesOf,
}
