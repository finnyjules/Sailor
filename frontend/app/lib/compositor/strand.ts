/**
 * Strand — the playgrnd "Strand" generator, rebuilt as the second STYLE of the Scatter
 * element (the `scatter` layer kind). Nothing is lifted from the site, which publishes
 * no licence: the rng, the hash, the value noise, the function boundaries and every
 * word of prose here are ours. What survives the port is the RULE SET, since the rules
 * are the picture — branching chains of stubby RODS whose contours are drawn freehand
 * instead of stroked, printed over a second impression of themselves that sits off
 * true, with the ink permitted to fail wherever a rod runs thin.
 *
 * Rule checklist. Every entry cites the captured reference by line number
 * (`playgrnd-strand-generator-reference.js`, in brackets), so the port can be read
 * against the source as code.
 *
 *  A. THE CHAINS (strandWalks) [61-111]
 *   A1 [78-82] `count` chains are queued, each with a spot, a random heading and `len`
 *      rods of life. Both counts are rounded; the chain count is floored at 1 and the
 *      life at 1, so no dial value can queue an empty walk.
 *   A2 [67, 80-81] Distances are quoted in units of √(box area): the box spans
 *      `0..fw` by `0..fh` with `fw = 1/√aspect`, `fh = √aspect`, `aspect = boxH/boxW`.
 *      Consequences the eye can check: widen the box and a chain's rods separate,
 *      rather than more of them arriving to fill the extra room; and since the units
 *      never mention pixels, one seed resolves to one layout at whatever resolution the
 *      sheet is eventually rasterised at. Starting spots run `-0.12 … 1.12` of each
 *      side, which puts some chains slightly off-page so they can walk on.
 *   A3 [73-75] `wid = 0.02 + thick·0.09`; `seg = wid·(0.4 + rod·2.2)`; and the walk
 *      advances by `seg + wid + notch·wid·0.95` each time. The `+ wid` term carries
 *      weight rather than slack: rule B2 spends `seg + wid` of the axis on every rod, so
 *      an advance of `seg` on its own would bury a whole rod-width of each neighbour
 *      under the one before it and no gap at all would survive. `notch·wid·0.95` is
 *      then the part of the advance a viewer can actually measure.
 *   A4 [83-86] The queue is drained last-in-first-out, so a chain's newest arm is
 *      finished before the older work resumes — depth-first, which keeps one arm's
 *      rods contiguous in the output.
 *   A5 [88] Every rod records where it was laid, the heading it was laid at, its `seg`
 *      and a sub-seed `(rnd()·9973)|0` that alone decides its outline (rule B).
 *   A6 [91] After each rod the heading drifts by `(rnd()−0.5)·wander·0.9`.
 *   A7 [92-94] A split happens when the arm is shallower than 3, has more than 4 rods
 *      of life left, and a roll comes in under `branch·0.22`. The new arm starts where
 *      the parent now stands, kinked by `±(0.5 + rnd()·0.6)`, with
 *      `max(3, (left·(0.4 + rnd()·0.5))|0)` rods of its own and one more depth. `left`
 *      here is already decremented for the rod just laid — the source tests the same
 *      post-decrement value, and copying that matters because it shifts which steps
 *      qualify.
 *   A8 [99-104] Beyond `±0.32` of a side outside the sheet the chain is pulled round:
 *      wrap the gap between its heading and the bearing to the box's midpoint into
 *      `−π…π`, then apply one fifth. The fraction is the whole trick. Apply the lot and
 *      the apron behaves like a hard boundary that chains visibly ricochet off; apply a
 *      fifth and the correction spreads across several rods into a curve no different
 *      from what Wander already produces. It also keeps Length working: uncorrected, a
 *      long chain spends most of its rods outside the box, contributing nothing.
 *   A9 [61, 83, 86] ROD_CAP = 7000 rods, tested at both loops. Branching is
 *      multiplicative, so the ceiling is what stops Chains 40 × Length 90 × Branching 1
 *      from running away.
 *   A10 [62-65] The source memoizes the rod list on its own key. Here the whole
 *      printed sheet is memoized instead (see `sheetCache`), on a key that already
 *      covers every input the rods depend on, so a second cache would only duplicate
 *      the first.
 *
 *  B. ONE ROD'S OUTLINE (strandRodPath) [113-151]
 *   B1 [124] Before anything is drawn, the rod tilts away from its chain's heading by
 *      `(hash(sd,17,3) − 0.5)·0.42·rough`. Without it every rod in a chain would sit
 *      exactly on the chain's heading and the row would come out mechanically aligned;
 *      the tilt is what breaks that alignment.
 *   B2 [127, 141] The drawn length is `full = seg + wid`, and the stations run from
 *      `t = −wid/2` to `t = seg + wid/2` along the axis, centred on the rod's spot.
 *   B3 [128-129] `half = max(wid·0.05, wid/2 + grow)`. `grow` is negative for the
 *      shrunken depth pass, and the floor is what keeps that pass from crossing zero
 *      and producing an outline turned inside out.
 *   B4 [130] ROD_STATIONS = 18 steps, so 19 points per edge.
 *   B5 [131-132, 135-136] The two ends open at different rates:
 *      `e0 = 0.06 + hash(sd,3,7)·0.34·rough` and `e1 = 0.06 + hash(sd,9,7)·0.60·rough`,
 *      combined as `cap = min(u/e0, (1−u)/e1, 1)`, clamped at zero and raised to 0.45.
 *      The two ends therefore ramp over different distances, which gives a rod a sense
 *      of having been laid down travelling one way.
 *   B6 [138-139] Each side reads a noise of its own (`wl` under salt `sd`, `wr` under
 *      `sd + 911`), each varying ±`rough·1.3/2` about full width. Two independent
 *      readings rather than one shared reading is what leaves the contour uneven from
 *      one flank to the other — a shape no stroking API could have produced, and the
 *      whole reason for building it out of points.
 *   B7 [140] Every station also slides sideways off the axis by
 *      `(noise − 0.5)·wid·0.55·rough`, at a low frequency, so the rod's centre line
 *      itself is not straight.
 *   B8 [143-150] Half-widths are `half·cap·wl` and `half·cap·wr` along the normal, and
 *      the outline closes as one ring: every station down one edge, the same stations
 *      back up the other.
 *   B9 [120] With Roughness at 0 every term above drops out — no tilt, `wl = wr = 1`,
 *      no sideways slide, `e0 = e1` — and a capsule, even across its axis, is what is
 *      left.
 *
 *  C. THE THREE MASK PASSES (strandMasks) [153-240]
 *   C1 [191-193] Half the sheet's resolution, deliberately. Rule D1 samples the mask
 *      back bilinearly, which spreads every boundary over two or three pixels, and that
 *      spread is the working room rule D2's jitter needs. Rasterise the mask at full
 *      resolution and a boundary is one blended pixel wide: the jitter has a single
 *      pixel it can move, and every rod keeps a cleanly cut silhouette however far Grain
 *      is pushed. The fourfold saving in both the raster and the read-back is welcome
 *      but incidental.
 *   C2 [196] The sheet is cleared to ground everywhere.
 *   C3 [181-184, 205-211] Pass one, into RED: the same rods, displaced by
 *      `offset·0.055·U` at 135° (down and to the left) and fattened by
 *      `grow = (fat − wide)/2` where `fat = wide·(1 + edge·0.55)`. One path, one fill.
 *   C4 [212-218] Pass two, into GREEN: those rods over again, square on and at their
 *      plain width. The two passes cover nearly the same pixels, and the print resolves
 *      fill ahead of plate (rule D7), so what stays visible of the plate is exactly the
 *      crescent the displacement failed to cover — up to `slip + grow` thick on one
 *      flank of a rod, and nothing at all on the flank the plate moved away from.
 *   C5 [225-240] Pass three, into BLUE, and only above Coverage 0.004: a third go at the
 *      rods, shrunk by `eat = wide·0.5·0.38`, softened by a `blur(eat·0.8)` and
 *      accumulated under `lighter`. The blue channel then encodes depth — close to zero
 *      along a rod's boundary, close to full through its interior — and rule D4 divides
 *      the ink loss by it, so the dropout gathers where a rod is thin instead of
 *      spreading evenly over the whole silhouette. `eat` is quoted against the HALF
 *      width; go past that and there would be no interior left to defend.
 *   C6 [238-239] The composite operation and the filter are put back afterwards. The
 *      source assigns its two defaults; this restores whatever the caller had, which is
 *      the same thing on our own freshly-made mask canvas and safe on any other.
 *
 *  D. THE PRINT (strandPixels) [242-313]
 *   D1 [259-272] The half-size mask is read back bilinearly, RED and GREEN into `R`
 *      and `G` in 0..1.
 *   D2 [246, 250, 273] The threshold is jittered by one value-noise reading,
 *      `n = (noise(x/cell, y/cell) − 0.5)·(0.8·grain + 0.06)`, with
 *      `cell = max(1.4, √(W·H)·0.0026)`. Because that lattice follows the sheet's own
 *      area, exporting at 6000px enlarges this drawing instead of adding detail to it;
 *      the constant 0.06 keeps the edge from ever coming out perfectly clean, even with
 *      Grain right down.
 *   D3 [274] Ink is `G > 0.5 + n`.
 *   D4 [276-279] Where there is ink, the BLUE channel gives `dep` (near 0 at a
 *      boundary, near 1 well inside), and `miss = tex·(0.12 + 0.88·(1 − dep))` is how
 *      much of the ink is absent there. The floor of 0.12 leaves a trace of the texture
 *      showing even at maximum depth.
 *   D5 [281-292] Three arrangements the absent ink can take. All three index the
 *      sheet's own x and y and nothing local to a rod, which is why two touching rods
 *      share one continuous pattern instead of each carrying its own copy. All three sit
 *      at 1.75 rad:
 *        screen  [282-287] a square lattice at pitch `cell·4.4`, each cell keeping a
 *                disc of radius `0.72·√(1 − miss)`. 0.72 is a shade over √2/2, a unit
 *                cell's half-diagonal, so at `miss = 0` the discs meet and nothing at
 *                all is knocked out.
 *        drag    [288-290] a lattice `cell·13` along the axis by `cell·1.5` across, so
 *                its cells are far longer than they are wide; thrown against `miss` they
 *                come out as long unidirectional streaks.
 *        stipple [292] a square lattice of `cell·1.7`, one speck per cell.
 *   D6 [294-296] An absent patch switches the fill off at that pixel and does nothing
 *      else; which role then wins is left entirely to rule D7 and the passes underneath.
 *   D7 [298-301] The three roles resolve in order: fill first, then plate wherever `R`
 *      cleared the same jittered threshold, then ground.
 *   D8 [303-306] Grain last: `(hash − 0.5)·grain·46` added to all three channels
 *      alike, so it lightens and darkens without tinting.
 *   D9 [310] Every pixel opaque — a Strand sheet is a printed rectangle, not a cut-out.
 *
 *  E. PARAMS
 *   E1 [20-29] The tool's own defaults.
 *   E2 [12-18] Its five palettes, each three inks in role order (ground, plate, fill),
 *      exposed under plain-language names.
 *   E3 [9] Its three ink textures.
 *   E4 Dial ranges are the tool page's own slider mins/maxes/steps (Chains 1..40 and
 *      Length 3..90 by whole numbers, everything else 0..1 by 0.01) — they are not in
 *      the captured slice, so they were read off the live tool.
 *
 *  NOT PORTED: the motion modes [6, 27, 164, 175-181] and the aspect-ratio picker
 *  [4-5]. A Scatter is a still element whose box IS its frame, so every phase term
 *  would sit at zero and the aspect comes from the box — the same call all six earlier
 *  playgrnd ports made.
 *
 *  HOST ADAPTATIONS, each one deliberate:
 *   H1 The source's `putImageData` ignores alpha, transform and clip alike, so the
 *      whole sheet is built on an offscreen canvas at the box's paint resolution and
 *      `drawImage`d in. That keeps the layer's opacity, blend, rotation and box clip.
 *      No absolute `globalAlpha` or composite op is ever written on the caller's ctx.
 *   H2 The sheet is held under STRAND_MAX_PIXELS (6 Mpx); the tool's own export tops
 *      out at 2400² = 5.76 Mpx, so this is the same order of work.
 *   H3 Grain is one hash reading per pixel of the tool's fixed 2400px export [28], so
 *      the tooth is 1/2400 of the box WIDTH, converted to device pixels and floored at
 *      one (`strandGrainCellPx`). Preview and bake then carry the same grain rather
 *      than the bake carrying a finer one.
 *   H4 At the sheet's right-hand column the source wraps its second sample to column 0
 *      [268] where the row branch clamps [262]. That asymmetry costs one column of
 *      wrong pixels at the box's own edge, which in a Frame is a visible seam rather
 *      than a hidden export margin, so the column clamps here like the row does.
 *   H5 A rod carries the `depth` it was branched at. Paint ignores it entirely; the
 *      unit suite reads it to check rule A7 without reaching into the walk.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { LruCache } from '~/lib/compositor/silhouetteCache'

/** How the missing ink is arranged (rule D5). */
export const STRAND_TEXTURES = ['stipple', 'drag', 'screen'] as const
export type StrandTexture = typeof STRAND_TEXTURES[number]

