/**
 * `F.interpolate(t, size=(dh, dw), mode='bilinear', align_corners=False)` in
 * float32, bit for bit as torch's CPU kernel (step 3, R1.4; R2 reuses it).
 * The arithmetic is ./core.ts `bilinear` (which of torch's three sums, by
 * channels, memory format and output size); proven against
 * scripts/runner_values_fixtures.py `bilinear`. Five or more channels are refused.
 *
 * Pictures here are channels last, as ComfyUI holds them: (H, W, C)
 * interleaved. `memory` is the tensor's memory format when torch resizes it:
 * 'contiguous' (a mask's unsqueeze, a .contiguous() tensor; the default) or
 * 'channels-last' (a ComfyUI picture movedim'd to (B, C, H, W) without a copy).
 * It changes the result for 4 channels only.
 */
import { pixels } from './core'

export const MAX_BILINEAR_CHANNELS = 4

export function bilinearResize(
  src: Float32Array, sw: number, sh: number, channels: number, dw: number, dh: number,
  memory: 'contiguous' | 'channels-last' = 'contiguous',
): Float32Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_BILINEAR_CHANNELS) throw new Error(`A picture of ${channels} channels can’t be resized here`)
  if (src.length !== sw * sh * channels) throw new Error('The picture to resize is the wrong size')
  const inN = sw * sh
  const plane = channels === 1 ? src : new Float32Array(src.length)
  if (channels > 1) {
    for (let i = 0; i < inN; i++) for (let c = 0; c < channels; c++) plane[c * inN + i] = src[i * channels + c]!
  }
  const out = pixels.bilinear(plane, channels, sh, sw, dh, dw, memory === 'channels-last')
  if (channels === 1) return out
  const outN = dw * dh
  const hwc = new Float32Array(out.length)
  for (let i = 0; i < outN; i++) for (let c = 0; c < channels; c++) hwc[i * channels + c] = out[c * outN + i]!
  return hwc
}
