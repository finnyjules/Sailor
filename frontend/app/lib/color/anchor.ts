import { hexToOklch, oklchToHexInGamut, rgbToOklab, hexToRgb } from './convert'
import { makeRng } from '~/lib/rng'
import { labDist } from './seedFamily'

export type CorpusEntry = { s: 0 | 1; c: string[] }
const hexLab = (h: string): [number, number, number] => rgbToOklab(...hexToRgb(h))

function shortestHueDelta(to: number, from: number): number {
  let d = (to - from) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d
}

export function anchorOne(entry: CorpusEntry, seedHex: string) {
  const seedLch = hexToOklch(seedHex), seedLab = hexLab(seedHex)
  const lch = entry.c.map(hexToOklch)
  const labs = entry.c.map(hexLab)
  let ni = 0, nd = Infinity
  for (let i = 0; i < labs.length; i++) { const d = labDist(labs[i]!, seedLab); if (d < nd) { nd = d; ni = i } }
  const m = lch[ni]!
  const neutral = m[1] < 0.02 || seedLch[1] < 0.02
  const dH = neutral ? 0 : shortestHueDelta(seedLch[2], m[2])
  const dL = seedLch[0] - m[0]
  const r = Math.max(0.35, Math.min(2.8, seedLch[1] / Math.max(m[1], 1e-4)))
  const hexes = lch.map(([L, C, H], i) => {
    if (i === ni) return seedHex
    let h = (H + dH) % 360; if (h < 0) h += 360
    return oklchToHexInGamut(Math.max(0.03, Math.min(0.97, L + dL)), C * r, h)
  })
  return { hexes, anchorIdx: ni, warp: nd }
}

export function anchorTwo(entry: CorpusEntry, seedA: string, seedB: string) {
  const a = anchorOne(entry, seedA)
  const bLab = hexLab(seedB)
  let ni = -1, nd = Infinity
  a.hexes.forEach((h, i) => {
    if (i === a.anchorIdx) return
    const d = labDist(hexLab(h), bLab); if (d < nd) { nd = d; ni = i }
  })
  const hexes = a.hexes.map((h, i) => (i === ni ? seedB : h))
  return { hexes, anchorIdxs: [a.anchorIdx, ni], warp: a.warp + nd }
}

export function applyVariation(hexes: string[], anchorIdxs: number[], amount: number, key: string): string[] {
  if (amount <= 0) return hexes
  const rng = makeRng(key)
  return hexes.map((hex, i) => {
    if (anchorIdxs.includes(i)) return hex
    const [L, C, H] = hexToOklch(hex)
    const h = (H + (rng.next() - 0.5) * amount * 50 + 360) % 360
    const l = Math.max(0.03, Math.min(0.97, L + (rng.next() - 0.5) * amount * 0.14))
    const c = Math.max(0, C * (1 + (rng.next() - 0.5) * amount * 0.6))
    return oklchToHexInGamut(l, c, h)
  })
}
