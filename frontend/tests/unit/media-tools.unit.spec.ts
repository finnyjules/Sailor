/**
 * Task R5.1a: the video tools' finder and licence guard (server/media/tools.ts),
 * the build's pins (scripts/media-tools/, Dockerfile), and build.sh's own
 * checks (scripts/media-tools/checks.sh) run against fixtures.
 *
 * The finder is tested against a fake tools folder of small shell scripts that
 * print canned `-version`, `-buildconf`, `-L`, `-encoders`, `-protocols`,
 * `-demuxers` and `-muxers` answers. Only the last block needs the real build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_DEMUXERS, ALLOWED_MUXERS, ALLOWED_PROTOCOLS, FORBIDDEN_BUILDCONF, MEDIA_TOOLS_BUILD_TAG, MEDIA_TOOLS_MISSING,
  MEDIA_TOOLS_VERSION, REQUIRED_ENCODERS, askTool, licenceTextOk, mediaTools, mediaToolsDir, mediaToolsReady, parseBuildconf,
  parseFormats, resetMediaTools,
} from '~~/server/media/tools'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const CHECKS_SH = join(REPO, 'scripts/media-tools/checks.sh')

function readArgs(): string[] {
  return readFileSync(join(REPO, 'scripts/media-tools/configure.args'), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}
function listOf(args: string[], prefix: string): string[] {
  return args.filter(a => a.startsWith(prefix)).flatMap(a => a.slice(prefix.length).split(','))
}
/** configure's component names as -demuxers / -muxers list them (FFmpeg 8.0.3). */
const displayName = (kind: 'demuxer' | 'muxer', n: string) =>
  kind === 'demuxer' && n === 'mpegps' ? 'mpeg' : n.startsWith('pcm_') ? n.slice(4) : n

/**
 * Demuxers, muxers and filters that reach other files or the network: never
 * enabled, never allowed (rule 6 and the controller's ruling on it).
 */
/** The real 8.0.3-sailor1 build's `-buildconf` answers (Mac, rebuild 3). ffmpeg's alone ends in "Exiting with exit code 0". */
const REAL_FFMPEG_BUILDCONF = readFileSync(join(REPO, 'frontend/tests/unit/fixtures/media-tools/ffmpeg-buildconf.txt'), 'utf8')
const REAL_FFPROBE_BUILDCONF = readFileSync(join(REPO, 'frontend/tests/unit/fixtures/media-tools/ffprobe-buildconf.txt'), 'utf8')
/** The same answer with one real argument changed. */
const withArg = (text: string, from: string, to: string) => {
  expect(text).toContain(`    ${from}\n`)
  return text.replace(`    ${from}\n`, `    ${to}\n`)
}

const REFERENCE_DEMUXERS = [
  'concat', 'hls', 'dash', 'imf', 'image2', 'image2pipe', 'sdp', 'rtsp', 'rtp', 'sap', 'vobsub', 'dvdvideo',
  'webm_dash_manifest', 'avisynth', 'vapoursynth', 'libgme', 'libmodplug', 'libopenmpt', 'bluray',
]
const REFERENCE_MUXERS = [
  'tee', 'segment', 'stream_segment', 'hls', 'dash', 'hds', 'smoothstreaming', 'fifo', 'fifo_test', 'rtp', 'rtp_mpegts',
  'rtsp', 'image2', 'webm_chunk', 'webm_dash_manifest',
]
const FILE_FILTERS = ['movie', 'amovie', 'sendcmd', 'asendcmd']

// ---------------------------------------------------------------------------
// A fake build
// ---------------------------------------------------------------------------

const GOOD_BUILDCONF = ['--cc=cc', '--cxx=c++', '--pkg-config-flags=--static', '--extra-cflags=-I/w/prefix/include', '--extra-ldflags=-L/w/prefix/lib', ...readArgs()]

const LGPL_L = `ffmpeg is free software; you can redistribute it and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version.
`
const GPL_L = `ffmpeg is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
`
const MIXED_L = `${GPL_L}Parts are under the GNU Lesser General Public License.\n`
const NONFREE_L = `This version of ffmpeg has nonfree parts compiled in.
Therefore it is not legally redistributable.
${LGPL_L}`

const ENCODER_DESC: Record<string, string> = {
  libopenh264: ' V....D libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
  aac: ' A....D aac                  AAC (Advanced Audio Coding)',
  libmp3lame: ' A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)',
  flac: ' A....D flac                 FLAC (Free Lossless Audio Codec)',
  libopus: ' A....D libopus              libopus Opus (codec opus)',
  ffv1: ' VFS..D ffv1                 FFmpeg video codec #1',
  pcm_f32le: ' A....D pcm_f32le            PCM 32-bit floating point little-endian',
  pcm_s16le: ' A....D pcm_s16le            PCM signed 16-bit little-endian',
  rawvideo: ' V....D rawvideo             raw video',
}

/** What each program answers; ffprobe answers the same unless `probe` overrides. */
interface ToolFake {
  version?: string
  buildconf?: string[]
  /** The whole `-buildconf` answer, verbatim (the real outputs' fixtures). */
  buildconfText?: string
  license?: string
  input?: string[]
  output?: string[]
  demuxers?: string[]
  muxers?: string[]
}
interface Fake extends ToolFake {
  encoders?: string[]
  hang?: boolean
  probe?: ToolFake
}

/** As the real build lists them: the first name, then aliases (mov and matroska have some). */
const ALIASES: Record<string, string> = { mov: 'mov,mp4,m4a,3gp,3g2,mj2', matroska: 'matroska,webm' }
const GOOD_DEMUXERS = ALLOWED_DEMUXERS.map(n => ALIASES[n] ?? n)
const GOOD_MUXERS = [...ALLOWED_MUXERS]

function formatsText(flag: 'D' | 'E', names: string[]): string {
  return ['File formats:', ' D.. = Demuxing supported', ' .E. = Muxing supported', ' ..d = Is a device', ' ---',
    ...names.map(n => ` ${flag === 'D' ? 'D  ' : ' E '} ${n.padEnd(15)} ${n} format`), ''].join('\n')
}

function encodersText(names: string[]): string {
  return ['Encoders:', ' V..... = Video', ' A..... = Audio', ' ------',
    ...names.map(n => ENCODER_DESC[n] ?? ` V....D ${n.padEnd(20)} ${n}`), ''].join('\n')
}

function protocolsText(input: string[], output: string[]): string {
  return ['Supported file protocols:', 'Input:', ...input.map(p => `  ${p}`), 'Output:', ...output.map(p => `  ${p}`), ''].join('\n')
}

