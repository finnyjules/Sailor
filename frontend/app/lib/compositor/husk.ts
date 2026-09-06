/**
 * Husk — the playgrnd "Husk" generator, rebuilt as the third STYLE of the Scatter
 * element (the `scatter` layer kind). The site publishes no licence, so nothing here
 * is lifted: the rng, the hash, the noise and the shape of this file are ours. What
 * carries over is the RULE SET, because the rules are what make the look.
 *
 * Husk differs from its two siblings in what it draws INTO. Chaff and Strand stencil
 * their marks onto a mask canvas; a husk is never stencilled at all. Every warped oval
 * writes a DEPTH across the cells it covers — 1 under its centre, tailing off to 0 at
 * its rim — and all of them write into one small shared grid. A cell under two husks
 * keeps only the higher depth. The print then reads that grid back between its cells
 * and settles one question per pixel: sheet, body, or surviving fill — the body/fill
 * decision is made per pixel from the depth alone, which is what gives overlapping
 * husks one outline and two separate cores.
 *
 * Rule checklist — the bracketed numbers are lines of the captured reference
 * (`playgrnd-husk-generator-reference.js`), so a reviewer can read the port against
 * the source as code:
 *
 *  A. THE THROW (huskShapes)
 *   A1 [76] `count` husks, rounded, at least one. The dial stops at 70 (HUSK_LIMITS,
 *      read off the tool's own slider).
 *   A2 [85] Centres are drawn over `-0.12 … 1.12` of each side, an apron of about an
 *      eighth of a side beyond every edge, so husks are cut by the box as readily as
 *      they sit inside it.
 *   A3 [81, 86] `base = (0.045 + size·0.115)·√(FW·FH)`, and each radius is
 *      `base·(1 + (u − 0.5)·2·vary·0.7)` — ±70 % of base at Size range 1. Quoting a
 *      size against √(FW·FH) is what stops a stretched box reading as a busier one:
 *      widening it pushes the husks apart instead of adding any.
 *   A4 [87] Two independent axis factors, each `0.78 + u·0.5`. Drawing them apart is
 *      what makes ovals of them; one shared draw would leave circles of varying size.
 *   A5 [88-90] Per husk: a rotation, then a phase the motion modes use, then three
 *      harmonic phases and three lobe counts — 2..3, 4..6 and 7..9. The motion phase
 *      is still drawn (`rnd()` with nothing bound) so the stream keeps the source's
 *      shape even though this port never animates.
 *   A6 [67, 75] One seeded stream per picture, drawn in the source's own order.
 *
 *  B. THE GRID (huskFieldSize, huskDepthField)
 *   B1 [72-73] The LONGER side gets 560 cells and the shorter one follows the box's
 *      proportions, with a floor of 8 either way. The grid is therefore fixed by the
 *      box's shape alone: one variation is the same picture on a thumbnail and on a
 *      bake, and the cost of building it does not move with the render size.
 *   B2 [74] A Float32 cell per grid point, zero meaning no husk reached it.
 *   B3 [82] `lump = lumpiness·0.55`, so the dial's full travel bends a rim by just
 *      over half its radius.
 *   B4 [93-96] Each husk touches only the cells inside `R·(1+lump)·max(ex,ey) + 2` of
 *      its centre, clipped to the grid; a husk whose box misses the grid is dropped.
 *   B5 [102-104] A cell is put into each husk's local frame — turned by its rotation,
 *      then divided by the two axis factors — and anything past `R·(1+lump)` there is
 *      dropped before the harmonics are evaluated at all.
 *   B6 [106] Three sines of the angle carry the rim: weights 0.5, 0.33 and 0.2 on the
 *      2-3, 4-6 and 7-9 lobe harmonics. Three of them at these weights is what stops
 *      the rim reading as a regular scallop; noise evaluated at every cell would buy
 *      the same irregularity for a great deal more work.
 *   B7 [107-109] `edge = R·(1 + lump·s)`; a cell at `dist` inside that rim is recorded
 *      as `1 − dist/edge`, so the number is a fraction of the LOCAL radius rather than
 *      a distance — a small husk and a large one both reach 1 at their middles.
 *   B8 [110] Overlaps keep the LARGER of the two numbers. Nothing is ever painted over
 *      anything, so the throw's order cannot change the picture (pinned by test).
 *
 *  C. THE PRINT (huskPixels)
 *   C1 [120-123] The palette is read as three jobs, and its order names them: the
 *      sheet, then the ink a husk's body takes, then the ink its fill takes. Under
 *      three entries and a role repeats whichever came before it.
 *   C2 [128, 142-154] The grid is read back BILINEARLY (it is far coarser than the
 *      sheet), with both axes clamping at the last row and column rather than wrapping.
 *   C3 [157] At 0.001 or below no husk is here: the ground prints, and neither bite is
 *      consulted.
 *   C4 [130-133, 160-166] Bite = dots: a screen on a lattice of
 *      `max(3, (0.004 + tex·0.03)·min(W,H))` pixels, each cell holding a dot of radius
 *      `0.52·√v·(1.35 − eat·0.85)` with `v = clamp((dep − 0.05)/0.95)`. Taking the root
 *      puts a dot's AREA, not its radius, in step with the depth, so coverage falls off
 *      at the same rate the husk does.
 *   C5 [137, 168, 173-174] Bite = crumble: three octaves of value noise run through a
 *      smoothstep, which crowds the readings against 0 and 1, and the fill lives only
 *      where
 *      `dep > 0.02 + eat·(0.06 + 1.5·nse)`. With the 1.5 the threshold can exceed 1,
 *      the deepest value a husk holds, so at high `eat` whole regions of a core fail
 *      the test — the fill survives only as separate patches.
 *   C6 [176-177] Kept ⇒ the fill ink; eaten ⇒ the husk's body ink.
 *   C7 [140, 179-182] Grain last: one reading per pixel, `(hash − 0.5)·grain·40` added
 *      to all three channels alike and clamped.
 *   C8 [186] Every pixel opaque — a Husk sheet is a printed rectangle, not a cut-out.
 *   C9 [40-44] The noise: 3 octaves, gain 0.55, lacunarity 2.07, normalised by the sum
 *      of the amplitudes, each octave on its own salt.
 *
 *  NOT ported: the motion modes [6, 25, 77-79, 91-92, 139 — drift / turn / eat] and the
 *  ratio picker [4-5]. A Frame element is still, and its box IS its frame, so every
 *  phase term sits at zero and the aspect comes from the box.
 *
 * Host adaptations — every other clamp, floor and constant in the paint path is the
 * reference's own:
 *  H1 The source's `putImageData` would ignore the layer's alpha, transform and clip,
 *     so the sheet is built on an OFFSCREEN canvas at the box's paint resolution and
 *     `drawImage`d in. No absolute `globalAlpha` / composite op is ever written on the
 *     caller's ctx (pinned by test): the layer's own ride through.
 *  H2 That sheet is held under HUSK_MAX_PIXELS (6 Mpx) — the plan's cap for every
 *     per-pixel Scatter style. (The tool's export is a 600–6000 px slider, default
 *     2400; its largest export is far bigger than this cap.)
 *  H3 FIELD UNITS. The crumble's noise lattice is quoted in the tool's RENDER pixels
 *     [137], so the tool's own crumble is not scale-stable: its 800 px preview, its
 *     2400 px default export and its 6000 px export are three different textures. A
 *     Frame box is printed at a preview size and again at a bake size and must be the
 *     same picture, so ONE anchor had to be chosen: one pixel of the tool's DEFAULT
 *     export (`huskRefPx` = 1/2400 of the box WIDTH in device pixels) is the unit here.
 *     Consequence, stated plainly: the port matches the tool's 2400 px export, and at
 *     a Frame preview it reads finer than the tool's on-screen preview (a 900 px box
 *     has refPx ≈ 0.375, so the clumps are ~2.7× smaller relative to a husk — see
 *     `husk-port-default.png` vs `husk-port-toolscale.png`); and once refPx·nsc drops
 *     below one device pixel the floor below pins the lattice to the pixel and the
 *     bite loses its clump structure — reachable on a small element on a normal
 *     canvas. The tool's preview size (~800 px) would be the other defensible anchor;
 *     it was not chosen because the export is what the tool ships. Neither lattice may go finer than the
 *     device can print, so each floors at one device pixel: for the grain the lattice
 *     IS the reference pixel (`huskGrainCellPx`), while the crumble's lattice is `nsc`
 *     of one, so its floor lands on `nsc` (`huskCrumbleUnitPx`). The dot screen needs
 *     no such treatment — it is quoted against `min(W,H)` [133] and so already scales
 *     with the render.
 *  NOT PORTED: the tool page also carries a dither / finish stage (its own size,
 *     levels and amount controls) that lives outside the captured generator slice; the
 *     reference ends at `paint()`, so it is out of scope here by design.
 *  H4 The sheet is memoized on everything that decides its pixels, so a drag — which
 *     only moves the box — repaints from cache. The source memoizes its field on the
 *     same principle [64-70]; keying the finished sheet covers the field's inputs too.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { LruCache } from '~/lib/compositor/silhouetteCache'

/** How the fill inside a husk is eaten away (rules C4, C5). */
export const HUSK_BITES = ['crumble', 'dots'] as const
export type HuskBite = typeof HUSK_BITES[number]

