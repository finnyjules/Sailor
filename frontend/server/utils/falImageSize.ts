/**
 * fal `image_size` from an aspect-ratio string. The named presets cover the common
 * ratios; anything else becomes an explicit box with the long side at `longSide`
 * (both sides multiples of 16, which every FLUX-family endpoint wants).
 *
 * Seedream 4.5 needs ≥1920 on both sides or ≥2560×1440 px in total — pass
 * `longSide = 3200` there. Everything else is happy at 1024 (~1 MP).
 */
export type FalImageSize =
  | 'square_hd' | 'square' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9'
  | { width: number; height: number }

const PRESET: Record<string, Exclude<FalImageSize, object>> = {
  '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9',
}

export function falImageSize(aspect: string | undefined, longSide = 1024): FalImageSize {
  const raw = (aspect ?? '1:1').trim()
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw)
  const w0 = m ? Number(m[1]) : 0, h0 = m ? Number(m[2]) : 0
  const valid = w0 > 0 && h0 > 0
  const ar = valid ? raw : '1:1'            // anything unparseable is square
  if (longSide === 1024 && PRESET[ar]) return PRESET[ar]
  const ratio = valid ? w0 / h0 : 1
  const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16)
  return ratio >= 1
    ? { width: r16(longSide), height: r16(longSide / ratio) }
    : { width: r16(longSide * ratio), height: r16(longSide) }
}
