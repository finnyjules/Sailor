/**
 * The one way Sailor starts its video tools (step 3, R5 rule 5, Task R5.1b).
 * Nothing else in the server spawns ffmpeg or ffprobe: probe.ts and decode.ts
 * (and the encoders after them) hand their argument lists to `runMedia`.
 *
 * Every job:
 *   - runs the checked build from tools.ts (`mediaTools()`), by its path, with
 *     an argument list (never a shell) and a minimal environment (`LC_ALL=C`
 *     only, so FFREPORT and AV_LOG_FORCE_* can't leak in);
 *   - starts with `-hide_banner -loglevel error -max_alloc 536870912` (and
 *     `-nostdin` for ffmpeg), and in hosted `-filter_threads 1` and
 *     `-threads 2` before each input;
 *   - reads its inputs only as `file:<absolute path>` or `pipe:0`, with the
 *     demuxer named from the file's first bytes (`inputArgs`), and writes
 *     files only inside a folder made by `mediaTempDir()`;
 *   - never carries an option that reads or writes files named by the media
 *     itself (`-report`, `-dump_attachment`, `-filter_script`, `-/opt`,
 *     `-use_absolute_path`, `-enable_drefs 1`, …): `checkArgs` refuses them
 *     before anything starts. Filtergraphs are built in this module from
 *     numbers and fixed words, never from a person's text;
 *   - waits its turn behind the limiter (one job per person hosted, two
 *     local, at most max(1, ⌊cpus / 2⌋) at once; the thumbnail and waveform
 *     routes have two slots of their own);
 *   - has a time limit, and is killed (SIGKILL) at once by Stop or by the
 *     limit, its partial outputs removed;
 *   - keeps at most 64 KiB of stderr, logged on failure and never shown: a
 *     failure reaches a person only as MEDIA_WORDS.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import {
  MEDIA_JOB_TIMEOUT_MS, MEDIA_JOBS_PER_USER, MEDIA_MAX_ALLOC, MEDIA_ROUTE_SLOTS, MEDIA_STDERR_BYTES, MEDIA_WORDS,
  type MediaWord,
} from '#shared/runner/media'
import { isHosted } from '../utils/deployMode'
import type { MediaFormat } from '../runner/mediaInputs'
import { MEDIA_TOOLS_MISSING, mediaTools } from './tools'

/** A media failure, in words a person can read. `word` says which. */
export class MediaError extends Error {
  readonly word: MediaWord | 'toolsMissing'
  constructor(word: MediaWord | 'toolsMissing') {
    super(word === 'toolsMissing' ? MEDIA_TOOLS_MISSING : MEDIA_WORDS[word])
    this.name = 'MediaError'
    this.word = word
  }
}

export interface MediaJob {
  tool: 'ffmpeg' | 'ffprobe'; args: string[]
  userId: string | null
  /** The thumbnail and waveform routes' own slots (and their 30 s limit). */
  route?: boolean
  signal?: AbortSignal; timeoutMs?: number
  /** Piped frames or samples, read by the tool as `pipe:0`. */
  stdin?: AsyncIterable<Uint8Array>
  /** Back-pressure: the tool's output is paused while this runs. Without it, stdout is collected (up to 32 MiB). */
  onStdout?(chunk: Uint8Array): Promise<void> | void
  /** The tool's `pipe:3` (e.g. `-stats_mux_pre pipe:3`), read as it comes and never paused; null once it has closed. */
  onSide?(chunk: Uint8Array | null): void
  /** Paths removed when the job fails or is stopped. */
  cleanup?: string[]
}

/** ffmpeg's demuxer for each container `mediaFormat` tells apart. */
const DEMUXER: Readonly<Record<MediaFormat, string>> = {
  mp4: 'mov', mov: 'mov', m4a: 'mov',
  webm: 'matroska', mkv: 'matroska',
  wav: 'wav', avi: 'avi', mp3: 'mp3', ogg: 'ogg', flac: 'flac', aac: 'aac',
}

/**
 * The arguments that open one input file: only the file and pipe protocols,
 * the demuxer named from the file's first bytes, and the path as a `file:`
 * address so no name is read as an option or another protocol. A mov-family
 * input also refuses data references to other files (`-enable_drefs 0`).
 * Throws (MEDIA_WORDS.unreadable) for a relative path, a `scheme:` address,
 * or a format it doesn't know.
 */
export function inputArgs(path: string, fmt: MediaFormat): string[] {
  const demuxer = Object.hasOwn(DEMUXER, fmt) ? DEMUXER[fmt] : undefined
  if (!demuxer || !isAbsolute(path) || path.includes('\0')) throw new MediaError('unreadable')
  return [
    '-protocol_whitelist', 'file,pipe',
    '-f', demuxer,
    ...(demuxer === 'mov' ? ['-enable_drefs', '0'] : []),
    '-i', `file:${path}`,
  ]
}

const TEMP_PREFIX = 'sailor-media-'
const tempDirs = new Set<string>()

/** A fresh folder for one job's outputs; the only place a job may write a file. */
export async function mediaTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
  tempDirs.add(dir)
  return dir
}

