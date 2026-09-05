/**
 * Chaff — a line-faithful port of the playgrnd "Chaff" generator, as the first
 * STYLE of the Scatter element (the `scatter` layer kind). Reimplemented from the
 * algorithm (the site has no licence; nothing here is copied — our own rng, our own
 * hash, our own noise, our own structure), but every RULE of the original is kept,
 * because the rules ARE the look: a handful of BLADES thrown at the paper, each an
 * arc with a width profile, printed through a half-size mask that a two-scale
 * mottle then thresholds into two inks.
 *
 * Rule checklist — each line maps to the captured reference
 * (`playgrnd-chaff-generator-reference.js`, line numbers in brackets):
 *
 *  A. THE THROW (chaffBlades)
 *   A1 [69] `count` blades: `min(1200, max(1, round(count)))` — the tool's own cap,
 *      under the dial's 4..400 range (CHAFF_LIMITS.count, the tool's slider).
 *   A2 [66-67, 77-78] Everything is measured in units of √(frame area): `fw = 1/√aspect`,
 *      `fh = √aspect` (aspect = boxH/boxW), so a wide box is not a busier box and a
 *      variation is the same picture at any size. A blade's spot runs
 *      `-0.25 … 1.25` of each side, so the big ones run OFF the edges instead of all
 *      sitting politely inside.
 *   A3 [72-75] The size spread is SQUARED: `k = 1 + (u·u·3.2 − 0.5)·vary`, so most
 *      blades sit near the base and a few run away large. A linear spread reads as
 *      two even ranks.
 *   A4 [68, 80] `base = 0.06 + size·0.38`; `L = base · max(0.12, k)` — a blade can
 *      never collapse to nothing.
 *   A5 [79, 81-82] Each blade gets its own heading, turn direction and sub-seed (its
 *      wobble), all off ONE stream seeded from the picture's seed [67] (our own rng —
 *      `mulberry32(hashSeed(...))`, drawn in the source's own order).
 *   A6 [85-87] Sorted BIGGEST FIRST, so the large blades sit at the back and the
 *      small ones read as lying on top rather than being swallowed.
 *
 *  B. THE SILHOUETTE (chaffProfile) — width at `t` along the blade, 0 at both ends.
 *   B1 [105] crescent — `sin(πt)^(0.45 + taper·1.4)`: pointed at both ends.
 *   B2 [100-104] leaf — a fast head ramp `min(1, √(t/e))`, `e = 0.05 + taper·0.10`,
 *      times `(1−t)^(0.55 + taper·1.5)`: blunt at one end, drawn to a point at the other.
 *   B3 [95-99] bar — `min(1, √(t/e), √((1−t)/e))`, `e = 0.04 + taper·0.20`: near
 *      enough parallel-sided the whole way, with taper widening the end ramps.
 *
 *  C. THE ARC AND ITS EDGES (chaffBladeOutline)
 *   C1 [113-127] The centre line is an ARC walked in N = 26 steps: the heading starts
 *      at `a0 = a − sweep·turn/2` and turns steadily by `sweep·turn` over the length,
 *      `sweep = curve·2.3` [187]. Walked rather than solved, so curve 0 is a straight
 *      stroke with no special branch.
 *   C2 [117] `L = blade.L · scale · U` and `wide = L·(0.10 + slim·0.42)` — the blade's
 *      girth is a fraction of its own length, and `U = √(boxW·boxH)` is what turns
 *      √area units into pixels.
 *   C3 [128-130] The blade hangs on its OWN MIDDLE (the mean of the centre stations),
 *      or Curve would swing it off its spot.
 *   C4 [133-142] At each station the edges are laid ±(profile · wide/2 · wob) along
 *      the normal, `wob = 1 + (noise(t·2.9 + sd·0.11, sd·0.07, sd) − 0.5)·0.34`: a
 *      slight swell of its own, so no two blades are the same casting. NOTE: the wobble
 *      is ONE value per station applied to BOTH edges — the outline is symmetric about
 *      the centre line and the WIDTH varies down the blade. (The brief called these
 *      "asymmetric wobble edges"; the source says otherwise, and the source wins.)
 *   C5 [143-146] One closed ring: down the left edge, back up the right.
 *
 *  D. THE MASK (chaffMask)
 *   D1 [174-182] Drawn at HALF size on purpose: a full-size mask has hard edges, so
 *      the mottle could only nibble the one anti-aliased pixel at the boundary and the
 *      result reads as plotted. Half size gives every edge a ramp a few pixels wide
 *      for the noise to bite into — and costs a quarter of the drawing and the reading.
 *   D2 [184] Bare ground over the whole sheet first.
 *   D3 [196-207] `apart` is a KNOCKOUT, not a gap drawn afterwards: each blade first
 *      clears a fatter copy of itself (`pad = 1 + apart·0.5`, scaling the length AND
 *      the width) back to ground, then prints itself inside that. Whatever was there
 *      loses. At nothing the pile merges into one silhouette; wound up, every blade
 *      carries its own margin.
 *   D4 [208-215] Below `apart > 0.004` the whole scatter is ONE path and ONE fill — a
 *      tenth of the drawing of the branch above.
 *
 *  E. THE PRINT (chaffPixels)
 *   E1 [233-246] The mask's coverage is read back BILINEARLY (it is half size), off
 *      its green channel, into `G` in 0..1.
 *   E2 [221-225] The mottle is sized off the PICTURE, not the pixel: `U = √(W·H)`,
 *      `fine = U·(0.0022 + coarse·0.007)`, `big = fine·7.5`. A 6000px export is the
 *      same picture as the preview, not a finer one.
 *   E3 [226-231, 247-248] Two scales added: `0.66·fine + 0.34·coarse`, times
 *      `amp = mottle·2.6`. It HAS to push past 1 and below 0, or a flat area of ink
 *      would stay flat: the overshoot is what puts pale flecks out in the open ground
 *      and dark ones in the middle of a blade.
 *   E4 [249] One threshold, two roles: `G + n > 0.5 ? ink : ground` [161-163] —
 *      `inks[0]` is the ground, `inks[1]` the one ink thrown across it (a one-ink
 *      palette prints itself).
 *   E5 [220, 250-254] Grain last: `(hash − 0.5)·grain·52` added to all three channels
 *      and clamped. Ported with a box-space TOOTH (chaffGrainCellPx) — the source's
 *      hash is one value per pixel of its fixed 2400px export, so 1/2400 of the box
 *      width is the tooth, and preview and bake print the same grain.
 *   E6 [258] Every pixel is opaque: a Chaff sheet is a printed rectangle.
 *
 *  NOT ported: the motion modes [160, 169-172 `drift` / `spin` / `swell`] and the
 *  ratio picker [4-5] — a Scatter is a still element whose box IS its frame, so every
 *  phase term is 0 and the aspect comes from the box. The same call the six earlier
 *  ports made.
 *
 * Host integration: the source writes no `globalAlpha` and no composite op, so neither
 * does this — the layer's own opacity and blend, already on the ctx, ride through. Its
 * `putImageData` would ignore alpha, transform and clip alike, so the whole sheet is
 * built on an OFFSCREEN canvas at the box's paint resolution (capped at 6 Mpx) and
 * `drawImage`d into the box. The sheet is memoized on everything that determines its
 * pixels, so a drag — which only moves the box — is a cache hit. Every rule above is a
 * pure function, so the port unit-tests without mounting anything.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { LruCache } from '~/lib/compositor/silhouetteCache'

/** The three silhouettes a blade can wear (rule B). */
export const CHAFF_SHAPES = ['crescent', 'leaf', 'bar'] as const
export type ChaffShape = typeof CHAFF_SHAPES[number]

