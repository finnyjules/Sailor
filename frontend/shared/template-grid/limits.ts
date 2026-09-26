/**
 * What one layout render may ask for (R1.6 fix round 2), checked by the
 * translation (server/templates/translate.ts) for the route and the runner
 * alike, and by the runner's Smart Layout plan before anything runs:
 *   - each side 1 … 16384 pixels and at most 8192² pixels in all (resvg
 *     panics or runs out of memory past that, taking the process with it);
 *   - at most 20,000 characters of text across the layout's elements, their
 *     tokens filled in (the text fit's work grows with it, on the main thread);
 *   - at most 8 elements reading any one `{{ props.x }}` (each reads it whole);
 *   - (round 3) at most 256 elements (top-level and section children): the
 *     translation's cost grows faster than the count, on the main thread;
 *   - (round 3) pictures: at most 100 MB fetched in all per render, at most
 *     4 different pictures with a photo treatment (duotone, grain), each at
 *     most 4096 × 4096 pixels (the bake's time and memory grow with it).
 */
import { resolveTokens, type TokenScope } from './tokens'

export const LAYOUT_MAX_SIDE = 16384
export const LAYOUT_MAX_AREA = 8192 * 8192
export const LAYOUT_MAX_TEXT = 20_000
export const LAYOUT_MAX_READERS = 8
export const LAYOUT_MAX_ELEMENTS = 256
export const LAYOUT_MAX_IMAGE_BYTES = 100 * 1024 * 1024
export const LAYOUT_MAX_TREATED = 4
export const LAYOUT_MAX_TREATED_AREA = 4096 * 4096

export const LAYOUT_TOO_SMALL = 'A format of this layout is smaller than 1 × 1 pixel, so it can’t be rendered'
export const LAYOUT_TOO_BIG = `A format of this layout is too large to render (each side at most ${LAYOUT_MAX_SIDE} pixels, and at most ${Math.floor(LAYOUT_MAX_AREA / 1_000_000)} million pixels in all)`
export const LAYOUT_TOO_MUCH_TEXT = `This layout has too much text to render (more than ${LAYOUT_MAX_TEXT.toLocaleString('en-US')} characters in all). Use shorter text.`
export const LAYOUT_TOO_MANY_READERS = `Too many elements of this layout show the same wired text (more than ${LAYOUT_MAX_READERS}).`
export const LAYOUT_TOO_MANY_ELEMENTS = `This layout has too many elements to render (more than ${LAYOUT_MAX_ELEMENTS}).`
export const LAYOUT_IMAGES_TOO_LARGE = `The pictures in this layout are too large to render together (more than ${LAYOUT_MAX_IMAGE_BYTES / (1024 * 1024)} MB in all). Use fewer or smaller pictures.`
export const LAYOUT_TOO_MANY_TREATED = `This layout has more than ${LAYOUT_MAX_TREATED} different pictures with a photo treatment (duotone or grain).`
export const LAYOUT_TREATED_TOO_LARGE = 'A picture with a photo treatment (duotone or grain) is too large: at most 4096 × 4096 pixels. Use a smaller picture or no treatment.'
export const LAYOUT_TREATMENT_FAILED = 'A photo treatment (duotone or grain) could not be applied to a picture in this layout'

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

/** How many elements a layout has, top-level and in sections. */
export function layoutElementCount(template: unknown): number {
  return elementsOf(template).length
}

/** The refusal for a layout's element count, or null. */
export function layoutElementsProblem(template: unknown): string | null {
  return layoutElementCount(template) > LAYOUT_MAX_ELEMENTS ? LAYOUT_TOO_MANY_ELEMENTS : null
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
