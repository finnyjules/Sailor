import { describe, it, expect, vi } from 'vitest'
import { recordTimeline, TimelineExportRefused, describeClip } from '../../app/lib/timeline/recordTimeline'

const S = (clips: any[], extra: any = {}) => ({
  version: 2, canvas: { width: 64, height: 36, fps: 30, bg_color: '#000000' }, transitions: [], total_frames: 0,
  tracks: [{ id: 'v', kind: 'video', name: 'V', muted: false, locked: false, clips }], ...extra,
}) as any
const img = (id: string, start: number, length: number) => ({ id, kind: 'image', asset_id: 'a', start_frame: start, in_frame: 0, length })

function fakes(opts: { inexact?: [string, string][]; failed?: [string, string][] } = {}) {
  const log: string[] = []
  const renderer = {
    loadWarnings: new Map(opts.failed ?? []), inexactClips: new Map(opts.inexact ?? []),
    load: vi.fn(async (_s: any, o: any) => { log.push('load'); expect(typeof o.resolve).toBe('function') }),
    renderFrame: vi.fn(async (i: number, target: any) => { log.push(`render ${i}`); target.frame = i }),
    dispose: vi.fn(() => log.push('dispose')),
  }
  const record = vi.fn(async (req: any) => {
    for (let i = 0; i < req.frameCount; i++) await req.drawFrame(i, { drawImage: (c: any) => log.push(`copy ${c.frame}`) })
    return { blob: new Blob(['v']), ext: 'mp4', contentType: 'video/mp4', width: req.width, height: req.height }
  })
  const buffer = { duration: 1 } as any
  const mixAudio = vi.fn(async () => { log.push('mix'); return { buffer, skipped: 1 } })
  return { log, renderer, record, mixAudio, buffer, createCanvas: () => ({}) as any }
}

describe('recordTimeline', () => {
  it('mixes, loads, records every frame of the timeline with the mix as sound, then disposes', async () => {
    const f = fakes()
    const phases: string[] = []
    const r = await recordTimeline(S([img('a', 0, 3)]), {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    }, { onPhase: p => phases.push(p) })
    expect(phases).toEqual(['mixing', 'rendering'])
    expect(f.record.mock.calls[0]![0]).toMatchObject({ width: 64, height: 36, fps: 30, frameCount: 3, audio: f.buffer })
    expect(f.log).toEqual(['mix', 'load', 'render 0', 'copy 0', 'render 1', 'copy 1', 'render 2', 'copy 2', 'dispose'])
    expect(r.skippedAudio).toBe(1)
  })

  it('refuses, by name, clips that can only be drawn ±1 frame or failed to load — and still disposes', async () => {
    const f = fakes({ inexact: [['v1', 'the file is larger than 96 MB']], failed: [['i2', 'fetch 404']] })
    const state = S([{ id: 'v1', kind: 'video', asset_id: 'a', start_frame: 120, in_frame: 0, length: 30 }, img('i2', 0, 30)])
    const err = await recordTimeline(state, {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    }).then(() => null, e => e)
    expect(err).toBeInstanceOf(TimelineExportRefused)
    expect(err.clips).toEqual(['the video clip at 4.0 s', 'the image clip at 0.0 s'])
    expect(err.message).toBe("These clips can't be drawn frame-exactly in the browser: the video clip at 4.0 s (the file is larger than 96 MB); the image clip at 0.0 s (fetch 404).")
    expect(f.record).not.toHaveBeenCalled()
    expect(f.log.at(-1)).toBe('dispose')
  })

  it('lists workflow clips with nothing to draw as skipped, like the server does', async () => {
    const f = fakes()
    const state = S([img('a', 0, 2), { id: 'w', kind: 'workflow', port_index: 0, start_frame: 30, in_frame: 0, length: 10 }])
    const r = await recordTimeline(state, {
      resolve: c => (c.kind === 'workflow' ? null : { url: 'u', kind: 'image' } as any), resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    })
    expect(r.skippedClips).toEqual(['the workflow clip at 1.0 s'])
  })

  it('no sound → no audio track asked for', async () => {
    const f = fakes()
    f.mixAudio.mockResolvedValueOnce({ buffer: null, skipped: 0 })
    await recordTimeline(S([img('a', 0, 1)]), {
      resolve: () => null, resolveAudioUrl: () => null,
      createRenderer: () => f.renderer as any, record: f.record as any, mixAudio: f.mixAudio as any, createCanvas: f.createCanvas,
    })
    expect(f.record.mock.calls[0]![0].audio).toBeUndefined()
  })

  it('describeClip speaks plainly', () => {
    expect(describeClip({ kind: 'lower_third', start_frame: 45 } as any, 30)).toBe('the lower third clip at 1.5 s')
  })
})
