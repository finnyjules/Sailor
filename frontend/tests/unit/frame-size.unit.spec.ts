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
