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

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** How many times the dial's block halves before it reaches the finest block. */
export function pixelStages(cell: number): number {
  return cell > PIXEL_END ? Math.max(0, Math.ceil(Math.log2(cell / PIXEL_END) - 1e-9)) : 0
}

/** The block at `amount` (fraction of the frame's width): the dial's size halved once per
 *  stage, the stages spread evenly over the bar, so each refinement subdivides the last. */
export function pixelBlock(amount: number, cell: number): number {
  const stages = pixelStages(cell)
  return cell / 2 ** Math.min(stages, Math.floor(clamp01(amount) * (stages + 1)))
}

/** The shader's Brightness across the bar: −1 (nothing drawn) → +1 (every covered cell full).
 *  Bright tones cross zero first, so they arrive first. */
export function pixelBrightness(amount: number): number { return clamp01(amount) * 2 - 1 }

/** How much of the real, sharp layer is laid over the characters: most sets never become a
 *  solid picture, so the last fifth of the bar cross-fades to the layer itself. */
export function pixelSharp(amount: number): number {
  const x = clamp01((clamp01(amount) - 0.8) / 0.2)
  return x * x * (3 - 2 * x)
}

/** The ASCII effect's params, keyed WITHOUT the `u_` prefix (the `ShaderSpec.params`
 *  convention). `cell` is a fraction of the frame's HEIGHT in the shader, so the dial's
 *  frame-WIDTH fraction is rescaled by `frameW / frameH`; a non-positive frame height (not yet
 *  measured) falls back to 1 rather than dividing by zero. */
export function pixelShaderParams(r: MotionReveal, frameW: number, frameH: number): Record<string, number> {
  const h = frameH > 0 ? frameH : 1
  const cell = Math.min(0.1, Math.max(0.004, (pixelBlock(r.amount, r.cell) * frameW) / h))
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
