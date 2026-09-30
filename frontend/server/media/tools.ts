/**
 * Where Sailor's video tools live, and whether they may be used (Task R5.1a).
 *
 * The tools are an ffmpeg and ffprobe built by scripts/media-tools/build.sh:
 * FFmpeg 8.0.3, LGPL parts only, OpenH264 for H.264. They are found in exactly
 * two places, never on PATH and never in Homebrew:
 *   - NUXT_MEDIA_TOOLS_DIR (the Fly image sets /opt/media-tools/bin);
 *   - frontend/.media-tools/<platform>-<arch>/bin, where the script puts a local build.
 *
 * Before use the build is checked once and the answer remembered. BOTH programs
 * must be version 8.0.3-sailor1, have no GPL or non-free switch in their build
 * line (the same line for both), show the LGPL licence, and list exactly the
 * allowed protocols, demuxers and muxers (the allow-lists of
 * scripts/media-tools/configure.args); ffmpeg must have every encoder Sailor
 * needs. Any failure (or NUXT_MEDIA_TOOLS=off) answers null, and the media work
 * stays with the engine.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface MediaTools {
  ffmpeg: string; ffprobe: string
  /** `ffmpeg -version`'s first line, e.g. 'ffmpeg version 8.0.3-sailor1'. */
  version: string
  /** `ffmpeg -buildconf`, one switch per entry. */
  buildconf: readonly string[]
  encoders: ReadonlySet<string>
  protocols: { input: readonly string[]; output: readonly string[] }
}

export const MEDIA_TOOLS_VERSION = '8.0.3'
/** configure.args's `--extra-version`: what marks Sailor's own build. */
export const MEDIA_TOOLS_BUILD_TAG = 'sailor1'
export const MEDIA_TOOLS_MISSING = 'This needs the video tools, which aren’t installed on this server'
/** Switches whose presence refuses a build (the ledger's no-GPL ruling). */
export const FORBIDDEN_BUILDCONF: readonly string[] = ['--enable-gpl', '--enable-nonfree', '--enable-version3', '--enable-libx264', '--enable-libx265']
export const REQUIRED_ENCODERS: readonly string[] = ['libopenh264', 'aac', 'libmp3lame', 'flac', 'libopus', 'ffv1', 'pcm_f32le', 'pcm_s16le', 'rawvideo']

/**
 * ALLOW-lists, exactly configure.args's `--enable-demuxer=` / `--enable-muxer=` /
 * `--enable-protocol=` lines, as `-demuxers` / `-muxers` / `-protocols` list them
 * (the first name of each line: configure's `mpegps` is listed as `mpeg`, and
 * its `pcm_f32le` demuxer and muxer as `f32le`). A
 * binary listing anything else, or missing any, is refused. None of these
 * follows references to other files or addresses (rule 6);
 * tests/unit/media-tools.unit.spec.ts ties them to configure.args.
 */
export const ALLOWED_DEMUXERS: readonly string[] = [
  'aac', 'ac3', 'aiff', 'amr', 'asf', 'au', 'avi', 'caf', 'dts', 'dv', 'eac3', 'f32le', 'ffmetadata', 'flac', 'flv', 'gif',
  'h264', 'hevc', 'ivf', 'loas', 'm4v', 'matroska', 'mov', 'mp3', 'mpeg', 'mpegts', 'mpegvideo', 'mxf', 'nut', 'ogg', 'rawvideo', 'rm', 'w64', 'wav', 'yuv4mpegpipe',
]
export const ALLOWED_MUXERS: readonly string[] = ['f32le', 'flac', 'matroska', 'mov', 'mp3', 'mp4', 'null', 'ogg', 'opus', 'rawvideo', 'wav']
export const ALLOWED_PROTOCOLS: readonly string[] = ['file', 'pipe']

/** How long one answer from a tool may take. */
const TOOL_ANSWER_MS = 5000
/** Enough for `-encoders`; anything larger is not ffmpeg talking. */
const TOOL_ANSWER_MAX_BYTES = 1 << 20

