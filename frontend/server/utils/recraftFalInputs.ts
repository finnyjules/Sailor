/**
 * Pure payload builders for the two Recraft vector routes now that they run
 * on fal instead of Replicate. No h3 imports — safe to unit test directly.
 *
 * fal-ai/recraft/v3/text-to-image wants `style` from its own enum (the
 * `vector_illustration` family, optionally a sub-style like
 * `vector_illustration/line_art`) and an `image_size` — either a named
 * preset or an explicit `{ width, height }`.
 *
 * The route's `style` body param still carries Replicate's recraft-v3-svg
 * vocabulary ('any' | 'engraving' | 'line_art' | 'line_circuit' | 'linocut'),
 * so it's translated through an explicit map rather than passed straight
 * through. A caller that already sends an `vector_illustration[/sub]` string
 * (the fal-native form) passes through unchanged.
 */
import { falImageSize, type FalImageSize } from './falImageSize'

// Replicate's recraft-v3-svg style names → fal's vector_illustration family.
// 'line_circuit' has no direct fal sub-style, so it falls back to the bare
// family (same as 'any').
const STYLE_MAP: Record<string, string> = {
  any: 'vector_illustration',
  engraving: 'vector_illustration/engraving',
  line_art: 'vector_illustration/line_art',
  linocut: 'vector_illustration/linocut',
}

function mapStyle(style: string | undefined): string {
  const raw = (style || '').trim()
  if (!raw) return 'vector_illustration'
  if (raw === 'vector_illustration' || raw.startsWith('vector_illustration/')) return raw
  return STYLE_MAP[raw] ?? 'vector_illustration'
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// The route's `size` body param is a pixel `WxH` string (default
// '1024x1024'), not an aspect ratio — reduce it to a ratio and hand it to
// falImageSize with the long side set to the requested pixel size, so a
// recognized ratio at the default 1024 long side becomes a named preset
// (e.g. 1024x1024 -> 'square_hd') and everything else becomes an explicit
// 16-aligned box at the size actually requested.
function sizeToImageSize(size: string | undefined): FalImageSize {
  const raw = (size || '1024x1024').trim()
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(raw)
  if (!m) return falImageSize('1:1', 1024)
  const w = Number(m[1]), h = Number(m[2])
  if (!w || !h) return falImageSize('1:1', 1024)
  const g = gcd(w, h) || 1
  const ratio = `${w / g}:${h / g}`
  const longSide = Math.max(w, h)
  return falImageSize(ratio, longSide)
}

export function recraftGenerateInput(prompt: string, style: string | undefined, size: string | undefined) {
  return {
    prompt,
    style: mapStyle(style),
    image_size: sizeToImageSize(size),
  }
}

export function recraftVectorizeInput(image: string) {
  return { image_url: image }
}
