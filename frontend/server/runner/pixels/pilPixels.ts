/**
 * The per-pixel half of reading a picture as PIL's `Image.open(…).convert("RGBA")`
 * does (bytesio_to_image_tensor; ../pictures/pythonView.ts pilRgba decodes with
 * sharp and hands the raw samples here), and the channels Separate
 * background and foreground takes from it (step 3, R3.7 fix round 1): the
 * alpha (its mask) and the RGB (its fill picture).
 *
 *  - 'rgba': sharp's 8-bit sRGB with alpha, already PIL's: kept as it is;
 *  - 'cmyk': Pillow's naive cmyk2rgb (Convert.c): `nk − MULDIV255(c, nk)`, alpha 255;
 *  - 'grey16': PIL's I;16, each value clipped to 255, alpha 255.
 *
 * ONE self-contained function, as ./core.ts `pixelsCore` and ./maxFilter.ts
 * are: it refers to nothing outside itself but JavaScript built-ins, so the
 * Frame's worker runs it from its source text (compositor/worker.ts
 * `px.splitMask` and `px.rgbOf`, with their Stop checks) and pythonView.ts
 * calls the same code in this thread.
 */

/** Raw samples as sharp decodes them, before PIL's conversion to RGBA. */
export interface PilRaw {
  kind: 'rgba' | 'cmyk' | 'grey16'
  /** 'rgba' and 'cmyk': 4 bytes a pixel; 'grey16': one ushort a pixel. */
  data: Uint8Array | Uint16Array
  width: number
  height: number
}

export function pilPixelsCore() {
  /** PIL's MULDIV255 (Convert.c): a × b / 255, rounded as Pillow rounds it. */
  function mulDiv255(a: number, b: number): number {
    const t = a * b + 128
    return ((t >> 8) + t) >> 8
  }

  const ROWS = 256

  /** The picture as PIL's convert("RGBA") gives it: 8-bit RGBA, 4 bytes a pixel. */
  function toRgba(raw: PilRaw, isStopped?: () => boolean): Uint8Array {
    const n = raw.width * raw.height
    if (raw.kind === 'rgba') return raw.data as Uint8Array
    const out = new Uint8Array(n * 4)
    const data = raw.data
    for (let i = 0; i < n; i++) {
      if (i % (ROWS * raw.width || 1) === 0 && isStopped && isStopped()) throw new Error('Stopped')
      if (raw.kind === 'cmyk') {
        const nk = 255 - data[i * 4 + 3]!
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.min(255, Math.max(0, nk - mulDiv255(data[i * 4 + c]!, nk)))
      }
      else {
        const v = Math.min(255, data[i]!)
        out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v
      }
      out[i * 4 + 3] = 255
    }
    return out
  }

  /** Some channels of an RGBA picture, interleaved (alpha: [3]; RGB: [0, 1, 2]). */
  function channels(rgba: Uint8Array, n: number, pick: readonly number[], isStopped?: () => boolean): Uint8Array {
    const k = pick.length
    const out = new Uint8Array(n * k)
    for (let i = 0; i < n; i++) {
      if (i % 65536 === 0 && isStopped && isStopped()) throw new Error('Stopped')
      for (let j = 0; j < k; j++) out[i * k + j] = rgba[i * 4 + pick[j]!]!
    }
    return out
  }

  /** The alpha channel as Split's mask reads it: `round(clamp(a/255)·255)`, each 8-bit value back. */
  function alphaOf(raw: PilRaw, isStopped?: () => boolean): Uint8Array {
    return channels(toRgba(raw, isStopped), raw.width * raw.height, [3], isStopped)
  }

  /** `tensor[..., :3]` sent again as 8 bits (`round(clamp(v/255)·255)`, each value back): RGB, 3 bytes a pixel. */
  function rgbOf(raw: PilRaw, isStopped?: () => boolean): Uint8Array {
    return channels(toRgba(raw, isStopped), raw.width * raw.height, [0, 1, 2], isStopped)
  }

  return { toRgba, alphaOf, rgbOf }
}

/** The core in this thread (pythonView.ts pilRgba, tests). */
export const pilPixels = pilPixelsCore()
