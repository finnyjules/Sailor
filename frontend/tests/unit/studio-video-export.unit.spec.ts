import { describe, it, expect, vi } from 'vitest'
import { exportStudioVideo, videoErrorText } from '../../app/lib/studio/studioVideoExport'
import { publishVideo, HOSTED_UPLOAD_LIMIT } from '../../app/lib/engine/publishVideo'

const recorded = { blob: new Blob(['x'], { type: 'video/mp4' }), ext: 'mp4' as const, contentType: 'video/mp4', width: 4, height: 2 }
const base = {
  prefix: 'shader', width: 4, height: 2, fps: 30, frameCount: 3,
  drawFrame: () => {},
}

describe('exportStudioVideo', () => {
  it('records in the browser and publishes when asked', async () => {
    const publish = vi.fn(async () => 'shader_9.mp4')
    const r = await exportStudioVideo({ ...base, publish: true },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r).toEqual({ ext: 'mp4', blob: recorded.blob, filename: 'shader_9.mp4' })
    expect(publish).toHaveBeenCalledWith(recorded.blob, 'mp4', 'shader', undefined, undefined)
  })

  it('Cancel reaches the upload itself, so a cancelled upload leaves no file', async () => {
    const ac = new AbortController()
    const publish = vi.fn(async (_b: Blob, _e: string, _p: string, _f?: unknown, signal?: AbortSignal) => {
      ac.abort()
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return 'x.mp4'
    })
    await expect(exportStudioVideo({ ...base, publish: true, signal: ac.signal },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })).rejects.toThrow(/aborted/i)
    expect(publish.mock.calls[0]![4]).toBe(ac.signal)
  })

  it('a download-only export never uploads, and hands back the browser file', async () => {
    const publish = vi.fn()
    const r = await exportStudioVideo({ ...base, publish: false },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(r.filename).toBeNull()
    expect(r.blob).toBe(recorded.blob)
    expect(publish).not.toHaveBeenCalled()
  })

  // R10.4 (spec ruling 7): no server route. A browser that can't make the
  // video fails, and says why, locally exactly as in hosted.
  for (const hosted of [false, true]) {
    const where = hosted ? 'hosted' : 'local'

    it(`${where}: a browser that cannot record is a plain error, and nothing is recorded or uploaded`, async () => {
      const record = vi.fn(async () => recorded)
      const publish = vi.fn(async () => 'x.mp4')
      const err = await exportStudioVideo({ ...base, publish: true },
        { hosted, canRecord: async () => false, record, publish }).then(() => null, e => e)
      expect(err?.message).toBe("Video export failed: this browser can't record video.")
      expect(videoErrorText(err)).toBe("Video export failed: this browser can't record video.")
      expect(record).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    })

    it(`${where}: a recording that fails is a plain error, without the encoder text`, async () => {
      const publish = vi.fn(async () => 'x.mp4')
      const err = await exportStudioVideo({ ...base, publish: true },
        { hosted, canRecord: async () => true, record: async () => { throw new Error('EncodingError: encoder crashed') }, publish })
        .then(() => null, e => e)
      expect(err?.message).toBe("Video export failed: the browser's video encoder failed.")
      expect(videoErrorText(err)).toBe("Video export failed: the browser's video encoder failed.")
      expect(publish).not.toHaveBeenCalled()
    })
  }

  it('cancel is passed through as cancel', async () => {
    const abort = new DOMException('Export cancelled', 'AbortError')
    const err = await exportStudioVideo({ ...base, publish: true },
      { hosted: false, canRecord: async () => true, record: async () => { throw abort } }).then(() => null, e => e)
    expect(err).toBe(abort)
  })

  it('an upload failure after a good recording is that error', async () => {
    const err = await exportStudioVideo({ ...base, publish: true },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish: async () => { throw new Error('video upload failed (500)') } })
      .then(() => null, e => e)
    expect(err?.message).toBe('video upload failed (500)')
  })

  it('cancel during the upload rejects with AbortError, not a success', async () => {
    const ac = new AbortController()
    const publish = vi.fn(async () => { ac.abort(); return 'shader_9.mp4' })
    const err = await exportStudioVideo({ ...base, publish: true, signal: ac.signal },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish }).then(r => r, e => e)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(DOMException)
    expect(err.name).toBe('AbortError')
  })

  it('cancel after recording, before the upload, never uploads', async () => {
    const ac = new AbortController()
    const publish = vi.fn(async () => 'shader_9.mp4')
    const err = await exportStudioVideo({ ...base, publish: true, signal: ac.signal },
      { hosted: false, canRecord: async () => true, record: async () => { ac.abort(); return recorded }, publish }).then(r => r, e => e)
    expect(err?.name).toBe('AbortError')
    expect(publish).not.toHaveBeenCalled()
  })

  it('hosted: a video over the upload limit is refused before uploading', async () => {
    const big = { ...recorded, blob: { size: HOSTED_UPLOAD_LIMIT + 1, type: 'video/mp4' } as unknown as Blob }
    const publish = vi.fn(async () => 'shader_9.mp4')
    const err = await exportStudioVideo({ ...base, publish: true },
      { hosted: true, canRecord: async () => true, record: async () => big, publish }).then(() => null, e => e)
    expect(err?.message).toBe('This video is larger than 100 MB, the upload limit.')
    expect(publish).not.toHaveBeenCalled()
  })

  it('local: a video over the hosted limit still uploads', async () => {
    const big = { ...recorded, blob: { size: HOSTED_UPLOAD_LIMIT + 1, type: 'video/mp4' } as unknown as Blob }
    const publish = vi.fn(async () => 'shader_9.mp4')
    const r = await exportStudioVideo({ ...base, publish: true },
      { hosted: false, canRecord: async () => true, record: async () => big, publish })
    expect(r.filename).toBe('shader_9.mp4')
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("says 'Uploading…' once, right before the upload, and never on a download-only export", async () => {
    const order: string[] = []
    const onStatus = vi.fn((t: string) => { order.push(`status:${t}`) })
    const publish = vi.fn(async () => { order.push('publish'); return 'shader_9.mp4' })
    await exportStudioVideo({ ...base, publish: true, onStatus },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith('Uploading…')
    expect(order).toEqual(['status:Uploading…', 'publish'])

    const quiet = vi.fn()
    await exportStudioVideo({ ...base, publish: false, onStatus: quiet },
      { hosted: false, canRecord: async () => true, record: async () => recorded, publish })
    expect(quiet).not.toHaveBeenCalled()
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
