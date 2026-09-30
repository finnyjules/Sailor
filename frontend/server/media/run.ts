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
 *     (`workDir`), which is also its working directory. Once the job has
 *     its slot, just before the tool starts, each output is checked on disk
 *     too (`confineOutputs`): its folder must really be the job's folder
 *     (symlinks resolved), and the file is made there as a new regular file
 *     without following a link (an existing name is refused), so neither a
 *     symlink nor a hard link named like an output can send the write
 *     elsewhere; afterwards it must still be that same file;
 *   - carries only options on an allow-list (`checkArgs`), each with its
 *     number of values, so nothing that reads or writes a file by name
 *     (`-report`, `-vstats`, `-print_graphs_file`, `-fpre`, `-dump_attachment`,
 *     `-attach`, ffprobe's `-o`, `-/opt`, …) can get in. Filtergraphs are
 *     built in this module from numbers and fixed words, never from a
 *     person's text, and `checkFilterGraph` admits only the filters the
 *     module uses, with their own options (none of which names a file):
 *     the build's filters that open files by name (deshake, xpsnr, fsync,
 *     life, …) can't be reached;
 *   - can't be started from inside another job's callbacks (`onStdout`,
 *     `onSide`): with one slot per person in hosted, a job waiting on its own
 *     child would wait for ever, so it is refused at once instead;
 *   - waits its turn behind the limiter (one job per person hosted, two
 *     local, at most max(1, ⌊cpus / 2⌋) at once; the thumbnail and waveform
 *     routes have two slots of their own, of which a person holds one at most
 *     in hosted with four more waiting, and a route job waits at most
 *     MEDIA_ROUTE_WAIT_MS, the wait counted in its 30 s: past either it is
 *     refused at once with MEDIA_WORDS.busy);
 *   - has a time limit, and is killed (SIGKILL) at once by Stop or by the
 *     limit, its partial outputs removed;
 *   - keeps at most 64 KiB of stderr, logged on failure and never shown: a
 *     failure reaches a person only as MEDIA_WORDS.
 *
 * A node that runs several tools at once (R6.1, ruling (n): a video effect's
 * decodes and its encode, at most MEDIA_LEASE_PROCESSES) takes ONE of the
 * person's slots for all of them with `mediaLease`, all at once, so it never
 * waits on itself; its jobs carry the lease (MediaJob.lease) and take no slot
 * of their own. Ending the lease (its job settled, Stop, a failure) kills
 * every process it started (SIGKILL) and waits for them to be gone, their
 * partial outputs removed, before the slot is given back.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import {
  MEDIA_JOB_TIMEOUT_MS, MEDIA_JOBS_PER_USER, MEDIA_LEASE_PROCESSES, MEDIA_MAX_ALLOC, MEDIA_ROUTE_JOBS_PER_USER, MEDIA_ROUTE_SLOTS, MEDIA_ROUTE_WAIT_MS,
  MEDIA_STALL_MS, MEDIA_STDERR_BYTES, MEDIA_WORDS,
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
  /**
   * R6.1: the node's lease (`mediaLease`): the job runs in the lease's slot
   * instead of taking its own, as one of its processes, and ends with it.
   * `userId` must be the lease's.
   */
  lease?: MediaLease
}

/** One of a person's media slots, held by one node for all its tool processes (R6.1, `mediaLease`). */
export interface MediaLease {
  readonly userId: string | null
  /** Aborted by the node's Stop and when the lease ends. */
  readonly signal?: AbortSignal
  /** False once the lease has ended (or was stopped): a job can't start under it any more. */
  readonly live: boolean
}