/** The tunables, with the original's defaults (see `defaultHusk`). The tool's own
 *  control names are Count / Size / Size range / Lumpiness · Kind / Amount / Texture ·
 *  Grain; the field names stay the source's so the port reads against it. */
export interface HuskParams {
  count: number            // 1..70 how many husks are thrown
  size: number             // 0..1 base radius (in units of √grid area)
  vary: number             // 0..1 how far the radii spread either side of that base
  lump: number             // 0..1 how far the harmonics bend a rim away from an oval
  bite: HuskBite           // crumble | dots — how the fill is eaten
  eat: number              // 0..1 how much of the fill the bite takes
  tex: number              // 0..1 the bite's own scale (noise pitch, or dot lattice)
  grain: number            // 0..1 per-pixel print grain
  inks: string[]           // ORDERED roles: [ground, silhouette, fill]
}

/** A named palette: the tool's own three-entry tables, in role order (rule C1). */
export interface HuskPalettePreset { inks: readonly string[] }

export const HUSK_PALETTE_PRESETS = {
  Iris: { inks: ['#A99BE0', '#0B0B0B', '#9BE870'] },
  Ember: { inks: ['#EDE7D8', '#141414', '#F0402F'] },
  Harbour: { inks: ['#0F1A2B', '#F2F0E6', '#37C6F0'] },
  Sherbet: { inks: ['#F4C542', '#1A1A1A', '#E8508D'] },
  Cinder: { inks: ['#1E1E1E', '#EFEDE4', '#C6F03A'] },
} as const satisfies Record<string, HuskPalettePreset>
export type HuskPresetName = keyof typeof HUSK_PALETTE_PRESETS
export const HUSK_PRESET_NAMES = Object.keys(HUSK_PALETTE_PRESETS) as HuskPresetName[]

