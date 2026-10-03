/**
 * Stage 6 Task 3: training-queue ownership. Today GET /api/training-queue
 * returns EVERY user's jobs unfiltered, and the per-job cancel/delete routes
 * take no ownership check — any signed-in hosted user could see, cancel, or
 * delete another user's training job. Jobs already persist `userId` (Stage 4
 * metering; trainingQueue.ts:52), so this is filtering + guarding at the
 * route layer, not a new store.
 *
 * Drives the REAL route handlers (server/api/training-queue/*) against a
 * REAL file-backed job store rooted in a temp dir (the training-meter.unit.
 * spec.ts / loras-local-handlers.unit.spec.ts pattern) — chdir so
 * trainingQueue.ts's defaultJobsPath() resolves into the temp tree, and
 * vi.resetModules() before each import so the process-wide jobStore()
 * singleton is rebuilt against the new cwd instead of reusing a stale one
 * from a previous test.
 *
 * The handlers rely on Nitro auto-imports (defineEventHandler/getRouterParam/
 * createError), stubbed as globals before the modules are imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.getRouterParam = (event: any, name: string) => event.params?.[name]
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? 'error') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerkKey = process.env[CLERK_KEY]
function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

let tmp: string
let cwd: string

type Handlers = {
  listHandler: (event: any) => Promise<any>
  cancelHandler: (event: any) => Promise<any>
  deleteHandler: (event: any) => Promise<any>
  jobStore: () => any
}

/** Fresh module graph (fresh jobStore() singleton) rooted at the current cwd. */
async function loadHandlers(): Promise<Handlers> {
  vi.resetModules()
  const trainingQueue = await import('../../server/utils/trainingQueue')
  const listHandler = (await import('../../server/api/training-queue/index.get')).default as any
  const cancelHandler = (await import('../../server/api/training-queue/[id]/cancel.post')).default as any
  const deleteHandler = (await import('../../server/api/training-queue/[id]/index.delete')).default as any
  return { listHandler, cancelHandler, deleteHandler, jobStore: trainingQueue.jobStore }
}

function ev(id: string | null, userId: string | null): any {
  return { context: { userId }, params: id ? { id } : {} }
}

beforeEach(async () => {
  cwd = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'training-queue-owner-'))
  // trainingQueue.ts's defaultJobsPath() resolves ../library/.training-jobs.json
  // from cwd, so mirror that shape (loras-local-handlers.unit.spec.ts pattern).
  await fs.mkdir(path.join(tmp, 'library'), { recursive: true })
  await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
  process.chdir(path.join(tmp, 'frontend'))
})

