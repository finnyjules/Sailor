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
  FRAME_SIZE_PRESETS, applyFramePreset, designSizeForAspect, framePresetId, readFrameSize,
  setFrameDim, setFrameResponsive, type FrameSizeNodeData,
} from '~/lib/frame/frameSize'
import { isResponsiveFrame } from '~/lib/frame/responsive'

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
  it('keeps the node header presets', () => {
    expect(FRAME_SIZE_PRESETS.map(p => p.id)).toEqual(['1:1', '16:9', '9:16', '4:5', '4:3', 'A4'])
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
