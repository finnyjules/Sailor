import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDrawList, hexToRgb } from '../../app/lib/engine/compositor'
import { migrateEditState } from '../../shared/timeline/types'
import { createSpaceTypeClip } from '../../app/composables/timelineSpaceTypeClip'
import { defaultSpaceTypeState } from '../../app/lib/spacetype/state'

const fixturesDir = fileURLToPath(new URL('../../../tests-unit/timeline_fixtures', import.meta.url))

function loadFixture(name: string) {
  const state = migrateEditState(JSON.parse(readFileSync(`${fixturesDir}/${name}`, 'utf-8')))!
  // All fixture assets are 320×180 (see tests-unit/timeline_fixtures/generate_assets.py).
  const dims = new Map<string, { w: number; h: number }>()
  for (const track of state.tracks) for (const clip of track.clips) {
    if ('path' in clip && clip.path) dims.set(clip.id, { w: 320, h: 180 })
  }
  return { state, dims }
}

describe('hexToRgb', () => {
  it('parses #rrggbb to floats', () => {
    expect(hexToRgb('#336699')).toEqual([0x33 / 255, 0x66 / 255, 0x99 / 255])
    expect(hexToRgb('#000000')).toEqual([0, 0, 0])
    expect(hexToRgb('garbage')).toEqual([0, 0, 0]) // fallback, mirrors _hex_rgb_safe
  })
})

describe('buildDrawList — fixture 03 (fades, stacking, muted)', () => {
  const { state, dims } = loadFixture('03-fades-stack.json')

  it('frame 3: only f1, mid fade-in (fade 3/6 = 0.5)', () => {
    const list = buildDrawList(state, 3, dims)
    expect(list.map(e => e.clipId)).toEqual(['f1'])
    expect(list[0]!.alpha).toBeCloseTo(0.5, 10)
  })

  it('frame 6: f1 fully faded in; f2 mid fade-in → alpha 0.5 * opacity 0.9 = 0.45', () => {
    const list = buildDrawList(state, 6, dims)
    expect(list.map(e => e.clipId)).toEqual(['f1', 'f2'])
    expect(list[0]!.alpha).toBeCloseTo(1.0, 10)
    expect(list[1]!.alpha).toBeCloseTo(0.45, 10)
  })

  it('frame 8: f2 past its fade-in window (local 4, fade_in 4 → no fade) → alpha 0.9', () => {
    const list = buildDrawList(state, 8, dims)
    expect(list[1]!.alpha).toBeCloseTo(0.9, 10)
  })

  it('frame 21: f1 fading out ((24-21)/6 = 0.5); f2 ended; f3 active; muted f4 NEVER appears', () => {
    const list = buildDrawList(state, 21, dims)
    expect(list.map(e => e.clipId)).toEqual(['f1', 'f3'])
    expect(list[0]!.alpha).toBeCloseTo(0.5, 10)
    expect(list[1]!.alpha).toBeCloseTo(1.0, 10)
  })

  it('quantizes size/center exactly like the Python renderer (f2: 16:9 source on 16:9 canvas)', () => {
    // gradient_b 320×180 on 640×360: same aspect → fit 640×360; scale 0.55 →
    // round(640*0.55)=352, round(360*0.55)=198; center 320+round(0.1*640)=384,
    // 180+round(0.1*360)=216 (mirrors _transform_and_alpha + paste math).
    const e = buildDrawList(state, 8, dims).find(x => x.clipId === 'f2')!
    expect(e.widthPx).toBe(352)
    expect(e.heightPx).toBe(198)
    expect(e.centerX).toBe(384)
    expect(e.centerY).toBe(216)
    expect(e.rotationDeg).toBe(0)
  })
})

describe('buildDrawList — fixture 02 (keyframed transforms)', () => {
  const { state, dims } = loadFixture('02-keyframes.json')

  it('frame 12: k1 keyframe hit exactly (x 0, y 0, rot 180, scale 0.6, opacity 1)', () => {
    const e = buildDrawList(state, 12, dims).find(x => x.clipId === 'k1')!
    expect(e.rotationDeg).toBeCloseTo(180, 10)
    expect(e.alpha).toBeCloseTo(1.0, 10)
    expect(e.widthPx).toBe(Math.round(640 * 0.6))
    expect(e.centerX).toBe(320)
  })

  it('frame 0: k1 first keyframe (opacity 0.2, scale 0.3, x -0.3 → center 320-192=128)', () => {
    const e = buildDrawList(state, 0, dims).find(x => x.clipId === 'k1')!
    expect(e.alpha).toBeCloseTo(0.2, 10)
    expect(e.widthPx).toBe(Math.round(640 * 0.3))
    expect(e.centerX).toBe(128)
  })
})

