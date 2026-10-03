/**
 * Where Sailor's data folders live (C1, ComfyUI code removal): the one folder
 * that holds `input/`, `output/`, `temp/`, `user/` and `library/` (the user's
 * LoRAs, characters and voices — see library.ts; and the shipped
 * `blueprints/`, `shader_effects/`, `scenes/`).
 * Every server path into those folders resolves through this module.
 *
 * - `SAILOR_DATA_ROOT` names it explicitly (the hosted image sets `/app`).
 *   `SAILOR_ENGINE_ROOT` is the old name, still read; `SAILOR_DATA_ROOT` wins
 *   when both are set. A named folder is checked by the folder Sailor
 *   actually reads, `input/`; one that doesn't hold it fails closed (null),
 *   never falling back to a guess.
 * - Otherwise the walk up from the server's working directory stops at the
 *   repo root: the folder holding `frontend/` beside `user/` or `input/`.
 *   Nothing Python marks it — Sailor no longer ships ComfyUI's `main.py`.
 *
 * Null means "unknown". Checks that guard files (the upload overwrite gate,
 * the /view owner checks) must treat that as unknown and fail closed; see
 * `inputUploads.ts`. Distinct from `SAILOR_DATA_DIR` (dataDir.ts), which
 * moves the server's own JSON stores.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

export type DataFolder = 'input' | 'output' | 'temp' | 'user' | 'library'

/** The env name to set, for messages. */
export const DATA_ROOT_ENV = 'SAILOR_DATA_ROOT'

export interface DataRootEnv {
  SAILOR_DATA_ROOT?: string | null
  /** The old name, kept as an alias. */
  SAILOR_ENGINE_ROOT?: string | null
}

/** The explicitly named root: `SAILOR_DATA_ROOT`, else the old `SAILOR_ENGINE_ROOT`. Empty = unset. */
export function namedDataRoot(env: DataRootEnv): string | null {
  return env.SAILOR_DATA_ROOT || env.SAILOR_ENGINE_ROOT || null
}

/** The repo root marker: `frontend/` beside `user/` or `input/`. */
function isRepoDataRoot(dir: string): boolean {
  return existsSync(path.join(dir, 'frontend'))
    && (existsSync(path.join(dir, 'user')) || existsSync(path.join(dir, 'input')))
}

/**
 * Pure resolver: the named root when it checks out (validated, not trusted
 * blind — a broken setting fails closed rather than silently deferring to
 * the walk), else the walk up from `cwd`. Null when nothing is found.
 */
export function computeDataRoot(cwd: string, env: DataRootEnv): string | null {
  const named = namedDataRoot(env)
  if (named) return existsSync(path.join(named, 'input')) ? named : null
  let dir = cwd
  for (let i = 0; i < 12; i++) {
    if (isRepoDataRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

let rootOverride: string | null | undefined // undefined = no override, use real resolution

/** Test-only override — bypasses the env and the walk entirely. */
export function __setDataRootForTests(root: string | null | undefined): void {
  rootOverride = root
}

/** Production wiring: the env names, else the walk from `process.cwd()`. */
export function resolveDataRoot(): string | null {
  if (rootOverride !== undefined) return rootOverride
  return computeDataRoot(process.cwd(), {
    SAILOR_DATA_ROOT: process.env.SAILOR_DATA_ROOT,
    SAILOR_ENGINE_ROOT: process.env.SAILOR_ENGINE_ROOT,
  })
}

/** `<data root>/<name>`, or null when the root is unknown. */
export function dataFolder(name: DataFolder): string | null {
  const root = resolveDataRoot()
  return root ? path.join(root, name) : null
}

/**
 * A path under the data root for the local-studio routes (LoRAs, characters,
 * voices, training) that never had a fail-closed answer: when the root can't
 * be found they keep their old reading, the folder above the server's working
 * directory. Guards that decide whose file something is must use
 * `resolveDataRoot()` / `dataFolder()` instead and refuse on null.
 */
export function dataPath(...parts: string[]): string {
  return path.join(resolveDataRoot() ?? path.resolve(process.cwd(), '..'), ...parts)
}