function platformFolder(): string {
  return `${process.platform}-${process.arch}`
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** NUXT_MEDIA_TOOLS_DIR, else frontend/.media-tools/<platform>-<arch>/bin when it exists, else null. Never PATH. */
export function mediaToolsDir(): string | null {
  const env = process.env.NUXT_MEDIA_TOOLS_DIR?.trim()
  if (env) return isAbsolute(env) ? env : resolve(env)
  const cwd = process.cwd()
  // The Nuxt server runs from frontend/; allow the repository root too.
  for (const base of [join(cwd, '.media-tools'), join(cwd, 'frontend', '.media-tools')]) {
    const bin = join(base, platformFolder(), 'bin')
    if (isDir(bin)) return bin
  }
  return null
}

export interface ToolAnswer { ok: boolean; out: string; why?: string }

/**
 * Runs one tool by its absolute path, no shell, a minimal environment, with a
 * hard time limit. Never throws. Exported for tests.
 */
export function askTool(file: string, args: string[], timeoutMs = TOOL_ANSWER_MS): Promise<ToolAnswer> {
  return new Promise((done) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (a: ToolAnswer) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      done(a)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { LC_ALL: 'C' }, shell: false })
    } catch (e) {
      finish({ ok: false, out: '', why: `could not start ${file}: ${(e as Error).message}` })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, out: '', why: `${file} ${args.join(' ')} did not answer within ${timeoutMs / 1000} s` })
    }, timeoutMs)
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length
      if (size > TOOL_ANSWER_MAX_BYTES) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish({ ok: false, out: '', why: `${file} ${args.join(' ')} answered too much` })
        return
      }
      chunks.push(b)
    })
    child.stderr!.resume()
    child.on('error', e => finish({ ok: false, out: '', why: `could not start ${file}: ${e.message}` }))
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, out: Buffer.concat(chunks).toString('utf8') })
      else finish({ ok: false, out: '', why: `${file} ${args.join(' ')} exited with ${code}` })
    })
  })
}

export function parseBuildconf(out: string): string[] {
  return out.split('\n').map(l => l.trim()).filter(l => l.startsWith('--'))
}

/** ` V....D libopenh264   OpenH264 ...` lines after the `------` rule. */
export function parseEncoders(out: string): Set<string> {
  const names = new Set<string>()
  let body = false
  for (const line of out.split('\n')) {
    if (!body) { if (/^\s*-{6}\s*$/.test(line)) body = true; continue }
    const m = /^\s*[VASD.][A-Z.]{5}\s+(\S+)/.exec(line)
    if (m) names.add(m[1]!)
  }
  return names
}

/**
 * `-demuxers` / `-muxers`: after the ` ---` rule, lines ` DEd name[,alias…]  long name`
 * (flags are letters, dots or spaces). The first name of each line.
 */
export function parseFormats(out: string): Set<string> {
  const names = new Set<string>()
  let body = false
  for (const line of out.split('\n')) {
    if (!body) { if (/^\s*-{2,}\s*$/.test(line)) body = true; continue }
    const m = /^ [D. ][E. ][d. ] +(\S+)/.exec(line)
    if (m) names.add(m[1]!.split(',')[0]!)
  }
  return names
}

/** `Supported file protocols:` / `Input:` / names / `Output:` / names. */
export function parseProtocols(out: string): { input: string[]; output: string[] } {
  const input: string[] = []
  const output: string[] = []
  let into: string[] | null = null
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (line === 'Input:') { into = input; continue }
    if (line === 'Output:') { into = output; continue }
    if (!line || !into) continue
    into.push(line)
  }
  return { input, output }
}

/** `<tool> version 8.0.3-sailor1` (then a space or the end), nothing else. */
export function versionOk(line: string, tool: string): boolean {
  const m = new RegExp(`^${tool} version (\\S+)(?: |$)`).exec(line)
  return !!m && m[1] === `${MEDIA_TOOLS_VERSION}-${MEDIA_TOOLS_BUILD_TAG}`
}

/** The ffmpeg -L text of an LGPL build; a GPL or nonfree text is refused. */
export function licenceTextOk(text: string): boolean {
  return /Lesser General Public/.test(text) && !/GNU General Public License/.test(text) && !/nonfree/i.test(text)
}

function sameNames(listed: Iterable<string>, allowed: readonly string[]): { extra: string[]; missing: string[] } {
  const got = new Set(listed)
  return {
    extra: [...got].filter(n => !allowed.includes(n)).sort(),
    missing: allowed.filter(n => !got.has(n)),
  }
}

type Checked = { tools: MediaTools } | { refused: string }

interface ToolReport { version: string; buildconf: string[]; protocols: { input: string[]; output: string[] } }

