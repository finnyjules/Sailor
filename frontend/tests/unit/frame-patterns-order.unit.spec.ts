import { describe, it, expect } from 'vitest'
import { reconcileOrder, orderWithZ, nextOrderFor } from '~/lib/frame/patterns/order'
import type { LayerOp, FrameElements } from '~/lib/frame/patterns/types'

describe('reconcileOrder', () => {
  it('keeps saved order for present keys and appends newcomers on top', () => {
    expect(reconcileOrder(['l:a', 'l:gone', 'l:b'], ['l:b', 'l:a', 'l:new'])).toEqual(['l:a', 'l:b', 'l:new'])
  })
  it('an empty saved order is just the present keys', () => {
    expect(reconcileOrder([], ['l:x', 'l:y'])).toEqual(['l:x', 'l:y'])
  })
})

describe('orderWithZ', () => {
  it('sorts touched keys by z within their own slots; untouched keys stay put', () => {
    // photo (l:p) is above title (l:t); untouched l:u sits between them
    const order = ['l:t', 'l:u', 'l:p']
    const z = new Map([['l:t', 1], ['l:p', 0]])      // title z1 over photo z0
    expect(orderWithZ(order, z)).toEqual(['l:p', 'l:u', 'l:t'])   // photo now first, title last, l:u unmoved
  })
  it('ties keep current relative order', () => {
    const order = ['l:a', 'l:b', 'l:c']
    const z = new Map([['l:a', 0], ['l:b', 0], ['l:c', 0]])
    expect(orderWithZ(order, z)).toEqual(['l:a', 'l:b', 'l:c'])
  })
})

describe('nextOrderFor', () => {
  const elements = { title: { role: 'title', id: 't', text: 'X', words: ['X'] }, images: [{ id: 'img' }], shapes: [], shapeMode: null } as unknown as FrameElements
  it('puts a z:0 image behind a z:1 title even when the photo was saved on top', () => {
    const ops: LayerOp[] = [
      { target: 'title', kind: 'text', x: .5, y: .3, fontSize: .2, z: 1 },
      { target: 'img', kind: 'image', x: .5, y: .7, w: 1, h: .5, z: 0 },
    ]
    const next = nextOrderFor(['l:t', 'l:img'], ['l:t', 'l:img'], ops, elements, new Map())
    expect(next).toEqual(['l:img', 'l:t'])
  })
  it('an inserted layer for a sentinel shape op takes its z via the op index', () => {
    const ops: LayerOp[] = [
      { target: 'shape', kind: 'shape', x: .5, y: .5, w: .6, shapeId: 'circle', z: 0 },
      { target: 'title', kind: 'text', x: .5, y: .5, fontSize: .2, z: 1 },
    ]
    const next = nextOrderFor(['l:t'], ['l:t', 'l:new'], ops, elements, new Map([[0, 'new']]))
    expect(next).toEqual(['l:new', 'l:t'])                       // shape behind the title
  })
})
