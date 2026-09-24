/**
 * The small input/ housekeeping routes, served by Sailor instead of ComfyUI:
 *
 *   POST /sailor/lora/save_captions   (comfy_extras/_lora_training.py:117)
 *   POST /sailor/lora/clear_dataset   (comfy_extras/_lora_training.py:154)
 *   POST /sailor/motion/cleanup_frames (comfy_extras/nodes_compositor.py:958)
 *
 * The Python's own checks are ported as written, with one addition the
 * shared path rule demands: the dataset folder must resolve INSIDE input/.
 * `_safe_folder` compares paths without resolving `..` (`os.path.commonpath`
 * on unnormalised paths), so on the Python side `folder: "../output"` passed
 * its guard and `clear_dataset` would `rmtree` the output folder; `"."` or
 * `"/"` named input/ itself. Here both are refused with the Python's own
 * `folder escapes input directory` 400 — escaping input/ always (by `..` or
 * through a symlink: real paths are compared), and naming input/ itself for a
 * dataset clear.
 */
import fs from 'node:fs'
import path from 'node:path'
import { truthy } from './projects'
import { isDir, realpathLoose, resolveInside } from './paths'

type Json = any

export interface HousekeepingResult {
  status: number
  body: unknown
}

const isObj = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `body.get(...)` on a request body that isn't a dict raises (aiohttp's 500; the caller's guard). */
function asDict(body: unknown): Record<string, Json> {
  if (!isObj(body)) throw new TypeError('\'body\' has no attribute \'get\'')
  return body
}

/** `os.path.basename` (POSIX): everything after the last `/`. */
function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** `os.path.splitext(p)[0]` (POSIX): leading dots belong to the name. */
function stem(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || !/[^.]/.test(base.slice(0, dot))) return p
  return p.slice(0, p.length - (base.length - dot))
}

/** `os.path.normpath` (POSIX), including its keep-exactly-two-leading-slashes rule. */
function normpath(p: string): string {
  if (p === '') return '.'
  const initial = p.startsWith('/') ? (p.startsWith('//') && !p.startsWith('///') ? 2 : 1) : 0
  const out: string[] = []
  for (const comp of p.split('/')) {
    if (comp === '' || comp === '.') continue
    if (comp !== '..' || (!initial && !out.length) || (out.length && out.at(-1) === '..')) out.push(comp)
    else if (out.length) out.pop()
  }
  const joined = '/'.repeat(initial) + out.join('/')
  return joined || '.'
}

export class FolderEscapesError extends Error {
  constructor() { super('folder escapes input directory') }
}

/**
 * `_safe_folder`, then the containment backstop: the folder, normalised and
 * stripped of leading slashes, joined under input/, must stay inside it.
 * `allowRoot` = whether input/ itself is an acceptable answer.
 */
export function safeDatasetFolder(inputDir: string, folder: string, allowRoot: boolean): string {
  // `os.path.join(input_dir, normalized)` names the same folder as this resolved path.
  const normalized = normpath(folder).replace(/^[/\\]+/, '')
  const inside = resolveInside(inputDir, normalized)
  if (!inside || (!allowRoot && inside === path.resolve(inputDir))) throw new FolderEscapesError()
  // A symlink inside input/ must not carry the folder out of it: compare real paths.
  const realRoot = realpathLoose(inputDir)
  const realTarget = realpathLoose(inside)
  const within = realTarget === realRoot || realTarget.startsWith(realRoot === '/' ? '/' : realRoot + path.sep)
  if (!within || (!allowRoot && realTarget === realRoot)) throw new FolderEscapesError()
  return inside
}

/** `_save_captions`: `{folder, captions: {image_filename: text}}` → `<stem>.txt` sidecars; `{written}`. */
export function saveCaptionsRoute(inputDir: string, rawBody: unknown): HousekeepingResult {
  const body = asDict(rawBody)
  const folder = truthy(body.folder) ? body.folder : ''
  const captions = truthy(body.captions) ? body.captions : {}
  if (typeof folder !== 'string' || !isObj(captions)) return { status: 400, body: { error: 'bad payload' } }

  let target: string
  try { target = safeDatasetFolder(inputDir, folder, true) }
  catch (e) { return { status: 400, body: { error: (e as Error).message } } }
  if (!isDir(target)) return { status: 404, body: { error: `folder not found: ${folder}` } }

  let written = 0
  for (const [imageFilename, text] of Object.entries(captions)) {
    if (typeof imageFilename !== 'string' || typeof text !== 'string') continue
    const s = stem(basename(imageFilename))
    if (!s) continue
    fs.writeFileSync(path.join(target, `${s}.txt`), text, 'utf8')
    written += 1
  }
  return { status: 200, body: { written } }
}

/** `_clear_dataset`: remove input/<folder> and everything in it; `{ok: true}` even when it was not there. */
export function clearDatasetRoute(inputDir: string, rawBody: unknown): HousekeepingResult {
  const body = asDict(rawBody)
  const folder = truthy(body.folder) ? body.folder : ''
  if (typeof folder !== 'string' || !folder) return { status: 400, body: { error: 'bad payload' } }
  let target: string
  try { target = safeDatasetFolder(inputDir, folder, false) }
  catch (e) { return { status: 400, body: { error: (e as Error).message } } }
  // shutil.rmtree(ignore_errors=True) — and it does not follow a symlinked folder.
  if (isDir(target)) {
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true })
    }
    catch {}
  }
  return { status: 200, body: { ok: true } }
}

/**
 * `_SLATE_FRAME_RE = re.compile(r"^slate_\d+_\d{4}\.png$")`, used with
 * `.match`: Python's `\d` is any Unicode decimal digit, and its `$` also
 * matches just before a final newline.
 */
export const SLATE_FRAME_RE = /^slate_\p{Nd}+_\p{Nd}{4}\.png\n?$/u

/** `_cleanup_motion_frames`: `{delete: string[], keep?: string[]}` → `{deleted, skipped}`. */
export function cleanupFramesRoute(inputDir: string, rawBody: unknown): HousekeepingResult {
  const body = asDict(rawBody)
  const del = body.delete
  const keep = truthy(body.keep) ? body.keep : []
  if (!Array.isArray(del) || !Array.isArray(keep)) return { status: 400, body: { error: 'bad payload' } }
  const keepSet = new Set(keep.filter((k): k is string => typeof k === 'string').map(basename))
  let deleted = 0
  let skipped = 0
  for (const name of del) {
    if (typeof name !== 'string' || basename(name) !== name || !SLATE_FRAME_RE.test(name) || keepSet.has(name)) {
      skipped += 1
      continue
    }
    try {
      fs.unlinkSync(path.join(inputDir, name))
      deleted += 1
    }
    catch {
      skipped += 1
    }
  }
  if (deleted) console.info(`[Compositor] motion cleanup: deleted ${deleted} superseded bake frames`)
  return { status: 200, body: { deleted, skipped } }
}
