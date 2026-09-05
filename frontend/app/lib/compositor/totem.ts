/**
 * Totem — the playgrnd "Totem" generator rebuilt as the `totem` cell fill of a
 * generative `deal` layer (the Mosaic element's Totem style). The site publishes
 * no licence, so not a character of it is copied: every rule below was read off
 * the captured reference and written again here, with our own stream, our own
 * helpers and our own structure. The RULES are what carry the look, so they are
 * kept exactly — a framed screenprint plate on a speckled mat, its left half
 * carved into blocks and folded onto the right, and a small stack of rectangles
 * standing at its exact middle.
 *
 * Rule checklist — the bracketed numbers are lines of the captured reference
 * (`playgrnd-totem-generator-reference.js`); each maps to the code named beside it.
 *
 *  A. INK ROLES (`totemRoles`)
 *   A1 [35] Brightness is measured .299·R + .587·G + .114·B.
 *   A2 [38-40] Whichever swatch measures lowest becomes the plate colour — it is what
 *      the panel is grounded in and what its keylines are struck in. A tie goes to
 *      whichever swatch came first.
 *   A3 [41-42] The remaining inks are never sorted: their positions in the row are
 *      read directly as jobs (A4), so moving a swatch changes the print.
 *   A4 [45-47] Off that ordered remainder: the first is the mat, the one two from
 *      the end is the speckle mark (a single leftover falls back to the plate), and
 *      the whole remainder is the pool the blocks draw from.
 *   A5 [37] An empty row is stood up with one near-black so nothing downstream throws.
 *
 *  B. THE LATTICE (`totemUnit`)
 *   B1 [141] One unit for the whole picture: the short side over `grain`, rounded,
 *      floored at two.
 *   B2 [142] `snap` rounds any length to a whole number of units. Everything is
 *      placed through it, which is why no rect ever lands off the lattice.
 *   B3 [140] The source turns image smoothing off. Nothing here is an image — this
 *      port stamps rects and nothing else — so there is no flag to set, and writing
 *      one on the layer's own context would be exactly the kind of absolute write
 *      the host forbids.
 *
 *  C. THE MAT (`totemMatField`, `paintTotem`)
 *   C1 [146] The sheet starts as one rect of the mat ink.
 *   C2 [147-148] The band is `snap(min(W,H)·border)` wide; the plate is that far in
 *      on all four sides, its size snapped too.
 *   C3 [150] Speckle only happens when there is a band to hold it and the dial is
 *      off its floor.
 *   C4 [151-153] The speckle runs on its own coarser lattice, `matGrain` units to a
 *      cell, with one spare row and column so the sheet is covered.
 *   C5 [154] Every cell is set with probability `mat`.
 *   C6 [155-167] Two smoothing passes. A cell tallies its own 3×3 neighbourhood,
 *      itself included; anything past the edge is tallied as the cell being judged.
 *      Over four sets the cell, under four clears it, exactly four leaves it be.
 *   C7 [168-176] Set cells print as full lattice squares in the mark ink, and any
 *      square overlapping the plate is passed over.
 *   C8 [179] If the plate came out under four units either way, the picture is the
 *      mat and stops there.
 *
 *  D. THE PLATE (`paintTotem`)
 *   D1 [182-183] One rect of the plate colour inside the band.
 *   D2 [184-185] `keyline` units in from that is the composition box, each side held
 *      at one unit minimum.
 *
 *  E. THE RULE BAG (`totemKinds`, `totemMotifOn`)
 *   E1 [188] How many of the eleven rules are in play: `max(2, round(2 + variety·9))`.
 *   E2 [189-192] They are lifted out of the list one at a time and not put back.
 *   E3 [56-71] The eleven rules themselves, each a yes/no over a cell's column and
 *      row (plus the animation phase term, which is always nought in a still). See
 *      `totemMotifOn` — one case per rule, in the same order.
 *   E4 [76-87] A block is grounded in one colour, then marked in the other wherever
 *      the rule says yes; the cell counts round off the block's own size, and the
 *      last cell in a row or column is trimmed to the edge. `solid` skips the cell
 *      walk and stamps one rect.
 *
 *  F. THE COMPOSITION (`totemCarve`, `totemDeal`, `totemMirror`, `paintTotem`)
 *   F1 [197] The layout happens on one side alone. Its width is half the composition
 *      taken UP to a whole unit, and never under a single unit.
 *   F2 [94-117] Each cut lands on whichever block currently holds the most area, over
 *      and over until the count is met. A cut needs six units of room; the long way
 *      wins when the block is over 1.1 to 1, otherwise it is a coin. The cut falls
 *      between three and seven tenths, snapped, and never under two units. Four
 *      hundred turns is the ceiling, and a cut that would swallow the block puts it
 *      back and stops.
 *   F3 [119-131] Each block is dealt: a rule from the bag, re-drawn once when it
 *      came up flat and a coin lands under 0.55; a mark colour from the pool; a
 *      ground from that same pool plus the plate colour listed twice, minus the mark;
 *      and a cell of one unit, or two units three times in ten.
 *   F4 [199-202] The block prints, trimmed at the right edge of the composition.
 *   F5 [204-206] Its twin sits mirrored about the centre line and is dealt again
 *      unless a coin comes in under `mirror` — the coin is drawn either way.
 *   F6 [207-208] The twin prints only when some of it is still inside the composition.
 *   F7 [210-212] It is drawn through a flipped frame, so the rule reads backwards —
 *      and that reversal is why the diagonals meet along the centre line instead of
 *      carrying straight on across it.
 *   F8 [216] After the twin, the left block is painted once more. A twin whose
 *      footprint crosses the centre line would otherwise cover part of it.
 *
 *  G. THE CORE (`totemCore`, `paintTotem`)
 *   G1 [221] Nothing is drawn when the size dial is at its floor.
 *   G2 [222] Width is `snap(min(cw,ch)·core)`; height is that times 1.2 to 1.8,
 *      the fifth of the seed choosing where in that span.
 *   G3 [223] Both are held between two units and the composition less two units.
 *   G4 [224] It is centred, snapped.
 *   G5 [226-231] `coreRings` rects, the plate colour and an ink from the pool taking
 *      turns, each stepping one unit in on every side; the run ends early once there
 *      is under two units left either way.
 *   G6 [232-233] A last deal fills what remains, at one unit to a cell, always over
 *      the plate colour.
 *
 * NOT ported, and why:
 *  - Motion [135, 137] (shuffle re-seeds each frame, weave walks the phase term). A
 *    Mosaic is one still picture, so the phase stays nought — every earlier playgrnd
 *    port here made the same call.
 *  - The tool page's dither stage, which runs after this generator rather than inside
 *    it, and the page's SVG recorder [237-298]: our Frame writes rich layers as a
 *    flattened raster, so replaying the paint into a rect recorder is follow-up work.
 *
 * Host adaptations, declared:
 *  - Our own stream (`mulberry32`/`hashSeed`) rather than the page's xorshift, per the
 *    no-copying rule. Same rules, same order of draws, different pictures.
 *  - `TOTEM_MAX_UNITS`: a Frame box can be far more lopsided than the eight ratios the
 *    tool exports, and at a very short side the unit hits its floor of two while the
 *    long side runs on, which would ask for millions of rects. The unit is therefore
 *    also floored so the box never holds more than TOTEM_MAX_UNITS lattice cells. The
 *    budget is set above everything the tool itself can produce — at 6000px and any of
 *    its ratios the short-side rule already wins — so no picture the tool can make is
 *    changed by it (`totemUnit`, and the test that walks every one of those sizes).
 *  - Paint happens in box space, `(0,0)`–`(boxW,boxH)`; the host clips to the box.
 *  - No absolute `globalAlpha` / `globalCompositeOperation` write, so the layer's
 *    opacity and blend survive. The flipped frame for the twin is a matched
 *    save/restore around a translate and a scale, nothing else.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'

/** The eleven cell rules a block can be dealt, in the source's own order. */
export const TOTEM_MOTIFS = ['solid', 'check', 'hline', 'vline', 'diag', 'diagB', 'brick', 'dash', 'grid', 'rings', 'noise'] as const
export type TotemMotif = typeof TOTEM_MOTIFS[number]

