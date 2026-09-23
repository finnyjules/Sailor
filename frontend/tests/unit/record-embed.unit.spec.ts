import { describe, it, expect, vi } from 'vitest'
import { recordEmbed } from '../../app/lib/engine/recordEmbed'

function fakeSurface(alpha = false, hasCanvas = true) {
  const log: string[] = []
  const canvas = { tagName: 'CANVAS' } as any
  const container: any = { querySelector: (s: string) => (s === 'canvas' && hasCanvas ? canvas : null) }
  const surface = {
    kind: 'fake', caps: { alpha },
    async mount(el: any, cfg: any) {
      log.push(`mount ${cfg.id}`); expect(el).toBe(container)
      return { setTime: (t: number) => log.push(`t ${t}`), setSize: (w: number, h: number) => log.push(`size ${w}x${h}`), destroy: () => log.push('destroy') }
    },
  }
  return { surface, container, canvas, log }
}

describe('recordEmbed', () => {
  it('mounts once, sizes, sets each frame time (normalized) and copies the canvas right after, then destroys', async () => {
    const { surface, container, canvas, log } = fakeSurface()
    const drawn: any[] = []
    const record = vi.fn(async (req: any) => {
      for (let i = 0; i < req.frameCount; i++) {
        await req.drawFrame(i, { drawImage: (c: any, x: number, y: number, w: number, h: number) => { drawn.push([c, w, h]); log.push(`copy ${i}`) } })
      }
      return { blob: new Blob(['v']), ext: 'mp4', contentType: 'video/mp4', width: req.width, height: req.height } as any
    })
    const r = await recordEmbed(surface as any, { id: 'c' }, { width: 64, height: 32, fps: 4, duration: 1 }, { record, container: () => container })
    expect(r.ext).toBe('mp4')
    expect(record.mock.calls[0]![0]).toMatchObject({ width: 64, height: 32, fps: 4, frameCount: 4, alpha: false })
    expect(log).toEqual(['mount c', 'size 64x32', 't 0', 'copy 0', 't 0.25', 'copy 1', 't 0.5', 'copy 2', 't 0.75', 'copy 3', 'destroy'])
    expect(drawn.every(([c, w, h]) => c === canvas && w === 64 && h === 32)).toBe(true)
  })

  it('transparency only when both asked for and the surface really has it', async () => {
    const record = vi.fn(async () => ({ blob: new Blob([]), ext: 'webm' }) as any)
    const a = fakeSurface(true)
    await recordEmbed(a.surface as any, { id: 'a' }, { width: 2, height: 2, fps: 1, duration: 1, alpha: true }, { record, container: () => a.container })
    const b = fakeSurface(false)
    await recordEmbed(b.surface as any, { id: 'b' }, { width: 2, height: 2, fps: 1, duration: 1, alpha: true }, { record, container: () => b.container })
    expect(record.mock.calls.map((c: any) => c[0].alpha)).toEqual([true, false])
  })

  it('destroys the surface even when recording fails', async () => {
    const { surface, container, log } = fakeSurface()
    const err = await recordEmbed(surface as any, { id: 'x' }, { width: 2, height: 2, fps: 1, duration: 1 }, {
      record: async () => { throw new Error('boom') }, container: () => container,
    }).then(() => null, e => e)
    expect(err?.message).toBe('boom')
    expect(log.at(-1)).toBe('destroy')
  })

  it('a surface that mounts no canvas is an error', async () => {
    // fakeSurface's own mount() asserts it was handed the same container the
    // deps factory returns (see the first test) — so the container that draws
    // no canvas has to be that SAME reference, not an unrelated stand-in.
    const { surface, container } = fakeSurface(false, false)
    const record = vi.fn(async (req: any) => { await req.drawFrame(0, { drawImage: () => {} }); return {} as any })
    await expect(recordEmbed(surface as any, { id: 'e' }, { width: 2, height: 2, fps: 1, duration: 1 }, { record, container: () => container }))
      .rejects.toThrow('embed surface drew no canvas')
  })
})
