/**
 * A mini app's run on the Sailor runner: the prompt it sends and the wait for
 * its picture on the runner's event pipe (useRunnerEvents posts each event on
 * window as a `sailor-bridge` envelope). The Face Swap app is the first app on
 * the runner (spec 2026-09-26-non-commercial-face-models-replacement).
 *
 * `gender`/`keepHairFrom` are the FaceSwap node's own human-readable combo
 * values (#shared/runner/faceSwap: FACE_SWAP_GENDER_OPTIONS,
 * FACE_SWAP_HAIR_OPTIONS) — the canvas shows a stored combo value raw, so the
 * app passes them straight through rather than translating to an identifier.
 *
 * Fix round 1: server/runner/engine.ts starts the leg before POST /api/runs
 * returns (app/layouts/default.vue's runnerEventBuffer/sendRunnerPost hazard
 * documents the same race), so the run's events can land on window before the
 * caller even knows its own prompt id. `awaitRunnerImage` therefore takes the
 * id as `string | Promise<string>`, attaches its window listener immediately
 * (synchronously, before the id promise can settle), and buffers every
 * sailor-bridge envelope until the id is known — then replays the buffer
 * against it and keeps matching live envelopes the same way.
 */
import type { ApiPrompt } from '#shared/runner/graph'

export interface RunnerImage { filename: string; subfolder: string; type: string }

export function buildFaceSwapPrompt(a: { face: string, target: string, gender: string, keepHairFrom: string }): ApiPrompt {
  return {
    1: { class_type: 'LoadImage', inputs: { image: a.face } },
    2: { class_type: 'LoadImage', inputs: { image: a.target } },
    3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: a.gender, keep_hair_from: a.keepHairFrom } },
  } as ApiPrompt
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>
type Envelope = Record<string, any>

/** What a run's listener does with each of its own envelopes: settle the wait, or keep waiting. */
interface Watch<T> {
  onEvent(d: Envelope, resolve: (v: T) => void, reject: (e: Error) => void): void
  /** The error the wait gives up with. */
  slow(): Error
}

/**
 * The shared wait (R8.0): a window listener attached at once (before
 * `promptId`, even a settled promise, can resolve), every sailor-bridge
 * envelope buffered until the id is known, then replayed against it, and live
 * envelopes matched the same way. The timeout starts at call time; an id that
 * fails rejects with its own error. The listener always goes when it settles.
 */
function watchRun<T>(promptId: string | Promise<string>, watch: Watch<T>, opts: { timeoutMs?: number, target?: Target, signal?: AbortSignal }): Promise<T> {
  const target = opts.target ?? window
  return new Promise<T>((resolve, reject) => {
    let resolvedId: string | null = null
    let finished = false
    const buffer: Envelope[] = []

    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      target.removeEventListener('message', onMessage as EventListener)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const done = (v: T) => finish(() => resolve(v))
    const fail = (e: Error) => finish(() => reject(e))

    const process = (d: Envelope) => {
      if (finished || resolvedId === null || d.prompt_id !== resolvedId) return
      watch.onEvent(d, done, fail)
    }

    const onMessage = (e: MessageEvent) => {
      const d = e.data as Envelope | null
      if (!d || d.type !== 'sailor-bridge') return
      if (resolvedId === null) { buffer.push(d); return }
      process(d)
    }

    const timer = setTimeout(() => fail(watch.slow()), opts.timeoutMs ?? 5 * 60_000)
    // The caller let go (an app closed mid-run): the listener goes at once.
    const onAbort = () => fail(new AppRunStopped())
    target.addEventListener('message', onMessage as EventListener)
    if (opts.signal?.aborted) { onAbort(); return }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    Promise.resolve(promptId).then(
      (id) => {
        if (finished) return
        resolvedId = id
        for (const d of buffer) {
          if (finished) break
          process(d)
        }
      },
      (err) => fail(err instanceof Error ? err : new Error(String(err))),
    )
  })
}

