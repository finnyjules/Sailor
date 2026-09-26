// frontend/server/runner/fileAccess.ts
/**
 * One reader for every file a run touches: kept bytes from ./keptBytes.ts,
 * everything else from the result store. The engine reads, checks and sizes
 * files only through this, so a node never needs to know where a file lives.
 */
import type { KeptBytes } from './keptBytes'
import type { ResultStore } from './results'
import type { OutputFile } from './types'

export interface FileAccess {
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  size(file: OutputFile): Promise<number | null>
}

export function createFileAccess(results: ResultStore, kept: KeptBytes): FileAccess {
  return {
    read: f => f.type === 'kept' ? kept.read(f) : results.read(f),
    exists: f => f.type === 'kept' ? kept.exists(f) : results.exists(f),
    size: f => f.type === 'kept' ? kept.size(f) : (results.size?.(f) ?? Promise.resolve(null)),
  }
}
