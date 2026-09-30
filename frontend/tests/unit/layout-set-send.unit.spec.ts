// Stage 5 (Make a set), Task 4: send one format of the set to the canvas as a new Frame node —
// the pure node-props builder (size + stored preset, layers, groups, order, posterState, owned
// pieces, name, source untouched), the wired-slot edges, the placement, and the toast.
import { describe, it, expect } from 'vitest'
import {
  frameCardSize, placeRightOf, sendFailedToast, sentFrameData, sentFrameEdges, sentFrameName, sentFrameToast,
} from '~/lib/frame/layoutSetSend'
import { FRAME_FORMATS, formatFor } from '~/lib/frame/formats'
import { framePresetId, readFrameSize } from '~/lib/frame/frameSize'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { LocalLayer } from '~/composables/useCompositorLayers'

function source() {
  return {
    nodeType: 'Compositor',
    title: 'Summer sale',
    widgetDefs: [{ name: 'width' }, { name: 'height' }],
    widgetsValues: [1080, 1350],
    inputs: [{ name: 'layer1', type: 'IMAGE', link: null }],
    images: ['/view?filename=old.png&type=input'],
    properties: {
      sailor_frame: { preset: 'meta-feed-4x5', displayEdge: 320 },
      sailor_localBg: { type: 'solid', color: '#f4efe6' },
      sailor_localLayers: [
        { id: 't1', kind: 'text', text: 'Summer sale', x: 0.1, y: 0.1, w: 0.8 },
        { id: 'img', kind: 'image', x: 0, y: 0.5, w: 1 },
      ],
      sailor_localGroups: [{ id: 'g1', name: 'Group 1', layerIds: ['t1'] }],
      sailor_stackOrder: ['w:1', 'l:img', 'l:t1'],
      sailor_renderKey: 'abc',
      sailor_posterState: {
        patternId: 'runoff', seed: 3, choice: { scale: 'large' }, roles: { title: 't1' }, style: 'swiss', index: 4,
        shapeMode: { family: 'blob' }, imageMode: true, palette: ['#111111'], tags: { t1: 'title' },
        set: { formats: ['meta-story', 'ad-300x250'] },
      },
      sailor_layoutSet: { formats: ['meta-story', 'ad-300x250'] },
    },
  }
}

function entry(formatId: string, over: Partial<SetEntry> = {}): SetEntry {
  const f = FRAME_FORMATS.find(x => x.id === formatId)!
  const layers = [
    { id: 't1', kind: 'text', text: 'Summer sale', x: 0.2, y: 0.3, w: 0.6 },
    { id: 'img', kind: 'image', x: 0, y: 0.4, w: 1 },
    { id: 'piece-1', kind: 'shape', owner: 'layout', x: 0.05, y: 0.05, w: 0.1 },
  ] as unknown as LocalLayer[]
  return {
    formatId, label: f.label, w: f.w, h: f.h, layoutId: 'edCover', layoutName: 'Cover', swapped: true,
    choice: { scale: 'small' } as unknown as SetEntry['choice'],
    plan: {
      layers, order: ['l:piece-1', 'w:1', 'l:img', 'l:t1'], did: '', issues: [],
      posterState: { patternId: 'edCover', seed: 7, choice: { scale: 'small' } as never, roles: { title: 't1', details: 'img' } as never, placed: ['t1'] },
      format: null, notPlaced: [],
    } as unknown as SetEntry['plan'],
    layers,
    groups: [{ id: 'g1', name: 'Group 1', layerIds: ['t1'] }] as unknown as SetEntry['groups'],
    ...over,
  }
}

