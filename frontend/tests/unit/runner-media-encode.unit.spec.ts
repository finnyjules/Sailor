/**
 * Task R5.1c: the media module's encoders (server/media/encode.ts,
 * h264Quality.ts, resample.ts) against what the real Python writes, as
 * scripts/runner_media_fixtures.py --group encode recorded it. Needs the real
 * build (R5.1a).
 *
 * H.264 is judged by ruling (c): Python's libx264 and Sailor's OpenH264 are
 * different encoders, so
 *   - the frame count, rate, length and size equal Python's exactly;
 *   - the decoded frames equal, byte for byte, Python's own save_to switched
 *     to libopenh264 with the same settings (so the encoder gets the same
 *     frames with the same settings);
 *   - the decoded frames are no further from the source than libx264's
 *     (PSNR within 0.5 dB);
 *   - the average difference from libx264's decoded frames is measured and
 *     held to the bound the report proposes (ruling (c)'s 2/255 can't hold
 *     between two encoders: see task-R5.1c-report.md).
 * MP3 and AAC decode exactly, or within 60 dB SNR (named case by case).
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeAudio, decodeFrames, type DecodedSound } from '~~/server/media/decode'
import {
  OPENH264_FOR, PYAV_H264_DEFAULT, RGB_TO_YUV420P, SAVE_AUDIO_SAMPLE_FMT, encodeAudio, encodeVideo, ffmetadataText, floatWav,
  h264Args, pyAudioCutSamples, pyStreamRate, writeFfv1, type SoundLayout,
} from '~~/server/media/encode'
import { opusRate, resampleLikeTorchaudio } from '~~/server/media/resample'
import { probeMedia, pyFrameCount, pyFrameRate, pyRawDuration } from '~~/server/media/probe'
import { MediaError, checkArgs, confineOutputs, mediaLimiter, mediaTempDir, removeMediaTempDir, runMedia } from '~~/server/media/run'
import { MEDIA_WORDS } from '#shared/runner/media'
import { synth } from './__runner__/effectsParity'
import {
  CLIP_ROOTS, clipPath, mediaFixture, requireMediaTools, sha256Hex, smoothFrame, unz, unzF32,
  type EncodeCases, type PyVideoOut,
} from './__runner__/mediaParity'

const FIX = mediaFixture<never>('encode') as unknown as { cases: EncodeCases; encodeClips: Record<string, string> }
const C = FIX.cases
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER

/**
 * The average difference allowed between Sailor's decoded H.264 and Python's
 * libx264 one, in 8-bit levels, per case. Ruling (c) says 2; measured on this
 * build it is 5.6–6.0 on the save_to cases (while Sailor's frames are closer
 * to the source than libx264's), so this bound is the report's proposal, a
 * regression guard pending the controller's ruling.
 */
const MEAN_DIFF_BOUND = 7

/**
 * Opus: PyAV's wheel carries libopus 1.6.1, Sailor's build 1.5.2, and Opus's
 * float encoder isn't bit-stable across versions: even fed torchaudio's own
 * resampled samples, the decoded sound differs (up to 0.014). Measured SNR
 * against Python's decoded file: 50.4 dB mono, 42.1 dB stereo. Rule 3 names
 * no bound for Opus; this is the report's proposal.
 */
const OPUS_SNR_DB = 40

const scratch = mkdtempSync(join(tmpdir(), 'media-encode-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let serial = 0
/** A fresh output path (the folder is this spec's own). */
function outPath(ext: string): string {
  return join(realpathSync(scratch), `out-${++serial}.${ext}`)
}
const ROOTS = () => [realpathSync(scratch)]

async function* framesOf(list: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const f of list) yield f
}

async function decodeAll(path: string): Promise<{ frames: Uint8Array[]; pts: number[] }> {
  const frames: Uint8Array[] = []
  const pts: number[] = []
  await decodeFrames(path, { userId: null, maxFrames: BIG, roots: ROOTS(), onFrame: async (f, _i, t) => { frames.push(f); pts.push(t) } })
  return { frames, pts }
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; se += d * d }
  const mse = se / a.length
  return mse ? 10 * Math.log10((255 * 255) / mse) : Number.POSITIVE_INFINITY
}

