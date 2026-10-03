/**
 * Durable job registry for cloud training (style/character LoRA + voice).
 *
 * The browser no longer holds training jobs in memory and polls them — that's
 * what made closing the window abort a training. Instead every job is persisted
 * here as a small JSON file under the models dir, and a server-side runner
 * (server/plugins/trainingQueueRunner.ts) starts/polls/finalizes them. The
 * browser becomes a pure viewer via /api/training-queue.
 *
 * Pure Node (fs/path/crypto only) so it unit-tests without the Nitro runtime.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from './dataRoot'
import { randomUUID } from 'node:crypto'

export type TrainingKind = 'lora' | 'voice'

export type TrainingStatus =
  | 'queued' // accepted, not yet started on Replicate
  | 'starting' // start request sent / Replicate provisioning
  | 'processing' // training on Replicate
  | 'succeeded' // finalized: weights/voice downloaded + sidecar written
  | 'failed'
  | 'canceled'

export interface TrainingJob {
  id: string
  kind: TrainingKind
  status: TrainingStatus
  /** Sanitized stem used for the output filename. */
  outputName: string
  /** What the user typed, shown in the queue panel. */
  displayName: string
  /** Replicate Files URL (LoRA dataset zip, or voice audio file). */
  datasetUrl: string
  /** Provider-specific hyperparameters (family/steps/… for LoRA; accuracy/… for voice). */
  params: Record<string, unknown>
  trigger?: string | null
  /** Generated client-side at enqueue (LoRA) so finalize is headless. */
  aesthetic?: string | null
  /** 'character' tags the LoRA as an identity; otherwise a style. */
  loraKind?: 'style' | 'character'
  /**
   * Hosted-mode user id that queued this job, captured at enqueue time from
   * event.context.userId (see server/api/training-queue/index.post.ts).
   * The queue runner (server/plugins/trainingQueueRunner.ts) starts jobs on
   * a timer with no request/ALS context, so it can't resolve "who's paying"
   * any other way — this is threaded to preflightMeterFor explicitly (see
   * trainingProviders.ts). Local mode never sets it; absent/null means
   * "don't meter this job", not "meter it for nobody".
   */
  userId?: string | null
  /** Replicate training/prediction id once started. */
  replicateId?: string | null
  /** owner/model destination (LoRA only). */
  destination?: string | null
  progressPct: number
  logsTail?: string | null
  error?: string | null
  /** Final on-disk filename once finalized. */
  localFilename?: string | null
  createdAt: string
  updatedAt: string
}

/** Fields a caller supplies when enqueuing. The store fills in the rest. */
export type NewTrainingJob =
  Pick<TrainingJob, 'kind' | 'outputName' | 'displayName' | 'datasetUrl' | 'params'>
  & Partial<Pick<TrainingJob, 'trigger' | 'aesthetic' | 'loraKind' | 'id' | 'status' | 'userId'>>

export interface JobStore {
  list(): Promise<TrainingJob[]>
  get(id: string): Promise<TrainingJob | null>
  add(input: NewTrainingJob): Promise<TrainingJob>
  /**
   * Patch a job. If `guard` is supplied, it's evaluated against the *current*
   * persisted job inside the serialized critical section; if it returns false
   * the write is skipped and the unchanged job returned (compare-and-set). Used
   * to stop a stale poll result from clobbering a job that went terminal (e.g.
   * canceled) between the runner reading the list and applying the patch.
   */
  update(id: string, patch: Partial<TrainingJob>, guard?: (cur: TrainingJob) => boolean): Promise<TrainingJob | null>
  remove(id: string): Promise<boolean>
}

/** Default registry path: alongside the model outputs (../models from the Nuxt cwd). */
export function defaultJobsPath(): string {
  return dataPath('models', '.training-jobs.json')
}

/**
 * Create a job store backed by a single JSON file. Writes are serialized through
 * an in-module promise chain so concurrent add/update calls can't interleave a
 * read-modify-write and clobber each other (single Node process).
 */
export function createJobStore(filePath: string): JobStore {
  let chain: Promise<unknown> = Promise.resolve()

  const tmpPath = `${filePath}.tmp`
  const bakPath = `${filePath}.bak`

  async function parseFile(p: string): Promise<TrainingJob[] | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8'))
      return Array.isArray(parsed) ? parsed as TrainingJob[] : null
    } catch {
      return null
    }
  }

  async function readAll(): Promise<TrainingJob[]> {
    // Prefer the main file; if it's missing or torn (crash mid-write, disk
    // corruption), fall back to the last-good backup so the durable queue
    // survives instead of silently resetting to empty.
    return (await parseFile(filePath)) ?? (await parseFile(bakPath)) ?? []
  }

  async function writeAll(jobs: TrainingJob[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Snapshot the current good state as the backup before overwriting.
    await fs.copyFile(filePath, bakPath).catch(() => {})
    // Write to a temp file then atomically rename, so a crash never leaves a
    // torn main file (rename is atomic on POSIX).
    await fs.writeFile(tmpPath, JSON.stringify(jobs, null, 2))
    await fs.rename(tmpPath, filePath)
  }

  // Run `fn` after the previous mutation settles, regardless of its outcome.
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.then(() => {}, () => {})
    return next as Promise<T>
  }

  return {
    list: () => readAll(),
    async get(id) {
      const jobs = await readAll()
      return jobs.find(j => j.id === id) ?? null
    },
    add(input) {
      return serialize(async () => {
        const jobs = await readAll()
        const now = new Date().toISOString()
        const job: TrainingJob = {
          id: input.id ?? randomUUID(),
          kind: input.kind,
          status: input.status ?? 'queued',
          outputName: input.outputName,
          displayName: input.displayName,
          datasetUrl: input.datasetUrl,
          params: input.params ?? {},
          trigger: input.trigger ?? null,
          aesthetic: input.aesthetic ?? null,
          loraKind: input.loraKind,
          userId: input.userId ?? null,
          replicateId: null,
          destination: null,
          progressPct: 0,
          logsTail: null,
          error: null,
          localFilename: null,
          createdAt: now,
          updatedAt: now,
        }
        jobs.push(job)
        await writeAll(jobs)
        return job
      })
    },
    update(id, patch, guard) {
      return serialize(async () => {
        const jobs = await readAll()
        const idx = jobs.findIndex(j => j.id === id)
        if (idx === -1) return null
        if (guard && !guard(jobs[idx])) return jobs[idx] // compare-and-set: skip
        const merged: TrainingJob = {
          ...jobs[idx],
          ...patch,
          id: jobs[idx].id, // never let a patch change identity/timestamps
          createdAt: jobs[idx].createdAt,
          updatedAt: new Date().toISOString(),
        }
        jobs[idx] = merged
        await writeAll(jobs)
        return merged
      })
    },
    remove(id) {
      return serialize(async () => {
        const jobs = await readAll()
        const next = jobs.filter(j => j.id !== id)
        if (next.length === jobs.length) return false
        await writeAll(next)
        return true
      })
    },
  }
}

/** Process-wide singleton store at the default path. */
let singleton: JobStore | null = null
export function jobStore(): JobStore {
  if (!singleton) singleton = createJobStore(defaultJobsPath())
  return singleton
}

/** Statuses that count against the concurrency cap / "active" badge. */
export function isActive(job: TrainingJob): boolean {
  return job.status === 'queued' || job.status === 'starting' || job.status === 'processing'
}