/** The dials, under the tool's own field names. */
export interface TotemParams {
  border: number      // 0..0.4 band width, as a share of the short side
  mat: number         // 0..0.7 how much of the band is speckled
  matGrain: number    // 1..6 lattice units to a speckle cell
  keyline: number     // 0..10 units between the plate edge and the composition
  regions: number     // 1..30 blocks the left half is carved into
  grain: number       // 16..220 short side divided by this gives the lattice unit
  mirror: number      // 0..1 how often the twin repeats its partner's deal
  variety: number     // 0..1 how many of the eleven cell rules are in play
  core: number        // 0..0.6 width of the centre stack, as a share of the short side
  coreRings: number   // 0..8 nested rects around it
  inks: string[]      // the ORDERED row of five: the order is what assigns the jobs
}

/** A named ink row (the tool's six five-ink sets). */
export interface TotemPalettePreset { inks: readonly string[] }

export const TOTEM_PALETTE_PRESETS = {
  Arcade: { inks: ['#1B1A6B', '#2323E0', '#7A1FD6', '#F01E2C', '#17C93B'] },
  Lagoon: { inks: ['#141344', '#1E5BE0', '#00B2A6', '#FF3B30', '#B9E01F'] },
  Carnival: { inks: ['#2A0F3D', '#E01E5A', '#F5A623', '#00C2A8', '#3B2BE0'] },
  Kiosk: { inks: ['#101820', '#F0532A', '#F2C500', '#1FB6E0', '#0FA958'] },
  Neon: { inks: ['#1D0B2E', '#8A2BE2', '#FF2D95', '#25D0C0', '#FFE03D'] },
  Harbour: { inks: ['#0E1A2B', '#2F6BE0', '#E8452C', '#F0C93B', '#5BD1A0'] },
} as const satisfies Record<string, TotemPalettePreset>
export type TotemPresetName = keyof typeof TOTEM_PALETTE_PRESETS
export const TOTEM_PRESET_NAMES = Object.keys(TOTEM_PALETTE_PRESETS) as TotemPresetName[]