function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

/** Signal-to-noise ratio of `got` against `want` (dB), over every channel; Infinity when equal. */
function snr(want: Float32Array[], got: Float32Array[]): number {
  let sig = 0
  let noise = 0
  for (let c = 0; c < want.length; c++) {
    for (let i = 0; i < want[c]!.length; i++) {
      sig += want[c]![i]! ** 2
      noise += (want[c]![i]! - (got[c]?.[i] ?? 0)) ** 2
    }
  }
  return noise ? 10 * Math.log10(sig / noise) : Number.POSITIVE_INFINITY
}

/** A zlib'd [C][N] float32 fixture sound as channels. */
function channelsOf(f32z: string, rows: number): Float32Array[] {
  const all = unzF32(f32z)
  const n = all.length / rows
  return Array.from({ length: rows }, (_, c) => all.slice(c * n, (c + 1) * n))
}

/** The fields of our output's probe that PyAV's header holds, in the fixture's shape. */
async function headerOf(path: string) {
  const p = await probeMedia(path, { userId: null, roots: ROOTS() })
  return {
    p,
    header: {
      formatName: p.formatName, containerDuration: p.containerDuration,
      video: p.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, averageRate: v.averageRate, frames: v.frames, duration: v.duration, timeBase: v.timeBase })),
      sound: p.sound.map(s => ({ rate: s.rate, channels: s.channels, layout: s.layout, codec: s.codec, sampleFmt: s.sampleFmt, duration: s.duration, timeBase: s.timeBase })),
    },
  }
}

/** Ruling (c)'s exact half: frame count, rate, length and size equal Python's; the helpers too. */
async function expectSameNumbers(path: string, py: PyVideoOut, label: string): Promise<void> {
  const { p, header } = await headerOf(path)
  const want = py.header
  expect(header.formatName, label).toBe(want.formatName)
  expect(header.containerDuration, label).toBe(want.containerDuration)
  expect(header.video.length, label).toBe(want.video.length)
  const v = header.video[0]!
  const wv = want.video[0]!
  expect({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, averageRate: v.averageRate, frames: v.frames, duration: v.duration, timeBase: v.timeBase }, label)
    .toEqual({ w: wv.w, h: wv.h, codec: wv.codec, pixFmt: wv.pixFmt, averageRate: wv.averageRate, frames: wv.frames, duration: wv.duration, timeBase: wv.timeBase })
  expect(header.sound.length, label).toBe(want.sound.length)
  header.sound.forEach((s, i) => {
    const ws = want.sound[i]!
    expect({ rate: s.rate, channels: s.channels, layout: s.layout, codec: s.codec, duration: s.duration, timeBase: s.timeBase }, label)
      .toEqual({ rate: ws.rate, channels: ws.channels, layout: ws.layout, codec: ws.codec, duration: ws.duration, timeBase: ws.timeBase })
  })
  expect(await pyFrameCount(p, p.path, { userId: null }), label).toBe(py.frameCount)
  expect(pyFrameRate(p), label).toEqual(py.frameRate)
  expect(pyRawDuration(p), label).toBe(py.duration)
}

/** The rest of ruling (c): equal to Python's OpenH264 run; no further from the source than libx264; the mean difference measured. */
function expectH264(ours: Uint8Array[], openh264: PyVideoOut, x264: PyVideoOut, source: Uint8Array | null, label: string): { mean: number; psnrOurs: number | null } {
  expect(ours.map(sha256Hex), `${label}: equal to Python's save_to on libopenh264`).toEqual(openh264.frames)
  const py = unz(x264.rgbz!)
  const all = concat(ours)
  expect(all.length, label).toBe(py.length)
  const mean = meanDiff(all, py)
  expect(mean, `${label}: mean difference from libx264 (levels)`).toBeLessThanOrEqual(MEAN_DIFF_BOUND)
  let psnrOurs: number | null = null
  if (source) {
    psnrOurs = psnr(source, all)
    expect(psnrOurs, `${label}: no further from the source than libx264`).toBeGreaterThanOrEqual(x264.psnr! - 0.5)
  }
  return { mean, psnrOurs }
}