/** Removes a folder made by `mediaTempDir` and forgets it. */
export async function removeMediaTempDir(dir: string): Promise<void> {
  tempDirs.delete(dir)
  await rm(dir, { recursive: true, force: true })
}

/** Options that read or write files the media names, or that load a filtergraph from a file (media-tools.md). */
const FORBIDDEN_OPTIONS = new Set([
  '-report', '-dump_attachment', '-attach', '-filter_script', '-filter_complex_script', '-use_absolute_path',
  '-sdp_file', '-vstats_file', '-passlogfile', '-progress',
])

function insideTemp(p: string): boolean {
  const n = normalize(p)
  if (!isAbsolute(n) || n !== p) return false
  for (const dir of tempDirs) if (n.startsWith(dir + sep)) return true
  return false
}

/**
 * Refuses an argument list that breaks the module's rules before anything
 * starts: a forbidden option, a `-/option` (its value read from a file),
 * `-enable_drefs` other than 0, an input that isn't `file:<absolute>` or
 * `pipe:0`, a `file:` output outside a `mediaTempDir()` folder, or `pipe:3`
 * without a reader. Exported for tests.
 */
export function checkArgs(args: readonly string[], o: { side?: boolean } = {}): void {
  const bad = () => { throw new MediaError('failed') }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.includes('\0')) bad()
    // An option's name without its stream specifier (`-dump_attachment:t` is `-dump_attachment`).
    const name = a.startsWith('-') ? a.split(':')[0]! : ''
    if (FORBIDDEN_OPTIONS.has(name) || a.startsWith('-/')) bad()
    if (name === '-enable_drefs' && args[i + 1] !== '0') bad()
    if (a === '-i') {
      const v = args[++i]
      if (v === 'pipe:0') continue
      if (!v || !v.startsWith('file:') || !isAbsolute(v.slice(5))) bad()
      continue
    }
    if (a.startsWith('file:') && !insideTemp(a.slice(5))) bad()
    if (/^pipe:/.test(a) && a !== 'pipe:0' && a !== 'pipe:1' && !(a === 'pipe:3' && o.side)) bad()
    // Any other address a protocol could read (the build has none, belt and braces).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) bad()
  }
}

// ── the limiter ──────────────────────────────────────────────────────────────

interface Waiter { key: string; route: boolean; go: () => void }

const running = new Map<string, number>()
const queue: Waiter[] = []
let total = 0
let routeRunning = 0
let started = 0

function jobsMax(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2))
}
function perUser(): number {
  return isHosted() ? MEDIA_JOBS_PER_USER.hosted : MEDIA_JOBS_PER_USER.local
}
const keyOf = (userId: string | null) => userId ?? '\0local'

function canStart(w: Waiter): boolean {
  if (w.route) return routeRunning < MEDIA_ROUTE_SLOTS
  return total < jobsMax() && (running.get(w.key) ?? 0) < perUser()
}

function take(w: Waiter): void {
  if (w.route) routeRunning++
  else { total++; running.set(w.key, (running.get(w.key) ?? 0) + 1) }
}

function pump(): void {
  for (let i = 0; i < queue.length;) {
    const w = queue[i]!
    if (canStart(w)) {
      queue.splice(i, 1)
      take(w)
      w.go()
    }
    else i++
  }
}

/** Waits in order for a slot; the returned function gives it back. Stop while waiting leaves the queue. */
function acquire(userId: string | null, route: boolean, signal?: AbortSignal): Promise<() => void> {
  const key = keyOf(userId)
  return new Promise((resolve, reject) => {
    let done = false
    const release = () => {
      if (done) return
      done = true
      if (route) routeRunning--
      else {
        total--
        const n = (running.get(key) ?? 1) - 1
        if (n > 0) running.set(key, n)
        else running.delete(key)
      }
      pump()
    }
    const onAbort = () => {
      const at = queue.indexOf(w)
      if (at >= 0) queue.splice(at, 1)
      reject(new MediaError('stopped'))
    }
    const w: Waiter = {
      key, route,
      go: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(release)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queue.push(w)
    pump()
  })
}

/** For tests: jobs running or waiting for a person, and how many processes have been started. */
export function mediaLimiter(): { pending(userId: string | null): number; started(): number } {
  return {
    pending: (userId) => {
      const key = keyOf(userId)
      return (running.get(key) ?? 0) + queue.filter(w => w.key === key && !w.route).length
    },
    started: () => started,
  }
}

// ── one job ──────────────────────────────────────────────────────────────────

/** Output collected when there is no `onStdout` (a probe's JSON); anything larger is not a probe. */
const STDOUT_MAX_BYTES = 32 * 1024 * 1024

function defaultTimeout(route: boolean): number {
  if (route) return MEDIA_JOB_TIMEOUT_MS.route
  return isHosted() ? MEDIA_JOB_TIMEOUT_MS.hosted : MEDIA_JOB_TIMEOUT_MS.local
}

/** The fixed start of every job, then the job's own arguments (hosted threads before each input). */
function fullArgs(tool: 'ffmpeg' | 'ffprobe', args: readonly string[]): string[] {
  const hosted = isHosted()
  const out = tool === 'ffmpeg' ? ['-nostdin'] : []
  out.push('-hide_banner', '-loglevel', 'error', '-max_alloc', String(MEDIA_MAX_ALLOC))
  if (hosted && tool === 'ffmpeg') out.push('-filter_threads', '1')
  for (let i = 0; i < args.length; i++) {
    if (hosted && tool === 'ffmpeg' && args[i] === '-i') out.push('-threads', '2')
    out.push(args[i]!)
  }
  return out
}

/**
 * Runs one tool to the end. Resolves with its collected stdout (null when
 * `onStdout` took it) and the tail of its stderr; rejects with a MediaError
 * (or the error `onStdout` threw), after the process is gone and `cleanup`
 * removed.
 */
export async function runMedia(job: MediaJob): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  checkArgs(job.args, { side: !!job.onSide })
  if (job.signal?.aborted) {
    await removeAll(job.cleanup)
    throw new MediaError('stopped')
  }
  const tools = await mediaTools()
  if (!tools) throw new MediaError('toolsMissing')
  let release: () => void
  try { release = await acquire(job.userId, !!job.route, job.signal) }
  catch (e) {
    await removeAll(job.cleanup)
    throw e
  }
  try {
    return await spawnJob(tools[job.tool], job)
  }
  finally {
    release()
  }
}