describe('sentFrameData — the new Frame node', () => {
  it('is sized to the format, with its preset stored the way the Size menu stores it', () => {
    const e = entry('meta-story')
    const d = sentFrameData(source(), e)!
    expect(readFrameSize(d)).toEqual({ w: e.w, h: e.h })
    expect(d.properties.sailor_frame.preset).toBe('meta-story')
    expect(formatFor(d.properties, e.w, e.h)?.id).toBe('meta-story')
    expect(framePresetId(e.w, e.h, d.properties.sailor_frame.preset)).toBe('meta-story')
    // the rest of sailor_frame is kept (the card's display size)
    expect(d.properties.sailor_frame.displayEdge).toBe(320)
  })

  it('finds the right format where two formats share one size', () => {
    const shared = FRAME_FORMATS.find(f => FRAME_FORMATS.some(g => g.id !== f.id && g.w === f.w && g.h === f.h))
    if (!shared) return
    const d = sentFrameData(source(), entry(shared.id))!
    expect(formatFor(d.properties, shared.w, shared.h)?.id).toBe(shared.id)
  })

  it('carries the planned layers, groups and stack order; owned pieces keep their owner', () => {
    const e = entry('ad-300x250')
    const d = sentFrameData(source(), e)!
    expect(d.properties.sailor_localLayers).toEqual(e.layers)
    expect(d.properties.sailor_localLayers).not.toBe(e.layers)
    expect(d.properties.sailor_localLayers.find((l: any) => l.id === 'piece-1').owner).toBe('layout')
    expect(d.properties.sailor_localGroups).toEqual(e.groups)
    expect(d.properties.sailor_stackOrder).toEqual(e.plan!.order)
  })

  it('remembers the plan’s layout so its Layout tab opens on it', () => {
    const d = sentFrameData(source(), entry('meta-story'))!
    const st = d.properties.sailor_posterState
    expect(st.patternId).toBe('edCover')
    expect(st.choice).toEqual({ scale: 'small' })
    expect(st.style).toBe('editorial')
    expect(st.roles).toEqual({ title: 't1', details: 'img' })
    expect(st.seed).toBe(7)
    expect(st.placed).toEqual(['t1'])
    // the picker state the set planned with is kept; the set ticks and list position are not
    expect(st.tags).toEqual({ t1: 'title' })
    expect(st.shapeMode).toEqual({ family: 'blob' })
    expect(st.imageMode).toBe(true)
    expect(st.palette).toEqual(['#111111'])
    expect(st.set).toBeUndefined()
    expect(st.index).toBeUndefined()
    expect(d.properties.sailor_layoutSet).toBeUndefined()
  })

  it('a Swiss layout is remembered as Swiss, with no stale placed lines', () => {
    const e = entry('meta-story')
    e.plan!.posterState = { patternId: 'runoff', seed: 1, choice: {} as never, roles: {} as never }
    const src = source(); (src.properties.sailor_posterState as any).placed = ['old']
    const st = sentFrameData(src, e)!.properties.sailor_posterState
    expect(st.style).toBe('swiss')
    expect(st.placed).toBeUndefined()
  })

  it('keeps the source’s background and everything else, is named after it, and starts unbaked', () => {
    const d = sentFrameData(source(), entry('meta-story'))!
    expect(d.properties.sailor_localBg).toEqual({ type: 'solid', color: '#f4efe6' })
    expect(d.nodeType).toBe('Compositor')
    expect(d.inputs).toEqual(source().inputs)
    expect(d.title).toBe('Summer sale · ' + FRAME_FORMATS.find(f => f.id === 'meta-story')!.label)
    expect(d.images).toBeUndefined()
    expect(d.properties.sailor_renderKey).toBeUndefined()
  })

  it('drops the source card’s viewing shape (made for the source’s size), keeping the rest of sailor_frame', () => {
    const src = source() as ReturnType<typeof source> & { properties: { sailor_frame: Record<string, unknown> } }
    src.properties.sailor_frame = { ...src.properties.sailor_frame, responsive: true, cardView: { w: 1440, h: 900 } }
    const d = sentFrameData(src, entry('meta-story'))!
    expect(d.properties.sailor_frame.cardView).toBeUndefined()
    expect(d.properties.sailor_frame.preset).toBe('meta-story')
    expect(d.properties.sailor_frame.displayEdge).toBe(320)
    expect(d.properties.sailor_frame.responsive).toBe(true)
    expect(src.properties.sailor_frame.cardView).toEqual({ w: 1440, h: 900 })   // source untouched
  })

  it('leaves the source untouched', () => {
    const src = source()
    const before = JSON.parse(JSON.stringify(src))
    const e = entry('meta-story')
    const eBefore = JSON.parse(JSON.stringify(e))
    const d = sentFrameData(src, e)!
    d.properties.sailor_localLayers[0].x = 99
    d.properties.sailor_posterState.tags.t1 = 'changed'
    d.properties.sailor_frame.displayEdge = 1
    expect(src).toEqual(before)
    expect(JSON.parse(JSON.stringify(e))).toEqual(eBefore)
  })

  it('sends nothing for a format where nothing fits', () => {
    expect(sentFrameData(source(), entry('meta-story'))).not.toBeNull()
    expect(sentFrameData(source(), entry('meta-story', { plan: null, layers: null, groups: null, layoutId: null }))).toBeNull()
  })
})