/** The tunables. Field names follow the source so the port reads against it; the
 *  tool's own control labels are Chains / Length / Wander / Branching · Thickness /
 *  Rod length / Notch / Roughness · Off-register / Plate spread / Ink texture /
 *  Coverage / Grain, and those are what the inspector shows. */
export interface StrandParams {
  count: number            // 1..40 how many chains are started
  len: number              // 3..90 rods of life each chain begins with
  wander: number           // 0..1 how far the heading drifts per rod
  branch: number           // 0..1 how readily a chain splits
  thick: number            // 0..1 rod width, in units of √(box area)
  rod: number              // 0..1 rod length as a multiple of that width
  notch: number            // 0..1 extra clearance at every joint
  rough: number            // 0..1 how hand-drawn each rod's outline is
  offset: number           // 0..1 how far the plate impression sits off true
  edge: number             // 0..1 how much fatter the plate is than the fill
  texKind: StrandTexture   // stipple | drag | screen
  tex: number              // 0..1 how much of the fill ink is missing (Coverage)
  grain: number            // 0..1 per-pixel print grain
  inks: string[]           // ORDERED roles: [ground, plate, fill]
}

/** A named palette: one of the tool's three-ink tables, in role order (rule E2). */
export interface StrandPalettePreset { inks: readonly string[] }

