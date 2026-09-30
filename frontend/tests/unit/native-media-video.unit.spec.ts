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
// The Frame's worker, watched (a large thumbnail frame is resized there): the real one, counted.
const workerCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('~~/server/runner/compositor/worker', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/worker')>()
  return { ...real, pixelsInWorker: ((...a: Parameters<typeof real.pixelsInWorker>) => { workerCalls.n++; return real.pixelsInWorker(...a) }) as typeof real.pixelsInWorker }
})
vi.mock('~~/server/native/engineHealth', async orig => ({ ...(await orig() as object), engineHealth: async () => 'down' as const }))

const g = globalThis as any
g.defineEventHandler ??= (fn: unknown) => fn
g.createError ??= (o: { statusCode: number, message?: string }) => Object.assign(new Error(o.message), { statusCode: o.statusCode })

const M = await import('~~/server/native/media')
const { pyDumps } = await import('~~/server/native/pyJson')
const T = await import('~~/server/media/thumbnails')
const { checkArgs, checkFilterGraph, mediaLimiter, runMedia, MediaError } = await import('~~/server/media/run')
const { framesFilter, pickFilter } = await import('~~/server/media/decode')
const { pixels } = await import('~~/server/runner/pixels/core')
const { MEDIA_ROUTE_JOBS_PER_USER, MEDIA_ROUTE_WAIT_MS, MEDIA_WORDS } = await import('#shared/runner/media')
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


// ── fix round 1 ──────────────────────────────────────────────────────────────

describe('run.ts pins select to the forms Sailor builds (fix round 1, Important 1)', () => {
  it('admits decode.ts\'s and thumbnails.ts\'s own select filters', () => {
    const v = { chromaLocation: 'left', pixFmt: 'yuv420p' }
    for (const g of [
      framesFilter(v),
      framesFilter(v, { start: 5, stride: 3, count: 10 }),
      pickFilter({ start: 0, stride: 1, count: 1 }),
      '[0:v:0]select=gte(pts\\,9216),split=3[a][b][c]',
      'select=gte(pts\\,0)',
    ]) expect(checkFilterGraph(g), g).toBe(true)
  })

  it('refuses every other select expression, loops and variables first', () => {
    for (const g of [
      'select=while(1\\,1)',
      'select=st(0\\,1)*ld(0)',
      'select=gte(pts\\,1)+1',
      'select=gte(t\\,1)',
      'select=gte(pts\\,-1)',
      'select=gte(n\\,3)*not(mod(n-4\\,2))',
      'select=gte(n\\,3)*not(mod(n-3\\,2))*while(1\\,1)',
      'select=1',
      'select',
      'select=eq(pts\\,5)',
    ]) expect(checkFilterGraph(g), g).toBe(false)
    expect(() => checkArgs('ffmpeg', ['-i', 'file:/a/b.mp4', '-vf', 'select=while(1\\,1)', 'pipe:1'])).toThrow()
  })
})

describe('the resize: inline below THUMB_WORKER_PIXELS, on the Frame\'s worker above (fix round 1)', () => {
  const frame = (w: number, h: number) => {
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 31 + (i >> 7)) & 255
    return { rgb, w, h }
  }
  it('a 1920 × 1080 frame goes to the worker, a 1280 × 720 one doesn\'t; both are Pillow\'s pixels', async () => {
    expect(T.THUMB_WORKER_PIXELS).toBe(2_000_000)
    for (const [w, h, onWorker] of [[1280, 720, false], [1920, 1080, true]] as const) {
      const f = frame(w, h)
      const want = pixels.pilResize(f.rgb.slice(), w, h, 3, 85, 48, undefined, 'bilinear')
      const before = workerCalls.n
      const png = await T.thumbnailPng(f)
      expect(workerCalls.n - before, `${w}×${h}`).toBe(onWorker ? 1 : 0)
      const got = await pngPixels(png)
      expect(got, `${w}×${h}`).toEqual({ mode: 'RGB', w: 85, h: 48, sha256: sha256Hex(want) })
    }
  }, 60_000)
})

