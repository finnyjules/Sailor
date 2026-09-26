/**
 * The one doorway for saving and reading run files. Today it writes into
 * ComfyUI's output folder with ComfyUI's naming (`generate_image_00001_.png`),
 * so Assets, result cards and /view work unchanged. Moving to cloud storage
 * later means a second implementation of ResultStore plus a /view change —
 * nothing else in the runner reads or writes files directly.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pyIntOf } from '#shared/runner/pyText'
import { shortUserHash } from '../utils/meterGraphRun'
import type { OutputFile } from './types'

/** What `save` is asked to write. */
export interface SaveOptions {
  userId: string | null
  /** The file name before `_<counter>_.<ext>`; no `/`. */
  prefix: string
  ext: string
  /**
   * A folder under the user's own (hosted) or the folder's root (local), as
   * Save image's prefix names it (`a/b`); `..` and absolute parts are refused.
   */
  subfolder?: string
  /** 'output' (an asset; the default) or 'temp' (Preview image). */
  folder?: 'output' | 'temp'
  /**
   * The counter is read over files named `prefix` (not the file's own
   * prefix) and moved on by `offset`: Save image's `%batch_num%`, whose
   * counter Python reads once over the prefix as typed.
   */
  counter?: { prefix: string; offset: number }
}

export const SAVE_OUTSIDE = 'This file name would save outside the output folder'
/** A preview's own name (savePreviewAs): a plain file name. */
export const PREVIEW_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/

export interface ResultStore {
  save(bytes: Uint8Array, o: SaveOptions): Promise<OutputFile>
  /**
   * A picture shown in a node under a name of the caller's choosing, in temp
   * (the runner's own subfolder locally, the user's hosted), overwritten when
   * it is there: the same name is the same picture (R1.5/R1.6).
   */
  savePreviewAs(bytes: Uint8Array, o: { filename: string; userId: string | null }): Promise<OutputFile>
  /**
   * A result shown in a node but not an asset: save_live_preview(unique=True)'s
   * `live_preview_<node>_<nnnnn>.png` in the temp folder (the Frame render);
   * hosted, in the user's own subfolder of it.
   */
  saveLivePreview(bytes: Uint8Array, o: { nodeId: string; userId: string | null }): Promise<OutputFile>
  read(file: OutputFile): Promise<Uint8Array>
  exists(file: OutputFile): Promise<boolean>
  /** The file's size in bytes without reading it, or null when it isn't there (F22 fix round 1). */
  size?(file: OutputFile): Promise<number | null>
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

/**
 * folder_paths.get_save_image_path's counter: over the names that are
 * `<prefix>_…`, the highest int() of what comes before the next `_` (0 when
 * int() can't read it), + 1; 1 when none is.
 */
export function nextCounter(names: string[], prefix: string): number {
  let max: number | null = null
  for (const n of names) {
    if (!n.startsWith(`${prefix}_`)) continue
    const digits = pyIntOf(n.slice(prefix.length + 1).split('_')[0]!) ?? 0
    max = max === null ? digits : Math.max(max, digits)
  }
  return max === null ? 1 : max + 1
}

/** Python's f"{counter:05}". */
export function counter05(n: number): string {
  return n < 0 ? `-${String(-n).padStart(4, '0')}` : String(n).padStart(5, '0')
}

/** A subfolder a save may write to: relative, no `..`, no NUL; '' for none. */
function safeSubfolder(sub: string | undefined): string {
  if (!sub) return ''
  const parts = sub.split('/')
  if (sub.startsWith('/') || sub.includes('\0') || parts.some(p => p === '..')) throw new Error(SAVE_OUTSIDE)
  return parts.filter(p => p && p !== '.').join('/')
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
    // Where the runner's file names part from Python's: Python never checks
    // that a name is free and overwrites; the runner writes with 'wx' and, on
    // a clash, moves on to the next counter, so it never overwrites. The
    // names differ exactly where Python would overwrite: a `%batch_num%` run
    // again (its counter reads the prefix as typed, so it starts at 1 each
    // time); a prefix ending in `/` or `/..` (get_save_image_path measures the
    // un-normalised basename, finds no match and always writes _00001_); two
    // saves racing for one name; a name differing only in case on a
    // case-insensitive disk. The counter itself (nextCounter) is Python's.
    async save(bytes, { userId, prefix, ext, subfolder: sub, folder = 'output', counter: counting }) {
      const base = o.dirForType(folder)
      if (!base) throw new Error('The file store is not available')
      if (!prefix || /[/\0]/.test(prefix) || /[/\0]/.test(ext)) throw new Error(SAVE_OUTSIDE)
      const subfolder = [userSubfolder(userId, o.hosted()), safeSubfolder(sub)].filter(Boolean).join('/')
      const root = resolve(base)
      const dir = resolve(root, subfolder)
      if (dir !== root && !dir.startsWith(root + sep)) throw new Error(SAVE_OUTSIDE)
      await mkdir(dir, { recursive: true })
      const names = await readdir(dir).catch(() => [])
      let counter = counting ? nextCounter(names, counting.prefix) + counting.offset : nextCounter(names, prefix)
      for (let tries = 0; tries < 1000; tries++, counter++) {
        const filename = `${prefix}_${counter05(counter)}_.${ext}`
        try {
          await writeFile(join(dir, filename), bytes, { flag: 'wx' })
          return { filename, subfolder, type: folder }
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
    async savePreviewAs(bytes, { filename, userId }) {
      if (!PREVIEW_NAME_RE.test(filename) || filename === '.' || filename === '..') throw new Error('This preview’s file name is not a plain name')
      const root = o.dirForType('temp')
      if (!root) throw new Error('The file store is not available')
      const subfolder = o.hosted() ? userSubfolder(userId, true) : LOCAL_LIVE_PREVIEW_SUBFOLDER
      const dir = join(root, subfolder)
      await mkdir(dir, { recursive: true })
      // Written whole, then moved into place: a reader never sees half a file.
      const tmp = join(dir, `.${filename}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(tmp, bytes)
      await rename(tmp, join(dir, filename))
      return { filename, subfolder, type: 'temp' }
    },
    async read(file) {
      return new Uint8Array(await readFile(pathOf(file)))
    },
    async exists(file) {
      try { return (await stat(pathOf(file))).isFile() } catch { return false }
    },
    async size(file) {
      try {
        const st = await stat(pathOf(file))
        return st.isFile() ? st.size : null
      }
      catch { return null }
    },
  }
}
