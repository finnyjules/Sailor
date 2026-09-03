/**
 * A fills list read as a smooth ramp: `stops` are evenly spaced over 0..1 and
 * the colour at `t` is the perceptual mix of the two nearest (`mixHex`'s default
 * space — see mix.ts for why OKLab). Used by Shape Studio's "Colour ramp" and,
 * in phase two, the Frame's Blend layer.
 *
 * Only solid colours interpolate. A gradient/pattern/image stop has no single
 * colour to mix, so it is used as-is on its own side of the midpoint — the ramp
 * degrades to a hard step there rather than inventing a colour.
 */
import { mixHex } from './mix'
import type { Paint } from '~/lib/compositor/paint'

const FALLBACK = '#808080'

export function rampColour(stops: Paint[], t: number): Paint {
  if (stops.length === 0) return FALLBACK
  if (stops.length === 1) return stops[0]!
  const tt = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  const u = tt * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u))
  const f = u - i
  const a = stops[i]!, b = stops[i + 1]!
  if (f <= 0) return a
  if (f >= 1) return b
  if (typeof a !== 'string' || typeof b !== 'string') return f < 0.5 ? a : b
  return mixHex(a, b, f)
}
