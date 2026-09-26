/** Type scale resolution and estimate-based copy fitting. The estimate uses
 * an average glyph width (CHAR_W × fontSize) — deterministic and identical in
 * the editor and the renderer, which matters more than per-glyph accuracy.
 * Satori re-wraps at render time; fitting only decides size and truncation. */

import { CLASS_DEFAULTS, FONT_FLOOR, classifyFormat, metricScale } from './grid'
import type { TemplateV2, TextLevel, TextOverflow } from './types'

export const LEVELS: TextLevel[] = ['caption', 'body', 'subhead', 'headline', 'display']
export const CHAR_W = 0.55

/** Per-character advance widths in em — the per-glyph upgrade of CHAR_W for
 * word PLACEMENT (expressive text). Values are the MAX advance measured across
 * every curated family (Inter, Space Grotesk, Playfair Display, Bebas Neue,
 * Anton) × weights 400/700, rounded up: an estimate may run a little wide
 * (word sits slightly inside its anchor) but must never run narrow — a
 * narrow estimate lets an edge-anchored word's real glyphs escape the element
 * box, where overflow:hidden clips them mid-letter. Deterministic and shared
 * so the editor DOM and the Satori export keep placing words identically.
 * Uploaded brand fonts aren't in the max, so an unusually wide display font
 * can still clip — acceptable; the curated set is the common path. */
const CHAR_WIDTHS_EM: Record<string, number> = {
  'a': 0.581, 'b': 0.644, 'c': 0.598, 'd': 0.644, 'e': 0.596, 'f': 0.442,
  'g': 0.642, 'h': 0.623, 'i': 0.315, 'j': 0.297, 'k': 0.585, 'l': 0.344,
  'm': 0.913, 'n': 0.623, 'o': 0.618, 'p': 0.644, 'q': 0.644, 'r': 0.467,
  's': 0.561, 't': 0.46, 'u': 0.623, 'v': 0.6, 'w': 0.851, 'x': 0.593,
  'y': 0.616, 'z': 0.573,
  'A': 0.747, 'B': 0.672, 'C': 0.74, 'D': 0.776, 'E': 0.634, 'F': 0.592,
  'G': 0.751, 'H': 0.8, 'I': 0.376, 'J': 0.61, 'K': 0.72, 'L': 0.611,
  'M': 0.932, 'N': 0.763, 'O': 0.794, 'P': 0.648, 'Q': 0.794, 'R': 0.692,
  'S': 0.655, 'T': 0.669, 'U': 0.745, 'V': 0.747, 'W': 1.038, 'X': 0.739,
  'Y': 0.731, 'Z': 0.665,
  '0': 0.675, '1': 0.452, '2': 0.63, '3': 0.646, '4': 0.677, '5': 0.623,
  '6': 0.65, '7': 0.582, '8': 0.651, '9': 0.65,
  '.': 0.334, ',': 0.334, ':': 0.334, ';': 0.343, '!': 0.338, '?': 0.58,
  "'": 0.339, '"': 0.552, '-': 0.499, '–': 0.607, '—': 1, '&': 0.899,
  '@': 1.026, '#': 0.649, '%': 1.057, '(': 0.398, ')': 0.39, '/': 0.406,
  '+': 0.679, '*': 0.56, '=': 0.679, '_': 0.62, '$': 0.655, '€': 0.685,
  '£': 0.66,
}

/** Width a word may render at, in em. Per-glyph table lookup; accented
 * characters fall back to their base letter (NFD), anything else to a
 * generous 0.72em (CJK/emoji and other wide scripts to 1em). */
export function estimateWordEm(word: string): number {
  let em = 0
  for (const ch of word) {
    let w = CHAR_WIDTHS_EM[ch]
    if (w == null) {
      const base = ch.normalize('NFD')[0]
      w = (base != null ? CHAR_WIDTHS_EM[base] : undefined)
        ?? ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 1 : 0.72)
    }
    em += w
  }
  return em
}

/** Level-derived size for a format. `basePxOverride` (master px, from
 * style.fontSize) replaces the modular-scale base but keeps the per-format
 * scaling, so manual sizes still reflow across formats. */
