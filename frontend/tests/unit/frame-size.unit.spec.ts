/**
 * The Frame's size and Responsive switch — one module that both the Frame node's header and the
 * Frame editor's "Frame" section write through, so the two can never write different fields.
 *
 *  - A size matches a preset exactly, or reads "custom"; no size at all reads "".
 *  - A preset writes the width and height widgets and remembers itself on `sailor_frame.preset`.
 *  - Turning Responsive on writes a concrete design size when the frame had none (slice 2: the
 *    design size must never be re-derived from the live canvas), and keeps an explicit one.
 *  - Turning it off keeps the size; every write keeps the rest of `sailor_frame` (e.g. `clock`).
 */
import { describe, it, expect } from 'vitest'
import {
  FRAME_SIZE_PRESETS, applyFramePreset, designSizeForAspect, frameDimFor, framePresetId, readFrameSize,
  readFrameSizeState, setFrameDim, setFrameResponsive, writeFrameSizeState, type FrameSizeNodeData,
} from '~/lib/frame/frameSize'
import { isResponsiveFrame } from '~/lib/frame/responsive'
import { reactive } from 'vue'
import { formatFor } from '~/lib/frame/formats'
import { planLayout } from '~/lib/frame/patterns/kit/plan'
import { layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

function frameData(w = 0, h = 0, properties?: Record<string, any>): FrameSizeNodeData {
  return {
    widgetDefs: [{ name: 'layer1_x' }, { name: 'width' }, { name: 'height' }],
    widgetsValues: [5, w, h],
    ...(properties ? { properties } : {}),
  }
}

describe('framePresetId', () => {
  it('names the preset a size matches exactly', () => {
    expect(framePresetId(1280, 720)).toBe('16:9')
    expect(framePresetId(1024, 1024)).toBe('1:1')
  })
  it('reads "custom" for an explicit size no preset matches, and "" for no size', () => {
    expect(framePresetId(1280, 721)).toBe('custom')
    expect(framePresetId(0, 0)).toBe('')
    expect(framePresetId(1280, 0)).toBe('')
  })
  it('keeps the node header presets first, unchanged (Stage 2 adds the ad/social formats after them)', () => {
    expect(FRAME_SIZE_PRESETS.slice(0, 6).map(p => p.id)).toEqual(['1:1', '16:9', '9:16', '4:5', '4:3', 'A4'])
  })
})

describe('applyFramePreset', () => {
  it('writes width and height and remembers the preset', () => {
    const d = frameData(0, 0, { sailor_frame: { clock: { duration: 4 } } })
    expect(applyFramePreset(d, '9:16')).toBe(true)
    expect(readFrameSize(d)).toEqual({ w: 720, h: 1280 })
    expect(d.widgetsValues![0]).toBe(5)
    expect(d.properties!.sailor_frame).toEqual({ clock: { duration: 4 }, preset: '9:16' })
  })
  it('ignores an unknown id, and "custom"', () => {
    const d = frameData(800, 600)
    expect(applyFramePreset(d, 'custom')).toBe(false)
    expect(applyFramePreset(d, 'nope')).toBe(false)
    expect(readFrameSize(d)).toEqual({ w: 800, h: 600 })
    expect(d.properties).toBeUndefined()
  })
  it('does not change whether the frame is responsive', () => {
    const d = frameData(1024, 1024, { sailor_frame: { responsive: true } })
    applyFramePreset(d, '16:9')
    expect(isResponsiveFrame(d.properties)).toBe(true)
  })
})

describe('setFrameDim', () => {
  it('writes one side, rounded and never negative, and marks the size custom', () => {
    const d = frameData(1024, 1024)
    setFrameDim(d, 'width', 1300.6)
    setFrameDim(d, 'height', -5)
    expect(readFrameSize(d)).toEqual({ w: 1301, h: 0 })
    expect(d.properties!.sailor_frame.preset).toBe('custom')
  })
  it('refuses to clear a side of a responsive frame — its design size must stay concrete', () => {
    const d = frameData(1280, 720, { sailor_frame: { responsive: true } })
    expect(frameDimFor(d, 0)).toBeNull()
    expect(setFrameDim(d, 'width', 0)).toBe(false)
    expect(readFrameSize(d)).toEqual({ w: 1280, h: 720 })
    expect(d.properties!.sailor_frame.preset).toBeUndefined()
    expect(frameDimFor(d, 900.4)).toBe(900)
  })
  it('treats a non-number as 0', () => {
    const d = frameData(1024, 1024)
    setFrameDim(d, 'width', Number.NaN)
    expect(readFrameSize(d).w).toBe(0)
  })
})

describe('setFrameResponsive', () => {
  it('turning on with no size writes a concrete design size from the aspect (long side 1024)', () => {
    const wide = frameData()
    setFrameResponsive(wide, true, 16 / 9)
    expect(readFrameSize(wide)).toEqual({ w: 1024, h: 576 })
    expect(isResponsiveFrame(wide.properties)).toBe(true)

    const tall = frameData()
    setFrameResponsive(tall, true, 0.5)
    expect(readFrameSize(tall)).toEqual({ w: 512, h: 1024 })
  })
  it('turning on falls back to square when the aspect is unknown', () => {
    const d = frameData()
    setFrameResponsive(d, true, Number.NaN)
    expect(readFrameSize(d)).toEqual({ w: 1024, h: 1024 })
  })
  it('turning on keeps an explicit size', () => {
    const d = frameData(1280, 720)
    setFrameResponsive(d, true, 1)
    expect(readFrameSize(d)).toEqual({ w: 1280, h: 720 })
  })
  it('turning off keeps the size and the rest of sailor_frame', () => {
    const d = frameData(1280, 720, { sailor_frame: { responsive: true, clock: { duration: 2 } } })
    setFrameResponsive(d, false, 1)
    expect(readFrameSize(d)).toEqual({ w: 1280, h: 720 })
    expect(d.properties!.sailor_frame).toEqual({ responsive: false, clock: { duration: 2 } })
    expect(isResponsiveFrame(d.properties)).toBe(false)
  })
})

describe('designSizeForAspect', () => {
  it('puts 1024 on the long side', () => {
    expect(designSizeForAspect(1)).toEqual({ w: 1024, h: 1024 })
    expect(designSizeForAspect(2)).toEqual({ w: 1024, h: 512 })
    expect(designSizeForAspect(0)).toEqual({ w: 1024, h: 1024 })
  })
})

describe('readFrameSizeState / writeFrameSizeState (the undo snapshot of the size)', () => {
  it('is undefined for a node without size widgets', () => {
    expect(readFrameSizeState({ widgetDefs: [{ name: 'x' }], widgetsValues: [1] })).toBeUndefined()
  })
  it('round-trips the size, Responsive and the preset exactly, keeping the rest of sailor_frame', () => {
    const d = frameData(1280, 720, { sailor_frame: { responsive: true, preset: '16:9', clock: { duration: 3 } } })
    const saved = readFrameSizeState(d)!
    expect(saved).toEqual({ w: 1280, h: 720, responsive: true, preset: '16:9' })
    setFrameResponsive(d, false, 1)
    applyFramePreset(d, 'A4')
    writeFrameSizeState(d, saved)
    expect(readFrameSize(d)).toEqual({ w: 1280, h: 720 })
    expect(d.properties!.sailor_frame).toEqual({ responsive: true, preset: '16:9', clock: { duration: 3 } })
  })
  it('restores absent keys as absent, and no sailor_frame when there was none', () => {
    const d = frameData(0, 0)
    const saved = readFrameSizeState(d)!
    expect(saved).toEqual({ w: 0, h: 0 })
    setFrameResponsive(d, true, 2)
    writeFrameSizeState(d, saved)
    expect(readFrameSize(d)).toEqual({ w: 0, h: 0 })
    expect(d.properties?.sailor_frame).toBeUndefined()
  })
  it('writes nothing when the state already matches', () => {
    const sf = { responsive: false, preset: '1:1' }
    const d = frameData(1024, 1024, { sailor_frame: sf })
    writeFrameSizeState(d, readFrameSizeState(d)!)
    expect(d.properties!.sailor_frame).toBe(sf)
  })
})

// ── Final fix I1: two presets can share one size; the select shows the stored one ──────────────
describe('framePresetId — the stored preset wins among presets of the same size (final fix I1)', () => {
  it('a video-thumb Frame shows "video-thumb"; a plain 16:9 Frame shows "16:9"', () => {
    expect(framePresetId(1280, 720, 'video-thumb')).toBe('video-thumb')
    expect(framePresetId(1280, 720, '16:9')).toBe('16:9')
    expect(framePresetId(1080, 1920, 'pinterest-9x16')).toBe('pinterest-9x16')
    expect(framePresetId(1200, 1200, 'pmax-square')).toBe('pmax-square')
  })
  it('a stored preset of another size (or none, or custom) falls back to the first of this size', () => {
    expect(framePresetId(1280, 720)).toBe('16:9')
    expect(framePresetId(1280, 720, 'custom')).toBe('16:9')
    expect(framePresetId(1280, 720, 'A4')).toBe('16:9')
    expect(framePresetId(1280, 721, 'video-thumb')).toBe('custom')
  })
  it('picking "16:9" on a video-thumb Frame writes preset "16:9", and the Frame then has no format', () => {
    const d = frameData(1280, 720, { sailor_frame: { preset: 'video-thumb' } })
    expect(formatFor(d.properties!, 1280, 720)?.id).toBe('video-thumb')
    expect(framePresetId(1280, 720, d.properties!.sailor_frame.preset)).not.toBe('16:9')   // so the pick is not a no-op
    expect(applyFramePreset(d, '16:9')).toBe(true)
    expect(d.properties!.sailor_frame.preset).toBe('16:9')
    expect(formatFor(d.properties!, 1280, 720)).toBeNull()
    expect(framePresetId(1280, 720, d.properties!.sailor_frame.preset)).toBe('16:9')
  })
})

// ── Final fix I2: leaving a format shows again the lines it hid ────────────────────────────────
describe('a size write that changes the format restores the lines the old one hid (final fix I2)', () => {
  /** A Frame sized as a video thumbnail with a layout applied: the date and caption hidden. */
  function videoThumbFrame() {
    const t = (id: string, text: string, fontSize: number) =>
      createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
    const layers = [t('t', 'Weather Report', 0.12), t('d', 'Ines Vollmer', 0.04), t('dt', '19.09.–15.11.2026', 0.03), t('c', 'Kunstraum Lenz', 0.02)]
    const props: Record<string, any> = { sailor_localLayers: layers, sailor_frame: { preset: 'video-thumb' } }
    const plan = planLayout({ props, frameW: 1280, frameH: 720, layoutId: 'statement', choice: { ...DEFAULT_CHOICE }, palette: { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }, connectedSlots: [], measure: makeStubMeasure() })!
    expect(plan.format!.hidden).toEqual(['date', 'caption'])
    props.sailor_localLayers = plan.layers
    props.sailor_posterState = plan.posterState
    return props
  }
  const layer = (props: Record<string, any>, id: string) => (props.sailor_localLayers as any[]).find(l => l.id === id)

  it('video-thumb hides the date and caption; applyFramePreset("4:5") shows both again; one undo brings back the hidden state and video-thumb', () => {
    const properties = videoThumbFrame()
    expect(layer(properties, 'dt').visible).toBe(false)
    expect(layer(properties, 'c').visible).toBe(false)
    expect(layer(properties, 'dt').layoutPrev.visible).toEqual({ was: null, set: false })
    const node = reactive({ data: { widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [1280, 720], properties } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
    ed.recordHistory(); applyFramePreset(node.data, '4:5')                       // what CompositorModal does
    const p = node.data.properties
    for (const id of ['dt', 'c']) {
      expect(layer(p, id), id).not.toHaveProperty('visible')
      expect(layer(p, id).layoutPrev?.visible, id).toBeUndefined()
    }
    expect(layer(p, 't').visible).not.toBe(false)
    ed.undo()
    expect(node.data.widgetsValues).toEqual([1280, 720])
    expect(node.data.properties.sailor_frame.preset).toBe('video-thumb')
    expect(layer(node.data.properties, 'dt').visible).toBe(false)
    expect(layer(node.data.properties, 'c').visible).toBe(false)
    expect(layer(node.data.properties, 'c').layoutPrev.visible).toEqual({ was: null, set: false })
  })

  it('a line the user showed again by hand (visible: true) is left alone', () => {
    const properties = videoThumbFrame()
    properties.sailor_localLayers = properties.sailor_localLayers.map((l: any) => (l.id === 'c' ? { ...l, visible: true } : l))
    const d = frameData(1280, 720, properties)
    applyFramePreset(d, '4:5')
    expect(layer(d.properties!, 'c').visible).toBe(true)
    expect(layer(d.properties!, 'c').layoutPrev.visible).toEqual({ was: null, set: false })
    expect(layer(d.properties!, 'dt')).not.toHaveProperty('visible')           // the untouched one is restored
  })

  it('a line hid before the format and "was" visible: false goes back to false', () => {
    const properties = videoThumbFrame()
    properties.sailor_localLayers = properties.sailor_localLayers.map((l: any) => (l.id === 'c' ? { ...l, layoutPrev: { ...l.layoutPrev, visible: { was: false, set: false } } } : l))
    const d = frameData(1280, 720, properties)
    applyFramePreset(d, '4:5')
    expect(layer(d.properties!, 'c').visible).toBe(false)
    expect(layer(d.properties!, 'c').layoutPrev?.visible).toBeUndefined()
  })

  it('only the levels the NEW format carries come back: video-thumb → 300×600 (carries 3) shows the date, keeps the caption hidden', () => {
    const d = frameData(1280, 720, videoThumbFrame())
    applyFramePreset(d, 'ad-300x600')
    expect(layer(d.properties!, 'dt')).not.toHaveProperty('visible')
    expect(layer(d.properties!, 'c').visible).toBe(false)
    expect(layer(d.properties!, 'c').layoutPrev.visible).toEqual({ was: null, set: false })
  })

  it('setFrameDim and setFrameResponsive restore too; a size write that keeps the format changes no layer', () => {
    const d1 = frameData(1280, 720, videoThumbFrame())
    setFrameDim(d1, 'height', 721)                                               // custom: no format
    expect(layer(d1.properties!, 'dt')).not.toHaveProperty('visible')
    expect(layer(d1.properties!, 'c')).not.toHaveProperty('visible')
    // Responsive on a Frame with no explicit size writes a 1024×576 design size: with the stored
    // video-thumb preset (aspect matches) that is video-thumb again, which still hides both lines.
    const d2 = frameData(0, 0, videoThumbFrame())
    const before = d2.properties!.sailor_localLayers
    setFrameResponsive(d2, true, 1280 / 720)
    expect(readFrameSize(d2)).toEqual({ w: 1024, h: 576 })
    expect(d2.properties!.sailor_localLayers).toBe(before)
    // …and re-picking the same format writes nothing to the layers.
    const d3 = frameData(1280, 720, videoThumbFrame())
    const same = d3.properties!.sailor_localLayers
    applyFramePreset(d3, 'video-thumb')
    expect(d3.properties!.sailor_localLayers).toBe(same)
  })
})

describe('leaving a format restores the lines by the style that hid them (Stage 3, Task 8)', () => {
  /** A Performance layout applied on a video thumbnail (carries 2): Performance ranks the date
   *  above the details, so it keeps title + date and hides the details and the caption. */
  function performanceThumbFrame() {
    const t = (id: string, text: string, fontSize: number) =>
      createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
    const layers = [t('t', 'Run lighter.', 0.12), t('d', 'Halden Trail 2', 0.04), t('dt', '–30%', 0.03), t('c', 'Offer ends 12 October.', 0.02)]
    const props: Record<string, any> = { sailor_localLayers: layers, sailor_frame: { preset: 'video-thumb' } }
    // The first Performance layout that runs on this Frame (with the image stand-in: they all
    // show the product).
    const plan = layoutsForStyle('performance').map(l => planLayout({ props, frameW: 1280, frameH: 720, layoutId: l.id, choice: { ...DEFAULT_CHOICE }, palette: { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }, connectedSlots: [], measure: makeStubMeasure(), style: 'performance', imageMode: true })).find(Boolean)!
    expect(plan.format!.hidden).toEqual(['details', 'caption'])
    props.sailor_localLayers = plan.layers
    props.sailor_posterState = { ...plan.posterState, style: 'performance' }
    return props
  }
  const layer = (props: Record<string, any>, id: string) => (props.sailor_localLayers as any[]).find(l => l.id === id)

  it('video-thumb → 320×50 (also carries 2): the details and caption stay hidden — the Swiss order would show the details', () => {
    const d = frameData(1280, 720, performanceThumbFrame())
    expect(layer(d.properties!, 'd').visible).toBe(false)
    expect(layer(d.properties!, 'c').visible).toBe(false)
    applyFramePreset(d, 'ad-320x50')
    expect(layer(d.properties!, 'd').visible).toBe(false)
    expect(layer(d.properties!, 'd').layoutPrev.visible).toEqual({ was: null, set: false })
    expect(layer(d.properties!, 'c').visible).toBe(false)
  })

  it('video-thumb → 300×600 (carries 3): the details come back, the caption stays hidden', () => {
    const d = frameData(1280, 720, performanceThumbFrame())
    applyFramePreset(d, 'ad-300x600')
    expect(layer(d.properties!, 'd')).not.toHaveProperty('visible')
    expect(layer(d.properties!, 'c').visible).toBe(false)
  })

  it('video-thumb → 4:5 (no format): both come back', () => {
    const d = frameData(1280, 720, performanceThumbFrame())
    applyFramePreset(d, '4:5')
    expect(layer(d.properties!, 'd')).not.toHaveProperty('visible')
    expect(layer(d.properties!, 'c')).not.toHaveProperty('visible')
  })
})

// ── Known limit 2: a size change restores only what the OLD format hid ─────────────────────────
// A line a layout left out (Review's headline, Strip's details) is not the format's: leaving or
// changing the format keeps it hidden, and the layout still names it.
describe('a format change shows again only the lines the old format hid (layout limits, fix 2)', () => {
  const pal = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const t = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  const reviewAd = (): LocalLayer[] => [
    t('t', 'Run lighter.', 0.1), t('d', 'Halden Trail 2', 0.045), t('q', '“Lightest shoe I have ever raced in.”', 0.035),
    t('dt', '–30%', 0.04), t('a', 'Shop now', 0.025), t('r', '4.7 ★', 0.022), t('c', 'Offer ends 12 October.', 0.02),
    t('b', '— Maya R., verified buyer', 0.018), img(),
  ]
  const img = () => createImageLayer('img.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer
  const layer = (props: Record<string, any>, id: string) => (props.sailor_localLayers as any[]).find(l => l.id === id)
  /** Apply `layoutId` (Performance) at w×h, as the Layout tab does; the Frame's size widgets and preset set. */
  function applied(layers: LocalLayer[], layoutId: string, w: number, h: number, preset?: string) {
    const props: Record<string, any> = { sailor_localLayers: layers, ...(preset ? { sailor_frame: { preset } } : {}) }
    const plan = planLayout({ props, frameW: w, frameH: h, layoutId, choice: { ...DEFAULT_CHOICE }, palette: pal, connectedSlots: [], measure: makeStubMeasure(), style: 'performance' })!
    expect(plan, layoutId).toBeTruthy()
    props.sailor_localLayers = plan.layers
    props.sailor_posterState = { ...plan.posterState, style: 'performance' }
    return { plan, data: frameData(w, h, props) }
  }
  const replan = (d: FrameSizeNodeData, layoutId: string) => {
    const { w, h } = readFrameSize(d)
    return planLayout({ props: d.properties!, frameW: w, frameH: h, layoutId, choice: { ...DEFAULT_CHOICE }, palette: pal, connectedSlots: [], measure: makeStubMeasure(), style: 'performance' })!
  }

  it('Review, then a format: the headline Review left out stays hidden, and is named', () => {
    const { plan, data } = applied(reviewAd(), 'perfReview', 895, 1280)
    expect(layer(data.properties!, 't').visible).toBe(false)                 // Review hides the headline
    expect(plan.notPlaced).toContainEqual({ role: 'title', text: 'Run lighter.' })
    applyFramePreset(data, 'ad-300x600')
    expect(formatFor(data.properties!, 300, 600)?.id).toBe('ad-300x600')
    expect(layer(data.properties!, 't').visible).toBe(false)
    expect(layer(data.properties!, 't').layoutPrev.visible).toEqual({ was: null, set: false })
    expect(replan(data, 'perfReview').notPlaced.map(n => n.text)).toContain('Run lighter.')
  })

  it('Review on a format, then leaving it: the format\'s lines come back; the headline and the number Review left out stay hidden', () => {
    const { plan, data } = applied(reviewAd(), 'perfReview', 1280, 720, 'video-thumb')
    // Performance keeps the title and the number on a video thumbnail; the format hides the rest.
    expect(plan.format!.hidden).toEqual(['details', 'action', 'caption'])
    const hidden = (data.properties!.sailor_localLayers as any[]).filter(l => l.visible === false).map(l => l.id)
    expect(hidden).toEqual(['t', 'd', 'dt', 'a', 'c'])                        // Review leaves out the headline and the number
    applyFramePreset(data, '4:5')                                            // no format
    for (const id of ['d', 'a', 'c']) expect(layer(data.properties!, id), id).not.toHaveProperty('visible')
    for (const id of ['t', 'dt']) expect(layer(data.properties!, id).visible, id).toBe(false)
  })

  it('Strip, then a format: the details Strip left out stay hidden', () => {
    const layers = [t('t', 'Run lighter.', 0.12), t('d', 'Halden Trail 2', 0.04), t('dt', '–30%', 0.03), t('c', 'Offer ends 12 October.', 0.02), img()]
    const { plan, data } = applied(layers, 'perfStrip', 1200, 628, 'link-preview')
    expect(plan.notPlaced.map(n => n.role)).toContain('details')
    const ids = plan.notPlaced.map(n => (plan.layers as any[]).find(l => l.text === n.text)!.id)
    applyFramePreset(data, 'ad-970x250')                                     // carries 3: hides only the fine print
    for (const id of ids) expect(layer(data.properties!, id).visible, id).toBe(false)
  })

  it('a format-hidden date still comes back when leaving the format (as before)', () => {
    const lines = [t('t', 'Weather Report', 0.12), t('d', 'Ines Vollmer', 0.04), t('dt', '19.09.–15.11.2026', 0.03), t('c', 'Kunstraum Lenz', 0.02)]
    const props: Record<string, any> = { sailor_localLayers: lines, sailor_frame: { preset: 'video-thumb' } }
    const plan = planLayout({ props, frameW: 1280, frameH: 720, layoutId: 'statement', choice: { ...DEFAULT_CHOICE }, palette: pal, connectedSlots: [], measure: makeStubMeasure() })!
    props.sailor_localLayers = plan.layers
    props.sailor_posterState = plan.posterState
    const d = frameData(1280, 720, props)
    expect(layer(d.properties!, 'dt').visible).toBe(false)
    applyFramePreset(d, '4:5')
    expect(layer(d.properties!, 'dt')).not.toHaveProperty('visible')
  })
})
