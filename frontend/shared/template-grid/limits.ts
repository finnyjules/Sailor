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
 *   - (round 4) pictures as shown: each distinct picture's bytes times the
 *     elements showing it, at most 100 MB in all; at most 16 fonts that have
 *     to be downloaded; and a layout the translation can't read (not an
 *     object, its formats, elements or sections not what it expects) is
 *     refused plainly rather than failing as a server error.
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
export const LAYOUT_MAX_REMOTE_FONTS = 16

export const LAYOUT_TOO_SMALL = 'A format of this layout is smaller than 1 × 1 pixel, so it can’t be rendered'
export const LAYOUT_TOO_BIG = `A format of this layout is too large to render (each side at most ${LAYOUT_MAX_SIDE} pixels, and at most ${Math.floor(LAYOUT_MAX_AREA / 1_000_000)} million pixels in all)`
export const LAYOUT_TOO_MUCH_TEXT = `This layout has too much text to render (more than ${LAYOUT_MAX_TEXT.toLocaleString('en-US')} characters in all). Use shorter text.`
export const LAYOUT_TOO_MANY_READERS = `Too many elements of this layout show the same wired text (more than ${LAYOUT_MAX_READERS}).`
export const LAYOUT_TOO_MANY_ELEMENTS = `This layout has too many elements to render (more than ${LAYOUT_MAX_ELEMENTS}).`
export const LAYOUT_IMAGES_TOO_LARGE = `The pictures in this layout are too large to render together (more than ${LAYOUT_MAX_IMAGE_BYTES / (1024 * 1024)} MB in all). Use fewer or smaller pictures.`
export const LAYOUT_TOO_MANY_TREATED = `This layout has more than ${LAYOUT_MAX_TREATED} different pictures with a photo treatment (duotone or grain).`
export const LAYOUT_TREATED_TOO_LARGE = 'A picture with a photo treatment (duotone or grain) is too large: at most 4096 × 4096 pixels. Use a smaller picture or no treatment.'
export const LAYOUT_TOO_MANY_FONTS = `This layout uses more than ${LAYOUT_MAX_REMOTE_FONTS} fonts that have to be downloaded. Use fewer fonts.`
export const LAYOUT_BAD_SHAPE = 'This layout is not in a shape the renderer can read'
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isObjectList = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(isObject)

/** The first way an element is not what the translation reads, or null. */
function elementShapeProblem(e: Record<string, unknown>, grid: boolean): string | null {
  for (const k of ['style', 'overrides', 'regionByClass'] as const) {
    if (e[k] !== undefined && e[k] !== null && !isObject(e[k])) return `an element's ${k === 'regionByClass' ? 'class regions' : k} are not a set of values`
  }
  if (isObject(e.overrides) && !Object.values(e.overrides).every(o => o === null || o === undefined || isObject(o))) return 'an element\'s overrides are not sets of values'
  if (grid && e.region !== undefined && !isObject(e.region)) return 'an element\'s region is not a set of values'
  if (!grid && e.size !== undefined && !isObject(e.size)) return 'an element\'s size is not a set of values'
  if (!grid && e.offset !== undefined && !isObject(e.offset)) return 'an element\'s offset is not a set of values'
  return null
}

/**
 * The refusal for a layout the translation can't read (fix round 4), or
 * null: the template is an object; a grid layout (version 2 or 3) has its
 * formats as a set of formats, its elements as a list of objects, and
 * (version 3) its sections as a list of objects each with a list of
 * children; a version 1 layout has its aspects as a set and its elements as
 * a list of objects. What an element or section holds is checked where it
 * is a set of values; anything deeper the translation can't read (a missing
 * region, say) is caught as a TypeError by the render and refused the same way.
 */
export function layoutShapeProblem(template: unknown): string | null {
  const bad = (why: string) => `${LAYOUT_BAD_SHAPE}: ${why}.`
  if (!isObject(template)) return bad('it is not a layout object')
  const t = template
  const grid = t.version === 2 || t.version === 3
  if (grid) {
    if (!isObject(t.formats) || !Object.keys(t.formats).length) return bad('it has no formats')
    if (!Object.values(t.formats).every(isObject)) return bad('a format is not a set of values')
    if (t.grid !== undefined && !isObject(t.grid)) return bad('its grid is not a set of values')
    if (t.typeScale !== undefined && !isObject(t.typeScale)) return bad('its type scale is not a set of values')
  }
  else {
    if (!isObject(t.aspects)) return bad('it has no aspects')
    if (!Object.values(t.aspects).every(isObject)) return bad('an aspect is not a set of values')
  }
  if (!isObjectList(t.elements)) return bad('its elements are not a list of elements')
  for (const e of t.elements) {
    const why = elementShapeProblem(e, grid)
    if (why) return bad(why)
  }
  if (t.version === 3 || (t.sections !== undefined && t.sections !== null)) {
    if (!isObjectList(t.sections)) return bad('its sections are not a list of sections')
    for (const s of t.sections) {
      if (s.region !== undefined && !isObject(s.region)) return bad('a section\'s region is not a set of values')
      if (!isObjectList(s.children)) return bad('a section\'s children are not a list of elements')
      for (const e of s.children) {
        const why = elementShapeProblem(e, grid)
        if (why) return bad(why)
      }
    }
  }
  if (t.background !== undefined && t.background !== null && !isObject(t.background)) return bad('its background is not a set of values')
  return null
}
