/**
 * Task R5.1b: the media module's machinery (server/media/run.ts, and the
 * refusals and caps in probe.ts / decode.ts), against a fake tools folder of
 * small shell scripts: nothing here needs the real build.
 *
 * The fakes stand in for `mediaTools()`; each scenario writes its own
 * ffmpeg / ffprobe bodies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaTools } from '~~/server/media/tools'

const fake = vi.hoisted(() => ({ tools: null as MediaTools | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return { ...real, mediaTools: async () => fake.tools }
})

const { MediaError, checkArgs, inputArgs, mediaLimiter, mediaTempDir, removeMediaTempDir, runMedia } = await import('~~/server/media/run')
const { probeMedia, scanTimeoutMs } = await import('~~/server/media/probe')
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
      await expect(probeMedia(p, { userId: null, roots: [dir] }), p).rejects.toThrow(MEDIA_WORDS.unreadable)
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
    await expect(probeMedia(f, { userId: null, roots: [dir] })).rejects.toThrow(MEDIA_WORDS.unreadable)
    await expect(decodeFrames(f, { userId: null, roots: [dir], maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.unreadable)
    expect(started()).toBe(before)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('mediaFormat tells Matroska and AVI apart', () => {
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x88, ...Buffer.from('matroska')]))).toBe('mkv')
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x84, ...Buffer.from('webm')]))).toBe('webm')
    expect(mediaFormat(Buffer.from('RIFF\0\0\0\0AVI LIST'))).toBe('avi')
    expect(mediaFormat(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBe('wav')
  })

  it('checkArgs allows only listed options; every output is pipe:1 or file: inside the job’s own folder', async () => {
    const work = await mediaTempDir()
    try {
      const head = ['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-i', 'file:/a/b.mp4']
      const ok = [...head, '-map', '0:v:0', '-f', 'rawvideo', 'pipe:1']
      expect(() => checkArgs('ffmpeg', ok)).not.toThrow()
      expect(() => checkArgs('ffmpeg', [...head, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'])).not.toThrow()
      expect(() => checkArgs('ffmpeg', [...head, '-stats_mux_pre', 'pipe:3', '-f', 'rawvideo', 'pipe:1'], { side: true })).not.toThrow()
      expect(() => checkArgs('ffmpeg', [...head, '-y', `file:${join(work, 'x.flac')}`], { workDir: work })).not.toThrow()
      expect(() => checkArgs('ffprobe', ['-probesize', '5000000', ...head, '-of', 'json', '-show_format'])).not.toThrow()

      const refusedFfmpeg: [string, string[], { side?: boolean; workDir?: string }?][] = [
        // Outputs: bare, relative, outside the folder, escaping it, another pipe, another folder.
        ['bare absolute output', [...head, '-f', 'matroska', join(dir, 'escaped.mkv')]],
        ['bare relative output', [...head, '-f', 'matroska', 'escaped.mkv']],
        ['file: output with no job folder', [...head, '-y', `file:${join(work, 'x.flac')}`]],
        ['file: output in another folder', [...head, '-y', `file:${join(dir, 'x.flac')}`], { workDir: work }],
        ['file: output climbing out', [...head, '-y', `file:${work}/../x.flac`], { workDir: work }],
        ['file: relative output', [...head, '-y', 'file:x.flac'], { workDir: work }],
        ['stdout as -', [...head, '-f', 'rawvideo', '-']],
        ['pipe:2', [...head, '-f', 'rawvideo', 'pipe:2']],
        ['pipe:3 as an output', [...head, '-f', 'rawvideo', 'pipe:3'], { side: true }],
        // Options that write or read a file by name.
        ['-print_graphs_file', [...head, '-print_graphs_file', join(dir, 'graphs.txt'), 'pipe:1']],
        ['-print_graphs', [...head, '-print_graphs', 'pipe:1']],
        ['-vstats', [...head, '-vstats', 'pipe:1']],
        ['-vstats_file', [...head, '-vstats_file', join(dir, 'v.log'), 'pipe:1']],
        ['-stats_enc_pre with a path', [...head, '-stats_enc_pre', join(dir, 's.txt'), 'pipe:1']],
        ['-stats_enc_post with a path', [...head, '-stats_enc_post', join(dir, 's.txt'), 'pipe:1']],
        ['-stats_mux_pre with a path', [...head, '-stats_mux_pre', join(dir, 's.txt'), 'pipe:1'], { side: true }],
        ['-stats_mux_pre pipe:3 with no reader', [...head, '-stats_mux_pre', 'pipe:3', 'pipe:1']],
        ['-fpre', [...head, '-fpre', join(dir, 'x.ffpreset'), 'pipe:1']],
        ['-report', [...head, '-report', 'pipe:1']],
        ['-dump_attachment', [...head, '-dump_attachment', 'x', 'pipe:1']],
        ['-dump_attachment:t', [...head, '-dump_attachment:t', 'x', 'pipe:1']],
        ['-attach', [...head, '-attach', '/etc/passwd', 'pipe:1']],
        ['-filter_script', [...head, '-filter_script', '/x', 'pipe:1']],
        ['-/filter', [...head, '-/filter', '/x', 'pipe:1']],
        ['-progress', [...head, '-progress', 'pipe:1', 'pipe:1']],
        ['-passlogfile', [...head, '-passlogfile', '/x', 'pipe:1']],
        ['-sdp_file', [...head, '-sdp_file', '/x', 'pipe:1']],
        ['-use_absolute_path', [...head, '-use_absolute_path', '1', 'pipe:1']],
        // Inputs and their guards.
        ['-enable_drefs 1', ['-enable_drefs', '1', '-i', 'file:/a/b.mp4', 'pipe:1']],
        ['a wider protocol whitelist', ['-protocol_whitelist', 'file,pipe,http', '-i', 'file:/a/b.mp4', 'pipe:1']],
        ['an http input', ['-i', 'http://example.com/a.mp4', 'pipe:1']],
        ['a bare input', ['-i', '/a/b.mp4', 'pipe:1']],
        ['a relative file: input', ['-i', 'file:rel.mp4', 'pipe:1']],
        ['an option missing its value', [...head, '-map']],
      ]
      for (const [label, args, o] of refusedFfmpeg) expect(() => checkArgs('ffmpeg', args, o), label).toThrow(MediaError)
      // ffprobe: no outputs at all, and not its -o.
      expect(() => checkArgs('ffprobe', [...head, '-o', join(dir, 'probe.json')])).toThrow(MediaError)
      expect(() => checkArgs('ffprobe', [...head, 'pipe:1'])).toThrow(MediaError)
      expect(() => checkArgs('ffprobe', [...head, '-report'])).toThrow(MediaError)
    }
    finally { await removeMediaTempDir(work) }
  })

  it('the review’s two proven escapes (a bare output path, -print_graphs_file) are refused before any tool starts', async () => {
    fakeTools({})
    const before = started()
    const head = ['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-i', 'file:/a/b.mp4']
    await expect(runMedia({ tool: 'ffmpeg', args: [...head, '-f', 'matroska', join(dir, 'escaped.mkv')], userId: null })).rejects.toThrow(MEDIA_WORDS.failed)
    await expect(runMedia({ tool: 'ffmpeg', args: [...head, '-print_graphs_file', join(dir, 'graphs.txt'), '-f', 'rawvideo', 'pipe:1'], userId: null })).rejects.toThrow(MEDIA_WORDS.failed)
    expect(started()).toBe(before)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('every job runs in its own folder: the given workDir, or a fresh one removed afterwards', async () => {
    const log = join(dir, 'pwd.txt')
    fakeTools({ ffmpeg: `/bin/pwd -P >> "${log}"` })
    await runMedia({ tool: 'ffmpeg', args: [], userId: null })
    const own = readFileSync(log, 'utf8').trim()
    expect(own).toMatch(/sailor-media-/)
    expect(existsSync(own)).toBe(false)
    const work = await mediaTempDir()
    try {
      await runMedia({ tool: 'ffmpeg', args: [], userId: null, workDir: work })
      expect(readFileSync(log, 'utf8').trim().split('\n')[1]).toBe(realpathSync(work))
    }
    finally { await removeMediaTempDir(work) }
  })

  it('an input must really be inside the caller’s roots: a symlink out of the folder is refused', async () => {
    fakeTools({ ffprobe: probeAnswer(video(64, 48, 1)) })
    const inside = mp4File('inside.mp4')
    const elsewhere = mkdtempSync(join(tmpdir(), 'media-run-outside-'))
    try {
      const outside = join(elsewhere, 'outside.mp4')
      writeFileSync(outside, readFileSync(inside))
      symlinkSync(outside, join(dir, 'link.mp4'))
      symlinkSync(inside, join(dir, 'ok-link.mp4'))
      const before = started()
      await expect(probeMedia(join(dir, 'link.mp4'), { userId: null, roots: [dir] })).rejects.toThrow(MEDIA_WORDS.unreadable)
      await expect(probeMedia(outside, { userId: null, roots: [dir] })).rejects.toThrow(MEDIA_WORDS.unreadable)
      await expect(probeMedia(inside, { userId: null, roots: [] })).rejects.toThrow(MEDIA_WORDS.unreadable)
      await expect(probeMedia(dir, { userId: null, roots: [dir] })).rejects.toThrow(MEDIA_WORDS.unreadable)
      expect(started()).toBe(before)
      // A link that stays inside is read through its real path.
      const p = await probeMedia(join(dir, 'ok-link.mp4'), { userId: null, roots: [dir] })
      expect(p.path).toBe(realpathSync(inside))
      // A probe of one file can't be handed in for another.
      await expect(decodeFrames(join(dir, 'link.mp4'), { userId: null, roots: [dir], probe: p, maxFrames: 1, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.unreadable)
    }
    finally { rmSync(elsewhere, { recursive: true, force: true }) }
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
    const job = runMedia({ tool: 'ffmpeg', args: [], userId: null, signal: stop.signal, cleanup: [partial] })
    job.catch(() => {})
    // Stop once the tool has really written (R5.1c review, Minor 8: not after a fixed wait, which a loaded
    // machine can outlast); the second is measured from Stop, not from the start.
    while (!existsSync(partial)) await sleep(10)
    const t0 = Date.now()
    stop.abort()
    await expect(job).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(Date.now() - t0).toBeLessThan(1000)
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

  it('a stuck onStdout after the tool has exited still ends by the time limit, and the slot is given back', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'echo some-output' })
    const t0 = Date.now()
    const job = runMedia({ tool: 'ffmpeg', args: [], userId: 'hang', timeoutMs: 500, onStdout: () => new Promise<void>(() => {}) })
    await expect(job).rejects.toThrow(MEDIA_WORDS.timedOut)
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(mediaLimiter().pending('hang')).toBe(0)
  })

  it('a stuck onStdout after the tool has exited still ends by Stop, and the slot is given back', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'echo some-output' })
    const stop = new AbortController()
    const job = runMedia({ tool: 'ffmpeg', args: [], userId: 'hang2', signal: stop.signal, onStdout: () => new Promise<void>(() => {}) })
    await sleep(300)
    expect(mediaLimiter().pending('hang2')).toBe(1)
    const t0 = Date.now()
    stop.abort()
    await expect(job).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(mediaLimiter().pending('hang2')).toBe(0)
    // The person's next job runs at once.
    fakeTools({ ffmpeg: 'exit 0' })
    await expect(runMedia({ tool: 'ffmpeg', args: [], userId: 'hang2', timeoutMs: 2000 })).resolves.toBeTruthy()
  })

  it('a job’s callback may not start another job: it is refused at once, never left waiting on its own slot', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffmpeg: 'echo some-output' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let nested: unknown = null
      const t0 = Date.now()
      await runMedia({
        tool: 'ffmpeg', args: [], userId: 'u1', timeoutMs: 5000,
        onStdout: async () => {
          await sleep(1)   // still inside the callback after an await
          nested = await runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' }).catch((e: unknown) => e)
        },
      })
      expect(nested).toBeInstanceOf(MediaError)
      expect((nested as Error).message).toBe(MEDIA_WORDS.failed)
      expect(Date.now() - t0).toBeLessThan(1000)
      // Outside any callback, the same person's next job runs as usual.
      await expect(runMedia({ tool: 'ffmpeg', args: [], userId: 'u1' })).resolves.toBeTruthy()
    }
    finally { warn.mockRestore() }
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
    await expect(decodeFrames(mp4File(), { userId: 'u1', roots: [dir], maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooBig)
    expect(started() - before).toBe(1)   // the probe only
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('refuses a video over the length cap (hosted: 10 minutes; local: an hour)', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(video(64, 48, 601)) })
    await expect(decodeFrames(mp4File(), { userId: 'u1', roots: [dir], maxFrames: 1e9, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooLong)
    delete process.env[HOSTED_KEY]
    fakeTools({ ffprobe: probeAnswer(video(64, 48, 3601)) })
    await expect(decodeFrames(mp4File(), { userId: null, roots: [dir], maxFrames: 1e9, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('refuses a sound over the sample cap, though under the length cap', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(sound(8, 48000, 1000)) })
    const before = started()
    await expect(decodeAudio(mp4File(), { decoder: 'load', userId: 'u1', roots: [dir], maxSamples: 1e12 })).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(started() - before).toBe(1)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })

  it('judges the size and the header’s own lengths before any whole-file scan', async () => {
    process.env[HOSTED_KEY] = 'sk_test_x'
    // A header with a rate but no length and no frame count: Python would count packets.
    const needsScan = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ ...video(64, 48, 1).streams[0], nb_frames: undefined, duration_ts: undefined }] }
    const log = join(dir, 'probes.txt')
    fakeTools({ ffprobe: `echo x >> "${log}"; ${probeAnswer(needsScan)}` })
    const big = mp4File('big.mp4')
    truncateSync(big, 3 * 1024 ** 3)   // sparse: 3 GiB on paper, over the hosted video cap
    await expect(probeMedia(big, { userId: 'u1', roots: [dir], kind: 'video' })).rejects.toThrow(MEDIA_WORDS.tooBig)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)   // the header only, no scan
    // A sound header stating 2 hours: refused as too long before the scan of its other stream.
    const twoStreams = { format: { format_name: 'matroska,webm' }, streams: [sound(2, 48000, 7200).streams[0], { ...sound(2, 48000, 1).streams[0], index: 1, duration_ts: undefined }] }
    writeFileSync(log, '')
    fakeTools({ ffprobe: `echo x >> "${log}"; ${probeAnswer(twoStreams)}` })
    await expect(probeMedia(mp4File('long.mp4'), { userId: 'u1', roots: [dir], kind: 'sound' })).rejects.toThrow(MEDIA_WORDS.tooLong)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('gives a whole-file scan its own time limit, scaled to the size', () => {
    expect(scanTimeoutMs(0)).toBe(10_000)
    expect(scanTimeoutMs(2 * 1024 ** 3)).toBeGreaterThan(100_000)
  })

  it('refuses a file whose length can’t be read in hosted, and lets it through locally', async () => {
    const noLength = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ ...video(64, 48, 1).streams[0], avg_frame_rate: '0/0', nb_frames: undefined, duration_ts: undefined }] }
    process.env[HOSTED_KEY] = 'sk_test_x'
    fakeTools({ ffprobe: probeAnswer(noLength) })
    await expect(decodeFrames(mp4File(), { userId: 'u1', roots: [dir], maxFrames: 10, onFrame: async () => {} })).rejects.toThrow(MEDIA_WORDS.unreadable)
    expect(existsSync(join(dir, 'ffmpeg.ran'))).toBe(false)
  })
})