function writeTool(dir: string, name: string, answers: Record<string, string>, hang: boolean): void {
  const cases = Object.keys(answers).map(flag => `    ${flag}) exec /bin/cat "$HERE/${name}${flag}.txt" ;;`).join('\n')
  for (const [flag, text] of Object.entries(answers)) writeFileSync(join(dir, `${name}${flag}.txt`), text)
  const body = hang
    ? '#!/bin/sh\nexec /bin/sleep 30\n'
    : `#!/bin/sh\nHERE="$(/usr/bin/dirname "$0")"\nfor a in "$@"; do\n  case "$a" in\n${cases}\n  esac\ndone\nexit 1\n`
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

function toolAnswers(tool: 'ffmpeg' | 'ffprobe', f: ToolFake): Record<string, string> {
  const version = f.version ?? `${tool} version ${MEDIA_TOOLS_VERSION}-sailor1 Copyright (c) 2000-2026 the FFmpeg developers`
  const buildconf = f.buildconf ?? GOOD_BUILDCONF
  return {
    '-version': `${version}\nbuilt with Apple clang\nconfiguration: ${buildconf.join(' ')}\n`,
    '-buildconf': f.buildconfText ?? `  configuration:\n${buildconf.map(s => `    ${s}`).join('\n')}\n`,
    '-L': (f.license ?? LGPL_L).replace(/^ffmpeg/, tool),
    '-protocols': protocolsText(f.input ?? ['file', 'pipe'], f.output ?? ['file', 'pipe']),
    '-demuxers': formatsText('D', f.demuxers ?? GOOD_DEMUXERS),
    '-muxers': formatsText('E', f.muxers ?? GOOD_MUXERS),
  }
}

function makeFake(dir: string, f: Fake = {}): string {
  mkdirSync(dir, { recursive: true })
  const { probe, encoders, hang, ...mpeg } = f
  writeTool(dir, 'ffmpeg', { ...toolAnswers('ffmpeg', mpeg), '-encoders': encodersText(encoders ?? [...REQUIRED_ENCODERS]) }, !!hang)
  writeTool(dir, 'ffprobe', toolAnswers('ffprobe', { ...mpeg, version: undefined, ...probe }), false)
  return dir
}

/** Runs checks.sh's functions in bash (macOS's 3.2 is fine). */
function bash(script: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync('/bin/bash', ['-c', `. "${CHECKS_SH}"; ${script}`], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env }, timeout: 20_000,
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

// ---------------------------------------------------------------------------

let tmp: string
const envKeys = ['NUXT_MEDIA_TOOLS_DIR', 'NUXT_MEDIA_TOOLS', 'PATH'] as const
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {}
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'media-tools-'))
  for (const k of envKeys) savedEnv[k] = process.env[k]
  delete process.env.NUXT_MEDIA_TOOLS_DIR
  delete process.env.NUXT_MEDIA_TOOLS
  // No real .media-tools folder may be found from the test's own cwd.
  vi.spyOn(process, 'cwd').mockReturnValue(join(tmp, 'app'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetMediaTools()
})

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
  resetMediaTools()
  rmSync(tmp, { recursive: true, force: true })
})

function refusedWith(): string {
  return warn.mock.calls.map(c => String(c[0])).join('\n')
}

async function refuses(f: Fake, why: RegExp): Promise<void> {
  process.env.NUXT_MEDIA_TOOLS_DIR = makeFake(join(tmp, 'bin'), f)
  expect(await mediaTools()).toBeNull()
  expect(mediaToolsReady()).toBe(false)
  expect(refusedWith()).toMatch(/media\.tools\.refused/)
  expect(refusedWith()).toMatch(why)
}

