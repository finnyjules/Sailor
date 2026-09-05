/**
 * Carve — a line-faithful port of the playgrnd "Carve" generator, as the `carve`
 * cell fill of a generative `deal` layer (the Mosaic element's Carve style).
 * Reimplemented from the algorithm (the site has no licence; nothing here is
 * copied — our own rng, our own hash, our own structure), but every RULE of the
 * original is kept, because the rules ARE the look: ONE rectangle carved into
 * panels, each panel given one of five printed treatments in two palette inks.
 *
 * Rule checklist — each line maps to the captured reference
 * (`playgrnd-carve-generator-reference.js`, line numbers in brackets):
 *
 *  A. THE CARVE (carveSplit)
 *   A1 [56-57] The frame starts as ONE rect in 0..1 and is cut `max(1, round(cuts))`
 *      times, so a composition always has cuts+1 panels and never zero cuts.
 *   A2 [59-62] Each cut picks among the LARGEST FEW, not always the largest: the
 *      panels are ordered by area and the index is `min(n-1, ⌊r()·r()·3⌋)` — ~70%
 *      the biggest, ~23% the second, ~7% the third. Always-the-largest lays out
 *      like a spreadsheet.
 *   A3 [64-67] The cut runs across the LONG side in REAL proportions
 *      (`w ≥ h·aspect`, aspect = boxH/boxW), with an 18% chance of flipping to the
 *      short side.
 *   A4 [68] The split fraction is `0.5 + (r()−0.5)·min(0.92, uneven)·0.86`, i.e.
 *      0.5 ± uneven·0.43 — `uneven` 0 cuts dead centre.
 *   A5 [69-74] The picked rect is REPLACED by its two halves (the panels always
 *      tile the box exactly).
 *   A6 [76-78] The list is then sorted top-to-bottom, left-to-right, so a panel
 *      keeps its treatment when the list is rebuilt in another order.
 *   A7 [27-32, 55] ONE stream drives the whole layout, seeded from the picture's
 *      seed (our own rng — see `splitRng`).
 *
 *  B. THE TREATMENTS (carveTreatments) — one stream PER PANEL [82-83], keyed by
 *     the panel's sorted index, so a layout dial never reshuffles the treatments.
 *   B1 [84] `patterned = p() < mix`; an unpatterned panel is `flat`.
 *   B2 [81, 86-92] The drawn grid is a GUEST, not a tenant: at most ONE per
 *      composition, only on a panel under 0.3 of the box, and only when the roll
 *      is above 0.86. Otherwise roll < 0.34 ⇒ stripe, < 0.6 ⇒ chevron, else grain.
 *   B3 [94-95] Two inks: `a = ⌊p()·n⌋`, `b = (a + 1 + ⌊p()·(n−1)⌋) mod n` — always
 *      DISTINCT (a one-ink palette is the one exception, and must not loop).
 *   B4 [96] `dir` — stripes and chevrons run either way.
 *   B5 [97] `brk` in 0.3..0.75 — where a stripe panel changes pitch.
 *   B6 [98] Each panel gets its own sub-seed for its grain angle / grid dots.
 *
 *  C. THE PAINT (paintCarve)
 *   C1 [233] The ground is the palette's FIRST ink over the whole box (it shows
 *      through the gaps).
 *   C2 [235, 242-243] `gap = gap · min(W,H) · 0.02`, inset half a gap on every
 *      side, and no panel side ever falls below 1px.
 *   C3 [104] flat — one rect in ink A.
 *   C4 [106-135] stripe — ink A under bands of ink B at
 *      `base = max(3, (0.006 + pitch·0.075)·min(w,h) + 2)`, duty 1:2, phase
 *      `(panelSeed mod 7)/7 · pitch`, in TWO passes: the near side of `brk` at
 *      `base`, the far side at `base·1.9` — the "dropped signal".
 *   C5 [138-161] chevron — ink A under stacked 6-point arrows in ink B, clipped to
 *      the panel, `rows = max(2, round(h / max(14, min(w,h)·0.55)))` (off the SHORT
 *      side, never fewer than two), waist `t = 0.42`, pointing left or right by `dir`.
 *   C6 [165-194] grain — a per-pixel ramp A→B along the panel's OWN angle
 *      (`panelSeed mod 360`), plus a slow sine streak across the ramp (×11, ×0.06)
 *      and noise `(hash−0.5)·grain·104` TAPERED by `(1 − |t−0.5|·1.1)` so the pale
 *      end is not burnt out and the dark end is not blocked up.
 *   C7 [196-218] grid — ink A under a hairline lattice in ink B at
 *      `step = max(14, min(w,h)/(2 + round(gridDetail·6)))`, line width
 *      `max(1, min(w,h)·0.004)`, and a dot of radius `max(1.6, min(w,h)·0.016)` on
 *      the ~18% of nodes whose hash is above 0.82.
 *   C8 [8-16] The palette is 2 neutrals to hold the composition down + 4 loud inks
 *      to spend on the panels that shout; the five tables ship as named presets.
 *
 *  NOT ported: the motion modes [220-250 `T` / `roll` / `ph` / `shown`]. A Mosaic
 *  is a still composition, so every phase term is 0 here — the same call the five
 *  earlier ports made.
 *
 * Host integration: the source writes no `globalAlpha` and no composite op, so
 * neither does this — the layer's own opacity and blend, already on the ctx, ride
 * through. The one place that could break it is the grain: the source calls
 * `putImageData`, which ignores alpha, transform and clip alike, so here the ramp
 * is built on an OFFSCREEN canvas at the box's paint resolution and `drawImage`d
 * into the panel. DOM-free apart from that one canvas (and the pixel maths itself
 * is `carveGrainPixels`, a pure function), so every rule unit-tests without
 * mounting anything. The deal paint branch (drawLayerContent) translates to the
 * box and calls `paintCarve`.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { LruCache } from '~/lib/compositor/silhouetteCache'

/** The five treatments a panel can wear. */
export const CARVE_KINDS = ['flat', 'stripe', 'chev', 'grain', 'grid'] as const
export type CarveKind = typeof CARVE_KINDS[number]