/** Where every dial may sit — the ranges the tool page's own sliders carry, and the
 *  inspector's too. */
export const TOTEM_LIMITS = {
  border: [0, 0.4], mat: [0, 0.7], matGrain: [1, 6], keyline: [0, 10],
  regions: [1, 30], grain: [16, 220], mirror: [0, 1], variety: [0, 1],
  core: [0, 0.6], coreRings: [0, 8],
} as const

/** The starting picture: the tool's own opening values and its first ink row. */
export function defaultTotem(): TotemParams {
  return {
    border: 0.15, mat: 0.36, matGrain: 2, keyline: 3,
    regions: 14, grain: 110, mirror: 1, variety: 0.7,
    core: 0.22, coreRings: 3,
    inks: [...TOTEM_PALETTE_PRESETS.Arcade.inks],
  }
}

/** What a named ink row writes onto the params. */
export function totemPresetPatch(name: TotemPresetName): Pick<TotemParams, 'inks'> {
  return { inks: [...TOTEM_PALETTE_PRESETS[name].inks] }
}

/** The row the params currently spell, if any (every swatch, in order). */
export function totemPresetOf(params: TotemParams): TotemPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of TOTEM_PRESET_NAMES) {
    const p = TOTEM_PALETTE_PRESETS[name].inks
    if (params.inks?.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// Six digits, or eight when the shared picker hands back a translucent pick.
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Pull a loose, partial or plainly wrong params object onto `base`. Layer objects
 *  arrive raw, so every reader here starts by going through this. */
export function normalizeTotem(partial: unknown, base: TotemParams = defaultTotem()): TotemParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const whole = (v: unknown, lo: number, hi: number, fb: number) => Math.round(num(v, lo, hi, fb))
  const L = TOTEM_LIMITS
  // A screenprint ink is opaque: the picker's #rrggbbaa is cut to #rrggbb here,
  // once, so nothing translucent ever reaches fillStyle.
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex).map(h => h.slice(0, 7)) : base.inks.slice()
  return {
    border: num(p.border, L.border[0], L.border[1], base.border),
    mat: num(p.mat, L.mat[0], L.mat[1], base.mat),
    matGrain: whole(p.matGrain, L.matGrain[0], L.matGrain[1], base.matGrain),
    keyline: whole(p.keyline, L.keyline[0], L.keyline[1], base.keyline),
    regions: whole(p.regions, L.regions[0], L.regions[1], base.regions),
    grain: whole(p.grain, L.grain[0], L.grain[1], base.grain),
    mirror: num(p.mirror, L.mirror[0], L.mirror[1], base.mirror),
    variety: num(p.variety, L.variety[0], L.variety[1], base.variety),
    core: num(p.core, L.core[0], L.core[1], base.core),
    coreRings: whole(p.coreRings, L.coreRings[0], L.coreRings[1], base.coreRings),
    inks: inks.length ? inks : base.inks.slice(),
  }
}

