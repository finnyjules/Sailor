import { describe, expect, it } from 'vitest'
import { applyMorphBehaviours, compileBehaviourForLayer } from '~/lib/motionx/adapter/frame'
import type { StoredBehaviour, Track } from '~/lib/motionx'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const layer = (id: string) => ({ id, kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1, fill: '#ff0000' }) as unknown as LocalLayer
const A = layer('a'), B = layer('b'), C = layer('c')
const bar = (id: string, layerId: string, start: number, target?: string): StoredBehaviour =>
  ({ id, layerId, kind: 'morph', timing: { start, duration: 1 }, params: { style: 'letters', ...(target ? { target } : {}) } })
// Tracks are tagged with their bar's id by `setBehaviourTracks` in the app; tag them here.
const tracksFor = (bs: StoredBehaviour[], ls: LocalLayer[]): Track[] =>
  bs.flatMap(b => compileBehaviourForLayer(ls.find(l => l.id === b.layerId)!, b).map(t => ({ ...t, behaviourId: b.id })))
const get = (ls: LocalLayer[], id: string) => ls.find(l => l.id === id) as unknown as Record<string, unknown>

describe('applyMorphBehaviours', () => {
  const bs = [bar('m', 'a', 1, 'l:b')]
  const tr = tracksFor(bs, [A, B])

  it('before the bar: A as is, B hidden', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 0.5)
    expect(get(out, 'a').motionMorph).toBeUndefined()
    expect(get(out, 'a').motionHidden).toBeUndefined()
    expect(get(out, 'b').motionHidden).toBe(true)
  })
  it('during the bar: A carries the morph, B hidden', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 1.5)
    const mm = get(out, 'a').motionMorph as { target: string; style: string; amount: number }
    expect(mm.target).toBe('l:b')
    expect(mm.style).toBe('letters')
    expect(mm.amount).toBeGreaterThan(0)
    expect(mm.amount).toBeLessThan(1)
    expect(get(out, 'b').motionHidden).toBe(true)
  })
  it('after the bar: A hidden, B showing', () => {
    const out = applyMorphBehaviours([A, B], tr, bs, 3)
    expect(get(out, 'a').motionHidden).toBe(true)
    expect(get(out, 'b').motionHidden).toBeUndefined()
    expect(out.find(l => l.id === 'b')).toBe(B)
  })
  it('a chain A → B → C shows B between the two bars', () => {
    const chain = [bar('m1', 'a', 1, 'l:b'), bar('m2', 'b', 4, 'l:c')]
    const out = applyMorphBehaviours([A, B, C], tracksFor(chain, [A, B, C]), chain, 3)
    expect(get(out, 'b').motionHidden).toBeUndefined()
    expect(get(out, 'c').motionHidden).toBe(true)
  })
  it('no target or a dangling one: nothing happens at any time', () => {
    for (const b of [bar('x', 'a', 1), bar('y', 'a', 1, 'l:gone')]) {
      for (const t of [0.5, 1.5, 3]) {
        const ls = [A, B]
        expect(applyMorphBehaviours(ls, tracksFor([b], ls), [b], t)).toBe(ls)
      }
    }
  })
  it('idle identity with no morph bars', () => {
    const ls = [A, B]
    expect(applyMorphBehaviours(ls, [], [], 1)).toBe(ls)
  })
})