/** The tunables, with the original's defaults (see defaultCarve). The two names
 *  that differ from the source's are spelled out: `pitch` → `stripePitch`,
 *  `nodes` → `gridDetail` (the tool's own labels are "Stripe pitch" / "Grid detail"). */
export interface CarveParams {
  cuts: number             // how many times the frame is cut (panels = cuts + 1)
  uneven: number           // 0..1 how far off centre a cut may fall (± uneven·0.43)
  gap: number              // 0..1 inset between panels (× min(W,H)·0.02)
  mix: number              // 0..1 fraction of panels that are patterned rather than flat
  stripePitch: number      // 0..1 band width of the striped panels
  grain: number            // 0..1 noise strength of the photographic panels
  gridDetail: number       // 0..1 how fine the one hairline grid panel is
  inks: string[]           // ORDERED palette: 2 neutrals (inks[0] is the ground) + 4 loud inks
}

/** A named palette: the tool's own tables, two neutrals then four loud inks. */
export interface CarvePalettePreset { inks: readonly string[] }

export const CARVE_PALETTE_PRESETS = {
  Report: { inks: ['#0B0B0B', '#E9E9E7', '#EF0A2B', '#FF2ECC', '#16216E', '#F5851F'] },
  Signal: { inks: ['#101010', '#EFEDE6', '#F5003C', '#00C2A0', '#1B1BE0', '#FFD400'] },
  Playbill: { inks: ['#0A0A0A', '#F2F0EA', '#FF5A1F', '#7CE860', '#2B2B8F', '#FF2D8B'] },
  Almanac: { inks: ['#141414', '#E4E2DC', '#D6006E', '#00A6A6', '#243B7A', '#F0B429'] },
  Broadsheet: { inks: ['#0C0C0C', '#EAE8E1', '#3B2FE0', '#FF7A00', '#00B24A', '#F20D3E'] },
} as const satisfies Record<string, CarvePalettePreset>
export type CarvePresetName = keyof typeof CARVE_PALETTE_PRESETS
export const CARVE_PRESET_NAMES = Object.keys(CARVE_PALETTE_PRESETS) as CarvePresetName[]

