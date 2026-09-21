// The Pixels style TRANSFORMS the layer — it runs the Shader Studio `ascii_dither` effect over
// it — rather than masking it. This file is the maths that turns the bar's progress into that
// shader's dials. Pure: no Vue, no DOM, no shader compilation.
import type { MotionReveal } from './params'

/** The ASCII effect's `u_shape` options, in manifest order, minus Custom (value 14) — Custom
 *  needs a user-supplied glyph sheet a transition dial can't offer. Pinned against
 *  `shader_effects/manifest.json` by `reveal-pixels.unit.spec.ts` so the two can never drift. */
export const PIXEL_CHARS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Mixed' },
  { value: 1, label: 'Blocks' },
  { value: 2, label: 'Circles' },
  { value: 3, label: 'Lines' },
  { value: 4, label: 'Diagonal' },
  { value: 5, label: 'Cross' },
  { value: 6, label: 'Diamond' },
  { value: 7, label: 'Hash' },
  { value: 8, label: 'Matrix' },
  { value: 9, label: 'Binary' },
  { value: 10, label: 'Braille' },
  { value: 11, label: 'Morse' },
  { value: 12, label: 'Dots' },
  { value: 13, label: 'Slashes' },
  { value: 15, label: 'Lego' },
  { value: 16, label: 'Cross-stitch' },
  { value: 17, label: 'Voxel' },
  { value: 18, label: 'Beads' },
  { value: 19, label: 'Gems' },
]

/** Below this fraction of the frame's width the block is already as fine as the shader bothers
 *  with — the manifest's own `u_cell` floor is coarser (0.004) but this is the maths' own end. */
export const PIXEL_END = 0.002
export const PIXEL_JITTER = 0.25

/** The shader's own `u_cell` range (manifest `ascii_dither`), a fraction of the frame's
 *  HEIGHT. The ladder below is built in frame-WIDTH fractions, so the two only agree on a
 *  square frame — hence `pixelFinest` / the start cap in `pixelShaderParams`. */
const SHADER_CELL_MIN = 0.004
const SHADER_CELL_MAX = 0.1

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1)

/** The finest block the SHADER will actually draw, as a fraction of the frame's width: its
 *  `u_cell` floor is a fraction of the frame's HEIGHT, so on a portrait frame it is a much
 *  coarser width fraction than `PIXEL_END`. Building the ladder down to `PIXEL_END` anyway
 *  is what made the last three stages of a 1080×1920 bar the SAME cell size — 60 % of the
 *  bar with no refinement at all, which is the whole promise of the style. */
export function pixelFinest(frameW: number, frameH: number): number {
  return Math.max(PIXEL_END, (SHADER_CELL_MIN * pos(frameH)) / pos(frameW))
}

/** How many times the dial's block halves before it reaches the finest block (`PIXEL_END`
 *  unless the caller knows the frame, in which case `pixelFinest`). */
export function pixelStages(cell: number, finest: number = PIXEL_END): number {
  return cell > finest ? Math.max(0, Math.ceil(Math.log2(cell / finest) - 1e-9)) : 0
}

/** The block at `amount` (fraction of the frame's width): the dial's size halved once per
 *  stage, the stages spread evenly over the bar, so each refinement subdivides the last. */
export function pixelBlock(amount: number, cell: number, finest: number = PIXEL_END): number {
  const stages = pixelStages(cell, finest)
  return cell / 2 ** Math.min(stages, Math.floor(clamp01(amount) * (stages + 1)))
}

/** The shader's Brightness across the bar. In matte mode the shader's tone runs 0.25–0.75 and
 *  its jitter ±0.125, so −0.9 draws nothing at all and +0.9 fills every covered cell. The ramp
 *  spends the FIRST HALF of the bar getting from one to the other — so the coarsest blocks
 *  (stage one, the first fifth) are already visible and growing, bright tones first — and
 *  the second half holds full density while the blocks refine: a mosaic resolving to the
 *  picture. (Found live: a −1 → +1 ramp over the whole bar left stage one invisible and had
 *  the element solid by mid-bar, so only two of the five stages were ever seen.) */
export function pixelBrightness(amount: number): number { return Math.min(1, -0.9 + clamp01(amount) * 3.6) }

/** How much of the real, sharp layer is laid over the characters: most sets never become a
 *  solid picture, so the last fifth of the bar cross-fades to the layer itself. */
export function pixelSharp(amount: number): number {
  const x = clamp01((clamp01(amount) - 0.8) / 0.2)
  return x * x * (3 - 2 * x)
}

/** The ASCII effect's params, keyed WITHOUT the `u_` prefix (the `ShaderSpec.params`
 *  convention). `cell` is a fraction of the frame's HEIGHT in the shader, so the dial's
 *  frame-WIDTH fraction is rescaled by `frameW / frameH`; a non-positive frame size (not yet
 *  measured) falls back to 1 rather than dividing by zero.
 *
 *  The ladder is built BETWEEN the shader's own two limits, not clamped into them after the
 *  fact: the first block is the dial or the coarsest cell the shader draws, whichever is
 *  smaller, and the last is `pixelFinest`. Clamping a ladder built in the wrong units is what
 *  collapsed several stages into one cell on a portrait frame (and made the coarse end of the
 *  dial flat on a wide one). */
export function pixelShaderParams(r: MotionReveal, frameW: number, frameH: number): Record<string, number> {
  const w = pos(frameW)
  const h = pos(frameH)
  const start = Math.min(r.cell, (SHADER_CELL_MAX * h) / w)
  const block = pixelBlock(r.amount, start, pixelFinest(w, h))
  const cell = Math.min(SHADER_CELL_MAX, Math.max(SHADER_CELL_MIN, (block * w) / h))
  return {
    shape: r.chars,
    cell,
    brightness: pixelBrightness(r.amount),
    jitter: PIXEL_JITTER,
    speed: r.drift / 6,
    colored: 1,
    underlay: 0,
    spacing: 0,
    invert: 0,
    blur: 0,
  }
}