export function defaultHusk(): HuskParams {
  return {
    count: 30, size: 0.62, vary: 0.5, lump: 0.42,
    bite: 'crumble', eat: 0.55, tex: 0.45,
    grain: 0.3,
    inks: [...HUSK_PALETTE_PRESETS.Iris.inks],
  }
}

/** Bounds each dial is clamped to — the tool's own slider ranges (read off the tool
 *  page: Count 1..70 step 1, every other dial 0..1 step 0.01). */
export const HUSK_LIMITS = {
  count: [1, 70], size: [0, 1], vary: [0, 1], lump: [0, 1],
  eat: [0, 1], tex: [0, 1], grain: [0, 1],
} as const

/** The params patch a preset applies (the three roles, in order). */
export function huskPresetPatch(name: HuskPresetName): Pick<HuskParams, 'inks'> {
  return { inks: [...HUSK_PALETTE_PRESETS[name].inks] }
}

/** Which preset the params currently match (all three roles, in order), if any. */
export function huskPresetOf(params: HuskParams): HuskPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of HUSK_PRESET_NAMES) {
    const p = HUSK_PALETTE_PRESETS[name].inks
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
export function normalizeHusk(partial: unknown, base: HuskParams = defaultHusk()): HuskParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex) : base.inks.slice()
  return {
    count: Math.round(num(p.count, HUSK_LIMITS.count[0], HUSK_LIMITS.count[1], base.count)),
    size: num(p.size, 0, 1, base.size),
    vary: num(p.vary, 0, 1, base.vary),
    lump: num(p.lump, 0, 1, base.lump),
    bite: HUSK_BITES.includes(p.bite as HuskBite) ? p.bite as HuskBite : base.bite,
    eat: num(p.eat, 0, 1, base.eat),
    tex: num(p.tex, 0, 1, base.tex),
    grain: num(p.grain, 0, 1, base.grain),
    inks: inks.length ? inks : base.inks.slice(),
  }
}

