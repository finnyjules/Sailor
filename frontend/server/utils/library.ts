/**
 * Sailor's library: the user's own LoRAs, characters and voices, at
 * `<data root>/library/{loras,characters,voices}` (step 4, C6b). Every server
 * path into them resolves through this module; the training queue's job file
 * lives beside them (`library/.training-jobs.json`).
 *
 * They used to live in ComfyUI's model folder, `<data root>/models/<kind>`.
 * On first use of a kind, when `library/<kind>` doesn't exist and
 * `models/<kind>` does, the old folder is MOVED with one rename — the same
 * disk, so a 19 GB LoRA folder moves instantly and nothing is copied. The
 * check runs on every call (two stats), so it is idempotent and needs no
 * memo; a concurrent first request (another process) that loses the race
 * gets ENOENT (the source is gone) or ENOTEMPTY (the target is there), and
 * both are fine — the next line reads what is there.
 *
 * When both folders exist (the move was refused — a different disk — or
 * something made the new folder first), both are read, the library first, and
 * that is logged once. Writes of new files always go to the library.
 *
 * This is the only module that names `models/` (guarded by
 * library-no-models-readers.unit.spec.ts). Hosted: the same paths under the
 * data root, which is the volume.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataPath } from './dataRoot'

export type LibraryKind = 'loras' | 'characters' | 'voices'
export const LIBRARY_KINDS: readonly LibraryKind[] = ['loras', 'characters', 'voices']

/** The library folder under the data root. */
export const LIBRARY_FOLDER = 'library'
/** ComfyUI's old model folder — read only by the move below and the fallback read. */
const LEGACY_FOLDER = 'models'
/** The training queue's job file (and its `.bak`), moved the same way. */
const JOBS_FILE = '.training-jobs.json'

/** The data root, or the old fallback (the folder above the server's cwd) — `dataPath()`'s answer. */
function baseOf(root?: string | null): string {
  return root ?? dataPath()
}

function present(p: string): boolean {
  try { fs.lstatSync(p); return true }
  catch { return false }
}

const logged = new Set<string>()
function logOnce(key: string, msg: string, warn = false): void {
  if (logged.has(key)) return
  logged.add(key)
  if (warn) console.warn(msg)
  else console.info(msg)
}

/**
 * Whether the one-time move may run at `base`. Always, except under the test
 * runner, where it runs only inside the OS temp folder: a test that forgets to
 * point the data root at a scratch folder must never move the real library.
 */
export function libraryMoveAllowed(base: string): boolean {
  if (!process.env.VITEST) return true
  const tmp = [os.tmpdir()]
  try { tmp.push(fs.realpathSync(os.tmpdir())) }
  catch { /* keep the plain name */ }
  return tmp.some(t => base === t || base.startsWith(t + path.sep))
}

/** Codes that mean "someone else moved it first / made the target": fine, read what is there. */
const RACE_CODES = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR'])

/** Move `models/<name>` (a folder) to `library/<name>` once: rename only, never copy. */
function moveFolder(base: string, name: string): void {
  const target = path.join(base, LIBRARY_FOLDER, name)
  const legacy = path.join(base, LEGACY_FOLDER, name)
  if (present(target) || !present(legacy) || !libraryMoveAllowed(base)) return
  try {
    fs.mkdirSync(path.join(base, LIBRARY_FOLDER), { recursive: true })
    fs.renameSync(legacy, target)
    console.info(`[library] moved ${legacy} to ${target}`)
  }
  catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? ''
    if (!RACE_CODES.has(code)) {
      // EXDEV (another disk), EACCES, …: never copied; the old folder stays a fallback read.
      logOnce(`move:${legacy}`, `[library] could not move ${legacy} to ${target} (${code || String(e)}); reading it where it is`, true)
    }
  }
}

/**
 * Move a file the same way, without ever replacing one at the target:
 * link (fails if the target exists) then unlink the old name. A rename could
 * silently overwrite a file another process wrote in between.
 */
function moveFile(base: string, name: string): void {
  const target = path.join(base, LIBRARY_FOLDER, name)
  const legacy = path.join(base, LEGACY_FOLDER, name)
  if (present(target) || !present(legacy) || !libraryMoveAllowed(base)) return
  try {
    fs.mkdirSync(path.join(base, LIBRARY_FOLDER), { recursive: true })
    fs.linkSync(legacy, target)
    fs.unlinkSync(legacy)
    console.info(`[library] moved ${legacy} to ${target}`)
  }
  catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? ''
    if (!RACE_CODES.has(code)) {
      logOnce(`move:${legacy}`, `[library] could not move ${legacy} to ${target} (${code || String(e)})`, true)
    }
  }
}

/**
 * `<data root>/library/<kind>` — where this kind is written. Moves the old
 * `models/<kind>` here first when only the old one exists. Not created.
 */
export function libraryDir(kind: LibraryKind, root?: string | null): string {
  const base = baseOf(root)
  moveFolder(base, kind)
  return path.join(base, LIBRARY_FOLDER, kind)
}

/**
 * Every folder this kind is read from, in order: the library, then the old
 * `models/<kind>` only while it still exists beside it (logged once).
 */
export function libraryDirs(kind: LibraryKind, root?: string | null): string[] {
  const base = baseOf(root)
  const dir = libraryDir(kind, base)
  const legacy = path.join(base, LEGACY_FOLDER, kind)
  if (!present(legacy)) return [dir]
  logOnce(`both:${legacy}`, `[library] both ${dir} and ${legacy} exist; reading both, ${dir} first`)
  return [dir, legacy]
}

/** The first folder holding `name` (a bare file name), as a full path, or null. */
export async function findInLibrary(kind: LibraryKind, name: string, root?: string | null): Promise<string | null> {
  for (const dir of libraryDirs(kind, root)) {
    const p = path.join(dir, name)
    try { await fs.promises.access(p); return p }
    catch { /* not in this folder */ }
  }
  return null
}

/** Where `name` is read from: the folder that holds it, else the library (where it would be written). */
export async function libraryFile(kind: LibraryKind, name: string, root?: string | null): Promise<string> {
  return (await findInLibrary(kind, name, root)) ?? path.join(libraryDir(kind, root), name)
}

/**
 * One listing of the kind's folders: each entry name with the folder it was
 * found in, the library winning a name both hold. Empty when none exists.
 */
export async function listLibrary(kind: LibraryKind, root?: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const dir of libraryDirs(kind, root)) {
    let names: string[]
    try { names = await fs.promises.readdir(dir) }
    catch { continue }
    for (const n of names) if (!out.has(n)) out.set(n, dir)
  }
  return out
}

/**
 * The training queue's job file: `library/.training-jobs.json`, moved (with
 * its `.bak`) from `models/` on first use. A store can't be read from two
 * places, so when both exist the library's copy is the one used (logged).
 */
export function trainingJobsFile(root?: string | null): string {
  const base = baseOf(root)
  moveFile(base, JOBS_FILE)
  moveFile(base, `${JOBS_FILE}.bak`)
  const file = path.join(base, LIBRARY_FOLDER, JOBS_FILE)
  const legacy = path.join(base, LEGACY_FOLDER, JOBS_FILE)
  if (present(legacy)) logOnce(`both:${legacy}`, `[library] both ${file} and ${legacy} exist; using ${file}`, true)
  return file
}

/** Tests: forget which messages were logged. */
export function __resetLibraryLogForTests(): void { logged.clear() }