/** ffmpeg's demuxer for each container `mediaFormat` tells apart. */
const DEMUXER: Readonly<Record<MediaFormat, string>> = {
  mp4: 'mov', mov: 'mov', m4a: 'mov',
  webm: 'matroska', mkv: 'matroska',
  wav: 'wav', avi: 'avi', mp3: 'mp3', ogg: 'ogg', flac: 'flac', aac: 'aac',
  // R5.4 fix round 1: single-file containers Python's LoadVideo reads (the build has had their demuxers since R5.1a).
  mpegts: 'mpegts', mpegps: 'mpeg', flv: 'flv', asf: 'asf',
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
    // R5.5 fix round 1: Save video frames' sound scan stops at the first decode error, as PyAV raises there.
    '-xerror': 0,
    '-protocol_whitelist': 1, '-f': 1, '-enable_drefs': 1, '-i': 1,
    '-map': 1, '-fps_mode': 1, '-vf': 1, '-c': 1,
    '-stats_mux_pre': 1, '-stats_mux_pre_fmt': 1,
    '-y': 0,
    // R5.1c, the encoders.
    '-pix_fmt': 1, '-s': 1, '-framerate': 1,
    '-ar': 1, '-ch_layout': 1, '-sample_fmt': 1,
    '-b': 1, '-q': 1, '-rc_mode': 1, '-qmin': 1, '-qmax': 1, '-coder': 1, '-threads': 1,
    '-filter_complex': 1, '-af': 1,
    '-movflags': 1, '-map_metadata': 1, '-fflags': 1, '-enc_time_base': 1, '-bsf': 1,
    // R5.2: a kept frame batch read at the video's rate (encode.ts, the 'ffv1' input).
    '-r': 1,
    // get_components' seek (decode.ts pythonSeekArgs) and its leading frames; R5.6's thumbnail seek (thumbnails.ts).
    '-ss': 1, '-seek_timestamp': 1, '-noaccurate_seek': 0, '-frames': 1,
    // R5.4: Save video's stream copy (encode.ts copyVideo): each stream's time base as PyAV's muxer
    // sets it, and no chapters (Python copies none).
    '-time_base': 1, '-map_chapters': 1,
    // R5.4: an encoded stream carries no `encoder` tag (PyAV writes none; only `encoder=`, which clears it).
    '-metadata': 1,
    // R5.4 fix round 1: a copied stream's codec tag as PyAV's reset gives it (encode.ts MP4_DEFAULT_TAG).
    '-tag': 1,
  },
  ffprobe: {
    '-probesize': 1, '-analyzeduration': 1,
    '-protocol_whitelist': 1, '-f': 1, '-enable_drefs': 1, '-i': 1,
    '-of': 1, '-show_format': 0, '-show_streams': 0, '-count_packets': 0,
    '-select_streams': 1, '-show_entries': 1, '-read_intervals': 1,
  },
}

/**
 * The filters the media module uses, and the options each may carry (a key
 * of '' is a value given without a name). None of them reads or writes a
 * file.
 */
const ALLOWED_FILTERS: Readonly<Record<string, readonly string[]>> = {
  // Its expression is pinned to SELECT_FORMS below (R5.6 fix round 1).
  select: [''],
  scale: ['w', 'h', 'eval', 'flags', 'in_h_chr_pos', 'in_v_chr_pos', 'out_h_chr_pos', 'out_v_chr_pos'],
  format: [''],
  settb: ['expr'],
  setpts: [''],
  trim: ['start_frame'],
  concat: ['n', 'v', 'a'],
  atrim: ['end_sample'],
  asetpts: [''],
  // R5.4: Get video components' one job hands the same frames to the kept batch and to the size check (values.ts keepVideoFrames).
  split: [''],
  // R5.5: Save video frames pads an odd size to even with black (encode.ts `padToEven`).
  pad: ['w', 'h', 'x', 'y', 'color'],
  // R3.17 fix round 1: the stitch gives each renumbered frame one frame's duration (encode.ts `clips`).
  fps: [''],
}

/**
 * The only `select` expressions the module builds (R5.6 fix round 1: the
 * expression language has loops and variables, so the shape is pinned, not
 * only its characters): decode.ts's `gte(pts\,0)`, a thumbnail's
 * `gte(pts\,<target>)` (thumbnails.ts) and Load video frames' pick
 * `gte(n\,<start>)*not(mod(n-<start>\,<stride>))` (decode.ts pickFilter).
 */