export function typeSize(
  level: TextLevel, template: TemplateV2, formatKey: string,
  basePxOverride?: number,
): number {
  const f = template.formats[formatKey]
  if (!f) throw new Error(`Unknown format '${formatKey}' on template '${template.id}'`)
  const base = basePxOverride ?? (template.typeScale.base * template.typeScale.ratio ** LEVELS.indexOf(level))
  const raw = base
    * metricScale(template, f)
    * CLASS_DEFAULTS[classifyFormat(f)].typeMultiplier
  return Math.max(FONT_FLOOR, Math.round(raw))
}

export function wrapLines(text: string, fontSize: number, width: number): string[] {
  const cpl = Math.max(1, Math.floor(width / (fontSize * CHAR_W)))
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > cpl) {
      if (cur) { lines.push(cur); cur = '' }
      lines.push(w.slice(0, cpl))
      w = w.slice(cpl)
    }
    if (!w) continue
    const cand = cur ? `${cur} ${w}` : w
    if (cand.length <= cpl) cur = cand
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

export interface FitResult {
  fontSize: number
  content: string     // possibly truncated (overflow: shrink-then-truncate)
  lines: string[]     // wrap estimate; rendering re-wraps
  clipped: boolean    // floor size still overflows and policy allows clipping
}

export function fitText(opts: {
  content: string
  maxFontSize: number
  w: number
  h: number
  lineHeight: number
  overflow: TextOverflow
  maxLines?: number
  /** Auto-shrink the size down to fit the region (default true). When false —
   *  the user set an explicit fontSize — the size is honoured exactly and the
   *  overflow policy handles the doesn't-fit case (truncate / clip). */
  autoShrink?: boolean
}): FitResult {
  const { content, lineHeight } = opts
  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY
  const autoShrink = opts.autoShrink !== false
  const tryFit = (fs: number): string[] | null => {
    const lines = wrapLines(content, fs, opts.w)
    const ok = lines.length <= maxLines && lines.length * fs * lineHeight <= opts.h
    return ok ? lines : null
  }

  // Truncate `content` to the lines that fit `h` at `fs`, with an ellipsis.
  const truncateAt = (fs: number): FitResult => {
    const full = wrapLines(content, fs, opts.w)
    const byHeight = Math.floor(opts.h / (fs * lineHeight))
    const keep = Math.max(1, Math.min(Number.isFinite(maxLines) ? maxLines : byHeight, byHeight))
    const kept = full.slice(0, keep)
    const last = kept[kept.length - 1] ?? ''
    kept[kept.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`
    return { fontSize: fs, content: kept.join(' '), lines: kept, clipped: false }
  }

  const startFs = Math.max(FONT_FLOOR, Math.round(opts.maxFontSize))

  // Explicit size: keep it; only handle overflow.
  if (!autoShrink) {
    const lines = tryFit(startFs)
    if (lines) return { fontSize: startFs, content, lines, clipped: false }
    if (opts.overflow === 'shrink-then-truncate') return truncateAt(startFs)
    // 'shrink' (now "keep size, clip") or 'grow' with rows exhausted → clip.
    return { fontSize: startFs, content, lines: wrapLines(content, startFs, opts.w), clipped: true }
  }

  // Auto (level-derived) size: shrink toward the floor until it fits. A size
  // that isn't a finite number never reaches the floor: bounded (R1.6 fix 1).
  let fs = startFs
  for (let step = 0; step < 512 && Number.isFinite(fs); step++) {
    const lines = tryFit(fs)
    if (lines) return { fontSize: fs, content, lines, clipped: false }
    if (fs === FONT_FLOOR) break
    fs = Math.max(FONT_FLOOR, Math.floor(fs * 0.9))
  }

  if (opts.overflow !== 'shrink-then-truncate') {
    // 'shrink' clips; 'grow' only reaches here when the grid ran out of rows.
    return { fontSize: FONT_FLOOR, content, lines: wrapLines(content, FONT_FLOOR, opts.w), clipped: true }
  }
  return truncateAt(FONT_FLOOR)
}
