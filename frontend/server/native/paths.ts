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