/** Face swap's wait: the first picture its run shows. */
export function awaitRunnerImage(promptId: string | Promise<string>, opts: { timeoutMs?: number, target?: Target } = {}): Promise<RunnerImage> {
  let picture: RunnerImage | null = null
  return watchRun<RunnerImage>(promptId, {
    slow: () => new Error('The swap took too long. Try again.'),
    onEvent(d, resolve, reject) {
      if (d.event === 'executed') {
        const img = d.output?.images?.[0]
        if (img?.filename) { picture = { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' }; resolve(picture) }
      } else if (d.event === 'execution_error') {
        reject(new Error(d.exception_message || 'The swap failed.'))
      } else if (d.event === 'execution_complete') {
        if (picture) resolve(picture)
        else reject(new Error('The swap finished but made no picture.'))
      }
    },
  }, opts)
}

/** One node's files from its `executed` output (its ui), sorted by kind, with the ui itself. */
export interface RunnerNodeOutput {
  images: RunnerImage[]
  audio: RunnerImage[]
  videos: RunnerImage[]
  ui: Record<string, unknown>
}

/** A run Stop ended (execution_complete with `stopped`), or a wait its caller let go. */
export class AppRunStopped extends Error {
  constructor() { super('Stopped.'); this.name = 'AppRunStopped' }
}

/** The wait gave up (awaitRunnerOutputs' timeout): the run may still be going until it is stopped. */
export class AppRunTimedOut extends Error {
  constructor(words: string) { super(words); this.name = 'AppRunTimedOut' }
}

const VIDEO_NAME = /\.(mp4|webm|mov|mkv|m4v|gif)$/i

function fileOf(f: any): RunnerImage | null {
  return f && typeof f.filename === 'string' && f.filename ? { filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' } : null
}

/**
 * A node's ui as files: `images` (a picture; Save video's video is an
 * animated entry there, R5.4, sorted to `videos` by its `animated` flag or
 * name), `audio`, and the video keys (`gifs`, `video`, `videos`).
 */
export function nodeOutputOf(ui: unknown): RunnerNodeOutput {
  const u = (ui && typeof ui === 'object' ? ui : {}) as Record<string, any>
  const out: RunnerNodeOutput = { images: [], audio: [], videos: [], ui: u }
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : v ? [v] : [])
  const animated = list(u.animated)
  list(u.images).forEach((f, i) => {
    const file = fileOf(f)
    if (!file) return
    if (animated[i] === true || (animated.length === 1 && animated[0] === true) || VIDEO_NAME.test(file.filename)) out.videos.push(file)
    else out.images.push(file)
  })
  for (const f of list(u.audio)) { const file = fileOf(f); if (file) out.audio.push(file) }
  for (const key of ['gifs', 'video', 'videos']) for (const f of list(u[key])) { const file = fileOf(f); if (file) out.videos.push(file) }
  return out
}

export interface AwaitOutputsOptions {
  timeoutMs?: number
  target?: Target
  /** Aborted: the wait ends at once (AppRunStopped) and its listener goes. */
  signal?: AbortSignal
  /** The app's own words for a failure with none of its own, a run that made nothing, and one that took too long. */
  words?: { failed?: string, empty?: string, slow?: string }
}

/**
 * A mini app's wait for its run (R8.0): each listed node's `executed` output,
 * by node id. Resolves once every listed node has shown its output; rejects
 * on the run's error (its own words), on a run that finished without one of
 * them, on Stop or `signal` (AppRunStopped) and on the timeout (AppRunTimedOut:
 * the caller stops the run, useAppRun does). Early events are kept, as
 * awaitRunnerImage keeps them.
 */
export function awaitRunnerOutputs(promptId: string | Promise<string>, nodeIds: readonly string[], opts: AwaitOutputsOptions = {}): Promise<Record<string, RunnerNodeOutput>> {
  const want = new Set(nodeIds.map(String))
  const got: Record<string, RunnerNodeOutput> = {}
  const complete = () => [...want].every(id => Object.prototype.hasOwnProperty.call(got, id))
  return watchRun(promptId, {
    slow: () => new AppRunTimedOut(opts.words?.slow ?? 'This took too long, so it was stopped.'),
    onEvent(d, resolve, reject) {
      if (d.event === 'executed') {
        const id = String(d.node_id ?? d.node ?? '')
        if (!want.has(id)) return
        got[id] = nodeOutputOf(d.output)
        if (complete()) resolve(got)
      } else if (d.event === 'execution_error') {
        reject(new Error(d.exception_message || opts.words?.failed || 'This didn’t work. Try again.'))
      } else if (d.event === 'execution_complete') {
        if (d.stopped === true) reject(new AppRunStopped())
        else if (complete()) resolve(got)
        else reject(new Error(opts.words?.empty ?? 'This finished but made nothing.'))
      }
    },
  }, opts)
}