/** Every check both programs must pass; null when fine, else why not. */
async function checkTool(tool: 'ffmpeg' | 'ffprobe', file: string): Promise<{ report: ToolReport } | { refused: string }> {
  const [ver, conf, lic, proto, demux, mux] = await Promise.all([
    askTool(file, ['-hide_banner', '-version']),
    askTool(file, ['-hide_banner', '-buildconf']),
    askTool(file, ['-hide_banner', '-L']),
    askTool(file, ['-hide_banner', '-protocols']),
    askTool(file, ['-hide_banner', '-demuxers']),
    askTool(file, ['-hide_banner', '-muxers']),
  ])
  for (const a of [ver, conf, lic, proto, demux, mux]) if (!a.ok) return { refused: a.why! }

  const version = ver.out.split('\n')[0]!.trim()
  if (!versionOk(version, tool)) return { refused: `${tool} is '${version}', not ${MEDIA_TOOLS_VERSION}-${MEDIA_TOOLS_BUILD_TAG}` }

  const buildconf = parseBuildconf(conf.out)
  const forbidden = buildconf.filter(s => FORBIDDEN_BUILDCONF.includes(s))
  if (forbidden.length) return { refused: `${tool} was built with ${forbidden.join(', ')}` }
  if (!licenceTextOk(lic.out)) return { refused: `${tool} -L does not show an LGPL build` }

  const protocols = parseProtocols(proto.out)
  for (const [side, list] of [['input', protocols.input], ['output', protocols.output]] as const) {
    const d = sameNames(list, ALLOWED_PROTOCOLS)
    if (d.extra.length) return { refused: `${tool} has the ${side} protocols ${d.extra.join(', ')} (only file and pipe are allowed)` }
    if (d.missing.length) return { refused: `${tool} lacks the ${side} protocols ${d.missing.join(', ')}` }
  }
  const dm = sameNames(parseFormats(demux.out), ALLOWED_DEMUXERS)
  if (dm.extra.length) return { refused: `${tool} has demuxers outside the allowed list: ${dm.extra.join(', ')}` }
  if (dm.missing.length) return { refused: `${tool} lacks the demuxers ${dm.missing.join(', ')}` }
  const mm = sameNames(parseFormats(mux.out), ALLOWED_MUXERS)
  if (mm.extra.length) return { refused: `${tool} has muxers outside the allowed list: ${mm.extra.join(', ')}` }
  if (mm.missing.length) return { refused: `${tool} lacks the muxers ${mm.missing.join(', ')}` }

  return { report: { version, buildconf, protocols } }
}

async function check(): Promise<Checked> {
  if ((process.env.NUXT_MEDIA_TOOLS ?? '').trim().toLowerCase() === 'off') return { refused: 'switched off (NUXT_MEDIA_TOOLS=off)' }
  const dir = mediaToolsDir()
  if (!dir) return { refused: 'not installed (run scripts/media-tools/build.sh)' }
  const ffmpeg = join(dir, 'ffmpeg')
  const ffprobe = join(dir, 'ffprobe')
  for (const f of [ffmpeg, ffprobe]) {
    if (!existsSync(f)) return { refused: `${f} is missing` }
    try { accessSync(f, constants.X_OK) } catch { return { refused: `${f} can't be run` } }
  }

  const [mpeg, probe, enc] = await Promise.all([
    checkTool('ffmpeg', ffmpeg),
    checkTool('ffprobe', ffprobe),
    askTool(ffmpeg, ['-hide_banner', '-encoders']),
  ])
  if ('refused' in mpeg) return mpeg
  if ('refused' in probe) return probe
  if (!enc.ok) return { refused: enc.why! }
  if (mpeg.report.buildconf.join('\n') !== probe.report.buildconf.join('\n')) return { refused: 'ffmpeg and ffprobe have different build lines' }

  const encoders = parseEncoders(enc.out)
  const missing = REQUIRED_ENCODERS.filter(e => !encoders.has(e))
  if (missing.length) return { refused: `ffmpeg lacks the encoders ${missing.join(', ')}` }

  const { version, buildconf, protocols } = mpeg.report
  return { tools: { ffmpeg, ffprobe, version, buildconf, encoders, protocols } }
}

let pending: Promise<MediaTools | null> | null = null
let ready = false

/** The tools, checked once and remembered (null when missing or refused; a `media.tools.refused` log line says why). */
export function mediaTools(): Promise<MediaTools | null> {
  if (!pending) {
    const mine = check().then((c): MediaTools | null => {
      if ('refused' in c) {
        console.warn(`[media] media.tools.refused: ${c.refused}`)
        return null
      }
      return c.tools
    }, (e: unknown): MediaTools | null => {
      console.warn(`[media] media.tools.refused: ${(e as Error)?.message ?? String(e)}`)
      return null
    })
    pending = mine
    void mine.then((t) => { if (pending === mine) ready = t !== null })
  }
  return pending
}

/** The remembered answer, for eligibility (false until the first check has finished; the server warms it at start). */
export function mediaToolsReady(): boolean {
  return ready
}

/** Tests only. */
export function resetMediaTools(): void {
  pending = null
  ready = false
}