export const STRAND_PALETTE_PRESETS = {
  Orchid: { inks: ['#A794C8', '#0B0B0B', '#A8DCEF'] },
  Vermilion: { inks: ['#EFE9DC', '#141414', '#F0402F'] },
  Beacon: { inks: ['#0E1626', '#F2F0E6', '#F5C542'] },
  Lime: { inks: ['#1B1B1B', '#EDEAE0', '#7CE860'] },
  Cobalt: { inks: ['#F3D9E8', '#181818', '#3B5BDB'] },
} as const satisfies Record<string, StrandPalettePreset>
export type StrandPresetName = keyof typeof STRAND_PALETTE_PRESETS
export const STRAND_PRESET_NAMES = Object.keys(STRAND_PALETTE_PRESETS) as StrandPresetName[]

export function defaultStrand(): StrandParams {
  return {
    count: 8, len: 22, wander: 0.6, branch: 0.22,
    thick: 0.42, rod: 0.5, notch: 0.18, rough: 0.55,
    offset: 0.5, edge: 0.35, texKind: 'stipple', tex: 0.4, grain: 0.42,
    inks: [...STRAND_PALETTE_PRESETS.Orchid.inks],
  }
}

/** The bounds every dial is clamped to — the tool's own slider ranges (rule E4). */
export const STRAND_LIMITS = {
  count: [1, 40], len: [3, 90],
  wander: [0, 1], branch: [0, 1], thick: [0, 1], rod: [0, 1], notch: [0, 1],
  rough: [0, 1], offset: [0, 1], edge: [0, 1], tex: [0, 1], grain: [0, 1],
} as const