describe('the waveform, streamed (fix round 1, Important 3)', () => {
  const f32 = (xs: number[]) => Float32Array.from(xs)

  it('PeakBuckets: chunks may split a sample; the buckets are Python\'s (0.0 past the end)', () => {
    const l = T.flatLayout('flt', 2)
    const a = new T.PeakBuckets(6, 4, l)
    a.push(f32([0.25, -0.5]))
    a.push(f32([0.125]))
    a.push(f32([-1, 0.75, 0.5]))
    // flat = |interleaved|; chunk = 6 // 4 = 1; the last bucket runs to the end.
    expect(a.peaks()).toEqual([0.25, 0.5, 0.125, 1])
    const b = new T.PeakBuckets(2, 4, T.flatLayout('s16', 1))
    b.push(f32([0.5, -0.25]))
    expect(b.peaks()).toEqual([1, 0.5, 0, 0])
  })

  it('PeakBuckets: planar u8 is back to 0…255 and averaged in float64; planar floats in float32', () => {
    // u8p, two channels: x0 = [0, 255], x1 = [10, 20] (pcm_f32le gives (x − 128) / 128).
    const u = new T.PeakBuckets(2, 2, T.flatLayout('u8p', 2))
    u.push(f32([(0 - 128) / 128, (10 - 128) / 128, (255 - 128) / 128, (20 - 128) / 128]))
    expect(u.peaks()).toEqual([Math.fround(5 / 137.5), 1])
    // fltp, three channels: numpy's float32 sum row by row, then / 3.
    const x = [0.1, 0.2, 0.3].map(Math.fround)
    const sum = Math.fround(Math.fround(x[0]! + x[1]!) + x[2]!)
    const m = Math.abs(Math.fround(sum / 3))
    const p = new T.PeakBuckets(1, 16, T.flatLayout('fltp', 3))
    p.push(f32(x))
    expect(p.peaks()[0]).toBe(Math.fround(m / m))
  })

  it('PeakBuckets fails when the second pass brings a different count', () => {
    const a = new T.PeakBuckets(3, 2, T.flatLayout('flt', 1))
    a.push(f32([1, 2]))
    expect(() => a.peaks()).toThrow(MediaError)
    expect(() => a.push(f32([1, 2]))).toThrow(MediaError)
  })
})

/** A fake ffprobe answering this JSON. */
const probeSays = (j: unknown) => `cat <<'JSON'\n${JSON.stringify(j)}\nJSON`
const soundAnswer = (o: { fmt: string, channels: number, seconds: number, rate?: number }) => ({
  format: { format_name: 'wav', duration: o.seconds.toFixed(6) },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_fmt: o.fmt, sample_rate: String(o.rate ?? 8000), channels: o.channels, time_base: `1/${o.rate ?? 8000}`, duration_ts: o.seconds * (o.rate ?? 8000) }],
})
function fakeWav(name: string): string {
  const f = join(input, name)
  writeFileSync(f, Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(64)]))
  return f
}

