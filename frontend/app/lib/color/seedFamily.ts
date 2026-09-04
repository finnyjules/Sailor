import { hexToOklch, rgbToOklab, hexToRgb } from './convert'

export interface PaletteFamily {
  hexes: string[]
  anchorIdxs: number[]
  source: 'curated' | 'composed'
  sourceTag?: 0 | 1
  recipe?: string
  warp: number
}

export interface Facets { avgL: number; avgC: number; maxC: number; hue: number; hueWeight: number }
export type Character = 'any' | 'muted' | 'vivid' | 'dark' | 'light' | 'warm' | 'cool'

const hexLab = (hex: string): [number, number, number] => rgbToOklab(...hexToRgb(hex))
export function labDist(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
}

export function facetsOf(hexes: string[]): Facets {
  const lch = hexes.map(hexToOklch)
  const avgL = lch.reduce((a, x) => a + x[0], 0) / lch.length
  const avgC = lch.reduce((a, x) => a + x[1], 0) / lch.length
  const maxC = Math.max(...lch.map(x => x[1]))
  let X = 0, Y = 0
  for (const [, C, H] of lch) { X += C * Math.cos(H * Math.PI / 180); Y += C * Math.sin(H * Math.PI / 180) }
  let hue = Math.atan2(Y, X) * 180 / Math.PI; if (hue < 0) hue += 360
  return { avgL, avgC, maxC, hue, hueWeight: Math.hypot(X, Y) }
}

const TESTS: Record<Character, (f: Facets) => boolean> = {
  any: () => true,
  muted: f => f.avgC < 0.09,
  vivid: f => f.maxC > 0.16,
  dark: f => f.avgL < 0.48,
  light: f => f.avgL > 0.68,
  warm: f => f.hueWeight > 0.03 && (f.hue < 130 || f.hue > 340),
  cool: f => f.hueWeight > 0.03 && f.hue > 160 && f.hue < 330,
}
export function matchesCharacter(f: Facets, ch: Character): boolean { return TESTS[ch](f) }

/** Mean pairwise OKLab distance between two palettes, for dedupe. */
export function meanPairwiseLab(a: string[], b: string[]): number {
  const la = a.map(hexLab), lb = b.map(hexLab)
  let t = 0, n = 0
  for (let i = 0; i < Math.min(la.length, lb.length); i++) { t += labDist(la[i]!, lb[i]!); n++ }
  return n ? t / n : Infinity
}