const SELECT_FORMS: readonly RegExp[] = [
  /^gte\(pts\\,\d{1,18}\)$/,
  /^gte\(n\\,(\d{1,15})\)\*not\(mod\(n-(\d{1,15})\\,\d{1,15}\)\)$/,
]

function selectAllowed(expr: string): boolean {
  const m = SELECT_FORMS.map(r => r.exec(expr)).find(Boolean)
  if (!m) return false
  // The pick names its start twice, the same number both times.
  return m.length < 3 || m[1] === m[2]
}

/**
 * A filtergraph as the module builds it: no quotes, spaces or other syntax
 * that could hide a filter from this reading, a backslash only before a comma,
 * `[label]`s of plain words (an input's may name a stream, `[0:v:0]`), and
 * every filter and option on ALLOWED_FILTERS.
 * Exported for tests.
 */
export function checkFilterGraph(graph: string): boolean {
  if (!/^[A-Za-z0-9_=:.,;[\]\\()*/+-]+$/.test(graph)) return false
  if (/\\(?!,)/.test(graph)) return false
  for (const chain of graph.split(';')) {
    // Split on commas that aren't escaped.
    for (const f of chain.split(/(?<!\\),/)) {
      const m = /^(?:\[[A-Za-z0-9_:]+\])*([a-z]+)(?:=([^[\]]*))?(?:\[[A-Za-z0-9_]+\])*$/.exec(f)
      if (!m) return false
      const keys = Object.hasOwn(ALLOWED_FILTERS, m[1]!) ? ALLOWED_FILTERS[m[1]!]! : null
      if (!keys) return false
      if (m[1] === 'select' && (m[2] === undefined || !selectAllowed(m[2]))) return false
      if (m[2] === undefined) continue
      for (const opt of m[2].split(':')) {
        const eq = opt.indexOf('=')
        const key = eq < 0 ? '' : opt.slice(0, eq)
        const value = eq < 0 ? opt : opt.slice(eq + 1)
        if (!keys.includes(key) || !value || value.includes('=')) return false
      }
    }
  }
  return true
}

/**
 * R5.5: SaveVideoFrames' sound packets numbered from 0 (encode.ts): Python
 * hands the AAC encoder frames with no pts, so the muxer numbers its packets
 * from 0 and the encoder's priming delay stays at the front of the sound.
 */
export const FROM_ZERO_BSF = 'setts=pts=PTS-STARTPTS:dts=DTS-STARTDTS'

/**
 * R5.5 fix round 1: packets numbered 0, 1024, 2048… (whole AAC frames), then only the first N kept (`noise`'s
 * drop expression: every packet from number N on is dropped). A sound that
 * failed partway in Python ended with its encoder unflushed, so its file holds
 * only the packets made before the error. `-frames:a` can't do this: in ffmpeg
 * 8 a stream reaching its frame limit ends the whole output file.
 */
export const FROM_ZERO_BSF_CUT = /^setts=pts=N\*1024:dts=N\*1024:duration=1024,noise=drop=gte\(n\\,\d{1,9}\)$/

/** FROM_ZERO_BSF, keeping only the first `packets` packets. */
export function fromZeroBsfCut(packets: number): string {
  if (!Number.isSafeInteger(packets) || packets < 1) throw new MediaError('failed')
  // Every packet kept is a whole AAC frame (1024 samples), numbered from 0, as Python's muxer numbers the
  // unflushed encoder's: a sound converted from mono would otherwise carry the resampler's stamps (a 1023).
  return `setts=pts=N*1024:dts=N*1024:duration=1024,noise=drop=gte(n\\,${packets})`
}