describe('what is cached: only Python\'s own empties (fix round 1)', () => {
  const q = (s: string) => new URLSearchParams(s)

  it('a frame over the size cap, and a tool that fails, give [] and cache nothing', async () => {
    fakeTools({ ffprobe: probeSays(JSON.parse(videoAnswer.replace('"width":64,"height":48', '"width":10000,"height":10000'))), ffmpeg: 'exit 1' })
    const big = fakeMp4('big.mp4')
    writeAssets([{ id: 'big', path: big, kind: 'video' }])
    expect(await M.assetThumbnailsRoute(user, q('asset_id=big&count=2'), vi.fn(async () => null), localNative())).toEqual({ status: 200, body: { thumbnails: [], asset_id: 'big', count: 2 } })
    fakeTools({ ffprobe: probeSays(JSON.parse(videoAnswer)), ffmpeg: 'exit 1' })
    const broken = fakeMp4('broken.mp4')
    writeAssets([{ id: 'broken', path: broken, kind: 'video' }])
    expect((await M.assetThumbnailsRoute(user, q('asset_id=broken&count=2'), vi.fn(async () => null), localNative())).body).toMatchObject({ thumbnails: [] })
    expect(cached()).toEqual([])
  })

  it('hosted, a sound over the caps gives [] and caches nothing; a planar sound of 10 channels is a named case, not cached', async () => {
    deploy.mode = 'hosted'
    fakeTools({ ffprobe: probeSays(soundAnswer({ fmt: 's16', channels: 1, seconds: 3 * 3600 })), ffmpeg: 'exit 1' })
    writeAssets([{ id: 'long', path: fakeWav('long.wav'), kind: 'audio' }, { id: 'ten', path: fakeWav('ten.wav'), kind: 'audio' }])
    const hosted = T.nativeMedia({ roots: [input], userId: 'u1' })
    expect((await M.assetWaveformRoute(user, q('asset_id=long&buckets=16'), vi.fn(async () => null), hosted)).body).toEqual({ peaks: [], asset_id: 'long', buckets: 16 })
    fakeTools({ ffprobe: probeSays(soundAnswer({ fmt: 'fltp', channels: 10, seconds: 1 })), ffmpeg: 'exit 1' })
    expect((await M.assetWaveformRoute(user, q('asset_id=ten&buckets=16'), vi.fn(async () => null), hosted)).body).toEqual({ peaks: [], asset_id: 'ten', buckets: 16 })
    expect(cached()).toEqual([])
  })

  it('locally a sound over an hour is drawn, as Python draws it, and cached', async () => {
    // Both passes hand over the same two floats: 0.5 and -1.0.
    fakeTools({ ffprobe: probeSays(soundAnswer({ fmt: 's16', channels: 1, seconds: 2 * 3600 })), ffmpeg: `printf '\\000\\000\\000\\077\\000\\000\\200\\277'` })
    writeAssets([{ id: 'long', path: fakeWav('long.wav'), kind: 'audio' }])
    const r = await M.assetWaveformRoute(user, q('asset_id=long&buckets=16'), vi.fn(async () => null), localNative())
    expect(r.body).toEqual({ peaks: [0.5, 1, ...Array(14).fill(0)], asset_id: 'long', buckets: 16 })
    expect(readFileSync(join(thumbsDir(), 'wave_long.16.json'), 'utf8')).toBe(`{"peaks": [0.5, 1.0, ${Array(14).fill('0.0').join(', ')}], "asset_id": "long", "buckets": 16}`)
  })

  it('an import whose probe stops for Sailor\'s own reason is answered but not recorded, so a re-import probes again (Minor 4)', async () => {
    fakeTools({ ffprobe: 'exec /bin/sleep 120', ffmpeg: 'exit 1' })
    fakeMp4('slow.mp4')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const native = T.nativeMedia({ roots: ['/'], userId: null, signal: ac.signal })
    const r = await M.assetImportRoute(user, input, { path: 'slow.mp4' }, vi.fn(async () => null), native)
    expect(r.body).toMatchObject({ created: true, asset: { kind: 'video', duration_sec: null, width: null, height: null } })
    expect(existsSync(join(user, 'timeline_assets.json')) ? JSON.parse(readFileSync(join(user, 'timeline_assets.json'), 'utf8')) : []).toEqual([])
    // A file that isn't media is Python's own answer: recorded with nulls.
    fakeTools({ ffprobe: 'exit 1', ffmpeg: 'exit 1' })
    fakeMp4('junk.mp4')
    await M.assetImportRoute(user, input, { path: 'junk.mp4' }, vi.fn(async () => null), T.nativeMedia({ roots: ['/'], userId: null }))
    expect(JSON.parse(readFileSync(join(user, 'timeline_assets.json'), 'utf8')).map((a: any) => a.name)).toEqual(['junk.mp4'])
  })
})

