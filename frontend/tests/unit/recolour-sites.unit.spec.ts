import { describe, it, expect } from 'vitest'
import { colourSites } from '~/lib/compositor/recolour/sites'

const text = (id: string, color: any, extra: any = {}) => ({ id, kind: 'text', text: 'HELLO', fontSize: 0.1, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000000', strokeWidth: 0, ...extra })
const rect = (id: string, fill: any, extra: any = {}) => ({ id, kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill, stroke: '', strokeWidth: 0, ...extra })

describe('colourSites', () => {
  it('yields the background, text colours, shape fills and gradient stops with weights, bg heaviest', () => {
    const layers: any[] = [text('t', '#112233'), rect('r', { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00' }] })]
    const sites = colourSites(layers, '#fafafa', 1.25)
    const by = Object.fromEntries(sites.map(s => [s.owner + ':' + s.path, s]))
    expect(by['bg:background'].hex).toBe('#fafafa'); expect(by['bg:background'].weight).toBe(1)
    expect(by['t:color'].hex).toBe('#112233'); expect(by['t:color'].kind).toBe('text')
    expect(by['r:fill.stops[0]'].hex).toBe('#ff0000'); expect(by['r:fill.stops[1]'].hex).toBe('#00ff00')
    expect(by['r:fill.stops[0]'].weight).toBeCloseTo(by['r:fill.stops[1]'].weight)   // a stop shares its layer's area
    expect(by['bg:background'].weight).toBeGreaterThan(by['r:fill.stops[0]'].weight)
  })
  it('strips alpha for grouping and re-attaches it on write', () => {
    const layers: any[] = [rect('r', '#ff000080')]
    const [site] = colourSites(layers, undefined, 1)
    expect(site.hex).toBe('#ff0000'); expect(site.alpha).toBe('80')
    const clone = JSON.parse(JSON.stringify(layers[0]))
    site.set(clone, '#123456')
    expect(clone.fill).toBe('#12345680')
  })
  it('skips non-hex paints, images without tint, and wired layers', () => {
    const layers: any[] = [
      rect('r', 'rgba(0,0,0,0.5)'),
      { id: 'i', kind: 'image', filename: 'x.png', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 },
      { id: 'w', kind: 'wired', slot: 1, x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 },
    ]
    expect(colourSites(layers, undefined, 1)).toEqual([])
  })
  it('reads a stroke stack through strokeStackOf and writes back without touching the legacy field', () => {
    // strokeWidth: 0 keeps the legacy stroke field INACTIVE (legacyStrokeIsLive is
    // hasInk(stroke) && strokeWidth > 0) so strokeStackOf reads the stored `strokes` array
    // rather than falling through to a synthesised single entry — see strokeStack.ts's
    // storedStrokeEntries: a layer with BOTH a live legacy stroke and a stored array is
    // read as "an older build editing a newer document" and the array is ignored entirely.
    const layers: any[] = [rect('r', '#ffffff', { stroke: '#000000', strokeWidth: 0, strokes: [{ id: 'a', paint: '#0000ff', width: 0.01, distance: 0 }, { id: 'b', paint: '#00ffff', width: 0.005, distance: 0.02 }] })]
    const sites = colourSites(layers, undefined, 1)
    const strokeSites = sites.filter(s => s.kind === 'stroke')
    expect(strokeSites.map(s => s.hex)).toEqual(['#0000ff', '#00ffff'])
    const clone = JSON.parse(JSON.stringify(layers[0]))
    strokeSites[0]!.set(clone, '#abcdef')
    expect(clone.strokes[0].paint).toBe('#abcdef'); expect(clone.strokes).toHaveLength(2); expect(clone.stroke).toBe('#000000')
  })
  it('when a live legacy stroke sits alongside a stale stored array, follows the reader: ONE legacy site, array untouched', () => {
    // strokeWidth: 0.01 (> 0) makes the legacy `stroke` field LIVE, so strokeStackOf's
    // storedStrokeEntries (strokeStack.ts:220, `allIded && !legacyStrokeIsLive(layer)`)
    // refuses the stored array outright and strokeStackOf synthesises ONE entry from the
    // legacy fields instead — the black legacy stroke is what the painter actually draws;
    // the blue/cyan array is stale. The walker must offer exactly the site the reader
    // renders, not the stale array underneath it.
    const layers: any[] = [rect('r', '#ffffff', { stroke: '#000000', strokeWidth: 0.01, strokes: [{ id: 'a', paint: '#0000ff', width: 0.01, distance: 0 }, { id: 'b', paint: '#00ffff', width: 0.005, distance: 0.02 }] })]
    const sites = colourSites(layers, undefined, 1)
    const strokeSites = sites.filter(s => s.kind === 'stroke')
    expect(strokeSites).toHaveLength(1)
    expect(strokeSites[0]!.hex).toBe('#000000')
    const clone = JSON.parse(JSON.stringify(layers[0]))
    strokeSites[0]!.set(clone, '#abcdef')
    expect(clone.stroke).toBe('#abcdef')
    expect(clone.strokes).toEqual(layers[0].strokes)   // byte-identical, untouched
  })
  it('a brush outline surfaces as a legacy stroke site; its freehand strokes never do', () => {
    // BrushLayer.strokes is freehand PaintStroke[] path data — unrelated to the stroke
    // stack, and brush is deliberately excluded from STACKABLE (strokeStack.ts:79). The
    // walker's legacy gate used to treat ANY `strokes` array (freehand or stored stack)
    // as "this layer has a stack," which hid the brush's real outline colour entirely.
    const layers: any[] = [{
      id: 'b', kind: 'brush', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1,
      fill: '#ffffff', stroke: '#112233', strokeWidth: 0.01,
      strokes: [{ points: [[0, 0], [0.1, 0.1], [0.2, 0]] }, { points: [[0.3, 0.3], [0.4, 0.4]] }],
    }]
    const sites = colourSites(layers, undefined, 1)
    const strokeSites = sites.filter(s => s.kind === 'stroke')
    expect(strokeSites).toHaveLength(1)
    expect(strokeSites[0]!.hex).toBe('#112233')
    expect(strokeSites[0]!.path).toBe('stroke')
    const clone = JSON.parse(JSON.stringify(layers[0]))
    strokeSites[0]!.set(clone, '#abcdef')
    expect(clone.stroke).toBe('#abcdef')
    expect(clone.strokes).toEqual(layers[0].strokes)   // freehand data untouched
  })
  it('never emits sites for a shader Fill\'s vestigial a/b/textColor', () => {
    const layers: any[] = [rect('r', {
      type: 'shader', a: '#111111', b: '#222222', textColor: '#333333', angle: 0, density: 1,
      shader: { effectId: 'holographic_surface', params: {}, input: '#444444' },
    })]
    const sites = colourSites(layers, undefined, 1)
    expect(sites.filter(s => s.owner === 'r')).toEqual([])
  })
  it('reads only the ACTIVE deal style inks and a Fill\'s a/b/textColor', () => {
    const layers: any[] = [
      { id: 'd', kind: 'deal', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1, cellFill: 'mosh', mosh: { inks: ['#111111', '#eeeeee'] }, pane: { inks: ['#999999'] } },
      rect('p', { type: 'dots', a: '#101010', b: '#f0f0f0', textColor: '#ff00ff', angle: 0, density: 0.5 }),
    ]
    const sites = colourSites(layers, undefined, 1)
    expect(sites.filter(s => s.owner === 'd').map(s => s.hex)).toEqual(['#111111', '#eeeeee'])   // pane ignored
    expect(sites.filter(s => s.owner === 'p').map(s => s.path).sort()).toEqual(['fill.a', 'fill.b', 'fill.textColor'])
  })
  it('a line with no stroke width emits no stroke site (gated like every other stroke path)', () => {
    const layers: any[] = [{ id: 'ln', kind: 'line', x: .5, y: .5, w: .3, rotation: 0, opacity: 1, stroke: '#334455', strokeWidth: 0 }]
    expect(colourSites(layers, undefined, 1)).toEqual([])
  })
  it('a line with a stroke width emits its stroke site', () => {
    const layers: any[] = [{ id: 'ln', kind: 'line', x: .5, y: .5, w: .3, rotation: 0, opacity: 1, stroke: '#334455', strokeWidth: 0.01 }]
    const sites = colourSites(layers, undefined, 1)
    expect(sites.map(s => s.hex)).toEqual(['#334455'])
  })
  it('text weight is frame-aspect-normalised, sharing a scale with shape weight', () => {
    const layers: any[] = [text('t', '#000000', { fontSize: 0.1 })]
    const wide = colourSites(layers, undefined, 1)[0]!.weight
    const tall = colourSites(layers, undefined, 2)[0]!.weight
    expect(tall).toBeCloseTo(wide / 2)
  })
  it('text weight scales with size and length; a stroke is light', () => {
    const layers: any[] = [text('big', '#000000', { fontSize: 0.2 }), text('small', '#000001', { fontSize: 0.05 }), rect('r', '#ffffff', { stroke: '#222222', strokeWidth: 0.01 })]
    const sites = colourSites(layers, undefined, 1)
    const w = (id: string) => sites.find(s => s.owner === id)!.weight
    expect(w('big')).toBeGreaterThan(w('small'))
    expect(sites.find(s => s.owner === 'r' && s.kind === 'stroke')!.weight).toBeLessThan(w('small'))
  })
})

describe('site.set with an alpha override', () => {
  it('replaces the captured alpha, and ff writes a 6-digit hex', () => {
    const layers: any[] = [{ id: 'r', kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill: '#ff000080', stroke: '', strokeWidth: 0 }]
    const [site] = colourSites(layers as any, undefined, 1)
    const c1 = JSON.parse(JSON.stringify(layers[0])); site!.set(c1, '#123456', '40'); expect(c1.fill).toBe('#12345640')
    const c2 = JSON.parse(JSON.stringify(layers[0])); site!.set(c2, '#123456', 'ff'); expect(c2.fill).toBe('#123456')
    const c3 = JSON.parse(JSON.stringify(layers[0])); site!.set(c3, '#123456'); expect(c3.fill).toBe('#12345680')   // no override → captured alpha kept
  })
})
