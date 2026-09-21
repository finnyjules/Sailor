// Assemble: the layer stays ONE constant block size for the whole transition. A front travels
// across the frame (the same projection Wipe uses); cells pop in ahead of it, scattered in
// dither order, and settle into a look picture. A second, differently-offset scattered front
// follows and turns each cell into the real, sharp layer. `assembleCell`/`assembleTest` are the
// per-cell maths (0 nothing, 1 look, 2 sharp); `buildAssembleMasks` turns a frame's worth of
// that into the two RGBA bitmaps the painter blends; `assembleShaderParams`/`assembleGrid` drive
// whichever look shader (Dither or Characters) draws the block picture underneath. Pure: no
// Vue, no DOM, no shader compilation.
import type { MotionReveal } from './params'
import { alongTravel, travelAlong, bayer8, driftCells } from './dither'
import { PIXEL_JITTER } from './pixels'

/** The Dither look's Pattern options — the `bayer_dither` effect's 12, in manifest order.
 *  Pinned against `shader_effects/manifest.json` by `reveal-assemble.unit.spec.ts` so the two
 *  can never drift. */
export const DITHER_PATTERNS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Coarse 2×2' },
  { value: 1, label: 'Bayer 4×4' },
  { value: 2, label: 'Fine 8×8' },
  { value: 3, label: 'Clustered' },
  { value: 4, label: 'Scanline' },
  { value: 5, label: 'Diagonal' },
  { value: 6, label: 'White Noise' },
  { value: 7, label: 'Noise 2×' },
  { value: 8, label: 'Blue Noise' },
  { value: 9, label: 'Blue Noise 2×' },
  { value: 10, label: 'Blue Noise 0.5×' },
  { value: 11, label: 'R2 Noise' },
]

const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The width of the scattered band ahead of each front, in the same 0..1 travel units as
 *  `band`. Never 0 — a front needs SOME width to scatter cells across, and dividing by it is
 *  the whole maths below. */
export function assembleSoft(r: { scatter: number }): number {
  return Math.max(0.001, r.scatter * 0.6)
}

/** Assemble: is this cell nothing (0), the block look (1), or the sharp layer (2)? One-off
 *  form — `assembleTest` is the per-frame form with the cell-independent parts hoisted, exactly
 *  as `cellTest` is to `cellShown`. Sharp wins over look: the second front is checked first. */
export function assembleCell(r: MotionReveal, cx: number, cy: number, grid: { cols: number; rows: number }): 0 | 1 | 2 {
  if (!Number.isFinite(r.amount) || r.amount <= 0) return 0
  if (r.amount >= 1) return 2
  const soft = assembleSoft(r)
  const lead = r.amount * (1 + r.band + 2 * soft)
  const s = alongTravel(r.angle, r.out, cx, cy, grid)
  const { dx, dy } = driftCells(r)
  const tp = (lead - soft - r.band - s) / soft
  if (tp >= 1 || (tp > 0 && tp > bayer8(cx + 3 - dx, cy + 5 - dy))) return 2
  const lp = (lead - s) / soft
  if (lp >= 1 || (lp > 0 && lp > bayer8(cx - dx, cy - dy))) return 1
  return 0
}

/** Assemble: the per-frame test, with amount, softness, lead and drift resolved once — the
 *  same shape as `cellTest`. */
export function assembleTest(
  r: MotionReveal, grid: { cols: number; rows: number },
): (cx: number, cy: number) => 0 | 1 | 2 {
  if (!Number.isFinite(r.amount) || r.amount <= 0) return () => 0
  if (r.amount >= 1) return () => 2
  const soft = assembleSoft(r)
  const band = r.band
  const lead = r.amount * (1 + band + 2 * soft)
  const { dx, dy } = driftCells(r)
  const along = travelAlong(r.angle, r.out, grid)   // trig + extent once per frame, not per cell
  return (cx, cy) => {
    const s = along(cx, cy)
    const tp = (lead - soft - band - s) / soft
    if (tp >= 1 || (tp > 0 && tp > bayer8(cx + 3 - dx, cy + 5 - dy))) return 2
    const lp = (lead - s) / soft
    if (lp >= 1 || (lp > 0 && lp > bayer8(cx - dx, cy - dy))) return 1
    return 0
  }
}

/** Two RGBA bitmaps of `grid.cols × grid.rows`, alpha 255 where that cell shows the look / the
 *  sharp layer — row 0 is the TOP row. `covered[j * cols + i] === 0` drops a cell from the LOOK
 *  mask only: the Dither look paints opaque colour everywhere it samples, so a cell the layer
 *  itself does not cover must stay empty; the sharp side canvas already carries its own alpha,
 *  so the sharp mask needs no such filter. */
