import type { Params } from '~/lib/spacetype/effect'

export type RGBA = [number, number, number, number]

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const out = (c: [number, number, number]): RGBA => [c[0], c[1], c[2], 1]

// Deterministic 0..1 hash of an integer cell index.
function hash1(i: number): number {
  let x = (i | 0) * 374761393 + 668265263
  x = (x ^ (x >>> 13)) * 1274126177
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

const posmod = (a: number, n: number) => ((a % n) + n) % n
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const fract = (x: number) => x - Math.floor(x)

// --- Chips: irregular scattered cells (terrazzo / mosaic / pebbles) ---------
// Every other Texture Studio mode is a REGULAR lattice; chips is cell noise
// (Worley) on a WRAPPED grid: one hashed feature point per cell, each with its
// own hashed radius scale, and a pixel belongs to the chip whose feature point
// is nearest in radius-weighted distance. Grout appears where the nearest and
// the second-nearest (from a DIFFERENT chip) are nearly tied, which is the
// mathematical definition of "on the boundary between two cells".
//
// Seamless BY CONSTRUCTION, not by luck: a feature point's offset and radius are
// hashed from the cell id already taken mod `cells`, while its POSITION is that
// id's un-wrapped grid coordinate. At u=0 the window spans cells -2..2 and at
// u=1 it spans cells-2..cells+2 — the same wrapped ids at the same relative
// offsets, so both edges of the tile compute the identical distance set.
//
// Mirrorable: pure arithmetic over the loop bounds below, no Math.random, no
// closures over mutable state, no per-render caches. The shader twin runs the
// same fixed 5×5 loop with the same salts.

/**
 * Half-width of the neighbourhood scanned for feature points (5×5 window).
 *
 * The RIGOROUS bound is 4, not 2. A cell at Chebyshev ring k can hold a point as
 * close as k−1 (pixel at the near edge of its own cell, point at the near edge of
 * the ring cell), so its weighted distance is at worst (k−1)/CHIP_R_MAX. The
 * pixel's own cell always offers F1 ≤ √2/CHIP_R_MIN. Ring N+1 is therefore
 * provably unreachable only when N/CHIP_R_MAX > √2/CHIP_R_MIN, i.e.
 * N > √2 · CHIP_R_MAX/CHIP_R_MIN = 3.54 → N = 4.
 *
 * 2 is licensed EMPIRICALLY, not by that inequality: the worst case needs the
 * pixel's own chip to be simultaneously the smallest and the furthest, which the
 * hash does not actually produce. Measured over 240k samples (every cell count,
 * sizeVar 1), the nearest candidate outside the 5×5 window never came closer
 * than 1.275× the winning distance. Two tests hold that honest — the global
 * toroidal brute force (which fails outright at N=1) and the margin measurement
 * in texturefx-chips.unit.spec.ts.
 *
 * The invariant that licenses it is CHIP_R_MAX/CHIP_R_MIN ≤ 2.5. Widening the
 * radius range breaks the empirical margin, so a unit test asserts the ratio: if
 * you need wilder chips, raise this to 4 (a 9×9 GLSL loop) rather than gambling.
 */
export const CHIP_NEIGHBORHOOD = 2
/** Hashed radius-scale range at chipSizeVar = 1 (1.0 = every chip the same).
 *  CHIP_R_MAX/CHIP_R_MIN must stay ≤ 2.5 — see CHIP_NEIGHBORHOOD. */
export const CHIP_R_MIN = 0.6
export const CHIP_R_MAX = 1.5
/**
 * Ink roles chips cycle through; the ground/grout role is index CHIP_INK_ROLES.
 * Kept in step with ROLES_BY_FAMILY.chips in roles.ts (pinned by a unit test).
 *
 * DECIDED: this stays 2. Two chip colours + ground, with colour jitter supplying
 * the tonal variety — the terrazzo recipe promises a TWO-TONE terrazzo, not the
 * "3-4 muted chips" the design sketch imagined. A third chip colour is not a
 * one-line change: the fill machinery resolves exactly three roles end-to-end
 * (renderer.ts's u_fillType[3] / u_fillFrame[3] / u_fillC0[3] / u_fillStops[12] /
 * u_strokeRole[3] uniform arrays and the render() loop `for (r = 0; r < 3; r++)`),
 * so a 4th role needs all of those widened first. Follow-up, not a footnote.
 */
export const CHIP_INK_ROLES = 2
/** How far colour jitter may carry a chip toward white or black: at jitter 1 a
 *  chip travels at most 0.5 × this = 30% of the way. See chipTone(). */
export const CHIP_TONE_RANGE = 0.6

/**
 * Ink roles the DEALT GRID cycles through; the ground role is index DEALT_INK_ROLES.
 * Kept in step with ROLES_BY_FAMILY.dealtgrid in roles.ts (pinned by a unit test).
 *
 * Two inks + ground, exactly like chips — and for the same reason: the fill
 * machinery resolves exactly three roles end-to-end (renderer.ts's u_fillType[3] …
 * and the render() `for (r = 0; r < 3; r++)` loop), and roles.ts's legacyColor()
 * hard-maps roleIndex 2 to the background, so a third ink is not a one-line change.
 */
export const DEALT_INK_ROLES = 2

/**
 * Salts keeping the six per-cell hashes independent. Fractional, so `seed +
 * SALT` can never collide with another integer seed's salted value.
 *
 * EXPORTED so the shader twin cannot drift from these numbers. Unlike the other
 * chip constants (which renderer.ts interpolates straight into its GLSL template
 * literal), the salts reach the GPU as a UNIFORM: chipSaltLanes() there folds
 * each `seed + salt` through the hash's first step in float64 and uploads the
 * 0..1 result. The reason is that chipHash AMPLIFIES — a ~1e-4 error in that
 * lane leaves as a full-range change, so float32's rounding of `seed + salt`
 * (harmless-looking: the ulp never even reaches the smallest salt) rewrites the
 * field wholesale, ~47% of the tile already at seed 12345. Either way — never
 * retype the numbers in the shader.
 */
export const CHIP_SALT_X = 0.317
export const CHIP_SALT_Y = 1.523
export const CHIP_SALT_R = 2.719
export const CHIP_SALT_ROLE = 3.911
export const CHIP_SALT_TONE = 4.507
/** Lane 5 — the DENSITY dropout (see chipSample). Appended, never inserted: the
 *  five lanes above must keep their index, or every saved terrazzo reshuffles. */
export const CHIP_SALT_DENSITY = 5.213

/**
 * Per-cell hash to 0..1 — Dave Hoskins' hash13, the same construction the GLSL
 * `cellHash()` in renderer.ts uses, so the shader branch computes the same chips
 * from the same salts (shared formula, like truchetStates' shared grid).
 * Precision-safe: it never forms a huge float, unlike hash1's multiply-by-primes
 * above. The CPU runs it in float64 and the GPU in float32, so the low bits can
 * differ — that can nudge a feature point by ~1e-7, never break the wrap.
 *
 * One deviation from renderer.ts's cellHash, and it matters: stock hash13 adds
 * the SAME constant (33.33) to all three lanes, which makes the mix symmetric in
 * x and y — cellHash(1,2) === cellHash(2,1). On a scattered field that mirrors
 * every chip across the tile diagonal. A per-lane constant breaks the symmetry.
 * The shader twin must use this vector, not the scalar.
 *
 *   vec3 p = fract(vec3(cx, cy, salt) * 0.1031);
 *   p += dot(p, p.yzx + vec3(33.33, 41.17, 27.83));
 *   return fract((p.x + p.y) * p.z);
 */
export function chipHash(cx: number, cy: number, salt: number): number {
  let px = fract(cx * 0.1031), py = fract(cy * 0.1031), pz = fract(salt * 0.1031)
  const d = px * (py + 33.33) + py * (pz + 41.17) + pz * (px + 27.83)   // dot(p, p.yzx + vec3(...))
  px += d; py += d; pz += d
  return fract((px + py) * pz)
}

/**
 * The one cell that is NEVER dropped, whatever the density: the cell whose
 * density-lane hash is lowest across the whole tile.
 *
 * Why it exists: the Density floor bounds the drop RATE, not the OUTCOME. Every
 * cell is an independent coin flip, so a small grid can come up empty — at
 * chipCells 4 and density 0.15 that is 0.85^16 ≈ 7.4% of seeds, and 35 of the
 * first 400 seeds really did render a completely blank tile. A control that can
 * produce a blank tile reads as broken, and Roll walks straight into it.
 *
 * Keeping the cell is only half of it: grout is applied afterwards and swallowed
 * the lone survivor whole (chipCells 4 / grout 0.25 / density 0.15 / seed 16 was
 * still blank), so chipSample() also exempts this cell from the grout test while
 * it is the ONLY chip in the tile. "Kept cell" and "visible chip" are not the
 * same claim.
 *
 * Which is why `second` — the SECOND-smallest density-lane hash — is returned
 * alongside the winner. "This cell is the only chip" is exactly `second >=
 * density`: the kept cell always draws, and every other cell draws iff its hash
 * is below density, so the runner-up failing the test means nothing else drew.
 * The narrower test "the kept cell was rescued from its own hash" is NOT enough
 * and was measured failing: at chipCells 4 / density 0.15, seeds 20, 38 and 47
 * put the minimum hash just BELOW the threshold (0.131, 0.065, 0.122), so the
 * cell survived on its own merits, was still the only chip, and grout 0.25 ate
 * it. `second` catches those; a rescue is just the sub-case where the minimum
 * fails too.
 *
 * Keeping the ARGMIN rather than a fixed cell is what makes this invisible: that
 * cell is the last one any density would have dropped, so raising density never
 * un-keeps it and the field only ever grows monotonically. A no-op at density 1
 * (nothing is dropped there anyway), so the byte-identity pin is untouched.
 *
 * A function of (cells, seed) ALONE — not of the pixel — which is the whole
 * reason the shader can mirror it. The GPU cannot scan C² cells per pixel, so
 * renderer.ts calls this once per render and uploads the result as the
 * `u_chipKeep` vec2, the same trick chipSaltLanes() uses. One implementation,
 * no retyped twin.
 *
 * Ties go to the first in row-major order (strict `<`), so it is deterministic.
 */
export function chipKeepCell(cells: number, seed: number): { cx: number; cy: number; second: number } {
  const C = Math.max(2, Math.round(cells) || 12)
  let best = Infinity, second = Infinity, bx = 0, by = 0
  for (let cy = 0; cy < C; cy++) {
    for (let cx = 0; cx < C; cx++) {
      const h = chipHash(cx, cy, seed + CHIP_SALT_DENSITY)
      if (h < best) { second = best; best = h; bx = cx; by = cy }
      else if (h < second) { second = h }
    }
  }
  return { cx: bx, cy: by, second }
}

// Single-slot memo, the same shape as cachedStates(): chipSample() is called
// per-pixel with a fixed (cells, seed) per render, so the C² scan runs once.
// Keyed by both, so it is a pure function of its inputs, not hidden state.
// It DEGRADES rather than breaks if two parameter sets interleave (a sweep, or a
// second chips render mid-frame): the key misses every call and each pixel pays
// the C² scan — correct, just slow. Widen to an LRU if that ever shows up.
type ChipKeep = ReturnType<typeof chipKeepCell>
let _keepCache: { key: string, cell: ChipKeep } | null = null
function cachedKeep(cells: number, seed: number): ChipKeep {
  const key = `${cells}|${seed}`
  if (!_keepCache || _keepCache.key !== key) _keepCache = { key, cell: chipKeepCell(cells, seed) }
  return _keepCache.cell
}

export type ChipFeature = { x: number; y: number; r: number }

/** The feature point of wrapped cell (cx,cy): its offset INSIDE the cell (0..1)
 *  plus a radius scale. sizeVar blends 1.0 (every chip identical) toward the
 *  hashed [CHIP_R_MIN, CHIP_R_MAX] range — a bigger radius divides the weighted
 *  distance by more, so that chip claims more ground. */
export function chipFeature(cx: number, cy: number, seed: number, sizeVar: number): ChipFeature {
  const spread = CHIP_R_MIN + chipHash(cx, cy, seed + CHIP_SALT_R) * (CHIP_R_MAX - CHIP_R_MIN)
  return {
    x: chipHash(cx, cy, seed + CHIP_SALT_X),
    y: chipHash(cx, cy, seed + CHIP_SALT_Y),
    r: 1 + clamp01(sizeVar) * (spread - 1),
  }
}

export type ChipSample = {
  /** 0..CHIP_INK_ROLES-1 = the chip's ink role; CHIP_INK_ROLES = grout/ground. */
  role: number
  /** Wrapped id of the owning chip's cell. */
  cellX: number
  cellY: number
  /** Weighted distance to the nearest feature point, and to the nearest one
   *  belonging to a DIFFERENT chip (so a chip never grouts against itself). */
  f1: number
  f2: number
  /** Per-chip 0..1 hash — what colour jitter rides. */
  tone: number
}

/**
 * @param density Fraction of cells that draw a chip at all, 0..1. The cell keeps
 *   its chip iff `chipHash(cell, seed + CHIP_SALT_DENSITY) < density`; the hash
 *   is a 0..1 fraction that never reaches 1, so density 1 keeps EVERY cell and
 *   reproduces the fully-packed field byte for byte. That back-compat is pinned
 *   by a characterization test holding the pre-Density role field as a literal.
 *   Defaults to 1 so a caller written before Density is unchanged.
 *
 *   ONE cell is exempt: the tile's minimum-hash cell is force-kept at any density,
 *   and while it is being force-kept it also skips the GROUT test, so no
 *   combination of density, grout, grid and seed renders a blank tile. Both
 *   halves were needed — see chipKeepCell for why the floor alone did not
 *   guarantee it, and the `forced` branch below for why keeping a CELL was not
 *   the same as drawing a CHIP. Inert at density 1, where nothing is dropped, so
 *   the packed field is untouched.
 *
 *   A DROPPED CELL FALLS TO GROUND, across its whole area: the test is applied to
 *   the F1 owner AFTER the nearest-point search and BEFORE grout, so the survivors
 *   keep exactly the shapes they had at density 1 and the holes read as chips
 *   SCATTERED ON GROUND (speckle, confetti, sparse terrazzo). Grout is irrelevant
 *   inside a hole — a dropped cell is ground even at grout 0.
 *
 *   The rejected alternative, noted here because it is the other reasonable
 *   reading: drop the cell from the CANDIDATE SET instead, so the nearest
 *   surviving chip wins the pixel and chips GROW into the gaps — a "packed"
 *   variant, coarser chips at low density rather than fewer. That needs the drop
 *   test inside the neighbourhood loop (and a wider window, since a survivor may
 *   now have to reach past several dropped rings), so it is a future mode, not a
 *   flag on this one.
 */
export function chipSample(
  u: number, v: number, cells: number, seed: number, grout: number, sizeVar: number,
  density = 1,
): ChipSample {
  const C = Math.max(2, Math.round(cells) || 12)
  const gx = u * C, gy = v * C
  const ix = Math.floor(gx), iy = Math.floor(gy)
  let f1 = Infinity, f2 = Infinity, id1 = -1, cx1 = 0, cy1 = 0
  for (let dy = -CHIP_NEIGHBORHOOD; dy <= CHIP_NEIGHBORHOOD; dy++) {
    for (let dx = -CHIP_NEIGHBORHOOD; dx <= CHIP_NEIGHBORHOOD; dx++) {
      const jx = ix + dx, jy = iy + dy
      const cx = posmod(jx, C), cy = posmod(jy, C)
      const f = chipFeature(cx, cy, seed, sizeVar)
      const d = Math.hypot(gx - (jx + f.x), gy - (jy + f.y)) / f.r
      const id = cy * C + cx
      if (d < f1) {
        // The old best becomes the best-of-the-others — unless it was this very
        // chip seen through another wrap window, in which case f2 already holds
        // the nearest point of a different chip.
        if (id !== id1) f2 = f1
        f1 = d; id1 = id; cx1 = cx; cy1 = cy
      } else if (id !== id1 && d < f2) {
        f2 = d
      }
    }
  }
  const gap = Math.max(0, Number(grout) || 0)
  // Density dropout — see the @param note above. Non-finite (an unset param on an
  // older scene) reads as 1, the packed field. `>= dens` is the exact negation of
  // "kept iff hash < dens"; the shader twin carries that same comparison.
  // The tile's minimum-hash cell is force-kept so no density can render a blank
  // tile — see chipKeepCell(). A no-op at density 1, where nothing drops anyway.
  const dens = clamp01(Number.isFinite(density) ? density : 1)
  const keep = cachedKeep(C, seed)
  const isKeep = cx1 === keep.cx && cy1 === keep.cy
  const dropped = !isKeep && chipHash(cx1, cy1, seed + CHIP_SALT_DENSITY) >= dens
  // `lone` = the kept cell is the ONLY chip in the tile (the runner-up hash failed
  // the density test, so nothing else drew — see chipKeepCell). That last chip
  // must skip the GROUT test too, or the rescue is undone: its F2 neighbours are
  // still there geometrically (a dropped cell keeps its feature point, it just
  // isn't drawn), so a wide grout swallowed it and the tile went blank anyway.
  // There is nothing left for it to grout against. Inert at density 1, where the
  // runner-up always passes — so the packed field is untouched.
  const lone = isKeep && keep.second >= dens
  const isGround = dropped || (!lone && f2 - f1 < gap)
  const role = isGround
    ? CHIP_INK_ROLES
    : Math.min(CHIP_INK_ROLES - 1, Math.floor(chipHash(cx1, cy1, seed + CHIP_SALT_ROLE) * CHIP_INK_ROLES))
  return { role, cellX: cx1, cellY: cy1, f1, f2, tone: chipHash(cx1, cy1, seed + CHIP_SALT_TONE) }
}

export type DealtGridSample = {
  /** 0..DEALT_INK_ROLES-1 = the cell's ink role; DEALT_INK_ROLES = ground/empty. */
  role: number
  /** Wrapped id of the owning grid cell. */
  cellX: number
  cellY: number
}

/**
 * The dealt grid: a rigid `cells × cells` grid in UV space (NOT Worley scatter),
 * the tileable cousin of the Frame's generative deal. Seamless BY CONSTRUCTION —
 * every per-cell quantity is hashed on the WRAPPED cell index posmod(ix,C),
 * posmod(iy,C), so the tile repeats without a visible seam. Shares the chip hash
 * and salt lanes (chipHash + CHIP_SALT_*), so the GLSL twin reuses the exact same
 * u_chipSalt uniforms and needs no new hash — that is what keeps the twins in step.
 *
 * Per cell:
 *  - ROLE by hash: floor(chipHash(cx,cy,seed+ROLE) * DEALT_INK_ROLES) → ink 0/1.
 *  - DENSITY DROP: if chipHash(cx,cy,seed+DENSITY) >= density the cell is empty
 *    (ground), EXCEPT the force-kept min-hash cell (chipKeepCell, shared with
 *    chips), so no density can render a fully-blank tile. A dropped cell is ground
 *    across its WHOLE area — filled cells SCATTERED on ground, not grown.
 *  - SIZE VARIANCE: inset = sizeVar * chipHash(cx,cy,seed+R) * 0.5 shrinks the
 *    filled square toward its centre (a gutter / irregular-tile look); the cell
 *    outside the inset is ground. sizeVar 0 → flush cells (rigid grid).
 *
 * The lone survivor (kept cell is the only one left, keep.second >= density) is
 * drawn FLUSH — its inset is skipped — so the guaranteed cell is always fully
 * visible, mirroring the way chipSample() exempts its lone survivor from grout.
 * Inert at density 1, where nothing is dropped.
 *
 * @param density Fraction of cells that fill, 0..1. Non-finite reads as 1 (a scene
 *   saved before the control), which fills every cell. `>= density` is the exact
 *   negation the GLSL twin carries.
 * @param sizeVar Inset amount, 0..1. Non-finite reads as 0 (flush rigid grid).
 */
export function dealtGridSample(
  u: number, v: number, cells: number, seed: number, density = 1, sizeVar = 0,
): DealtGridSample {
  const C = Math.max(2, Math.round(cells) || 8)
  const gx = u * C, gy = v * C
  const ix = Math.floor(gx), iy = Math.floor(gy)
  const cx = posmod(ix, C), cy = posmod(iy, C)
  const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy)
  const dens = clamp01(Number.isFinite(density) ? density : 1)
  // Reuse chips' force-keep (a pure function of cells+seed): the min density-lane
  // hash cell is never dropped, so no density renders a blank tile.
  const keep = cachedKeep(C, seed)
  const isKeep = cx === keep.cx && cy === keep.cy
  const dropped = !isKeep && chipHash(cx, cy, seed + CHIP_SALT_DENSITY) >= dens
  // `lone` = the kept cell is the ONLY survivor (runner-up density hash failed the
  // test). It draws flush so the guaranteed cell is fully visible, not shrunk to a
  // dot by its own size hash. Inert at density 1 (runner-up always passes).
  const lone = isKeep && keep.second >= dens
  const sv = clamp01(Number.isFinite(sizeVar) ? sizeVar : 0)
  const inset = lone ? 0 : sv * chipHash(cx, cy, seed + CHIP_SALT_R) * 0.5
  const inInset = fx >= inset && fx <= 1 - inset && fy >= inset && fy <= 1 - inset
  const isGround = dropped || !inInset
  const role = isGround
    ? DEALT_INK_ROLES
    : Math.min(DEALT_INK_ROLES - 1, Math.floor(chipHash(cx, cy, seed + CHIP_SALT_ROLE) * DEALT_INK_ROLES))
  return { role, cellX: cx, cellY: cy }
}