/**
 * One swatch changed by hand: the patch writing the whole row back with `index`
 * replaced. The rest keep their places, because their places are their jobs (rule
 * A3). `null` for an index off the row or a value that is not a colour. Any alpha
 * the picker sends is trimmed — a screenprint ink is opaque.
 */
export function totemInkPatch(params: TotemParams, index: number, hex: string): Pick<TotemParams, 'inks'> | null {
  if (!isHex(hex)) return null
  const inks = normalizeTotem(params).inks
  if (!Number.isInteger(index) || index < 0 || index >= inks.length) return null
  inks[index] = hex.slice(0, 7)
  return { inks }
}

// ── Rule A: ink roles ────────────────────────────────────────────────────────

/** The four jobs the ordered row hands out. */
export interface TotemRoles {
  dark: string      // the plate: it grounds the panel and prints its keylines
  mat: string       // the sheet the frame sits on
  mark: string      // the speckle in the border band
  inks: string[]    // the pool the blocks and rings draw from, still in row order
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → the three channels (any alpha is ignored). */
function channels(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const at = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [at(0), at(2), at(4)]
}

/** A1 — how bright one swatch reads. */
function brightness(hex: string): number {
  const [r, g, b] = channels(hex)
  return r * 0.299 + g * 0.587 + b * 0.114
}

/** Rules A1–A5 — hand the row's four jobs out by brightness and by position. */
export function totemRoles(inks: readonly string[]): TotemRoles {
  const row = (inks.length ? inks : ['#111111']).slice()
  let darkAt = 0
  for (let i = 1; i < row.length; i++) if (brightness(row[i]!) < brightness(row[darkAt]!)) darkAt = i
  const dark = row[darkAt]!
  const rest = row.filter((_, i) => i !== darkAt)
  if (!rest.length) rest.push(dark)
  return {
    dark,
    mat: rest[0]!,
    mark: rest.length > 1 ? rest[Math.max(0, rest.length - 2)]! : dark,
    inks: rest,
  }
}

// ── Rule B: the lattice ──────────────────────────────────────────────────────

/**
 * How many lattice cells one box may be cut into. See the host-adaptation note in
 * the header: the tool's own widest export at its most lopsided ratio stays well
 * under this, so nothing it can draw is affected — this only catches Frame boxes
 * shaped like a rule, where the short side pins the unit at two while the long side
 * runs for thousands of pixels.
 */
export const TOTEM_MAX_UNITS = 400_000

/** Rule B1 (plus the budget floor) — the one unit the whole picture is placed on. */
export function totemUnit(boxW: number, boxH: number, grain: number): number {
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const g = Math.max(TOTEM_LIMITS.grain[0], Math.min(TOTEM_LIMITS.grain[1], Number.isFinite(grain) ? grain : 110))
  const fromGrain = Math.max(2, Math.round(Math.min(W, H) / g))
  const fromBudget = Math.ceil(Math.sqrt((W * H) / TOTEM_MAX_UNITS))
  return Math.max(fromGrain, fromBudget)
}

// ── Rule C: the mat's field ──────────────────────────────────────────────────

/**
 * Rules C5–C6 — scatter `gw × gh` cells at `density`, then run the two smoothing
 * passes over them. A cell weighs its own 3×3 patch, counting itself, and reads any
 * cell past the edge as a copy of itself; over four it lights, under four it goes
 * out, and at exactly four it is left as it was. Pure, so the whole rule is testable
 * without a canvas.
 */
export function totemMatField(gw: number, gh: number, density: number, rand: () => number): Uint8Array {
  const w = Math.max(1, Math.round(gw)), h = Math.max(1, Math.round(gh))
  let cells = new Uint8Array(w * h)
  for (let i = 0; i < cells.length; i++) cells[i] = rand() < density ? 1 : 0
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(cells.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const self = cells[y * w + x]!
        let tally = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            tally += (nx < 0 || ny < 0 || nx >= w || ny >= h) ? self : cells[ny * w + nx]!
          }
        }
        next[y * w + x] = tally > 4 ? 1 : (tally < 4 ? 0 : self)
      }
    }
    cells = next
  }
  return cells
}

