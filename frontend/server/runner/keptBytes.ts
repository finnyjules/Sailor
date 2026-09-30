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
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, rmSync, statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRunId } from './store'
import { sha256Hex } from './handoff'
import type { OutputFile } from './types'

/**
 * R5.2: `mkv` is a frame batch (FFV1, server/media/values.ts keepFrames) and
 * `wav` the runner's exact sound (a float WAV, keepSound). Both are written by
 * the tools into `workDir`, then kept with `putPath`, and read by the tools
 * from `pathOf` / `verifiedPath`: media code never reads them into memory.
 */
export type KeptExt = 'png' | 'glb' | 'json' | 'bin' | 'mkv' | 'wav'

export const KEPT_GONE = 'A result this step needs is gone. Run the workflow again.'
/** A run's kept files would pass MEDIA_CAPS.keptBytesPerRun (R5.2; `withRunCap`). */
export const KEPT_TOO_MUCH = 'This run has made more than the server can keep for it'

const KEPT_NAME_RE = /^([0-9a-f]{64})\.(png|glb|json|bin|mkv|wav)$/
/** A `workDir` folder's name prefix: never a kept name, so the sweep of a run's files and `runBytes` skip it. */
const WORK_PREFIX = '.work-'

export interface KeptBytes {
  /** Keeps `bytes` for the run; the same bytes give the same file. */
  put(runId: string, bytes: Uint8Array, ext: KeptExt): Promise<OutputFile>
  /** The kept bytes, checked against their name; KEPT_GONE when missing or changed. */
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
  /** Lets go of every run not in this set. */
  keepOnly(runIds: ReadonlySet<string>): Promise<void>
  /**
   * Keeps the file at `tmpPath` (written by a tool into `workDir(runId)`) for
   * the run: its sha256 is read as it streams, then it is renamed into place
   * (removed when the same bytes are already kept). Never read whole.
   */
  putPath(runId: string, tmpPath: string, ext: KeptExt): Promise<OutputFile>
  /** The kept file's path, for a tool to read; KEPT_GONE when missing (its bytes are not checked: `verifiedPath`). */
  pathOf(file: OutputFile): string
  /** `pathOf`, once the file's bytes are checked against its name as they stream; KEPT_GONE when changed. */
  verifiedPath(file: OutputFile): Promise<string>
  /** The folder a run's kept files are in (a tool's `roots`). */
  rootOf(runId: string): string
  /** A fresh temporary folder inside the run's kept folder, for a tool's outputs; swept with the run. */
  workDir(runId: string): Promise<string>
  /** The bytes a run keeps now (its kept files, not its work folders). */
  runBytes(runId: string): Promise<number>
  /** The bytes in the run's work folders now (a tool's outputs before they are kept). */
  workBytes(runId: string): Promise<number>
  /**
   * Throws KEPT_TOO_MUCH when the run already keeps its cap or more (kept
   * files and work folders together): called before media work starts
   * (`withRunCap`; a store without a cap never refuses).
   */
  checkRoom(runId: string): Promise<void>
}

