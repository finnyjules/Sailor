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
 *     files only as `file:<absolute path>` inside the job's own folder
 *     (`workDir`), which is also its working directory. Before the tool
 *     starts, each output is checked on disk too (`confineOutputs`): its
 *     folder must really be the job's folder (symlinks resolved), and the
 *     file is made there first as a new regular file without following a
 *     link, so a symlink named like an output can't send the write
 *     elsewhere;
 *   - carries only options on an allow-list (`checkArgs`), each with its
 *     number of values, so nothing that reads or writes a file by name
 *     (`-report`, `-vstats`, `-print_graphs_file`, `-fpre`, `-dump_attachment`,
 *     `-attach`, ffprobe's `-o`, `-/opt`, …) can get in. Filtergraphs are
 *     built in this module from numbers and fixed words, never from a
 *     person's text;
 *   - can't be started from inside another job's callbacks (`onStdout`,
 *     `onSide`): with one slot per person in hosted, a job waiting on its own
 *     child would wait for ever, so it is refused at once instead;
 *   - waits its turn behind the limiter (one job per person hosted, two
 *     local, at most max(1, ⌊cpus / 2⌋) at once; the thumbnail and waveform
 *     routes have two slots of their own);
 *   - has a time limit, and is killed (SIGKILL) at once by Stop or by the
 *     limit, its partial outputs removed;
 *   - keeps at most 64 KiB of stderr, logged on failure and never shown: a
 *     failure reaches a person only as MEDIA_WORDS.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
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
  /**
   * The run's own temporary folder (`mediaTempDir()`): the job's working
   * directory, and the only place its `file:` outputs may be. Without it the
   * job gets a fresh empty folder of its own, removed afterwards, and may
   * write no file.
   */
  workDir?: string
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

/** A fresh folder for one run's outputs; the only place a job may write a file. */
export async function mediaTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), TEMP_PREFIX))
}

/** Removes a folder made by `mediaTempDir`. */
export async function removeMediaTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * The options a job may carry and how many values each takes (by name, a
 * stream specifier dropped: `-c:a` is `-c`). Everything else is refused.
 * The second block is the encoders' own (R5.1c): raw inputs described in
 * full, the encoder settings encode.ts and h264Quality.ts pass, a filter
 * graph built in encode.ts from numbers and fixed words, and the
 * workflow tags as an ffmetadata input mapped in.
 */
const ALLOWED_OPTIONS: Readonly<Record<'ffmpeg' | 'ffprobe', Readonly<Record<string, number>>>> = {
  ffmpeg: {
    '-copyts': 0, '-reinit_filter': 1, '-noautorotate': 0,
    '-protocol_whitelist': 1, '-f': 1, '-enable_drefs': 1, '-i': 1,
    '-map': 1, '-fps_mode': 1, '-vf': 1, '-c': 1,
    '-stats_mux_pre': 1, '-stats_mux_pre_fmt': 1,
    '-y': 0,
    // R5.1c, the encoders.
    '-pix_fmt': 1, '-s': 1, '-framerate': 1,
    '-ar': 1, '-ch_layout': 1, '-sample_fmt': 1,
    '-b': 1, '-q': 1, '-rc_mode': 1, '-qmin': 1, '-qmax': 1, '-coder': 1, '-threads': 1,
    '-filter_complex': 1, '-af': 1,
    '-movflags': 1, '-map_metadata': 1, '-fflags': 1, '-enc_time_base': 1,
  },
  ffprobe: {
    '-probesize': 1, '-analyzeduration': 1,
    '-protocol_whitelist': 1, '-f': 1, '-enable_drefs': 1, '-i': 1,
    '-of': 1, '-show_format': 0, '-show_streams': 0, '-count_packets': 0,
    '-select_streams': 1, '-show_entries': 1, '-read_intervals': 1,
  },
}

/** `file:<absolute, normalised path>` strictly inside `dir`. */
function fileInside(arg: string, dir: string | undefined): boolean {
  if (!dir || !arg.startsWith('file:')) return false
  const p = arg.slice(5)
  return isAbsolute(p) && normalize(p) === p && p.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Refuses an argument list that breaks the module's rules, before anything
 * starts:
 *   - an option not on the allow-list (with `-/opt`, whose value is read
 *     from a file), or one missing its value;
 *   - `-protocol_whitelist` other than `file,pipe`, `-enable_drefs` other
 *     than 0, `-stats_mux_pre` other than `pipe:3` (and only with a reader);
 *   - an input other than `file:<absolute path>` or `pipe:0`;
 *   - an output (any other word) other than `pipe:1` or `file:<absolute
 *     path>` inside `workDir`; ffprobe has no outputs at all.
 * Exported for tests.
 */
export function checkArgs(tool: 'ffmpeg' | 'ffprobe', args: readonly string[], o: { side?: boolean; workDir?: string } = {}): void {
  const bad = () => { throw new MediaError('failed') }
  const allowed = ALLOWED_OPTIONS[tool]
  for (const a of args) if (a.includes('\0')) bad()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-') && a !== '-') {
      const name = a.split(':')[0]!
      const arity = Object.hasOwn(allowed, name) ? allowed[name]! : undefined
      if (arity === undefined) bad()
      const v = arity ? args[i + 1] : undefined
      if (arity && v === undefined) bad()
      if (name === '-protocol_whitelist' && v !== 'file,pipe') bad()
      if (name === '-enable_drefs' && v !== '0') bad()
      if (name === '-stats_mux_pre' && !(v === 'pipe:3' && o.side)) bad()
      if (name === '-movflags' && !/^[+a-z_]+$/.test(v!)) bad()
      if (name === '-map_metadata' && !/^(?:-1|\d+)$/.test(v!)) bad()
      if (name === '-fflags' && v !== '+bitexact') bad()
      if (name === '-enc_time_base' && !/^\d+\/\d+$/.test(v!)) bad()
      if (name === '-i' && v !== 'pipe:0' && !(v!.startsWith('file:') && isAbsolute(v!.slice(5)) && normalize(v!.slice(5)) === v!.slice(5))) bad()
      i += arity!
      continue
    }
    // An output.
    if (tool === 'ffprobe') bad()
    if (a !== 'pipe:1' && !fileInside(a, o.workDir)) bad()
  }
}

