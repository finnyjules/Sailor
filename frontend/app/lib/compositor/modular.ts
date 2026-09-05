/**
 * Modular — a line-faithful port of the playgrnd "Modular" generator, as the
 * `modular` cell fill of a generative `deal` layer. Reimplemented from the
 * algorithm (the site has no licence; nothing here is copied — our own rng, our
 * own noise, our own structure), but every RULE of the original is kept, because
 * the rules ARE the look:
 *
 *  A. Layout: ONE seeded stream walks the `gcols × gr` module grid in raster order
 *     (`gr = max(2, round(gcols · boxH/boxW))`). Each untaken module draws `k` and
 *     merges 2×2 / 2-wide / 2-tall by the thresholds `merge·0.32 / ·0.66 / merge`
 *     when the cells are free, then draws its TYPE by cumulative weight over
 *     [empty, solid, blocks, dots, lines, grad], then a first ink `ci`, a DISTINCT
 *     second ink `ci2`, `sub` (→ inset), `onBg`, `corner`, `angle`, `phase` — in
 *     that order, from that one stream. The draw order is part of the character.
 *  B. `cellOn`: a unit sub-cell is ON when a 2-octave noise field, sampled at
 *     (gx·.55, gy·.55) with a per-module salt, stretched ×1.9 about .5 and clamped,
 *     falls below `blockFill`.
 *  C. `cluster`: a dot cluster is the module's sub-grid shrunk by `inset·2` per
 *     side (only when the side has more than 2 sub-cells) and pushed against the
 *     corner `corner` (bit 0 = right, bit 1 = bottom).
 *  D. Paint: bg, then per module by type — solid fill; a PLAIN 2-stop gradient in
 *     one of 4 directions; a run-length block field; a corner cluster of circles
 *     (`dot` = diameter fraction of the sub-cell); interior sub-grid lines at .85
 *     alpha — the blocks/dots/lines fields sit on `col2` unless `onBg`; empty shows
 *     the background. Finally hairlines in the `rule` colour at every interior
 *     module edge over the WHOLE composition, at `rules` alpha. Module edges are
 *     FLUSH integer edges (`edges(n, a, b)`), no gutter.
 *
 * DOM-free (the paint function only takes a canvas-shaped ctx) so every rule
 * unit-tests without mounting anything. The deal paint branch (drawLayerContent)
 * translates to the box and calls `paintModular`.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { dealVocabItems, type DealVocab } from '~/lib/compositor/dealVocab'

/** The six module types, in the order the cumulative-weight pick walks them. */
export const MODULAR_TYPES = ['empty', 'solid', 'blocks', 'dots', 'lines', 'grad'] as const
export type ModularType = typeof MODULAR_TYPES[number]

/** Relative weight of each module type (the pick is by cumulative weight). */
export type ModularWeights = Record<ModularType, number>

/** The tunables, with the original's defaults (see defaultModular). */
export interface ModularParams {
  gcols: number            // module columns (rows follow the box aspect)
  unit: number             // each module is a unit×unit sub-grid per module cell
  merge: number            // 0..1 how often modules merge into 2×2 / 2×1 / 1×2
  w: ModularWeights        // type weights
  blockFill: number        // 0..1 coverage threshold of the block / dot fields
  dot: number              // 0..1 dot diameter as a fraction of its sub-cell
  rules: number            // 0..1 alpha of the hairlines over the whole grid (0 = none)
  ruleW: number            // hairline / sub-grid line width in px
  bg: string               // background colour
  rule: string             // hairline colour
  inks: string[]           // ORDERED palette; empty ⇒ the deal vocabulary's solids
}

export function defaultModular(): ModularParams {
  return {
    gcols: 6, unit: 4, merge: 0.45,
    w: { empty: 34, solid: 20, blocks: 24, dots: 14, lines: 12, grad: 10 },
    blockFill: 0.5, dot: 0.62, rules: 0.22, ruleW: 1,
    bg: '#0A0A0B', rule: '#F2F0EA', inks: [],
  }
}