export function defaultCarve(): CarveParams {
  return {
    cuts: 7, uneven: 0.55, gap: 0, mix: 0.7,
    stripePitch: 0.4, grain: 0.5, gridDetail: 0.5,
    inks: [...CARVE_PALETTE_PRESETS.Report.inks],
  }
}

/** Bounds each param is clamped to (also the inspector's slider ranges — the same
 *  ranges the tool's own controls carry). */
export const CARVE_LIMITS = {
  cuts: [1, 16], uneven: [0, 1], gap: [0, 1], mix: [0, 1],
  stripePitch: [0, 1], grain: [0, 1], gridDetail: [0, 1],
} as const

/** The params patch a preset applies (the ordered ink list). */
export function carvePresetPatch(name: CarvePresetName): Pick<CarveParams, 'inks'> {
  return { inks: [...CARVE_PALETTE_PRESETS[name].inks] }
}

/** Which preset the params currently match (every ink, in order), if any. */
export function carvePresetOf(params: CarveParams): CarvePresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of CARVE_PRESET_NAMES) {
    const p = CARVE_PALETTE_PRESETS[name].inks
    if (params.inks?.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas fillStyle/strokeStyle accept both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`.
 *  Raw layer objects reach paint un-normalised, so every reader starts here. */
export function normalizeCarve(partial: unknown, base: CarveParams = defaultCarve()): CarveParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex) : base.inks.slice()
  return {
    cuts: Math.round(num(p.cuts, CARVE_LIMITS.cuts[0], CARVE_LIMITS.cuts[1], base.cuts)),
    uneven: num(p.uneven, 0, 1, base.uneven),
    gap: num(p.gap, 0, 1, base.gap),
    mix: num(p.mix, 0, 1, base.mix),
    stripePitch: num(p.stripePitch, 0, 1, base.stripePitch),
    grain: num(p.grain, 0, 1, base.grain),
    gridDetail: num(p.gridDetail, 0, 1, base.gridDetail),
    inks: inks.length ? inks : base.inks.slice(),
  }
}

// ── Rule A: the carve ────────────────────────────────────────────────────────

/** One panel of the composition, in 0..1 of the box (so one layout drives any size). */
export interface CarvePanel { x: number; y: number; w: number; h: number }

/** A panel with its treatment drawn (rule B). */
export interface CarveTreatedPanel extends CarvePanel {
  kind: CarveKind
  a: number                // palette index of the panel's ground ink
  b: number                // palette index of its mark ink (always ≠ a when the palette allows)
  dir: 0 | 1               // which way the stripes / chevrons run
  brk: number              // 0.3..0.75 — where a striped panel changes pitch
  seed: number             // the panel's own sub-seed (grain angle, grid dots)
}

/**
 * Rule A — carve the unit box into `cuts + 1` panels at `aspect` (= boxH/boxW),
 * from ONE seeded stream, sorted top-to-bottom then left-to-right.
 */
export function carveSplit(params: CarveParams, aspect: number, seed: number): CarvePanel[] {
  const p = normalizeCarve(params)
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const r = mulberry32(hashSeed(`${seed}:carve-split`))
  const rects: CarvePanel[] = [{ x: 0, y: 0, w: 1, h: 1 }]
  const cuts = Math.max(1, Math.round(p.cuts))
  for (let i = 0; i < cuts; i++) {
    // A2 — the largest few, biased hard towards the biggest.
    const order = rects.map((rect, k) => ({ k, area: rect.w * rect.h })).sort((u, v) => v.area - u.area)
    const pick = order[Math.min(order.length - 1, Math.floor(r() * r() * 3))]!.k
    const rect = rects[pick]!
    // A3 — across the long side in real proportions, flipped 18% of the time.
    const wide = rect.w >= rect.h * asp
    const vertical = r() < 0.18 ? !wide : wide
    // A4 — 0.5 ± uneven·0.43.
    const t = 0.5 + (r() - 0.5) * Math.min(0.92, p.uneven) * 0.86
    rects.splice(pick, 1)
    if (vertical) {
      rects.push({ x: rect.x, y: rect.y, w: rect.w * t, h: rect.h })
      rects.push({ x: rect.x + rect.w * t, y: rect.y, w: rect.w * (1 - t), h: rect.h })
    } else {
      rects.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h * t })
      rects.push({ x: rect.x, y: rect.y + rect.h * t, w: rect.w, h: rect.h * (1 - t) })
    }
  }
  // A6 — a stable reading order.
  rects.sort((u, v) => (u.y - v.y) || (u.x - v.x))
  return rects
}

// ── Rule B: the treatments ───────────────────────────────────────────────────

/**
 * Rule B — give every panel its treatment and its two inks, from a stream of its
 * own keyed by its sorted index. `paletteSize` is how many inks are on offer.
 */
export function carveTreatments(panels: readonly CarvePanel[], params: CarveParams, paletteSize: number, seed: number): CarveTreatedPanel[] {
  const p = normalizeCarve(params)
  const n = Math.max(1, Math.floor(paletteSize))
  let gridLeft = 1                       // B2 — the drawn grid is a guest, not a tenant
  return panels.map((rect, i) => {
    const q = mulberry32(hashSeed(`${seed}:carve-panel:${i}`))
    const patterned = q() < p.mix
    let kind: CarveKind = 'flat'
    if (patterned) {
      const roll = q()
      if (gridLeft > 0 && roll > 0.86 && rect.w * rect.h < 0.3) { kind = 'grid'; gridLeft-- }
      else if (roll < 0.34) kind = 'stripe'
      else if (roll < 0.6) kind = 'chev'
      else kind = 'grain'
    }
    const a = Math.min(n - 1, Math.floor(q() * n))
    const b = n > 1 ? (a + 1 + Math.floor(q() * (n - 1))) % n : a
    return {
      ...rect, kind, a, b,
      dir: q() < 0.5 ? 0 : 1,
      brk: 0.3 + q() * 0.45,
      seed: Math.floor(q() * 99999),
    }
  })
}

/** The whole layout over a pixel box: the carve at the box aspect, treated. */
export function carveLayout(params: CarveParams, boxW: number, boxH: number, paletteSize: number, seed: number): CarveTreatedPanel[] {
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  return carveTreatments(carveSplit(params, H / W, seed), params, paletteSize, seed)
}

// ── Rule C6: the grain ramp ──────────────────────────────────────────────────

/** Our own integer lattice hash → [0,1). Every (x, y, salt) gets an independent value. */
function carveHash(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 13; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b] (alpha is dropped: the ramp is opaque). */
function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [v(0), v(2), v(4)]
}

/**
 * Rule C6 — the photographic panel's pixels: a ramp `colA → colB` along the angle
 * `panelSeed mod 360`, bent by a slow sine streak across the ramp, roughened by
 * noise that tapers to nothing at both ends of the ramp. Returns RGBA for a
 * `w × h` block; pure, so the whole rule tests without a canvas.
 *
 * `cellPx` (buffer/device pixels, default 1 — the old per-device-pixel tooth) is the
 * noise lattice's tooth: the hash is looked up at `floor(i/cellPx), floor(j/cellPx)`,
 * not at the raw pixel, so the SAME tooth (in box units) survives any zoom/dpr and any
 * bake size — see `carveGrainCellPx`, which computes it from the box width so the tooth
 * always matches the source tool's fixed 2400px export.
 */
export function carveGrainPixels(w: number, h: number, colA: string, colB: string, grain: number, panelSeed: number, cellPx = 1): Uint8ClampedArray {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  const out = new Uint8ClampedArray(W * H * 4)
  const ca = hexToRgb(colA), cb = hexToRgb(colB)
  const g = Math.max(0, Math.min(1, grain))
  const cell = Number.isFinite(cellPx) && cellPx > 0 ? cellPx : 1
  const ang = (panelSeed % 360) * Math.PI / 180
  const ux = Math.cos(ang), uy = Math.sin(ang)
  for (let j = 0, p = 0; j < H; j++) {
    const v = j / H - 0.5
    for (let i = 0; i < W; i++, p += 4) {
      const u = i / W - 0.5
      let t = 0.5 + (u * ux + v * uy)
      t += Math.sin((u * uy - v * ux) * 11 + panelSeed) * 0.06
      t = t < 0 ? 0 : t > 1 ? 1 : t
      let r = ca[0] + (cb[0] - ca[0]) * t
      let gr = ca[1] + (cb[1] - ca[1]) * t
      let bl = ca[2] + (cb[2] - ca[2]) * t
      if (g > 0.002) {
        const n = (carveHash(Math.floor(i / cell), Math.floor(j / cell), panelSeed) - 0.5) * g * 104 * (1 - Math.abs(t - 0.5) * 1.1)
        r += n; gr += n; bl += n
      }
      out[p] = r; out[p + 1] = gr; out[p + 2] = bl; out[p + 3] = 255
    }
  }
  return out
}

/**
 * C6 device-vs-box fidelity — the grain lattice's tooth, in BUFFER (device) pixels.
 * The tool renders its export at a fixed 2400px width and its noise is one pixel of
 * that, so `1/2400` of the box WIDTH is the tooth in box units; multiplying by `scale`
 * (device px per box unit) turns that into the buffer pixels `carveGrainPixels` needs.
 * Floored at 1: a lattice finer than one device pixel cannot be resolved anyway, so a
 * small box (or a low device scale) clamps to the device-pixel tooth rather than going
 * sub-pixel and losing the noise entirely.
 */
export function carveGrainCellPx(scale: number, boxW: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const w = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  return Math.max(1, s * w / 2400)
}

// ── Rule C: paint ────────────────────────────────────────────────────────────

/** The subset of a 2D context the paint needs — so a recording stub can stand in. */
export type CarveCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'fillRect' | 'beginPath' | 'moveTo' | 'lineTo'
  | 'closePath' | 'fill' | 'stroke' | 'arc' | 'rect' | 'clip' | 'save' | 'restore' | 'drawImage'>
  & { getTransform?: () => { a: number; b: number } }

/** Used only when the palette is empty — a graceful pair so the generator never
 *  throws (every real palette ships six inks). */
const FALLBACK_INKS = ['#0B0B0B', '#E9E9E7'] as const

/** The per-pixel grain budget for ONE composition, whatever the box or the zoom
 *  (the tool's own ceiling is 2400²). Panels tile the box, so capping the box's
 *  paint resolution caps every grain panel together, and the grain stays the same
 *  size in every panel. */
const GRAIN_MAX_PIXELS = 6_000_000

/** How many device pixels one box unit is, from the ctx transform (1 when the ctx
 *  can't say — a recording stub, a fresh canvas). */
function ctxScale(ctx: CarveCtx): number {
  const m = ctx.getTransform?.()
  const s = Math.hypot(Number(m?.a ?? 1), Number(m?.b ?? 0))
  return Number.isFinite(s) && s > 0 ? s : 1
}

/** An offscreen canvas holding `pixels` at `w × h`, or null when this environment
 *  has no canvas to give (SSR, a stub) — the caller falls back to the plain ramp,
 *  which is what the tool's own SVG export ships too. */
function grainCanvas(w: number, h: number, pixels: Uint8ClampedArray): CanvasImageSource | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const cx = c.getContext('2d')
  if (!cx) return null
  const img = cx.createImageData(w, h)
  img.data.set(pixels)
  cx.putImageData(img, 0, 0)
  return c
}

/**
 * Grain panel cache — `carveGrainPixels` is a per-pixel CPU pass (tens of ms at a
 * typical preview box, ~100ms at the 6 Mpx cap), and every OTHER Mosaic style costs
 * microseconds. A drag only moves the box, never the panel's own pixels, so keying the
 * cache on everything that DOES determine those pixels (the panel's sub-seed, the
 * buffer size, the two inks, the grain amount, and the lattice cell from
 * `carveGrainCellPx`) makes a drag frame a cache hit. Bounded (insertion-order LRU,
 * `GRAIN_CACHE_CAP` entries) so a long session never grows it unboundedly — see
 * `LruCache` (shared with the torn-edge silhouette cache; same shape, same reason).
 */
const GRAIN_CACHE_CAP = 64
const grainPanelCache = new LruCache<CanvasImageSource>(GRAIN_CACHE_CAP)

function grainCanvasKey(gw: number, gh: number, colA: string, colB: string, grain: number, panelSeed: number, cellPx: number): string {
  return `${gw}x${gh}|${colA}|${colB}|${grain}|${panelSeed}|${cellPx}`
}

/** Memoized `grainCanvas`: a cache hit skips both `carveGrainPixels` and the
 *  offscreen canvas allocation entirely. */
function memoGrainCanvas(gw: number, gh: number, colA: string, colB: string, grain: number, panelSeed: number, cellPx: number): CanvasImageSource | null {
  const key = grainCanvasKey(gw, gh, colA, colB, grain, panelSeed, cellPx)
  const hit = grainPanelCache.get(key)
  if (hit) return hit
  const img = grainCanvas(gw, gh, carveGrainPixels(gw, gh, colA, colB, grain, panelSeed, cellPx))
  if (img) grainPanelCache.set(key, img)
  return img
}

/** C5 — the 6-point stacked arrow of one chevron row, `dir` deciding which way it
 *  points and `t` its waist. Pure geometry so the shape tests without a canvas. */
export function carveChevronRow(x: number, y0: number, w: number, step: number, dir: 0 | 1, t = 0.42): [number, number][] {
  const a = dir ? x : x + w, b = dir ? x + w : x
  return [
    [a, y0], [b, y0 + step * 0.5], [a, y0 + step],
    [a, y0 + step * (1 - t)], [b - (b - a) * (1 - t), y0 + step * 0.5], [a, y0 + step * t],
  ]
}

/**
 * Rule C — paint the composition at the ctx's origin over `boxW × boxH`: the
 * ground, then every panel by its treatment. `palette` is the ORDERED ink list.
 * Returns the treated panels so a caller (or a test) can read the composition back.
 */
export function paintCarve(ctx: CarveCtx, params: CarveParams, palette: readonly string[], boxW: number, boxH: number, seed: number): CarveTreatedPanel[] {
  const p = normalizeCarve(params)
  const pal = palette.length ? palette : FALLBACK_INKS
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const panels = carveLayout(p, W, H, pal.length, seed)
  // C1 — the ground.
  ctx.fillStyle = pal[0]!
  ctx.fillRect(0, 0, W, H)
  // C2 — the gap between panels, in units of the box's short side.
  const gap = p.gap * Math.min(W, H) * 0.02
  // C6's resolution: the device scale, held under the grain budget.
  const grainScale = Math.min(ctxScale(ctx), Math.sqrt(GRAIN_MAX_PIXELS / (W * H)))
  // C6's tooth: fixed to the box WIDTH (not the device scale alone), so preview and
  // bake show the same lattice — see carveGrainCellPx.
  const grainCell = carveGrainCellPx(grainScale, W)
  for (const panel of panels) {
    const x = panel.x * W + gap / 2, y = panel.y * H + gap / 2
    const w = Math.max(1, panel.w * W - gap), h = Math.max(1, panel.h * H - gap)
    const A = pal[panel.a] ?? pal[0]!, B = pal[panel.b] ?? pal[pal.length - 1]!
    if (panel.kind === 'stripe') paintStripePanel(ctx, p, panel, x, y, w, h, A, B)
    else if (panel.kind === 'chev') paintChevronPanel(ctx, panel, x, y, w, h, A, B)
    else if (panel.kind === 'grain') paintGrainPanel(ctx, p, panel, x, y, w, h, A, B, grainScale, grainCell)
    else if (panel.kind === 'grid') paintGridPanel(ctx, p, panel, x, y, w, h, A, B)
    else { ctx.fillStyle = A; ctx.fillRect(x, y, w, h) }   // C3 — flat
  }
  return panels
}

/** C4 — two-pitch bands, the pitch changing at `brk`: the dropped signal. */
function paintStripePanel(ctx: CarveCtx, p: CarveParams, panel: CarveTreatedPanel, x: number, y: number, w: number, h: number, A: string, B: string) {
  ctx.fillStyle = A
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = B
  const span = panel.dir ? h : w
  const base = Math.max(3, (0.006 + p.stripePitch * 0.075) * Math.min(w, h) + 2)
  const brk = (panel.dir ? w : h) * panel.brk
  for (let pass = 0; pass < 2; pass++) {
    const pitch = base * (pass ? 1.9 : 1)
    const bands = Math.ceil(span / (pitch * 2)) + 2
    const phase = ((panel.seed % 7) / 7) * pitch
    for (let i = -1; i < bands; i++) {
      const o = i * pitch * 2 + phase
      if (o + pitch < 0) continue
      if (panel.dir) {
        const yy = y + o
        if (yy > y + h) break
        const x0 = pass ? x + brk : x, x1 = pass ? x + w : x + brk
        if (x1 > x0) ctx.fillRect(x0, yy, x1 - x0, Math.min(pitch, y + h - yy))
      } else {
        const xx = x + o
        if (xx > x + w) break
        const y0 = pass ? y + brk : y, y1 = pass ? y + h : y + brk
        if (y1 > y0) ctx.fillRect(xx, y0, Math.min(pitch, x + w - xx), y1 - y0)
      }
    }
  }
}

/** C5 — stacked arrows, at least two, sized off the panel's SHORT side. */
function paintChevronPanel(ctx: CarveCtx, panel: CarveTreatedPanel, x: number, y: number, w: number, h: number, A: string, B: string) {
  ctx.fillStyle = A
  ctx.fillRect(x, y, w, h)
  const rows = Math.max(2, Math.round(h / Math.max(14, Math.min(w, h) * 0.55)))
  const step = h / rows
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.fillStyle = B
  for (let i = 0; i < rows; i++) {
    const poly = carveChevronRow(x, y + i * step, w, step, panel.dir)
    ctx.beginPath()
    poly.forEach((pt, k) => (k ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])))
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

/** C6 — the photographic panel, through an offscreen canvas so the layer's opacity,
 *  transform and box clip all still apply (putImageData would ignore all three).
 *  `cellPx` is the grain lattice tooth in buffer pixels (carveGrainCellPx), and the
 *  whole canvas is memoized (memoGrainCanvas) since a drag only moves the box, never
 *  these pixels. */
function paintGrainPanel(ctx: CarveCtx, p: CarveParams, panel: CarveTreatedPanel, x: number, y: number, w: number, h: number, A: string, B: string, scale: number, cellPx: number) {
  const gw = Math.max(1, Math.round(w * scale)), gh = Math.max(1, Math.round(h * scale))
  const img = memoGrainCanvas(gw, gh, A, B, p.grain, panel.seed, cellPx)
  if (img) { ctx.drawImage(img, x, y, w, h); return }
  // No canvas to render into: ship the ramp alone — exactly what the tool's own
  // SVG export does ("the ramp is what survives anywhere, the grain is there for
  // anything that renders SVG filters").
  ctx.fillStyle = A
  ctx.fillRect(x, y, w, h)
}

/** C7 — the one hairline grid, with a dot on ~18% of its nodes. */
function paintGridPanel(ctx: CarveCtx, p: CarveParams, panel: CarveTreatedPanel, x: number, y: number, w: number, h: number, A: string, B: string) {
  ctx.fillStyle = A
  ctx.fillRect(x, y, w, h)
  const step = Math.max(14, Math.min(w, h) / (2 + Math.round(p.gridDetail * 6)))
  const xs: number[] = [], ys: number[] = []
  for (let gx = x; gx <= x + w + 0.5; gx += step) xs.push(gx)
  for (let gy = y; gy <= y + h + 0.5; gy += step) ys.push(gy)
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.strokeStyle = B
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.004)
  ctx.beginPath()
  for (const gx of xs) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h) }
  for (const gy of ys) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy) }
  ctx.stroke()
  ctx.fillStyle = B
  const rad = Math.max(1.6, Math.min(w, h) * 0.016)
  xs.forEach((gx, i) => ys.forEach((gy, j) => {
    if (carveHash(i, j, panel.seed) > 0.82) { ctx.beginPath(); ctx.arc(gx, gy, rad, 0, Math.PI * 2); ctx.fill() }
  }))
  ctx.restore()
}