// ── Rule E: the rule bag and the eleven rules ────────────────────────────────

/** Rules E1–E2 — how many of the eleven are in play, drawn out without repeats. */
export function totemKinds(variety: number, rand: () => number): TotemMotif[] {
  const v = Math.max(0, Math.min(1, Number.isFinite(variety) ? variety : 0))
  const want = Math.max(2, Math.round(2 + v * (TOTEM_MOTIFS.length - 2)))
  const pool = [...TOTEM_MOTIFS] as TotemMotif[]
  const out: TotemMotif[] = []
  for (let i = 0; i < want && pool.length; i++) out.push(pool.splice((rand() * pool.length) | 0, 1)[0]!)
  return out
}

/**
 * Rule E3 — does the mark print in cell (`i`, `j`) of a block `w × h` cells across?
 * `phase` is the animation term, always nought here; `rand` is only ever touched by
 * the scattered rule. The remainder maths is written to stay right on the negative
 * indices the mirrored frame produces.
 */
export function totemMotifOn(kind: TotemMotif, i: number, j: number, w: number, h: number, phase: number, rand: () => number): boolean {
  // `phase` may be negative in principle (a caller's choice); the modulo below is
  // the mathematical one so a negative sum still lands in 0..m-1. Cell indices
  // themselves are always 0..cols-1 — the mirrored twin flips the transform, not i/j.
  const wrap = (n: number, m: number) => ((n % m) + m) % m
  switch (kind) {
    case 'solid': return true
    case 'check': return ((i + j + phase) & 1) === 0
    case 'hline': return ((j + phase) & 1) === 0
    case 'vline': return ((i + phase) & 1) === 0
    case 'diag': return wrap(i + j + phase, 4) < 2
    case 'diagB': return wrap(i - j + phase, 4) < 2
    case 'brick': return wrap(((j & 1) ? i + 2 : i) + phase, 4) < 2
    case 'dash': return (j & 1) === 0 && wrap(i + phase, 3) < 2
    case 'grid': return wrap(i + phase, 3) === 0 || wrap(j + phase, 3) === 0
    case 'rings': return (Math.min(i, j, w - 1 - i, h - 1 - j) & 1) === 0
    case 'noise': return rand() < 0.5
  }
  return true
}

