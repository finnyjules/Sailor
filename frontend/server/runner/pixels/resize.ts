/**
 * `F.interpolate(t, size=(dh, dw), mode='bilinear', align_corners=False)` in
 * float32, bit for bit as torch's CPU kernel (step 3, R1.4; R2 reuses it).
 *
 * The arithmetic is the Frame's (compositor/plane.ts `resizeBilinear`, measured
 * against torch 2.10): source index fma(scale, d + 0.5, −0.5) clamped at 0;
 * the four corner weights a·b rounded; then for 1–3 channels a fused chain,
 * and for 4 torch's channels-last order of unfused adds. Proven against
 * scripts/runner_values_fixtures.py `bilinear` (1 and 4 channels). Five or
 * more channels follow neither order in torch, and are refused.
 *
 * Pictures here are channels last, as ComfyUI holds them: (H, W, C) interleaved.
 */
import { core } from '../compositor/plane'

export const MAX_BILINEAR_CHANNELS = 4

export function bilinearResize(src: Float32Array, sw: number, sh: number, channels: number, dw: number, dh: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_BILINEAR_CHANNELS) throw new Error(`A picture of ${channels} channels can’t be resized here`)
  if (src.length !== sw * sh * channels) throw new Error('The picture to resize is the wrong size')
  const inN = sw * sh
  const plane = channels === 1 ? src : new Float32Array(src.length)
  if (channels > 1) {
    for (let i = 0; i < inN; i++) for (let c = 0; c < channels; c++) plane[c * inN + i] = src[i * channels + c]!
  }
  const out = core.resizeBilinear({ c: channels, h: sh, w: sw, data: plane }, dh, dw).data
  if (channels === 1) return out
  const outN = dw * dh
  const hwc = new Float32Array(out.length)
  for (let i = 0; i < outN; i++) for (let c = 0; c < channels; c++) hwc[i * channels + c] = out[c * outN + i]!
  return hwc
}
