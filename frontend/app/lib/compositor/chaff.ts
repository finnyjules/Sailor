/**
 * Chaff — the playgrnd "Chaff" generator, rebuilt as the first STYLE of the Scatter
 * element (the `scatter` layer kind). The site carries no licence, so nothing here is
 * lifted: the rng, the hash, the noise and the shape of the file are ours. What is
 * kept is the RULE SET, because the rules are what make the look — a litter of BLADES
 * strewn over a sheet, each one an arc carrying a width profile, stencilled into a
 * coverage buffer at half resolution, then decided pixel by pixel into one of two inks
 * by a noise of two scales.
 *
 * Rule checklist — each entry names the captured reference's own lines
 * (`playgrnd-chaff-generator-reference.js`, line numbers in brackets):
 *
 *  A. THE THROW (chaffBlades)
 *   A1 [69] `count` blades, rounded and floored at 1. The source also ceilings that
 *      round at 1200 [60]; our Blades dial stops at 400 (CHAFF_LIMITS.count, read off
 *      the tool's own slider), so the ceiling is unreachable here and is not restated
 *      in code — the dial range subsumes it.
 *   A2 [66-67, 77-78] Lengths and spots are quoted against √(frame area), never
 *      against a side: `fw = 1/√aspect`, `fh = √aspect` (aspect = boxH/boxW). Two
 *      consequences the eye can see — widening the box spreads one throw further
 *      apart rather than crowding more marks into it, and a single seed reads as the
 *      same layout at thumbnail size and at print size. Spots are drawn across
 *      `-0.25 … 1.25` of each side, a quarter-frame apron all round, because a blade
 *      is meant to be cut by the frame edge as often as it is contained by it.
 *   A3 [72-75] `k = 1 + (u·u·3.2 − 0.5)·vary`, with `u` SQUARED before use. The square
 *      bends the distribution: P(k ≤ x) = √x, so the median length lands roughly
 *      quarter-way up the range where a linear roll would leave it halfway, and the
 *      top of the range is reached only rarely. Roll linearly instead and the lengths
 *      spread evenly, which the eye resolves into distinct sizes of blade rather than
 *      one continuous population.
 *   A4 [68, 80] `base = 0.06 + size·0.38`; `L = base · max(0.12, k)`. The floor stops
 *      a low `k` reducing a blade to a speck.
 *   A5 [79, 81-82] Heading, turn direction and a wobble sub-seed are drawn per blade
 *      from ONE stream keyed to the picture's seed [67] — our own rng
 *      (`mulberry32(hashSeed(...))`), pulled in the source's draw order so the
 *      structure of a variation matches.
 *   A6 [85-87] Sorted by descending length before anything is drawn. Draw order is the
 *      only depth a canvas has, so the sort decides which blades survive: with the
 *      giants laid down first every short blade drawn after them stays visible. Sort
 *      the other way and the small marks are simply covered over, and the picture
 *      loses a whole size class.
 *
 *  B. THE SILHOUETTE (chaffProfile) — every profile is a 0..1 multiplier on `wide`,
 *  evaluated at `t` (0 at the head, 1 at the tail) and reaching 0 at both ends. Three
 *  curves are on offer under `shape`, and `taper` is an exponent inside each of them,
 *  so one dial narrows a crescent's shoulders and lengthens a bar's end ramps.
 *   B1 [105] crescent — `sin(πt)^(0.45 + taper·1.4)`: a spindle, fattest at dead
 *      centre, thinning to nothing at either tip.
 *   B2 [100-104] leaf — `min(1, √(t/e))` with `e = 0.05 + taper·0.10`, times
 *      `(1−t)^(0.55 + taper·1.5)`: full width within the first few percent of the run,
 *      then a long fall to a tip. A comma rather than a spindle.
 *   B3 [95-99] bar — `min(1, √(t/e), √((1−t)/e))`, `e = 0.04 + taper·0.20`:
 *      flat-topped, holding one width for most of the run with a short ramp at each
 *      end; taper lengthens those ramps.
 *
 *  C. THE ARC AND ITS EDGES (chaffBladeOutline)
 *   C1 [113-127] N = 26 equal steps, the heading advancing by a constant
 *      `sweep·turn/N` and starting half the total turn behind the blade's own angle
 *      (`a0 = a − sweep·turn/2`), with `sweep = curve·2.3` [187]. Turning at a fixed
 *      rate over a fixed step length is what a circular arc IS, so the spine is walked
 *      out rather than solved for a centre and a radius: 26 sin/cos pairs cost nothing
 *      here, and `curve` 0 needs no case of its own because a zero increment simply
 *      walks straight ahead.
 *   C2 [117] `L = blade.L · scale · U`, `wide = L·(0.10 + slim·0.42)`: a blade's
 *      girth is quoted as a fraction of its own length, and `U = √(boxW·boxH)` is the
 *      one conversion from √area units into pixels. Note the knockout hands `slim`
 *      over already multiplied by its `pad` [201] and the source clamps NOTHING, so a
 *      padded copy at a high Width really is fatter than `0.52·L`.
 *   C3 [128-130] The 26 spine stations are averaged, and it is that average which is
 *      set down on the blade's spot. Skip the centring and Curve becomes a position
 *      dial as well as a shape dial — each blade would slide further from the spot the
 *      throw gave it as the bend came up, so the two would be impossible to tune
 *      independently.
 *   C4 [133-142] Each station's half-width is `profile · wide/2` times a noise
 *      reading `wob = 1 + (noise(t·2.9 + sd·0.11, sd·0.07, sd) − 0.5)·0.34`, stepped
 *      off both ways along the normal. Varying the width by up to ±17 % station to
 *      station is what keeps two blades of the same shape and length from arriving at
 *      identical outlines. NOTE: the reading is ONE value per station used on BOTH
 *      edges, so the outline stays symmetric about the spine and it is the WIDTH that
 *      varies along the blade. (The brief said "asymmetric wobble edges"; the source
 *      disagrees, and the source wins.)
 *   C5 [143-146] The two edges close into a single ring: every station along one side,
 *      then the same stations back along the other.
 *
 *  D. THE MASK (chaffMask)
 *   D1 [174-182] Rasterised at half the sheet's resolution, deliberately, for the blur
 *      that costs. Sampled back up bilinearly by the print, each silhouette boundary
 *      arrives spread over two or three pixels, and that spread is the only room the
 *      mottle has to act in: against a hard edge the noise can move one blended pixel
 *      and nothing else, so the blades keep a cut-out outline however high Mottle
 *      goes. Rasterising into 25 % as many pixels, and sampling 25 % as many back, is
 *      the incidental saving.
 *   D2 [184] The sheet starts as bare ground, everywhere.
 *   D3 [196-207] Every blade takes TWO fills on the mask: an enlarged outline
 *      (`pad = 1 + apart·0.5`, applied to the length and to the width alike) painted
 *      back to ground, then the blade itself painted into the hole that leaves.
 *      Nothing is ever stroked or offset to make the margin — it exists only because a
 *      blade wipes its surroundings before it prints, which means the clearance around
 *      a blade belongs to whichever blade went down last, and a later blade eats into
 *      the ones already on the sheet. With the dial down both fills land on the same
 *      outline and the throw closes up into one continuous silhouette.
 *   D4 [208-215] Below the `apart > 0.004` threshold no blade has anything to clear,
 *      so the mask can accumulate every outline into one path and close it with one
 *      fill: 2N canvas fills become 1. That saving is the reason for the threshold —
 *      otherwise `pad = 1` would run harmlessly but expensively through the branch
 *      above.
 *
 *  E. THE PRINT (chaffPixels)
 *   E1 [233-246] Coverage comes back off the half-size mask's green channel, sampled
 *      BILINEARLY into `G` in 0..1.
 *   E2 [221-225] Fleck size is derived from the sheet's own area — `U = √(W·H)`,
 *      `fine = U·(0.0022 + coarse·0.007)`, `big = fine·7.5` — so the lattice grows
 *      with the render. Bake at four times the preview's resolution and every fleck
 *      comes out four times as wide in pixels, which means the two prints differ in
 *      scale and in nothing else. Tie the lattice to the pixel instead and Coarseness
 *      would quietly mean something different at every zoom.
 *   E3 [226-231, 247-248] Two scales mixed 0.66 / 0.34 and multiplied by
 *      `amp = mottle·2.6`. The amplitude is allowed to carry `G + n` outside 0..1, and
 *      that is the difference between a mottle which only roughens outlines and one
 *      which works across the whole sheet: only an out-of-range sum can flip a pixel
 *      sitting at full coverage or at none. Without those flips a blade's interior and
 *      the bare sheet would both stay perfectly clean. Hold the amplitude
 *      to what the coverage ramp needs and the dial stops doing anything away from the
 *      edges.
 *   E4 [249] One comparison decides every pixel — `G + n > 0.5` takes `inks[1]`,
 *      anything else takes `inks[0]` [161-163]. The palette is ORDERED by role: entry
 *      0 is the sheet, entry 1 the mark laid on it, and a palette of one entry uses
 *      that entry for both.
 *   E5 [220, 250-254] Grain goes on last: `(hash − 0.5)·grain·52` added to r, g and b
 *      alike, then clamped. Ported with a box-space TOOTH (chaffGrainCellPx), because
 *      the source's hash is one value per pixel of its fixed 2400px export — 1/2400 of
 *      the box width — so preview and bake carry the same grain.
 *   E6 [258] Alpha is 255 everywhere: a Chaff sheet is a printed rectangle, not a
 *      cut-out.
 *
 *  NOT ported: the motion modes [160, 169-172 `drift` / `spin` / `swell`] and the
 *  ratio picker [4-5]. A Scatter is a still element and its box IS its frame, so every
 *  phase term sits at 0 and the aspect is read off the box — the same call the six
 *  earlier ports made.
 *
 * Host integration: the source sets no `globalAlpha` and no composite op, so neither
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
  coarse: number           // 0..1 the mottle's grain size
  grain: number            // 0..1 per-pixel print grain
  inks: string[]           // ORDERED roles: [ground, ink]
}

/** A named palette: the tool's own two-entry tables — the sheet's colour first, the
 *  mark's second (rule E4). */
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

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b, a]. Alpha is KEPT: an ink the picker made
 *  translucent (or Cleared to transparent) paints translucent, so a see-through ground
 *  lets the blades sit over whatever is beneath the layer. A 3- or 6-digit hex is opaque. */