// ── Rule F: the carve, the deal, the twin ────────────────────────────────────

/** One block of the composition, in box pixels. */
export interface TotemRegion { x: number; y: number; w: number; h: number }

/** What one block was dealt (rule F3). */
export interface TotemHand {
  kind: TotemMotif
  cs: number      // cell size in box pixels: one unit, or two
  a: string       // the mark
  b: string       // the ground under it
}

/**
 * Rule F2 — carve a rectangle into at most `n` blocks by always reaching for the one
 * with the most area. Every edge lands on the lattice, and a block too tight to take
 * a cut is simply left as it is.
 */
export function totemCarve(x: number, y: number, w: number, h: number, n: number, u: number, rand: () => number): TotemRegion[] {
  const list: TotemRegion[] = [{ x, y, w, h }]
  const want = Math.max(1, Math.floor(n))
  let turns = 0
  while (list.length < want && turns++ < 400) {
    let at = 0, most = -1
    for (let i = 0; i < list.length; i++) {
      const area = list[i]!.w * list[i]!.h
      if (area > most) { most = area; at = i }
    }
    const block = list[at]!
    const roomAcross = block.w >= u * 6, roomDown = block.h >= u * 6
    if (!roomAcross && !roomDown) break
    let across: boolean
    if (roomAcross && roomDown) {
      // Clearly oblong ⇒ cut the long way; near enough square ⇒ leave it to the draw.
      across = block.w / block.h > 1.1 ? true : (block.h / block.w > 1.1 ? false : rand() < 0.5)
    } else {
      across = roomAcross
    }
    const frac = 0.3 + rand() * 0.4
    list.splice(at, 1)
    if (across) {
      const cut = Math.max(u * 2, Math.round(block.w * frac / u) * u)
      if (cut <= 0 || cut >= block.w) { list.push(block); break }
      list.push({ x: block.x, y: block.y, w: cut, h: block.h })
      list.push({ x: block.x + cut, y: block.y, w: block.w - cut, h: block.h })
    } else {
      const cut = Math.max(u * 2, Math.round(block.h * frac / u) * u)
      if (cut <= 0 || cut >= block.h) { list.push(block); break }
      list.push({ x: block.x, y: block.y, w: block.w, h: cut })
      list.push({ x: block.x, y: block.y + cut, w: block.w, h: block.h - cut })
    }
  }
  return list
}

/**
 * Rule F3 — deal one block. Kind: one draw from the bag; if it is `solid`, a second
 * coin (p = 0.55) replaces it with a fresh draw — `solid` is one entry among up to
 * eleven yet needs damping because a flat block reads much louder than a patterned
 * one. Ink `a`: one draw from the inks. Ground `b`: one draw from the inks plus the
 * plate colour entered TWICE, with `a` removed — the double entry gives the plate
 * colour twice the weight of any other ground.
 */
export function totemDeal(kinds: readonly TotemMotif[], inks: readonly string[], dark: string, u: number, rand: () => number): TotemHand {
  // Two guards the source does not need (its bag and inks are never empty) and
  // that never fire here either: totemKinds returns at least two kinds and
  // totemRoles never returns an empty ink list. Kept so a hand-built call cannot
  // index into nothing.
  const bag = kinds.length ? kinds : (['solid'] as const)
  const pool = inks.length ? inks : [dark]
  let kind = bag[(rand() * bag.length) | 0]!
  if (kind === 'solid' && rand() < 0.55) kind = bag[(rand() * bag.length) | 0]!
  const a = pool[(rand() * pool.length) | 0]!
  const grounds = [...pool, dark, dark].filter(c => c !== a)
  const b = grounds.length ? grounds[(rand() * grounds.length) | 0]! : dark
  return { kind, cs: u * (rand() < 0.3 ? 2 : 1), a, b }
}

