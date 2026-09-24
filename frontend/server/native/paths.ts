/**
 * The engine folders Sailor's native routes read and write, and the one shared
 * guard every request-supplied file name goes through.
 *
 * The folders are the ones ComfyUI used — `<engine root>/{input,output,temp,
 * user,models}` — resolved through the same `resolveEngineRoot()` the upload
 * checks use, so the native routes and the Python routes they replace always
 * address the same files. Null means the engine root could not be found;
 * callers must say so rather than guess a folder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveEngineRoot } from '../utils/inputUploads'

export type EngineFolder = 'input' | 'output' | 'temp' | 'user' | 'models'

export function engineFolder(name: EngineFolder): string | null {
  const root = resolveEngineRoot()
  return root ? path.join(root, name) : null
}

/** ComfyUI's `folder_paths.get_user_directory()`. */
export function userDir(): string | null {
  return engineFolder('user')
}

/**
 * Port of `_is_safe_id` (comfy_extras/nodes_sailor_projects.py): a non-empty
 * string with no separator, no parent reference, and no leading dot. Ids here
 * are Sailor's own (uuids, `v_<hex>`, `b_<ts>`), so the allowlist is
 * deliberately conservative.
 */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('..')
    && !value.startsWith('.')
}

/**
 * Join request-derived names under `root`, refusing (null) any result that
 * resolves outside it. Callers validate each name with the Python's own rule
 * first (e.g. `isSafeId`); this is the containment backstop.
 */
export function resolveInside(root: string, ...names: string[]): string | null {
  const base = path.resolve(root)
  const full = path.resolve(base, ...names)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

/**
 * `os.path.realpath` (non-strict): symlinks resolved for the part of the path
 * that exists, the missing remainder appended as written.
 */
function realpathLoose(p: string): string {
  let head = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail)
    }
    catch {
      const parent = path.dirname(head)
      if (parent === head) return path.join(head, ...tail)
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

/**
 * Port of `_safe_resolve` (comfy_extras/nodes_timeline.py), the guard behind
 * the input/output file deletes: refuse an empty or absolute filename or an
 * absolute subfolder, then refuse anything whose real path leaves `root`.
 * Returns the normalised (not the real) path, as the Python does.
 */
export function pySafeResolve(root: string, subfolder: string, filename: string): string | null {
  if (!filename || filename.startsWith('/') || (subfolder || '').startsWith('/')) return null
  const candidate = path.normalize([root, subfolder || '', filename].filter(Boolean).join('/'))
    .replace(/(.)\/+$/, '$1')
  const realRoot = realpathLoose(root)
  const realCandidate = realpathLoose(candidate)
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot === '/' ? '/' : realRoot + path.sep)) return null
  return candidate
}

/**
 * Review C2 — an exact mirror of ComfyUI's folder_paths.annotated_filepath().
 * The engine resolves a trailing `[output]` / `[input]` / `[temp]` annotation
 * to a base directory BEFORE it looks at the `type` query param, so `type`
 * alone is not the type. Kept byte-for-byte faithful to the Python (plain
 * endsWith + fixed-width strip, which also eats the separating space) rather
 * than a tidier regex — if the two ever disagree, the gate and the engine
 * disagree about which file is being served.
 */
export function annotatedFilepath(name: string): { name: string, type: 'output' | 'input' | 'temp' | null } {
  if (name.endsWith('[output]')) return { name: name.slice(0, -9), type: 'output' }
  if (name.endsWith('[input]')) return { name: name.slice(0, -8), type: 'input' }
  if (name.endsWith('[temp]')) return { name: name.slice(0, -7), type: 'temp' }
  return { name, type: null }
}

/**
 * `os.path.basename` on POSIX: everything after the last `/` (so `a/` is ''
 * and a backslash is an ordinary character). The one rule both the native
 * /view resolver and the hosted /view gate use, so they name the same file.
 */
export function pyBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}