/** The JSON text Python's json.dumps writes for the tags (read back from Python's own file). */
function pyTags(py: PyVideoOut | { tags: Record<string, string> }): Record<string, string> {
  const t = py.tags!
  return { prompt: t.prompt!, workflow: t.workflow! }
}

async function tagsOf(path: string): Promise<Record<string, string>> {
  const { stdout } = await runMedia({
    tool: 'ffprobe',
    args: ['-protocol_whitelist', 'file,pipe', '-i', `file:${path}`, '-of', 'json', '-show_format', '-show_streams'],
    userId: null,
  })
  const j = JSON.parse(Buffer.from(stdout!).toString('utf8')) as { format?: { tags?: Record<string, string> }; streams?: { tags?: Record<string, string> }[] }
  const tags: Record<string, string> = { ...(j.format?.tags ?? {}) }
  for (const s of j.streams ?? []) for (const [k, v] of Object.entries(s.tags ?? {})) tags[`stream:${k}`] = v
  return tags
}

describe('the OpenH264 table (ruling d)', () => {
  it('has one measured row per CRF 10–32, the same rows the fixture ran, and h264Args puts them after the fixed part', () => {
    const want = Object.fromEntries(Object.entries(C.openh264Qp).map(([crf, qp]) => [crf, ['-rc_mode', 'quality', '-qmin', String(qp), '-qmax', String(qp)]]))
    expect(Object.fromEntries(Object.entries(OPENH264_FOR).map(([k, v]) => [k, [...v]]))).toEqual(want)
    expect(Object.keys(OPENH264_FOR).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => 10 + i))
    expect(h264Args(PYAV_H264_DEFAULT)).toEqual(['-c:v', 'libopenh264', '-threads:v', '1', '-coder', 'cabac', '-rc_mode', 'quality', '-qmin', '24', '-qmax', '24', '-pix_fmt', 'yuv420p'])
    // Held to the widget's range; a fraction truncates as Python's int() does.
    expect(h264Args({ crf: 4, preset: 'fast' })).toEqual(h264Args({ crf: 10, preset: 'slow' }))
    expect(h264Args({ crf: 51, preset: 'fast' })).toEqual(h264Args({ crf: 32, preset: 'fast' }))
    expect(h264Args({ crf: 20.9, preset: 'veryfast' })).toEqual(h264Args({ crf: 20, preset: 'medium' }))
  })

  it('each row equals Python’s save_to switched to libopenh264 at that row, after decoding', LONG, async () => {
    await requireMediaTools()
    const frames = Array.from({ length: 6 }, (_, i) => smoothFrame(64, 48, i))
    for (const row of C.rows) {
      const out = outPath('mp4')
      const r = await encodeVideo({ input: { kind: 'rgb', w: 64, h: 48, frames: framesOf(frames) }, out, fps: pyStreamRate(24), quality: { crf: row.crf, preset: 'medium' }, userId: null })
      expect(r.frames, `crf ${row.crf}`).toBe(row.frameCount)
      const got = await decodeAll(out)
      expect(got.frames.map(sha256Hex), `crf ${row.crf}`).toEqual(row.frames)
    }
  })
})