function hexToRgb(hex: string): [number, number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [v(0), v(2), v(4), h.length === 8 ? v(6) : 255]
}

/** Used only when the palette is empty — the tool's own fallback pair [ref 161]. */
const FALLBACK_INKS = ['#C98A28', '#F2ECAC'] as const

/** The two roles a Chaff palette carries, in order (rule E4). */
export function chaffRoles(params: ChaffParams): { ground: string; ink: string } {
  const pal = params.inks?.length ? params.inks : FALLBACK_INKS
  return { ground: pal[0]!, ink: pal[1] ?? pal[0]! }
}

// ── Rule A: the throw ────────────────────────────────────────────────────────

/** One thrown blade. `x`/`y`/`L` are quoted in √(box area) units — the box covers
 *  `0..fw` × `0..fh`, `fw = 1/√aspect` and `fh = √aspect` — which is what lets a
 *  single throw describe one layout at every render size (rule A2). */
export interface ChaffBlade {
  x: number
  y: number
  a: number            // heading, radians
  L: number            // length, in units of √(box area)
  turn: -1 | 1         // which way its arc sweeps
  sd: number           // its own sub-seed (the wobble)
}

/**
 * Rule A — throw `count` blades over a `boxW × boxH` box from ONE seeded stream,
 * biggest first. Pure: the whole layout tests without a canvas.
 */