/**
 * Colour jitter for a chip. Procedural mode spends `jitter` on a per-cell coin
 * flip that swaps the two ink roles (see `swap` in patternColor below); a chip
 * already picks its ink role by hash, so a swap there would be invisible — the
 * same knob shifts the chip's LIGHTNESS instead, which is what varied terrazzo
 * chips actually need.
 *
 * The chip is MIXED toward white (tone > 0.5) or black (tone < 0.5) by
 * |tone − 0.5| · jitter · CHIP_TONE_RANGE — at most 30% of the way. Not a
 * multiply: scaling an already-light palette clips, and clipping is not a
 * subtle loss. The studio's own default chipA (#e8eef5) drove 27.5% of its
 * pixels to pure white under a ×gain, collapsing 69 distinct chip tones into 49
 * colours — the lightest quarter of the terrazzo went flat. A mix toward an
 * endpoint can never leave the 0..1 cube, so every distinct tone stays a
 * distinct colour whatever the palette.
 *
 * At jitter 0 the mix amount is exactly 0, so the chip is the role colour to the
 * bit. Trivially mirrorable — one GLSL mix(), no clamp, no branch:
 *
 *   col = mix(col, vec3(step(0.5, tone)), abs(tone - 0.5) * u_jitter * ${CHIP_TONE_RANGE});
 */
