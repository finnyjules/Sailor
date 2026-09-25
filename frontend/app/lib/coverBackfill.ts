/**
 * coverBackfill — pure logic for the lazy cover backfill (read-side companion
 * to stampProjectCover in default.vue). Projects saved before cover stamping
 * shipped show "No preview" until re-opened; the grid closes that gap by
 * fetching the saved doc for blank cards as they scroll into view. This
 * module holds the testable parts: which cards qualify, and a small
 * concurrency gate so scrolling a 200-card grid can't burst version fetches.
 */
import type { GenOutput } from '~/lib/generations'

/** A card qualifies when it has no images and its id is a real server uuid —
 *  history-fingerprint cards (comma-joined class types, pre-uuid runs) have
 *  no durable doc to fetch. */
export function isBackfillCandidate(p: { workflowId?: string | null; images?: unknown[] | null }): boolean {
  if (!p.workflowId || p.workflowId.includes(',')) return false
  return !p.images || p.images.length === 0
}

/** Minimal FIFO task queue: at most `maxConcurrent` tasks in flight; a task
 *  settling (resolve, reject, or synchronous throw) frees its slot. */
export function createTaskQueue(maxConcurrent: number) {
  const pending: (() => Promise<void>)[] = []
  let active = 0
  function pump() {
    while (active < maxConcurrent && pending.length) {
      const task = pending.shift()!
      active++
      Promise.resolve().then(task).catch(() => {}).finally(() => {
        active--
        pump()
      })
    }
  }
  return {
    push(task: () => Promise<void>) {
      pending.push(task)
      pump()
    },
    get activeCount() { return active },
    get pendingCount() { return pending.length },
  }
}

/** Old docs can reference input files that were since pruned (live_preview_*
 *  temp uploads especially). Never paint or stamp a dead reference — a broken
 *  tile is worse than "No preview". Survivors carry the file's etag as `v`.
 *  fetchFn is injectable for tests. */
export async function filterToExistingImages(
  images: GenOutput[],
  fetchFn: typeof fetch = fetch,
): Promise<GenOutput[]> {
  const checks = await Promise.all(images.map(async (img) => {
    try {
      const params = new URLSearchParams({ filename: img.filename, type: img.type })
      if (img.subfolder) params.set('subfolder', img.subfolder)
      const res = await fetchFn(`/view?${params}`, { method: 'HEAD' })
      if (!res.ok) return null
      // Tag with the file's version so an overwritten file gets a new URL.
      const etag = res.headers?.get?.('etag')?.replace(/[^\w-]+/g, '')
      return etag ? { ...img, v: etag } : img
    } catch {
      return null
    }
  }))
  return checks.filter((i): i is GenOutput => i !== null)
}