/** The sha256 of a file, read as it streams. */
export async function sha256OfPath(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
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
  const runDir = (runId: string) => {
    if (!isRunId(runId)) throw new Error('Kept bytes need a run id')
    return join(dir, runId)
  }
  const existingPath = (f: OutputFile): string => {
    if (!shaOf(f)) throw new Error(KEPT_GONE)
    const p = pathOf(f)
    try { if (statSync(p).isFile()) return p }
    catch {}
    throw new Error(KEPT_GONE)
  }
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
    async putPath(runId, tmpPath, ext) {
      const d = runDir(runId)
      const sha = await sha256OfPath(tmpPath)
      const file: OutputFile = { filename: `${sha}.${ext}`, subfolder: runId, type: 'kept' }
      const dest = pathOf(file)
      await mkdir(d, { recursive: true })
      // The same bytes are kept once: the copy just made is let go.
      if (await stat(dest).then(st => st.isFile(), () => false)) {
        await rm(tmpPath, { force: true })
        return file
      }
      try { await rename(tmpPath, dest) }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
        // Another disk: copied beside it first, so a reader never sees half a file.
        const tmp = join(d, `${file.filename}.${process.pid}.tmp`)
        await copyFile(tmpPath, tmp, fsConstants.COPYFILE_EXCL)
        await rename(tmp, dest)
        await rm(tmpPath, { force: true })
      }
      return file
    },
    pathOf: existingPath,
    async verifiedPath(file) {
      const p = existingPath(file)
      let sha: string
      try { sha = await sha256OfPath(p) }
      catch { throw new Error(KEPT_GONE) }
      if (sha !== shaOf(file)) throw new Error(KEPT_GONE)
      return p
    },
    rootOf: runDir,
    async workDir(runId) {
      const d = runDir(runId)
      await mkdir(d, { recursive: true })
      return mkdtemp(join(d, WORK_PREFIX))
    },
    async runBytes(runId) {
      const d = runDir(runId)
      let names: string[] = []
      try { names = await readdir(d) }
      catch { return 0 }
      let total = 0
      for (const n of names) {
        if (!KEPT_NAME_RE.test(n)) continue
        try {
          const st = await stat(join(d, n))
          if (st.isFile()) total += st.size
        }
        catch {}
      }
      return total
    },
    async workBytes(runId) {
      const d = runDir(runId)
      let names: string[] = []
      try { names = await readdir(d) }
      catch { return 0 }
      let total = 0
      for (const n of names) {
        if (!n.startsWith(WORK_PREFIX)) continue
        let inner: string[] = []
        try { inner = await readdir(join(d, n)) }
        catch { continue }
        for (const f of inner) {
          try {
            const st = await stat(join(d, n, f))
            if (st.isFile()) total += st.size
          }
          catch {}
        }
      }
      return total
    },
    async checkRoom() {},
  }
}

/** The memory stores' temporary folders, removed when the process exits (R5.2 fix round 1). */
const memoryDiskDirs = new Set<string>()
let memoryExitHook = false
function removeMemoryDirsAtExit(dir: string): void {
  memoryDiskDirs.add(dir)
  if (memoryExitHook) return
  memoryExitHook = true
  process.once('exit', () => {
    for (const d of memoryDiskDirs) {
      try { rmSync(d, { recursive: true, force: true }) }
      catch {}
    }
  })
}

/**
 * In memory: for an engine built without a kept store (tests). Files a tool
 * wrote (`putPath`: frame batches, sounds) stay on disk, in a temporary folder
 * of this store's own, since the tools read them by path.
 */
export function createMemoryKeptBytes(): KeptBytes {
  const m = new Map<string, Uint8Array>()
  const key = (f: OutputFile) => `${f.subfolder}/${f.filename}`
  let disk: KeptBytes | null = null
  let diskDir: string | null = null
  const onDisk = async (): Promise<KeptBytes> => {
    if (!diskDir) {
      diskDir = await mkdtemp(join(tmpdir(), 'runner-kept-'))
      removeMemoryDirsAtExit(diskDir)
    }
    disk ??= createFileKeptBytes(diskDir)
    return disk
  }
  const pathsOnly = (): KeptBytes => {
    if (!disk) throw new Error(KEPT_GONE)
    return disk
  }
  return {
    async put(runId, bytes, ext) {
      const file = keptFile(runId, bytes, ext)
      m.set(key(file), bytes.slice())
      return file
    },
    async read(file) {
      const b = shaOf(file) ? m.get(key(file)) : undefined
      if (b) return b
      if (disk && await disk.exists(file)) return disk.read(file)
      throw new Error(KEPT_GONE)
    },
    async exists(file) { return (!!shaOf(file) && m.has(key(file))) || (!!disk && await disk.exists(file)) },
    async size(file) { return (shaOf(file) ? m.get(key(file))?.length : null) ?? (disk ? await disk.size(file) : null) },
    async keepOnly(runIds) {
      for (const k of [...m.keys()]) if (!runIds.has(k.split('/')[0]!)) m.delete(k)
      await disk?.keepOnly(runIds)
    },
    async putPath(runId, tmpPath, ext) { return (await onDisk()).putPath(runId, tmpPath, ext) },
    pathOf: file => pathsOnly().pathOf(file),
    verifiedPath: async file => pathsOnly().verifiedPath(file),
    rootOf: (runId) => {
      if (!diskDir) throw new Error(KEPT_GONE)
      return pathsOnly().rootOf(runId)
    },
    async workDir(runId) { return (await onDisk()).workDir(runId) },
    async runBytes(runId) {
      let total = disk ? await disk.runBytes(runId) : 0
      for (const [k, b] of m) if (k.split('/')[0] === runId) total += b.length
      return total
    },
    async workBytes(runId) { return disk ? disk.workBytes(runId) : 0 },
    async checkRoom() {},
  }
}

