// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "enableJavaScriptEvaluation": true, "suppressInsecureJavaScriptEnvironmentWarning": true } }
/**
 * checkLiveEmbed — the export-time check that a live layer's player draws what the editor draws.
 * A fake source and a fake bundle (a tiny script assigning a stub __SAILOR_SURFACE__, run in the
 * check's own blank iframe exactly as a built bundle is). happy-dom has no 2D canvas, so a
 * picture here is an object carrying one grey level (`__v`), and the 2D context the check reads
 * pixels with is stubbed to paint that level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkLiveEmbed, liveCheckTimes, LIVE_CHECK_AT } from '~/lib/embed/frame/liveCheck'
import type { StudioEmbed, StudioFrameSource } from '~/lib/studio/frameSource'

const STUB_BUNDLE = `
window.__SAILOR_SURFACE__ = {
  kind: 'stub', caps: { alpha: false },
  async mount(container, cfg) {
    const log = cfg.log
    log.push('mount')
    if (cfg.throwOnMount) throw new Error('no WebGL here')
    if (cfg.hang) return new Promise(function () {})
    if (cfg.later) await cfg.later()
    const cv = document.createElement('canvas')
    container.appendChild(cv)
    return {
      setTime: function (t) { cv.__v = cfg.off != null && Math.abs(t - cfg.off) < 1e-9 ? 250 : Math.round(t * 100); log.push('time') },
      setSize: function (w, h) { cv.width = w; cv.height = h; log.push('size ' + w + 'x' + h) },
      destroy: function () { log.push('destroy') },
    }
  },
}`

function fakeSource(over: Partial<StudioFrameSource> = {}): StudioFrameSource & { getFrame: ReturnType<typeof vi.fn> } {
  return {
    duration: 6, fps: 30, width: 960, height: 540,
    getFrame: vi.fn(async (t01: number, w: number, h: number) => ({ width: w, height: h, __v: Math.round(t01 * 100) }) as unknown as TexImageSource),
    ...over,
  } as StudioFrameSource & { getFrame: ReturnType<typeof vi.fn> }
}

// The stub player logs into its config (the one object both documents share).
const embedOf = (config: Record<string, unknown> = {}, duration = 6): StudioEmbed =>
  ({ surface: 'stub', bundle: 'stub', config: { ...config, log }, width: 960, height: 540, duration })

let log: string[]
beforeEach(() => {
  log = []
  // The 2D context the check reads pixels through: paints the drawn picture's grey level.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const canvas = this
    let v = 0
    return {
      clearRect() { v = 0 },
      drawImage(img: { __v?: number }) { v = img.__v ?? 0 },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let p = 0; p < data.length; p += 4) { data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255 }
        expect([w, h]).toEqual([canvas.width, canvas.height])
        return { data }
      },
    } as unknown as CanvasRenderingContext2D
  } as any)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('liveCheckTimes', () => {
  it('lands on whole frames near 0, 0.37 and 0.71 of the loop', () => {
    expect(LIVE_CHECK_AT).toEqual([0, 0.37, 0.71])
    expect(liveCheckTimes(180)).toEqual([0, 67 / 180, 128 / 180])
    expect(liveCheckTimes(120)).toEqual([0, 44 / 120, 85 / 120])
    expect(liveCheckTimes(1)).toEqual([0, 0, 0])
  })
})

describe('checkLiveEmbed', () => {
  it('a player that draws what the source draws is ok — three frame-boundary times at 480 on the long side', async () => {
    const source = fakeSource()
    const r = await checkLiveEmbed(source, embedOf(), STUB_BUNDLE)
    expect(r).toEqual({ ok: true, diffs: [{ mean: 0, shareOver: 0 }, { mean: 0, shareOver: 0 }, { mean: 0, shareOver: 0 }] })
    expect(source.getFrame.mock.calls).toEqual([[0, 480, 270], [67 / 180, 480, 270], [128 / 180, 480, 270]])
    // Mounted with the config as is, THEN sized — how the Frame export builds its nested player.
    expect(log).toEqual(['mount', 'size 480x270', 'time', 'time', 'time', 'destroy'])
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  it('frames = round(fps × the embed\'s duration), loops included; a portrait source keeps its aspect', async () => {
    const source = fakeSource({ width: 540, height: 960 })
    const r = await checkLiveEmbed(source, embedOf({}, 12), STUB_BUNDLE)
    expect(r.ok).toBe(true)
    expect(source.getFrame.mock.calls).toEqual([[0, 270, 480], [133 / 360, 270, 480], [256 / 360, 270, 480]])
    expect(log).toContain('size 270x480')
  })

  it('one differing time is not ok, and carries that time\'s diff', async () => {
    const r = await checkLiveEmbed(fakeSource(), embedOf({ off: 67 / 180 }), STUB_BUNDLE)
    expect(r.ok).toBe(false)
    expect(r.diffs).toHaveLength(3)
    expect(r.diffs[0]).toEqual({ mean: 0, shareOver: 0 })
    expect(r.diffs[1]!.shareOver).toBe(1)
    expect(r.diffs[1]!.mean).toBe(250 - 37)
    expect(r.diffs[2]).toEqual({ mean: 0, shareOver: 0 })
    expect(r.reason).toMatch(/frame 67 of 180/)
    expect(log.at(-1)).toBe('destroy')
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  it('a mount that throws is not ok, and the iframe is removed', async () => {
    const r = await checkLiveEmbed(fakeSource(), embedOf({ throwOnMount: true }), STUB_BUNDLE)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no WebGL here/)
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  it('a mount that hangs is not ok after timeoutMs, and the iframe is removed', async () => {
    const t0 = Date.now()
    const r = await checkLiveEmbed(fakeSource(), embedOf({ hang: true }), STUB_BUNDLE, { timeoutMs: 60 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/timed out/)
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  it('a mount that lands after the timeout is destroyed at once', async () => {
    // The wait runs on this document's clock: a removed iframe's own timers never fire.
    const later = () => new Promise(res => setTimeout(res, 120))
    const r = await checkLiveEmbed(fakeSource(), embedOf({ later }), STUB_BUNDLE, { timeoutMs: 30 })
    expect(r.reason).toMatch(/timed out/)
    await new Promise(res => setTimeout(res, 250))
    expect(log).toEqual(['mount', 'destroy'])
  })

  it('a source pull that rejects is not ok, and nothing is mounted', async () => {
    const source = fakeSource({ getFrame: vi.fn(async () => { throw new Error('engine not ready') }) as any })
    const r = await checkLiveEmbed(source, embedOf(), STUB_BUNDLE)
    expect(r).toMatchObject({ ok: false, diffs: [] })
    expect(r.reason).toMatch(/engine not ready/)
    expect(log).toEqual([])
  })

  it('a bundle that defines no surface is not ok', async () => {
    const r = await checkLiveEmbed(fakeSource(), embedOf(), 'window.somethingElse = 1')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/surface/)
    expect(document.querySelectorAll('iframe').length).toBe(0)
  })

  it('waits for the document\'s fonts before its first pull of the source', async () => {
    let settle!: () => void
    const ready = new Promise<void>((r) => { settle = r })
    const had = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } })
    try {
      const source = fakeSource()
      const p = checkLiveEmbed(source, embedOf(), STUB_BUNDLE)
      await new Promise(r => setTimeout(r, 20))
      expect(source.getFrame).not.toHaveBeenCalled()
      settle()
      expect((await p).ok).toBe(true)
      expect(source.getFrame).toHaveBeenCalledTimes(3)
    } finally {
      if (had) Object.defineProperty(document, 'fonts', had)
      else delete (document as any).fonts
    }
  })
})
