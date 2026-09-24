import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import { planSet } from '~/lib/frame/patterns/kit/set'
import { closestFirst, DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { Choice } from '~/lib/frame/patterns/kit/vary'
import { layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { applyFramePreset } from '~/lib/frame/frameSize'
import { clearPinsOfMoved } from '~/lib/frame/patterns/pins'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import type { Kind } from '~/lib/frame/patterns/kit/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ planSet (Stage 5, Task 1) ═══════════════════════
// The Frame's layout, recomposed at each picked format: the same layout at the closest choice,
// else the style's first offered layout (`swapped`), else nothing — planned purely, as an apply at
// that size would write it.

const SOURCE = FRAME_FORMATS.find(f => f.id === 'meta-feed-4x5')!

/** A portrait (4:5) Frame with `layoutId` applied at `choice`, as the Layout tab leaves it. */
function appliedSource(kind: Kind, layoutId: string, choice: Choice, style: StyleId = 'swiss') {
  const base = {
    props: { sailor_localLayers: frameLayers(kind, { image: false, shape: false }), sailor_frame: { preset: SOURCE.id } } as Record<string, unknown>,
    frameW: SOURCE.w, frameH: SOURCE.h, palette, connectedSlots: [] as number[], measure: makeStubMeasure(), style,
  }
  const plan = planLayout({ ...base, layoutId, choice })!
  expect(plan.issues).toEqual([])
  const props = {
    ...base.props,
    sailor_localLayers: plan.layers,
    sailor_stackOrder: plan.order,
    sailor_posterState: { ...plan.posterState, style },
  }
  return { ...base, props }
}

const setArgs = (src: ReturnType<typeof appliedSource>, layoutId: string, choice: Choice, formats: string[]) =>
  ({ ...src, layoutId, choice, formats })

describe('closestFirst — the one "closest choice" order (tag re-apply and the set)', () => {
  const list = [
    { choice: { lines: 0, arr: 0, scale: 'full', side: 'right' } as Choice },
    { choice: { lines: 1, arr: 1, scale: 'full', side: 'right' } as Choice },
    { choice: { lines: 0, arr: 1, scale: 'full', side: 'right' } as Choice },
  ]
  it('the equal choice first, then the most matching axes, ties in list order', () => {
    expect(closestFirst(list, { lines: 0, arr: 1, scale: 'full', side: 'right' }).map(o => o.i)).toEqual([2, 0, 1])
    expect(closestFirst(list, { lines: 2, arr: 1, scale: 'full', side: 'right' }).map(o => o.i)).toEqual([1, 2, 0])
  })
  it('an absent cta reads as drawn', () => {
    const l = [{ choice: { ...DEFAULT_CHOICE, cta: 'native' } as Choice }, { choice: { ...DEFAULT_CHOICE, cta: 'drawn' } as Choice }]
    expect(closestFirst(l, DEFAULT_CHOICE)[0]!.i).toBe(1)
  })
})

describe('planSet', () => {
  const runoff = { ...DEFAULT_CHOICE, lines: 1, arr: 2 }
  const src = appliedSource('sentence', 'runoff', runoff)

  it('keeps Run-off where it is offered, swaps to the style\'s first offered layout where it is not', () => {
    const out = planSet(setArgs(src, 'runoff', runoff, ['meta-feed-1x1', 'meta-story']))
    expect(out.map(e => e.formatId)).toEqual(['meta-feed-1x1', 'meta-story'])
    const [sq, story] = out
    expect(sq).toMatchObject({ label: 'Meta feed · 1:1', w: 1200, h: 1200, layoutId: 'runoff', layoutName: 'Run-off', swapped: false })
    expect(sq!.plan!.issues).toEqual([])
    expect(sq!.plan!.format?.id).toBe('meta-feed-1x1')
    // Run-off is never offered on stories: the Swiss library's first layout offered there.
    const storyFmt = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const storyArgs = { ...src, props: { ...src.props, sailor_frame: { preset: 'meta-story' } }, frameW: storyFmt.w, frameH: storyFmt.h }
    expect(candidatesForFrame({ ...storyArgs, layoutId: 'runoff' })).toEqual([])
    const first = layoutsForStyle('swiss').find(d => candidatesForFrame({ ...storyArgs, layoutId: d.id }).length)!
    expect(story).toMatchObject({ formatId: 'meta-story', layoutId: first.id, layoutName: first.name, swapped: true })
    expect(story!.plan!.issues).toEqual([])
    expect(story!.plan!.format?.id).toBe('meta-story')
    expect(story!.layers).not.toBeNull()
  })

  it('a format where nothing fits: no layout, no plan, no layers', () => {
    const quiet = appliedSource('sentence', 'edQuiet', DEFAULT_CHOICE, 'editorial')
    const out = planSet(setArgs(quiet, 'edQuiet', DEFAULT_CHOICE, ['meta-feed-1x1', 'ad-320x50']))
    expect(out[0]).toMatchObject({ formatId: 'meta-feed-1x1', layoutId: 'edQuiet', swapped: false })
    expect(out[1]).toEqual(expect.objectContaining({ formatId: 'ad-320x50', label: 'Display ad · 320×50', w: 320, h: 50, layoutId: null, layoutName: null, choice: null, plan: null, layers: null }))
  })

  it('the stored choice is kept where it exists, else the closest', () => {
    const out = planSet(setArgs(src, 'runoff', runoff, ['meta-feed-1x1', 'ad-300x600']))
    expect(out.map(e => e.choice)).toEqual([runoff, runoff])
    // Three-line breaks (lines 2) exist on 4:5 but not on 1:1: the closest is the same arrangement.
    const three = { ...DEFAULT_CHOICE, lines: 2, arr: 1 }
    const src3 = appliedSource('sentence', 'runoff', three)
    const [sq, tall] = planSet(setArgs(src3, 'runoff', three, ['meta-feed-1x1', 'ad-300x600']))
    expect(sq!.choice).toEqual({ ...DEFAULT_CHOICE, lines: 1, arr: 1 })
    expect(tall!.choice).toEqual(three)
    expect(sq!.plan!.posterState.choice).toEqual(sq!.choice)
  })

  it('writes what an apply at that size writes: resized, planned, pins of moved layers cleared', () => {
    // A pin on the title: an apply moves the title and drops its pins.
    const layers = (src.props.sailor_localLayers as LocalLayer[]).map(l => l.id === 't' ? { ...l, pins: { left: 0.1 } } as LocalLayer : l)
    const pinned = { ...src, props: { ...src.props, sailor_localLayers: layers } }
    const [e] = planSet(setArgs(pinned, 'runoff', runoff, ['meta-feed-1x1']))
    // The real thing: the Frame resized to the preset, then the layout planned and committed.
    const data = { widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [SOURCE.w, SOURCE.h], properties: structuredClone(pinned.props) }
    applyFramePreset(data, 'meta-feed-1x1')
    const plan = planLayout({ ...pinned, props: data.properties!, frameW: 1200, frameH: 1200, layoutId: 'runoff', choice: runoff })!
    const before = data.properties!.sailor_localLayers as LocalLayer[]
    expect(e!.plan).toEqual(plan)
    expect(e!.layers).toEqual(clearPinsOfMoved(before, plan.layers))
    expect((e!.layers!.find(l => l.id === 't') as { pins?: unknown }).pins).toBeUndefined()
  })

  it('a line the source format hid comes back at a format that carries it (as a resize does)', () => {
    // Source: a video thumbnail (carries two levels) — the number, the action line and the fine
    // print are hidden there. Sizing it to 4:5 shows them again before the layout runs.
    const vt = FRAME_FORMATS.find(f => f.id === 'video-thumb')!
    const base = {
      props: { sailor_localLayers: adFrameLayers('phrase', { image: true, action: true }), sailor_frame: { preset: vt.id } } as Record<string, unknown>,
      frameW: vt.w, frameH: vt.h, palette, connectedSlots: [] as number[], measure: makeStubMeasure(), style: 'swiss' as StyleId,
    }
    const at = candidatesForFrame({ ...base, layoutId: 'runoff' })[0]!.choice
    const plan = planLayout({ ...base, layoutId: 'runoff', choice: at })!
    expect(plan.issues).toEqual([])
    expect(plan.layers.find(l => l.id === 'dt')!.visible).toBe(false)
    const thumb = { ...base, props: { ...base.props, sailor_localLayers: plan.layers, sailor_posterState: { ...plan.posterState, style: 'swiss' } } }
    const [e] = planSet({ ...thumb, layoutId: 'runoff', choice: at, formats: ['meta-feed-4x5'] })
    expect(e!.layers!.find(l => l.id === 'dt')!.visible).not.toBe(false)
    expect(e!.plan!.format?.hidden).toEqual([])
    // Exactly what sizing the Frame to 4:5 and applying there leaves (tracking and naming included).
    const data = { widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [vt.w, vt.h], properties: structuredClone(thumb.props) }
    applyFramePreset(data, 'meta-feed-4x5')
    const real = planLayout({ ...thumb, props: data.properties!, frameW: SOURCE.w, frameH: SOURCE.h, layoutId: 'runoff', choice: e!.choice! })!
    expect(e!.plan).toStrictEqual(real)
    expect(e!.layers).toEqual(clearPinsOfMoved(data.properties!.sailor_localLayers as LocalLayer[], real.layers))
  })

  it('never changes the source Frame', () => {
    const snapshot = structuredClone(src.props)
    const out = planSet(setArgs(src, 'runoff', runoff, ['meta-feed-1x1', 'meta-story', 'ad-320x50', 'video-thumb']))
    expect(src.props).toEqual(snapshot)
    // The entries share nothing with the source: a caller editing one (Send to canvas) leaves it be.
    for (const e of out) for (const l of e.layers ?? []) Object.assign(l, { x: -1, text: 'changed' })
    expect(src.props).toEqual(snapshot)
  })

  it('is deterministic, in the order given; an unknown format id is left out', () => {
    const f = ['ad-300x250', 'meta-story', 'nope', 'meta-feed-1x1']
    const a = planSet(setArgs(src, 'runoff', runoff, f))
    const b = planSet(setArgs(src, 'runoff', runoff, f))
    expect(a.map(e => e.formatId)).toEqual(['ad-300x250', 'meta-story', 'meta-feed-1x1'])
    expect(a).toEqual(b)
  })

  it('performance: a 10-format set plans in under 1.5 s', () => {
    const ten = FRAME_FORMATS.slice(0, 10).map(f => f.id)
    planSet(setArgs(src, 'runoff', runoff, ten.slice(0, 1)))   // warm the module graph
    const t0 = performance.now()
    const out = planSet(setArgs(src, 'runoff', runoff, ten))
    const ms = performance.now() - t0
    process.stderr.write(`planSet: 10 formats in ${ms.toFixed(0)} ms\n`)
    expect(out).toHaveLength(10)
    expect(ms).toBeLessThan(1500)
  })
})