export function chipTone(c: [number, number, number], tone: number, jitter: number): [number, number, number] {
  const amt = Math.abs(tone - 0.5) * clamp01(jitter) * CHIP_TONE_RANGE
  const target = tone > 0.5 ? 1 : 0
  return [c[0] + (target - c[0]) * amt, c[1] + (target - c[1]) * amt, c[2] + (target - c[2]) * amt]
}

/**
 * Toroidal, deterministic Truchet state field (0/1) for "structured" placement.
 * Seeds a hashed random field, then runs fixed coherence-weighted majority
 * smoothing passes (each cell adopts its 4 toroidal neighbours' majority with
 * probability `coherence`). Wraps because every index is taken mod `cells`.
 */
export function truchetStates(cells: number, seed: number, coherence: number): Uint8Array {
  const n = cells * cells
  const f = new Uint8Array(n)
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      f[y * cells + x] = hash1(x * 73856093 + y * 19349663 + seed * 83492791) < 0.5 ? 0 : 1
    }
  }
  const co = clamp01(coherence)
  const PASSES = 3
  for (let pass = 0; pass < PASSES; pass++) {
    const g = f.slice()
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        if (hash1(x * 26699 + y * 43889 + pass * 15485863 + seed * 2246822519) >= co) continue
        const up = f[((y - 1 + cells) % cells) * cells + x]
        const dn = f[((y + 1) % cells) * cells + x]
        const lf = f[y * cells + ((x - 1 + cells) % cells)]
        const rt = f[y * cells + ((x + 1) % cells)]
        const sum = up + dn + lf + rt
        if (sum >= 3) g[y * cells + x] = 1
        else if (sum <= 1) g[y * cells + x] = 0
        // sum === 2 is a tie → keep current state
      }
    }
    f.set(g)
  }
  return f
}

