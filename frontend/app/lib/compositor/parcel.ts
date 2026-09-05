/**
 * Parcel — a line-faithful port of the playgrnd "Parcel" generator, as the
 * `parcel` cell fill of a generative `deal` layer. Reimplemented from the
 * algorithm (the site has no licence; nothing here is copied — our own rng, our
 * own lattice hash and value noise, our own structure), but every RULE of the
 * original is kept, because the rules ARE the look: a coarse two-tone block
 * field with hairline survey grids floating on top. No rounded rects, no
 * overlaid grids — every cell is ground or ink, and the survey grids are ragged
 * rectangular clusters of 1px lattice lines that DARKEN whatever they cross.
 *
 *  A. Spec: from the seed, noise offsets `ox = r·43`, `oy = r·37` and a noise
 *     salt from ONE seeded stream; a SECOND hash seed keys the survey clusters.
 *  B. Noise: value noise on an integer lattice with smoothstep interpolation
 *     (`u = fx²(3−2fx)`); `fbm(x, y) = vn(x, y)·0.62 + vn(2.17x, 2.17y)·0.38` —
 *     TWO octaves with those weights and that lacunarity.
 *  C. Block mask: `sc = 0.2/chunk`, `th = 0.5 + (0.5 − cover)·0.55`; cell (u, v)
 *     is INK iff `fbm(u·sc + ox, v·sc + oy) > th`. More cover ⇒ lower threshold
 *     ⇒ more ink; more chunk ⇒ bigger blobs.
 *  D. Survey clusters: `grids` of them; cluster i is `w = 2 + ⌊h(i,1)·6⌋` (2..7)
 *     by `h = 2 + ⌊h(i,2)·5⌋` (2..6) at `cx = round(h(i,3)·max(0, gw−w))`,
 *     `cy = round(h(i,4)·max(0, gh−h))`; each cell (a, b) of the box is INCLUDED
 *     iff `h(a, b, i·17+7) < 0.78` — ragged, ~78% of the box.
 *  E. Grid lines: EVERY cell border of every included cell goes into two SETS
 *     (horizontal edges keyed (a, b) and (a, b+1); vertical (a, b) and (a+1, b)).
 *     The Set DEDUPES: a border shared by two adjacent included cells is stored
 *     once and drawn once — it is NOT removed, so a cluster renders as a full
 *     lattice including its interior borders. Each set is grouped by row /
 *     column, sorted, and consecutive unit edges merge into runs.
 *  F. Paint (`cw = W/gw`, `ch = H/gh`): ground over the whole box; ink cells
 *     run-length per row as cell-snapped rects `round(u0·cw)..round(u1·cw)` ×
 *     `round(v·ch)..round((v+1)·ch)` — flush, no gutter; then the hairlines in
 *     the hairline colour at lineWidth 1, under `globalCompositeOperation =
 *     'multiply'` when blend is multiply (so they darken ink and ground alike),
 *     each run from `(round(x0·cw)+.5, round(y0·ch)+.5)` to the same of (x1, y1);
 *     the composite op is put back afterwards.
 *
 * Grid: `gw = cells` wide, `gh = max(4, round(cells · H/W))` tall.
 *
 * DOM-free (the paint function only takes a canvas-shaped ctx) so every rule
 * unit-tests without mounting anything. The deal paint branch (drawLayerContent)
 * translates to the box and calls `paintParcel`.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'

export const PARCEL_BLENDS = ['multiply', 'normal'] as const
export type ParcelBlend = typeof PARCEL_BLENDS[number]

/** The tunables, with the original's defaults (see defaultParcel). */
export interface ParcelParams {
  cells: number            // grid width in cells (rows follow the box aspect)
  cover: number            // 0..1 ink coverage of the block field
  chunk: number            // block scale: bigger ⇒ bigger blobs
  grids: number            // how many survey-grid clusters float on top
  blend: ParcelBlend       // 'multiply' darkens whatever the hairlines cross; 'normal' paints them flat
  ground: string           // the ground colour (palette[0])
  ink: string              // the ink-block colour (palette[1])
  hairline: string         // the survey-grid line colour (palette[2])
}

export function defaultParcel(): ParcelParams {
  return {
    cells: 16, cover: 0.5, chunk: 1, grids: 4, blend: 'multiply',
    ground: '#D9D9D4', ink: '#DFF23C', hairline: '#98988F',
  }
}

/** Bounds each param is clamped to (also the inspector's slider ranges). */
export const PARCEL_LIMITS = {
  cells: [8, 40], cover: [0, 1], chunk: [0.5, 3], grids: [0, 8],
} as const

