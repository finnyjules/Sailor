/**
 * Task R5.1b: the media module's machinery (server/media/run.ts, and the
 * refusals and caps in probe.ts / decode.ts), against a fake tools folder of
 * small shell scripts: nothing here needs the real build.
 *
 * The fakes stand in for `mediaTools()`; each scenario writes its own
 * ffmpeg / ffprobe bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaTools } from '~~/server/media/tools'

const fake = vi.hoisted(() => ({ tools: null as MediaTools | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return { ...real, mediaTools: async () => fake.tools }
})

const { MediaError, checkArgs, inputArgs, mediaLimiter, mediaTempDir, removeMediaTempDir, runMedia } = await import('~~/server/media/run')
const { probeMedia } = await import('~~/server/media/probe')
const { decodeAudio, decodeFrames } = await import('~~/server/media/decode')
const { mediaFormat } = await import('~~/server/runner/mediaInputs')
const { MEDIA_TOOLS_MISSING } = await import('~~/server/media/tools')
const { MEDIA_WORDS, MEDIA_MAX_ALLOC } = await import('#shared/runner/media')

let dir: string
const HOSTED_KEY = 'NUXT_CLERK_SECRET_KEY'
let savedKey: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-run-spec-'))
  savedKey = process.env[HOSTED_KEY]
  delete process.env[HOSTED_KEY]
})
afterEach(() => {
  fake.tools = null
  if (savedKey === undefined) delete process.env[HOSTED_KEY]
  else process.env[HOSTED_KEY] = savedKey
  rmSync(dir, { recursive: true, force: true })
})

/** Writes fake ffmpeg / ffprobe scripts (sh, absolute tool paths: the job's environment has no PATH). */
function fakeTools(o: { ffmpeg?: string; ffprobe?: string }): MediaTools {
  const write = (name: string, body: string) => {
    const f = join(dir, name)
    writeFileSync(f, `#!/bin/sh\n${body}\n`)
    chmodSync(f, 0o755)
    return f
  }
  const t: MediaTools = {
    ffmpeg: write('ffmpeg', o.ffmpeg ?? `echo ran >> "${join(dir, 'ffmpeg.ran')}"`),
    ffprobe: write('ffprobe', o.ffprobe ?? 'exit 1'),
    version: 'ffmpeg version 8.0.3-sailor1', buildconf: [], encoders: new Set(), protocols: { input: ['file', 'pipe'], output: ['file', 'pipe'] },
  }
  fake.tools = t
  return t
}

/** A file whose first bytes say MP4 (the probe's own answer comes from the fake ffprobe). */
function mp4File(name = 'clip.mp4'): string {
  const f = join(dir, name)
  writeFileSync(f, Buffer.concat([Buffer.from('\0\0\0\x20ftypisom\0\0\0\0'), Buffer.alloc(64)]))
  return f
}

/** A fake ffprobe answering with this JSON. */
const probeAnswer = (j: unknown) => `cat <<'JSON'\n${JSON.stringify(j)}\nJSON`
const video = (w: number, h: number, seconds: number) => ({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: seconds.toFixed(6) },
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: w, height: h, avg_frame_rate: '24/1', nb_frames: String(seconds * 24), time_base: '1/12288', duration_ts: seconds * 12288 }],
})
const sound = (channels: number, rate: number, seconds: number) => ({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: seconds.toFixed(6) },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', sample_fmt: 'fltp', sample_rate: String(rate), channels, time_base: `1/${rate}`, duration_ts: seconds * rate }],
})

