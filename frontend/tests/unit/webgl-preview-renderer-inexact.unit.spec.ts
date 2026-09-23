import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../app/lib/engine/gl/glRenderer', () => ({
  GlRenderer: class { canvas = {}; clearSources() {} ; dispose() {} ; setSource() {} ; render() {} },
}))
vi.mock('../../app/lib/engine/sources/webCodecsSource', () => {
  class UnsupportedSourceError extends Error {}
  return {
    UnsupportedSourceError,
    WebCodecsSource: { load: vi.fn(async (url: string) => {
      if (url.includes('odd')) throw new UnsupportedSourceError('no decoder')
      return { width: 1, height: 1, getFrame: async () => ({}), dispose() {} }
    }) },
  }
})
vi.mock('../../app/lib/engine/sources/videoElementSource', () => ({
  VideoElementSource: { load: vi.fn(async () => ({ width: 1, height: 1, getFrame: async () => ({}), dispose() {} })) },
}))

import { WebGLPreviewRenderer } from '../../app/lib/engine/webglPreviewRenderer'

const state = (paths: string[]) => ({
  version: 2, canvas: { width: 10, height: 10, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0,
  tracks: [{ id: 'v', kind: 'video', name: 'V', muted: false, locked: false,
    clips: paths.map((p, i) => ({ id: `c${i}`, kind: 'video', asset_id: 'x', path: p, start_frame: i * 10, in_frame: 0, length: 10 })) }],
}) as any

describe('WebGLPreviewRenderer.inexactClips', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, headers: { get: () => (url.includes('huge') ? String(200 * 1024 * 1024) : '1000') } })))
  })

  it('names the clips that fell back to the ±1-frame source, and why', async () => {
    const r = new WebGLPreviewRenderer()
    await r.load(state(['/view?filename=a.mp4', '/view?filename=huge.mp4', '/view?filename=odd.mov']))
    expect([...r.inexactClips.keys()].sort()).toEqual(['c1', 'c2'])
    expect(r.inexactClips.get('c1')).toBe('the file is larger than 96 MB')
    expect(r.inexactClips.get('c2')).toBe('this browser cannot decode its format frame by frame')
  })

  it('is cleared on the next load', async () => {
    const r = new WebGLPreviewRenderer()
    await r.load(state(['/view?filename=huge.mp4']))
    await r.load(state(['/view?filename=a.mp4']))
    expect(r.inexactClips.size).toBe(0)
  })
})
