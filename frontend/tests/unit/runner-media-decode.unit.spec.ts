/**
 * Task R5.1b: the media module's decoders (server/media/decode.ts) against
 * the real PyAV. Pictures byte-equal to VideoFromFile.get_components'
 * `to_ndarray('rgb24')`; sound bit-equal to nodes_audio.load,
 * nodes_replicate._download_url_to_audio_dict and get_components' sound, as
 * scripts/runner_media_fixtures.py --group decode recorded them. Needs the
 * real build (R5.1a).
 */
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { chromaSubsampling, decodeAudio, decodeFrames, framesFilter, type DecodedSound, type SoundDecoder } from '~~/server/media/decode'
import { MEDIA_WORDS } from '#shared/runner/media'
import {
  CLIP_ROOTS, clipPath, deinterleave, f32, mediaFixture, requireMediaTools, sha256Hex, soundBytes, type DecodeCase, type PySound,
} from './__runner__/mediaParity'

const FIX = mediaFixture<DecodeCase>('decode')
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER

/**
 * Cases that can't be made bit-equal, each named in the R5.1b report:
 * Opus decodes some floats a last bit apart (159 of 96,000 samples, at most
 * 2⁻²⁴): FFmpeg's float Opus decoder built by a different compiler from
 * PyAV's wheel. Re-measured with libopus 1.6.1 (PyAV's own version, R5.1c):
 * still the same 159 samples, so the version was not the cause. Measured,
 * not guessed: the fixture keeps Python's whole sound, and every sample is
 * checked against the bound.
 */
const OPUS_ULP = new Set(['a_opus.webm'])
/** How many of the Opus clip's samples are a last bit off (measured on this build). */
const OPUS_DIFFER = 159

function isSound(x: PySound | { error: string } | null | undefined): x is PySound {
  return !!x && !('error' in x)
}

/** Compares a decode with Python's record; `interleaved`: Python's row is one packed stereo row (ruling k). */
function expectSound(got: DecodedSound, want: PySound, label: string, o: { interleaved?: number; ulp?: PySound } = {}): void {
  expect(got.rate, label).toBe(want.rate)
  let wantChannels: Float32Array[] | null = null
  if (want.f32) {
    const flat = f32(want.f32)
    wantChannels = o.interleaved
      ? deinterleave(flat, o.interleaved)
      : Array.from({ length: want.rows }, (_, c) => flat.subarray(c * want.samples, (c + 1) * want.samples))
  }
  const channels = o.interleaved ?? want.rows
  const samples = o.interleaved ? want.samples / o.interleaved : want.samples
  expect(got.channels.length, label).toBe(channels)
  for (const ch of got.channels) expect(ch.length, label).toBe(samples)
  if (o.ulp) {
    // The fixture keeps the whole sound for a named case: every sample within the bound, and the count exact.
    const all = f32(inflateSync(Buffer.from(o.ulp.f32z!, 'base64')).toString('base64'))
    let worst = 0
    let differ = 0
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < samples; i++) {
        const d = Math.abs(got.channels[c]![i]! - all[c * samples + i]!)
        if (d) differ++
        worst = Math.max(worst, d)
      }
    }
    expect(worst, label).toBeLessThanOrEqual(2 ** -24)
    expect(differ, label).toBe(OPUS_DIFFER)
    return
  }
  if (o.interleaved) {
    // Python's bytes are the interleaved row: interleave ours back and compare hashes.
    const row = new Float32Array(channels * samples)
    for (let i = 0; i < samples; i++) for (let c = 0; c < channels; c++) row[i * channels + c] = got.channels[c]![i]!
    expect(sha256Hex(new Uint8Array(row.buffer)), label).toBe(want.sha256)
    if (wantChannels) expect(got.channels, label).toEqual(wantChannels)
    return
  }
  expect(sha256Hex(soundBytes(got.channels)), label).toBe(want.sha256)
}