describe('names and toast', () => {
  it('names the new Frame and says what was added, quoting the new Frame’s own name', () => {
    const label = FRAME_FORMATS.find(f => f.id === 'meta-story')!.label
    expect(sentFrameName({ title: 'Summer sale' }, { label })).toBe(`Summer sale · ${label}`)
    expect(sentFrameToast({ title: 'Summer sale' }, { label })).toBe(`Added “Summer sale · ${label}” to the canvas.`)
    expect(sentFrameToast({}, { label })).toBe(`Added “Frame · ${label}” to the canvas.`)
    // …the name the new Frame is given.
    expect(sentFrameToast(source(), entry('meta-story'))).toBe(`Added “${sentFrameData(source(), entry('meta-story'))!.title}” to the canvas.`)
  })

  it('says so when a send could not be made', () => {
    const label = FRAME_FORMATS.find(f => f.id === 'meta-story')!.label
    expect(sendFailedToast({ label })).toBe(`Couldn't send ${label} to the canvas.`)
  })
})

describe('sentFrameEdges — wired slots keep their wires', () => {
  it('copies every edge into the source onto the new node, and nothing else', () => {
    const edges = [
      { id: 'a', source: '5', sourceHandle: 'output-0', target: '9', targetHandle: 'input-0', type: 'comfy', data: { dataType: 'IMAGE' } },
      { id: 'b', source: '6', sourceHandle: 'output-1', target: '9', targetHandle: 'input-2', type: 'comfy' },
      { id: 'c', source: '9', sourceHandle: 'output-0', target: '12', targetHandle: 'input-0', type: 'comfy' },
    ]
    const out = sentFrameEdges('9', '42', edges)
    expect(out.map(e => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['5', 'output-0', '42', 'input-0'],
      ['6', 'output-1', '42', 'input-2'],
    ])
    expect(out[0]!.data).toEqual({ dataType: 'IMAGE' })
    expect(new Set(out.map(e => e.id)).size).toBe(2)
    expect(edges[0]!.target).toBe('9')
  })
})

describe('placeRightOf — right of the source, never overlapping', () => {
  const src = { id: '9', position: { x: 100, y: 50 }, dimensions: { width: 300, height: 400 } }
  it('goes right of the source, level with it', () => {
    const p = placeRightOf(src, [src], { w: 200, h: 300 })
    expect(p.y).toBe(50)
    expect(p.x).toBeGreaterThanOrEqual(400)
  })
  it('each further send steps further right, past the ones already sent', () => {
    const nodes: any[] = [src]
    const xs: number[] = []
    for (let i = 0; i < 3; i++) {
      const size = frameCardSize(300, 1080, 1920)
      const p = placeRightOf(src, nodes, size)
      xs.push(p.x)
      nodes.push({ id: `n${i}`, position: p, dimensions: { width: size.w, height: size.h } })
    }
    expect(xs[1]!).toBeGreaterThan(xs[0]! + frameCardSize(300, 1080, 1920).w)
    expect(xs[2]!).toBeGreaterThan(xs[1]! + frameCardSize(300, 1080, 1920).w)
  })
  it('the card size follows the format’s aspect and the display edge', () => {
    // Portrait 1080×1920 at edge 300: box.w = round(300×1080/1920) = 169, plus the glass's 12px.
    expect(frameCardSize(300, 1080, 1920).w).toBe(181)
    // No stored displayEdge: the default is now 308 (the card's own default), plus the glass.
    expect(frameCardSize(undefined, 1920, 1080).w).toBe(320)
  })
})