/** A named palette preset: the source's three-colour triple [ground, ink, hairline]. */
export interface ParcelPalettePreset { ground: string; ink: string; hairline: string }

export const PARCEL_PALETTE_PRESETS = {
  'Lime on grey': { ground: '#D9D9D4', ink: '#DFF23C', hairline: '#98988F' },
  'Blue on cream': { ground: '#EFE9DC', ink: '#1B3FA8', hairline: '#8A857B' },
  'Acid on black': { ground: '#141414', ink: '#C6FF3D', hairline: '#5A5A52' },
  'Orange on cream': { ground: '#F2EDE4', ink: '#F0480F', hairline: '#9A948A' },
  'Cyan on stone': { ground: '#E8E4DC', ink: '#12B9DC', hairline: '#8F948C' },
  'Blue on olive': { ground: '#DCE2AA', ink: '#2B2BE0', hairline: '#94997F' },
} as const satisfies Record<string, ParcelPalettePreset>
export type ParcelPresetName = keyof typeof PARCEL_PALETTE_PRESETS
export const PARCEL_PRESET_NAMES = Object.keys(PARCEL_PALETTE_PRESETS) as ParcelPresetName[]

/** The params patch a preset applies (the three colours). */
export function parcelPresetPatch(name: ParcelPresetName): Pick<ParcelParams, 'ground' | 'ink' | 'hairline'> {
  const p = PARCEL_PALETTE_PRESETS[name]
  return { ground: p.ground, ink: p.ink, hairline: p.hairline }
}

