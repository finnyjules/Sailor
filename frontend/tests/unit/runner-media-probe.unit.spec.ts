/**
 * Task R5.1b: the media module's probe (server/media/probe.ts) against the
 * real PyAV. Every standard clip's header and VideoFromFile's own helpers
 * (_get_raw_duration, get_frame_count, get_frame_rate, get_dimensions),
 * recorded by scripts/runner_media_fixtures.py --group probe, must come out
 * the same from Sailor's own ffprobe. Needs the real build (R5.1a).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkMediaCaps, limitDenominator, probeMedia, pyFrameCount, pyFrameRate, pyRawDuration, type MediaProbe,
} from '~~/server/media/probe'
import { askTool, parseProtocols } from '~~/server/media/tools'
import { MEDIA_WORDS } from '#shared/runner/media'
import { clipPath, mediaFixture, requireMediaTools, sha256Hex, type ProbeCase } from './__runner__/mediaParity'

const FIX = mediaFixture<ProbeCase>('probe')
const LONG = { timeout: 120_000 }

/** PyAV's AVColorRange / AVColorSpace numbers as ffprobe names them (unspecified: null). */
const RANGE: Record<number, string | null> = { 0: null, 1: 'tv', 2: 'pc' }
const SPACE: Record<number, string | null> = { 0: 'gbr', 1: 'bt709', 2: null, 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020nc' }
/** PyAV names the decoder; ffprobe the codec. */
const CODEC: Record<string, string> = { mp3float: 'mp3' }

async function probeOf(clip: string): Promise<MediaProbe> {
  return probeMedia(clipPath(clip), { userId: null })
}

describe('the fixture', () => {
  it('was written by PyAV 17 on this platform, over the clips in fixtures/media', () => {
    expect(FIX.av).toBe('17.0.0')
    expect(FIX.libraries.libavcodec).toEqual([62, 11, 100])
    expect(FIX.libraries.libswscale).toEqual([9, 1, 100])
    for (const [name, sha] of Object.entries(FIX.clips)) expect(sha256Hex(readFileSync(clipPath(name))), name).toBe(sha)
  })
})

describe('probeMedia equals PyAV', () => {
  it('reads every clip’s header as PyAV does', LONG, async () => {
    await requireMediaTools()
    for (const c of FIX.cases) {
      const p = await probeOf(c.clip)
      const h = c.header
      expect(p.formatName, c.clip).toBe(h.formatName)
      expect(p.containerDuration, c.clip).toBe(h.containerDuration)
      expect(p.bytes, c.clip).toBe(h.bytes)
      expect(p.video.map(v => ({ ...v, chromaLocation: undefined })), c.clip).toEqual(h.video.map(v => ({
        index: v.index, w: v.w, h: v.h, codec: CODEC[v.codec] ?? v.codec, pixFmt: v.pixFmt,
        averageRate: v.averageRate, frames: v.frames || null, duration: v.duration, timeBase: v.timeBase,
        colorRange: RANGE[v.colorRange], colorSpace: SPACE[v.colorSpace], chromaLocation: undefined,
      })))
      expect(p.sound, c.clip).toEqual(h.sound.map(s => ({
        index: s.index, rate: s.rate, channels: s.channels, layout: s.layout, codec: CODEC[s.codec] ?? s.codec,
        sampleFmt: s.sampleFmt, duration: s.duration, timeBase: s.timeBase,
        measuredSeconds: s.duration === null && h.containerDuration === null ? expect.any(Number) : null,
      })))
    }
  })

  it('pyRawDuration equals _get_raw_duration on every clip (the live WebM counts its packets and the flush packet)', LONG, async () => {
    await requireMediaTools()
    let counted = 0
    for (const c of FIX.cases) {
      const p = await probeOf(c.clip)
      if (p.videoPackets !== null) counted++
      if ('value' in c.rawDuration) expect(pyRawDuration(p), c.clip).toBe(c.rawDuration.value)
      else expect(pyRawDuration(p), c.clip).toBeNull()
    }
    expect(counted).toBe(1)   // v_vp9_live.webm: no length anywhere in its header
  })

  it('pyFrameCount equals get_frame_count where Python answers; where Python raises TypeError on its flush packet, it counts the packets the loop means', LONG, async () => {
    await requireMediaTools()
    const differs: string[] = []
    for (const c of FIX.cases) {
      const p = await probeOf(c.clip)
      const got = pyFrameCount(p, clipPath(c.clip), { userId: null })
      if ('value' in c.frameCount) await expect(got, c.clip).resolves.toBe(c.frameCount.value)
      else if (c.frameCount.error.startsWith('TypeError')) {
        differs.push(c.clip)
        await expect(got, c.clip).resolves.toBe((c as ProbeCase & { frameCountIntended: number }).frameCountIntended)
      }
      else {
        expect(c.frameCount.error, c.clip).toMatch(/No video stream/)
        await expect(got, c.clip).rejects.toThrow(MEDIA_WORDS.noVideo)
      }
    }
    expect(differs.sort()).toEqual(['v_two_sounds.mkv', 'v_vp9_live.webm', 'v_vp9_odd.webm', 'x_vp9_resize.webm'])
  })

  it('pyFrameRate and the first video stream’s size equal get_frame_rate and get_dimensions on every clip', LONG, async () => {
    await requireMediaTools()
    for (const c of FIX.cases) {
      const p = await probeOf(c.clip)
      if ('value' in c.frameRate) expect(pyFrameRate(p), c.clip).toEqual(c.frameRate.value)
      else expect(() => pyFrameRate(p), c.clip).toThrow(MEDIA_WORDS.noVideo)
      if ('value' in c.dimensions) expect([p.video[0]!.w, p.video[0]!.h], c.clip).toEqual(c.dimensions.value)
      else expect(p.video, c.clip).toEqual([])
    }
  })
})

describe('get_frame_rate’s fallback: Fraction(frames / seconds).limit_denominator()', () => {
  const probe = (frames: number, us: number): MediaProbe => ({
    format: 'mp4', formatName: 'mov', containerDuration: us, bytes: 0, videoPackets: null, sound: [],
    video: [{ index: 0, w: 2, h: 2, codec: 'h264', pixFmt: 'yuv420p', averageRate: null, frames, duration: null, timeBase: { num: 1, den: 1000 }, colorRange: null, colorSpace: null, chromaLocation: null }],
  })
  it('matches CPython 3.12 (answers printed by .venv/bin/python)', () => {
    expect(pyFrameRate(probe(240, 10_010_000))).toEqual({ num: 24000, den: 1001 })
    expect(pyFrameRate(probe(8, 340_000))).toEqual({ num: 400, den: 17 })
    expect(pyFrameRate(probe(7, 3_000_000))).toEqual({ num: 7, den: 3 })
    expect(pyFrameRate(probe(1000, 33_366_700))).toEqual({ num: 10_000_000, den: 333_667 })
    expect(pyFrameRate(probe(0, 3_000_000))).toEqual({ num: 1, den: 1 })
    // The docstring's own examples.
    expect(limitDenominator(3141592653589793n, 1000000000000000n, 10n)).toEqual([22n, 7n])
    expect(limitDenominator(3141592653589793n, 1000000000000000n, 100n)).toEqual([311n, 99n])
    expect(limitDenominator(4321n, 8765n, 10000n)).toEqual([4321n, 8765n])
  })
})

describe('the real build', () => {
  it('lists only the file and pipe protocols', async () => {
    const t = await requireMediaTools()
    const a = await askTool(t.ffmpeg, ['-hide_banner', '-protocols'])
    expect(a.ok).toBe(true)
    const p = parseProtocols(a.out)
    expect(p.input).toEqual(['file', 'pipe'])
    expect(p.output).toEqual(['file', 'pipe'])
  })
})

describe('checkMediaCaps on real clips', () => {
  it('passes every standard clip in hosted and local, and says which kind is missing', LONG, async () => {
    await requireMediaTools()
    for (const c of FIX.cases) {
      const p = await probeOf(c.clip)
      for (const hosted of [true, false]) {
        const kind = p.video.length ? 'video' : 'sound'
        expect(checkMediaCaps(p, kind, hosted), `${c.clip} ${hosted}`).toBeNull()
      }
      if (!p.video.length) expect(checkMediaCaps(p, 'video', true)).toBe(MEDIA_WORDS.noVideo)
      if (!p.sound.length) expect(checkMediaCaps(p, 'sound', true)).toBe(MEDIA_WORDS.noSound)
    }
  })
})
