import { describe, it, expect } from 'vitest'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import type { PosterLayerView } from '~/lib/frame/patterns/types'

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
})