/** `-r`'s value: `num/den` or a decimal, both positive. Exported for tests. */
export function validRate(v: string): boolean {
  const m = /^(\d{1,9})\/(\d{1,9})$/.exec(v)
  if (m) return Number(m[1]) > 0 && Number(m[2]) > 0
  return /^\d{1,9}(?:\.\d{1,9})?$/.test(v) && Number(v) > 0
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
      // A rate only: a positive fraction or a positive decimal (R5.2 fix round 1).
      if (name === '-r' && !validRate(v!)) bad()
      if (name === '-map_metadata' && !/^(?:-1|\d+)$/.test(v!)) bad()
      if (name === '-fflags' && v !== '+bitexact') bad()
      if (name === '-enc_time_base' && !/^\d+\/\d+$/.test(v!)) bad()
      if ((name === '-vf' || name === '-af' || name === '-filter_complex') && !checkFilterGraph(v!)) bad()
      if (name === '-bsf' && !/^setts=dts=DTS-\d+$/.test(v!) && v !== FROM_ZERO_BSF && !FROM_ZERO_BSF_CUT.test(v!)) bad()
      // R5.6: a thumbnail's seek, whole microseconds (thumbnails.ts `seekMicros`); otherwise get_components' 0.
      if (name === '-ss' && v !== '0' && !/^\d{1,15}us$/.test(v!)) bad()
      if (name === '-seek_timestamp' && v !== '1') bad()
      if (name === '-frames' && !/^\d+$/.test(v!)) bad()
      if (name === '-time_base' && !/^1\/\d{1,9}$/.test(v!)) bad()
      if (name === '-map_chapters' && v !== '-1') bad()
      if (name === '-metadata' && v !== 'encoder=') bad()
      if (name === '-tag' && v !== 'avc1' && v !== 'hev1') bad()
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

/** An output made by `confineOutputs`: the file the tool must write, by its identity. */
export interface ConfinedOutput { path: string; dev: number; ino: number }

/**
 * The physical half of the output rule (R5.1b re-review: the lexical check
 * alone let a symlink inside the job's folder send a write elsewhere). Run
 * after the job has its slot, just before the tool starts (R5.1c review,
 * Minor 1: not across the wait in the queue). For every `file:` output: its
 * folder, symlinks resolved, must be the job's folder or one inside it; then
 * the file is made there as a new regular file with O_EXCL | O_NOFOLLOW. A
 * name that already exists is refused, whatever it is (a planted symlink or
 * a hard link to a file elsewhere alike). Exported for tests.
 */
export async function confineOutputs(args: readonly string[], workDir: string | undefined): Promise<ConfinedOutput[]> {
  const outs = fileOutputs(args)
  if (!outs.length) return []
  const bad = () => { throw new MediaError('failed') }
  if (!workDir) bad()
  let root: string
  try { root = await realpath(workDir!) }
  catch { bad() }
  const made: ConfinedOutput[] = []
  for (const p of outs) {
    let folder: string
    try { folder = await realpath(dirname(p)) }
    catch { bad() }
    if (folder! !== root! && !folder!.startsWith(root! + sep)) bad()
    try {
      const fh = await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      try {
        const st = await fh.stat()
        made.push({ path: p, dev: st.dev, ino: st.ino })
      }
      finally { await fh.close() }
    }
    catch { bad() }
  }
  return made
}

/**
 * After the tool: each output is still the very file `confineOutputs` made
 * (the same inode, a regular file with one link), so nothing swapped in while
 * it ran is ever moved on as the result. Exported for tests.
 */
export async function checkConfinedOutputs(made: readonly ConfinedOutput[]): Promise<void> {
  for (const o of made) {
    const st = await lstat(o.path).catch(() => null)
    if (!st || !st.isFile() || st.nlink !== 1 || st.ino !== o.ino || st.dev !== o.dev) throw new MediaError('failed')
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
/** Route jobs running per person (hosted holds each to MEDIA_ROUTE_JOBS_PER_USER.running). */
const routeRunningBy = new Map<string, number>()
let started = 0

function jobsMax(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2))
}
function perUser(): number {
  return isHosted() ? MEDIA_JOBS_PER_USER.hosted : MEDIA_JOBS_PER_USER.local
}
const keyOf = (userId: string | null) => userId ?? '\0local'

function canStart(w: Waiter): boolean {
  if (w.route) return routeRunning < MEDIA_ROUTE_SLOTS && (!isHosted() || (routeRunningBy.get(w.key) ?? 0) < MEDIA_ROUTE_JOBS_PER_USER.running)
  return total < jobsMax() && (running.get(w.key) ?? 0) < perUser()
}

function take(w: Waiter): void {
  if (w.route) { routeRunning++; routeRunningBy.set(w.key, (routeRunningBy.get(w.key) ?? 0) + 1) }
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

/**
 * Waits in order for a slot; the returned function gives it back. Stop while
 * waiting leaves the queue. A route job (R5.6 fix round 1) is refused at once
 * (busy) when its person already has MEDIA_ROUTE_JOBS_PER_USER.waiting route
 * jobs waiting (hosted), and leaves the queue refused (busy) after
 * MEDIA_ROUTE_WAIT_MS.
 */
function acquire(userId: string | null, route: boolean, signal?: AbortSignal): Promise<() => void> {
  const key = keyOf(userId)
  return new Promise((resolve, reject) => {
    if (route && isHosted() && queue.filter(q => q.route && q.key === key).length >= MEDIA_ROUTE_JOBS_PER_USER.waiting) {
      reject(new MediaError('busy'))
      return
    }
    let done = false
    let waitTimer: ReturnType<typeof setTimeout> | null = null
    const release = () => {
      if (done) return
      done = true
      if (route) {
        routeRunning--
        const n = (routeRunningBy.get(key) ?? 1) - 1
        if (n > 0) routeRunningBy.set(key, n)
        else routeRunningBy.delete(key)
      }
      else {
        total--
        const n = (running.get(key) ?? 1) - 1
        if (n > 0) running.set(key, n)
        else running.delete(key)
      }
      pump()
    }
    const leave = (word: 'stopped' | 'busy') => {
      const at = queue.indexOf(w)
      if (at >= 0) queue.splice(at, 1)
      if (waitTimer) clearTimeout(waitTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(new MediaError(word))
    }
    const onAbort = () => leave('stopped')
    const w: Waiter = {
      key, route,
      go: () => {
        signal?.removeEventListener('abort', onAbort)
        if (waitTimer) clearTimeout(waitTimer)
        resolve(release)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queue.push(w)
    if (route) waitTimer = setTimeout(() => leave('busy'), MEDIA_ROUTE_WAIT_MS)
    pump()
  })
}

/** For tests: jobs running or waiting for a person, and how many processes have been started. */
export function mediaLimiter(): { pending(userId: string | null): number; started(): number; routes(userId: string | null): { running: number; waiting: number } } {
  return {
    routes: (userId) => {
      const key = keyOf(userId)
      return { running: routeRunningBy.get(key) ?? 0, waiting: queue.filter(w => w.key === key && w.route).length }
    },
    pending: (userId) => {
      const key = keyOf(userId)
      return (running.get(key) ?? 0) + queue.filter(w => w.key === key && !w.route).length
    },
    started: () => started,
  }
}

// ── leases (R6.1) ────────────────────────────────────────────────────────────

interface LeaseState {
  userId: string | null
  signal: AbortSignal
  ended: boolean
  /** Processes running under it now. */
  processes: number
  /** Every job started under it, settled or not. */
  jobs: Set<Promise<unknown>>
}

const leases = new WeakMap<MediaLease, LeaseState>()

/**
 * One of the person's media slots for a node, taken once (it waits its turn
 * as a job would); up to MEDIA_LEASE_PROCESSES tool processes run under it at
 * once, none taking a slot of its own. When `job` settles, or Stop reaches the
 * lease, every process still running under it is killed (SIGKILL) and its
 * partial outputs removed; the slot is given back once they are all gone.
 */
export async function mediaLease<T>(o: { userId: string | null; signal?: AbortSignal }, job: (lease: MediaLease) => Promise<T>): Promise<T> {
  if (insideCallback.getStore()) {
    console.warn('[media] media.lease.refused: a lease was asked for from inside a job\'s callback')
    throw new MediaError('failed')
  }
  if (o.signal?.aborted) throw new MediaError('stopped')
  const release = await acquire(o.userId, false, o.signal)
  const end = new AbortController()
  const signal = o.signal ? AbortSignal.any([o.signal, end.signal]) : end.signal
  const state: LeaseState = { userId: o.userId, signal, ended: false, processes: 0, jobs: new Set() }
  const lease: MediaLease = {
    userId: o.userId,
    signal,
    get live() { return !state.ended && !signal.aborted },
  }
  leases.set(lease, state)
  try {
    return await job(lease)
  }
  finally {
    state.ended = true
    // Every process still running is killed now, and each job's partial outputs removed, before the slot goes back.
    end.abort()
    await Promise.allSettled([...state.jobs])
    release()
  }
}

/**
 * The clock a lease job's time is measured by (R6.1 fix round 1), and how
 * often its watchdog looks. Tests stub it (`__setMediaClockForTests`).
 */
const clock = { now: () => Date.now(), tickMs: 1000 }

/** Tests only: a stubbed clock for lease jobs' watchdog (null restores the real one). */
export function __setMediaClockForTests(c: { now: () => number; tickMs: number } | null): void {
  clock.now = c ? c.now : () => Date.now()
  clock.tickMs = c ? c.tickMs : 1000
}

/** For tests: processes running now under a lease (0 once it has ended). */
export function leaseProcesses(lease: MediaLease): number {
  return leases.get(lease)?.processes ?? 0
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
  if (job.signal?.aborted) {
    await removeAll(job.cleanup)
    throw new MediaError('stopped')
  }
  const tools = await mediaTools()
  if (!tools) throw new MediaError('toolsMissing')
  if (job.lease) return underLease(job, job.lease, tools)
  let release: () => void
  const asked = Date.now()
  try { release = await acquire(job.userId, !!job.route, job.signal) }
  catch (e) {
    await removeAll(job.cleanup)
    throw e
  }
  return inSlot(job, tools, release, asked)
}

/** A job in its lease's slot (R6.1): no slot of its own, Stop and the lease's end both reach it. */
function underLease(job: MediaJob, lease: MediaLease, tools: NonNullable<Awaited<ReturnType<typeof mediaTools>>>): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  const st = leases.get(lease)
  const refuse = async (word: MediaWord | 'failed') => {
    await removeAll(job.cleanup)
    throw new MediaError(word)
  }
  if (!st || st.ended || st.signal.aborted) return refuse('stopped')
  // A lease is one person's: its jobs are theirs, and no more at once than it was taken for.
  if (job.userId !== st.userId || job.route || st.processes >= MEDIA_LEASE_PROCESSES) return refuse('failed')
  st.processes++
  const signal = job.signal ? AbortSignal.any([job.signal, st.signal]) : st.signal
  let done = false
  const release = () => {
    if (done) return
    done = true
    st.processes--
  }
  const p = inSlot({ ...job, signal }, tools, release, Date.now())
  st.jobs.add(p.catch(() => {}))
  return p
}

/** The job once it has its slot: its outputs confined, the tool run, the slot given back. */
async function inSlot(job: MediaJob, tools: NonNullable<Awaited<ReturnType<typeof mediaTools>>>, release: () => void, asked: number): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  let ownDir: string | null = null
  try {
    if (!job.workDir) ownDir = await mediaTempDir()
    let made: ConfinedOutput[] = []
    try { made = job.tool === 'ffmpeg' ? await confineOutputs(job.args, job.workDir) : [] }
    catch (e) {
      await removeAll(job.cleanup)
      throw e
    }
    // A route job's wait for its slot counts against its time limit (R5.6 fix round 1).
    const left = job.route ? Math.max(1, MEDIA_JOB_TIMEOUT_MS.route - (Date.now() - asked)) : Number.POSITIVE_INFINITY
    const r = await spawnJob(tools[job.tool], job, job.workDir ?? ownDir!, left)
    try { await checkConfinedOutputs(made) }
    catch (e) {
      await removeAll(job.cleanup)
      throw e
    }
    return r
  }
  finally {
    release()
    if (ownDir) await removeMediaTempDir(ownDir).catch(() => {})
  }
}

async function removeAll(paths?: string[]): Promise<void> {
  for (const p of paths ?? []) await rm(p, { recursive: true, force: true }).catch(() => {})
}

function spawnJob(file: string, job: MediaJob, cwd: string, atMost = Number.POSITIVE_INFINITY): Promise<{ stdout: Uint8Array | null; stderrTail: string }> {
  const args = fullArgs(job.tool, job.args)
  const timeoutMs = Math.min(job.timeoutMs ?? defaultTimeout(!!job.route), atMost)
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

    // A job in a node's lease (R6.1 fix round 1) lives as long as its node streams frames through it, so it
    // isn't held to one span of wall-clock time. Its clock runs only while the tool owes the node something:
    // not while its output waits for the node (a frame queued on the worker, the next node's slot), nor while
    // it waits for the node's next frame to encode. Held to the job's limit of that time in hosted (none
    // locally, as Python has none), and killed when it makes no progress at all for MEDIA_STALL_MS.
    const leased = !!job.lease
    const activeLimit = leased ? (job.timeoutMs ?? (isHosted() ? MEDIA_JOB_TIMEOUT_MS.hosted : Number.POSITIVE_INFINITY)) : timeoutMs
    let ours = 0
    let active = 0
    let idle = 0
    let last = clock.now()
    const tick = () => {
      const now = clock.now()
      if (ours === 0) { active += now - last; idle += now - last }
      last = now
      if (active > activeLimit || idle > MEDIA_STALL_MS) fail(new MediaError('timedOut'))
    }
    const progress = () => { if (leased) { tick(); idle = 0 } }
    const oursBegins = () => { if (leased) { tick(); ours++ } }
    const oursEnds = () => { if (leased) { tick(); ours--; idle = 0 } }
    const watch = leased ? setInterval(tick, clock.tickMs) : null
    const timer = leased ? null : setTimeout(() => fail(new MediaError('timedOut')), timeoutMs)
    const onAbort = () => fail(new MediaError('stopped'))
    job.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr!.on('data', (b: Buffer) => {
      progress()
      stderrTail = Buffer.concat([stderrTail, b])
      if (stderrTail.length > MEDIA_STDERR_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MEDIA_STDERR_BYTES)
    })

    const out = child.stdout!
    out.on('data', (b: Buffer) => {
      if (failure !== null) return
      progress()
      if (job.onStdout) {
        out.pause()
        // The node's own time (it works on what it was handed): not the tool's.
        oursBegins()
        inflight = inflight
          .then(() => (failure === null ? insideCallback.run(true, () => job.onStdout!(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) : undefined))
          // Resumed on every path: after a failure the rest of the output is read and dropped (the handler
          // returns early), so the pipe drains and 'close' comes. A callback that ends cleanly after the job
          // was failed (a stopped reader's last frame) must not leave the pipe paused (R6.3: a hang).
          .then(() => { oursEnds(); out.resume() }, (e) => { oursEnds(); fail(e); out.resume() })
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
        progress()
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
        const it = job.stdin![Symbol.asyncIterator]()
        try {
          for (;;) {
            // Waiting for the node's next frame is the node's time, not the tool's.
            oursBegins()
            let got: IteratorResult<Uint8Array>
            try { got = await it.next() }
            finally { oursEnds() }
            if (got.done || failure !== null || exited) break
            if (!sink.write(got.value)) {
              await new Promise<void>((r) => {
                // Whichever comes first; the other listener goes too, so none pile up over a long encode.
                const done = () => { sink.off('drain', done); sink.off('close', done); r() }
                sink.once('drain', done)
                sink.once('close', done)
              })
            }
            progress()
          }
        }
        catch (e) { fail(e) }
        finally {
          sink.end()
          // Leaving early (a failure, Stop): the source is told, so it can let go of what it holds.
          if (failure !== null || exited) void Promise.resolve(it.return?.()).catch(() => {})
        }
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
        if (timer) clearTimeout(timer)
        if (watch) clearInterval(watch)
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