afterEach(async () => {
  process.chdir(cwd)
  await fs.rm(tmp, { recursive: true, force: true })
  if (savedClerkKey === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerkKey
  vi.resetModules()
})

// --------------------------------------------------------------- GET (list)

describe('GET /api/training-queue — hosted ownership filter', () => {
  it('returns ONLY the caller\'s own jobs', async () => {
    setHosted()
    const { listHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    await store.add({ kind: 'lora', outputName: 'mine', displayName: 'Mine', datasetUrl: 'u', params: {}, userId: 'u1' })
    await store.add({ kind: 'lora', outputName: 'theirs', displayName: 'Theirs', datasetUrl: 'u', params: {}, userId: 'u2' })

    const { jobs } = await listHandler(ev(null, 'u1'))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].outputName).toBe('mine')
  })

  it('a job with NO userId (pre-Stage-4 legacy) is invisible to EVERYONE in hosted mode', async () => {
    setHosted()
    const { listHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    // add() defaults userId to null when the field is absent — the legacy shape.
    await store.add({ kind: 'lora', outputName: 'legacy', displayName: 'Legacy', datasetUrl: 'u', params: {} })
    await store.add({ kind: 'lora', outputName: 'mine', displayName: 'Mine', datasetUrl: 'u', params: {}, userId: 'u1' })

    const { jobs: forU1 } = await listHandler(ev(null, 'u1'))
    expect(forU1.map((j: any) => j.outputName)).toEqual(['mine'])

    const { jobs: forU2 } = await listHandler(ev(null, 'u2'))
    expect(forU2).toHaveLength(0) // legacy job visible to NOBODY, not even close matches
  })

  it('LOCAL mode: unfiltered, byte-identical to today', async () => {
    setLocal()
    const { listHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    await store.add({ kind: 'lora', outputName: 'a', displayName: 'A', datasetUrl: 'u', params: {}, userId: 'u1' })
    await store.add({ kind: 'lora', outputName: 'b', displayName: 'B', datasetUrl: 'u', params: {}, userId: 'u2' })
    await store.add({ kind: 'lora', outputName: 'c', displayName: 'C', datasetUrl: 'u', params: {} }) // legacy/local

    const { jobs } = await listHandler(ev(null, null))
    expect(jobs).toHaveLength(3)
  })
})

// --------------------------------------------------------- POST /:id/cancel

describe('POST /api/training-queue/:id/cancel — hosted ownership guard', () => {
  it('another user\'s job: 404, and the mutation function is NEVER called', async () => {
    setHosted()
    const { cancelHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'theirs', displayName: 'Theirs', datasetUrl: 'u', params: {}, userId: 'u2', status: 'queued' })
    const updateSpy = vi.spyOn(store, 'update')

    await expect(cancelHandler(ev(job.id, 'u1'))).rejects.toMatchObject({ statusCode: 404 })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('an unowned (legacy, no userId) job: 404 too — invisible, not just unmutatable', async () => {
    setHosted()
    const { cancelHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'legacy', displayName: 'Legacy', datasetUrl: 'u', params: {}, status: 'queued' })
    const updateSpy = vi.spyOn(store, 'update')

    await expect(cancelHandler(ev(job.id, 'u1'))).rejects.toMatchObject({ statusCode: 404 })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('own job: proceeds exactly as today (marked canceled)', async () => {
    setHosted()
    const { cancelHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'mine', displayName: 'Mine', datasetUrl: 'u', params: {}, userId: 'u1', status: 'queued' })

    const { job: updated } = await cancelHandler(ev(job.id, 'u1'))
    expect(updated.status).toBe('canceled')
  })

  it('a nonexistent id: 404 (existing behavior, unchanged)', async () => {
    setHosted()
    const { cancelHandler } = await loadHandlers()
    await expect(cancelHandler(ev('ghost-id', 'u1'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('LOCAL mode: ungated — cancels ANY job regardless of userId, byte-identical to today', async () => {
    setLocal()
    const { cancelHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'theirs', displayName: 'Theirs', datasetUrl: 'u', params: {}, userId: 'u2', status: 'queued' })

    const { job: updated } = await cancelHandler(ev(job.id, null))
    expect(updated.status).toBe('canceled')
  })
})

// --------------------------------------------------------- DELETE /:id

describe('DELETE /api/training-queue/:id — hosted ownership guard', () => {
  it('another user\'s job: 404, and the mutation function is NEVER called', async () => {
    setHosted()
    const { deleteHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'theirs', displayName: 'Theirs', datasetUrl: 'u', params: {}, userId: 'u2' })
    const removeSpy = vi.spyOn(store, 'remove')

    await expect(deleteHandler(ev(job.id, 'u1'))).rejects.toMatchObject({ statusCode: 404 })
    expect(removeSpy).not.toHaveBeenCalled()
    expect(await store.get(job.id)).not.toBeNull() // untouched
  })

  it('an unowned (legacy, no userId) job: 404 too', async () => {
    setHosted()
    const { deleteHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'legacy', displayName: 'Legacy', datasetUrl: 'u', params: {} })
    const removeSpy = vi.spyOn(store, 'remove')

    await expect(deleteHandler(ev(job.id, 'u1'))).rejects.toMatchObject({ statusCode: 404 })
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('own job: proceeds exactly as today (removed)', async () => {
    setHosted()
    const { deleteHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'mine', displayName: 'Mine', datasetUrl: 'u', params: {}, userId: 'u1' })

    const { removed } = await deleteHandler(ev(job.id, 'u1'))
    expect(removed).toBe(true)
    expect(await store.get(job.id)).toBeNull()
  })

  it('LOCAL mode: ungated — deletes ANY job regardless of userId, byte-identical to today', async () => {
    setLocal()
    const { deleteHandler, jobStore } = await loadHandlers()
    const store = jobStore()
    const job = await store.add({ kind: 'lora', outputName: 'theirs', displayName: 'Theirs', datasetUrl: 'u', params: {}, userId: 'u2' })

    const { removed } = await deleteHandler(ev(job.id, null))
    expect(removed).toBe(true)
  })
})
