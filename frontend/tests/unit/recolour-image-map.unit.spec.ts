import { describe, it, expect } from 'vitest'
import { gradientMapStopsFor, applyImageMaps, removeImageMaps } from '~/lib/compositor/recolour/imageMap'
import { effectStackOf, createEffect } from '~/lib/compositor/effectStack'
import { DEFAULT_TORN_EDGE } from '~/lib/compositor/tornEdge'
import { lightnessOf } from '~/lib/compositor/recolour/map'

const img = (id: string, extra: any = {}) => ({ id, kind: 'image', filename: 'x.png', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1, ...extra })
const wired = (id: string) => ({ id, kind: 'wired', slot: 1, x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 })
const rect = (id: string) => ({ id, kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#ff0000', stroke: '', strokeWidth: 0 })
const fam = ['#f5f5f5', '#0b132b', '#5bc0be', '#3a506b']

describe('gradientMapStopsFor', () => {
  it('sorts the family dark → light at even positions, deduped', () => {
    const stops = gradientMapStopsFor([...fam, '#0B132B'])
    expect(stops.map(s => s.pos)).toEqual([0, 1 / 3, 2 / 3, 1])
    for (let i = 1; i < stops.length; i++) expect(lightnessOf(stops[i]!.color)).toBeGreaterThanOrEqual(lightnessOf(stops[i - 1]!.color))
    expect(stops[0]!.color).toBe('#0b132b'); expect(stops[3]!.color).toBe('#f5f5f5')
  })
  it('a single colour is one stop at 0.5', () => { expect(gradientMapStopsFor(['#123456'])).toEqual([{ pos: 0.5, color: '#123456' }]) })
})

describe('applyImageMaps', () => {
  it('adds an owned gradient map to every image and wired layer, not to shapes, and returns new layers', () => {
    const layers: any[] = [img('i'), wired('w'), rect('r')]
    const out = applyImageMaps(layers as any, fam, {})
    expect(Object.keys(out.owned).sort()).toEqual(['i', 'w'])
    for (const id of ['i', 'w']) {
      const l = out.layers.find(x => x.id === id) as any
      const fx = effectStackOf(l).find(e => e.id === out.owned[id]) as any
      expect(fx?.type).toBe('gradientMap'); expect(fx.mix).toBe(1); expect(fx.visible).toBe(true)
      expect(fx.stops.map((s: any) => s.color)).toEqual(gradientMapStopsFor(fam).map(s => s.color))
    }
    expect((out.layers[2] as any).effects).toBeUndefined()
    expect((layers[0] as any).effects).toBeUndefined()                        // input untouched
  })
  it('updates the owned map in place on re-apply (same id, same position) and leaves a user map alone', () => {
    const userMap = { ...createEffect('gradientMap'), stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }
    const drop = createEffect('drop_shadow')
    const layers: any[] = [img('i', { effects: [userMap, drop] })]
    const first = applyImageMaps(layers as any, fam, {})
    const stackA = effectStackOf(first.layers[0] as any)
    // canonical position: after the existing (user) gradient map, before drop_shadow — not appended after it
    expect(stackA.map(e => e.id)).toEqual([userMap.id, first.owned.i, drop.id])
    const second = applyImageMaps(first.layers, ['#101010', '#eeeeee'], first.owned)
    const stackB = effectStackOf(second.layers[0] as any)
    expect(second.owned.i).toBe(first.owned.i)
    expect(stackB.map(e => e.id)).toEqual(stackA.map(e => e.id))                    // position kept
    expect((stackB[1] as any).stops.map((s: any) => s.color)).toEqual(['#101010', '#eeeeee'])
    expect((stackB[0] as any).stops[0].color).toBe('#000000')                       // user map untouched
  })
  it('forgets an owned map the user deleted', () => {
    const layers: any[] = [img('i')]
    const out = applyImageMaps(layers as any, fam, { i: 'fx_gone' })
    expect(out.owned.i).not.toBe('fx_gone')
    expect(effectStackOf(out.layers[0] as any)).toHaveLength(1)
  })
  it('lands at its canonical position, BEFORE an existing bloom, not appended after it', () => {
    const layers: any[] = [img('i', { effects: [createEffect('bloom')] })]
    const out = applyImageMaps(layers as any, fam, {})
    expect(effectStackOf(out.layers[0] as any).map(e => e.type)).toEqual(['gradientMap', 'bloom'])
  })
  it('id-stamps a legacy-shape stack, keeps the existing effect, and inserts the map before it', () => {
    const layers: any[] = [img('i', { effects: [{ type: 'grain', amount: 0.3, visible: true }] })]
    const out = applyImageMaps(layers as any, fam, {})
    const stack = effectStackOf(out.layers[0] as any)
    expect(stack.every(e => typeof e.id === 'string' && e.id.length > 0)).toBe(true)
    expect(stack.map(e => e.type)).toEqual(['gradientMap', 'grain'])
    expect(stack.find(e => e.type === 'grain')).toMatchObject({ amount: 0.3, visible: true })
    expect(stack.find(e => e.id === out.owned.i)?.type).toBe('gradientMap')
  })
  it('writes the stack through the house helper: an active legacy tornEdge is retired, not just shadowed, so re-applying never orphans the owned map', () => {
    const layers: any[] = [img('i', { effects: [], tornEdge: { ...DEFAULT_TORN_EDGE } })]
    const out = applyImageMaps(layers as any, fam, {})
    const l = out.layers[0] as any
    expect(l.tornEdge).toBeUndefined()
    const stack = effectStackOf(l)
    expect(stack.map(e => e.type).sort()).toEqual(['gradientMap', 'torn_edge'])
    expect(stack.find(e => e.id === out.owned.i)?.type).toBe('gradientMap')
    // a second apply, with the returned `owned`, must keep the SAME map id — no orphan
    const second = applyImageMaps(out.layers, fam, out.owned)
    expect(second.owned.i).toBe(out.owned.i)
    expect(effectStackOf(second.layers[0] as any)).toHaveLength(stack.length)
  })
})

describe('removeImageMaps', () => {
  it('removes only the owned maps and returns an empty record', () => {
    const userMap = createEffect('gradientMap')
    const layers: any[] = [img('i', { effects: [userMap] }), wired('w')]
    const applied = applyImageMaps(layers as any, fam, {})
    const out = removeImageMaps(applied.layers, applied.owned)
    expect(out.owned).toEqual({})
    expect(effectStackOf(out.layers[0] as any).map(e => e.id)).toEqual([userMap.id])
    expect(effectStackOf(out.layers[1] as any)).toHaveLength(0)
  })
})
