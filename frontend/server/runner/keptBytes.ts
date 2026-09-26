// frontend/server/runner/keptBytes.ts
/**
 * Bytes the runner makes itself and hands between nodes (R0, step 3 spec):
 * a mask, a picture converted the way a Python loader sees it. Kept per run,
 * named by the sha256 of the bytes, so the same bytes are kept once and a
 * restarted server reads exactly what was made. They live beside the run
 * store (never ComfyUI's temp folder, which ComfyUI empties at every start
 * and exit), are not assets, and are never served by /view.
 *
 * Let go at server start for runs no longer in progress (as ./heldBytes.ts).
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRunId } from './store'
import { sha256Hex } from './handoff'
import type { OutputFile } from './types'

export type KeptExt = 'png' | 'glb' | 'json' | 'bin'

export const KEPT_GONE = 'A result this step needs is gone. Run the workflow again.'

const KEPT_NAME_RE = /^([0-9a-f]{64})\.(png|glb|json|bin)$/

export interface KeptBytes {
  /** Keeps `bytes` for the run; the same bytes give the same file. */
  put(runId: string, bytes: Uint8Array, ext: KeptExt): Promise<OutputFile>
  /** The kept bytes, checked against their name; KEPT_GONE when missing or changed. */
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
  /** Lets go of every run not in this set. */
  keepOnly(runIds: ReadonlySet<string>): Promise<void>
}

/** The kept file's sha, or null when the file isn't a well-formed kept name. */
function shaOf(file: OutputFile): string | null {
  if (file.type !== 'kept' || !isRunId(file.subfolder)) return null
  const m = KEPT_NAME_RE.exec(file.filename)
  return m ? m[1]! : null
}

function keptFile(runId: string, bytes: Uint8Array, ext: KeptExt): OutputFile {
  if (!isRunId(runId)) throw new Error('Kept bytes need a run id')
  return { filename: `${sha256Hex(bytes)}.${ext}`, subfolder: runId, type: 'kept' }
}

export function createFileKeptBytes(dir: string): KeptBytes {
  const pathOf = (f: OutputFile) => join(dir, f.subfolder, f.filename)
  return {
    async put(runId, bytes, ext) {
      const file = keptFile(runId, bytes, ext)
      const d = join(dir, runId)
      await mkdir(d, { recursive: true })
      const tmp = join(d, `${file.filename}.${process.pid}.tmp`)
      await writeFile(tmp, bytes)
      await rename(tmp, pathOf(file))
      return file
    },
    async read(file) {
      const sha = shaOf(file)
      if (!sha) throw new Error(KEPT_GONE)
      let b: Uint8Array
      try { b = new Uint8Array(await readFile(pathOf(file))) }
      catch { throw new Error(KEPT_GONE) }
      if (sha256Hex(b) !== sha) throw new Error(KEPT_GONE)
      return b
    },
    async exists(file) {
      if (!shaOf(file)) return false
      try { return (await stat(pathOf(file))).isFile() }
      catch { return false }
    },
    async size(file) {
      if (!shaOf(file)) return null
      try {
        const st = await stat(pathOf(file))
        return st.isFile() ? st.size : null
      }
      catch { return null }
    },
    async keepOnly(runIds) {
      let names: string[] = []
      try { names = await readdir(dir) }
      catch { return }
      for (const n of names) if (!runIds.has(n) && isRunId(n)) await rm(join(dir, n), { recursive: true, force: true })
    },
  }
}

/** In memory: for an engine built without a kept store (tests). */
export function createMemoryKeptBytes(): KeptBytes {
  const m = new Map<string, Uint8Array>()
  const key = (f: OutputFile) => `${f.subfolder}/${f.filename}`
  return {
    async put(runId, bytes, ext) {
      const file = keptFile(runId, bytes, ext)
      m.set(key(file), bytes.slice())
      return file
    },
    async read(file) {
      const b = shaOf(file) ? m.get(key(file)) : undefined
      if (!b) throw new Error(KEPT_GONE)
      return b
    },
    async exists(file) { return !!shaOf(file) && m.has(key(file)) },
    async size(file) { return (shaOf(file) ? m.get(key(file))?.length : null) ?? null },
    async keepOnly(runIds) {
      for (const k of [...m.keys()]) if (!runIds.has(k.split('/')[0]!)) m.delete(k)
    },
  }
}
