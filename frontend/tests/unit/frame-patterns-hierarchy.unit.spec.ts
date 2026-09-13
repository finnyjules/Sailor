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
})
