/**
 * What one layout render may ask for (R1.6 fix round 2), checked by the
 * translation (server/templates/translate.ts) for the route and the runner
 * alike, and by the runner's Smart Layout plan before anything runs:
 *   - each side 1 … 16384 pixels and at most 8192² pixels in all (resvg
 *     panics or runs out of memory past that, taking the process with it);
 *   - at most 20,000 characters of text across the layout's elements, their
 *     tokens filled in (the text fit's work grows with it, on the main thread);
 *   - at most 8 elements reading any one `{{ props.x }}` (each reads it whole).
 */
import { resolveTokens, type TokenScope } from './tokens'

export const LAYOUT_MAX_SIDE = 16384
export const LAYOUT_MAX_AREA = 8192 * 8192
export const LAYOUT_MAX_TEXT = 20_000
export const LAYOUT_MAX_READERS = 8

export const LAYOUT_TOO_SMALL = 'A format of this layout is smaller than 1 × 1 pixel, so it can’t be rendered'
export const LAYOUT_TOO_BIG = `A format of this layout is too large to render (each side at most ${LAYOUT_MAX_SIDE} pixels, and at most ${Math.floor(LAYOUT_MAX_AREA / 1_000_000)} million pixels in all)`
export const LAYOUT_TOO_MUCH_TEXT = `This layout has too much text to render (more than ${LAYOUT_MAX_TEXT.toLocaleString('en-US')} characters in all). Use shorter text.`
export const LAYOUT_TOO_MANY_READERS = `Too many elements of this layout show the same wired text (more than ${LAYOUT_MAX_READERS}).`

/** The refusal for a render size, or null when it is fine. */
export function renderSizeProblem(w: unknown, h: unknown): string | null {
  const W = Number(w)
  const H = Number(h)
  if (!(W >= 1) || !(H >= 1)) return LAYOUT_TOO_SMALL
  if (W > LAYOUT_MAX_SIDE || H > LAYOUT_MAX_SIDE || Math.ceil(W) * Math.ceil(H) > LAYOUT_MAX_AREA) return LAYOUT_TOO_BIG
  return null
}

const PROP_RE = /\{\{\s*props\.([\w.]+)\s*\}\}/g

/** Every element of a layout (top-level and section children) that is an object. */
function elementsOf(template: unknown): Record<string, unknown>[] {
  const t = template as { elements?: unknown; sections?: unknown }
  const out: unknown[] = Array.isArray(t?.elements) ? [...t.elements] : []
  if (Array.isArray(t?.sections)) {
    for (const s of t.sections) {
      const kids = (s as { children?: unknown })?.children
      if (Array.isArray(kids)) out.push(...kids)
    }
  }
  return out.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
}

/** An element's text: its content and each per-format override's. */
function contentsOf(e: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof e.content === 'string') out.push(e.content)
  const ov = e.overrides
  if (ov && typeof ov === 'object') {
    for (const o of Object.values(ov as Record<string, unknown>)) {
      const c = (o as { content?: unknown })?.content
      if (typeof c === 'string') out.push(c)
    }
  }
  return out
}

/** The refusal for a layout's text (too much in all, or one wired text read too often), or null. */
export function layoutTextProblem(template: unknown, props: TokenScope = {}, brand: TokenScope = {}): string | null {
  let total = 0
  const readers = new Map<string, number>()
  for (const e of elementsOf(template)) {
    const read = new Set<string>()
    for (const c of contentsOf(e)) {
      if (c.length > LAYOUT_MAX_TEXT) return LAYOUT_TOO_MUCH_TEXT
      const v = resolveTokens(c, props, brand)
      total += typeof v === 'string' ? v.length : String(v ?? '').length
      if (total > LAYOUT_MAX_TEXT) return LAYOUT_TOO_MUCH_TEXT
      for (const m of c.matchAll(PROP_RE)) read.add(m[1]!)
    }
    for (const k of read) {
      const n = (readers.get(k) ?? 0) + 1
      if (n > LAYOUT_MAX_READERS) return LAYOUT_TOO_MANY_READERS
      readers.set(k, n)
    }
  }
  return null
}