/** The tunables, with the original's defaults (see `defaultChaff`). The tool's own
 *  control labels are Blades / Size / Variation / Separation · Shape / Curve / Width /
 *  Taper · Mottle / Coarseness / Grain — `slim` is the Width dial and `apart` is
 *  Separation; the field names stay the source's so the port reads against it. */
export interface ChaffParams {
  count: number            // 4..400 how many blades are thrown
  size: number             // 0..1 base blade length (in units of √box area)
  vary: number             // 0..1 how far the squared size spread runs
  apart: number            // 0..1 the knockout margin each blade clears for itself
  shape: ChaffShape        // crescent | leaf | bar
  curve: number            // 0..1 how far the centre line bends (0 = a straight stroke)
  taper: number            // 0..1 sharpens or blunts the profile's ends
  slim: number             // 0..1 the blade's girth as a fraction of its length (Width)
  mottle: number           // 0..1 how hard the two-scale noise chews the silhouette
  coarse: number           // 0..1 how big the mottle's flecks are
  grain: number            // 0..1 per-pixel print grain
  inks: string[]           // ORDERED roles: [ground, ink]
}

/** A named palette: the tool's own two-role tables (ground, then the ink thrown on it). */
export interface ChaffPalettePreset { inks: readonly string[] }

export const CHAFF_PALETTE_PRESETS = {
  Wheat: { inks: ['#C98A28', '#F2ECAC'] },
  Night: { inks: ['#12100E', '#E8E2D4'] },
  Brick: { inks: ['#E7E1D3', '#B8402C'] },
  Pine: { inks: ['#1E3A34', '#EFC85B'] },
  Blush: { inks: ['#F0DCE4', '#2C3E8F'] },
} as const satisfies Record<string, ChaffPalettePreset>
export type ChaffPresetName = keyof typeof CHAFF_PALETTE_PRESETS
export const CHAFF_PRESET_NAMES = Object.keys(CHAFF_PALETTE_PRESETS) as ChaffPresetName[]