/** Bounds each param is clamped to (also the inspector's slider ranges). */
export const MODULAR_LIMITS = {
  gcols: [2, 12], unit: [2, 8], weight: [0, 50], ruleW: [1, 3],
} as const

/** A named palette preset: background + rule colour + 4 ordered inks. */
export interface ModularPalettePreset { bg: string; rule: string; inks: readonly string[] }

export const MODULAR_PALETTE_PRESETS = {
  Digital: { bg: '#0A0A0B', rule: '#F2F0EA', inks: ['#C6FF3D', '#FFE800', '#A97BF5', '#F2F0EA'] },
  Riso: { bg: '#F1EBE1', rule: '#0E2A8C', inks: ['#1B4FA0', '#FF87C3', '#8E9A24', '#FF5B1E'] },
  Bloom: { bg: '#000000', rule: '#D9F3F0', inks: ['#FFF04D', '#FF7A1A', '#FF2CB0', '#D9F3F0'] },
  Heat: { bg: '#0A0A0A', rule: '#F2F0EA', inks: ['#E8452C', '#F49BD1', '#FFE800', '#F2F0EA'] },
  Mono: { bg: '#09090B', rule: '#F2F0EA', inks: ['#F2F0EA', '#7E848E', '#3A3E46', '#191B20'] },
} as const satisfies Record<string, ModularPalettePreset>
export type ModularPresetName = keyof typeof MODULAR_PALETTE_PRESETS
export const MODULAR_PRESET_NAMES = Object.keys(MODULAR_PALETTE_PRESETS) as ModularPresetName[]

/** The params patch a preset applies (bg + rule + inks). */
export function modularPresetPatch(name: ModularPresetName): Pick<ModularParams, 'bg' | 'rule' | 'inks'> {
  const p = MODULAR_PALETTE_PRESETS[name]
  return { bg: p.bg, rule: p.rule, inks: [...p.inks] }
}