describe('the finder', () => {
  it('a good build is ready, and remembered', async () => {
    const bin = makeFake(join(tmp, 'bin'))
    process.env.NUXT_MEDIA_TOOLS_DIR = bin
    expect(mediaToolsReady()).toBe(false)
    const t = await mediaTools()
    expect(warn.mock.calls).toEqual([])
    expect(t).not.toBeNull()
    expect(t!.ffmpeg).toBe(join(bin, 'ffmpeg'))
    expect(t!.ffprobe).toBe(join(bin, 'ffprobe'))
    expect(t!.version).toBe(`ffmpeg version ${MEDIA_TOOLS_VERSION}-sailor1 Copyright (c) 2000-2026 the FFmpeg developers`)
    expect(t!.buildconf).toEqual(GOOD_BUILDCONF)
    for (const e of REQUIRED_ENCODERS) expect(t!.encoders.has(e)).toBe(true)
    expect(t!.protocols).toEqual({ input: ['file', 'pipe'], output: ['file', 'pipe'] })
    expect(mediaToolsReady()).toBe(true)
    // Checked once: the same promise, even after the folder is gone.
    rmSync(bin, { recursive: true, force: true })
    expect(await mediaTools()).toBe(t)
  })

  it.each(FORBIDDEN_BUILDCONF.map(s => [s]))('%s in the build line refuses it (ffmpeg or ffprobe)', async (sw) => {
    await refuses({ buildconf: [...GOOD_BUILDCONF, sw] }, new RegExp(`ffmpeg was built with ${sw}`))
    resetMediaTools(); warn.mockClear()
    await refuses({ probe: { buildconf: [...GOOD_BUILDCONF, sw] } }, new RegExp(`ffprobe was built with ${sw}`))
  })

  it("the real build's -buildconf answers count as the same build line, though only ffmpeg's ends in 'Exiting with exit code 0'", async () => {
    expect(REAL_FFMPEG_BUILDCONF).toMatch(/Exiting with exit code 0/)
    expect(REAL_FFPROBE_BUILDCONF).not.toMatch(/Exiting with exit code/)
    expect(REAL_FFMPEG_BUILDCONF).not.toBe(REAL_FFPROBE_BUILDCONF)
    expect(parseBuildconf(REAL_FFMPEG_BUILDCONF)).toEqual(parseBuildconf(REAL_FFPROBE_BUILDCONF))
    expect(parseBuildconf(REAL_FFMPEG_BUILDCONF)).toContain('--extra-version=sailor1')
    process.env.NUXT_MEDIA_TOOLS_DIR = makeFake(join(tmp, 'bin'), { buildconfText: REAL_FFMPEG_BUILDCONF, probe: { buildconfText: REAL_FFPROBE_BUILDCONF } })
    expect(await mediaTools()).not.toBeNull()
    expect(warn.mock.calls).toEqual([])
  })

  it('a real argument that differs between the two programs still refuses it', async () => {
    await refuses({
      buildconfText: REAL_FFMPEG_BUILDCONF,
      probe: { buildconfText: withArg(REAL_FFPROBE_BUILDCONF, '--disable-iconv', '--enable-iconv') },
    }, /different build lines/)
  })

  it('ffmpeg and ffprobe from different builds refuse it', async () => {
    await refuses({ probe: { buildconf: GOOD_BUILDCONF.filter(a => a !== '--disable-iconv') } }, /different build lines/)
  })

  it('a GPL or nonfree licence from -L refuses it, for either program, even with a clean build line', async () => {
    await refuses({ license: GPL_L }, /ffmpeg -L does not show an LGPL build/)
    resetMediaTools(); warn.mockClear()
    await refuses({ license: NONFREE_L }, /ffmpeg -L does not show an LGPL build/)
    resetMediaTools(); warn.mockClear()
    await refuses({ probe: { license: GPL_L } }, /ffprobe -L does not show an LGPL build/)
    expect(licenceTextOk(LGPL_L)).toBe(true)
  })

  it('a missing libopenh264 refuses it', async () => {
    await refuses({ encoders: REQUIRED_ENCODERS.filter(e => e !== 'libopenh264') }, /libopenh264/)
  })

  it('an http protocol refuses it (input or output, ffmpeg or ffprobe)', async () => {
    await refuses({ input: ['file', 'http', 'pipe'] }, /ffmpeg has the input protocols http/)
    resetMediaTools(); warn.mockClear()
    await refuses({ output: ['file', 'http', 'pipe'] }, /ffmpeg has the output protocols http/)
    resetMediaTools(); warn.mockClear()
    await refuses({ probe: { input: ['file', 'https', 'pipe'] } }, /ffprobe has the input protocols https/)
  })

  it.each([['hls'], ['concat'], ['image2'], ['imf'], ['vobsub'], ['sdp'], ['some_future_format']])(
    'a %s demuxer (anything outside the allow-list) refuses it, in ffmpeg or ffprobe', async (d) => {
      await refuses({ demuxers: [...GOOD_DEMUXERS, d] }, new RegExp(`ffmpeg has demuxers outside the allowed list: ${d}`))
      resetMediaTools(); warn.mockClear()
      await refuses({ probe: { demuxers: [...GOOD_DEMUXERS, d] } }, new RegExp(`ffprobe has demuxers outside the allowed list: ${d}`))
    })

  it('a missing allowed demuxer or muxer refuses it (the build must match configure.args)', async () => {
    await refuses({ demuxers: GOOD_DEMUXERS.filter(d => d !== 'rawvideo') }, /ffmpeg lacks the demuxers rawvideo/)
    resetMediaTools(); warn.mockClear()
    await refuses({ muxers: GOOD_MUXERS.filter(d => d !== 'mp4') }, /ffmpeg lacks the muxers mp4/)
  })

  it.each([['tee'], ['segment'], ['hls'], ['image2']])('a %s muxer refuses it', async (m) => {
    await refuses({ muxers: [...GOOD_MUXERS, m] }, new RegExp(`ffmpeg has muxers outside the allowed list: ${m}`))
  })

  it('reads the first name of each ffmpeg -demuxers line, with letter, space or dot flags', () => {
    const names = parseFormats(formatsText('D', GOOD_DEMUXERS))
    expect([...names].sort()).toEqual([...ALLOWED_DEMUXERS].sort())
    expect(parseFormats('File formats:\n ---\n D.. concat  Virtual concatenation script\n').has('concat')).toBe(true)
    expect(parseBuildconf('  configuration:\n    --a\n    --b\n')).toEqual(['--a', '--b'])
  })

  it('only 8.0.3-sailor1 is accepted, on both programs', async () => {
    for (const [f, why] of [
      [{ version: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers' }, /ffmpeg is .*not 8\.0\.3-sailor1/],
      [{ version: 'ffmpeg version 8.0.30-sailor1 Copyright' }, /not 8\.0\.3-sailor1/],
      [{ version: 'ffmpeg version 8.0.3 Copyright' }, /not 8\.0\.3-sailor1/],
      [{ version: 'ffmpeg version 8.0.3-sailor2 Copyright' }, /not 8\.0\.3-sailor1/],
      [{ version: 'ffmpeg version 8.0.3-sailor1x' }, /not 8\.0\.3-sailor1/],
      [{ probe: { version: 'ffprobe version 8.0.3 Copyright' } }, /ffprobe is .*not 8\.0\.3-sailor1/],
      [{ probe: { version: 'ffprobe version 8.0.2-sailor1 Copyright' } }, /ffprobe is/],
    ] as const) {
      resetMediaTools(); warn.mockClear()
      await refuses(f as Fake, why)
    }
    expect(MEDIA_TOOLS_BUILD_TAG).toBe('sailor1')
  })

  it('a tool that hangs refuses it after 5 s', async () => {
    const started = Date.now()
    await refuses({ hang: true }, /did not answer within 5 s/)
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(4900)
    expect(took).toBeLessThan(9000)
  }, 20_000)

  it('a tool that cannot even be started answers plainly (no crash when spawn throws at once)', async () => {
    // A NUL in the path makes spawn throw synchronously, before the time limit is set.
    const a = await askTool(join(tmp, 'ff\0mpeg'), ['-version'])
    expect(a.ok).toBe(false)
    expect(a.why).toMatch(/^could not start /)
    expect(a.why).not.toMatch(/before initialization|Cannot access/)
  })

  it('an ffmpeg put on PATH is never used', async () => {
    const onPath = makeFake(join(tmp, 'path-bin'))
    process.env.PATH = `${onPath}:${process.env.PATH ?? ''}`
    expect(mediaToolsDir()).toBeNull()
    expect(await mediaTools()).toBeNull()
    expect(refusedWith()).toMatch(/not installed/)
  })

  it('finds a local build in .media-tools/<platform>-<arch>/bin, from frontend/ or the repository root', async () => {
    const plat = `${process.platform}-${process.arch}`
    const fromFrontend = makeFake(join(tmp, 'app', '.media-tools', plat, 'bin'))
    expect(mediaToolsDir()).toBe(fromFrontend)
    expect((await mediaTools())?.ffmpeg).toBe(join(fromFrontend, 'ffmpeg'))

    rmSync(join(tmp, 'app'), { recursive: true, force: true })
    const fromRoot = makeFake(join(tmp, 'app', 'frontend', '.media-tools', plat, 'bin'))
    expect(mediaToolsDir()).toBe(fromRoot)

    // Another machine's folder is not this one's.
    rmSync(join(tmp, 'app'), { recursive: true, force: true })
    makeFake(join(tmp, 'app', '.media-tools', 'plan9-mips', 'bin'))
    expect(mediaToolsDir()).toBeNull()
  })

  it('NUXT_MEDIA_TOOLS_DIR wins over a local build', async () => {
    makeFake(join(tmp, 'app', '.media-tools', `${process.platform}-${process.arch}`, 'bin'), { version: 'ffmpeg version 7.0 x' })
    const chosen = makeFake(join(tmp, 'chosen'))
    process.env.NUXT_MEDIA_TOOLS_DIR = chosen
    expect(mediaToolsDir()).toBe(chosen)
    expect((await mediaTools())?.ffmpeg).toBe(join(chosen, 'ffmpeg'))
  })

  it('NUXT_MEDIA_TOOLS=off wins over everything', async () => {
    process.env.NUXT_MEDIA_TOOLS_DIR = makeFake(join(tmp, 'bin'))
    makeFake(join(tmp, 'app', '.media-tools', `${process.platform}-${process.arch}`, 'bin'))
    process.env.NUXT_MEDIA_TOOLS = 'off'
    expect(await mediaTools()).toBeNull()
    expect(mediaToolsReady()).toBe(false)
    expect(refusedWith()).toMatch(/switched off/)
  })

  it('a folder without ffprobe refuses it', async () => {
    const bin = makeFake(join(tmp, 'bin'))
    rmSync(join(bin, 'ffprobe'))
    process.env.NUXT_MEDIA_TOOLS_DIR = bin
    expect(await mediaTools()).toBeNull()
    expect(refusedWith()).toMatch(/ffprobe is missing/)
  })

  it('the missing-tools message is plain words', () => {
    expect(MEDIA_TOOLS_MISSING).toBe('This needs the video tools, which aren’t installed on this server')
  })
})

// ---------------------------------------------------------------------------
// The build's pins
// ---------------------------------------------------------------------------

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of readFileSync(join(REPO, 'scripts/media-tools/versions.env'), 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Z0-9_]+)=(\S+)$/.exec(line)
    expect(m, `versions.env line is KEY=value with no spaces or quotes: ${line}`).not.toBeNull()
    out[m![1]!] = m![2]!
  }
  return out
}