// ── Our own hash and noise ───────────────────────────────────────────────────

/** Integer lattice hash → [0,1). Every (x, y, salt) gets an independent value. */
function huskHash(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smoothstep-interpolated value noise on that lattice → [0,1). */
function huskNoise(x: number, y: number, salt: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = huskHash(xi, yi, salt), b = huskHash(xi + 1, yi, salt)
  const c = huskHash(xi, yi + 1, salt), d = huskHash(xi + 1, yi + 1, salt)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** C9 — three octaves of that noise, amplitudes 0.5 / 0.275 / 0.151 (before the /total) and normalised, so
 *  the result still spans 0..1 whatever the octave count. */
function huskFbm(x: number, y: number, salt: number): number {
  let sum = 0, amp = 0.5, freq = 1, total = 0
  for (let i = 0; i < 3; i++) {
    sum += amp * huskNoise(x * freq, y * freq, salt + i * 131)
    total += amp
    freq *= 2.07
    amp *= 0.55
  }
  return sum / total
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b, a]. Alpha is KEPT: a translucent or Cleared
 *  ink paints see-through, so a transparent ground leaves only the husks over whatever
 *  sits beneath the layer. A 3- or 6-digit hex is opaque. */
function hexToRgb(hex: string): [number, number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [v(0), v(2), v(4), h.length === 8 ? v(6) : 255]
}

/** Used only when the palette is empty — the tool's own fallback trio [ref 120]. */
const FALLBACK_INKS = ['#A99BE0', '#0B0B0B', '#9BE870'] as const

/** C1 — the three roles a Husk palette carries, in order. */
export function huskRoles(params: HuskParams): { ground: string; silhouette: string; fill: string } {
  const pal = params.inks?.length ? params.inks : FALLBACK_INKS
  const ground = pal[0]!
  const silhouette = pal[1] ?? ground
  return { ground, silhouette, fill: pal[2] ?? silhouette }
}

// ── Rule B1: the grid ────────────────────────────────────────────────────────

/** Cells along the box's longer side [ref 72]. */
export const HUSK_FIELD_LONG = 560
/** No side of the grid may fall below this, however extreme the box [ref 72-73]. */
const HUSK_FIELD_MIN = 8

/**
 * B1 — the depth grid for a `boxW × boxH` box: the longer side takes
 * HUSK_FIELD_LONG cells, the shorter one follows the box's proportions, and neither
 * drops under HUSK_FIELD_MIN. It depends on the box's SHAPE alone, so the same
 * variation is the same picture at preview size and at bake size.
 */
export function huskFieldSize(boxW: number, boxH: number): { fw: number; fh: number } {
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  const aspect = H / W
  const fw = aspect > 1 ? Math.max(HUSK_FIELD_MIN, Math.round(HUSK_FIELD_LONG / aspect)) : HUSK_FIELD_LONG
  const fh = Math.max(HUSK_FIELD_MIN, Math.round(fw * aspect))
  return { fw, fh }
}

// ── Rule A: the throw ────────────────────────────────────────────────────────

/** One thrown husk, in GRID cells: a rotated oval whose rim three harmonics warp. */
export interface HuskShape {
  x: number
  y: number
  r: number            // radius before the axis factors and the harmonics
  ex: number           // 0.78..1.28, the oval's factor along its own x
  ey: number           // 0.78..1.28, the same along its own y
  rot: number          // the angle the oval is turned by, radians
  a1: number; a2: number; a3: number      // the three harmonic phases
  h1: number; h2: number; h3: number      // and their lobe counts
}

/**
 * Rule A — throw `count` husks over an `fw × fh` grid from ONE seeded stream. Pure:
 * the whole layout tests without a canvas, and it does not know the render size.
 */
export function huskShapes(params: HuskParams, fw: number, fh: number, seed: number): HuskShape[] {
  const p = normalizeHusk(params)
  const FW = Number.isFinite(fw) && fw > 0 ? fw : 1
  const FH = Number.isFinite(fh) && fh > 0 ? fh : 1
  const rnd = mulberry32(hashSeed(`${seed}:husk-shapes`))
  // A3 — against √(FW·FH): stretch the box and the husks move apart, they do not
  // multiply.
  const base = (0.045 + p.size * 0.115) * Math.sqrt(FW * FH)
  const n = Math.max(1, Math.round(p.count))                      // A1
  const out: HuskShape[] = []
  for (let i = 0; i < n; i++) {
    const x = (-0.12 + rnd() * 1.24) * FW                         // A2
    const y = (-0.12 + rnd() * 1.24) * FH
    const r = base * (1 + (rnd() - 0.5) * 2 * p.vary * 0.7)       // A3
    const ex = 0.78 + rnd() * 0.5                                 // A4
    const ey = 0.78 + rnd() * 0.5
    const rot = rnd() * Math.PI * 2
    // A5 — the motion phase: drawn and dropped, so the stream stays in step with the
    // source's own draw order even though a Frame element never animates.
    rnd()
    const a1 = rnd() * Math.PI * 2, a2 = rnd() * Math.PI * 2, a3 = rnd() * Math.PI * 2
    const h1 = 2 + ((rnd() * 2) | 0)
    const h2 = 4 + ((rnd() * 3) | 0)
    const h3 = 7 + ((rnd() * 3) | 0)
    out.push({ x, y, r, ex, ey, rot, a1, a2, a3, h1, h2, h3 })
  }
  return out
}

// ── Rule B: the depth field ──────────────────────────────────────────────────

/**
 * Rule B — drop every husk into one `fw × fh` grid of depths: 0 where no husk
 * reached, rising to 1 under a husk's middle. Overlaps keep the larger number (B8),
 * so this is order-free and nothing is ever drawn over anything. Pure.
 */
export function huskDepthField(
  shapes: readonly HuskShape[], fw: number, fh: number, params: HuskParams,
): Float32Array {
  const p = normalizeHusk(params)
  const FW = Math.max(1, Math.round(Number.isFinite(fw) && fw > 0 ? fw : 1))
  const FH = Math.max(1, Math.round(Number.isFinite(fh) && fh > 0 ? fh : 1))
  const field = new Float32Array(FW * FH)
  const lump = p.lump * 0.55                                      // B3
  for (const k of shapes) {
    // B4 — only the cells this husk can possibly reach, clipped to the grid.
    const reach = k.r * (1 + lump) * Math.max(k.ex, k.ey) + 2
    const x0 = Math.max(0, Math.floor(k.x - reach)), x1 = Math.min(FW - 1, Math.ceil(k.x + reach))
    const y0 = Math.max(0, Math.floor(k.y - reach)), y1 = Math.min(FH - 1, Math.ceil(k.y + reach))
    if (x1 < x0 || y1 < y0) continue
    const ca = Math.cos(k.rot), sa = Math.sin(k.rot)
    const outer = k.r * (1 + lump)
    for (let j = y0; j <= y1; j++) {
      const dy = j - k.y, row = j * FW
      for (let i = x0; i <= x1; i++) {
        const dx = i - k.x
        // B5 — into this husk's local frame: turn, then divide by the axis factors.
        const ux = (dx * ca + dy * sa) / k.ex, uy = (-dx * sa + dy * ca) / k.ey
        const dist = Math.sqrt(ux * ux + uy * uy)
        if (dist > outer) continue
        const ang = Math.atan2(uy, ux)
        // B6 — the rim, as three sines of that angle.
        const s = Math.sin(k.h1 * ang + k.a1) * 0.5
          + Math.sin(k.h2 * ang + k.a2) * 0.33
          + Math.sin(k.h3 * ang + k.a3) * 0.2
        const edge = k.r * (1 + lump * s)                         // B7
        if (edge <= 0.001 || dist >= edge) continue
        const d = 1 - dist / edge
        if (d > field[row + i]!) field[row + i] = d               // B8
      }
    }
  }
  return field
}

// ── Rule H3: what a lattice measures itself against ──────────────────────────

/**
 * H3 — one pixel of the tool's fixed 2400px export, in this sheet's device pixels.
 * `scale` is device pixels per box unit, `boxW` the box's width in box units, so this
 * is 1/2400 of the box WIDTH: it comes out at exactly 1 for a 2400px bake of a
 * frame-filling box, and the crumble and the grain then read the same at every other
 * render size instead of getting finer as the sheet grows.
 */
export function huskRefPx(scale: number, boxW: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const w = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  return s * w / 2400
}

/** H3 — the grain's lattice from a reference pixel: one of them, but never finer than
 *  a device pixel (below that there is nothing left to resolve, and a small box would
 *  simply lose its grain). */
function grainCellFrom(refPx: number): number {
  return Math.max(1, Number.isFinite(refPx) && refPx > 0 ? refPx : 1)
}

/** H3 — the grain's lattice in device pixels, for a box at this scale. */
export function huskGrainCellPx(scale: number, boxW: number): number {
  return grainCellFrom(huskRefPx(scale, boxW))
}

/** C5 — the crumble's noise pitch, in reference pixels [ref 137]. */
export function huskNoiseScale(tex: number): number {
  const t = Number.isFinite(tex) ? Math.max(0, Math.min(1, tex)) : 0
  return 1 / (2 + t * 18)
}

/**
 * H3 — the crumble's own unit. Its noise lattice spans `1/nsc` reference pixels, so
 * holding that lattice to a device pixel means holding this unit at `nsc` rather than
 * at 1. Above the floor it is the reference pixel itself, which is what keeps the
 * preview's bite and the bake's bite the same picture.
 */
export function huskCrumbleUnitPx(refPx: number, tex: number): number {
  const r = Number.isFinite(refPx) && refPx > 0 ? refPx : 1
  return Math.max(r, huskNoiseScale(tex))
}

// ── Rule C: the print ────────────────────────────────────────────────────────

/**
 * Rule C — print the sheet: read the grid back bilinearly, decide each pixel between
 * the three roles, then grain. `field` is `fw × fh` depths; returns RGBA for `w × h`.
 * `refPx` is H3's unit (1 = the tool's own export scale). Pure, so every rule of the
 * print tests without a canvas.
 */
export function huskPixels(
  field: Float32Array, fw: number, fh: number, w: number, h: number,
  params: HuskParams, seed: number, refPx = 1,
): Uint8ClampedArray {
  const p = normalizeHusk(params)
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  const FW = Math.max(1, Math.round(fw)), FH = Math.max(1, Math.round(fh))
  const out = new Uint8ClampedArray(W * H * 4)
  const { ground, silhouette, fill } = huskRoles(p)
  const cg = hexToRgb(ground), cs = hexToRgb(silhouette), cf = hexToRgb(fill)
  const s = seed | 0
  const dots = p.bite === 'dots'
  const cell = Math.max(3, (0.004 + p.tex * 0.03) * Math.min(W, H))     // C4
  const nsc = huskNoiseScale(p.tex)                                     // C5
  const unit = huskCrumbleUnitPx(refPx, p.tex)                          // H3
  const grainCell = grainCellFrom(refPx)                                 // H3
  const gl = p.grain * 40                                               // C7
  const eat = p.eat
  const kx = FW / W, ky = FH / H                                        // C2
  for (let y = 0; y < H; y++) {
    const gy = y * ky
    let y0 = gy | 0; if (y0 > FH - 1) y0 = FH - 1
    const fy = gy - y0
    let y1 = y0 + 1; if (y1 > FH - 1) y1 = FH - 1
    const r0 = y0 * FW, r1 = y1 * FW
    let q = y * W * 4
    for (let x = 0; x < W; x++, q += 4) {
      const gx = x * kx
      let x0 = gx | 0; if (x0 > FW - 1) x0 = FW - 1
      const fx = gx - x0
      let x1 = x0 + 1; if (x1 > FW - 1) x1 = FW - 1
      const top = field[r0 + x0]! + (field[r0 + x1]! - field[r0 + x0]!) * fx
      const bot = field[r1 + x0]! + (field[r1 + x1]! - field[r1 + x0]!) * fx
      const dep = top + (bot - top) * fy
      let col = cg                                                      // C3
      if (dep > 0.001) {
        let keep: boolean
        if (dots) {
          // C4 — where this pixel sits inside its screen cell, and how big the dot
          // that cell holds is at this depth.
          const ux = x / cell, uy = y / cell
          const dx = ux - ((ux | 0) + 0.5), dy = uy - ((uy | 0) + 0.5)
          const rad = Math.sqrt(dx * dx + dy * dy)
          const v = Math.max(0, Math.min(1, (dep - 0.05) / 0.95))
          keep = rad < 0.52 * Math.sqrt(v) * (1.35 - eat * 0.85)
        } else {
          // C5 — the smoothstep pushes the noise towards 0 and 1, so the threshold is
          // mostly either far below or far above the depth: large contiguous keep
          // and eat regions rather than a per-pixel scatter.
          const raw = huskFbm(x / unit * nsc, y / unit * nsc, s + 13)
          const nse = raw * raw * (3 - 2 * raw)
          keep = dep > 0.02 + eat * (0.06 + 1.5 * nse)
        }
        col = keep ? cf : cs                                            // C6
      }
      let r = col[0], g = col[1], b = col[2]
      if (gl > 0.002) {
        const j = (huskHash(Math.floor(x / grainCell), Math.floor(y / grainCell), s + 71) - 0.5) * gl
        r += j; g += j; b += j
      }
      out[q] = r; out[q + 1] = g; out[q + 2] = b
      out[q + 3] = col[3]                                                  // C8
    }
  }
  return out
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The subset of a 2D context `paintHusk` needs (a recording stub can stand in). */
export type HuskCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'drawImage'>
  & { getTransform?: () => { a: number; b: number } }

/** H2 — the per-pixel budget for ONE sheet, whatever the box or the zoom (the tool's
 *  own ceiling is 2400²). */
const HUSK_MAX_PIXELS = 6_000_000

/** Device pixels per box unit, off the ctx transform (1 when the ctx cannot say). */
function ctxScale(ctx: HuskCtx): number {
  const m = ctx.getTransform?.()
  const s = Math.hypot(Number(m?.a ?? 1), Number(m?.b ?? 0))
  return Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * H4 — sheet cache. Building one is a grid pass plus a per-pixel print; a drag only
 * moves the box and changes neither, so keying on everything that DOES decide the
 * pixels (the buffer size, every dial, the three inks, the seed and H3's unit) makes a
 * drag frame a cache hit. Bounded by an entry count AND a byte budget — one capped
 * sheet is 24 MB, so counting entries alone would hold a gigabyte of dead canvases.
 */
const SHEET_CACHE_CAP = 12
const SHEET_CACHE_BYTES = 128 * 1024 * 1024
const sheetCache = new LruCache<{ img: CanvasImageSource; bytes: number }>(SHEET_CACHE_CAP, {
  maxBytes: SHEET_CACHE_BYTES,
  sizeOf: v => v.bytes,
})

function sheetKey(pw: number, ph: number, fw: number, fh: number, p: HuskParams, seed: number, refPx: number): string {
  return [
    pw, ph, fw, fh, seed, refPx.toFixed(4),
    p.count, p.size, p.vary, p.lump, p.bite, p.eat, p.tex, p.grain, p.inks.join(','),
  ].join('|')
}

/** Build one printed sheet at `pw × ph`, or null when this environment has no canvas
 *  to give (SSR, a stub without createElement). */
function renderSheet(pw: number, ph: number, fw: number, fh: number, p: HuskParams, seed: number, refPx: number): CanvasImageSource | null {
  if (typeof document === 'undefined') return null
  const field = huskDepthField(huskShapes(p, fw, fh, seed), fw, fh, p)
  const sheet = document.createElement('canvas')
  sheet.width = pw; sheet.height = ph
  const sctx = sheet.getContext('2d')
  if (!sctx) return null
  const img = sctx.createImageData(pw, ph)
  img.data.set(huskPixels(field, fw, fh, pw, ph, p, seed, refPx))
  sctx.putImageData(img, 0, 0)
  return sheet
}

/** Memoized `renderSheet` — a hit skips the grid AND the per-pixel print. */
function memoSheet(pw: number, ph: number, fw: number, fh: number, p: HuskParams, seed: number, refPx: number): CanvasImageSource | null {
  const key = sheetKey(pw, ph, fw, fh, p, seed, refPx)
  const hit = sheetCache.get(key)
  if (hit) return hit.img
  const img = renderSheet(pw, ph, fw, fh, p, seed, refPx)
  if (img) sheetCache.set(key, { img, bytes: pw * ph * 4 })
  return img
}

/** Test seam — drops every cached sheet so cache-shape tests (eviction, memoization)
 *  don't depend on suite order. */
export function __resetHuskSheetCache(): void {
  sheetCache.clear()
}

/**
 * H1 — paint one Husk sheet at the ctx's origin over `boxW × boxH`. The sheet is built
 * offscreen at the box's paint resolution (held under HUSK_MAX_PIXELS) and drawn in,
 * so the layer's opacity, blend, transform and box clip all still apply.
 */
export function paintHusk(ctx: HuskCtx, params: HuskParams, boxW: number, boxH: number, seed: number): void {
  const p = normalizeHusk(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  const scale = Math.min(ctxScale(ctx), Math.sqrt(HUSK_MAX_PIXELS / (W * H)))
  const pw = Math.max(2, Math.round(W * scale)), ph = Math.max(2, Math.round(H * scale))
  // The field's aspect comes from the BOX, not the rounded device buffer, so a
  // thumbnail, a preview and a bake all lay their husks on the same grid (B1).
  const { fw, fh } = huskFieldSize(W, H)
  const img = memoSheet(pw, ph, fw, fh, p, seed, huskRefPx(scale, W))
  if (img) { ctx.drawImage(img, 0, 0, W, H); return }
  // Nowhere to render: lay the ground down on its own, so the box carries the
  // picture's colour instead of showing as a hole.
  ctx.fillStyle = huskRoles(p).ground
  ctx.fillRect(0, 0, W, H)
}