/**
 * The `file:` outputs of an argument list (the words `checkArgs` reads as
 * outputs), as paths.
 */
function fileOutputs(args: readonly string[]): string[] {
  const allowed = ALLOWED_OPTIONS.ffmpeg
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-') && a !== '-') {
      const name = a.split(':')[0]!
      i += Object.hasOwn(allowed, name) ? allowed[name]! : 0
      continue
    }
    if (a.startsWith('file:')) out.push(a.slice(5))
  }
  return out
}

/**
 * The physical half of the output rule (R5.1b re-review: the lexical check
 * alone let a symlink inside the job's folder send a write elsewhere). For
 * every `file:` output: its folder, symlinks resolved, must be the job's
 * folder or one inside it; then the file is made there as a new regular
 * file with O_EXCL | O_NOFOLLOW, so the tool writes into that very file. A
 * name that already exists passes only as a regular file (never a link).
 * Exported for tests.
 */
export async function confineOutputs(args: readonly string[], workDir: string | undefined): Promise<void> {
  const outs = fileOutputs(args)
  if (!outs.length) return
  const bad = () => { throw new MediaError('failed') }
  if (!workDir) bad()
  let root: string
  try { root = await realpath(workDir!) }
  catch { bad() }
  for (const p of outs) {
    let folder: string
    try { folder = await realpath(dirname(p)) }
    catch { bad() }
    if (folder! !== root! && !folder!.startsWith(root! + sep)) bad()
    try {
      const fh = await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      await fh.close()
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') bad()
      const st = await lstat(p).catch(() => null)
      if (!st || st.isSymbolicLink() || !st.isFile()) bad()
    }
  }
}

// ── nested jobs ──────────────────────────────────────────────────────────────

/** Set while a job's own callbacks run (and in everything they await). */
const insideCallback = new AsyncLocalStorage<true>()

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
  if (insideCallback.getStore()) {
    // The safer choice (R5.1b review, Minor 6): a callback may not start a job. Hosted gives a person one
    // slot, which the parent holds, so the child would wait for ever. Pipelines run as one ffmpeg job.
    console.warn(`[media] media.job.refused: a ${job.tool} job was started from inside another job's callback`)
    throw new MediaError('failed')
  }
  checkArgs(job.tool, job.args, { side: !!job.onSide, workDir: job.workDir })
  if (job.tool === 'ffmpeg') await confineOutputs(job.args, job.workDir)
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
  let ownDir: string | null = null
  try {
    if (!job.workDir) ownDir = await mediaTempDir()
    return await spawnJob(tools[job.tool], job, job.workDir ?? ownDir!)
  }
  finally {
    release()
    if (ownDir) await removeMediaTempDir(ownDir).catch(() => {})
  }
}

async function removeAll(paths?: string[]): Promise<void> {
  for (const p of paths ?? []) await rm(p, { recursive: true, force: true }).catch(() => {})
}

function spawnJob(file: string, job: MediaJob, cwd: string): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  const args = fullArgs(job.tool, job.args)
  const timeoutMs = job.timeoutMs ?? defaultTimeout(!!job.route)
  return new Promise((resolve, reject) => {
    const stdio: ('ignore' | 'pipe')[] = [job.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    if (job.onSide) stdio.push('pipe')
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio, cwd, env: { LC_ALL: 'C' }, shell: false })
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
    // Wakes the end of the job when it fails, even while a callback is still stuck.
    let wakeFailed: () => void = () => {}
    const failed = new Promise<void>((r) => { wakeFailed = r })
    const fail = (e: unknown) => {
      if (failure === null) failure = e
      kill()
      wakeFailed()
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
          .then(() => (failure === null ? insideCallback.run(true, () => job.onStdout!(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) : undefined))
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
        try { insideCallback.run(true, () => job.onSide!(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) }
        catch (e) { fail(e) }
      })
      // Always told, even after a failure, so a reader waiting on it can't hang.
      side.once('close', () => {
        try { insideCallback.run(true, () => job.onSide!(null)) }
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
      let finished = false
      const finish = async () => {
        if (finished) return
        finished = true
        // The time limit and Stop cover the job until here, a stuck callback included.
        clearTimeout(timer)
        job.signal?.removeEventListener('abort', onAbort)
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
      // The callbacks' last work, unless the job fails first (Stop, the time limit, an error):
      // a failed job never waits on a callback that may itself be stuck.
      void Promise.race([inflight, failed]).then(finish)
    })
  })
}