describe('decodeFrames equals PyAV’s to_ndarray(rgb24)', () => {
  it('is byte-equal on every clip (H.264 untagged, BT.709 and full range, 4:4:4 at 8 bits, full range and 10 bits, 4:2:2 at 10 bits, HEVC 10-bit, VP9 63×47, ProRes, VFR, Matroska, the live WebM)', LONG, async () => {
    await requireMediaTools()
    let clips = 0
    for (const c of FIX.cases) {
      const path = clipPath(c.clip)
      if ('error' in c.frames) {
        if (/No video stream/.test(c.frames.error)) {
          await expect(decodeFrames(path, { userId: null, roots: CLIP_ROOTS, maxFrames: BIG, onFrame: async () => {} }), c.clip).rejects.toThrow(MEDIA_WORDS.noVideo)
        }
        continue
      }
      const want = c.frames
      const got: string[] = []
      const inline: (string | undefined)[] = []
      const r = await decodeFrames(path, {
        userId: null, roots: CLIP_ROOTS, maxFrames: BIG,
        onFrame: async (rgb, i) => {
          expect(i, c.clip).toBe(got.length)
          got.push(sha256Hex(rgb))
          inline.push(want.list[i]?.rgb ? Buffer.from(rgb).toString('base64') : undefined)
        },
      })
      expect({ count: r.count, w: r.w, h: r.h }, c.clip).toEqual({ count: want.list.length, w: want.w, h: want.h })
      // The pictures themselves where they are small enough to keep, so a mismatch shows where.
      want.list.forEach((f, i) => { if (f.rgb) expect(inline[i], `${c.clip} frame ${i}`).toBe(f.rgb) })
      expect(got, c.clip).toEqual(want.list.map(f => f.sha256))
      clips++
    }
    expect(clips).toBe(17)
  })

  it('drops the edit-list clip’s frames stamped before zero: 6 of its 8 frames, as Python', LONG, async () => {
    await requireMediaTools()
    const pts: number[] = []
    const r = await decodeFrames(clipPath('v_editlist.mp4'), { userId: null, roots: CLIP_ROOTS, maxFrames: BIG, onFrame: async (_rgb, _i, t) => { pts.push(t) } })
    expect(r.count).toBe(6)
    expect(pts).toEqual([0, 1, 2, 3, 4, 5].map(i => (i * 512) / 12288))
  })

  it('hands each frame its pts in seconds (the VFR clip’s own stamps)', LONG, async () => {
    await requireMediaTools()
    const pts: number[] = []
    await decodeFrames(clipPath('v_vfr.mp4'), { userId: null, roots: CLIP_ROOTS, maxFrames: BIG, onFrame: async (_rgb, _i, t) => { pts.push(t) } })
    expect(pts.map(t => Math.round(t * 1000))).toEqual([0, 40, 70, 130, 160, 230, 250, 300])
  })

  it('fails with sizeChanged when the frames change size, as Python’s torch.stack does', LONG, async () => {
    await requireMediaTools()
    const c = FIX.cases.find(k => k.clip === 'x_vp9_resize.webm')!
    expect('error' in c.frames && c.frames.error).toMatch(/stack expects each tensor to be equal size/)
    const seen: number[] = []
    await expect(decodeFrames(clipPath(c.clip), { userId: null, roots: CLIP_ROOTS, maxFrames: BIG, onFrame: async (_rgb, i) => { seen.push(i) } }))
      .rejects.toThrow(MEDIA_WORDS.sizeChanged)
    // ffmpeg names the new size before its bytes arrive, so the failure may come before the third frame is handed on.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen).toEqual([0, 1, 2].slice(0, seen.length))
  })

  it('fails with tooManyFrames as it streams, past maxFrames', LONG, async () => {
    await requireMediaTools()
    let n = 0
    await expect(decodeFrames(clipPath('v_h264_601.mp4'), { userId: null, roots: CLIP_ROOTS, maxFrames: 3, onFrame: async () => { n++ } }))
      .rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    expect(n).toBe(3)
  })

  it('Stop mid-decode kills ffmpeg at once, with the pictures paused behind a slow reader', LONG, async () => {
    await requireMediaTools()
    const stop = new AbortController()
    let t0 = 0
    let seen = 0
    const job = decodeFrames(clipPath('v_stereo_aac.mp4'), {
      userId: null, roots: CLIP_ROOTS, signal: stop.signal, maxFrames: BIG,
      onFrame: async () => {
        seen++
        if (seen === 2) { t0 = Date.now(); stop.abort(); await new Promise(r => setTimeout(r, 50)) }
      },
    })
    await expect(job).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(seen).toBe(2)
  })

  it('names the chroma siting only on a subsampled axis, only when the file does, from fixed words', () => {
    const base = 'select=gte(pts\\,0),scale=w=iw:h=ih:eval=frame:flags=bilinear'
    expect(framesFilter({ chromaLocation: null, pixFmt: 'yuv420p' })).toBe(`${base},format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuv420p' })).toBe(`${base}:in_h_chr_pos=0:in_v_chr_pos=128,format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuv420p10le' })).toBe(`${base}:in_h_chr_pos=0:in_v_chr_pos=128,format=rgb24`)
    expect(framesFilter({ chromaLocation: 'topleft', pixFmt: 'nv12' })).toBe(`${base}:in_h_chr_pos=0:in_v_chr_pos=0,format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuv422p10le' })).toBe(`${base}:in_h_chr_pos=0,format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuv444p' })).toBe(`${base},format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuvj444p' })).toBe(`${base},format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'yuv444p10le' })).toBe(`${base},format=rgb24`)
    expect(framesFilter({ chromaLocation: 'center', pixFmt: 'yuv440p' })).toBe(`${base}:in_v_chr_pos=128,format=rgb24`)
    expect(framesFilter({ chromaLocation: 'left', pixFmt: 'gbrp' })).toBe(`${base},format=rgb24`)
    expect(framesFilter({ chromaLocation: 'x,movie=/etc/passwd', pixFmt: 'yuv420p' })).not.toContain('movie')
    expect(chromaSubsampling('yuvj422p')).toEqual({ w: true, h: false })
    expect(chromaSubsampling('rgb24')).toBeNull()
  })
})

describe('decodeAudio equals Python', () => {
  const run = (clip: string, decoder: SoundDecoder, stream?: 'first' | 'last') =>
    decodeAudio(clipPath(clip), { decoder, stream, userId: null, roots: CLIP_ROOTS, maxSamples: BIG })

  it("'load' is bit-equal to nodes_audio.load on every clip with sound (Opus within its named last bit)", LONG, async () => {
    await requireMediaTools()
    let n = 0
    for (const c of FIX.cases) {
      if (!isSound(c.load)) {
        if ('error' in c.load && /No audio stream/.test(c.load.error)) await expect(run(c.clip, 'load'), c.clip).rejects.toThrow(MEDIA_WORDS.noSound)
        continue
      }
      expect(c.load.dtype).toBe('torch.float32')
      expectSound(await run(c.clip, 'load'), c.load, c.clip, { ulp: OPUS_ULP.has(c.clip) ? c.load : undefined })
      n++
    }
    expect(n).toBe(15)
  })

  it("'download' is bit-equal to _download_url_to_audio_dict, with a packed stereo file read into its channels (ruling k)", LONG, async () => {
    await requireMediaTools()
    const unscrambled: string[] = []
    for (const c of FIX.cases) {
      if (!isSound(c.download)) continue
      const got = await run(c.clip, 'download')
      const load = c.load as PySound
      // Python leaves a packed file with more than one channel as one interleaved row.
      const interleaved = c.download.rows === 1 && load.rows > 1 ? load.rows : undefined
      if (interleaved) unscrambled.push(c.clip)
      if (OPUS_ULP.has(c.clip)) {
        // Python's download of this float sound is its load, value for value (no integer scale, peak under 1.5).
        expect(c.download.sha256).toBe(load.sha256)
        expectSound(got, c.download, c.clip, { ulp: load })
        continue
      }
      expectSound(got, c.download, c.clip, { interleaved })
    }
    expect(unscrambled.sort()).toEqual(['a_16.flac', 'a_24.flac', 'a_s16.wav', 'a_s24.wav', 'a_s32.wav'])
  })

  it("'download' scales integer samples to their peak, as Python (s16 and s32 WAVs, the −32768 one)", LONG, async () => {
    await requireMediaTools()
    const s = await run('a_min.wav', 'download')
    let peak = 0
    for (const ch of s.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBe(1)
    const l = await run('a_min.wav', 'load')
    expect(Math.min(...l.channels[0]!)).toBe(-1)
  })

  it("'fltp' is bit-equal to get_components’ sound: the last stream, samples before 0 skipped, after Python's seek (ffmpeg-muxed MP4s too)", LONG, async () => {
    await requireMediaTools()
    let n = 0
    for (const c of FIX.cases) {
      if (!isSound(c.components)) continue
      expectSound(await run(c.clip, 'fltp'), c.components, c.clip)
      n++
    }
    // v_stereo_aac.mp4 and v_two_sounds.mkv (PyAV-muxed), v_ffmux_copy.mp4 and v_ffmux_nob.mp4 (ffmpeg-muxed, R5.1c).
    expect(n).toBe(4)
    // v_ffmux_nob.mp4: the video starts at decode time 0 and the AAC priming packet comes first, so Python's
    // seek skips that packet and the decoder starts cold on the next: without the same seek the mirror
    // differed on every sample (measured before decode.ts pythonSeekArgs). A remux that keeps the
    // B-frames' early decode times (v_ffmux_copy.mp4) reads as its source does.
    const copy = FIX.cases.find(k => k.clip === 'v_ffmux_copy.mp4')!.components as PySound
    const source = FIX.cases.find(k => k.clip === 'v_stereo_aac.mp4')!.components as PySound
    expect(copy.sha256).toBe(source.sha256)
    // v_two_sounds.mkv: the last stream is the stereo 48 kHz one, its first 1008 samples (21 ms) skipped.
    const two = FIX.cases.find(k => k.clip === 'v_two_sounds.mkv')!.components as PySound
    expect([two.rows, two.rate]).toEqual([2, 48000])
  })

  it('fails with tooLong as it streams, past maxSamples', LONG, async () => {
    await requireMediaTools()
    await expect(decodeAudio(clipPath('a_long_8k.wav'), { decoder: 'load', userId: null, roots: CLIP_ROOTS, maxSamples: 100_000 }))
      .rejects.toThrow(MEDIA_WORDS.tooLong)
  })
})