/** What a preset writes: the three roles, in order. */
export function strandPresetPatch(name: StrandPresetName): Pick<StrandParams, 'inks'> {
  return { inks: [...STRAND_PALETTE_PRESETS[name].inks] }
}

/** Which preset these params spell, if any (all three roles, in order). */
export function strandPresetOf(params: StrandParams): StrandPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of STRAND_PRESET_NAMES) {
    const p = STRAND_PALETTE_PRESETS[name].inks
    if (params.inks?.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit when the shared colour picker hands back a translucent pick.
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp a possibly partial, possibly nonsense params object onto `base`. Raw layer
 *  objects reach paint un-normalized, so every reader in this file starts here. */
export function normalizeStrand(partial: unknown, base: StrandParams = defaultStrand()): StrandParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const inks = Array.isArray(p.inks) ? p.inks.filter(isHex) : base.inks.slice()
  return {
    count: Math.round(num(p.count, STRAND_LIMITS.count[0], STRAND_LIMITS.count[1], base.count)),
    len: Math.round(num(p.len, STRAND_LIMITS.len[0], STRAND_LIMITS.len[1], base.len)),
    wander: num(p.wander, 0, 1, base.wander),
    branch: num(p.branch, 0, 1, base.branch),
    thick: num(p.thick, 0, 1, base.thick),
    rod: num(p.rod, 0, 1, base.rod),
    notch: num(p.notch, 0, 1, base.notch),
    rough: num(p.rough, 0, 1, base.rough),
    offset: num(p.offset, 0, 1, base.offset),
    edge: num(p.edge, 0, 1, base.edge),
    texKind: STRAND_TEXTURES.includes(p.texKind as StrandTexture) ? p.texKind as StrandTexture : base.texKind,
    tex: num(p.tex, 0, 1, base.tex),
    grain: num(p.grain, 0, 1, base.grain),
    inks: inks.length ? inks : base.inks.slice(),
  }
}

// ── Our own hash and value noise ─────────────────────────────────────────────

/** Integer lattice hash → [0,1). Independent for every (x, y, salt) triple. Each
 *  scatter style keeps its own so the modules stay separable. */
function strandHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smoothstep-interpolated value noise on that lattice → [0,1) (rules B6, B7, D2). */
function strandNoise(x: number, y: number, salt: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = strandHash(xi, yi, salt), b = strandHash(xi + 1, yi, salt)
  const c = strandHash(xi, yi + 1, salt), d = strandHash(xi + 1, yi + 1, salt)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b]; alpha is dropped (rule D9). */
function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [v(0), v(2), v(4)]
}

/** Stands in for an empty palette — the tool's own fallback trio [ref 165]. */
const FALLBACK_INKS = ['#A794C8', '#0B0B0B', '#A8DCEF'] as const