describe('rgb24 → yuv420p equals PyAV’s reformat(\'yuv420p\')', () => {
  it('gives Python’s planes byte for byte (64×48 noise, 64×48 smooth, 33×25 odd)', LONG, async () => {
    await requireMediaTools()
    const inputs: Record<string, Uint8Array> = {
      'synth 64×48': synth(64, 48, 3, 1), 'smooth 64×48': smoothFrame(64, 48, 3), 'synth 33×25': synth(33, 25, 3, 2),
    }
    for (const c of C.reformat) {
      const { stdout } = await runMedia({
        tool: 'ffmpeg',
        args: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${c.w}x${c.h}`, '-framerate', '1', '-i', 'pipe:0', '-vf', RGB_TO_YUV420P, '-f', 'rawvideo', 'pipe:1'],
        userId: null, stdin: framesOf([inputs[c.name]!]),
      })
      expect(sha256Hex(stdout!), c.name).toBe(c.sha256)
    }
  })
})

describe('encodeVideo equals VideoFromComponents.save_to (ruling c)', () => {
  const measured: Record<string, unknown> = {}
  afterAll(() => { console.info('[media-encode] save_to measured', JSON.stringify(measured)) })

  for (const c of C.saveTo) {
    it(`${c.name}: numbers exact, frames equal to the OpenH264 run, no further from the source, sound and tags`, LONG, async () => {
      await requireMediaTools()
      const source = Array.from({ length: c.frames }, (_, i) => smoothFrame(c.w, c.h, i))
      const fps = pyStreamRate(c.fps)
      let sound: DecodedSound | null = null
      let layout: SoundLayout = 'stereo'
      if (c.sound) {
        sound = { rate: c.sound.rate, channels: channelsOf(c.sound.f32z, c.sound.channels) }
        layout = ({ 1: 'mono', 2: 'stereo', 6: '5.1' } as Record<number, SoundLayout>)[c.sound.channels] ?? 'stereo'
      }
      const out = outPath('mp4')
      const tags = pyTags(c.x264)
      await encodeVideo({
        input: { kind: 'rgb', w: c.w, h: c.h, frames: framesOf(source) }, out, fps, quality: PYAV_H264_DEFAULT,
        sound: sound ? { source: { sound }, layout, rate: sound.rate, cutSamples: pyAudioCutSamples(sound.rate, c.fps, c.frames) } : null,
        metadata: tags, userId: null,
      })
      await expectSameNumbers(out, c.x264, c.name)
      const got = await decodeAll(out)
      measured[c.name] = expectH264(got.frames, c.openh264, c.x264, concat(source), c.name)
      // The sound: AAC from the same encoder and library, so the same decoded samples.
      if (c.x264.sound) {
        const ours = await decodeAudio(out, { decoder: 'fltp', userId: null, maxSamples: BIG, roots: ROOTS() })
        const want = channelsOf(c.x264.sound.f32z!, c.x264.sound.rows)
        expect(ours.rate, c.name).toBe(c.x264.sound.rate)
        expect(ours.channels.map(ch => ch.length), c.name).toEqual(want.map(ch => ch.length))
        expect(sha256Hex(new Uint8Array(concat(ours.channels.map(ch => new Uint8Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.byteLength)))))), `${c.name}: AAC decodes exactly`).toBe(c.x264.sound.sha256)
      }
      else expect((await probeMedia(out, { userId: null, roots: ROOTS() })).sound).toEqual([])
      // Workflow tags, JSON-equal (ruling i).
      const t = await tagsOf(out)
      expect(JSON.parse(t.prompt!), c.name).toEqual(JSON.parse(c.x264.tags!.prompt!))
      expect(JSON.parse(t.workflow!), c.name).toEqual(JSON.parse(c.x264.tags!.workflow!))
      expect(t.workflow, c.name).toBe(c.x264.tags!.workflow)
    })
  }

  it('takes Python’s stream rate and sound cut exactly (Fraction(round(fps·1000), 1000); ceil(rate / Fraction(fps) · frames))', () => {
    expect(pyStreamRate(24)).toEqual({ num: 24, den: 1 })
    expect(pyStreamRate(29.97)).toEqual({ num: 2997, den: 100 })
    expect(pyStreamRate(23.976)).toEqual({ num: 2997, den: 125 })
    expect(pyStreamRate(59.94)).toEqual({ num: 2997, den: 50 })
    expect(pyStreamRate(12.5)).toEqual({ num: 25, den: 2 })
    expect(pyStreamRate(0.1 + 0.2)).toEqual({ num: 3, den: 10 })
    // Printed by .venv's Python: math.ceil((44100 / Fraction(fps)) * 8) and (48000 …) * 7.
    const want: [number, number, number][] = [[24, 14700, 14000], [29.97, 11772, 11212], [30, 11760, 11200], [23.976, 14715, 14015], [59.94, 5886, 5606], [12.5, 28224, 26880], [0.1 + 0.2, 1176000, 1120000]]
    for (const [fps, a, b] of want) {
      expect(pyAudioCutSamples(44100, fps, 8), String(fps)).toBe(a)
      expect(pyAudioCutSamples(48000, fps, 7), String(fps)).toBe(b)
    }
  })

  it('a kept FFV1 batch encodes to the same H.264 as the same frames piped in', LONG, async () => {
    await requireMediaTools()
    const frames = Array.from({ length: 5 }, (_, i) => smoothFrame(64, 48, i + 20))
    const kept = outPath('mkv')
    expect((await writeFfv1({ frames: framesOf(frames), w: 64, h: 48, out: kept, userId: null })).count).toBe(5)
    const a = outPath('mp4')
    const b = outPath('mp4')
    await encodeVideo({ input: { kind: 'rgb', w: 64, h: 48, frames: framesOf(frames) }, out: a, fps: pyStreamRate(30), quality: { crf: 20, preset: 'veryfast' }, userId: null })
    await encodeVideo({ input: { kind: 'ffv1', path: kept, w: 64, h: 48 }, out: b, fps: pyStreamRate(30), quality: { crf: 20, preset: 'veryfast' }, userId: null, roots: ROOTS() })
    const da = await decodeAll(a)
    const db = await decodeAll(b)
    expect(db.frames.map(sha256Hex)).toEqual(da.frames.map(sha256Hex))
    expect(db.pts).toEqual(da.pts)
  })
})

describe('sound from a file (SaveVideoFrames’ audio_file; its Python parity is R5.5’s)', () => {
  it('encodes the first sound stream as stereo AAC at its rate, whole frames up to the cut', LONG, async () => {
    await requireMediaTools()
    const frames = Array.from({ length: 6 }, (_, i) => smoothFrame(32, 24, i))
    // The samples Python's loop keeps (frames until the first whose time is past 0.2 s), printed by .venv's PyAV.
    for (const [clip, rate, kept] of [['a_s16.wav', 44100, 12288], ['a_mono.mp3', 44100, 8111]] as const) {
      const out = outPath('mp4')
      await encodeVideo({
        input: { kind: 'rgb', w: 32, h: 24, frames: framesOf(frames) }, out, fps: pyStreamRate(30), quality: { crf: 20, preset: 'veryfast' },
        sound: { source: { path: clipPath(clip), stream: 'first', cutSeconds: 0.2 }, layout: 'stereo', rate },
        userId: null, roots: [...CLIP_ROOTS, ...ROOTS()],
      })
      const p = await probeMedia(out, { userId: null, roots: ROOTS() })
      expect(p.sound.map(s => ({ codec: s.codec, rate: s.rate, channels: s.channels })), clip).toEqual([{ codec: 'aac', rate, channels: 2 }])
      const back = await decodeAudio(out, { decoder: 'fltp', userId: null, maxSamples: BIG, roots: ROOTS() })
      // AAC ends on whole 1024-sample frames; the decoded end padding is R5.5's to fix against a Python fixture.
      expect(back.channels[0]!.length, clip).toBeGreaterThanOrEqual(kept)
      expect(back.channels[0]!.length, clip).toBeLessThan(kept + 1024)
    }
  })

  it('a sound file outside the person’s folders is refused', LONG, async () => {
    await requireMediaTools()
    await expect(encodeVideo({
      input: { kind: 'rgb', w: 16, h: 16, frames: framesOf([smoothFrame(16, 16, 0)]) }, out: outPath('mp4'), fps: { num: 24, den: 1 }, quality: PYAV_H264_DEFAULT,
      sound: { source: { path: clipPath('a_s16.wav'), stream: 'first' }, layout: 'stereo', rate: 44100 }, userId: null, roots: ROOTS(),
    })).rejects.toThrow(MEDIA_WORDS.unreadable)
  })
})

describe('Turntable’s stitch_clips (R3.17)', () => {
  it('joins three clips (one of another size): Σ − 2 frames, the first clip’s rate and size, frames in order, equal to the OpenH264 run', LONG, async () => {
    await requireMediaTools()
    for (const [name, sha] of Object.entries(FIX.encodeClips)) expect(sha256Hex(readFileSync(clipPath(name))), name).toBe(sha)
    const paths = C.stitch.clips.map(clipPath)
    const first = await probeMedia(paths[0]!, { userId: null, roots: CLIP_ROOTS })
    const out = outPath('mp4')
    const r = await encodeVideo({ input: { kind: 'clips', paths, dropFirstAfterFirst: true }, out, fps: pyFrameRate(first), quality: { crf: 20, preset: 'veryfast' }, userId: null, roots: CLIP_ROOTS })
    // 5 + 4 + 4.
    expect(r.frames).toBe(13)
    await expectSameNumbers(out, C.stitch.x264, 'stitch')
    const got = await decodeAll(out)
    expect(got.frames.length).toBe(13)
    expect(got.pts).toEqual(Array.from({ length: 13 }, (_, i) => i / 24))
    const m = expectH264(got.frames, C.stitch.openh264, C.stitch.x264, null, 'stitch')
    console.info(`[media-encode] stitch mean difference from libx264 ${m.mean}`)
  })
})

describe('encodeAudio equals AudioSaveHelper.save_audio', () => {
  const measured: Record<string, number | 'exact'> = {}
  afterAll(() => { console.info('[media-encode] save_audio measured SNR (dB)', JSON.stringify(measured)) })

  it('uses the encoder input formats PyAV picks, and Opus’s rates', () => {
    for (const c of C.saveAudio) expect(SAVE_AUDIO_SAMPLE_FMT[c.format], `${c.format}`).toBe(c.encoderSampleFmt)
    expect(C.saveAudio.filter(c => c.format === 'opus').map(c => c.encoderRate)).toEqual([48000, 48000])
    expect([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 96000].map(opusRate)).toEqual([8000, 12000, 12000, 16000, 24000, 24000, 48000, 48000, 48000, 48000])
  })

  for (const c of C.saveAudio) {
    const label = `${c.format} ${c.quality} ${c.channels === 1 ? 'mono' : 'stereo'}`
    it(`${label}: decodes like Python's file, with its tags`, LONG, async () => {
      await requireMediaTools()
      const sound: DecodedSound = { rate: c.rate, channels: channelsOf(c.input, c.channels) }
      const out = outPath(c.format)
      const tags = { prompt: c.tags.prompt ?? c.tags['stream:prompt']!, workflow: c.tags.workflow ?? c.tags['stream:workflow']! }
      await encodeAudio({ sound, format: c.format, quality: c.quality, sampleFmt: SAVE_AUDIO_SAMPLE_FMT[c.format], out, metadata: tags, userId: null })
      const ours = await decodeAudio(out, { decoder: 'load', userId: null, maxSamples: BIG, roots: ROOTS() })
      const want = channelsOf(c.decoded.f32z!, c.decoded.rows)
      expect(ours.rate, label).toBe(c.decoded.rate)
      expect(ours.channels.map(ch => ch.length), label).toEqual(want.map(ch => ch.length))
      const s = snr(want, ours.channels)
      measured[label] = s === Number.POSITIVE_INFINITY ? 'exact' : Math.round(s * 10) / 10
      // FLAC is lossless and MP3 the same LAME: exact. Opus: another libopus version (OPUS_SNR_DB).
      if (c.format === 'opus') expect(s, label).toBeGreaterThanOrEqual(OPUS_SNR_DB)
      else expect(s, `${label}: decodes exactly`).toBe(Number.POSITIVE_INFINITY)
      const t = await tagsOf(out)
      const got = { prompt: t.prompt ?? t['stream:prompt'], workflow: t.workflow ?? t['stream:workflow'] }
      expect(got, label).toEqual(tags)
    })
  }

  it('refuses more than two channels before any work, as PyAV does', async () => {
    const started = mediaLimiter().started()
    const three: DecodedSound = { rate: 44100, channels: [new Float32Array(10), new Float32Array(10), new Float32Array(10)] }
    await expect(encodeAudio({ sound: three, format: 'flac', quality: '128k', sampleFmt: 's16', out: outPath('flac'), userId: null })).rejects.toThrow(MEDIA_WORDS.failed)
    expect(mediaLimiter().started()).toBe(started)
  })
})

describe('torchaudio.functional.resample, ported (ruling j)', () => {
  it('is within a millionth of torchaudio on every sample, at every rate pair Opus export meets', () => {
    let worst = 0
    for (const c of C.resample) {
      const input = channelsOf(c.input, 2)
      const want = channelsOf(c.output, 2)
      const got = resampleLikeTorchaudio(input, c.orig, c.new)
      for (let ch = 0; ch < 2; ch++) {
        expect(got[ch]!.length, `${c.orig}→${c.new}`).toBe(c.samples)
        for (let i = 0; i < c.samples; i++) worst = Math.max(worst, Math.abs(got[ch]![i]! - want[ch]![i]!))
      }
    }
    console.info(`[media-encode] resample worst difference ${worst}`)
    expect(worst).toBeLessThanOrEqual(1e-6)
  })
})

describe('the runner’s own files', () => {
  it('floatWav reads back bit-equal through Python’s load (decodeAudio \'load\')', LONG, async () => {
    await requireMediaTools()
    const s: DecodedSound = { rate: 44100, channels: [new Float32Array([0, 0.5, -1, 1e-30, 3.5]), new Float32Array([-0.25, 1, 0, -2, 0.125])] }
    const p = outPath('wav')
    writeFileSync(p, floatWav(s))
    const back = await decodeAudio(p, { decoder: 'load', userId: null, maxSamples: BIG, roots: ROOTS() })
    expect(back.rate).toBe(44100)
    expect(back.channels).toEqual(s.channels)
  })

  it('writeFfv1 keeps frames losslessly, and the same frames make the same file', LONG, async () => {
    await requireMediaTools()
    const frames = [synth(33, 25, 3, 7), synth(33, 25, 3, 8), smoothFrame(33, 25, 1)]
    const a = outPath('mkv')
    const b = outPath('mkv')
    await writeFfv1({ frames: framesOf(frames), w: 33, h: 25, out: a, userId: null })
    await writeFfv1({ frames: framesOf(frames), w: 33, h: 25, out: b, userId: null })
    expect(sha256Hex(readFileSync(a))).toBe(sha256Hex(readFileSync(b)))
    const back = await decodeAll(a)
    expect(back.frames.map(sha256Hex)).toEqual(frames.map(sha256Hex))
  })

  it('writeFfv1 refuses a frame of the wrong size', LONG, async () => {
    await requireMediaTools()
    const out = outPath('mkv')
    await expect(writeFfv1({ frames: framesOf([synth(8, 8, 3, 1), new Uint8Array(5)]), w: 8, h: 8, out, userId: null })).rejects.toThrow(MEDIA_WORDS.sizeChanged)
    expect(existsSync(out)).toBe(false)
  })

  it('ffmetadataText escapes what the ffmetadata reader treats as syntax', () => {
    expect(ffmetadataText({ 'a=b': 'x;y#z\\w\nv' })).toBe(';FFMETADATA1\na\\=b=x\\;y\\#z\\\\w\\\nv\n')
  })
})

describe('safety', () => {
  it('the encoders’ options are allowed only with the values the module writes', () => {
    const head = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', '-framerate', '1', '-i', 'pipe:0']
    const ok = [...head, '-map_metadata', '-1', '-fflags', '+bitexact', '-enc_time_base:v', '100/2997', '-movflags', '+faststart+use_metadata_tags', 'pipe:1']
    expect(() => checkArgs('ffmpeg', ok)).not.toThrow()
    for (const [what, bad] of [
      ['-fflags other than +bitexact', ['-fflags', '+genpts']],
      ['-map_metadata naming a stream', ['-map_metadata', '0:s:0']],
      ['-movflags with a path-like value', ['-movflags', '/tmp/x']],
      ['-enc_time_base as a word', ['-enc_time_base:v', 'demux']],
      ['-metadata on the command line', ['-metadata', 'prompt=x']],
      ['-attach', ['-attach', '/etc/passwd']],
    ] as const) expect(() => checkArgs('ffmpeg', [...head, ...bad, 'pipe:1']), what).toThrow(MediaError)
  })

  it('an odd width or height fails before any work', async () => {
    const started = mediaLimiter().started()
    await expect(encodeVideo({ input: { kind: 'rgb', w: 63, h: 48, frames: framesOf([]) }, out: outPath('mp4'), fps: { num: 24, den: 1 }, quality: PYAV_H264_DEFAULT, userId: null }))
      .rejects.toThrow(MEDIA_WORDS.oddSize)
    await expect(encodeVideo({ input: { kind: 'rgb', w: 64, h: 47, frames: framesOf([]) }, out: outPath('mp4'), fps: { num: 24, den: 1 }, quality: PYAV_H264_DEFAULT, userId: null }))
      .rejects.toThrow(MEDIA_WORDS.oddSize)
    expect(mediaLimiter().started()).toBe(started)
  })

  it('never writes over an existing file at `out`', LONG, async () => {
    await requireMediaTools()
    const out = outPath('mp4')
    writeFileSync(out, 'mine')
    await expect(encodeVideo({ input: { kind: 'rgb', w: 16, h: 16, frames: framesOf([smoothFrame(16, 16, 0)]) }, out, fps: { num: 24, den: 1 }, quality: PYAV_H264_DEFAULT, userId: null }))
      .rejects.toThrow(MEDIA_WORDS.failed)
    expect(readFileSync(out, 'utf8')).toBe('mine')
  })

  it('a symlink in the job’s folder named like an output is refused before the tool starts, and its target is untouched', LONG, async () => {
    await requireMediaTools()
    const work = await mediaTempDir()
    const elsewhere = mkdtempSync(join(tmpdir(), 'media-encode-elsewhere-'))
    try {
      const target = join(elsewhere, 'victim.raw')
      writeFileSync(target, 'untouched')
      symlinkSync(target, join(work, 'looks-safe.raw'))
      const started = mediaLimiter().started()
      await expect(runMedia({
        tool: 'ffmpeg', userId: null, workDir: work,
        args: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', '-framerate', '1', '-i', 'pipe:0', '-f', 'rawvideo', '-y', `file:${join(work, 'looks-safe.raw')}`],
        stdin: framesOf([synth(8, 8, 3, 1)]),
      })).rejects.toThrow(MEDIA_WORDS.failed)
      expect(mediaLimiter().started()).toBe(started)
      expect(readFileSync(target, 'utf8')).toBe('untouched')
      // A symlinked folder inside the job's folder is refused too.
      symlinkSync(elsewhere, join(work, 'sub'))
      await expect(confineOutputs(['-f', 'rawvideo', `file:${join(work, 'sub', 'x.raw')}`], work)).rejects.toThrow(MediaError)
      expect(existsSync(join(elsewhere, 'x.raw'))).toBe(false)
      // A plain new name is made there, as a regular file.
      await confineOutputs(['-f', 'rawvideo', `file:${join(work, 'ok.raw')}`], work)
      expect(existsSync(join(work, 'ok.raw'))).toBe(true)
    }
    finally {
      await removeMediaTempDir(work)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('Stop during an encode ends it and leaves nothing behind', LONG, async () => {
    await requireMediaTools()
    const ac = new AbortController()
    const out = outPath('mp4')
    async function* slow(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 1000; i++) {
        if (i === 3) setTimeout(() => ac.abort(), 10)
        await new Promise(r => setTimeout(r, 20))
        yield smoothFrame(64, 48, i)
      }
    }
    const t0 = Date.now()
    await expect(encodeVideo({ input: { kind: 'rgb', w: 64, h: 48, frames: slow() }, out, fps: { num: 24, den: 1 }, quality: PYAV_H264_DEFAULT, userId: null, signal: ac.signal }))
      .rejects.toThrow(MediaError)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(existsSync(out)).toBe(false)
  })
})