const started = () => mediaLimiter().started()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('refusals before anything starts', () => {
  it('a relative path or a scheme: address is refused by inputArgs and probeMedia, and no tool starts', async () => {
    fakeTools({})
    for (const p of ['clip.mp4', './clip.mp4', 'file:/tmp/clip.mp4', 'http://example.com/a.mp4', 'pipe:0']) {
      expect(() => inputArgs(p, 'mp4'), p).toThrow(MEDIA_WORDS.unreadable)
    }
    const before = started()
    for (const p of ['clip.mp4', 'file:/tmp/clip.mp4', 'https://example.com/a.mp4']) {
      await expect(probeMedia(p, { userId: null }), p).rejects.toThrow(MEDIA_WORDS.unreadable)
    }
    expect(started()).toBe(before)
  })

  it('inputArgs whitelists file and pipe, names the demuxer, refuses data references on mov, and passes the path as file:', () => {
    expect(inputArgs('/a/b.mp4', 'mp4')).toEqual(['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-i', 'file:/a/b.mp4'])
    expect(inputArgs('/a/-y', 'webm')).toEqual(['-protocol_whitelist', 'file,pipe', '-f', 'matroska', '-i', 'file:/a/-y'])
    expect(inputArgs('/a/b', 'mkv')).toContain('matroska')
    expect(inputArgs('/a/b', 'avi')).toContain('avi')
    expect(() => inputArgs('/a/b', 'hls' as never)).toThrow(MEDIA_WORDS.unreadable)
  })

  it('an M3U8 playlist renamed .mp4 is refused by mediaFormat, and ffmpeg is never started for it', async () => {
    fakeTools({})
    const f = join(dir, 'playlist.mp4')
    writeFileSync(f, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nfile:///etc/passwd\n')
    expect(mediaFormat(readFileSync(f))).toBeNull()
    const before = started()
    await expect(probeMedia(f, { userId: null })).rejects.toThrow(MEDIA_WORDS.unreadable)
    await expect(decodeFrames(f, { userId: null, maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.unreadable)
    expect(started()).toBe(before)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('mediaFormat tells Matroska and AVI apart', () => {
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x88, ...Buffer.from('matroska')]))).toBe('mkv')
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x84, ...Buffer.from('webm')]))).toBe('webm')
    expect(mediaFormat(Buffer.from('RIFF\0\0\0\0AVI LIST'))).toBe('avi')
    expect(mediaFormat(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBe('wav')
  })

  it('checkArgs refuses options that read or write files the media names, other addresses, and outputs outside a job folder', async () => {
    const ok = ['-i', 'file:/a/b.mp4', '-f', 'rawvideo', 'pipe:1']
    expect(() => checkArgs(ok)).not.toThrow()
    for (const extra of [
      ['-report'], ['-dump_attachment:t', 'x'], ['-dump_attachment', 'x'], ['-filter_script', '/x'], ['-/filter', '/x'],
      ['-filter_complex_script', '/x'], ['-use_absolute_path', '1'], ['-enable_drefs', '1'], ['-progress', 'pipe:1'],
      ['-i', 'http://example.com/a.mp4'], ['-i', 'b.mp4'], ['-i', 'file:rel.mp4'], ['file:/tmp/out.mp4'], ['pipe:3'],
    ]) {
      expect(() => checkArgs([...ok.slice(0, 2), ...extra, ...ok.slice(2)]), extra.join(' ')).toThrow(MediaError)
    }
    expect(() => checkArgs([...ok, 'pipe:3'], { side: true })).not.toThrow()
    const out = await mediaTempDir()
    try {
      expect(() => checkArgs(['-i', 'file:/a/b.mp4', '-y', `file:${join(out, 'x.flac')}`])).not.toThrow()
      expect(() => checkArgs(['-i', 'file:/a/b.mp4', '-y', `file:${join(out, '..', 'x.flac')}`])).toThrow(MediaError)
    }
    finally { await removeMediaTempDir(out) }
  })

  it('with the tools missing, a job fails in plain words', async () => {
    fake.tools = null
    await expect(runMedia({ tool: 'ffmpeg', args: [], userId: null })).rejects.toThrow(MEDIA_TOOLS_MISSING)
  })
})

describe('every job', () => {
  it('starts with the fixed arguments and a minimal environment (no FFREPORT leaks in); hosted adds its thread limits', async () => {
    const log = join(dir, 'args.txt')
    fakeTools({ ffmpeg: `for a in "$@"; do echo "$a"; done > "${log}"; /usr/bin/env > "${join(dir, 'env.txt')}"` })
    process.env.FFREPORT = `file=${join(dir, 'report.log')}`
    try {
      await runMedia({ tool: 'ffmpeg', args: ['-i', 'file:/a/b.mp4', '-f', 'null', 'pipe:1'], userId: null })
    }
    finally { delete process.env.FFREPORT }
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', String(MEDIA_MAX_ALLOC), '-i', 'file:/a/b.mp4', '-f', 'null', 'pipe:1'])
    const env = readFileSync(join(dir, 'env.txt'), 'utf8')
    expect(env).toContain('LC_ALL=C')
    expect(env).not.toMatch(/FFREPORT|AV_LOG_FORCE|HOME=/)

    process.env[HOSTED_KEY] = 'sk_test_x'
    await runMedia({ tool: 'ffmpeg', args: ['-i', 'file:/a/b.mp4', '-f', 'null', 'pipe:1'], userId: 'u1' })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', String(MEDIA_MAX_ALLOC), '-filter_threads', '1',
      '-threads', '2', '-i', 'file:/a/b.mp4', '-f', 'null', 'pipe:1',
    ])
  })

  it('Stop kills a 10-second job within a second and removes its partial output', async () => {
    const partial = join(dir, 'partial.bin')
    fakeTools({ ffmpeg: `echo half > "${partial}"; exec /bin/sleep 10` })
    const stop = new AbortController()
    const t0 = Date.now()
    const job = runMedia({ tool: 'ffmpeg', args: [], userId: null, signal: stop.signal, cleanup: [partial] })
    await sleep(300)
    expect(existsSync(partial)).toBe(true)
    stop.abort()
    await expect(job).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(Date.now() - t0).toBeLessThan(1300)
    expect(existsSync(partial)).toBe(false)
  })

  it('a timeout does the same, with timedOut', async () => {
    const partial = join(dir, 'partial.bin')
    fakeTools({ ffmpeg: `echo half > "${partial}"; exec /bin/sleep 10` })
    const t0 = Date.now()
    await expect(runMedia({ tool: 'ffmpeg', args: [], userId: null, timeoutMs: 300, cleanup: [partial] })).rejects.toThrow(MEDIA_WORDS.timedOut)
    expect(Date.now() - t0).toBeLessThan(1300)
    expect(existsSync(partial)).toBe(false)
  })

  it('a job stopped while it waits never starts', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'exec /bin/sleep 1' })
    const before = started()
    const first = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    const stop = new AbortController()
    const second = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1', signal: stop.signal })
    await sleep(50)
    stop.abort()
    await expect(second).rejects.toThrow(MEDIA_WORDS.stopped)
    await first
    expect(started() - before).toBe(1)
    expect(mediaLimiter().pending('u1')).toBe(0)
  })

  it('stderr never reaches the error a person reads', async () => {
    fakeTools({ ffmpeg: 'echo "Error opening /private/secret/path.mp4: Permission denied" >&2; exit 1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const e = await runMedia({ tool: 'ffmpeg', args: [], userId: null }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(MediaError)
      expect((e as Error).message).toBe(MEDIA_WORDS.failed)
      expect(JSON.stringify(e)).not.toContain('secret')
      // It is logged for us, capped.
      expect(warn.mock.calls.flat().join(' ')).toContain('/private/secret/path.mp4')
    }
    finally { warn.mockRestore() }
  })

  it('keeps at most 64 KiB of stderr', async () => {
    fakeTools({ ffmpeg: `i=0; while [ $i -lt 2000 ]; do echo "line $i ................................................................"; i=$((i+1)); done >&2` })
    const r = await runMedia({ tool: 'ffmpeg', args: [], userId: null })
    expect(Buffer.byteLength(r.stderrTail)).toBeLessThanOrEqual(64 * 1024)
    expect(r.stderrTail).toContain('line 1999')
  })
})

