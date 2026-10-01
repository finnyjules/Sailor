/**
 * Subject mask's work around SAM 3's answer (step 3, R7.5;
 * comfy_extras/nodes_subject_track.py:160-248), exact against Python given
 * the same candidate masks:
 *
 *   pick   best: the first mask SAM 3 answers (its own order, by score);
 *          largest / smallest: the most / fewest pixels > 0, the first on a
 *          tie (np.argmax / np.argmin); one mask is taken for every mode; no
 *          mask at all is an all-black mask (the call ran: charged, ruling (k))
 *   fit    a mask of another size than the picture: k / 255 with R0's
 *          bilinear (Python's cv2.resize of the low-res logits), then > 0
 *   mask   (m > 0) as 0 / 255
 *   grow   round(mask_grow) half to even (Python's round): > 0 cv2.dilate
 *          with a 3 × 3 square that many times, which is one clipped
 *          (2k + 1)-square maximum (MaxFilter, ./maxFilter.ts, on the Frame's
 *          worker); < 0 cv2.erode the same, the maximum of the inverted mask
 *          (cv2's border ignores what lies outside either way)
 *   cutout rgb / 255 · mask (3 channels): the picture where the mask is, 0
 *          elsewhere — its 8 bits are the picture's own or 0
 *
 * Python's output is a float32 [T, H, W] mask of exact 0s and 1s (kept as the
 * runner keeps masks: a 16-bit PNG, exact) and a [T, H, W, 3] cutout of exact
 * k / 255s (an 8-bit RGB PNG, exact). The steps here are linear passes; the
 * grow, the one costly step, runs on the Frame's worker.
 */
import { pixels as pixelOps } from './core'
import type { SamAnswerMask } from './samMask'

export type SubjectPick = 'best' | 'largest' | 'smallest'

/** Pixels > 0 of an answer mask. */
function countOn(m: SamAnswerMask): number {
  let n = 0
  for (let i = 0; i < m.l.length; i++) if (m.l[i]! > 0) n++
  return n
}

/** Which answer mask Python's mode keeps (null: none came back). */
export function subjectPickIndex(masks: readonly SamAnswerMask[], mode: SubjectPick): number | null {
  if (!masks.length) return null
  if (mode === 'best' || masks.length === 1) return 0
  let at = 0
  let best = countOn(masks[0]!)
  for (let i = 1; i < masks.length; i++) {
    const n = countOn(masks[i]!)
    if (mode === 'largest' ? n > best : n < best) { at = i; best = n }
  }
  return at
}

/** The kept mask at the picture's size, (m > 0) as 0 / 255. */
export function subjectMask8(masks: readonly SamAnswerMask[], mode: SubjectPick, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const i = subjectPickIndex(masks, mode)
  if (i === null) return out
  const m = masks[i]!
  if (m.l.length !== m.w * m.h) throw new Error('The mask is not the size it says')
  if (m.w === w && m.h === h) {
    for (let k = 0; k < out.length; k++) out[k] = m.l[k]! > 0 ? 255 : 0
    return out
  }
  const unit = new Float32Array(m.l.length)
  for (let k = 0; k < unit.length; k++) unit[k] = Math.fround(m.l[k]! / 255)
  const fitted = pixelOps.bilinear(unit, 1, m.h, m.w, h, w, false)
  for (let k = 0; k < out.length; k++) out[k] = fitted[k]! > 0 ? 255 : 0
  return out
}

/** Python's `int(round(mask_grow))` (half to even): the dilate's and the erode's iterations. */
export function subjectGrowSteps(grow: number): { dilate: number; erode: number } {
  const r = pixelOps.roundHalfEven(grow)
  return { dilate: Math.max(0, r), erode: Math.max(0, -r) }
}

/**
 * The grown or shrunk mask: `maxFilter(l, w, h, size)` is MaxFilter (the
 * worker's op, or ./maxFilter.ts in this thread).
 */
export async function subjectGrow(
  m8: Uint8Array, w: number, h: number, grow: number,
  maxFilter: (l: Uint8Array, w: number, h: number, size: number) => Promise<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  const { dilate, erode } = subjectGrowSteps(grow)
  if (dilate > 0) return maxFilter(m8.slice(), w, h, 2 * dilate + 1)
  if (erode > 0) {
    const inv = new Uint8Array(m8.length)
    for (let i = 0; i < inv.length; i++) inv[i] = 255 - m8[i]!
    const grown = await maxFilter(inv, w, h, 2 * erode + 1)
    const out = new Uint8Array(grown.length)
    for (let i = 0; i < out.length; i++) out[i] = 255 - grown[i]!
    return out
  }
  return m8
}

/** The mask as Python's float32 (exact 0s and 1s). */
export function subjectMaskFloat(m8: Uint8Array): Float32Array {
  const out = new Float32Array(m8.length)
  for (let i = 0; i < out.length; i++) out[i] = m8[i]! > 0 ? 1 : 0
  return out
}

/** The cutout's 8 bits (RGB): the picture where the mask is, 0 elsewhere (k / 255 · 1 gives k back, rounded or truncated). */
export function subjectCutout8(rgb: Uint8Array, m8: Uint8Array): Uint8Array {
  if (rgb.length !== m8.length * 3) throw new Error('The picture is not the size of its mask')
  const out = new Uint8Array(rgb.length)
  for (let i = 0; i < m8.length; i++) {
    if (!m8[i]) continue
    out[i * 3] = rgb[i * 3]!
    out[i * 3 + 1] = rgb[i * 3 + 1]!
    out[i * 3 + 2] = rgb[i * 3 + 2]!
  }
  return out
}
