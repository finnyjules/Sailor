import { describe, it, expect, beforeEach } from 'vitest'
import { useNextStepsStrip, type FixChip } from '~/composables/useNextStepsStrip'

const chip = (id: number): FixChip => ({ id, label: `Fix ${id}`, hint: null, apply: () => {} })

describe('fixes per node', () => {
  beforeEach(() => useNextStepsStrip().clearFixes())

  it('keeps fixes for several nodes at once', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1), chip(2)])
    s.announceFixes('b', [chip(3)])
    expect(s.fixesFor('a')).toHaveLength(2)
    expect(s.fixesFor('b')).toHaveLength(1)
  })
  it('clears one node without touching the others', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)]); s.announceFixes('b', [chip(2)])
    s.clearFixes('a')
    expect(s.fixesFor('a')).toEqual([])
    expect(s.fixesFor('b')).toHaveLength(1)
  })
  it('a fresh take clears that node’s fixes', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)])
    s.announceFreshTake('a')
    expect(s.fixesFor('a')).toEqual([])
  })
  it('clearFixes() with no id clears everything', () => {
    const s = useNextStepsStrip()
    s.announceFixes('a', [chip(1)]); s.announceFixes('b', [chip(2)])
    s.clearFixes()
    expect(Object.keys(s.fixesByNode.value)).toEqual([])
  })
})