/**
 * The store with each run's kept total capped at `capOf()` bytes (R5.2:
 * MEDIA_CAPS.keptBytesPerRun, read at each put). Each run's total is kept in
 * memory, seeded once by one scan of its folder, and moved on at each put
 * under a per-run lock, so racing puts can't both pass (fix round 1). The
 * run's work folders (tool outputs not yet kept) count toward the cap while
 * they exist. A put that would pass the cap fails with KEPT_TOO_MUCH (and a
 * `putPath` lets its file go); `checkRoom` refuses before the work when the
 * run is already at or over it. The same bytes `put` again cost nothing; a
 * `putPath` is counted by its size (a repeat of bytes already kept is counted
 * again, which only makes the cap stricter: hashing a large file twice to
 * spot one isn't worth it).
 */
export function withRunCap(kept: KeptBytes, capOf: () => number): KeptBytes {
  const totals = new Map<string, number>()
  const locks = new Map<string, Promise<unknown>>()
  /** `fn` run alone for this run: after every earlier put of it. */
  const locked = <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(runId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    locks.set(runId, tail)
    void tail.then(() => { if (locks.get(runId) === tail) locks.delete(runId) })
    return next
  }
  const totalOf = async (runId: string): Promise<number> => {
    let t = totals.get(runId)
    if (t === undefined) {
      t = await kept.runBytes(runId)
      totals.set(runId, t)
    }
    return t
  }
  const add = (runId: string, n: number) => totals.set(runId, (totals.get(runId) ?? 0) + n)
  return {
    ...kept,
    async put(runId, bytes, ext) {
      if (!Number.isFinite(capOf())) return kept.put(runId, bytes, ext)
      const file = keptFile(runId, bytes, ext)
      return locked(runId, async () => {
        if (await kept.exists(file)) return kept.put(runId, bytes, ext)
        const used = (await totalOf(runId)) + await kept.workBytes(runId)
        if (used + bytes.length > capOf()) throw new Error(KEPT_TOO_MUCH)
        const f = await kept.put(runId, bytes, ext)
        add(runId, bytes.length)
        return f
      })
    },
    async putPath(runId, tmpPath, ext) {
      if (!Number.isFinite(capOf())) return kept.putPath(runId, tmpPath, ext)
      return locked(runId, async () => {
        let size: number
        try {
          size = (await stat(tmpPath)).size
          // The file itself is in a work folder: counted once, as the kept file it becomes.
          const work = Math.max(0, (await kept.workBytes(runId)) - size)
          if ((await totalOf(runId)) + work + size > capOf()) throw new Error(KEPT_TOO_MUCH)
        }
        catch (e) {
          await rm(tmpPath, { force: true })
          throw e
        }
        const f = await kept.putPath(runId, tmpPath, ext)
        add(runId, size)
        return f
      })
    },
    async checkRoom(runId) {
      const cap = capOf()
      if (!Number.isFinite(cap)) return
      if ((await totalOf(runId)) + await kept.workBytes(runId) >= cap) throw new Error(KEPT_TOO_MUCH)
    },
    async keepOnly(runIds) {
      for (const id of [...totals.keys()]) if (!runIds.has(id)) totals.delete(id)
      await kept.keepOnly(runIds)
    },
  }
}