describe('buildDrawList — fixture 01 (blends, time window)', () => {
  const { state, dims } = loadFixture('01-static-blends.json')

  it('frame 0: c6 (add, starts frame 6) absent; order = track clip order', () => {
    expect(buildDrawList(state, 0, dims).map(e => e.clipId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('frame 12: all six, blend modes carried through', () => {
    const list = buildDrawList(state, 12, dims)
    expect(list.map(e => e.blend)).toEqual(['normal', 'multiply', 'screen', 'overlay', 'difference', 'add'])
  })
})

describe('pyRound parity', () => {
  it('hexToRgb expands 3-digit shorthand like _hex_rgb', () => {
    expect(hexToRgb('#fff')).toEqual([1, 1, 1])
    expect(hexToRgb('#abc')).toEqual([0xaa / 255, 0xbb / 255, 0xcc / 255])
  })

  it('quantizes .5 cases half-to-even like Python round()', () => {
    // 1080×1920 portrait on 640×360: fit_w = 360 * (1080/1920) = 202.5 → 202 (even), not 203.
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 10, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'p', kind: 'image', asset_id: 'p', path: 'x.png', start_frame: 0, in_frame: 0, length: 10 },
      ] }],
    })!
    const dims = new Map([['p', { w: 1080, h: 1920 }]])
    const e = buildDrawList(state, 0, dims)[0]!
    expect(e.widthPx).toBe(202)
    expect(e.heightPx).toBe(360)
  })
})

describe('buildDrawList — sourceFrame threading', () => {
  it('computes sourceFrame from in_frame/speed/reverse', () => {
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'v', kind: 'video', asset_id: 'v', path: 'v.mp4', start_frame: 2, in_frame: 3, length: 10, speed: 2, reverse: false },
      ] }],
    })!
    const dims = new Map([['v', { w: 64, h: 64 }]])
    const e = buildDrawList(state, 6, dims)[0]!   // localF = 4
    expect(e.sourceFrame).toBe(3 + 8)             // in_frame 3 + floor(4*2)
  })
})

describe('buildDrawList — title/lower_third admission', () => {
  it('admits title clips with registered dims as full-canvas entries', () => {
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'ttl', kind: 'title', start_frame: 0, in_frame: 0, length: 20, opacity: 0.9,
          title: { text: 'Hi', font_family: 'Inter', font_weight: 700, font_size: 0.1,
                   color: '#fff', animation_in: 'stagger-up', animation_out: 'fade-out-up',
                   hold_frames: 10, stagger: 0.05, ease: 'power2.out' } },
      ] }],
    })!
    // Renderer registers the CANVAS size as the title source's dims.
    const dims = new Map([['ttl', { w: 640, h: 360 }]])
    const e = buildDrawList(state, 5, dims)[0]!
    expect(e.clipId).toBe('ttl')
    expect(e.widthPx).toBe(640)    // full canvas (same aspect → exact fit)
    expect(e.heightPx).toBe(360)
    expect(e.centerX).toBe(320)
    expect(e.alpha).toBeCloseTo(0.9, 10)
    expect(e.sourceFrame).toBe(5)
  })

  it('still skips unsupported kinds', () => {
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'wf', kind: 'workflow', start_frame: 0, in_frame: 0, length: 20, port_index: 0 },
      ] }],
    })!
    expect(buildDrawList(state, 5, new Map())).toEqual([])
  })
})

describe('buildDrawList — plain text admission', () => {
  // Task 2 (browser video export): the preview now draws plain 'text' clips
  // (TextCanvasSource), so 'text' is a RENDERABLE_KIND like 'title' above —
  // this replaces the old "text is Phase 2/3, always skipped" assertion.
  it('admits text clips with registered dims as full-canvas entries', () => {
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'txt', kind: 'text', start_frame: 0, in_frame: 0, length: 20,
          text: { text: 'x', font_size: 72, color: '#fff', bg_color: '#000', align: 'center', v_align: 'middle', padding: 0.06, line_spacing: 1.2 } },
      ] }],
    })!
    // Renderer registers the CANVAS size as the text source's dims (same as title).
    const dims = new Map([['txt', { w: 640, h: 360 }]])
    const list = buildDrawList(state, 5, dims)
    expect(list.map(e => e.clipId)).toEqual(['txt'])
  })

  it('still skips text clips with no registered dims', () => {
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [
        { id: 'txt', kind: 'text', start_frame: 0, in_frame: 0, length: 20,
          text: { text: 'x', font_size: 72, color: '#fff', bg_color: '#000', align: 'center', v_align: 'middle', padding: 0.06, line_spacing: 1.2 } },
      ] }],
    })!
    expect(buildDrawList(state, 5, new Map())).toEqual([])
  })
})

describe('buildDrawList — spacetype admission', () => {
  // Regression guard: RENDERABLE_KINDS in compositor.ts must include 'spacetype', or a
  // Space Type timeline clip loads its source fine and silently renders nothing. This
  // clip has a dims entry registered (unlike the 'still skips unsupported kinds' case
  // above), so the ONLY thing that can exclude it from the draw list is the kind check —
  // an empty result here can only mean RENDERABLE_KINDS regressed.
  it('admits spacetype clips with registered dims', () => {
    const spacetypeClip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    const state = migrateEditState({
      version: 2,
      canvas: { width: 640, height: 360, fps: 30, bg_color: '#000000' },
      total_frames: 20, transitions: [],
      tracks: [{ id: 't', kind: 'video', name: 'V', muted: false, locked: false, clips: [spacetypeClip] }],
    })!
    const dims = new Map([[spacetypeClip.id, { w: 960, h: 540 }]]) // matches defaultSpaceTypeState's dimsKey
    const list = buildDrawList(state, 0, dims)
    expect(list.map(e => e.clipId)).toEqual([spacetypeClip.id])
  })
})
