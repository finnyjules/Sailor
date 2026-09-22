import { describe, it, expect, vi } from 'vitest'
import { exportStudioVideo, resultBlob, videoErrorText } from '../../app/lib/studio/studioVideoExport'
import { publishVideo } from '../../app/lib/engine/publishVideo'

const recorded = { blob: new Blob(['x'], { type: 'video/mp4' }), ext: 'mp4' as const, contentType: 'video/mp4', width: 4, height: 2 }
const base = {
  prefix: 'shader', width: 4, height: 2, fps: 30, frameCount: 3,
  drawFrame: () => {},
}
const server = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))

describe('exportStudioVideo', () => {
  it('records in the browser and publishes when asked', async () => {
    const publish = vi.fn(async () => 'shader_9.mp4')
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r).toEqual({ ext: 'mp4', blob: recorded.blob, filename: 'shader_9.mp4', via: 'browser', notice: null })
    expect(publish).toHaveBeenCalledWith(recorded.blob, 'mp4', 'shader')
  })

  it('a download-only export never uploads', async () => {
    const publish = vi.fn()
    const r = await exportStudioVideo({ ...base, publish: false, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r?.filename).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })

  it('local: a browser that cannot record falls back to the server, and says so', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => false, record: async () => { throw new Error('not called') } })
    expect(r?.via).toBe('server')
    expect(r?.filename).toBe('spacetype_1.mp4')
    expect(r?.blob).toBeNull()
    expect(r?.notice).toBe("Made on the server, because this browser can't record video.")
  })

  it('local: a recording that fails falls back to the server, and says why', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, canRecord: async () => true, record: async () => { throw new Error('encoder crashed') } })
    expect(r?.via).toBe('server')
    expect(r?.notice).toBe('Made on the server, because the browser could not record it (encoder crashed).')
  })

  it('hosted: no server fallback — a clear error instead', async () => {
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: true, canRecord: async () => false }).then(() => null, e => e)
    expect(err?.message).toBe("Video export failed: this browser can't record video.")
  })

  it('cancel is never turned into a fallback', async () => {
    const abort = new DOMException('Export cancelled', 'AbortError')
    const fallback = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: fallback },
      { hosted: false, canRecord: async () => true, record: async () => { throw abort } }).then(() => null, e => e)
    expect(err).toBe(abort)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('an upload failure after a good recording is an error, not a fallback', async () => {
    const fallback = vi.fn(async () => ({ filename: 'spacetype_1.mp4', ext: 'mp4' as const }))
    const err = await exportStudioVideo({ ...base, publish: true, serverFallback: fallback },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish: async () => { throw new Error('video upload failed (500)') } })
      .then(() => null, e => e)
    expect(err?.message).toBe('video upload failed (500)')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('the server switch skips the browser in local mode, and says so; hosted ignores it', async () => {
    const record = vi.fn(async () => recorded)
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: server },
      { hosted: false, forceServer: true, canRecord: async () => true, record })
    expect(r?.via).toBe('server')
    expect(r?.notice).toBe('Made on the server (browser recording is switched off).')
    expect(record).not.toHaveBeenCalled()
    const h = await exportStudioVideo({ ...base, publish: false, serverFallback: server },
      { hosted: true, forceServer: true, canRecord: async () => true, record })
    expect(h?.via).toBe('browser')
  })

  it('a fallback that makes nothing returns null', async () => {
    const r = await exportStudioVideo({ ...base, publish: true, serverFallback: async () => null },
      { hosted: false, canRecord: async () => false })
    expect(r).toBeNull()
  })
})

describe('resultBlob', () => {
  it('uses the browser blob, or fetches the server file', async () => {
    const b = new Blob(['y'])
    expect(await resultBlob({ ext: 'mp4', blob: b, filename: null, via: 'browser', notice: null })).toBe(b)
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => b })) as any
    expect(await resultBlob({ ext: 'mp4', blob: null, filename: 'a b.mp4', via: 'server', notice: null }, fetchImpl)).toBe(b)
    expect(fetchImpl).toHaveBeenCalledWith('/view?filename=a+b.mp4&type=input')
  })
})

describe('videoErrorText', () => {
  it('passes our own plain messages through and hides internals', () => {
    expect(videoErrorText(new Error("Video export failed: this browser can't record video."))).toBe("Video export failed: this browser can't record video.")
    expect(videoErrorText(new Error('This video is larger than 100 MB, the upload limit.'))).toBe('This video is larger than 100 MB, the upload limit.')
    expect(videoErrorText(new Error('TypeError: x is undefined'))).toBe('Video export failed — see console.')
  })
})

describe('publishVideo', () => {
  it('uploads one file under a unique name, without overwrite', async () => {
    let sent: FormData | null = null
    const fetchImpl = vi.fn(async (_u: string, init: any) => { sent = init.body; return { ok: true, status: 200, json: async () => ({ name: 'shader_1.mp4', subfolder: '' }) } }) as any
    const name = await publishVideo(new Blob(['v'], { type: 'video/mp4' }), 'mp4', 'shader', fetchImpl)
    expect(name).toBe('shader_1.mp4')
    expect(fetchImpl.mock.calls[0][0]).toBe('/upload/image')
    const file = sent!.get('image') as File
    expect(file.name).toMatch(/^shader_\d+\.mp4$/)
    expect(file.type).toBe('video/mp4')
    expect(sent!.has('overwrite')).toBe(false)
  })

  it('keeps a subfolder, and explains the 100 MB limit', async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: 'v.webm', subfolder: 'sub' }) })) as any
    expect(await publishVideo(new Blob(['v']), 'webm', 'x', ok)).toBe('sub/v.webm')
    const big = vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) })) as any
    await expect(publishVideo(new Blob(['v']), 'mp4', 'x', big)).rejects.toThrow('This video is larger than 100 MB, the upload limit.')
  })
})