/** The three jobs a Strand palette fills, in order [ref 166-168]. A palette shorter
 *  than three repeats the role before it rather than leaving a hole. */
export function strandRoles(params: StrandParams): { ground: string; plate: string; fill: string } {
  const pal = params.inks?.length ? params.inks : FALLBACK_INKS
  const ground = pal[0]!
  const plate = pal[1] ?? ground
  return { ground, plate, fill: pal[2] ?? plate }
}

// ── Rule A: the chains ───────────────────────────────────────────────────────

/** The ceiling on how many rods one sheet may hold (rule A9). */
export const ROD_CAP = 7000

/** One rod, positioned in √(box area) units. */
export interface StrandRod {
  x: number
  y: number
  a: number          // the chain's heading where this rod was laid, radians
  seg: number        // its length before the two caps are added (rule B2)
  sd: number         // its own sub-seed; the whole outline follows from it
  depth: number      // 0 on a chain's trunk, +1 per split (rule H5)
}

/** What one throw of the chains produced. `wide` and every rod dimension are in
 *  √(box area) units; `fw` × `fh` is the box in those units. */
export interface StrandChains {
  rods: StrandRod[]
  wide: number
  fw: number
  fh: number
}

/** A queued arm waiting to be walked. */
interface PendingArm { x: number; y: number; a: number; left: number; depth: number }

/**
 * Rule A — walk `count` branching chains over a `boxW × boxH` box from one seeded
 * stream and return the rods they laid. Pure, so the whole structure of a variation
 * tests without a canvas.
 */
export function strandWalks(params: StrandParams, boxW: number, boxH: number, seed: number): StrandChains {
  const p = normalizeStrand(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  // A2 — the box in √area units: fw·U = boxW and fh·U = boxH, with U = √(boxW·boxH).
  const aspect = H / W
  const fw = 1 / Math.sqrt(aspect), fh = Math.sqrt(aspect)
  const rnd = mulberry32(hashSeed(`${seed}:strand-chains`))
  // A3 — width, rod length, and the advance that clears both caps plus the notch.
  const wide = 0.02 + p.thick * 0.09
  const seg = wide * (0.4 + p.rod * 2.2)
  const stride = seg + wide + p.notch * wide * 0.95
  const rods: StrandRod[] = []
  const queue: PendingArm[] = []
  // A1 — the chains, drawn in the source's own order so a variation has its structure.
  const chains = Math.max(1, Math.round(p.count))
  for (let i = 0; i < chains; i++) {
    queue.push({
      x: (-0.12 + rnd() * 1.24) * fw,
      y: (-0.12 + rnd() * 1.24) * fh,
      a: rnd() * Math.PI * 2,
      left: Math.max(1, Math.round(p.len)),
      depth: 0,
    })
  }
  const cx = fw * 0.5, cy = fh * 0.5
  while (queue.length && rods.length < ROD_CAP) {
    const arm = queue.pop()!                                  // A4 — newest arm first
    let x = arm.x, y = arm.y, a = arm.a, left = arm.left
    const depth = arm.depth
    while (left-- > 0 && rods.length < ROD_CAP) {
      // A5 — the rod goes down where the walk currently stands, at its current heading.
      rods.push({ x, y, a, seg, sd: (rnd() * 9973) | 0, depth })
      x += Math.cos(a) * stride
      y += Math.sin(a) * stride
      a += (rnd() - 0.5) * p.wander * 0.9                     // A6
      // A7 — `left` is already one lower here, which is the value the split tests.
      if (depth < 3 && left > 4 && rnd() < p.branch * 0.22) {
        queue.push({
          x, y,
          a: a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6),
          left: Math.max(3, (left * (0.4 + rnd() * 0.5)) | 0),
          depth: depth + 1,
        })
      }
      // A8 — out past the apron: turn a fifth of the way towards the box's middle.
      if (x < -0.32 * fw || x > 1.32 * fw || y < -0.32 * fh || y > 1.32 * fh) {
        let da = Math.atan2(cy - y, cx - x) - a
        while (da > Math.PI) da -= Math.PI * 2
        while (da < -Math.PI) da += Math.PI * 2
        a += da * 0.2
      }
    }
  }
  return { rods, wide, fw, fh }
}

// ── Rule B: one rod's outline ────────────────────────────────────────────────

/** Steps along a rod's axis; each edge gets one more point than that (rule B4). */
export const ROD_STATIONS = 18

/**
 * Rule B — the closed outline of ONE rod, in whatever space `x`, `y`, `seg` and `wid`
 * are given in: `ROD_STATIONS + 1` points down one edge, then the same stations back
 * up the other. `grow` fattens (plate) or shrinks (depth) the half-width. Pure
 * geometry, so the tilt, the two ends and the two edges all test without a canvas.
 */
