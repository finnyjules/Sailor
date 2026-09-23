import { describe, it, expect } from 'vitest'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import type { PosterLayerView, FrameElements, TextEl, ImageEl, ShapeEl } from '~/lib/frame/patterns/types'

describe('inferElements', () => {
  it('assigns title/details/caption by size and finds a date', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'Talks on sound', fontSize: 0.03 },
      { id: 'dt', kind: 'text', text: '12–14 October 2026', fontSize: 0.03 },
      { id: 'c', kind: 'text', text: 'free entry', fontSize: 0.018 },
      { id: 'img', kind: 'image' },
      { id: 'sh', kind: 'shape', shapeId: 'circle' },
    ]
    const e = inferElements(layers)
    expect(e.title?.id).toBe('t')
    expect(e.title?.words).toEqual(['NOISE'])
    expect(e.caption?.id).toBe('c')
    expect(e.date?.id).toBe('dt')          // the "…2026" line is date-shaped
    expect(e.details?.id).toBe('d')        // remaining non-date, non-caption text
    expect(e.images.map(i => i.id)).toEqual(['img'])
    expect(e.shapes[0]).toEqual({ id: 'sh', shapeId: 'circle' })
  })
  it('a lone title yields only a title', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'SILENCE', fontSize: 0.2 }])
    expect(e.title?.id).toBe('t')
    expect(e.details).toBeUndefined()
    expect(e.caption).toBeUndefined()
    expect(e.date).toBeUndefined()
  })
  it('carries shapeMode through', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'X', fontSize: 0.2 }], { family: 'suns' })
    expect(e.shapeMode).toEqual({ family: 'suns' })
  })
  it('sets imageMode to false by default', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'X', fontSize: 0.2 }])
    expect(e.imageMode).toBe(false)
  })
  it('carries imageMode through when set to true', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'X', fontSize: 0.2 }], null, true)
    expect(e.imageMode).toBe(true)
  })

  it('a discount percentage is the date, ahead of a plain sentence', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Summer sale', fontSize: 0.2 },
      { id: 'pct', kind: 'text', text: '–30%', fontSize: 0.05 },
      { id: 'd', kind: 'text', text: 'Only this week', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Terms apply', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.date?.id).toBe('pct')
    expect(e.details?.id).toBe('d')
  })

  it('a price is the date', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Big title', fontSize: 0.2 },
      { id: 'price', kind: 'text', text: '€29', fontSize: 0.05 },
      { id: 'd', kind: 'text', text: 'Free delivery', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Small print', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.date?.id).toBe('price')
  })

  it('a time reads as number-like and wins the date role', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Title', fontSize: 0.2 },
      { id: 'time', kind: 'text', text: 'Doors 19:30', fontSize: 0.05 },
      { id: 'n', kind: 'text', text: 'Ines Vollmer', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Kunstraum Lenz, 4056 Basel', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.date?.id).toBe('time')
  })

  it('the Stage 1 fixture (a digit-heavy date range) still resolves as the date', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Exhibition', fontSize: 0.2 },
      { id: 'dt', kind: 'text', text: '19.09.–15.11.2026', fontSize: 0.05 },
      { id: 'd', kind: 'text', text: 'Group show', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Free entry', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.date?.id).toBe('dt')
  })

  it('falls back to the Stage 1 DATE_RE match when nothing is number-like (a month name, no digits)', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Exhibition', fontSize: 0.2 },
      { id: 'dt', kind: 'text', text: 'Save the date: December', fontSize: 0.05 },
      { id: 'd', kind: 'text', text: 'Group show', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Free entry', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.date?.id).toBe('dt')
  })

  // ═══════════ Stage 3: the action line (ruling S3) ═══════════
  it('reads the action line before the rest: "Shop now" is the action, the other four as before', () => {
    const layers: PosterLayerView[] = [
      { id: 't', kind: 'text', text: 'Run lighter.', fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'Halden Trail 2', fontSize: 0.05 },
      { id: 'pct', kind: 'text', text: '–30%', fontSize: 0.05 },
      { id: 'a', kind: 'text', text: 'Shop now', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Offer ends 12 October.', fontSize: 0.018 },
    ]
    const e = inferElements(layers)
    expect(e.title?.id).toBe('t')
    expect(e.details?.id).toBe('d')
    expect(e.date?.id).toBe('pct')
    expect(e.caption?.id).toBe('c')
    expect(e.action).toEqual({ role: 'action', id: 'a', text: 'Shop now', words: ['Shop', 'now'] })
  })

  it('an action line set smallest is the action, not the caption', () => {
    const e = inferElements([
      { id: 't', kind: 'text', text: 'Run lighter.', fontSize: 0.2 },
      { id: 'd', kind: 'text', text: 'Halden Trail 2', fontSize: 0.05 },
      { id: 'c', kind: 'text', text: 'Offer ends 12 October.', fontSize: 0.03 },
      { id: 'a', kind: 'text', text: 'Shop now', fontSize: 0.012 },
    ])
    expect(e.action?.id).toBe('a')
    expect(e.caption?.id).toBe('c')
    expect(e.details?.id).toBe('d')
  })

  it('"Book tickets →" and "Tickets ›" are actions (a verb, or an arrow at the end)', () => {
    for (const text of ['Book tickets →', 'Tickets ›', 'Sign up today', 'DOWNLOAD THE APP']) {
      const e = inferElements([
        { id: 't', kind: 'text', text: 'Noise', fontSize: 0.2 },
        { id: 'a', kind: 'text', text, fontSize: 0.03 },
        { id: 'c', kind: 'text', text: 'Free entry', fontSize: 0.018 },
      ])
      expect(e.action?.id, text).toBe('a')
      expect(e.caption?.id, text).toBe('c')
    }
  })

  it('not an action: more than four words, number-like, the largest text, or no verb/arrow', () => {
    const cases: [string, number][] = [
      ['Learn more about our process today', 0.03],   // six words
      ['Get 30% off', 0.03],                          // number-like
      ['Shopping bag', 0.03],                         // "shop" is not the whole first word
      ['Free entry', 0.03],                           // no verb, no arrow
      ['Shop now', 0.2],                              // as large as the title: never the action
    ]
    for (const [text, fontSize] of cases) {
      const e = inferElements([
        { id: 't', kind: 'text', text: 'Noise', fontSize: 0.2 },
        { id: 'x', kind: 'text', text, fontSize },
        { id: 'c', kind: 'text', text: 'Small print', fontSize: 0.018 },
      ])
      expect(e.action, text).toBeUndefined()
    }
  })

  it('a lone action-like line is the title, never the action', () => {
    const e = inferElements([{ id: 't', kind: 'text', text: 'Shop now', fontSize: 0.2 }])
    expect(e.title?.id).toBe('t')
    expect(e.action).toBeUndefined()
  })

  it('a Frame without an action line infers exactly as in Stages 1–2 (every fixture above, deep-equal)', () => {
    const fixtures: PosterLayerView[][] = [
      [
        { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
        { id: 'd', kind: 'text', text: 'Talks on sound', fontSize: 0.03 },
        { id: 'dt', kind: 'text', text: '12–14 October 2026', fontSize: 0.03 },
        { id: 'c', kind: 'text', text: 'free entry', fontSize: 0.018 },
        { id: 'img', kind: 'image' },
        { id: 'sh', kind: 'shape', shapeId: 'circle' },
      ],
      [{ id: 't', kind: 'text', text: 'SILENCE', fontSize: 0.2 }],
      [
        { id: 't', kind: 'text', text: 'Summer sale', fontSize: 0.2 },
        { id: 'pct', kind: 'text', text: '–30%', fontSize: 0.05 },
        { id: 'd', kind: 'text', text: 'Only this week', fontSize: 0.05 },
        { id: 'c', kind: 'text', text: 'Terms apply', fontSize: 0.018 },
      ],
      [
        { id: 't', kind: 'text', text: 'Big title', fontSize: 0.2 },
        { id: 'price', kind: 'text', text: '€29', fontSize: 0.05 },
        { id: 'd', kind: 'text', text: 'Free delivery', fontSize: 0.05 },
        { id: 'c', kind: 'text', text: 'Small print', fontSize: 0.018 },
      ],
      [
        { id: 't', kind: 'text', text: 'Title', fontSize: 0.2 },
        { id: 'time', kind: 'text', text: 'Doors 19:30', fontSize: 0.05 },
        { id: 'n', kind: 'text', text: 'Ines Vollmer', fontSize: 0.05 },
        { id: 'c', kind: 'text', text: 'Kunstraum Lenz, 4056 Basel', fontSize: 0.018 },
      ],
      [
        { id: 't', kind: 'text', text: 'Exhibition', fontSize: 0.2 },
        { id: 'dt', kind: 'text', text: '19.09.–15.11.2026', fontSize: 0.05 },
        { id: 'd', kind: 'text', text: 'Group show', fontSize: 0.05 },
        { id: 'c', kind: 'text', text: 'Free entry', fontSize: 0.018 },
      ],
      [
        { id: 't', kind: 'text', text: 'Exhibition', fontSize: 0.2 },
        { id: 'dt', kind: 'text', text: 'Save the date: December', fontSize: 0.05 },
        { id: 'd', kind: 'text', text: 'Group show', fontSize: 0.05 },
        { id: 'c', kind: 'text', text: 'Free entry', fontSize: 0.018 },
      ],
      [
        { id: 't', kind: 'text', text: 'Weather Report', fontSize: 0.12 },
        { id: 'd', kind: 'text', text: 'Ines Vollmer', fontSize: 0.04 },
        { id: 'dt', kind: 'text', text: '19.09.–15.11.2026', fontSize: 0.03 },
        { id: 'c', kind: 'text', text: 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel', fontSize: 0.02 },
      ],
    ]
    for (const f of fixtures) for (const sm of [null, { family: 'suns' }] as const) for (const im of [false, true]) {
      const got = inferElements(f, sm, im)
      expect(got.action).toBeUndefined()
      expect(got).toEqual(stage2InferElements(f, sm, im))
    }
  })
})

// The Stage 2 inference verbatim (hierarchy.ts at 5f6ab549c), the reference a Frame without an
// action line must still match.
function stage2InferElements(layers: PosterLayerView[], shapeMode: FrameElements['shapeMode'] = null, imageMode = false): FrameElements {
  const DATE_RE = /\b(\d{4})\b|\d{1,2}[./-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i
  const isNumberish = (s: string | undefined) =>
    !!s && (/[%€$£]/.test(s) || s.replace(/\D/g, '').length / Math.max(1, s.replace(/\s/g, '').length) >= 0.3)
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean)
  const asText = (l: PosterLayerView, role: TextEl['role']): TextEl => ({ role, id: l.id, text: l.text ?? '', words: words(l.text ?? '') })
  const texts = layers.filter(l => l.kind === 'text' && (l.text ?? '').trim().length > 0)
  const images: ImageEl[] = layers.filter(l => l.kind === 'image').map(l => ({ id: l.id }))
  const shapes: ShapeEl[] = layers.filter(l => l.kind === 'shape').map(l => ({ id: l.id, shapeId: l.shapeId ?? 'circle' }))
  const base: FrameElements = { images, shapes, shapeMode, imageMode }
  if (!texts.length) return base
  const bySize = [...texts].sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))
  base.title = asText(bySize[0]!, 'title')
  const rest = bySize.slice(1)
  if (!rest.length) return base
  base.caption = asText(rest[rest.length - 1]!, 'caption')
  const middle = rest.slice(0, -1)
  const dateLayer = middle.find(l => isNumberish(l.text)) ?? middle.find(l => DATE_RE.test(l.text ?? ''))
  if (dateLayer) base.date = asText(dateLayer, 'date')
  const details = middle.find(l => l !== dateLayer)
  if (details) base.details = asText(details, 'details')
  return base
}