/** Where a block's twin lands, and how much of it the composition still holds
 *  (rules F5–F6). `cx`/`cw` are the composition box, `halfW` the composed half. */
export function totemMirror(g: TotemRegion, cx: number, cw: number, halfW: number): { mx: number; clipX: number; tw: number } {
  const mx = cx + cw - (g.x - cx) - g.w
  const clipX = Math.max(mx, cx + cw - halfW)
  return { mx, clipX, tw: Math.min(g.w - (clipX - mx), cx + cw - clipX) }
}

// ── Rule G: the core ─────────────────────────────────────────────────────────

/** One rect of the centre stack. */
export interface TotemRing { x: number; y: number; w: number; h: number; color: string }
/** The centre stack: its rings, and the box left over for the last deal. */
export interface TotemCoreLayout { rings: TotemRing[]; inner: TotemRegion }

/**
 * Rules G1–G5 — the centre stack's rects, plus the box the closing motif gets. `null` when
 * the size dial sits on its floor. Pure, so the ring colours and the step inwards
 * test without painting anything.
 */
export function totemCore(cx: number, cy: number, cw: number, ch: number, params: TotemParams, u: number, seed: number, roles: TotemRoles): TotemCoreLayout | null {
  const p = normalizeTotem(params)
  if (!(p.core > 0.01)) return null
  const snap = (v: number) => Math.round(v / u) * u
  let w = snap(Math.min(cw, ch) * p.core)
  let h = snap(w * (1.2 + 0.6 * ((Math.trunc(seed) % 5) / 5)))
  w = Math.max(u * 2, Math.min(w, cw - u * 2))
  h = Math.max(u * 2, Math.min(h, ch - u * 2))
  let x = snap(cx + (cw - w) / 2), y = snap(cy + (ch - h) / 2)
  const count = Math.max(0, Math.floor(p.coreRings))
  const rings: TotemRing[] = []
  for (let i = 0; i < count; i++) {
    rings.push({ x, y, w, h, color: (i & 1) ? roles.inks[(i + 1) % roles.inks.length]! : roles.dark })
    x += u; y += u; w -= u * 2; h -= u * 2
    if (w < u * 2 || h < u * 2) { w = Math.max(u, w); h = Math.max(u, h); break }
  }
  return { rings, inner: { x, y, w, h } }
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The slice of a 2D context this paint needs, so a recorder can stand in for one. */
export type TotemCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'save' | 'restore' | 'translate' | 'scale'>

/** Rule E4 — ground a block, then mark it cell by cell wherever the rule says yes. */
function printBlock(ctx: TotemCtx, kind: TotemMotif, x: number, y: number, w: number, h: number, cs: number, a: string, b: string, phase: number, rand: () => number) {
  ctx.fillStyle = b
  ctx.fillRect(x, y, w, h)
  // `cs` is always a whole number of units (one or two, and a unit is at least two),
  // so this floor never fires — it is here only so a stray zero could not spin the
  // loop below for ever. Not a rule of the source, and it changes no picture.
  const cell = Math.max(1, cs)
  const cols = Math.max(1, Math.round(w / cell))
  const rows = Math.max(1, Math.round(h / cell))
  ctx.fillStyle = a
  if (kind === 'solid') { ctx.fillRect(x, y, w, h); return }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!totemMotifOn(kind, i, j, cols, rows, phase, rand)) continue
      const px = x + i * cell, py = y + j * cell
      ctx.fillRect(px, py, Math.min(cell, x + w - px), Math.min(cell, y + h - py))
    }
  }
}

/**
 * Paint one Totem over `(0,0)`–`(boxW,boxH)` at `seed`. Everything is a filled rect
 * on the lattice; the only transform written is the flipped frame the twin needs,
 * inside a matched save/restore. The layer's opacity and blend are already on the
 * context and are never touched.
 */
