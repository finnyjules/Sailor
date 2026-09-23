import type { PosterLayerView, FrameElements, TextEl, ImageEl, ShapeEl } from './types'

const DATE_RE = /\b(\d{4})\b|\d{1,2}[./-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i

/** "Number-like": a price, a discount, a date or a time (the prototype's `isNumberish`). The one
 *  copy: `plan.ts` re-exports it so `needs.number` and every existing importer keep working.
 *  Lives here (not `plan.ts`) so `inferElements` can use it without a cycle. */
export const isNumberish = (s: string | undefined) =>
  !!s && (/[%€$£]/.test(s) || s.replace(/\D/g, '').length / Math.max(1, s.replace(/\s/g, '').length) >= 0.3)

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean)

/** Call-to-action verbs (ruling S3): the action line's first word (or first two, "sign up"). */
const ACTION_RE = /^(shop|buy|order|get|book|reserve|download|sign up|join|subscribe|learn|discover|see|try|start|register|apply|donate|watch|listen|call|visit|explore)\b/i
/** Ends with an arrow: "Book tickets →", "More ›". */
const ARROW_RE = /[→›]\s*$/

/** Ruling S3: an action line ("Shop now", "Book tickets →") is ≤ 4 words, not number-like, and
 *  opens with a call-to-action verb or ends with an arrow. (Not being the largest text is the
 *  caller's check.) */
export const isActionText = (s: string | undefined): boolean => {
  const t = (s ?? '').trim()
  if (!t || words(t).length > 4 || isNumberish(t)) return false
  return ACTION_RE.test(t) || ARROW_RE.test(t)
}

const asText = (l: PosterLayerView, role: TextEl['role']): TextEl =>
  ({ role, id: l.id, text: l.text ?? '', words: words(l.text ?? '') })

/** The action line first (ruling S3: the first text in document order that reads as a call to
 *  action and is not the largest text) — it leaves the texts before the rest is inferred, so it is
 *  never taken for the caption or the details. Then: largest text ⇒ title, smallest ⇒ caption, a
 *  date-shaped remaining line ⇒ date, the rest ⇒ details. Images/shapes collected in document
 *  order. A Frame with no action line infers exactly as in Stages 1–2. */
export function inferElements(
  layers: PosterLayerView[],
  shapeMode: FrameElements['shapeMode'] = null,
  imageMode: boolean = false,
): FrameElements {
  const allTexts = layers.filter(l => l.kind === 'text' && (l.text ?? '').trim().length > 0)
  const images: ImageEl[] = layers.filter(l => l.kind === 'image').map(l => ({ id: l.id }))
  const shapes: ShapeEl[] = layers
    .filter(l => l.kind === 'shape')
    .map(l => ({ id: l.id, shapeId: l.shapeId ?? 'circle' }))

  const base: FrameElements = { images, shapes, shapeMode, imageMode }
  if (!allTexts.length) return base

  // "Not the largest text": strictly smaller than the largest, so a lone line is never the action.
  const largest = Math.max(...allTexts.map(l => l.fontSize ?? 0))
  const actionLayer = allTexts.find(l => (l.fontSize ?? 0) < largest && isActionText(l.text))
  const texts = actionLayer ? allTexts.filter(l => l !== actionLayer) : allTexts

  const bySize = [...texts].sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))
  const title = bySize[0]!
  base.title = asText(title, 'title')
  if (actionLayer) base.action = asText(actionLayer, 'action')
  const rest = bySize.slice(1)
  if (!rest.length) return base

  const caption = rest[rest.length - 1]!
  base.caption = asText(caption, 'caption')
  const middle = rest.slice(0, -1)

  // Rule (Stage 2): the date/number role is the first middle text that is number-like — a
  // price, a discount, a date or a time — falling back to the Stage 1 DATE_RE match.
  // Trade-off: `isNumberish` doesn't know "date" from "any digit-heavy short line" — a bare
  // middle line like "Room 101" or "Gate 23" now reads as the number on a FRESH Frame (no
  // apply has run yet, so there's no stored role to defer to). A Frame laid out earlier keeps
  // whatever `sailor_posterState.roles` recorded (`withStoredRoles` in `kit/plan.ts` wins over
  // this inference), so only a Frame's first-ever layout can mis-read a room/gate number as
  // the date role.
  const dateLayer = middle.find(l => isNumberish(l.text)) ?? middle.find(l => DATE_RE.test(l.text ?? ''))
  if (dateLayer) base.date = asText(dateLayer, 'date')
  const details = middle.find(l => l !== dateLayer)
  if (details) base.details = asText(details, 'details')
  else if (!base.details && !dateLayer && middle.length === 0) { /* none */ }
  return base
}