/** Which preset the params currently match (all three colours), if any. */
export function parcelPresetOf(params: ParcelParams): ParcelPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of PARCEL_PRESET_NAMES) {
    const p = PARCEL_PALETTE_PRESETS[name]
    if (same(params.ground, p.ground) && same(params.ink, p.ink) && same(params.hairline, p.hairline)) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas fillStyle/strokeStyle accept both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex6 = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`. */
export function normalizeParcel(partial: unknown, base: ParcelParams = defaultParcel()): ParcelParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  return {
    cells: Math.round(num(p.cells, PARCEL_LIMITS.cells[0], PARCEL_LIMITS.cells[1], base.cells)),
    cover: num(p.cover, PARCEL_LIMITS.cover[0], PARCEL_LIMITS.cover[1], base.cover),
    chunk: num(p.chunk, PARCEL_LIMITS.chunk[0], PARCEL_LIMITS.chunk[1], base.chunk),
    grids: Math.round(num(p.grids, PARCEL_LIMITS.grids[0], PARCEL_LIMITS.grids[1], base.grids)),
    blend: p.blend === 'multiply' || p.blend === 'normal' ? p.blend : base.blend,
    ground: isHex6(p.ground) ? p.ground : base.ground,
    ink: isHex6(p.ink) ? p.ink : base.ink,
    hairline: isHex6(p.hairline) ? p.hairline : base.hairline,
  }
}

/** Grid rows from the box aspect: `max(4, round(cells · H/W))`. */
export function parcelRows(cells: number, boxW: number, boxH: number): number {
  return Math.max(4, Math.round(cells * (Math.max(1, boxH) / Math.max(1, boxW))))
}

// ── Rule A: the seeded spec ──────────────────────────────────────────────────

/** What one seed fixes: the noise offsets + salt for the block field, and a
 *  second hash seed for the survey clusters. */
export interface ParcelSpec { ox: number; oy: number; salt: number; survey: number }

export function parcelSpec(seed: number): ParcelSpec {
  const r = mulberry32(hashSeed(`${seed}:parcel`))
  const ox = r() * 43, oy = r() * 37
  const salt = Math.floor(r() * 0x7fffffff)
  return { ox, oy, salt, survey: hashSeed(`${seed}:parcel-survey`) }
}

// ── Rule B: noise ────────────────────────────────────────────────────────────

/** Our own integer-lattice hash → [0,1): fold (ix, iy, salt) through three odd
 *  multiplies with xor-shifts between them so every lattice point is independent. */
function lattice(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix | 0, 0x85ebca6b) >>> 0
  h = Math.imul((h ^ (h >>> 13)) + Math.imul(iy | 0, 0xc2b2ae35), 0x7feb352d) >>> 0
  h = Math.imul((h ^ (h >>> 16)) + Math.imul(salt | 0, 0x27d4eb2f), 0x846ca68b) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smoothstep: `t²(3 − 2t)` — the source's interpolant. */
const smooth = (t: number) => t * t * (3 - 2 * t)

/** Rule B — value noise in [0,1]: the 4 lattice corners around (x, y), bilinearly
 *  blended with smoothstep weights. */
export function valueNoise2(x: number, y: number, salt: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const a = lattice(ix, iy, salt), b = lattice(ix + 1, iy, salt)
  const c = lattice(ix, iy + 1, salt), d = lattice(ix + 1, iy + 1, salt)
  const top = a + (b - a) * fx, bottom = c + (d - c) * fx
  return top + (bottom - top) * fy
}

/** The second octave gets its own salt so the two layers don't correlate. */
export const PARCEL_OCTAVE2_SALT = 0x2f1

/** Rule B — two octaves: `vn(x, y)·0.62 + vn(2.17x, 2.17y)·0.38`. */
export function fbmParcel(x: number, y: number, salt: number): number {
  return valueNoise2(x, y, salt) * 0.62 + valueNoise2(x * 2.17, y * 2.17, salt + PARCEL_OCTAVE2_SALT) * 0.38
}

// ── Rule C: the block mask ───────────────────────────────────────────────────

/** Rule C — the ink field over a `gw × gh` grid: 1 = ink, 0 = ground. */
export function parcelBlockMask(params: ParcelParams, gw: number, gh: number, seed: number): Uint8Array {
  const p = normalizeParcel(params)
  const { ox, oy, salt } = parcelSpec(seed)
  const sc = 0.2 / p.chunk
  const th = 0.5 + (0.5 - p.cover) * 0.55
  const m = new Uint8Array(gw * gh)
  for (let v = 0; v < gh; v++) {
    for (let u = 0; u < gw; u++) m[v * gw + u] = fbmParcel(u * sc + ox, v * sc + oy, salt) > th ? 1 : 0
  }
  return m
}

// ── Rule D: survey clusters ──────────────────────────────────────────────────

/** Our own 3-int hash keyed by the survey seed → [0,1). */
function surveyHash(a: number, b: number, c: number, key: number): number {
  let h = Math.imul(key | 0, 0x9e3779b1) >>> 0
  h = Math.imul((h ^ (h >>> 15)) + Math.imul(a | 0, 0x85ebca6b), 0xc2b2ae35) >>> 0
  h = Math.imul((h ^ (h >>> 13)) + Math.imul(b | 0, 0x27d4eb2f), 0x165667b1) >>> 0
  h = Math.imul((h ^ (h >>> 16)) + Math.imul(c | 0, 0x7feb352d), 0x846ca68b) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** One survey grid: its box in cell units and the included cells (absolute). */
export interface ParcelCluster { x: number; y: number; w: number; h: number; cells: [number, number][] }

/**
 * Rule D — `grids` ragged clusters. Cells falling outside the `gw × gh` grid are
 * dropped (the source's canvas clips them; only a cluster taller than a very
 * squat grid can reach past it).
 */
export function parcelClusters(params: ParcelParams, gw: number, gh: number, seed: number): ParcelCluster[] {
  const p = normalizeParcel(params)
  const { survey } = parcelSpec(seed)
  const out: ParcelCluster[] = []
  for (let i = 0; i < p.grids; i++) {
    const w = 2 + Math.floor(surveyHash(i, 1, 0, survey) * 6)
    const h = 2 + Math.floor(surveyHash(i, 2, 0, survey) * 5)
    const cx = Math.round(surveyHash(i, 3, 0, survey) * Math.max(0, gw - w))
    const cy = Math.round(surveyHash(i, 4, 0, survey) * Math.max(0, gh - h))
    const cells: [number, number][] = []
    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        if (surveyHash(a, b, i * 17 + 7, survey) >= 0.78) continue
        if (cx + a >= gw || cy + b >= gh) continue
        cells.push([cx + a, cy + b])
      }
    }
    out.push({ x: cx, y: cy, w, h, cells })
  }
  return out
}

// ── Rule E: grid lines ───────────────────────────────────────────────────────

/** A hairline run `[x0, y0, x1, y1]` in CELL units (horizontal or vertical). */
export type ParcelRun = [number, number, number, number]

/** Group unit edges by their line (row for H, column for V), sort the positions
 *  along it and merge consecutive ones into `[start, end)` runs. */
function mergeRuns(keys: Set<string>, horizontal: boolean): ParcelRun[] {
  const lines = new Map<number, number[]>()
  for (const k of keys) {
    const [a, b] = k.split(',').map(Number) as [number, number]
    const line = horizontal ? b : a, pos = horizontal ? a : b
    const arr = lines.get(line)
    if (arr) arr.push(pos); else lines.set(line, [pos])
  }
  const out: ParcelRun[] = []
  for (const line of [...lines.keys()].sort((x, y) => x - y)) {
    const pos = lines.get(line)!.sort((x, y) => x - y)
    let s = pos[0]!, prev = pos[0]!
    const push = () => out.push(horizontal ? [s, line, prev + 1, line] : [line, s, line, prev + 1])
    for (let i = 1; i < pos.length; i++) {
      if (pos[i] === prev + 1) { prev = pos[i]! ; continue }
      push(); s = prev = pos[i]!
    }
    push()
  }
  return out
}

/**
 * Rule E — every border of every included cell, DEDUPED through two Sets (a
 * border two adjacent included cells share is stored once, drawn once, never
 * removed — the cluster is a full lattice), merged into runs.
 */
export function parcelGridLines(clusters: readonly ParcelCluster[]): ParcelRun[] {
  const H = new Set<string>(), V = new Set<string>()
  for (const c of clusters) {
    for (const [a, b] of c.cells) {
      H.add(`${a},${b}`); H.add(`${a},${b + 1}`)
      V.add(`${a},${b}`); V.add(`${a + 1},${b}`)
    }
  }
  return [...mergeRuns(H, true), ...mergeRuns(V, false)]
}

// ── Rule F: paint ────────────────────────────────────────────────────────────

/** One row of consecutive ink cells: `[u0, u1)` on row `v`. */
export interface ParcelInkRun { v: number; u0: number; u1: number }

/** Rule F — the run-length rows of the ink mask. */
export function parcelInkRuns(mask: Uint8Array, gw: number, gh: number): ParcelInkRun[] {
  const out: ParcelInkRun[] = []
  for (let v = 0; v < gh; v++) {
    let run = -1
    for (let u = 0; u <= gw; u++) {
      const on = u < gw && mask[v * gw + u] === 1
      if (on && run < 0) run = u
      else if (!on && run >= 0) { out.push({ v, u0: run, u1: u }); run = -1 }
    }
  }
  return out
}

/** The subset of a 2D context the paint needs — so a recording stub can stand in. */
export type ParcelCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalCompositeOperation' | 'fillRect'
  | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke'>

/** The whole layout over a pixel box, for tests and proofs. */
export interface ParcelLayout {
  gw: number; gh: number
  cw: number; ch: number          // cell size in px (fractional; rects snap per edge)
  mask: Uint8Array
  clusters: ParcelCluster[]
  lines: ParcelRun[]
}

/**
 * Rule F — paint the composition at the ctx's origin over `boxW × boxH`: ground,
 * the ink runs, then the hairlines (multiplied when `blend` says so). The
 * composite op is put back to what it was on entry.
 */
export function paintParcel(ctx: ParcelCtx, params: ParcelParams, boxW: number, boxH: number, seed: number): ParcelLayout {
  const p = normalizeParcel(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const gw = p.cells, gh = parcelRows(gw, W, H)
  const cw = W / gw, ch = H / gh
  const mask = parcelBlockMask(p, gw, gh, seed)
  // Ground over the whole box.
  ctx.fillStyle = p.ground
  ctx.fillRect(0, 0, W, H)
  // Ink blocks: run-length per row, cell-snapped, flush.
  ctx.fillStyle = p.ink
  for (const r of parcelInkRuns(mask, gw, gh)) {
    const x0 = Math.round(r.u0 * cw), x1 = Math.round(r.u1 * cw)
    const y0 = Math.round(r.v * ch), y1 = Math.round((r.v + 1) * ch)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
  // Hairline survey grids: 1px, on the half-pixel, darkening what they cross.
  const clusters = parcelClusters(p, gw, gh, seed)
  const lines = parcelGridLines(clusters)
  const entryOp = ctx.globalCompositeOperation
  ctx.strokeStyle = p.hairline
  ctx.lineWidth = 1
  if (p.blend === 'multiply') ctx.globalCompositeOperation = 'multiply'
  ctx.beginPath()
  for (const [x0, y0, x1, y1] of lines) {
    ctx.moveTo(Math.round(x0 * cw) + 0.5, Math.round(y0 * ch) + 0.5)
    ctx.lineTo(Math.round(x1 * cw) + 0.5, Math.round(y1 * ch) + 0.5)
  }
  ctx.stroke()
  ctx.globalCompositeOperation = entryOp
  return { gw, gh, cw, ch, mask, clusters, lines }
}