export function paintTotem(ctx: TotemCtx, params: TotemParams, boxW: number, boxH: number, seed: number): void {
  const p = normalizeTotem(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const roles = totemRoles(p.inks)
  const rand = mulberry32(hashSeed(`${Math.trunc(seed)}:totem`))
  const phase = 0                                    // stills only — see the header
  const u = totemUnit(W, H, p.grain)
  const snap = (v: number) => Math.round(v / u) * u

  // C1–C2 — the sheet, then the band and the plate's box.
  ctx.fillStyle = roles.mat
  ctx.fillRect(0, 0, W, H)
  const bw = snap(Math.min(W, H) * p.border)
  const plateX = bw, plateY = bw
  const plateW = snap(W - bw * 2), plateH = snap(H - bw * 2)

  // C3–C7 — the speckle, kept off the plate.
  if (bw > 0 && p.mat > 0.01) {
    const mu = u * Math.max(1, Math.floor(p.matGrain))
    const gw = Math.ceil(W / mu) + 1, gh = Math.ceil(H / mu) + 1
    const field = totemMatField(gw, gh, p.mat, rand)
    ctx.fillStyle = roles.mark
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (!field[y * gw + x]) continue
        const rx = x * mu, ry = y * mu
        if (rx + mu > plateX && rx < plateX + plateW && ry + mu > plateY && ry < plateY + plateH) continue
        ctx.fillRect(rx, ry, mu, mu)
      }
    }
  }

  // C8 — no room left for a picture.
  if (plateW < u * 4 || plateH < u * 4) return

  // D1–D2 — the plate and the composition box inside it.
  ctx.fillStyle = roles.dark
  ctx.fillRect(plateX, plateY, plateW, plateH)
  const inset = Math.max(0, Math.floor(p.keyline)) * u
  const cx = plateX + inset, cy = plateY + inset
  const cw = Math.max(u, plateW - inset * 2), ch = Math.max(u, plateH - inset * 2)

  // E1–E2 — which rules are in play.
  const kinds = totemKinds(p.variety, rand)

  // F1–F8 — lay out one half, then fold it across.
  const halfW = Math.max(u, Math.ceil(cw / u / 2) * u)
  const blocks = totemCarve(cx, cy, halfW, ch, Math.max(1, Math.floor(p.regions)), u, rand)
  for (const g of blocks) {
    const hand = totemDeal(kinds, roles.inks, roles.dark, u, rand)
    const drawW = Math.min(g.w, cx + cw - g.x)
    if (drawW > 0) printBlock(ctx, hand.kind, g.x, g.y, drawW, g.h, hand.cs, hand.a, hand.b, phase, rand)
    const twinHand = rand() < p.mirror ? hand : totemDeal(kinds, roles.inks, roles.dark, u, rand)
    const { mx, tw } = totemMirror(g, cx, cw, halfW)
    if (tw > 0) {
      ctx.save()
      ctx.translate(mx + g.w, 0)
      ctx.scale(-1, 1)
      printBlock(ctx, twinHand.kind, 0, g.y, g.w, g.h, twinHand.cs, twinHand.a, twinHand.b, phase, rand)
      ctx.restore()
      // F8 — put the original back on top of whatever the twin reached across.
      if (drawW > 0) printBlock(ctx, hand.kind, g.x, g.y, drawW, g.h, hand.cs, hand.a, hand.b, phase, rand)
    }
  }

  // G1–G6 — the centre stack.
  const core = totemCore(cx, cy, cw, ch, p, u, seed, roles)
  if (core) {
    for (const ring of core.rings) {
      ctx.fillStyle = ring.color
      ctx.fillRect(ring.x, ring.y, ring.w, ring.h)
    }
    const hand = totemDeal(kinds, roles.inks, roles.dark, u, rand)
    printBlock(ctx, hand.kind, core.inner.x, core.inner.y, core.inner.w, core.inner.h, u, hand.a, roles.dark, phase, rand)
  }
}