// Single-entry memo: patternColor is called per-pixel with fixed params per
// render, and only one Texture Studio renders at a time, so one slot suffices.
// (If coherence is ever animated frame-to-frame, widen this to an LRU.)
let _statesCache: { key: string, grid: Uint8Array } | null = null
function cachedStates(cells: number, seed: number, coherence: number): Uint8Array {
  const key = `${cells}|${seed}|${coherence}`
  if (!_statesCache || _statesCache.key !== key) _statesCache = { key, grid: truchetStates(cells, seed, coherence) }
  return _statesCache.grid
}

// Per-base-cell subdivision level (0 = whole-cell arc, 1 = 3×3 subdivided).
// A toroidal coherent value field thresholded at `subdivide`, so subdivided
// regions cluster and the tile wraps.
export function multiscaleLevels(cells: number, seed: number, subdivide: number): Uint8Array {
  const sd = clamp01(subdivide)
  const val = new Float64Array(cells * cells)
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) val[y * cells + x] = hash1(x * 60493 + y * 19990303 + seed * 6151)
  }
  // 2 plain box-blur passes (not truchetStates' stochastic majority): a smaller correlation radius keeps subdivided regions as compact clusters rather than large blobs.
  for (let pass = 0; pass < 2; pass++) {
    const blurred = val.slice()
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const up = val[((y - 1 + cells) % cells) * cells + x], dn = val[((y + 1) % cells) * cells + x]
        const lf = val[y * cells + ((x - 1 + cells) % cells)], rt = val[y * cells + ((x + 1) % cells)]
        blurred[y * cells + x] = (val[y * cells + x] + up + dn + lf + rt) / 5
      }
    }
    val.set(blurred)
  }
  const lvl = new Uint8Array(cells * cells)
  for (let i = 0; i < lvl.length; i++) lvl[i] = val[i] < sd ? 1 : 0
  return lvl
}