export function strandRodPath(
  x: number, y: number, a: number, seg: number, sd: number,
  wid: number, rough: number, grow: number,
): [number, number][] {
  const r = Math.max(0, Math.min(1, Number.isFinite(rough) ? rough : 0))
  const tilt = a + (strandHash(sd, 17, 3) - 0.5) * 0.42 * r          // B1
  const ca = Math.cos(tilt), sa = Math.sin(tilt)
  const nx = -sa, ny = ca
  const full = seg + wid                                             // B2
  const half = Math.max(wid * 0.05, wid * 0.5 + grow)                // B3
  const e0 = 0.06 + strandHash(sd, 3, 7) * 0.34 * r                  // B5
  const e1 = 0.06 + strandHash(sd, 9, 7) * 0.60 * r
  const left: [number, number][] = [], right: [number, number][] = []
  for (let i = 0; i <= ROD_STATIONS; i++) {
    const u = i / ROD_STATIONS
    const ramp = Math.min(u / e0, (1 - u) / e1, 1)
    const cap = Math.pow(ramp < 0 ? 0 : ramp, 0.45)
    // B6 — one noise per edge, drawn from two different salts.
    const wl = 1 + (strandNoise(u * 6.1 + sd * 0.11, sd * 0.07, sd) - 0.5) * r * 1.3
    const wr = 1 + (strandNoise(u * 5.3 + sd * 0.17, sd * 0.05, sd + 911) - 0.5) * r * 1.3
    const off = (strandNoise(u * 2.2 + sd * 0.09, 7.3, sd + 41) - 0.5) * wid * 0.55 * r   // B7
    const t = u * full - wid * 0.5
    const bx = x + ca * t + nx * off, by = y + sa * t + ny * off
    const hl = half * cap * wl, hr = half * cap * wr                 // B8
    left.push([bx + nx * hl, by + ny * hl])
    right.push([bx - nx * hr, by - ny * hr])
  }
  right.reverse()
  return [...left, ...right]
}

// ── Rule C: the three mask passes ────────────────────────────────────────────

/** The slice of a 2D context the mask draw touches, so a recording stub can stand in. */
export type StrandMaskCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'fillRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill'>
  & { globalCompositeOperation: string; filter: string }

/** One channel per pass, so the print can read all three from one buffer (rule D). */
const MASK_GROUND = '#000'
const MASK_PLATE = '#f00'
const MASK_FILL = '#0f0'
const MASK_DEPTH = '#00f'

/** Which way the plate impression slid: 135°, down and to the left [ref 181]. */
const PLATE_ANGLE = Math.PI * 0.75

/** Below this, Coverage does nothing, so the depth pass is skipped [ref 225, 253]. */
const TEX_EPS = 0.004

/**
 * Rule C — draw the plate, the fill and (when there is ink texture to measure) the
 * depth channel over an `mw × mh` mask context. Everything is derived from the mask's
 * own area unit, which is the same quantity the source reaches by scaling its
 * full-size sizes by the half-resolution factor.
 */
export function strandMasks(ctx: StrandMaskCtx, params: StrandParams, mw: number, mh: number, seed: number): void {
  const p = normalizeStrand(params)
  const MW = Math.max(1, Math.round(mw)), MH = Math.max(1, Math.round(mh))
  const MU = Math.sqrt(MW * MH)
  const { rods, wide } = strandWalks(p, MW, MH, seed)
  // C2 — ground everywhere first.
  ctx.fillStyle = MASK_GROUND
  ctx.fillRect(0, 0, MW, MH)
  const thick = wide * MU
  const slip = p.offset * 0.055 * MU                                 // C3
  const fat = thick * (1 + p.edge * 0.55)
  const grow = (fat - thick) * 0.5
  /** All the rods as ONE path, displaced by (dx, dy) and grown by `g`, then filled. */
  const stamp = (dx: number, dy: number, g: number) => {
    ctx.beginPath()
    for (const rod of rods) {
      const pts = strandRodPath(rod.x * MU + dx, rod.y * MU + dy, rod.a, rod.seg * MU, rod.sd, thick, p.rough, g)
      ctx.moveTo(pts[0]![0], pts[0]![1])
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1])
      ctx.closePath()
    }
    ctx.fill()
  }
  ctx.fillStyle = MASK_PLATE
  stamp(Math.cos(PLATE_ANGLE) * slip, Math.sin(PLATE_ANGLE) * slip, grow)
  ctx.fillStyle = MASK_FILL                                          // C4
  stamp(0, 0, 0)
  if (p.tex > TEX_EPS) {
    // C5 — a shrunken, blurred copy accumulated into the blue channel.
    const eat = thick * 0.5 * 0.38
    const entryOp = ctx.globalCompositeOperation, entryFilter = ctx.filter
    ctx.globalCompositeOperation = 'lighter'
    ctx.filter = `blur(${(eat * 0.8).toFixed(2)}px)`
    ctx.fillStyle = MASK_DEPTH
    stamp(0, 0, -eat)
    ctx.filter = entryFilter                                         // C6
    ctx.globalCompositeOperation = entryOp
  }
}

