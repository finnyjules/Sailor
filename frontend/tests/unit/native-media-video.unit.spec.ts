/**
 * Task R5.6 (step 3): the Timeline's video thumbnails, sound waveforms and the
 * asset-import probe answered by Sailor's own server with its media tools
 * (server/media/thumbnails.ts, wired in server/native/media.ts), with no
 * family: on as soon as the tools are ready, exactly as before without them.
 *
 * Parity is against fixtures from the REAL handlers of
 * comfy_extras/nodes_timeline.py (`_probe_media`, `_gen_thumbnails`,
 * `_gen_waveform_peaks`, lifted with `ast`) run over the standard clips:
 * scripts/runner_media_fixtures.py --group timeline-media. Those specs need
 * the real build (`requireMediaTools`, never a skip). The machinery specs
 * (tools missing, the hosted gate, a hanging decode) use a fake tools folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import type { MediaTools } from '~~/server/media/tools'

// 'real': the build on this machine; 'none': the tools missing; 'fake': shell scripts (machinery tests).
const tools = vi.hoisted(() => ({ mode: 'real' as 'real' | 'none' | 'fake', fake: null as MediaTools | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return {
    ...real,
    mediaTools: async () => (tools.mode === 'real' ? real.mediaTools() : tools.mode === 'fake' ? tools.fake : null),
  }
})
// The hosted gate's own checks (engineGate.ts): which mode, and a cached engine-health state that never reaches :8188.
const deploy = vi.hoisted(() => ({ mode: 'local' as 'local' | 'hosted' }))
vi.mock('~~/server/utils/deployMode', () => ({ deployMode: () => deploy.mode, isHosted: () => deploy.mode === 'hosted' }))
vi.mock('~~/server/native/engineHealth', async orig => ({ ...(await orig() as object), engineHealth: async () => 'down' as const }))

const g = globalThis as any
g.defineEventHandler ??= (fn: unknown) => fn
g.createError ??= (o: { statusCode: number, message?: string }) => Object.assign(new Error(o.message), { statusCode: o.statusCode })

const M = await import('~~/server/native/media')
const { pyDumps } = await import('~~/server/native/pyJson')
const T = await import('~~/server/media/thumbnails')
const { checkArgs, mediaLimiter } = await import('~~/server/media/run')
const { CLIP_ROOTS, clipPath, requireMediaTools, sha256Hex, unz } = await import('./__runner__/mediaParity')
const { handleHostedSailorData, SAILOR_ASSET_KIND } = await import('~~/server/utils/engineGate')
const { __setResourceOwnersDbForTests } = await import('~~/server/utils/resourceOwners')

// ── the fixtures ─────────────────────────────────────────────────────────────

interface ProbeInfoPy { kind: string, duration_sec: number | null, width: number | null, height: number | null }
interface ThumbPy { mode: string, w: number, h: number, sha256: string }
interface Pick { target: number, pts: number, ranOut: boolean, sha256: string }
interface TimelineFixture {
  clips: Record<string, string>
  cases: {
    groupClips: Record<string, string>
    probe: { clip: string, info: ProbeInfoPy }[]
    thumbnails: { clip: string, count: number, thumbnails: ThumbPy[], picks: Pick[] | { error: string } }[]
    waveforms: { clip: string, buckets: number, count: number, sha256: string, textz: string }[]
  }
}
const FIXTURE = fileURLToPath(new URL('./fixtures/runner-media-timeline-media.json', import.meta.url))
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as TimelineFixture
const pyText = (textz: string) => Buffer.from(unz(textz)).toString('ascii')
/**
 * R5.1b's one named not-exact decode: Opus puts some samples a last bit
 * (≤ 2⁻²⁴) from PyAV's wheel, so a few of its peaks (a sample divided by the
 * peak) land a float32 step away. Measured on this build: which cases, how
 * many peaks, and the largest difference.
 */
const OPUS_ULP = new Set(['a_opus.webm'])
const OPUS_INEXACT = ['a_opus.webm / 256', 'a_opus.webm / 2048']
/** 5 of the 2,320 Opus peaks, each one float32 step (2⁻²³ below 1) from Python's. */
const OPUS_PEAKS_APART = 5
const OPUS_PEAK_BOUND = 2 ** -23