let _levelCache: { key: string, grid: Uint8Array } | null = null
function cachedLevels(cells: number, seed: number, subdivide: number): Uint8Array {
  const key = `${cells}|${seed}|${subdivide}`
  if (!_levelCache || _levelCache.key !== key) _levelCache = { key, grid: multiscaleLevels(cells, seed, subdivide) }
  return _levelCache.grid
}

export function latticeCell(lattice: string, cells: number, u: number, v: number) {
  let gx = u * cells
  let gy = v * cells
  const row = Math.floor(gy)
  const col = Math.floor(gx)
  if (lattice === 'brick' && posmod(row, 2) === 1) gx += 0.5
  // diagonal = independent half-cell offsets on both axes (odd rows shift x,
  // odd columns shift y) → a quincunx/diamond lattice. row & col are read from
  // the original grid, so the two offsets stay independent. Seamless for even cells.
  if (lattice === 'diagonal') {
    if (posmod(row, 2) === 1) gx += 0.5
    if (posmod(col, 2) === 1) gy += 0.5
  }
  const cx = posmod(Math.floor(gx), cells)
  const cy = posmod(Math.floor(gy), cells)
  return { cx, cy, fx: gx - Math.floor(gx), fy: gy - Math.floor(gy) }
}

// True where pixel (fx,fy) lies on one of the two quarter-circle arcs for `state`.
// state 0 joins corners (0,0)&(1,1); state 1 joins (1,0)&(0,1). Either way the
// arcs hit all four edge midpoints, so neighbours connect.
function arcCoverage(fx: number, fy: number, state: number, tw: number): boolean {
  const c0x = state === 0 ? 0 : 1, c0y = 0
  const c1x = state === 0 ? 1 : 0, c1y = 1
  const d0 = Math.abs(Math.hypot(fx - c0x, fy - c0y) - 0.5)
  const d1 = Math.abs(Math.hypot(fx - c1x, fy - c1y) - 0.5)
  return d0 < tw * 0.5 || d1 < tw * 0.5
}

