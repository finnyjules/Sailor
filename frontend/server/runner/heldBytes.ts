/**
 * Bytes the runner keeps for a node between its send and its result, in a
 * place of its own (Task F11b fix round 1): Blend scene's kept subject needs
 * the exact picture it sent and the Frame's protect_mask after a provider wait
 * of up to 30 minutes, and both live in ComfyUI's temp folder, which ComfyUI
 * empties on every start and exit. They are copied here at plan time, keyed
 * by the sha256 of their bytes, so the composite after the wait (or after a
 * server restart, on resume) uses exactly the bytes that were sent.
 *
 * One folder per node turn (`<runId>/<holder>`), let go when that node
 * finishes; at server start, folders of runs no longer in progress are
 * removed. Locally under .data/runner-held (beside the run store); hosted
 * under SAILOR_DATA_DIR (the volume).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HeldBytes {
  /** Keep these bytes for (run, holder); returns their sha256 (hex). */
  put(runId: string, holder: string, bytes: Uint8Array): Promise<string>
  /** The bytes kept under this sha, or null when they are gone (or no longer match it). */
  get(runId: string, holder: string, sha: string): Promise<Uint8Array | null>
  /** Let go of everything kept for one node turn. */
  drop(runId: string, holder: string): Promise<void>
  /** Let go of everything kept for runs not in this set. */
  keepOnly(runIds: ReadonlySet<string>): Promise<void>
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

const SAFE = /^[A-Za-z0-9_.-]{1,200}$/
const SHA = /^[0-9a-f]{64}$/

function check(...parts: string[]): void {
  for (const p of parts) if (!SAFE.test(p) || p === '.' || p === '..') throw new Error('A held file name is not safe')
}

export function createFileHeldBytes(dir: string): HeldBytes {
  return {
    async put(runId, holder, bytes) {
      check(runId, holder)
      const sha = sha256Hex(bytes)
      const d = join(dir, runId, holder)
      await mkdir(d, { recursive: true })
      const tmp = join(d, `${sha}.${process.pid}.tmp`)
      await writeFile(tmp, bytes)
      await rename(tmp, join(d, sha))
      return sha
    },
    async get(runId, holder, sha) {
      check(runId, holder)
      if (!SHA.test(sha)) return null
      try {
        const b = new Uint8Array(await readFile(join(dir, runId, holder, sha)))
        return sha256Hex(b) === sha ? b : null
      }
      catch { return null }
    },
    async drop(runId, holder) {
      check(runId, holder)
      await rm(join(dir, runId, holder), { recursive: true, force: true })
      // The run's folder goes too once its last holder is gone.
      try {
        if (!(await readdir(join(dir, runId))).length) await rm(join(dir, runId), { recursive: true, force: true })
      }
      catch { /* already gone */ }
    },
    async keepOnly(runIds) {
      let names: string[] = []
      try { names = await readdir(dir) }
      catch { return }
      for (const n of names) {
        if (runIds.has(n) || !SAFE.test(n)) continue
        await rm(join(dir, n), { recursive: true, force: true })
      }
    },
  }
}

/** In memory: for an engine built without a held store (tests). */
export function createMemoryHeldBytes(): HeldBytes {
  const m = new Map<string, Map<string, Uint8Array>>()
  const key = (r: string, h: string) => `${r}/${h}`
  return {
    async put(runId, holder, bytes) {
      const sha = sha256Hex(bytes)
      let b = m.get(key(runId, holder))
      if (!b) m.set(key(runId, holder), b = new Map())
      b.set(sha, bytes.slice())
      return sha
    },
    async get(runId, holder, sha) { return m.get(key(runId, holder))?.get(sha) ?? null },
    async drop(runId, holder) { m.delete(key(runId, holder)) },
    async keepOnly(runIds) {
      for (const k of [...m.keys()]) if (!runIds.has(k.split('/')[0]!)) m.delete(k)
    },
  }
}