export function defaultChaff(): ChaffParams {
  return {
    count: 40, size: 0.5, vary: 0.55, apart: 0,
    shape: 'crescent', curve: 0.7, taper: 0.3, slim: 0.45,
    mottle: 0.62, coarse: 0.4, grain: 0.3,
    inks: [...CHAFF_PALETTE_PRESETS.Wheat.inks],
  }
}

/** Bounds each dial is clamped to — the tool's own slider ranges (read off the
 *  tool page: Blades 4..400 step 1, every other dial 0..1 step 0.01). */
export const CHAFF_LIMITS = {
  count: [4, 400], size: [0, 1], vary: [0, 1], apart: [0, 1],
  curve: [0, 1], taper: [0, 1], slim: [0, 1],
  mottle: [0, 1], coarse: [0, 1], grain: [0, 1],
} as const

/** The params patch a preset applies (the two roles, in order). */
export function chaffPresetPatch(name: ChaffPresetName): Pick<ChaffParams, 'inks'> {
  return { inks: [...CHAFF_PALETTE_PRESETS[name].inks] }
}

/** Which preset the params currently match (both roles, in order), if any. */
export function chaffPresetOf(params: ChaffParams): ChaffPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of CHAFF_PRESET_NAMES) {
    const p = CHAFF_PALETTE_PRESETS[name].inks
    if (params.inks?.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas fillStyle accepts both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`.
 *  Raw layer objects reach paint un-normalised, so every reader starts here. */
export function normalizeChaff(partial: unknown, base: ChaffParams = defaultChaff()): ChaffParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex) : base.inks.slice()
  return {
    count: Math.round(num(p.count, CHAFF_LIMITS.count[0], CHAFF_LIMITS.count[1], base.count)),
    size: num(p.size, 0, 1, base.size),
    vary: num(p.vary, 0, 1, base.vary),
    apart: num(p.apart, 0, 1, base.apart),
    shape: CHAFF_SHAPES.includes(p.shape as ChaffShape) ? p.shape as ChaffShape : base.shape,
    curve: num(p.curve, 0, 1, base.curve),
    taper: num(p.taper, 0, 1, base.taper),
    slim: num(p.slim, 0, 1, base.slim),
    mottle: num(p.mottle, 0, 1, base.mottle),
    coarse: num(p.coarse, 0, 1, base.coarse),
    grain: num(p.grain, 0, 1, base.grain),
    inks: inks.length ? inks : base.inks.slice(),
  }
}

// ── Our own hash and value noise ─────────────────────────────────────────────

/** Integer lattice hash → [0,1). Every (x, y, salt) gets an independent value. */
function chaffHash(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x2545f491) ^ Math.imul(y | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smoothstep-interpolated value noise on that lattice → [0,1) (rules C4, E2-E3). */
function chaffNoise(x: number, y: number, salt: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = chaffHash(xi, yi, salt), b = chaffHash(xi + 1, yi, salt)
  const c = chaffHash(xi, yi + 1, salt), d = chaffHash(xi + 1, yi + 1, salt)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b] (alpha dropped: the sheet is opaque). */
function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [v(0), v(2), v(4)]
}

/** Used only when the palette is empty — the tool's own fallback pair [ref 161]. */
const FALLBACK_INKS = ['#C98A28', '#F2ECAC'] as const

/** The two roles a Chaff palette carries, in order (rule E4). */
export function chaffRoles(params: ChaffParams): { ground: string; ink: string } {
  const pal = params.inks?.length ? params.inks : FALLBACK_INKS
  return { ground: pal[0]!, ink: pal[1] ?? pal[0]! }
}

// ── Rule A: the throw ────────────────────────────────────────────────────────

/** One thrown blade. `x`/`y`/`L` are in units of √(box area) — the box spans
 *  `0..fw` × `0..fh` where `fw = 1/√aspect`, `fh = √aspect` — so one throw is the
 *  same picture at any render size (rule A2). */
export interface ChaffBlade {
  x: number
  y: number
  a: number            // heading, radians
  L: number            // length, in units of √(box area)
  turn: -1 | 1         // which way its arc sweeps
  sd: number           // its own sub-seed (the wobble)
}

/** The tool's own hard ceiling on how many blades one picture may hold [ref 60]. */
export const CHAFF_BLADE_CAP = 1200

/**
 * Rule A — throw `count` blades over a `boxW × boxH` box from ONE seeded stream,
 * biggest first. Pure: the whole layout tests without a canvas.
 */
export function chaffBlades(params: ChaffParams, boxW: number, boxH: number, seed: number): ChaffBlade[] {
  const p = normalizeChaff(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  // A2 — √area units: fw·U = boxW and fh·U = boxH, so a wide box spreads wider
  // without the blades themselves growing.
  const aspect = H / W
  const fw = 1 / Math.sqrt(aspect), fh = Math.sqrt(aspect)
  const rnd = mulberry32(hashSeed(`${seed}:chaff-blades`))
  const base = 0.06 + p.size * 0.38                                     // A4
  const n = Math.min(CHAFF_BLADE_CAP, Math.max(1, Math.round(p.count))) // A1
  const out: ChaffBlade[] = []
  for (let i = 0; i < n; i++) {
    // A3 — the spread is SQUARED, so most sit near the base and a few run away large.
    const u = rnd()
    const k = 1 + (u * u * 3.2 - 0.5) * p.vary
    out.push({
      x: (-0.25 + rnd() * 1.5) * fw,
      y: (-0.25 + rnd() * 1.5) * fh,
      a: rnd() * Math.PI * 2,
      L: base * Math.max(0.12, k),
      turn: rnd() < 0.5 ? -1 : 1,
      sd: Math.floor(rnd() * 9973),
    })
  }
  // A6 — biggest first: the large blades sit at the back.
  out.sort((a, b) => b.L - a.L)
  return out
}

// ── Rule B: the silhouette ───────────────────────────────────────────────────

/**
 * Rule B — how wide the blade is at `t` (0..1) along it, from nothing at 0 to
 * nothing at 1. The shape picks the profile; `taper` sharpens or blunts it.
 */
export function chaffProfile(t: number, shape: ChaffShape, taper: number): number {
  const tp = Math.max(0, Math.min(1, taper))
  if (shape === 'bar') {
    // B3 — parallel-sided, with a short ramp at each end.
    const e = 0.04 + tp * 0.20
    const w = Math.min(1, Math.sqrt(t / e), Math.sqrt((1 - t) / e))
    return w > 0 ? w : 0
  }
  if (shape === 'leaf') {
    // B2 — a blunt head, drawn to a point at the tail.
    const e = 0.05 + tp * 0.10
    const head = Math.min(1, Math.sqrt(t / e))
    return head * Math.pow(1 - t, 0.55 + tp * 1.5)
  }
  // B1 — pointed at both ends.
  return Math.pow(Math.sin(Math.PI * t), 0.45 + tp * 1.4)
}

// ── Rule C: the arc and its edges ────────────────────────────────────────────

/** How many stations the centre line is walked in [ref 114]. */
const BLADE_STATIONS = 26

export interface ChaffOutlineOpts {
  /** The knockout's fattening factor (rule D3): scales BOTH the length and the width.
   *  1 (the default) is the blade itself. */
  pad?: number
}

/**
 * Rule C — the closed outline of ONE blade over a `boxW × boxH` box, in box pixels:
 * `BLADE_STATIONS + 1` points down the left edge, then the same count back up the
 * right. Pure geometry, so the arc, the hang-on-its-middle and the width all test
 * without a canvas.
 */
export function chaffBladeOutline(
  blade: ChaffBlade, params: ChaffParams, boxW: number, boxH: number, opts: ChaffOutlineOpts = {},
): [number, number][] {
  const p = normalizeChaff(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  const U = Math.sqrt(W * H)                                    // C2 — √area → pixels
  const pad = Number.isFinite(opts.pad) && (opts.pad as number) > 0 ? opts.pad as number : 1
  const N = BLADE_STATIONS
  const L = blade.L * pad * U
  const wide = L * (0.10 + Math.min(1, p.slim * pad) * 0.42)
  const sweep = p.curve * 2.3                                   // C1
  const th = sweep * blade.turn
  const a0 = blade.a - th * 0.5
  const step = L / N
  // C1 — walk the arc: record the station, THEN step, so station 0 is the origin.
  const cx = new Array<number>(N + 1), cy = new Array<number>(N + 1)
  let px = 0, py = 0, sx = 0, sy = 0
  for (let i = 0; i <= N; i++) {
    cx[i] = px; cy[i] = py; sx += px; sy += py
    const h = a0 + th * (i / N)
    px += Math.cos(h) * step; py += Math.sin(h) * step
  }
  // C3 — hang the blade on its own middle, or Curve swings it off its spot.
  const mx0 = sx / (N + 1), my0 = sy / (N + 1)
  const bx = blade.x * U - mx0, by = blade.y * U - my0
  const left: [number, number][] = [], right: [number, number][] = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const h = a0 + th * t
    const nx = -Math.sin(h), ny = Math.cos(h)
    // C4 — one swell per station, applied to both edges (see the note in the header).
    const wob = 1 + (chaffNoise(t * 2.9 + blade.sd * 0.11, blade.sd * 0.07, blade.sd) - 0.5) * 0.34
    const w = chaffProfile(t, p.shape, p.taper) * wide * 0.5 * wob
    const x = bx + cx[i]!, y = by + cy[i]!
    left.push([x + nx * w, y + ny * w])
    right.push([x - nx * w, y - ny * w])
  }
  // C5 — one closed ring: down the left edge, back up the right.
  right.reverse()
  return [...left, ...right]
}

// ── Rule D: the mask ─────────────────────────────────────────────────────────

/** The subset of a 2D context the mask draw needs — so a recording stub can stand in. */
export type ChaffMaskCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'fillRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill'>

/** The mask's two values: bare ground, and the blade printed on it. Read back off
 *  the GREEN channel (rule E1), so the "ink" value must have full green. */
const MASK_GROUND = '#000000'
const MASK_BLADE = '#00ff00'

/** Below this, Separation does nothing and the cheap single-path branch runs [ref 196]. */
const APART_EPS = 0.004

/** Rule D — draw the silhouette sheet over a `mw × mh` mask context. */
export function chaffMask(ctx: ChaffMaskCtx, params: ChaffParams, mw: number, mh: number, seed: number): void {
  const p = normalizeChaff(params)
  const W = Math.max(1, mw), H = Math.max(1, mh)
  // D2 — bare ground first.
  ctx.fillStyle = MASK_GROUND
  ctx.fillRect(0, 0, W, H)
  const blades = chaffBlades(p, W, H, seed)
  const trace = (b: ChaffBlade, pad: number) => {
    const pts = chaffBladeOutline(b, p, W, H, { pad })
    ctx.moveTo(pts[0]![0], pts[0]![1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1])
    ctx.closePath()
  }
  if (p.apart > APART_EPS) {
    // D3 — the knockout: clear a fatter copy back to ground, then print inside it.
    const pad = 1 + p.apart * 0.5
    for (const b of blades) {
      ctx.fillStyle = MASK_GROUND
      ctx.beginPath(); trace(b, pad); ctx.fill()
      ctx.fillStyle = MASK_BLADE
      ctx.beginPath(); trace(b, 1); ctx.fill()
    }
    return
  }
  // D4 — nothing knocks anything out, so the whole scatter is one path and one fill.
  ctx.fillStyle = MASK_BLADE
  ctx.beginPath()
  for (const b of blades) trace(b, 1)
  ctx.fill()
}

// ── Rule E: the print ────────────────────────────────────────────────────────

/**
 * E5 device-vs-box fidelity — the grain lattice's tooth, in BUFFER (device) pixels.
 * The tool renders its export at a fixed 2400px width and its grain is one value per
 * pixel of that, so `1/2400` of the box WIDTH is the tooth in box units; `scale`
 * (device px per box unit) turns that into the buffer pixels `chaffPixels` needs.
 * Floored at 1: a lattice finer than one device pixel cannot be resolved anyway, so a
 * small box clamps to the device-pixel tooth rather than losing the grain entirely.
 */
export function chaffGrainCellPx(scale: number, boxW: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const w = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  return Math.max(1, s * w / 2400)
}

/**
 * Rule E — print the sheet: read the half-size mask back bilinearly, add the
 * two-scale mottle, threshold into the two roles, then grain. `mask` is RGBA of
 * `mw × mh` (the green channel is the coverage); returns RGBA for `w × h`. Pure, so
 * every rule of the print tests without a canvas.
 */
export function chaffPixels(
  mask: Uint8ClampedArray, mw: number, mh: number, w: number, h: number,
  params: ChaffParams, seed: number, grainCell = 1,
): Uint8ClampedArray {
  const p = normalizeChaff(params)
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  const MW = Math.max(1, Math.round(mw)), MH = Math.max(1, Math.round(mh))
  const out = new Uint8ClampedArray(W * H * 4)
  const { ground, ink } = chaffRoles(p)
  const cg = hexToRgb(ground), ci = hexToRgb(ink)
  const s = seed | 0
  const gl = p.grain * 52                                        // E5
  const cell = Number.isFinite(grainCell) && grainCell > 0 ? grainCell : 1
  // E2 — sized off the picture, not the pixel.
  const U = Math.sqrt(W * H)
  const fine = Math.max(1e-6, U * (0.0022 + p.coarse * 0.007))
  const big = fine * 7.5
  const amp = p.mottle * 2.6                                     // E3
  const sx = MW / W, sy = MH / H                                 // E1 — half-size read-back
  for (let y = 0; y < H; y++) {
    const gy = y * sy
    let y0 = gy | 0; if (y0 > MH - 1) y0 = MH - 1
    const fy = gy - y0
    let y1 = y0 + 1; if (y1 > MH - 1) y1 = MH - 1
    const r0 = y0 * MW * 4, r1 = y1 * MW * 4
    let q = y * W * 4
    for (let x = 0; x < W; x++, q += 4) {
      const gx = x * sx
      let x0 = gx | 0; if (x0 > MW - 1) x0 = MW - 1
      const fx = gx - x0
      let x1 = x0 + 1; if (x1 > MW - 1) x1 = MW - 1
      const i00 = r0 + x0 * 4, i01 = r0 + x1 * 4, i10 = r1 + x0 * 4, i11 = r1 + x1 * 4
      const Ga = mask[i00 + 1]! + (mask[i01 + 1]! - mask[i00 + 1]!) * fx
      const Gb = mask[i10 + 1]! + (mask[i11 + 1]! - mask[i10 + 1]!) * fx
      const G = (Ga + (Gb - Ga) * fy) / 255
      // E3 — two scales, overshooting past 0 and 1 on purpose.
      const n = ((chaffNoise(x / fine, y / fine, s + 41) - 0.5) * 0.66
        + (chaffNoise(x / big, y / big, s + 13) - 0.5) * 0.34) * amp
      // E4 — one threshold, two roles.
      const col = (G + n > 0.5) ? ci : cg
      let r = col[0], g = col[1], b = col[2]
      if (gl > 0.002) {
        const j = (chaffHash(Math.floor(x / cell), Math.floor(y / cell), s + 71) - 0.5) * gl
        r += j; g += j; b += j
      }
      out[q] = r; out[q + 1] = g; out[q + 2] = b
      out[q + 3] = 255                                           // E6
    }
  }
  return out
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The subset of a 2D context `paintChaff` needs (a recording stub can stand in). */
export type ChaffCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'drawImage'>
  & { getTransform?: () => { a: number; b: number } }

/** The per-pixel budget for ONE sheet, whatever the box or the zoom (the tool's own
 *  ceiling is 2400²). */
const CHAFF_MAX_PIXELS = 6_000_000

/** How many device pixels one box unit is, from the ctx transform (1 when the ctx
 *  can't say — a recording stub, a fresh canvas). */
function ctxScale(ctx: ChaffCtx): number {
  const m = ctx.getTransform?.()
  const s = Math.hypot(Number(m?.a ?? 1), Number(m?.b ?? 0))
  return Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * Sheet cache — the print is a per-pixel CPU pass over the whole box (tens of ms at a
 * preview size, ~150 ms at the 6 Mpx cap) plus a mask rasterisation. A drag only moves
 * the box, never the sheet's own pixels, so keying on everything that DOES determine
 * them (the buffer size, every dial, the two inks, the seed and the grain tooth) makes
 * a drag frame a cache hit. Bounded by BOTH an entry count and a byte budget — one
 * capped sheet is 24 MB, so a count-only cap would hold a gigabyte of dead canvases.
 */
const SHEET_CACHE_CAP = 12
const SHEET_CACHE_BYTES = 128 * 1024 * 1024
const sheetCache = new LruCache<{ img: CanvasImageSource; bytes: number }>(SHEET_CACHE_CAP, {
  maxBytes: SHEET_CACHE_BYTES,
  sizeOf: v => v.bytes,
})

function sheetKey(pw: number, ph: number, p: ChaffParams, seed: number, cell: number): string {
  return [
    pw, ph, seed, cell.toFixed(4),
    p.count, p.size, p.vary, p.apart, p.shape, p.curve, p.taper, p.slim,
    p.mottle, p.coarse, p.grain, p.inks.join(','),
  ].join('|')
}

/** Build one printed sheet at `pw × ph`, or null when this environment has no canvas
 *  to give (SSR, a stub without createElement). */
function renderSheet(pw: number, ph: number, p: ChaffParams, seed: number, cell: number): CanvasImageSource | null {
  if (typeof document === 'undefined') return null
  // D1 — the mask is drawn at HALF size, so every edge has a ramp for the mottle to
  // bite into (and it costs a quarter of the drawing and the reading back).
  const mw = Math.max(2, Math.round(pw * 0.5)), mh = Math.max(2, Math.round(ph * 0.5))
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = mw; maskCanvas.height = mh
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!mctx) return null
  chaffMask(mctx, p, mw, mh, seed)
  const maskData = mctx.getImageData(0, 0, mw, mh).data
  const sheet = document.createElement('canvas')
  sheet.width = pw; sheet.height = ph
  const sctx = sheet.getContext('2d')
  if (!sctx) return null
  const img = sctx.createImageData(pw, ph)
  img.data.set(chaffPixels(maskData, mw, mh, pw, ph, p, seed, cell))
  sctx.putImageData(img, 0, 0)
  return sheet
}

/** Memoized `renderSheet` — a hit skips the mask raster AND the per-pixel pass. */
function memoSheet(pw: number, ph: number, p: ChaffParams, seed: number, cell: number): CanvasImageSource | null {
  const key = sheetKey(pw, ph, p, seed, cell)
  const hit = sheetCache.get(key)
  if (hit) return hit.img
  const img = renderSheet(pw, ph, p, seed, cell)
  if (img) sheetCache.set(key, { img, bytes: pw * ph * 4 })
  return img
}

/**
 * Paint one Chaff sheet at the ctx's origin over `boxW × boxH`. The sheet is built
 * offscreen at the box's paint resolution (held under CHAFF_MAX_PIXELS) and drawn in,
 * so the layer's opacity, blend, transform and box clip all still apply — the source's
 * own `putImageData` would ignore every one of them.
 */
export function paintChaff(ctx: ChaffCtx, params: ChaffParams, boxW: number, boxH: number, seed: number): void {
  const p = normalizeChaff(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  const scale = Math.min(ctxScale(ctx), Math.sqrt(CHAFF_MAX_PIXELS / (W * H)))
  const pw = Math.max(2, Math.round(W * scale)), ph = Math.max(2, Math.round(H * scale))
  const img = memoSheet(pw, ph, p, seed, chaffGrainCellPx(scale, W))
  if (img) { ctx.drawImage(img, 0, 0, W, H); return }
  // No canvas to render into (SSR / a stub): lay the ground down alone, so the box is
  // the picture's colour rather than a hole.
  ctx.fillStyle = chaffRoles(p).ground
  ctx.fillRect(0, 0, W, H)
}