describe('the limiter', () => {
  it('runs two jobs of one hosted person one after the other, and two people side by side', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'exec /bin/sleep 0.4' })
    let before = started()
    const a = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    const b = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    await sleep(150)
    expect(started() - before).toBe(1)
    expect(mediaLimiter().pending('u1')).toBe(2)
    await Promise.all([a, b])
    expect(started() - before).toBe(2)
    expect(mediaLimiter().pending('u1')).toBe(0)

    before = started()
    const c = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    const d = runMedia({ tool: 'ffmpeg', args: [], userId: 'u2' })
    await sleep(150)
    expect(started() - before).toBe(2)
    await Promise.all([c, d])
  })

  it('runs two jobs of one person at once locally', async () => {
    fakeTools({ ffmpeg: 'exec /bin/sleep 0.4' })
    const before = started()
    const jobs = [runMedia({ tool: 'ffmpeg', args: [], userId: null }), runMedia({ tool: 'ffmpeg', args: [], userId: null })]
    await sleep(150)
    expect(started() - before).toBe(2)
    await Promise.all(jobs)
  })

  it('a thumbnail job isn’t held up behind a long job', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'exec /bin/sleep 1.5' })
    const long = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    const queued = runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })
    await sleep(100)
    fakeTools({ ffmpeg: 'exit 0' })
    const t0 = Date.now()
    await runMedia({ tool: 'ffmpeg', args: [], userId: 'u1', route: true })
    expect(Date.now() - t0).toBeLessThan(700)
    await Promise.all([long, queued])
  })
})

describe('caps, from the probe alone', () => {
  it('refuses a 4097×4097 video in hosted before any decode', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(video(4097, 4097, 1)) })
    const before = started()
    await expect(decodeFrames(mp4File(), { userId: 'u1', maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooBig)
    expect(started() - before).toBe(1)   // the probe only
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('refuses a video over the length cap (hosted: 10 minutes; local: an hour)', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(video(64, 48, 601)) })
    await expect(decodeFrames(mp4File(), { userId: 'u1', maxFrames: 1e9, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooLong)
    delete process.env[HOSTED_KEY]
    fakeTools({ ffprobe: probeAnswer(video(64, 48, 3601)) })
    await expect(decodeFrames(mp4File(), { userId: null, maxFrames: 1e9, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('refuses a sound over the sample cap, though under the length cap', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(sound(8, 48000, 1000)) })
    const before = started()
    await expect(decodeAudio(mp4File(), { decoder: 'load', userId: 'u1', maxSamples: 1e12 })).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(started() - before).toBe(1)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('refuses a file whose length can’t be read in hosted, and lets it through locally', async () => {
    const noLength = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ ...video(64, 48, 1).streams[0], avg_frame_rate: '0/0', nb_frames: undefined, duration_ts: undefined }] }
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(noLength) })
    await expect(decodeFrames(mp4File(), { userId: 'u1', maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.unreadable)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })
})
