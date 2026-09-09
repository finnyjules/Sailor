import { describe, it, expect } from 'vitest'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { PatternPlacement, FrameElements } from '~/lib/frame/patterns/types'

const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
function textLayer(id: string, over: Partial<any> = {}): any {
  return { id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NOISE',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over }
}
const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [], shapes: [], shapeMode: null } as unknown as FrameElements

describe('applyPlacement', () => {
  it('patches the title layer geometry and ink colour from the op', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.3, w: 0.9, fontSize: 0.25, rotation: 0, align: 'left', colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next).not.toBe(layers)                 // new array
    expect(next[0]).not.toBe(layers[0])           // new layer object (immutable)
    const t = next[0] as any
    expect([t.x, t.y]).toEqual([0.2, 0.3])
    expect(t.fontSize).toBe(0.25)
    expect(t.boxW).toBe(0.9)                       // op.w → text boxW
    expect(t.align).toBe('left')
    expect(t.color).toBe('#121212')               // ink role → hex
  })
  it('inserts line breaks and blend, and leaves the font/weight untouched', () => {
    const layers: LocalLayer[] = [textLayer('t', { fontFamily: 'Anton', fontWeight: 800 })]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.2, colorRole: 'accent', blend: 'multiply', lineBreak: 'NO\nISE' },
    ] }
    const t = applyPlacement(layers, placement, elements, palette)[0] as any
    expect(t.text).toBe('NO\nISE')
    expect(t.blend).toBe('multiply')
    expect(t.color).toBe('#dd2200')
    expect(t.fontFamily).toBe('Anton')            // NEVER changed by apply
    expect(t.fontWeight).toBe(800)                // NEVER changed by apply
  })
  it('skips an op whose target resolves to no layer', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'details', kind: 'text', x: 0.1, y: 0.1, fontSize: 0.02, colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next[0]).toEqual(layers[0])            // unchanged (no details element)
  })
})