describe('route jobs are fair and bounded (fix round 1, Important 2)', () => {
  const job = (userId: string | null, signal?: AbortSignal) =>
    runMedia({ tool: 'ffprobe', args: ['-of', 'json', '-show_format', '-i', 'file:/a/b.mp4'], userId, route: true, signal })
  const word = (p: Promise<unknown>) => p.then(() => 'done', (e: InstanceType<typeof MediaError>) => e.word)

  it('hosted: one running and four waiting per person, the next refused at once (busy); another person still runs; Stop empties both', async () => {
    deploy.mode = 'hosted'
    fakeTools({ ffprobe: 'exec /bin/sleep 120', ffmpeg: 'exit 1' })
    expect(MEDIA_ROUTE_JOBS_PER_USER).toEqual({ running: 1, waiting: 4 })
    const ac = new AbortController()
    const a = Array.from({ length: 5 }, () => word(job('A', ac.signal)))
    await new Promise(r => setTimeout(r, 200))
    expect(mediaLimiter().routes('A')).toEqual({ running: 1, waiting: 4 })
    const t0 = Date.now()
    expect(await word(job('A', ac.signal))).toBe('busy')
    expect(Date.now() - t0).toBeLessThan(100)
    const b = word(job('B', ac.signal))
    await new Promise(r => setTimeout(r, 200))
    expect(mediaLimiter().routes('B')).toEqual({ running: 1, waiting: 0 })
    const t1 = Date.now()
    ac.abort()
    expect(await Promise.all([...a, b])).toEqual(Array(6).fill('stopped'))
    expect(Date.now() - t1).toBeLessThan(1500)
    expect(mediaLimiter().routes('A')).toEqual({ running: 0, waiting: 0 })
    expect(MEDIA_WORDS.busy).toMatch(/busy/)
  })

  it('a route job waits at most MEDIA_ROUTE_WAIT_MS for a slot, then is refused (busy)', async () => {
    fakeTools({ ffprobe: 'exec /bin/sleep 120', ffmpeg: 'exit 1' })
    const ac = new AbortController()
    const held = [word(job(null, ac.signal)), word(job(null, ac.signal))]
    const t0 = Date.now()
    expect(await word(job(null, ac.signal))).toBe('busy')
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(MEDIA_ROUTE_WAIT_MS - 50)
    expect(waited).toBeLessThan(MEDIA_ROUTE_WAIT_MS + 1000)
    ac.abort()
    expect(await Promise.all(held)).toEqual(['stopped', 'stopped'])
  }, 30_000)

  it('the request closing stops its jobs: through runMediaRoute, a closed response ends a hanging thumbnail at once, nothing cached', async () => {
    const { EventEmitter } = await import('node:events')
    fakeTools({ ffprobe: probeSays(JSON.parse(videoAnswer)), ffmpeg: 'exec /bin/sleep 120' })
    const clip = fakeMp4('hang.mp4')
    writeAssets([{ id: 'hang', path: clip, kind: 'video' }])
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const ev = { path: '/sailor/asset_thumbnails?asset_id=hang&count=5', method: 'GET', context: {}, node: { req: {}, res } } as any
    const ctx = { userDir: user, inputDir: input, outputDir: join(root, 'output') }
    setTimeout(() => res.emit('close'), 500)
    const t0 = Date.now()
    const r = await M.runMediaRoute(ctx, { name: 'assetThumbnails' }, ev, '/sailor/asset_thumbnails')
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(r.body).toEqual({ thumbnails: [], asset_id: 'hang', count: 5 })
    expect(cached()).toEqual([])
    expect(mediaLimiter().routes(null)).toEqual({ running: 0, waiting: 0 })
  })
})

describe('if the media module fails to load, the routes behave as without the tools (Minor 6)', () => {
  it('forwards (503 with the engine down) and logs', async () => {
    await requireMediaTools()
    vi.resetModules()
    vi.doMock('~~/server/media/thumbnails', () => { throw new Error('sharp failed to load') })
    try {
      const fresh = await import('~~/server/native/media')
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const clip = addClip('v_h264_601.mp4', 'clip.mp4')
      writeAssets([{ id: 'vid', path: clip, kind: 'video' }])
      const ctx = { userDir: user, inputDir: input, outputDir: join(root, 'output') }
      const r = await fresh.runMediaRoute(ctx, { name: 'assetThumbnails' }, { path: '/sailor/asset_thumbnails?asset_id=vid', method: 'GET', context: {} } as any, '/sailor/asset_thumbnails')
      expect(r).toEqual(fresh.NEEDS_ENGINE)
      expect(err.mock.calls.some(c => String(c[0]).includes('media.route.unavailable'))).toBe(true)
      err.mockRestore()
    }
    finally {
      vi.doUnmock('~~/server/media/thumbnails')
      vi.resetModules()
    }
  })
})
