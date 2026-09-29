// frontend/server/runner/fileAccess.ts
/**
 * One reader for every file a run touches: kept bytes from ./keptBytes.ts,
 * everything else from the result store. The engine reads, checks and sizes
 * files only through this, so a node never needs to know where a file lives.
 *
 * R5.2: the video tools read files by path, never through memory. `pathOf`
 * says where a file is, `rootOf` the store folder it must really be in (the
 * media module's `roots`), and `verifiedPath` is `pathOf` once a kept file's
 * bytes are checked against its name (KEPT_GONE when changed or missing).
 */
import type { KeptBytes } from './keptBytes'
import type { ResultStore } from './results'
import type { OutputFile } from './types'

export const FILE_PATHS_MISSING = 'The file store can’t hand this file to the video tools'

export interface FileAccess {
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
  /** Where the file is on disk (a kept file: KEPT_GONE when missing). */
  pathOf(file: OutputFile): string
  /** The folder the file must really be in, symlinks resolved (the run's kept folder, or its store folder). */
  rootOf(file: OutputFile): string
  /** `pathOf`, a kept file's bytes checked against its name first. */
  verifiedPath(file: OutputFile): Promise<string>
}

export function createFileAccess(results: ResultStore, kept: KeptBytes): FileAccess {
  const storePath = (f: OutputFile): string => {
    if (!results.pathOf) throw new Error(FILE_PATHS_MISSING)
    return results.pathOf(f)
  }
  return {
    read: f => f.type === 'kept' ? kept.read(f) : results.read(f),
    exists: f => f.type === 'kept' ? kept.exists(f) : results.exists(f),
    size: f => f.type === 'kept' ? kept.size(f) : (results.size?.(f) ?? Promise.resolve(null)),
    pathOf: f => f.type === 'kept' ? kept.pathOf(f) : storePath(f),
    rootOf: (f) => {
      if (f.type === 'kept') return kept.rootOf(f.subfolder)
      if (!results.rootOf) throw new Error(FILE_PATHS_MISSING)
      return results.rootOf(f)
    },
    verifiedPath: async f => f.type === 'kept' ? kept.verifiedPath(f) : storePath(f),
  }
}
