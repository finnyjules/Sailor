import { hexToOklch, oklchToHexInGamut } from './convert'
import { makeRng, type Rng } from '~/lib/rng'
import { facetsOf, matchesCharacter, type PaletteFamily, type Character } from './seedFamily'

const NGEN = 5
const clampL = (L: number) => Math.max(0.05, Math.min(0.96, L))
function shortestHueDelta(to: number, from: number): number {
  let d = (to - from) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d
}

function lSkeleton(Ls: number, rng: Rng) {
  const Lmin = 0.14 + rng.next() * 0.14, Lmax = 0.84 + rng.next() * 0.12
  const L: number[] = []
  for (let i = 0; i < NGEN; i++) { const t = i / (NGEN - 1); L.push(Lmin + (Lmax - Lmin) * (t * t * (3 - 2 * t) * 0.6 + t * 0.4)) }
  let i0 = 0, best = Infinity
  L.forEach((v, i) => { const d = Math.abs(v - Ls); if (d < best) { best = d; i0 = i } })
  const shift = Ls - L[i0]!
  return { L: L.map((v, i) => clampL(v + shift * (1 - Math.abs(i - i0) / NGEN))), i0 }
}

type Stops = [number, number, number][]
function rampFrom(seedLch: [number, number, number], rng: Rng, spread: number, cEnds: number): { stops: Stops; i0: number } {
  let [Ls, Cs, Hs] = seedLch
  if (Cs < 0.02) { Hs = rng.next() * 360; Cs = 0.03 + rng.next() * 0.05 }
  const { L, i0 } = lSkeleton(Ls, rng)
  const dir = rng.next() < 0.5 ? -1 : 1
  const stops: Stops = L.map((l, i) => {
    const u = (i - i0) / (NGEN - 1)
    const h = (Hs + dir * spread * u + 720) % 360
    const fall = 1 - (1 - cEnds) * Math.abs(u) * 1.6
    return [l, Math.max(0.01, Cs * Math.max(0.2, fall)), h]
  })
  return { stops, i0 }
}

interface Recipe { name: string; build(a: [number, number, number], rng: Rng): { stops: Stops; i0: number } }
const ONE_SEED_RECIPES: Recipe[] = [
  { name: 'tonal', build: (a, r) => rampFrom(a, r, 8 + r.next() * 14, 0.55) },
  { name: 'analogous', build: (a, r) => rampFrom(a, r, 40 + r.next() * 35, 0.7) },
  { name: 'hue-cycle', build: (a, r) => rampFrom(a, r, 120 + r.next() * 170, 0.85) },
  { name: 'complement', build: (a, r) => {
      const out = rampFrom(a, r, 24 + r.next() * 20, 0.6)
      const far = out.i0 < NGEN / 2 ? NGEN - 1 : 0
      const [l, c, h] = out.stops[far]!
      out.stops[far] = [l, Math.max(c, Math.min(0.22, a[1] * 1.15)), (h + 180) % 360]
      return out } },
  { name: 'split-tone', build: (a, r) => {
      const out = rampFrom(a, r, 14 + r.next() * 10, 0.7)
      const flip = 150 + r.next() * 60
      out.stops = out.stops.map(([l, c, h], i) => (i === out.i0 || l >= 0.5 ? [l, c, h] : [l, c * 0.65, (h + flip) % 360]))
      return out } },
  { name: 'neutral+pop', build: (a, r) => {
      const out = rampFrom(a, r, 10 + r.next() * 12, 0.5)
      const pop = out.i0 === 0 ? NGEN - 1 : out.i0 - 1
      out.stops = out.stops.map(([l, c, h], i) => (i === out.i0 ? [l, c, h]
        : i === pop ? [l, Math.min(0.2, a[1] * 1.1 + 0.04), (h + (r.next() < 0.5 ? 120 : -120)) % 360]
        : [l, c * 0.28, h]))
      return out } },
]
const TWO_SEED_RECIPES = [{ name: 'bridge', longWay: false }, { name: 'arc', longWay: true }]

function composedTwoSeed(aHex: string, bHex: string, longWay: boolean, rng: Rng): { stops: Stops; anchors: [number, string][] } {
  let A = hexToOklch(aHex), B = hexToOklch(bHex), hexA = aHex, hexB = bHex
  if (A[0] > B[0]) { [A, B] = [B, A];[hexA, hexB] = [hexB, hexA] }
  const i0 = 1, i1 = 3
  let dH = shortestHueDelta(B[2], A[2])
  if (longWay) dH = dH > 0 ? dH - 360 : dH + 360
  const stops: Stops = []
  for (let i = 0; i < NGEN; i++) {
    const t = (i - i0) / (i1 - i0)
    const l = clampL(A[0] + (B[0] - A[0]) * t)
    const c = Math.max(0.01, (A[1] + (B[1] - A[1]) * t) * (1 - 0.25 * Math.abs(t - 0.5)) * (0.85 + rng.next() * 0.3))
    const h = (A[2] + dH * t + 1080) % 360
    stops.push([l, c, h])
  }
  return { stops, anchors: [[i0, hexA], [i1, hexB]] }
}

export function composedFamilies(seedA: string, seedB: string | null, char: Character, page: number, want: number): PaletteFamily[] {
  const a = hexToOklch(seedA)
  const recipes = seedB ? TWO_SEED_RECIPES : ONE_SEED_RECIPES
  const variants = Math.ceil(want / recipes.length)
  const out: PaletteFamily[] = []
  for (let v = 0; v < variants; v++) {
    for (const rec of recipes) {
      const rng = makeRng('gen:' + seedA + (seedB || '') + rec.name + ':' + v + ':' + page)
      let stops: Stops, anchors: [number, string][]
      if (seedB) { const r = composedTwoSeed(seedA, seedB, (rec as { longWay: boolean }).longWay, rng); stops = r.stops; anchors = r.anchors }
      else { const r = (rec as Recipe).build(a, rng); stops = r.stops; anchors = [[r.i0, seedA]] }
      const hexes = stops.map(([L, C, H]) => oklchToHexInGamut(L, C, H))
      for (const [i, hx] of anchors) hexes[i] = hx
      const anchorIdxs = anchors.map(x => x[0])
      // NOTE: variation is applied once, at the engine layer (Task 6 assembleShelf),
      // so composed families are emitted un-varied here. Do not import applyVariation.
      const f = facetsOf(hexes)
      if (!matchesCharacter(f, char)) continue
      out.push({ hexes, anchorIdxs, source: 'composed', recipe: rec.name, warp: 0.01 * v })
    }
  }
  return out
}
