import type { PosterLayerView, FrameElements, TextEl, ImageEl, ShapeEl } from './types'

const DATE_RE = /\b(\d{4})\b|\d{1,2}[./-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i

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

  const dateLayer = middle.find(l => DATE_RE.test(l.text ?? ''))
  if (dateLayer) base.date = asText(dateLayer, 'date')
  const details = middle.find(l => l !== dateLayer)
  if (details) base.details = asText(details, 'details')
  else if (!base.details && !dateLayer && middle.length === 0) { /* none */ }
  return base
}
