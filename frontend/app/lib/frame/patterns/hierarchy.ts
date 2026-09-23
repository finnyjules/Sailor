import type { PosterLayerView, FrameElements, TextEl, ImageEl, ShapeEl } from './types'

const DATE_RE = /\b(\d{4})\b|\d{1,2}[./-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i

/** "Number-like": a price, a discount, a date or a time (the prototype's `isNumberish`). The one
 *  copy: `plan.ts` re-exports it so `needs.number` and every existing importer keep working.
 *  Lives here (not `plan.ts`) so `inferElements` can use it without a cycle. */
export const isNumberish = (s: string | undefined) =>
  !!s && (/[%€$£]/.test(s) || s.replace(/\D/g, '').length / Math.max(1, s.replace(/\s/g, '').length) >= 0.3)

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean)
const asText = (l: PosterLayerView, role: TextEl['role']): TextEl =>
  ({ role, id: l.id, text: l.text ?? '', words: words(l.text ?? '') })

/** Largest text ⇒ title, smallest ⇒ caption, a date-shaped remaining line ⇒
 *  date, the rest ⇒ details. Images/shapes collected in document order. */
export function inferElements(
  layers: PosterLayerView[],
  shapeMode: FrameElements['shapeMode'] = null,
  imageMode: boolean = false,
): FrameElements {
  const texts = layers.filter(l => l.kind === 'text' && (l.text ?? '').trim().length > 0)
  const images: ImageEl[] = layers.filter(l => l.kind === 'image').map(l => ({ id: l.id }))
  const shapes: ShapeEl[] = layers
    .filter(l => l.kind === 'shape')
    .map(l => ({ id: l.id, shapeId: l.shapeId ?? 'circle' }))

  const base: FrameElements = { images, shapes, shapeMode, imageMode }
  if (!texts.length) return base

  const bySize = [...texts].sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))
  const title = bySize[0]!
  base.title = asText(title, 'title')
  const rest = bySize.slice(1)
  if (!rest.length) return base

  const caption = rest[rest.length - 1]!
  base.caption = asText(caption, 'caption')
  const middle = rest.slice(0, -1)

  // Rule (Stage 2): the date/number role is the first middle text that is number-like — a
  // price, a discount, a date or a time — falling back to the Stage 1 DATE_RE match.
  const dateLayer = middle.find(l => isNumberish(l.text)) ?? middle.find(l => DATE_RE.test(l.text ?? ''))
  if (dateLayer) base.date = asText(dateLayer, 'date')
  const details = middle.find(l => l !== dateLayer)
  if (details) base.details = asText(details, 'details')
  else if (!base.details && !dateLayer && middle.length === 0) { /* none */ }
  return base
}