// ── Rule D: the print ────────────────────────────────────────────────────────

/**
 * H3 — the grain lattice's tooth, in BUFFER (device) pixels. The tool's grain is one
 * hash reading per pixel of its 2400px export, so the tooth is 1/2400 of the box WIDTH
 * in box units, and `scale` (device pixels per box unit) converts. Floored at one,
 * because a lattice finer than a device pixel cannot be shown anyway and a small box
 * should keep its grain rather than lose it.
 */
export function strandGrainCellPx(scale: number, boxW: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const w = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  return Math.max(1, s * w / 2400)
}

/**
 * Rule D — print the sheet: read the half-size mask back bilinearly, jitter the
 * threshold, knock the fill out where the ink is missing, resolve the three roles and
 * grain the lot. `mask` is RGBA of `mw × mh`; returns RGBA for `w × h`. Pure, so the
 * whole print tests without a canvas.
 */
export function strandPixels(
  mask: Uint8ClampedArray, mw: number, mh: number, w: number, h: number,
  params: StrandParams, seed: number, grainCell = 1,
): Uint8ClampedArray {
  const p = normalizeStrand(params)
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  const MW = Math.max(1, Math.round(mw)), MH = Math.max(1, Math.round(mh))
  const out = new Uint8ClampedArray(W * H * 4)
  const roles = strandRoles(p)
  const ground = hexToRgb(roles.ground), plate = hexToRgb(roles.plate), fill = hexToRgb(roles.fill)
  const s = seed | 0
  const cut = 0.5, spread = 0.8 * p.grain + 0.06                     // D2
  const gl = p.grain * 46                                            // D8
  const tooth = Number.isFinite(grainCell) && grainCell > 0 ? grainCell : 1
  const cell = Math.max(1.4, Math.sqrt(W * H) * 0.0026)
  const texOn = p.tex > TEX_EPS
  const speck = cell * 1.7                                           // D5 stipple
  const along = cell * 13, across = cell * 1.5                       // D5 drag
  const pitch = cell * 4.4                                           // D5 screen
  const tca = Math.cos(1.75), tsa = Math.sin(1.75)
  const sx = MW / W, sy = MH / H                                     // D1
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
      let x1 = x0 + 1; if (x1 > MW - 1) x1 = MW - 1        // H4 — clamps, never wraps
      const i00 = r0 + x0 * 4, i01 = r0 + x1 * 4, i10 = r1 + x0 * 4, i11 = r1 + x1 * 4
      const ra = mask[i00]! + (mask[i01]! - mask[i00]!) * fx
      const rb = mask[i10]! + (mask[i11]! - mask[i10]!) * fx
      const ga = mask[i00 + 1]! + (mask[i01 + 1]! - mask[i00 + 1]!) * fx
      const gb = mask[i10 + 1]! + (mask[i11 + 1]! - mask[i10 + 1]!) * fx
      const R = (ra + (rb - ra) * fy) / 255
      const G = (ga + (gb - ga) * fy) / 255
      const n = (strandNoise(x / cell, y / cell, s + 29) - 0.5) * spread
      let ink = G > cut + n                                          // D3
      if (ink && texOn) {
        const ba = mask[i00 + 2]! + (mask[i01 + 2]! - mask[i00 + 2]!) * fx
        const bb = mask[i10 + 2]! + (mask[i11 + 2]! - mask[i10 + 2]!) * fx
        const dep = (ba + (bb - ba) * fy) / 255                      // D4 — 0 at a boundary
        const miss = p.tex * (0.12 + 0.88 * (1 - dep))
        let gap: boolean
        if (p.texKind === 'screen') {
          const u = (x * tca + y * tsa) / pitch, v = (y * tca - x * tsa) / pitch
          const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5
          const cov = 1 - miss
          const rad = 0.72 * Math.sqrt(cov > 0 ? cov : 0)
          gap = (fu * fu + fv * fv) > rad * rad
        } else if (p.texKind === 'drag') {
          const u = (x * tca + y * tsa) / along, v = (y * tca - x * tsa) / across
          gap = strandHash(Math.floor(u), Math.floor(v), s + 17) < miss
        } else {
          gap = strandHash(Math.floor(x / speck), Math.floor(y / speck), s + 13) < miss
        }
        if (gap) ink = false                                         // D6
      }
      // D7 — fill first; failing that the plate where it reached; failing that ground.
      const col = ink ? fill : (R > cut + n ? plate : ground)
      let cr = col[0], cg = col[1], cb = col[2]
      if (gl > 0.002) {
        const j = (strandHash(Math.floor(x / tooth), Math.floor(y / tooth), s + 71) - 0.5) * gl
        cr += j; cg += j; cb += j
      }
      out[q] = cr; out[q + 1] = cg; out[q + 2] = cb
      out[q + 3] = 255                                               // D9
    }
  }
  return out
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The slice of a 2D context `paintStrand` needs (a recording stub can stand in). */
export type StrandCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'drawImage'>
  & { getTransform?: () => { a: number; b: number } }