/** Which preset the params currently match (bg + rule + inks), if any. */
export function modularPresetOf(params: ModularParams): ModularPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of MODULAR_PRESET_NAMES) {
    const p = MODULAR_PALETTE_PRESETS[name]
    if (same(params.bg, p.bg) && same(params.rule, p.rule) && params.inks.length === p.inks.length
      && params.inks.every((c, i) => same(c, p.inks[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas fillStyle/strokeStyle accept both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex6 = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`. */
export function normalizeModular(partial: unknown, base: ModularParams = defaultModular()): ModularParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const wIn = (p.w && typeof p.w === 'object' ? p.w : {}) as Record<string, unknown>
  const w = {} as ModularWeights
  for (const t of MODULAR_TYPES) w[t] = num(wIn[t], MODULAR_LIMITS.weight[0], MODULAR_LIMITS.weight[1], base.w[t])
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex6) : base.inks.slice()
  return {
    gcols: Math.round(num(p.gcols, MODULAR_LIMITS.gcols[0], MODULAR_LIMITS.gcols[1], base.gcols)),
    unit: Math.round(num(p.unit, MODULAR_LIMITS.unit[0], MODULAR_LIMITS.unit[1], base.unit)),
    merge: num(p.merge, 0, 1, base.merge),
    w,
    blockFill: num(p.blockFill, 0, 1, base.blockFill),
    dot: num(p.dot, 0, 1, base.dot),
    rules: num(p.rules, 0, 1, base.rules),
    ruleW: num(p.ruleW, MODULAR_LIMITS.ruleW[0], MODULAR_LIMITS.ruleW[1], base.ruleW),
    bg: isHex6(p.bg) ? p.bg : base.bg,
    rule: isHex6(p.rule) ? p.rule : base.rule,
    inks,
  }
}

// ── Rule A: layout ───────────────────────────────────────────────────────────

/** One module of the composition. `x, y, w, h` are in MODULE units. */
export interface ModularRegion {
  x: number; y: number; w: number; h: number
  type: ModularType
  ci: number; ci2: number    // ordered-palette indices of the two inks (always distinct)
  onBg: boolean              // a blocks/dots/lines field drawn straight on the bg (no col2 ground)
  inset: 0 | 1 | 2           // how far a dot cluster is pulled in
  corner: number             // 0..3 which corner the cluster sits against (bit0 right, bit1 bottom)
  angle: number              // 0..3 gradient direction
  phase: number              // 0..1 (reserved for motion; drawn from the stream to keep parity)
}

/** Module rows from the box aspect: `max(2, round(gcols · H/W))`. */
export function modularRows(gcols: number, boxW: number, boxH: number): number {
  return Math.max(2, Math.round(gcols * (Math.max(1, boxH) / Math.max(1, boxW))))
}

/** Draw a type by cumulative weight over MODULAR_TYPES order (`r` in [0,1)). */
export function modularPickType(w: ModularWeights, r: number): ModularType {
  const total = MODULAR_TYPES.reduce((s, t) => s + w[t], 0) || 1
  let n = r * total
  for (const t of MODULAR_TYPES) { n -= w[t]; if (n <= 0) return t }
  return 'empty'
}

/**
 * Rule A — the composition over a `gc × gr` module grid, from ONE seeded stream in
 * raster order. Every module cell is claimed exactly once (a `taken` mask); merges
 * only happen where the 2×2 / 2×1 / 1×2 block is entirely free.
 */
export function modularRegions(params: ModularParams, gc: number, gr: number, paletteSize: number, seed: number): ModularRegion[] {
  const p = normalizeModular(params)
  const n = Math.max(1, Math.floor(paletteSize))
  const taken = new Uint8Array(gc * gr)
  const r = mulberry32(hashSeed(`${seed}:modular-layout`))
  const free = (x: number, y: number, w: number, h: number) => {
    if (x + w > gc || y + h > gr) return false
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (taken[j * gc + i]) return false
    return true
  }
  const out: ModularRegion[] = []
  for (let y = 0; y < gr; y++) {
    for (let x = 0; x < gc; x++) {
      if (taken[y * gc + x]) continue
      let w = 1, h = 1
      const k = r()
      if (k < p.merge * 0.32 && free(x, y, 2, 2)) { w = 2; h = 2 }
      else if (k < p.merge * 0.66 && free(x, y, 2, 1)) { w = 2 }
      else if (k < p.merge && free(x, y, 1, 2)) { h = 2 }
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) taken[j * gc + i] = 1
      const type = modularPickType(p.w, r())
      const ci = Math.min(n - 1, Math.floor(r() * n))
      const ci2 = n > 1 ? (ci + 1 + Math.floor(r() * (n - 1))) % n : 0
      const sub = r()
      const onBg = r() < 0.45
      const corner = Math.floor(r() * 4)
      const angle = Math.floor(r() * 4)
      const phase = r()
      out.push({ x, y, w, h, type, ci, ci2, onBg, inset: sub < 0.55 ? 0 : (sub < 0.8 ? 1 : 2), corner, angle, phase })
    }
  }
  return out
}

/** FLUSH integer edges: n spans between a and b, `edges[i] = round(a + (b−a)·i/n)`. */
export function modularEdges(n: number, a: number, b: number): number[] {
  const e: number[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) e[i] = Math.round(a + (b - a) * i / n)
  return e
}

/** The whole layout over a pixel box: module counts, pixel edges and the regions. */
export interface ModularLayout {
  gc: number; gr: number
  mx: number[]; my: number[]   // module edges in px (length gc+1 / gr+1)
  regions: ModularRegion[]
}

export function modularLayout(params: ModularParams, boxW: number, boxH: number, paletteSize: number, seed: number): ModularLayout {
  const p = normalizeModular(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const gc = p.gcols, gr = modularRows(gc, W, H)
  return { gc, gr, mx: modularEdges(gc, 0, W), my: modularEdges(gr, 0, H), regions: modularRegions(p, gc, gr, paletteSize, seed) }
}

// ── Rule B: the on/off field ─────────────────────────────────────────────────

/** Our own integer lattice hash → [0,1). Mixes (ix, iy, salt) with a few multiply /
 *  xor-shift rounds; every lattice point gets an independent value. */
function lattice(ix: number, iy: number, salt: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Smooth value noise in [0,1]: bilinear blend of the 4 lattice corners. */
export function valueNoise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const a = lattice(ix, iy, salt), b = lattice(ix + 1, iy, salt)
  const c = lattice(ix, iy + 1, salt), d = lattice(ix + 1, iy + 1, salt)
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
}

/** `octaves` of value noise, each at double frequency and half amplitude, normalised to [0,1]. */
export function fbm2(x: number, y: number, salt: number, octaves = 2): number {
  let v = 0, amp = 1, norm = 0, f = 1
  for (let o = 0; o < octaves; o++) {
    v += valueNoise(x * f, y * f, salt + o * 1013) * amp
    norm += amp; amp *= 0.5; f *= 2
  }
  return v / norm
}

/**
 * Rule B — a unit sub-cell (gx, gy) of the module at `regionIdx` is ON when the
 * 2-octave field (per-module salt `seed + idx·131 + 9`), stretched ×1.9 about .5 and
 * clamped to [0,1], falls below `blockFill`.
 */
export function modularCellOn(gx: number, gy: number, regionIdx: number, blockFill: number, seed: number): boolean {
  let v = fbm2(gx * 0.55, gy * 0.55, seed + regionIdx * 131 + 9, 2)
  v = Math.max(0, Math.min(1, (v - 0.5) * 1.9 + 0.5))
  return v < blockFill
}

// ── Rule C: dot clusters ─────────────────────────────────────────────────────

/** Rule C — the cluster's sub-cell rect inside a `uw × uh` sub-grid: shrunk by
 *  `inset·2` per side only where the side exceeds 2 sub-cells, pushed to `corner`. */
export function modularCluster(reg: Pick<ModularRegion, 'inset' | 'corner'>, uw: number, uh: number): { ox: number; oy: number; cw: number; ch: number } {
  const cw = Math.max(1, uw - reg.inset * (uw > 2 ? 2 : 0))
  const ch = Math.max(1, uh - reg.inset * (uh > 2 ? 2 : 0))
  return { ox: (reg.corner & 1) ? uw - cw : 0, oy: (reg.corner & 2) ? uh - ch : 0, cw, ch }
}

// ── Rule D: paint ────────────────────────────────────────────────────────────

/** The 4 gradient directions for a module `[x0, y0, x1, y1]`, by `angle`:
 *  left→right, top→bottom, top-left→bottom-right, top-right→bottom-left. */
export function modularGradEndpoints(angle: number, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const dirs: [number, number, number, number][] = [[x0, y0, x1, y0], [x0, y0, x0, y1], [x0, y0, x1, y1], [x1, y0, x0, y1]]
  return dirs[((angle % 4) + 4) % 4]!
}

/** Used only when no palette offers any ink — a graceful pair so the generator
 *  never throws (the real vocabularies all have several solids). */
const FALLBACK_INKS = ['#0e6bff', '#ff6259'] as const

/** The ORDERED palette a Modular deal paints with: its own `inks` when set, else
 *  the vocabulary's solids in declaration order, else the fallback pair. */
export function modularPalette(params: ModularParams, vocab: DealVocab): string[] {
  if (params.inks.length) return params.inks.slice()
  const solids = dealVocabItems(vocab).map(it => it.paint).filter((p): p is string => typeof p === 'string')
  return solids.length ? solids : [...FALLBACK_INKS]
}

/** The subset of a 2D context the paint needs — so a recording stub can stand in. */
export type ModularCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'fillRect' | 'createLinearGradient'
  | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'fill' | 'stroke'>

/**
 * Rule D — paint the composition at the ctx's origin over `boxW × boxH`: bg, each
 * module by its type, then the hairlines. `palette` is the ORDERED ink list.
 */
export function paintModular(ctx: ModularCtx, params: ModularParams, palette: readonly string[], boxW: number, boxH: number, seed: number): ModularLayout {
  const p = normalizeModular(params)
  const pal = palette.length ? palette : FALLBACK_INKS
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const layout = modularLayout(p, W, H, pal.length, seed)
  const { gc, gr, mx, my, regions } = layout
  const unit = p.unit
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, W, H)
  regions.forEach((reg, idx) => {
    const x0 = mx[reg.x]!, x1 = mx[reg.x + reg.w]!, y0 = my[reg.y]!, y1 = my[reg.y + reg.h]!
    const rw = x1 - x0, rh = y1 - y0
    const col = pal[reg.ci]!, col2 = pal[reg.ci2]!
    const uw = reg.w * unit, uh = reg.h * unit
    const ux = modularEdges(uw, x0, x1), uy = modularEdges(uh, y0, y1)
    if (reg.type === 'solid') {
      ctx.fillStyle = col
      ctx.fillRect(x0, y0, rw, rh)
    } else if (reg.type === 'grad') {
      // A plain 2-stop ramp col → col2 in one of 4 directions (no hue walk here).
      const [gx0, gy0, gx1, gy1] = modularGradEndpoints(reg.angle, x0, y0, x1, y1)
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1)
      g.addColorStop(0, col); g.addColorStop(1, col2)
      ctx.fillStyle = g
      ctx.fillRect(x0, y0, rw, rh)
    } else if (reg.type === 'blocks') {
      // Noise-thresholded block field, each row of ON sub-cells filled per run.
      if (!reg.onBg) { ctx.fillStyle = col2; ctx.fillRect(x0, y0, rw, rh) }
      ctx.fillStyle = col
      for (let j = 0; j < uh; j++) {
        let i = 0
        while (i < uw) {
          if (!modularCellOn(reg.x * unit + i, reg.y * unit + j, idx, p.blockFill, seed)) { i++; continue }
          let run = 1
          while (i + run < uw && modularCellOn(reg.x * unit + i + run, reg.y * unit + j, idx, p.blockFill, seed)) run++
          ctx.fillRect(ux[i]!, uy[j]!, ux[i + run]! - ux[i]!, uy[j + 1]! - uy[j]!)
          i += run
        }
      }
    } else if (reg.type === 'dots') {
      // A corner-aligned cluster of circles; `dot` is the diameter fraction.
      if (!reg.onBg) { ctx.fillStyle = col2; ctx.fillRect(x0, y0, rw, rh) }
      const { ox, oy, cw, ch } = modularCluster(reg, uw, uh)
      ctx.fillStyle = col
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
        const gx = reg.x * unit + ox + i, gy = reg.y * unit + oy + j
        if (!modularCellOn(gx, gy, idx + 77, p.blockFill, seed)) continue
        const cx = (ux[ox + i]! + ux[ox + i + 1]!) / 2, cy = (uy[oy + j]! + uy[oy + j + 1]!) / 2
        const rr = Math.min(ux[ox + i + 1]! - ux[ox + i]!, uy[oy + j + 1]! - uy[oy + j]!) * p.dot / 2
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill()
      }
    } else if (reg.type === 'lines') {
      // Interior sub-grid rules, crisp on the half-pixel.
      if (!reg.onBg) { ctx.fillStyle = col2; ctx.fillRect(x0, y0, rw, rh) }
      ctx.strokeStyle = col; ctx.lineWidth = p.ruleW; ctx.globalAlpha = 0.85
      ctx.beginPath()
      for (let i = 1; i < uw; i++) { const X = ux[i]! + 0.5; ctx.moveTo(X, y0); ctx.lineTo(X, y1) }
      for (let j = 1; j < uh; j++) { const Y = uy[j]! + 0.5; ctx.moveTo(x0, Y); ctx.lineTo(x1, Y) }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // 'empty': nothing — the background shows.
  })
  // The hairline structure over the WHOLE composition.
  if (p.rules > 0) {
    ctx.strokeStyle = p.rule; ctx.globalAlpha = p.rules; ctx.lineWidth = p.ruleW
    ctx.beginPath()
    for (let i = 1; i < gc; i++) { const X = mx[i]! + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, H) }
    for (let j = 1; j < gr; j++) { const Y = my[j]! + 0.5; ctx.moveTo(0, Y); ctx.lineTo(W, Y) }
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  return layout
}