const PARTS: Record<string, string> = { FFMPEG: '8.0.3', OPENH264: '2.5.1', LAME: '3.100', OPUS: '1.6.1', DAV1D: '1.5.1', ZLIB: '1.3.2' }

describe('the pins', () => {
  it('versions.env: every part has its version, an https URL naming it, and a 64-hex sha256', () => {
    const env = readEnv()
    for (const [part, version] of Object.entries(PARTS)) {
      expect(env[`${part}_VERSION`], part).toBe(version)
      const url = env[`${part}_URL`]!
      expect(url, part).toMatch(/^https:\/\//)
      expect(url, part).toContain(version)
      expect(env[`${part}_SHA256`], `${part}_SHA256 (TODO-VERIFY until checked from the download)`).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(Object.keys(env).filter(k => /_VERSION$/.test(k)).sort()).toEqual(Object.keys(PARTS).map(p => `${p}_VERSION`).sort())
  })

  it("versions.env: FFmpeg's signature and key are pinned, and the version is the server's", () => {
    const env = readEnv()
    expect(env.FFMPEG_VERSION).toBe(MEDIA_TOOLS_VERSION)
    expect(env.FFMPEG_SIG_URL).toBe(`${env.FFMPEG_URL}.asc`)
    expect(env.FFMPEG_KEY_URL).toMatch(/^https:\/\/ffmpeg\.org\//)
    expect(env.FFMPEG_KEY_FINGERPRINT).toBe('FCF986EA15E6E293A5644F10B4322F04D67658D8')
    expect(env.MEDIA_TOOLS_SOURCE_DATE_EPOCH).toMatch(/^\d+$/)
  })

  it("configure.args: the brief's LGPL-only line with the rulings' additions, and none of the forbidden switches", () => {
    const args = readArgs()
    for (const f of FORBIDDEN_BUILDCONF) expect(args).not.toContain(f)
    expect(args.filter(a => /gpl|nonfree|version3|x264|x265/.test(a))).toEqual([])
    expect(args).toEqual([
      '--disable-autodetect', '--disable-iconv', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-devices', '--disable-hwaccels',
      '--disable-network', '--disable-protocols', '--enable-protocol=file,pipe',
      '--disable-demuxers',
      '--enable-demuxer=mov,matroska,wav,mp3,ogg,flac,aac,avi,aiff,caf,gif,mpegts,mpegps,flv,h264,hevc,asf,ac3,eac3,dts,amr,au,w64,dv,mxf,ivf,yuv4mpegpipe,nut,rm,mpegvideo,m4v,loas,rawvideo,pcm_f32le,ffmetadata',
      '--disable-muxers', '--enable-muxer=mp4,mov,matroska,wav,flac,mp3,ogg,opus,rawvideo,pcm_f32le,null',
      '--disable-encoders', '--enable-encoder=libopenh264,aac,libmp3lame,flac,libopus,ffv1,pcm_f32le,pcm_s16le,rawvideo',
      '--disable-filter=movie,amovie,sendcmd,asendcmd,lut1d,lut3d,curves,metadata,ametadata,psnr,ssim,ssim360,vmafmotion,signature,fieldhint,find_rect,cover_rect,removelogo,dnn_processing,dnn_classify,dnn_detect,sr,derain,drawtext,subtitles,ass,zmq,azmq,whisper,deshake,xpsnr,fsync,life,cellauto,arnndn,firequalizer,paletteuse,selectivecolor,showcqt',
      '--enable-libopenh264', '--enable-libmp3lame', '--enable-libopus', '--enable-libdav1d',
      '--enable-zlib',
      '--enable-static', '--disable-shared', `--extra-version=${MEDIA_TOOLS_BUILD_TAG}`,
    ])
    // Every encoder the server requires is built, and nothing else.
    expect(listOf(args, '--enable-encoder=').sort()).toEqual([...REQUIRED_ENCODERS].sort())
  })

  it("the server's allow-lists are exactly configure.args's demuxers, muxers and protocols", () => {
    const args = readArgs()
    expect(listOf(args, '--enable-demuxer=').map(n => displayName('demuxer', n)).sort()).toEqual([...ALLOWED_DEMUXERS].sort())
    expect(listOf(args, '--enable-muxer=').map(n => displayName('muxer', n)).sort()).toEqual([...ALLOWED_MUXERS].sort())
    expect(listOf(args, '--enable-protocol=').sort()).toEqual([...ALLOWED_PROTOCOLS].sort())
    // build.sh computes the same lists from the same file.
    const r = bash(`for k in demuxer muxer protocol encoder; do echo "== $k"; mt_expected_names "${join(REPO, 'scripts/media-tools/configure.args')}" $k; done`)
    expect(r.code).toBe(0)
    const got: Record<string, string[]> = {}
    let cur = ''
    for (const line of r.out.trim().split('\n')) {
      if (line.startsWith('== ')) { cur = line.slice(3); got[cur] = [] } else got[cur]!.push(line)
    }
    const sorted = (a: readonly string[]) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    expect(got.demuxer).toEqual(sorted(ALLOWED_DEMUXERS))
    expect(got.muxer).toEqual(sorted(ALLOWED_MUXERS))
    expect(got.protocol).toEqual(sorted(ALLOWED_PROTOCOLS))
    expect(got.encoder).toEqual(sorted(REQUIRED_ENCODERS))
    // One build tag everywhere.
    const sh = readFileSync(join(REPO, 'scripts/media-tools/build.sh'), 'utf8')
    expect(sh).toMatch(new RegExp(`^BUILD_TAG=${MEDIA_TOOLS_BUILD_TAG} `, 'm'))
  })

  it('configure.args can never enable a demuxer, muxer or filter that reaches other files, or a network protocol', () => {
    const args = readArgs()
    const at = (a: string) => args.indexOf(a)
    // Everything starts off, before anything is switched back on.
    for (const off of ['--disable-network', '--disable-protocols', '--disable-demuxers', '--disable-muxers', '--disable-devices', '--disable-autodetect']) {
      expect(args, off).toContain(off)
    }
    for (const a of args.filter(x => x.startsWith('--enable-demuxer='))) expect(at(a)).toBeGreaterThan(at('--disable-demuxers'))
    for (const a of args.filter(x => x.startsWith('--enable-muxer='))) expect(at(a)).toBeGreaterThan(at('--disable-muxers'))
    for (const a of args.filter(x => x.startsWith('--enable-protocol='))) expect(at(a)).toBeGreaterThan(at('--disable-protocols'))
    // No wholesale re-enable, no network, no devices, no filter switched back on.
    for (const a of args) {
      expect(a).not.toMatch(/^--enable-(demuxers|muxers|protocols|network|indevs|outdevs|devices|indev=|outdev=|filter=|filters)/)
      expect(a).not.toMatch(/^--enable-(libxml2|gnutls|openssl|libtls|mbedtls|libsrt|librist|libssh|libsmbclient|librtmp|libzmq|libgme|libmodplug|libopenmpt|libbluray|avisynth|vapoursynth)/)
    }
    expect(listOf(args, '--enable-protocol=').sort()).toEqual(['file', 'pipe'])
    const demuxers = listOf(args, '--enable-demuxer=')
    for (const d of REFERENCE_DEMUXERS) {
      expect(demuxers, d).not.toContain(d)
      expect(ALLOWED_DEMUXERS, d).not.toContain(d)
    }
    const muxers = listOf(args, '--enable-muxer=')
    for (const m of REFERENCE_MUXERS) {
      expect(muxers, m).not.toContain(m)
      expect(ALLOWED_MUXERS, m).not.toContain(m)
    }
    const offFilters = listOf(args, '--disable-filter=')
    for (const f of FILE_FILTERS) expect(offFilters, f).toContain(f)
    // The rulings' single-file formats and the media module's own inputs are there.
    for (const d of ['aiff', 'caf', 'gif', 'mpegts', 'mpegps', 'flv', 'h264', 'hevc', 'asf', 'ac3', 'eac3', 'dts', 'amr', 'au', 'w64',
      'dv', 'mxf', 'ivf', 'yuv4mpegpipe', 'nut', 'rm', 'rawvideo', 'pcm_f32le', 'ffmetadata']) expect(demuxers).toContain(d)
  })

  it("build.sh sources checks.sh, cleans the environment before pointing pkg-config at its prefix, and checks both programs", () => {
    const sh = readFileSync(join(REPO, 'scripts/media-tools/build.sh'), 'utf8')
    expect(sh).toContain('. "$HERE/checks.sh"')
    const clean = sh.indexOf('mt_clean_env "$OS"')
    expect(clean).toBeGreaterThan(0)
    expect(sh.indexOf('export PKG_CONFIG_LIBDIR=')).toBeGreaterThan(clean)
    expect(sh).toContain('PYTHON="$(mt_find_python')
    expect(sh).toContain('"$PYTHON" -m venv')
    expect(sh).toContain('for TOOL in ffmpeg ffprobe; do')
    expect(sh).not.toMatch(/cmp -s "\$CHK\/ffmpeg-buildconf/)
    expect(sh).toContain('mt_check_same_buildconf "$CHK/ffmpeg-buildconf.txt" "$CHK/ffprobe-buildconf.txt" || die')
    for (const f of ['mt_check_version_line', 'mt_check_buildconf', 'mt_check_licence_text', 'mt_check_same_names protocols',
      'mt_check_same_names demuxers', 'mt_check_same_names muxers', 'mt_check_links', 'mt_check_signature_status']) {
      expect(sh, f).toContain(f)
    }
    // Every check's failure stops the build: each call line ends in `|| die …` (or is an `if` test).
    const calls = sh.split('\n').filter(l => /\bmt_check_\w+ /.test(l) && !/^\s*#/.test(l))
    expect(calls.length).toBeGreaterThanOrEqual(10)
    // configure's components are checked before the compile, the encoders after it.
    expect(sh.indexOf('mt_check_config_components "$FFMPEG_SRC/config_components.h"')).toBeGreaterThan(sh.indexOf('./configure "${FULL_ARGS[@]}"'))
    expect(sh.indexOf('mt_check_config_components "$FFMPEG_SRC/config_components.h"')).toBeLessThan(sh.indexOf('make $J ffmpeg ffprobe'))
    expect(sh).toContain('mt_check_same_names encoders "$EXPECTED_ENCODERS"')
    for (const l of calls) expect(l, l).toMatch(/\|\| die "|^\s*if mt_check_/)
    for (const f of ['COPYING.LGPLv2.1', 'LICENSE.md', 'SOURCES.md', 'manifest.json']) expect(sh).toContain(f)
    expect(sh).toContain('copy_licence zlib "$ZLIB_SRC" LICENSE')
  })

  it('meson and ninja come only from a pinned, hash-checked venv in the work folder', () => {
    const sh = readFileSync(join(REPO, 'scripts/media-tools/build.sh'), 'utf8')
    expect(sh).toContain('VENV="$WORK/buildtools-venv"')
    expect(sh).toContain('--require-hashes --only-binary=:all: --no-deps -r "$HERE/buildtools.txt"')
    expect(sh).not.toMatch(/brew install[^\n]*(meson|ninja)/)
    expect(sh).not.toMatch(/need (meson|ninja)/)
    const req = readFileSync(join(REPO, 'scripts/media-tools/buildtools.txt'), 'utf8')
    const pins = [...req.matchAll(/^([a-z]+)==(\S+)/gm)].map(m => `${m[1]}==${m[2]}`)
    expect(pins).toEqual(['meson==1.12.1', 'ninja==1.13.2'])
    // Every requirement carries at least one sha256, and ninja has one per platform Sailor builds on.
    const blocks = req.split(/\n(?=[a-z]+==)/).filter(b => /^[a-z]+==/.test(b))
    for (const b of blocks) expect(b).toMatch(/--hash=sha256:[0-9a-f]{64}/)
    expect(blocks.find(b => b.startsWith('ninja'))!.match(/--hash=sha256:[0-9a-f]{64}/g)).toHaveLength(3)
    const df = readFileSync(join(REPO, 'Dockerfile'), 'utf8')
    // No apt-installed meson or ninja in any stage (no continued install line names them).
    expect(df).not.toMatch(/^[^#\n]*\b(meson|ninja-build|ninja)\b[^\n]*\\$/m)
  })

  it('the Dockerfile builds the media-tools stage on the pinned runtime base, copies it and points the server at it', () => {
    const df = readFileSync(join(REPO, 'Dockerfile'), 'utf8')
    expect(df).toMatch(/^ARG PYTHON_BASE=python:3\.12-slim@sha256:[0-9a-f]{64}$/m)
    expect(df).toMatch(/^FROM \$\{PYTHON_BASE\} AS media-tools$/m)
    expect(df).toMatch(/^FROM \$\{PYTHON_BASE\} AS runtime$/m)
    expect(df.indexOf('AS media-tools')).toBeLessThan(df.indexOf('AS runtime'))
    expect(df).toContain('scripts/media-tools/build.sh /opt/media-tools')
    expect(df).toMatch(/^COPY --from=media-tools \/opt\/media-tools \/opt\/media-tools$/m)
    expect(df).toMatch(/^ENV NUXT_MEDIA_TOOLS_DIR=\/opt\/media-tools\/bin$/m)
  })

  it('the local build folder is kept out of git and out of the image', () => {
    const gi = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n')
    expect(gi).toContain('frontend/.media-tools/')
    const di = readFileSync(join(REPO, '.dockerignore'), 'utf8').split('\n')
    expect(di).toContain('frontend/.media-tools')
  })
})

// ---------------------------------------------------------------------------
// build.sh's checks (checks.sh), run against fixtures
// ---------------------------------------------------------------------------

describe("build.sh's checks", () => {
  const fx = (name: string, text: string) => { const p = join(tmp, name); writeFileSync(p, text); return p }

  it('mt_clean_env unsets every build variable (DYLD_* too) and pins the ones the build needs', () => {
    const dirty: Record<string, string> = {
      CPATH: '/x', C_INCLUDE_PATH: '/x', CPLUS_INCLUDE_PATH: '/x', LIBRARY_PATH: '/x', CFLAGS: '-O0', CXXFLAGS: '-O0', CPPFLAGS: '-Dx',
      LDFLAGS: '-L/opt/homebrew/lib', OBJCFLAGS: '-x', CC: 'gcc-14', CXX: 'g++-14', LD: 'ld.gold', AR: 'gar', MAKEFLAGS: '-j1', CONFIG_SITE: '/x',
      PKG_CONFIG: '/opt/homebrew/bin/pkgconf', PKG_CONFIG_PATH: '/opt/homebrew/lib/pkgconfig', PKG_CONFIG_LIBDIR: '/x', PKG_CONFIG_SYSROOT_DIR: '/x',
      MACOSX_DEPLOYMENT_TARGET: '15.0', SDKROOT: '/x', DYLD_LIBRARY_PATH: '/opt/homebrew/lib', DYLD_INSERT_LIBRARIES: '/x.dylib',
      DYLD_FALLBACK_LIBRARY_PATH: '/x', LD_LIBRARY_PATH: '/x', LD_PRELOAD: '/x.so',
    }
    for (const os of ['darwin', 'linux']) {
      const r = bash(`mt_clean_env ${os} /usr/bin/pkg-config && env`, dirty)
      expect(r.code, r.err).toBe(0)
      const env = Object.fromEntries(r.out.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      for (const k of Object.keys(dirty).filter(k => !['CC', 'CXX', 'AR', 'PKG_CONFIG', 'MACOSX_DEPLOYMENT_TARGET'].includes(k))) {
        expect(env[k], `${os}: ${k}`).toBeUndefined()
      }
      expect(Object.keys(env).filter(k => k.startsWith('DYLD_'))).toEqual([])
      expect({ CC: env.CC, CXX: env.CXX, AR: env.AR, RANLIB: env.RANLIB, PKG_CONFIG: env.PKG_CONFIG, LC_ALL: env.LC_ALL, TZ: env.TZ, ZERO_AR_DATE: env.ZERO_AR_DATE })
        .toEqual({ CC: 'cc', CXX: 'c++', AR: 'ar', RANLIB: 'ranlib', PKG_CONFIG: '/usr/bin/pkg-config', LC_ALL: 'C', TZ: 'UTC', ZERO_AR_DATE: '1' })
      expect(env.MACOSX_DEPLOYMENT_TARGET).toBe(os === 'darwin' ? '13.0' : undefined)
    }
  })

  it('mt_find_python refuses a Python older than 3.10, plainly, and takes a newer one', () => {
    const old = join(tmp, 'oldpy'); mkdirSync(old)
    writeFileSync(join(old, 'python3'), '#!/bin/sh\ncase "$1" in --version) echo "Python 3.9.6";; esac\nexit 1\n'); chmodSync(join(old, 'python3'), 0o755)
    const r = bash('mt_find_python', { PATH: `${old}:/usr/bin:/bin` })
    // /usr/bin/python3 may exist on this machine; only assert when it is itself too old or missing.
    const sys = spawnSync('/bin/sh', ['-c', 'command -v python3.10 python3.11 python3.12 python3.13 python3.14; /usr/bin/python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"'], { env: { PATH: '/usr/bin:/bin' } })
    if (sys.status !== 0 && !sys.stdout.toString().trim()) {
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/meson needs Python 3\.10 or later/)
    }
    const oldOnly = bash('mt_find_python', { PATH: old })
    expect(oldOnly.code).not.toBe(0)
    expect(oldOnly.err).toMatch(/meson needs Python 3\.10 or later.*Python 3\.9\.6/)

    const fresh = join(tmp, 'newpy'); mkdirSync(fresh)
    writeFileSync(join(fresh, 'python3.12'), '#!/bin/sh\nexit 0\n'); chmodSync(join(fresh, 'python3.12'), 0o755)
    const ok = bash('mt_find_python', { PATH: `${old}:${fresh}` })
    expect(ok.code, ok.err).toBe(0)
    expect(ok.out.trim()).toBe(join(fresh, 'python3.12'))
  })

  it("mt_check_signature_status needs gpg's VALIDSIG by the pinned key; GOODSIG alone or another key fails", () => {
    const fpr = 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
    const good = fx('valid.txt', `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG B4322F04D67658D8 FFmpeg release signing key\n[GNUPG:] VALIDSIG ${fpr} 2026-06-18 1781740800 0 4 0 1 10 00 ${fpr}\n`)
    const goodOnly = fx('goodsig.txt', '[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG B4322F04D67658D8 FFmpeg release signing key\n')
    const other = fx('other.txt', '[GNUPG:] VALIDSIG 1111111111111111111111111111111111111111 2026-06-18 1781740800 0 4 0 1 10 00 1111111111111111111111111111111111111111\n')
    const bad = fx('bad.txt', '[GNUPG:] BADSIG B4322F04D67658D8 FFmpeg release signing key\n')
    expect(bash(`mt_check_signature_status "${good}" ${fpr}`).code).toBe(0)
    for (const f of [goodOnly, other, bad]) expect(bash(`mt_check_signature_status "${f}" ${fpr}`).code, f).not.toBe(0)
  })

  it("mt_check_same_buildconf compares only the configure arguments: the real outputs pass, a changed argument fails", () => {
    const ff = fx('ffmpeg-bc.txt', REAL_FFMPEG_BUILDCONF)
    const fp = fx('ffprobe-bc.txt', REAL_FFPROBE_BUILDCONF)
    // A raw byte comparison (the old check) says they differ.
    expect(spawnSync('/usr/bin/cmp', ['-s', ff, fp]).status).not.toBe(0)
    expect(bash(`mt_check_same_buildconf "${ff}" "${fp}"`).code).toBe(0)
    const args = bash(`mt_buildconf_args "${ff}"`).out.trim().split('\n')
    expect(args).toEqual(parseBuildconf(REAL_FFMPEG_BUILDCONF))
    expect(args).not.toContain('Exiting with exit code 0')
    // One real argument different, on either side, fails and says which.
    for (const [a, b] of [
      [ff, fx('p1.txt', withArg(REAL_FFPROBE_BUILDCONF, '--disable-iconv', '--enable-iconv'))],
      [fx('m1.txt', withArg(REAL_FFMPEG_BUILDCONF, '--extra-version=sailor1', '--extra-version=sailor2')), fp],
      [ff, fx('p2.txt', REAL_FFPROBE_BUILDCONF.replace('    --disable-shared\n', ''))],
      [ff, fx('p3.txt', REAL_FFPROBE_BUILDCONF.replace('    --disable-shared\n', '    --disable-shared\n    --enable-gpl\n'))],
    ] as const) {
      const r = bash(`mt_check_same_buildconf "${a}" "${b}"`)
      expect(r.code, b).not.toBe(0)
      expect(r.err).toMatch(/configured differently/)
    }
    // No configuration block at all fails too.
    expect(bash(`mt_check_same_buildconf "${fx('empty.txt', 'Exiting with exit code 0\n')}" "${fp}"`).code).not.toBe(0)
  })

  it('mt_check_licence_text rejects GPL and nonfree text', () => {
    expect(bash(`mt_check_licence_text "${fx('l.txt', LGPL_L)}"`).code).toBe(0)
    expect(bash(`mt_check_licence_text "${fx('g.txt', GPL_L)}"`).code).not.toBe(0)
    expect(bash(`mt_check_licence_text "${fx('n.txt', NONFREE_L)}"`).code).not.toBe(0)
    expect(bash(`mt_check_licence_text "${fx('e.txt', 'nothing\n')}"`).code).not.toBe(0)
    // A text naming the GPL is refused even if it also mentions the Lesser GPL.
    expect(bash(`mt_check_licence_text "${fx('b.txt', MIXED_L)}"`).code).not.toBe(0)
    expect(licenceTextOk(MIXED_L)).toBe(false)
  })

  it('mt_check_buildconf and mt_check_version_line refuse what the server refuses', () => {
    const conf = (extra: string[]) => fx('c.txt', `  configuration:\n${[...GOOD_BUILDCONF, ...extra].map(s => `    ${s}`).join('\n')}\n`)
    expect(bash(`mt_check_buildconf "${conf([])}"`).code).toBe(0)
    for (const f of FORBIDDEN_BUILDCONF) expect(bash(`mt_check_buildconf "${conf([f])}"`).code, f).not.toBe(0)
    expect(bash(`mt_check_version_line "ffmpeg version 8.0.3-sailor1 Copyright" ffmpeg 8.0.3 sailor1`).code).toBe(0)
    expect(bash(`mt_check_version_line "ffprobe version 8.0.3-sailor1" ffprobe 8.0.3 sailor1`).code).toBe(0)
    for (const line of ['ffmpeg version 8.0.3 Copyright', 'ffmpeg version 8.0.3-sailor10 x', 'ffmpeg version 8.0.30-sailor1 x', 'ffprobe version 8.0.3-sailor1']) {
      expect(bash(`mt_check_version_line "${line}" ffmpeg 8.0.3 sailor1`).code, line).not.toBe(0)
    }
  })

  it('mt_check_links allows only the system C and C++ libraries', () => {
    const run = (os: string, text: string) => bash(`mt_check_links ${os} "${fx('links.txt', text)}" /w/work`).code
    const macOk = '/x/bin/ffmpeg:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n'
    expect(run('darwin', macOk)).toBe(0)
    // What the real 8.0.3 Mac build links (otool -L, 2026-09-28): the three frameworks configure
    // adds to libavutil on every Darwin build are allowed, at exactly these paths.
    const macReal = `${macOk}\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3502.1.255)
\t/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo (compatibility version 1.2.0, current version 1.5.0)
\t/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia (compatibility version 1.0.0, current version 3225.7.1)
`
    expect(run('darwin', macReal)).toBe(0)
    for (const extra of [
      '\t/System/Library/Frameworks/AudioToolbox.framework/Versions/A/AudioToolbox (compatibility version 1.0.0, current version 1000.0.0)',
      '\t/System/Library/Frameworks/CoreImage.framework/Versions/A/CoreImage (compatibility version 1.0.0, current version 1.0.0)',
      '\t/System/Library/Frameworks/AVFoundation.framework/Versions/A/AVFoundation (compatibility version 1.0.0, current version 2.0.0)',
      '\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0, current version 368.0.0)',
      '\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 2575.0.0)',
      '\t/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1.0.0)',
      '\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundationX (compatibility version 150.0.0, current version 1.0.0)',
      '\t/usr/lib/libobjc.A.dylib (compatibility version 1.0.0, current version 228.0.0)',
    ]) expect(run('darwin', `${macReal}${extra}\n`), extra).not.toBe(0)
    // The frameworks are a macOS allowance only.
    expect(run('linux', '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x1)\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1.0.0)\n')).not.toBe(0)
    for (const extra of [
      '\t/opt/homebrew/opt/x264/lib/libx264.164.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)',
      '\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)',
      '\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox (compatibility version 1.0.0, current version 1.0.0)',
      '\t/w/work/prefix/lib/libopus.0.dylib (compatibility version 1.0.0, current version 1.0.0)',
    ]) expect(run('darwin', `${macOk}${extra}\n`), extra).not.toBe(0)
    const linuxOk = '\tlinux-vdso.so.1 (0x00007ffd5a9f2000)\n\tlibm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x00007f0e0)\n\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f0e1)\n\tlibgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007f0e2)\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0e3)\n\t/lib64/ld-linux-x86-64.so.2 (0x00007f0e4)\n'
    expect(run('linux', linuxOk)).toBe(0)
    for (const extra of [
      '\tlibz.so.1 => /lib/x86_64-linux-gnu/libz.so.1 (0x00007f0e5)',
      '\tlibx264.so.164 => /usr/lib/x86_64-linux-gnu/libx264.so.164 (0x00007f0e6)',
      '\tlibva.so.2 => /lib/x86_64-linux-gnu/libva.so.2 (0x00007f0e7)',
      '\tlibopus.so.0 => /usr/local/lib/libopus.so.0 (0x00007f0e8)',
    ]) expect(run('linux', `${linuxOk}${extra}\n`), extra).not.toBe(0)
  })

  it('mt_check_config_components: every enabled component is CONFIG_…=1, every disabled filter exists and is 0; a name configure lacks fails', () => {
    const args = join(REPO, 'scripts/media-tools/configure.args')
    const a = readArgs()
    const lines: string[] = []
    for (const kind of ['demuxer', 'muxer', 'encoder', 'protocol']) {
      for (const n of listOf(a, `--enable-${kind}=`)) lines.push(`#define CONFIG_${n.toUpperCase()}_${kind.toUpperCase()} 1`)
    }
    for (const n of listOf(a, '--disable-filter=')) lines.push(`#define CONFIG_${n.toUpperCase()}_FILTER 0`)
    lines.push('#define CONFIG_HLS_DEMUXER 0', '#define CONFIG_SCALE_FILTER 1')
    const good = lines.join('\n') + '\n'
    // config.h beside it, with every Apple feature off (as the real 8.0.3 build has it).
    const APPLE = ['VIDEOTOOLBOX', 'AUDIOTOOLBOX', 'COREIMAGE', 'AVFOUNDATION', 'APPKIT', 'METAL']
    const configH = APPLE.map(n => `#define CONFIG_${n} 0`).join('\n') + '\n#define CONFIG_ZLIB 1\n'
    fx('config.h', configH)
    expect(bash(`mt_check_config_components "${fx('cc.h', good)}" "${args}"`).code).toBe(0)
    // The bug the first real build hit: the name exists but is 0 (configure ignored a misspelling elsewhere).
    const zero = good.replace('#define CONFIG_PCM_F32LE_DEMUXER 1', '#define CONFIG_PCM_F32LE_DEMUXER 0')
    const r0 = bash(`mt_check_config_components "${fx('cc0.h', zero)}" "${args}"`)
    expect(r0.code).not.toBe(0)
    expect(r0.err).toMatch(/pcm_f32le.*CONFIG_PCM_F32LE_DEMUXER is 0/)
    // A name configure doesn't have at all (the old `f32le`).
    const oldArgs = fx('old.args', readFileSync(args, 'utf8').replace(',pcm_f32le,ffmetadata', ',f32le,ffmetadata'))
    const r1 = bash(`mt_check_config_components "${fx('cc1.h', good)}" "${oldArgs}"`)
    expect(r1.code).not.toBe(0)
    expect(r1.err).toMatch(/no demuxer called 'f32le'/)
    // A file filter left on.
    const on = good.replace('#define CONFIG_MOVIE_FILTER 0', '#define CONFIG_MOVIE_FILTER 1')
    expect(bash(`mt_check_config_components "${fx('cc2.h', on)}" "${args}"`).err).toMatch(/filter 'movie' is still enabled/)
  })

  it('mt_check_config_components: every Apple feature (VideoToolbox, AudioToolbox, CoreImage, AVFoundation, AppKit, Metal) must be 0 in config.h', () => {
    const args = join(REPO, 'scripts/media-tools/configure.args')
    const a = readArgs()
    const lines: string[] = []
    for (const kind of ['demuxer', 'muxer', 'encoder', 'protocol']) {
      for (const n of listOf(a, `--enable-${kind}=`)) lines.push(`#define CONFIG_${n.toUpperCase()}_${kind.toUpperCase()} 1`)
    }
    for (const n of listOf(a, '--disable-filter=')) lines.push(`#define CONFIG_${n.toUpperCase()}_FILTER 0`)
    const components = lines.join('\n') + '\n'
    const APPLE = ['VIDEOTOOLBOX', 'AUDIOTOOLBOX', 'COREIMAGE', 'AVFOUNDATION', 'APPKIT', 'METAL']
    const off = APPLE.map(n => `#define CONFIG_${n} 0`).join('\n') + '\n'
    let i = 0
    const run = (configH: string) => {
      const dir = join(tmp, `cfg${i++}`); mkdirSync(dir)
      writeFileSync(join(dir, 'config.h'), configH)
      writeFileSync(join(dir, 'config_components.h'), components)
      return bash(`mt_check_config_components "${join(dir, 'config_components.h')}" "${args}"`)
    }
    expect(run(off).code).toBe(0)
    for (const n of APPLE) {
      const r = run(off.replace(`#define CONFIG_${n} 0`, `#define CONFIG_${n} 1`))
      expect(r.code, n).not.toBe(0)
      expect(r.err, n).toMatch(new RegExp(`CONFIG_${n} is on`))
      const gone = run(off.replace(`#define CONFIG_${n} 0\n`, ''))
      expect(gone.code, `${n} missing`).not.toBe(0)
      expect(gone.err).toMatch(new RegExp(`config.h has no CONFIG_${n}`))
    }
    // No config.h at all fails too.
    const dir = join(tmp, 'nocfg'); mkdirSync(dir); writeFileSync(join(dir, 'config_components.h'), components)
    expect(bash(`mt_check_config_components "${join(dir, 'config_components.h')}" "${args}"`).code).not.toBe(0)
  })

  it('mt_listed_encoders reads -encoders; the build must list exactly configure.args\'s encoders', () => {
    const args = join(REPO, 'scripts/media-tools/configure.args')
    const e = fx('e.txt', encodersText([...REQUIRED_ENCODERS]))
    expect(bash(`mt_listed_encoders "${e}"`).out.trim().split('\n')).toEqual([...REQUIRED_ENCODERS].sort())
    expect(bash(`mt_check_same_names encoders "$(mt_expected_names "${args}" encoder)" "$(mt_listed_encoders "${e}")"`).code).toBe(0)
    const missing = fx('e2.txt', encodersText(REQUIRED_ENCODERS.filter(n => n !== 'pcm_f32le')))
    expect(bash(`mt_check_same_names encoders "$(mt_expected_names "${args}" encoder)" "$(mt_listed_encoders "${missing}")"`).code).not.toBe(0)
  })

  it("mt_listed_formats / mt_listed_protocols read ffmpeg's lists; mt_check_same_names refuses anything extra or missing", () => {
    const args = join(REPO, 'scripts/media-tools/configure.args')
    const d = fx('d.txt', formatsText('D', GOOD_DEMUXERS))
    const p = fx('p.txt', protocolsText(['file', 'pipe'], ['file', 'pipe']))
    expect(bash(`mt_check_same_names demuxers "$(mt_expected_names "${args}" demuxer)" "$(mt_listed_formats "${d}")"`).code).toBe(0)
    expect(bash(`mt_check_same_names protocols "$(mt_expected_names "${args}" protocol)" "$(mt_listed_protocols "${p}")"`).code).toBe(0)
    const extra = fx('d2.txt', formatsText('D', [...GOOD_DEMUXERS, 'hls']))
    const r = bash(`mt_check_same_names demuxers "$(mt_expected_names "${args}" demuxer)" "$(mt_listed_formats "${extra}")"`)
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/hls/)
    const missing = fx('d3.txt', formatsText('D', GOOD_DEMUXERS.filter(n => n !== 'f32le')))
    expect(bash(`mt_check_same_names demuxers "$(mt_expected_names "${args}" demuxer)" "$(mt_listed_formats "${missing}")"`).code).not.toBe(0)
    const http = fx('p2.txt', protocolsText(['file', 'http', 'pipe'], ['file', 'pipe']))
    expect(bash(`mt_check_same_names protocols "$(mt_expected_names "${args}" protocol)" "$(mt_listed_protocols "${http}")"`).code).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The real build, once the controller has made it on this machine
// ---------------------------------------------------------------------------

const REAL_BIN = join(REPO, 'frontend', '.media-tools', `${process.platform}-${process.arch}`, 'bin')
const REAL_FFMPEG = join(REAL_BIN, 'ffmpeg')

describe('the real build (frontend/.media-tools)', () => {
  it.skipIf(!existsSync(REAL_FFMPEG))('is ready: mediaTools() accepts it, its build line is configure.args, its licence the LGPL', async () => {
    process.env.NUXT_MEDIA_TOOLS_DIR = REAL_BIN
    const t = await mediaTools()
    expect(warn.mock.calls).toEqual([])
    expect(t).not.toBeNull()
    expect(mediaToolsReady()).toBe(true)
    expect(t!.version).toMatch(new RegExp(`^ffmpeg version ${MEDIA_TOOLS_VERSION}-${MEDIA_TOOLS_BUILD_TAG}( |$)`))
    // configure quotes a list value in its own record (--enable-protocol='file,pipe'); compare without the quotes.
    const unquoted = t!.buildconf.map(l => l.replace(/='(.*)'$/, '=$1'))
    for (const a of readArgs()) expect(unquoted, a).toContain(a)
    expect([...t!.encoders].sort()).toEqual([...REQUIRED_ENCODERS].sort())
    for (const f of FORBIDDEN_BUILDCONF) expect(t!.buildconf).not.toContain(f)
    for (const tool of [t!.ffmpeg, t!.ffprobe]) {
      const run = (flag: string) => execFileSync(tool, ['-hide_banner', flag], { encoding: 'utf8', timeout: 10_000 })
      expect(licenceTextOk(run('-L')), tool).toBe(true)
      expect([...parseFormats(run('-demuxers'))].sort()).toEqual([...ALLOWED_DEMUXERS].sort())
      expect([...parseFormats(run('-muxers'))].sort()).toEqual([...ALLOWED_MUXERS].sort())
      const protocols = run('-protocols').split('\n').map(l => l.trim()).filter(l => l && !/:$/.test(l))
      expect([...new Set(protocols)].sort()).toEqual([...ALLOWED_PROTOCOLS].sort())
    }
    // The licence folder and manifest are beside the programs.
    for (const f of ['../licenses/SOURCES.md', '../licenses/ffmpeg/COPYING.LGPLv2.1', '../manifest.json']) expect(existsSync(join(REAL_BIN, f)), f).toBe(true)
  }, 30_000)
})