export function chaffBlades(params: ChaffParams, boxW: number, boxH: number, seed: number): ChaffBlade[] {
  const p = normalizeChaff(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  // A2 — √area units: fw·U = boxW and fh·U = boxH, so stretching the box moves the
  // spots apart without changing how long a blade is.
  const aspect = H / W
  const fw = 1 / Math.sqrt(aspect), fh = Math.sqrt(aspect)
  const rnd = mulberry32(hashSeed(`${seed}:chaff-blades`))
  const base = 0.06 + p.size * 0.38                                     // A4
  // A1 — the source's 1200 ceiling [ref 60] is unreachable under a 4..400 dial, so
  // only the round and the floor of 1 survive here.
  const n = Math.max(1, Math.round(p.count))
  const out: ChaffBlade[] = []
  for (let i = 0; i < n; i++) {
    // A3 — squaring `u` skews the lengths toward the base, with a long tail past it.
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
  // A6 — longest first: the shorter blades land later and so sit above them.
  out.sort((a, b) => b.L - a.L)
  return out
}

// ── Rule B: the silhouette ───────────────────────────────────────────────────

/**
 * Rule B — the width FACTOR at position `t` (0 at the head, 1 at the tail): a 0..1
 * fraction of `wide` that vanishes at each end. `shape` selects the curve, `taper`
 * moves its exponents.
 */
export function chaffProfile(t: number, shape: ChaffShape, taper: number): number {
  const tp = Math.max(0, Math.min(1, taper))
  if (shape === 'bar') {
    // B3 — flat-topped, ramping only close to the ends.
    const e = 0.04 + tp * 0.20
    const w = Math.min(1, Math.sqrt(t / e), Math.sqrt((1 - t) / e))
    return w > 0 ? w : 0
  }
  if (shape === 'leaf') {
    // B2 — full width almost at once, then a long fall to a tip.
    const e = 0.05 + tp * 0.10
    const head = Math.min(1, Math.sqrt(t / e))
    return head * Math.pow(1 - t, 0.55 + tp * 1.5)
  }
  // B1 — a spindle, fattest at the middle.
  return Math.pow(Math.sin(Math.PI * t), 0.45 + tp * 1.4)
}

// ── Rule C: the arc and its edges ────────────────────────────────────────────

/** How many stations the spine is marched in [ref 114]. Exported so the unit suite
 *  can pin the ring's exact point count rather than guessing at it. */
export const BLADE_STATIONS = 26

export interface ChaffOutlineOpts {
  /** The knockout's fattening factor (rule D3): scales BOTH the length and the width.
   *  At 1 (the default) the outline comes back unpadded. */
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
  // C2 — `slim` arrives multiplied by `pad` and the source clamps it nowhere [ref
  // 117, 201], so a knockout copy at a high Width is genuinely fatter than 0.52·L.
  const wide = L * (0.10 + p.slim * pad * 0.42)
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
  // C3 — set down the spine's mean, so Curve bends a blade without relocating it.
  const mx0 = sx / (N + 1), my0 = sy / (N + 1)
  const bx = blade.x * U - mx0, by = blade.y * U - my0
  const left: [number, number][] = [], right: [number, number][] = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const h = a0 + th * t
    const nx = -Math.sin(h), ny = Math.cos(h)
    // C4 — one noise reading per station, used on both edges (see the header's note).
    const wob = 1 + (chaffNoise(t * 2.9 + blade.sd * 0.11, blade.sd * 0.07, blade.sd) - 0.5) * 0.34
    const w = chaffProfile(t, p.shape, p.taper) * wide * 0.5 * wob
    const x = bx + cx[i]!, y = by + cy[i]!
    left.push([x + nx * w, y + ny * w])
    right.push([x - nx * w, y - ny * w])
  }
  // C5 — close the ring: one side forward, the other reversed onto the end of it.
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
    // D3 — erase an enlarged copy, then print the blade into the hole it left.
    const pad = 1 + p.apart * 0.5
    for (const b of blades) {
      ctx.fillStyle = MASK_GROUND
      ctx.beginPath(); trace(b, pad); ctx.fill()
      ctx.fillStyle = MASK_BLADE
      ctx.beginPath(); trace(b, 1); ctx.fill()
    }
    return
  }
  // D4 — nothing to erase: every blade joins one path, and the sheet takes one fill.
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
  // E2 — fleck size follows the sheet's area, so it grows with the render.
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
      // E3 — two scales; the amplitude is meant to leave the 0..1 band.
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
      out[q + 3] = col[3]                                           // E6
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
  // D1 — half resolution, so the bilinear read-back turns every boundary into a soft
  // ramp for the mottle to work in (and a quarter-area buffer is cheaper both ways).
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

/** Test seam — drops every cached sheet so cache-shape tests (eviction, memoization)
 *  don't depend on suite order. */
export function __resetChaffSheetCache(): void {
  sheetCache.clear()
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
