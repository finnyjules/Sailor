import { describe, it, expect } from 'vitest'
import { FRAME_FORMATS, formatFor, keepKind, keepLabel, keepNote } from '~/lib/frame/formats'
import { FRAME_SIZE_PRESETS, framePresetId, applyFramePreset, type FrameSizeNodeData } from '~/lib/frame/frameSize'
import { PLAIN_SIZE_PRESETS } from '~/lib/frame/plainPresets'

describe('frame formats — the table', () => {
  it('has 16 entries', () => {
    expect(FRAME_FORMATS.length).toBe(16)
  })

  it('every label starts with a capital letter', () => {
    for (const f of FRAME_FORMATS) expect(f.label[0]).toMatch(/[A-Z]/)
  })

  it('spot-checks the table verbatim', () => {
    const metaStory = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    expect(metaStory.w).toBe(1080)
    expect(metaStory.h).toBe(1920)
    expect(metaStory.view).toBe(390)
    expect(metaStory.keep).toEqual({ top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 })
    expect(metaStory.platformButton).toBe(true)

    const pin9x16 = FRAME_FORMATS.find(f => f.id === 'pinterest-9x16')!
    expect(pin9x16.keep!.right).toBeCloseTo(195 / 1080, 9)
    expect(pin9x16.keep!.top).toBeCloseTo(270 / 1920, 9)
    expect(pin9x16.keep!.bottom).toBeCloseTo(440 / 1920, 9)
    expect(pin9x16.keep!.left).toBeCloseTo(65 / 1080, 9)

    const videoThumb = FRAME_FORMATS.find(f => f.id === 'video-thumb')!
    expect(videoThumb.carries).toBe(2)
    expect(videoThumb.w).toBe(1280)
    expect(videoThumb.h).toBe(720)
    expect(videoThumb.view).toBe(170)

    const ad728 = FRAME_FORMATS.find(f => f.id === 'ad-728x90')!
    expect(ad728.nc).toBe(24)
    expect(ad728.carries).toBe(3)
  })
})

describe('plainPresets — the one shared source of the six plain sizes', () => {
  it('FRAME_SIZE_PRESETS builds its first six directly from PLAIN_SIZE_PRESETS', () => {
    expect(FRAME_SIZE_PRESETS.slice(0, 6)).toEqual(PLAIN_SIZE_PRESETS)
  })

  it('formatFor\'s exclusion check reads the same six sizes: none of them exact-match a format', () => {
    for (const p of PLAIN_SIZE_PRESETS) {
      const byExactSize = FRAME_FORMATS.find(f => f.w === p.w && f.h === p.h)
      if (byExactSize) expect(formatFor(undefined, p.w, p.h)).toBeNull()
    }
  })
})

describe('formatFor — ruling P5', () => {
  it('stored preset whose aspect matches the Frame wins', () => {
    expect(formatFor({ sailor_frame: { preset: 'pinterest-9x16' } }, 1080, 1920)?.id).toBe('pinterest-9x16')
  })

  it('exact size, first match in table order, when no stored preset', () => {
    expect(formatFor(undefined, 1080, 1920)?.id).toBe('meta-story')
    expect(formatFor(undefined, 300, 250)?.id).toBe('ad-300x250')
  })

  it('stored preset also matches by exact size', () => {
    expect(formatFor({ sailor_frame: { preset: 'video-thumb' } }, 1280, 720)?.id).toBe('video-thumb')
  })

  it('null: the plain 16:9 preset size, aspect alone, mismatched stored preset, and every Stage 1 matrix frame', () => {
    expect(formatFor(undefined, 1280, 720)).toBeNull() // plain 16:9 preset's own size
    expect(formatFor(undefined, 540, 960)).toBeNull() // 9:16 aspect, not meta-story's exact size
    expect(formatFor(undefined, 600, 500)).toBeNull() // 1.2 aspect, not any format's exact size
    expect(formatFor({ sailor_frame: { preset: 'meta-story' } }, 1000, 1000)).toBeNull() // stored preset, aspect mismatch

    for (const [w, h] of [[895, 1280], [1080, 1080], [1280, 720], [1280, 400]] as const) {
      expect(formatFor(undefined, w, h)).toBeNull()
    }
  })
})

describe('FRAME_SIZE_PRESETS — gains the formats', () => {
  it('keeps the old six unchanged, in place, at the front', () => {
    expect(FRAME_SIZE_PRESETS.slice(0, 6)).toEqual([
      { id: '1:1', label: 'Square · 1:1', w: 1024, h: 1024 },
      { id: '16:9', label: 'Wide · 16:9', w: 1280, h: 720 },
      { id: '9:16', label: 'Tall · 9:16', w: 720, h: 1280 },
      { id: '4:5', label: 'Portrait · 4:5', w: 1024, h: 1280 },
      { id: '4:3', label: 'Classic · 4:3', w: 1024, h: 768 },
      { id: 'A4', label: 'A4 · print', w: 1240, h: 1754 },
    ])
  })

  it('has 22 entries total, one per format after the six', () => {
    expect(FRAME_SIZE_PRESETS.length).toBe(22)
  })

  it('framePresetId returns the first match — meta-story before pinterest disambiguation', () => {
    expect(framePresetId(1080, 1920)).toBe('meta-story')
  })

  it('applyFramePreset writes a format size', () => {
    const data: FrameSizeNodeData = {
      widgetDefs: [{ name: 'width' }, { name: 'height' }],
      widgetsValues: [0, 0],
      properties: {},
    }
    expect(applyFramePreset(data, 'ad-728x90')).toBe(true)
    expect(data.widgetsValues).toEqual([728, 90])
  })
})

// ── What the keep-clear areas are, in words (Stage 2, Task 8) ─────────────────────────────────
describe('keepKind / keepNote / keepLabel', () => {
  const fmt = (id: string) => FRAME_FORMATS.find(f => f.id === id)!

  it('Meta story: covered by the app, top and bottom (its 6% side margins are not named)', () => {
    expect(keepKind(fmt('meta-story'))).toBe('app')
    expect(keepNote(fmt('meta-story'))).toBe('The app covers the top and bottom of this format; text stays clear of them.')
    expect(keepLabel('app')).toBe('Covered by the app')
  })

  it('Pinterest idea pin: covered by the app, top, bottom and sides', () => {
    expect(keepKind(fmt('pinterest-9x16'))).toBe('app')
    expect(keepNote(fmt('pinterest-9x16'))).toBe('The app covers the top, bottom and sides of this format; text stays clear of them.')
  })

  it('Google display: may be cropped', () => {
    for (const id of ['pmax-landscape', 'pmax-square']) {
      expect(keepKind(fmt(id))).toBe('crop')
      expect(keepNote(fmt(id))).toBe('Google may crop the edges; text stays in the middle.')
    }
    expect(keepLabel('crop')).toBe('May be cropped')
  })

  it('a format without keep-clear areas, or none at all: null', () => {
    expect(keepKind(fmt('video-thumb'))).toBeNull()
    expect(keepNote(fmt('video-thumb'))).toBeNull()
    expect(keepKind(null)).toBeNull()
  })
})
