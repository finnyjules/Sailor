/**
 * Tone, colour and light effects (family `effects-tone`, step 3 R2): per-pixel
 * work with no neighbourhood. R2.1 brings the three pilots; R2.4 the rest.
 *
 * SELF-CONTAINED apart from its argument (the tensor core), as
 * ../../pixels/core.ts is: the compositor worker composes it from its source
 * text. Do not reference anything from outside this body but `k`.
 *
 * Each op takes the node's tensors by input name, its widgets as ComfyUI's
 * validation converted them (float(), int(), bool(), str()), and a Stop
 * check; it returns its outputs and the tensor its live preview shows.
 * FLOAT32, OP BY OP as torch: every product, sum and difference rounded,
 * a Python double scalar rounded to float32 once where it meets a tensor.
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'

export function toneCore(k: TensorCore) {
  const f = Math.fround

  /**
   * AdjustExposure (comfy_extras/nodes_adjust_exposure.py:39-43): clamp when
   * exposure is 0, else (image · f32(2.0 ** exposure)).clamp(0, 1). Exact.
   */
  function AdjustExposure(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const e = p.exposure as number
    const out = k.tensor(x.c, x.h, x.w)
    const m = k.s32(2 ** e)
    const n = x.w * x.h
    for (let c = 0; c < x.c; c++) {
      const s = x.data.subarray(c * n, (c + 1) * n)
      const d = out.data.subarray(c * n, (c + 1) * n)
      k.rows(x.h, stop, (y) => {
        for (let i = y * x.w, end = i + x.w; i < end; i++) d[i] = k.clamp01(e === 0 ? s[i]! : f(s[i]! * m))
      })
    }
    return { outputs: [out], preview: null }
  }

  /**
   * AdjustInvert (nodes_color_filters.py:277-281):
   * (image · (1 − a) + (1 − image) · a).clamp(0, 1), op by op; 1 − a in
   * Python's double, then rounded to float32 as a scalar. Exact.
   */
  function AdjustInvert(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const a = p.amount as number
    const keep = k.s32(1 - a)
    const flip = k.s32(a)
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    for (let c = 0; c < x.c; c++) {
      const s = x.data.subarray(c * n, (c + 1) * n)
      const d = out.data.subarray(c * n, (c + 1) * n)
      k.rows(x.h, stop, (y) => {
        for (let i = y * x.w, end = i + x.w; i < end; i++) {
          const v = s[i]!
          d[i] = k.clamp01(f(f(v * keep) + f(f(1 - v) * flip)))
        }
      })
    }
    return { outputs: [out], preview: null }
  }

  /**
   * AdjustThreshold (nodes_color_filters.py:326-330): luma > threshold (the
   * threshold rounded to float32, as torch compares a tensor with a Python
   * scalar), as 0 or 1 on EVERY channel of the tensor (alpha too). Exact.
   */
  function AdjustThreshold(inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean): EffectResult {
    const x = inp.image!
    const t = k.s32(p.threshold as number)
    const luma = k.luma709(x, stop)
    const out = k.tensor(x.c, x.h, x.w)
    const n = x.w * x.h
    k.rows(x.h, stop, (y) => {
      for (let i = y * x.w, end = i + x.w; i < end; i++) {
        const v = luma[i]! > t ? 1 : 0
        for (let c = 0; c < x.c; c++) out.data[c * n + i] = v
      }
    })
    return { outputs: [out], preview: null }
  }

  return { AdjustExposure, AdjustInvert, AdjustThreshold }
}

export type ToneCore = ReturnType<typeof toneCore>