// --- Truchet families ------------------------------------------------------
// Per-cell state ∈ {0,1} chosen by a seamless hash of the already-modded cell
// index (so it wraps), biased by rotBias. Each family is fully edge-connected
// and tiles seamlessly for any state combination.
function truchetColor(
  fam: string, fx: number, fy: number, cx: number, cy: number, state: number, tw: number,
  A: [number, number, number], B: [number, number, number], BG: [number, number, number],
): RGBA {
  if (fam === 'diagonal') {
    // state 0: split by main diagonal (ink below fy<fx); state 1: anti-diagonal.
    const side = state === 0 ? fy < fx : fy < 1 - fx
    return out(side ? A : B)
  }
  if (fam === 'maze') {
    // 10-PRINT: a straight diagonal per cell. state 0 → main diagonal '\' (corners
    // (0,0)-(1,1)); state 1 → anti-diagonal '/'. Lines end at cell corners, which
    // are shared with neighbours, so uniform/mixed states weave into a labyrinth.
    const d = state === 0 ? Math.abs(fy - fx) : Math.abs(fy - (1 - fx))
    return d < tw ? out(A) : out(BG)
  }
  if (fam === 'arcs2') {
    // Double Truchet arcs: two concentric quarter-circles (radius 0.5 ± gap) per
    // corner pair. Same edge-midpoint endpoints as `arcs`, so it stays connected.
    const c0x = state === 0 ? 0 : 1, c1x = state === 0 ? 1 : 0
    const gap = 0.16
    const onArc = (cx0: number, cy0: number) => {
      const d = Math.hypot(fx - cx0, fy - cy0)
      return Math.abs(d - (0.5 - gap)) < tw * 0.5 || Math.abs(d - (0.5 + gap)) < tw * 0.5
    }
    return (onArc(c0x, 0) || onArc(c1x, 1)) ? out(A) : out(BG)
  }
  if (fam === 'arcdot') {
    // Truchet arcs with a dot at each cell centre — reads as a connected pipe network
    // studded with rivets. Arc coverage OR a centre disc of radius ~tw.
    const dot = Math.hypot(fx - 0.5, fy - 0.5) < tw * 1.4
    return (dot || arcCoverage(fx, fy, state, tw)) ? out(A) : out(BG)
  }
  if (fam === 'weave') {
    // Warp (vertical, A) and weft (horizontal, B) bands. Band width follows the
    // line-weight control (tw); the over/under at each crossing is the cell
    // parity XOR the per-cell state, so coherence/placement vary the weave
    // (uniform state = a clean basket weave; mixed = irregular). Bands span the
    // full cell so they connect across edges → seamless.
    const bw = 0.44 + tw
    const inV = Math.abs(fx - 0.5) < bw * 0.5
    const inH = Math.abs(fy - 0.5) < bw * 0.5
    const warpOnTop = (posmod(cx + cy, 2) === 0) !== (state === 1)
    if (inV && inH) return out(warpOnTop ? A : B)
    if (inV) return out(A)
    if (inH) return out(B)
    return out(BG)
  }
  // arcs (Smith): two quarter-circle arcs joining edge midpoints. state 0 joins
  // corners (0,0)&(1,1); state 1 joins (1,0)&(0,1). Either way all four edge
  // midpoints are arc endpoints, so neighbours always connect → seamless.
  return arcCoverage(fx, fy, state, tw) ? out(A) : out(BG)
}