async function removeAll(paths?: string[]): Promise<void> {
  for (const p of paths ?? []) await rm(p, { recursive: true, force: true }).catch(() => {})
}

function spawnJob(file: string, job: MediaJob): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  const args = fullArgs(job.tool, job.args)
  const timeoutMs = job.timeoutMs ?? defaultTimeout(!!job.route)
  return new Promise((resolve, reject) => {
    const stdio: ('ignore' | 'pipe')[] = [job.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    if (job.onSide) stdio.push('pipe')
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio, env: { LC_ALL: 'C' }, shell: false })
    }
    catch {
      reject(new MediaError('failed'))
      return
    }
    started++

    let failure: unknown = null
    let exited = false
    let stderrTail = Buffer.alloc(0)
    const collected: Buffer[] = []
    let collectedBytes = 0
    let inflight: Promise<void> = Promise.resolve()

    const kill = () => {
      if (!exited) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    const fail = (e: unknown) => {
      if (failure === null) failure = e
      kill()
    }

    const timer = setTimeout(() => fail(new MediaError('timedOut')), timeoutMs)
    const onAbort = () => fail(new MediaError('stopped'))
    job.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr!.on('data', (b: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, b])
      if (stderrTail.length > MEDIA_STDERR_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MEDIA_STDERR_BYTES)
    })

    const out = child.stdout!
    out.on('data', (b: Buffer) => {
      if (failure !== null) return
      if (job.onStdout) {
        out.pause()
        inflight = inflight
          .then(() => (failure === null ? job.onStdout!(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) : undefined))
          .then(() => { if (failure === null) out.resume() }, (e) => { fail(e); out.resume() })
        return
      }
      collectedBytes += b.length
      if (collectedBytes > STDOUT_MAX_BYTES) { fail(new MediaError('failed')); return }
      collected.push(b)
    })

    if (job.onSide) {
      const side = child.stdio[3] as NodeJS.ReadableStream
      side.on('data', (b: Buffer) => {
        if (failure !== null) return
        try { job.onSide!(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) }
        catch (e) { fail(e) }
      })
      // Always told, even after a failure, so a reader waiting on it can't hang.
      side.once('close', () => {
        try { job.onSide!(null) }
        catch (e) { fail(e) }
      })
    }

    if (job.stdin) {
      const sink = child.stdin!
      sink.on('error', () => { /* the tool stopped reading; its exit code says why */ })
      void (async () => {
        try {
          for await (const chunk of job.stdin!) {
            if (failure !== null || exited) break
            if (!sink.write(chunk)) {
              await new Promise<void>(r => { sink.once('drain', r); sink.once('close', r) })
            }
          }
        }
        catch (e) { fail(e) }
        finally { sink.end() }
      })()
    }

    child.on('error', () => fail(new MediaError('failed')))
    child.on('exit', () => { exited = true })
    child.on('close', (code, sig) => {
      exited = true
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
      const finish = async () => {
        if (failure === null && code !== 0) failure = new MediaError('failed')
        const tail = stderrTail.toString('utf8')
        if (failure !== null) {
          const word = failure instanceof MediaError ? failure.word : 'error'
          console.warn(`[media] media.job.failed: ${job.tool} (${word}, exit ${code ?? sig}): ${tail.trim().slice(-2000)}`)
          await removeAll(job.cleanup)
          reject(failure)
          return
        }
        resolve({ stdout: job.onStdout ? null : new Uint8Array(Buffer.concat(collected)), stderrTail: tail })
      }
      // A failed job doesn't wait on a reader that may itself be waiting (Stop and time limits end at once).
      if (failure !== null) void finish()
      else void inflight.then(finish)
    })
  })
}
