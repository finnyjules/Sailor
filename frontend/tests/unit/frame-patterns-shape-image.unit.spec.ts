import { describe, it, expect } from 'vitest'
import { shapeCounter } from '~/lib/frame/patterns/patterns/shapeCounter'
import { photoBehind } from '~/lib/frame/patterns/patterns/photoBehind'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('shapeCounter', () => {
  it('puts the shape behind the title and overprints', () => {
    const { ops } = shapeCounter.place(ctxFor({ elements: inferElements([
      { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
      { id: 'sh', kind: 'shape', shapeId: 'circle' },
    ]) }))
    const shape = ops.find(o => o.kind === 'shape')!
    const title = ops.find(o => o.target === 'title')!
    expect(shape.shapeId).toBe('circle')
    expect(shape.colorRole).toBe('accent')
    expect((shape.z ?? 0)).toBeLessThan(title.z ?? 0)
    expect(title.blend).toBe('multiply')
    assertSaneOps(ops)
  })
  it('declares needs.shape', () => { expect(shapeCounter.needs?.shape).toBe(true) })
})

describe('photoBehind', () => {
  it('puts the image behind the title', () => {
    const { ops } = photoBehind.place(ctxFor())
    const img = ops.find(o => o.kind === 'image')!
    const title = ops.find(o => o.target === 'title')!
    expect(img.target).toBe('img')
    expect((img.z ?? 0)).toBeLessThan(title.z ?? 0)
    expect(img.w!).toBeGreaterThan(0)
    assertSaneOps(ops.filter(o => o.kind === 'text'))
  })
  it('emits a sentinel image op when there is no real image', () => {
    const { ops } = photoBehind.place(ctxFor({ elements: inferElements([
      { id: 't', kind: 'text', text: 'WORD', fontSize: 0.2 },
    ]) }))
    const img = ops.find(o => o.kind === 'image')!
    expect(img).toBeDefined()
    expect(img.target).toBe('image')
    expect(img.w!).toBeGreaterThan(0)
  })
  it('declares needs.image', () => { expect(photoBehind.needs?.image).toBe(true) })
})