export function buildAssembleMasks(
  r: MotionReveal, grid: { cols: number; rows: number }, covered?: Uint8Array,
): { look: Uint8ClampedArray<ArrayBuffer>; sharp: Uint8ClampedArray<ArrayBuffer> } {
  const look = new Uint8ClampedArray(grid.cols * grid.rows * 4)
  const sharp = new Uint8ClampedArray(grid.cols * grid.rows * 4)
  const test = assembleTest(r, grid)
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const v = test(i, j)
      if (v === 0) continue
      const idx = j * grid.cols + i
      if (v === 1) {
        if (!covered || covered[idx] !== 0) look[idx * 4 + 3] = 255
      } else {
        sharp[idx * 4 + 3] = 255
      }
    }
  }
  return { look, sharp }
}

/** The block-look shader's own params for this frame. Dither (default) samples one colour per
 *  cell against a dither pattern; Characters runs the ASCII effect at full density, matte, with
 *  a CONSTANT cell — no halving ladder, that is Pixels' trick and not Assemble's. Both clamp
 *  the dial (a fraction of the frame's WIDTH) into the shader's own range (a fraction of the
 *  frame's HEIGHT), rescaled by the frame's aspect like `pixelShaderParams`. */
export function assembleShaderParams(
  r: MotionReveal, frameW: number, frameH: number,
): { effectId: 'bayer_dither' | 'ascii_dither'; params: Record<string, number>; matte: boolean } {
  const w = pos(frameW), h = pos(frameH)
  if (r.look === 'characters') {
    return {
      effectId: 'ascii_dither',
      params: {
        shape: r.chars,
        cell: clamp((r.cell * w) / h, 0.004, 0.1),
        brightness: 1,
        jitter: PIXEL_JITTER,
        speed: r.drift / 6,
        colored: 1,
        underlay: 0,
        spacing: 0,
        invert: 0,
        blur: 0,
      },
      matte: true,
    }
  }
  return {
    effectId: 'bayer_dither',
    params: { pattern: r.pattern, scale: clamp((r.cell * w) / h, 0.003, 0.05), levels: r.levels, colored: 1 },
    matte: false,
  }
}

/** The look shader's own cell grid in DEVICE pixels of the side canvas (`fw` × `fh`), mirroring
 *  its arithmetic exactly so a mask edge never cuts a cell it draws. `frameW`/`frameH` are the
 *  logical frame size `assembleShaderParams` scales `scale`/`cell` against — the aspect the
 *  dial's fraction is defined in, not the device pixels of the canvas it is drawn to. */
export function assembleGrid(
  r: MotionReveal, frameW: number, frameH: number, fw: number, fh: number,
): { cols: number; rows: number; cellW: number; cellH: number } {
  const shader = assembleShaderParams(r, frameW, frameH)
  const at = (key: string): number => shader.params[key] ?? 0
  let cellW: number, cellH: number
  if (shader.effectId === 'bayer_dither') {
    cellH = Math.max(at('scale') * fh, 1)
    cellW = cellH
  } else {
    cellH = Math.max(at('cell') * fh, 2)
    const shape = at('shape')
    cellW = cellH * (shape >= 7 && shape <= 14 ? 2 / 3 : 1)
  }
  return { cols: Math.ceil(fw / cellW), rows: Math.ceil(fh / cellH), cellW, cellH }
}

/** What the painter hands `renderFieldWithBase` beyond the effect's own params: the BUILD
 *  variant and its uniforms. Dither look → the SHIMMER build of bayer_dither, whose threshold
 *  pattern slides under the blocks by the same whole-cell drift that moves the scatter order,
 *  so the dithered tones shimmer while the sampled picture stays put (Julien: "I LOVE the
 *  colour shimmer"). The shader counts rows from the BOTTOM, hence `+dy`; `−dx` so the pattern
 *  travels the way `bayer8(cx − dx, …)` does here. Characters look → the ASCII MATTE build. */
export function assembleShaderExtras(r: MotionReveal): { variant: 'SHIMMER' | 'MATTE'; uniforms: Record<string, number> } {
  if (r.look === 'characters') return { variant: 'MATTE', uniforms: { u_matte: 1 } }
  const { dx, dy } = driftCells(r)
  return { variant: 'SHIMMER', uniforms: { u_shimmerX: -dx + 0, u_shimmerY: dy + 0 } }
}
