/**
 * The one doorway for saving and reading run files. Today it writes into
 * ComfyUI's output folder with ComfyUI's naming (`generate_image_00001_.png`),
 * so Assets, result cards and /view work unchanged. Moving to cloud storage
 * later means a second implementation of ResultStore plus a /view change —
 * nothing else in the runner reads or writes files directly.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { shortUserHash } from '../utils/meterGraphRun'
import type { OutputFile } from './types'

export interface ResultStore {
  save(bytes: Uint8Array, o: { userId: string | null; prefix: string; ext: string }): Promise<OutputFile>
  /**
   * A result shown in a node but not an asset: save_live_preview(unique=True)'s
   * `live_preview_<node>_<nnnnn>.png` in the temp folder (the Frame render);
   * hosted, in the user's own subfolder of it.
   */
  saveLivePreview(bytes: Uint8Array, o: { nodeId: string; userId: string | null }): Promise<OutputFile>
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
}

export function userSubfolder(userId: string | null, hosted: boolean): string {
  return hosted && userId ? `u_${shortUserHash(userId)}` : ''
}

/**
 * Local-mode live previews get their own subfolder of temp/ — ComfyUI's own
 * save_live_preview(unique=True) writes `live_preview_<node>_<nnnnn>.png`
 * straight into temp/ with the same name pattern, and when both the runner
 * and ComfyUI render the same node id, one silently overwrites the other's
 * file (seen live: ComfyUI's file replaced the runner's a moment later).
 * Hosted mode already isolates by user subfolder, so this only applies
 * locally, where userSubfolder() would otherwise return ''.
 */
export const LOCAL_LIVE_PREVIEW_SUBFOLDER = 'sailor_runner'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** folder_paths.get_save_image_path's counter: highest `<prefix>_<digits>_` + 1. */
export function nextCounter(names: string[], prefix: string): number {
  const re = new RegExp(`^${escapeRe(prefix)}_(\\d+)_`)
  let max = 0
  for (const n of names) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** The next `<prefix>_<nnnnn>.png` number: one past the highest there. */
export function nextLivePreview(names: string[], prefix: string): number {
  const re = new RegExp(`^${escapeRe(prefix)}_(\\d+)\\.png$`)
  let max = 0
  for (const n of names) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

export function extFor(contentType: string | null, url: string, fallback: string): string {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct]!
  const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)
  if (m) {
    const e = m[1]!.toLowerCase()
    return e === 'jpeg' ? 'jpg' : e
  }
  return fallback
}

export function createEngineResultStore(o: { dirForType(type: string): string | null; hosted(): boolean }): ResultStore {
  function pathOf(file: OutputFile): string {
    const base = o.dirForType(file.type)
    if (!base) throw new Error('The file store is not available')
    const root = resolve(base)
    const p = resolve(root, file.subfolder || '', file.filename)
    if (!p.startsWith(root + sep)) throw new Error('File path is outside the store')
    return p
  }
  return {
    async save(bytes, { userId, prefix, ext }) {
      const base = o.dirForType('output')
      if (!base) throw new Error('The file store is not available')
      const subfolder = userSubfolder(userId, o.hosted())
      const dir = join(base, subfolder)
      await mkdir(dir, { recursive: true })
      let counter = nextCounter(await readdir(dir).catch(() => []), prefix)
      for (let tries = 0; tries < 1000; tries++, counter++) {
        const filename = `${prefix}_${String(counter).padStart(5, '0')}_.${ext}`
        try {
          await writeFile(join(dir, filename), bytes, { flag: 'wx' })
          return { filename, subfolder, type: 'output' }
        }
        catch (e: any) {
          if (e?.code !== 'EEXIST') throw e
        }
      }
      throw new Error('Could not find a free file name')
    },
    async saveLivePreview(bytes, { nodeId, userId }) {
      const root = o.dirForType('temp')
      if (!root) throw new Error('The file store is not available')
      const subfolder = o.hosted() ? userSubfolder(userId, true) : LOCAL_LIVE_PREVIEW_SUBFOLDER
      const base = join(root, subfolder)
      await mkdir(base, { recursive: true })
      // Node ids come from the browser: keep them to a safe file-name alphabet.
      const prefix = `live_preview_${nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}`
      let counter = nextLivePreview(await readdir(base).catch(() => []), prefix)
      for (let tries = 0; tries < 1000; tries++, counter++) {
        const filename = `${prefix}_${String(counter).padStart(5, '0')}.png`
        try {
          await writeFile(join(base, filename), bytes, { flag: 'wx' })
          return { filename, subfolder, type: 'temp' }
        }
        catch (e: any) {
          if (e?.code !== 'EEXIST') throw e
        }
      }
      throw new Error('Could not find a free file name')
    },
    async read(file) {
      return new Uint8Array(await readFile(pathOf(file)))
    },
    async exists(file) {
      try { return (await stat(pathOf(file))).isFile() } catch { return false }
    },
  }
}