export function patternColor(p: Params, u: number, v: number): RGBA {
  const cells = Math.max(2, Math.round(Number(p.cells) || 8))
  const A = hexToRgb(String(p.colorA))
  const B = hexToRgb(String(p.colorB))
  const BG = hexToRgb(String(p.background))
  // seed is injected by textureDefaults()/Roll, not part of TEXTURE_CONTROLS
  const seed = Math.round(Number(p.seed) || 1)

  // Chips has no lattice — it scatters its own wrapped cell grid at chipCells,
  // so it short-circuits before latticeCell(). Roles: 0 = chipA, 1 = chipB,
  // 2 = ground (grout), matching ROLES_BY_FAMILY.chips / legacyColor's A/B/BG.
  if (String(p.mode) === 'chips') {
    const chipCells = Math.max(2, Math.round(Number(p.chipCells) || 12))
    const grout = Number.isFinite(Number(p.chipGrout)) ? Number(p.chipGrout) : 0.05
    const sizeVar = Number.isFinite(Number(p.chipSizeVar)) ? Number(p.chipSizeVar) : 0.7
    // Unset on scenes saved before Density → 1, the fully-packed look they were authored in.
    const density = Number.isFinite(Number(p.chipDensity)) ? Number(p.chipDensity) : 1
    const s = chipSample(u, v, chipCells, seed, grout, sizeVar, density)
    if (s.role >= CHIP_INK_ROLES) return out(BG)
    return out(chipTone(s.role === 0 ? A : B, s.tone, Number(p.jitter) || 0))
  }

  // Dealt grid — a rigid, tileable grid of solid-filled cells. Like chips it owns
  // its own wrapped grid (dgCells), so it short-circuits before latticeCell().
  // Roles: 0 = inkA, 1 = inkB, ground = background — matching ROLES_BY_FAMILY.dealtgrid
  // / legacyColor's A/B/BG (v1 = solid cells only; no per-cell tone jitter).
  if (String(p.mode) === 'dealtgrid') {
    const dgCells = Math.max(2, Math.round(Number(p.dgCells) || 8))
    const density = Number.isFinite(Number(p.dgDensity)) ? Number(p.dgDensity) : 1
    const sizeVar = Number.isFinite(Number(p.dgSizeVar)) ? Number(p.dgSizeVar) : 0
    const s = dealtGridSample(u, v, dgCells, seed, density, sizeVar)
    if (s.role >= DEALT_INK_ROLES) return out(BG)
    return out(s.role === 0 ? A : B)
  }

  const { cx, cy, fx, fy } = latticeCell(String(p.lattice), cells, u, v)
  // One seamless per-cell hash (modded cx/cy) shared by truchet state + jitter swap.
  const cellHash = hash1(cx * 73856093 + cy * 19349663 + seed * 83492791)

  if (String(p.mode) === 'truchet') {
    const tw = Number(p.truchetWeight) || 0.18

    if (String(p.tileFamily) === 'multiscale') {
      const level = cachedLevels(cells, seed, clamp01(Number(p.subdivide) || 0))[cy * cells + cx]
      let lfx = fx, lfy = fy, sub = 0
      if (level >= 1) {
        const sx = Math.min(2, Math.floor(fx * 3)), sy = Math.min(2, Math.floor(fy * 3)) // clamp guards fx===1.0 at the UV seam (floor(3)=3 → index 2)
        lfx = fx * 3 - sx; lfy = fy * 3 - sy; sub = sx * 3 + sy + 1 // sub: 0 = whole cell, 1-9 = row-major 3×3 sub-cell index (+1), so each sub-cell hashes to its own arc orientation
      }
      const st = hash1(cx * 73856093 + cy * 19349663 + sub * 50331653 + seed * 83492791) < 0.5 ? 0 : 1
      return arcCoverage(lfx, lfy, st, tw) ? out(A) : out(BG)
    }

    let state: number
    if (String(p.placement) === 'structured') {
      const grid = cachedStates(cells, seed, clamp01(Number(p.coherence) || 0))
      state = grid[cy * cells + cx]
    } else {
      const rotBias = Number(p.rotBias)
      const bias = Number.isFinite(rotBias) ? rotBias : 0.5
      state = cellHash < bias ? 0 : 1
    }
    return truchetColor(String(p.tileFamily), fx, fy, cx, cy, state, tw, A, B, BG)
  }

  // Procedural motif path (only reached when mode !== 'truchet').
  const scale = Number(p.scale) || 0.7
  const lw = Number(p.lineWeight) || 0.12
  const jitter = Number(p.jitter) || 0
  const motif = String(p.motif)
  // Shared knobs for the appended figure motifs. `bands` = concentric-band /
  // wave-cycle count; `waveAmp` = wave line amplitude; `majorEvery` = graph-paper
  // heavy-line interval. Every figure below is a pure function of the cell-local
  // (fx,fy) plus modded (cx,cy), so it wraps at the tile edge by construction.
  const bands = Math.max(1, Math.round(Number(p.bands) || 6))
  const waveAmp = Number.isFinite(Number(p.waveAmp)) ? Number(p.waveAmp) : 0.3
  const rtri = (x: number) => Math.abs(2 * (x - Math.floor(x)) - 1)

  const swap = jitter > 0 && cellHash < jitter
  const ink: [number, number, number] = swap ? B : A
  const ink2: [number, number, number] = swap ? A : B

  switch (motif) {
    case 'rings': {
      // Concentric circles centred in each cell (Euclidean distance banding).
      const bi = Math.floor(Math.hypot(fx - 0.5, fy - 0.5) * 2 * bands)
      return out(posmod(bi, 2) === 0 ? A : BG)
    }
    case 'squares': {
      // Concentric squares (Chebyshev distance banding).
      const bi = Math.floor(Math.max(Math.abs(fx - 0.5), Math.abs(fy - 0.5)) * 2 * bands)
      return out(posmod(bi, 2) === 0 ? A : BG)
    }
    case 'diamonds': {
      // Concentric diamonds (Manhattan distance banding).
      const bi = Math.floor((Math.abs(fx - 0.5) + Math.abs(fy - 0.5)) * 2 * bands)
      return out(posmod(bi, 2) === 0 ? A : BG)
    }
    case 'waves': {
      // Sine wave line, `bands` humps per cell. Endpoints sit at fy=0.5 (sin=0 at the
      // integer-frequency cell edges), so lines join left↔right into continuous waves.
      const curve = 0.5 + waveAmp * Math.sin(fx * 2 * Math.PI * bands)
      return out(Math.abs(fy - curve) < lw ? A : BG)
    }
    case 'zigzag': {
      // Triangle-wave line (chevron rows). rtri peaks at the integer-frequency cell
      // edges, so adjacent cells connect at a shared peak.
      const curve = 0.5 + waveAmp * (2 * rtri(fx * bands) - 1)
      return out(Math.abs(fy - curve) < lw ? A : BG)
    }
    case 'cross': {
      // A plus sign centred in each cell; arms half-width = line weight.
      return out((Math.abs(fx - 0.5) < lw || Math.abs(fy - 0.5) < lw) ? A : BG)
    }
    case 'graph': {
      // Graph paper: thin minor rule on every cell's top/left edge (like `grid`),
      // heavier major rule every `majorEvery` cells. major → A, minor → B, ground → BG.
      const major = Math.max(2, Math.round(Number(p.majorEvery) || 4))
      const minorW = Math.min(0.45, lw)
      const majorW = Math.min(0.49, lw * 1.8)
      const onMajor = (posmod(cx, major) === 0 && fx < majorW) || (posmod(cy, major) === 0 && fy < majorW)
      const onMinor = fx < minorW || fy < minorW
      return out(onMajor ? A : onMinor ? B : BG)
    }
    case 'stripes':
      // `scale` sets the stripe split point (fraction of each cell that is ink).
      return out(fx < scale ? ink : ink2)
    case 'dots': {
      const d = Math.hypot(fx - 0.5, fy - 0.5)
      return d < scale * 0.5 ? out(ink) : out(BG)
    }
    case 'grid':
      // Stroke only the top/left edge of each cell; the neighbor supplies the
      // other two edges, so seams stay single-width. Seamless by construction.
      return (fx < lw || fy < lw) ? out(ink) : out(BG)
    case 'checker':
    default:
      return out(posmod(cx + cy, 2) === 0 ? ink : ink2)
  }
}
