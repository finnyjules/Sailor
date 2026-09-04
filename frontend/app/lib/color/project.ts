// The three projections of a palette family. gradientize PRESERVES each color's
// own lightness — it is NOT toStops, which overwrites lightness with a fixed ramp.
import { hexToOklch, oklchToHexInGamut } from './convert'
import type { GradientStop } from './harmony'

export function gradientize(hexes: string[]): GradientStop[] {
  const sorted = [...hexes].sort((a, b) => hexToOklch(a)[0] - hexToOklch(b)[0])
  const n = sorted.length
  return sorted.map((color, i) => ({ pos: n === 1 ? 0.5 : i / (n - 1), color }))
}

export function paletteize(hexes: string[]): string[] { return [...hexes] }

export type DistributePolicy = 'cycle' | 'ramp'

export function distribute(hexes: string[], slotCount: number, policy: DistributePolicy = 'cycle'): string[] {
  if (slotCount <= 0 || hexes.length === 0) return []
  if (slotCount === hexes.length) return [...hexes]
  if (slotCount < hexes.length) {
    // resample down, evenly spaced (endpoints included)
    return Array.from({ length: slotCount }, (_, i) => hexes[Math.round(i * (hexes.length - 1) / (slotCount - 1))]!)
  }
  // slotCount > hexes.length
  if (policy === 'cycle') return Array.from({ length: slotCount }, (_, i) => hexes[i % hexes.length]!)
  // ramp: interpolate across the sorted family in OKLCH
  const sorted = [...hexes].map(hexToOklch)
  return Array.from({ length: slotCount }, (_, i) => {
    const f = (i / (slotCount - 1)) * (sorted.length - 1)
    const lo = Math.floor(f), hi = Math.min(sorted.length - 1, lo + 1), fr = f - lo
    const a = sorted[lo]!, b = sorted[hi]!
    const lerp = (x: number, y: number) => x + (y - x) * fr
    let dh = (b[2] - a[2]) % 360; if (dh > 180) dh -= 360; if (dh < -180) dh += 360
    return oklchToHexInGamut(lerp(a[0], b[0]), lerp(a[1], b[1]), (a[2] + dh * fr + 360) % 360)
  })
}
