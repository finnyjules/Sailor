import { describe, it, expect } from 'vitest'
import { sidebar } from '~/lib/frame/patterns/patterns/sidebar'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const els = () => inferElements([
  { id: 't', kind: 'text', text: 'THE LONG NOW', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'talks and screenings', fontSize: 0.02 },
  { id: 'dt', kind: 'text', text: '12 October', fontSize: 0.02 },
])

describe('sidebar', () => {
  it('is deterministic and sane', () => {
    const a = sidebar.place(ctxFor({ elements: els() }))
    expect(a).toEqual(sidebar.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('keeps the title column and the details column disjoint in x', () => {
    const ops = sidebar.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const side = ops.filter(o => o.target !== 'title')
    expect(side.length).toBeGreaterThan(0)
    const titleRight = title.x + (title.w) / 2
    for (const s of side) { const sLeft = s.x - (s.w ?? 0) / 2; expect(sLeft).toBeGreaterThanOrEqual(titleRight - 1e-9) }
  })
})