/** The native reader over the standard clips' folder. */
const clipsNative = () => T.nativeMedia({ roots: CLIP_ROOTS, userId: null })

/** A PNG's decoded pixels, as the fixture records PIL's. */
async function pngPixels(png: Buffer): Promise<{ mode: string, w: number, h: number, sha256: string }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { mode: info.channels === 3 ? 'RGB' : `channels ${info.channels}`, w: info.width, h: info.height, sha256: sha256Hex(data) }
}
const fromDataUrl = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')

// ── a temp engine root per test ──────────────────────────────────────────────

let root: string
let input: string
let user: string
beforeEach(() => {
  tools.mode = 'real'
  tools.fake = null
  deploy.mode = 'local'
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-media-video-')))
  input = join(root, 'input')
  user = join(root, 'user')
  for (const d of [input, user, join(root, 'output')]) mkdirSync(d)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

function addClip(clip: string, as = clip): string {
  const p = join(input, as)
  copyFileSync(clipPath(clip), p)
  return p
}
function writeAssets(assets: unknown[]): void {
  writeFileSync(join(user, 'timeline_assets.json'), JSON.stringify(assets, null, 2))
}
const thumbsDir = () => join(user, 'timeline_thumbs')
const cached = () => (existsSync(thumbsDir()) ? readdirSync(thumbsDir()).sort() : [])
/** The reader the routes get locally (Python reads any path). */
const localNative = () => T.nativeMedia({ roots: ['/'], userId: null })

// ── parity ───────────────────────────────────────────────────────────────────

describe('parity with the Python handlers (timeline-media fixtures)', () => {
  it('the fixtures were written from the clips on disk', () => {
    for (const [name, sha] of Object.entries({ ...fx.clips, ...fx.cases.groupClips })) {
      expect(sha256Hex(readFileSync(clipPath(name))), name).toBe(sha)
    }
  })

  it('_probe_media: kind, duration, width and height of every clip (and nulls for an unreadable one)', async () => {
    await requireMediaTools()
    const native = clipsNative()
    for (const c of fx.cases.probe) {
      expect(await M.probeMediaNative(clipPath(c.clip), native), c.clip).toEqual(c.info)
    }
  })

  it('_gen_thumbnails at 1, 5 and 20: the same frames, resized the same, pixel for pixel', async () => {
    await requireMediaTools()
    const opts = { roots: CLIP_ROOTS, userId: null }
    for (const c of fx.cases.thumbnails) {
      const r = await T.videoThumbnails(clipPath(c.clip), c.count, opts)
      const got = await Promise.all(r.pngs.map(pngPixels))
      expect(got, `${c.clip} × ${c.count}`).toEqual(c.thumbnails)
      expect(r.cache, `${c.clip} × ${c.count}`).toBe(true)
    }
  }, 240_000)

  it('_gen_waveform_peaks at 16, 256 and 2048: the cache file\'s JSON text, byte for byte (Opus: within its named last bit)', async () => {
    await requireMediaTools()
    const opts = { roots: CLIP_ROOTS, userId: null }
    const inexact: string[] = []
    let opusWorst = 0
    let opusApart = 0
    for (const c of fx.cases.waveforms) {
      const label = `${c.clip} / ${c.buckets}`
      const r = await T.waveformPeaks(clipPath(c.clip), c.buckets, opts)
      expect(r.peaks.length, label).toBe(c.count)
      expect(r.cache, label).toBe(true)
      const text = M.waveformJson({ peaks: r.peaks, asset_id: 'A', buckets: c.buckets })
      if (text === pyText(c.textz)) continue
      inexact.push(label)
      // R5.1b's named case: FFmpeg's float Opus decoder puts some samples a last bit (≤ 2⁻²⁴) from PyAV's wheel.
      expect(OPUS_ULP.has(c.clip), `${label} must be exact`).toBe(true)
      const want = (JSON.parse(pyText(c.textz)) as { peaks: number[] }).peaks
      r.peaks.forEach((x, i) => {
        opusWorst = Math.max(opusWorst, Math.abs(x - want[i]!))
        if (x !== want[i]) opusApart++
      })
    }
    expect(inexact).toEqual(OPUS_INEXACT)
    expect(opusApart).toBe(OPUS_PEAKS_APART)
    expect(opusWorst).toBe(OPUS_PEAK_BOUND)
  }, 240_000)
})

// ── the routes, with the tools and ComfyUI down ──────────────────────────────

describe('the routes answer from Sailor when the tools are ready (the engine never asked)', () => {
  const thumbCase = (clip: string, count: number) => fx.cases.thumbnails.find(c => c.clip === clip && c.count === count)!
  const waveCase = (clip: string, buckets: number) => fx.cases.waveforms.find(c => c.clip === clip && c.buckets === buckets)!

  it('input_thumbnail: a video gives its PNG, cached under Python\'s name; a sound 404s and caches nothing', async () => {
    await requireMediaTools()
    addClip('g_thumbs_gop.mp4', 'clip.mp4')
    addClip('a_s16.wav', 'tone.wav')
    const engine = vi.fn(async () => null)
    const r = await M.inputThumbnailRoute(user, input, 'clip.mp4', engine, localNative())
    expect(r.status).toBe(200)
    expect(r.headers).toEqual({ 'content-type': 'image/png', 'cache-control': 'max-age=86400' })
    expect(await pngPixels(r.body as Buffer)).toEqual(thumbCase('g_thumbs_gop.mp4', 1).thumbnails[0])
    const st = statSync(join(input, 'clip.mp4'), { bigint: true })
    expect(cached()).toEqual([M.inputThumbName('clip.mp4', M.pyMtime(st))])

    const a = await M.inputThumbnailRoute(user, input, 'tone.wav', engine, localNative())
    expect([a.status, a.body]).toEqual([404, ''])
    expect(cached()).toHaveLength(1)
    expect(engine).not.toHaveBeenCalled()
  })

  it('asset_thumbnails: Python\'s shape and cache file; a file no reader opens gives [] (cached), not the engine', async () => {
    await requireMediaTools()
    const clip = addClip('v_vfr.mp4')
    const junk = addClip('g_timeline_junk.mp4')
    writeAssets([{ id: 'vid', path: clip, kind: 'video' }, { id: 'bad', path: junk, kind: 'video' }])
    const engine = vi.fn(async () => null)
    const q = (s: string) => new URLSearchParams(s)
    const r = await M.assetThumbnailsRoute(user, q('asset_id=vid&count=5'), engine, localNative())
    expect(r.status).toBe(200)
    const body = r.body as { thumbnails: string[], asset_id: string, count: number }
    expect(Object.keys(body)).toEqual(['thumbnails', 'asset_id', 'count'])
    expect([body.asset_id, body.count]).toEqual(['vid', 5])
    expect(await Promise.all(body.thumbnails.map(u => pngPixels(fromDataUrl(u))))).toEqual(thumbCase('v_vfr.mp4', 5).thumbnails)
    expect(readFileSync(join(thumbsDir(), 'vid.5.json'), 'utf8')).toBe(pyDumps(body))

    const b = await M.assetThumbnailsRoute(user, q('asset_id=bad&count=3'), engine, localNative())
    expect(b).toEqual({ status: 200, body: { thumbnails: [], asset_id: 'bad', count: 3 } })
    expect(cached()).toEqual(['bad.3.json', 'vid.5.json'])
    expect(engine).not.toHaveBeenCalled()
  })

  it('asset_waveform: Python\'s shape, and the cache file is Python\'s own JSON text', async () => {
    await requireMediaTools()
    const wav = addClip('a_s16.wav')
    writeAssets([{ id: 'A', path: wav, kind: 'audio' }])
    const engine = vi.fn(async () => null)
    const r = await M.assetWaveformRoute(user, new URLSearchParams('asset_id=A'), engine, localNative())
    expect(r.status).toBe(200)
    const text = pyText(waveCase('a_s16.wav', 256).textz)
    expect(r.body).toEqual(JSON.parse(text))
    expect(Object.keys(r.body as object)).toEqual(['peaks', 'asset_id', 'buckets'])
    expect(readFileSync(join(thumbsDir(), 'wave_A.256.json'), 'utf8')).toBe(text)
    expect(engine).not.toHaveBeenCalled()
  })

  it('asset_import: a video and a sound are recorded with Python\'s probe numbers, the engine never asked', async () => {
    await requireMediaTools()
    addClip('v_h264_601.mp4', 'clip.mp4')
    addClip('a_mono.mp3', 'tone.mp3')
    addClip('g_timeline_junk.wav', 'junk.wav')
    const engine = vi.fn(async () => null)
    const native = localNative()
    const v = (await M.assetImportRoute(user, input, { path: 'clip.mp4' }, engine, native)).body as any
    expect(v.asset).toMatchObject({ kind: 'video', duration_sec: 0.3333333333333333, width: 32, height: 24, name: 'clip.mp4' })
    const a = (await M.assetImportRoute(user, input, { path: 'tone.mp3' }, engine, native)).body as any
    expect(a.asset).toMatchObject({ kind: 'audio', duration_sec: 1, width: null, height: null })
    const j = (await M.assetImportRoute(user, input, { path: 'junk.wav' }, engine, native)).body as any
    expect(j.asset).toMatchObject({ kind: 'audio', duration_sec: null, width: null, height: null })
    expect(engine).not.toHaveBeenCalled()
  })

  it('through runMediaRoute: the four routes are served natively and nothing is fetched', async () => {
    await requireMediaTools()
    const fetchSpy = vi.fn(async () => { throw new TypeError('fetch failed') })
    vi.stubGlobal('fetch', fetchSpy)
    const clip = addClip('v_h264_709.mp4', 'clip.mp4')
    const wav = addClip('a_min.wav')
    writeAssets([{ id: 'vid', path: clip, kind: 'video' }, { id: 'wav', path: wav, kind: 'audio' }])
    const ctx = { userDir: user, inputDir: input, outputDir: join(root, 'output') }
    const ev = (p: string, method = 'GET') => ({ path: p, method, context: {} }) as any

    const it1 = await M.runMediaRoute(ctx, { name: 'inputThumbnail' }, ev('/sailor/input_thumbnail?filename=clip.mp4'), '/sailor/input_thumbnail')
    expect(it1.status).toBe(200)
    expect(await pngPixels(it1.body as Buffer)).toEqual(thumbCase('v_h264_709.mp4', 1).thumbnails[0])
    const at = await M.runMediaRoute(ctx, { name: 'assetThumbnails' }, ev('/sailor/asset_thumbnails?asset_id=vid&count=20'), '/sailor/asset_thumbnails')
    expect((at.body as any).thumbnails).toHaveLength(20)
    const wf = await M.runMediaRoute(ctx, { name: 'assetWaveform' }, ev('/sailor/asset_waveform?asset_id=wav&buckets=16'), '/sailor/asset_waveform')
    expect(wf.body).toEqual({ ...JSON.parse(pyText(waveCase('a_min.wav', 16).textz)), asset_id: 'wav' })
    addClip('v_h264_709.mp4', 'new.mp4')
    const raw = Buffer.from(JSON.stringify({ path: 'new.mp4' }))
    const im = await M.runMediaRoute(ctx, { name: 'assetImport' }, ev('/sailor/asset_import', 'POST'), '/sailor/asset_import', { value: { path: 'new.mp4' }, raw })
    expect(im.body).toMatchObject({ created: true, asset: { kind: 'video', duration_sec: 0.3333333333333333, width: 32, height: 24 } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── without the tools: exactly as before ─────────────────────────────────────

describe('with the tools missing, the routes forward (or answer 503) exactly as today', () => {
  it('route functions hand a video or sound to the engine when there is no native reader', async () => {
    addClip('v_h264_601.mp4', 'clip.mp4')
    writeAssets([{ id: 'vid', path: join(input, 'clip.mp4'), kind: 'video' }])
    const engine = vi.fn(async () => ({ status: 200, body: { from: 'engine' } }))
    expect((await M.inputThumbnailRoute(user, input, 'clip.mp4', engine, null)).body).toEqual({ from: 'engine' })
    expect((await M.assetThumbnailsRoute(user, new URLSearchParams('asset_id=vid'), engine, null)).body).toEqual({ from: 'engine' })
    expect((await M.assetWaveformRoute(user, new URLSearchParams('asset_id=vid'), engine, null)).body).toEqual({ from: 'engine' })
    expect((await M.assetImportRoute(user, input, { path: 'clip.mp4' }, engine, null)).body).toEqual({ from: 'engine' })
    expect(engine).toHaveBeenCalledTimes(4)
  })

  it('through runMediaRoute with no tools and the engine down: 503 for thumbnails and waveforms, an import without numbers', async () => {
    tools.mode = 'none'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const clip = addClip('v_h264_601.mp4', 'clip.mp4')
    writeAssets([{ id: 'vid', path: clip, kind: 'video' }])
    const ctx = { userDir: user, inputDir: input, outputDir: join(root, 'output') }
    const ev = (p: string, method = 'GET') => ({ path: p, method, context: {} }) as any
    for (const [h, p] of [['inputThumbnail', '/sailor/input_thumbnail?filename=clip.mp4'], ['assetThumbnails', '/sailor/asset_thumbnails?asset_id=vid'], ['assetWaveform', '/sailor/asset_waveform?asset_id=vid']] as const) {
      expect(await M.runMediaRoute(ctx, { name: h }, ev(p), p.split('?')[0]!), p).toEqual(M.NEEDS_ENGINE)
    }
    addClip('v_h264_601.mp4', 'new.mp4')
    const raw = Buffer.from(JSON.stringify({ path: 'new.mp4' }))
    const im = await M.runMediaRoute(ctx, { name: 'assetImport' }, ev('/sailor/asset_import', 'POST'), '/sailor/asset_import', { value: { path: 'new.mp4' }, raw })
    expect(im.body).toMatchObject({ created: true, asset: { kind: 'video', duration_sec: null, width: null, height: null } })
    expect(cached()).toEqual([])
  })
})

// ── the machinery (fake tools) ───────────────────────────────────────────────

describe('the thumbnail seek', () => {
  it('run.ts admits -ss in whole microseconds (or 0), and nothing looser', () => {
    const args = (ss: string) => ['-seek_timestamp', '1', '-ss', ss, '-noaccurate_seek', '-i', 'file:/a/b.mp4', '-f', 'rawvideo', 'pipe:1']
    for (const ok of ['0', '0us', '406901us', '999999999999999us']) expect(() => checkArgs('ffmpeg', args(ok)), ok).not.toThrow()
    for (const bad of ['5', '1.5', '-5us', '1e3us', '5ms', '5 us', '1000000000000000us', '00:00:01']) expect(() => checkArgs('ffmpeg', args(bad)), bad).toThrow()
  })

  it('seekMicros names the microsecond that ffmpeg rescales (to nearest) onto the target pts', () => {
    // av_rescale(us, den, 1e6 · num), halves away from zero.
    const toPts = (us: number, tb: { num: number, den: number }) => Number((BigInt(us) * BigInt(tb.den) + 500_000n * BigInt(tb.num)) / (1_000_000n * BigInt(tb.num)))
    for (const tb of [{ num: 1, den: 12288 }, { num: 1, den: 1000 }, { num: 1, den: 16000 }, { num: 1, den: 90000 }, { num: 1001, den: 30000 }, { num: 1, den: 14112000 }]) {
      for (const target of [0, 1, 7, 307, 5000, 9216, 123456]) {
        const us = T.seekMicros(target, tb)
        const fine = tb.den / tb.num > 1_000_000
        if (fine) expect(toPts(us, tb), `${target} @ ${tb.num}/${tb.den}`).toBeLessThanOrEqual(target)
        else expect(toPts(us, tb), `${target} @ ${tb.num}/${tb.den}`).toBe(target)
      }
    }
    expect(T.seekMicros(5000, { num: 1, den: 12288 })).toBe(406901)
  })
})


/** Fake ffmpeg / ffprobe (sh; the job's environment has no PATH, so every tool is named in full). */
function fakeTools(o: { ffmpeg: string, ffprobe: string }): MediaTools {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const write = (name: string, body: string) => {
    const f = join(bin, name)
    writeFileSync(f, `#!/bin/sh\n${body}\n`)
    chmodSync(f, 0o755)
    return f
  }
  const t: MediaTools = {
    ffmpeg: write('ffmpeg', o.ffmpeg),
    ffprobe: write('ffprobe', o.ffprobe),
    version: 'ffmpeg version 8.0.3-sailor1', buildconf: [], encoders: new Set(), protocols: { input: ['file', 'pipe'], output: ['file', 'pipe'] },
  }
  tools.mode = 'fake'
  tools.fake = t
  return t
}
/** A file whose first bytes say MP4 (what it holds is the fake ffprobe's answer). */
function fakeMp4(name: string): string {
  const f = join(input, name)
  writeFileSync(f, Buffer.concat([Buffer.from('\0\0\0\x20ftypisom\0\0\0\0'), Buffer.alloc(64)]))
  return f
}
const videoAnswer = JSON.stringify({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000' },
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 48, avg_frame_rate: '24/1', nb_frames: '240', time_base: '1/12288', duration_ts: 122880 }],
})

describe('a hanging decode', () => {
  it('answers within the routes\' 30 s limit with Python\'s failure answer ([]), caches nothing, and stops at the first thumbnail', async () => {
    const ran = join(root, 'ffmpeg.ran')
    fakeTools({ ffprobe: `cat <<'JSON'\n${videoAnswer}\nJSON`, ffmpeg: `echo ran >> "${ran}"\nexec /bin/sleep 120` })
    const clip = fakeMp4('hang.mp4')
    writeAssets([{ id: 'hang', path: clip, kind: 'video' }])
    const t0 = Date.now()
    const r = await M.assetThumbnailsRoute(user, new URLSearchParams('asset_id=hang&count=5'), vi.fn(async () => null), localNative())
    const took = Date.now() - t0
    expect(r).toEqual({ status: 200, body: { thumbnails: [], asset_id: 'hang', count: 5 } })
    expect(took).toBeLessThan(31_000)
    expect(took).toBeGreaterThanOrEqual(29_000)
    expect(readFileSync(ran, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(cached()).toEqual([])
  }, 60_000)
})

describe('the hosted gate still runs first', () => {
  const owners = new Map<string, string>()
  beforeEach(() => {
    owners.clear()
    __setResourceOwnersDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/select\s+user_id\s+from\s+resource_owners/i.test(sql)) {
          const [kind, id] = params as string[]
          const u = owners.get(`${kind}::${id}`)
          return { rows: u ? [{ user_id: u }] : [] }
        }
        throw new Error(`unexpected resource_owners sql: ${sql}`)
      },
    } as any)
  })

  it('another user\'s asset is refused (404) before any probe or decode starts', async () => {
    deploy.mode = 'hosted'
    const ran = join(root, 'tool.ran')
    fakeTools({ ffprobe: `echo probe >> "${ran}"\ncat <<'JSON'\n${videoAnswer}\nJSON`, ffmpeg: `echo ffmpeg >> "${ran}"\nexit 1` })
    const clip = fakeMp4('theirs.mp4')
    writeAssets([{ id: 'a-theirs', path: clip, kind: 'video' }])
    owners.set(`${SAILOR_ASSET_KIND}::a-theirs`, 'u2')
    const before = mediaLimiter().started()
    for (const p of ['/sailor/asset_thumbnails?asset_id=a-theirs&count=5', '/sailor/asset_waveform?asset_id=a-theirs']) {
      const ev = { path: p, method: 'GET', context: { userId: 'u1' }, node: { req: {}, res: {} } }
      await expect(handleHostedSailorData(ev as any), p).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(mediaLimiter().started()).toBe(before)
    expect(existsSync(ran)).toBe(false)
    expect(cached()).toEqual([])
  })
})