/** H2 — the per-pixel budget for one sheet, whatever the box or the zoom. */
const STRAND_MAX_PIXELS = 6_000_000

/** Device pixels per box unit, off the ctx transform (1 when the ctx cannot say). */
function ctxScale(ctx: StrandCtx): number {
  const m = ctx.getTransform?.()
  const s = Math.hypot(Number(m?.a ?? 1), Number(m?.b ?? 0))
  return Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * Sheet cache. Printing a sheet is three canvas passes over every rod plus a per-pixel
 * loop over the whole box, and dragging the layer changes none of that — only where the
 * result is drawn. Keying on everything that DOES decide the pixels (the buffer size,
 * every dial, the three inks, the seed and the grain tooth) makes a drag frame a hit.
 * Bounded by an entry count AND a byte budget, since one capped sheet is 24 MB.
 */
const SHEET_CACHE_CAP = 12
const SHEET_CACHE_BYTES = 128 * 1024 * 1024
const sheetCache = new LruCache<{ img: CanvasImageSource; bytes: number }>(SHEET_CACHE_CAP, {
  maxBytes: SHEET_CACHE_BYTES,
  sizeOf: v => v.bytes,
})

function sheetKey(pw: number, ph: number, p: StrandParams, seed: number, tooth: number): string {
  return [
    pw, ph, seed, tooth.toFixed(4),
    p.count, p.len, p.wander, p.branch, p.thick, p.rod, p.notch, p.rough,
    p.offset, p.edge, p.texKind, p.tex, p.grain, p.inks.join(','),
  ].join('|')
}

/** Build one printed sheet at `pw × ph`, or null where there is no canvas to be had
 *  (SSR, or a stub without createElement). */
function renderSheet(pw: number, ph: number, p: StrandParams, seed: number, tooth: number): CanvasImageSource | null {
  if (typeof document === 'undefined') return null
  // C1 — the mask is half the sheet in each direction.
  const mw = Math.max(2, Math.round(pw * 0.5)), mh = Math.max(2, Math.round(ph * 0.5))
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = mw; maskCanvas.height = mh
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!mctx) return null
  strandMasks(mctx, p, mw, mh, seed)
  const maskData = mctx.getImageData(0, 0, mw, mh).data
  const sheet = document.createElement('canvas')
  sheet.width = pw; sheet.height = ph
  const sctx = sheet.getContext('2d')
  if (!sctx) return null
  const img = sctx.createImageData(pw, ph)
  img.data.set(strandPixels(maskData, mw, mh, pw, ph, p, seed, tooth))
  sctx.putImageData(img, 0, 0)
  return sheet
}

/** Memoized `renderSheet` — a hit skips all three mask passes and the print. */
function memoSheet(pw: number, ph: number, p: StrandParams, seed: number, tooth: number): CanvasImageSource | null {
  const key = sheetKey(pw, ph, p, seed, tooth)
  const hit = sheetCache.get(key)
  if (hit) return hit.img
  const img = renderSheet(pw, ph, p, seed, tooth)
  if (img) sheetCache.set(key, { img, bytes: pw * ph * 4 })
  return img
}

/**
 * H1 — paint one Strand sheet at the ctx's origin over `boxW × boxH`. The sheet is
 * built offscreen at the box's paint resolution and drawn in, so the layer's opacity,
 * blend, transform and box clip all survive.
 */
export function paintStrand(ctx: StrandCtx, params: StrandParams, boxW: number, boxH: number, seed: number): void {
  const p = normalizeStrand(params)
  const W = Number.isFinite(boxW) && boxW > 0 ? boxW : 1
  const H = Number.isFinite(boxH) && boxH > 0 ? boxH : 1
  const scale = Math.min(ctxScale(ctx), Math.sqrt(STRAND_MAX_PIXELS / (W * H)))
  const pw = Math.max(2, Math.round(W * scale)), ph = Math.max(2, Math.round(H * scale))
  const img = memoSheet(pw, ph, p, seed, strandGrainCellPx(scale, W))
  if (img) { ctx.drawImage(img, 0, 0, W, H); return }
  // Nowhere to render: lay the ground down on its own, so the box carries the
  // picture's colour instead of showing as a hole.
  ctx.fillStyle = strandRoles(p).ground
  ctx.fillRect(0, 0, W, H)
}
