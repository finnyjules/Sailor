/**
 * The media library, served by Sailor instead of ComfyUI — a port of the
 * handlers in comfy_extras/nodes_timeline.py:
 *
 *   GET    /sailor/output_listing    (:2020)  every media file under output/
 *   GET    /sailor/input_listing     (:2391)  media files at the top of input/
 *   DELETE /sailor/input_file        (:2438)
 *   DELETE /sailor/output_file       (:2452)
 *   GET    /sailor/assets            (:2118)  the Timeline asset library,
 *   POST   /sailor/asset_import      (:2122)  stored in user/timeline_assets.json
 *   DELETE /sailor/assets/{asset_id} (:2160)
 *   GET    /sailor/input_thumbnail   (:2247)  cached in user/timeline_thumbs/
 *   GET    /sailor/asset_thumbnails  (:2281)  under the Python's own names
 *   GET    /sailor/asset_waveform    (:2354)
 *
 * with `_probe_media` (:2077), `_gen_thumbnails` (:2184) and
 * `_gen_waveform_peaks` (:2319) behind them.
 *
 * Same folders, same file formats, same response shapes. Images are handled
 * here with sharp. Video and sound (step 3, R5.6, no family): when Sailor's
 * media tools are ready (`mediaTools()`), server/media/thumbnails.ts reads them
 * as PyAV does, and the engine is never asked; a file the tools can't read
 * gives Python's own failure answer ([] or nulls). Without the tools, those
 * requests answer 503 in plain words (MEDIA_UNAVAILABLE; an import still
 * records the asset, without duration or size), here and hosted alike: there
 * is no engine to ask (step 4, C5). A thumbnail or waveform already cached is
 * served from the cache either way.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { H3Event } from 'h3'
import { pyJsonDumps } from '../../shared/runner/pyJson'
import { mediaTools } from '../media/tools'
import type { NativeMedia } from '../media/thumbnails'
import { isHosted } from '../utils/deployMode'
import { engineFolder, listdirEntries, pySafeResolve, resolveInside, writeFileAtomic } from './paths'
import { pyDumps } from './pyJson'
import { truthy } from './projects'

type Json = any

export interface MediaResult {
  status: number
  body: unknown
  /** A plain-text body (aiohttp's own error pages). */
  text?: boolean
  headers?: Record<string, string>
}

// ------------------------------------------------------------------ constants

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'])
/** `_MEDIA_EXTS` */
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS])

/** `_thumb_height_px()` — source-strip thumbnail height; width follows the aspect (server/media/thumbnails.ts has the same). */
export const THUMB_HEIGHT_PX = 48
export type { NativeMedia }

/**
 * A video or sound Sailor's own media tools can't read right now, refused in
 * plain words (step 3, R10.9 for hosted; step 4, C5 everywhere: there is no
 * engine to ask).
 */
export const MEDIA_UNAVAILABLE: MediaResult = { status: 503, body: { error: 'Sailor can’t read this file right now. Try again in a moment.' } }

// --------------------------------------------------------------- Python-isms

/** `os.path.splitext(name)[1].lower()` — a leading dot is not an extension. */
export function pyExt(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  let i = base.length
  while (i > 0 && base[i - 1] !== '.') i--
  if (i === 0) return ''
  const dot = i - 1
  // Leading dots belong to the name (".bashrc", "..png" has no ext either).
  if (!/[^.]/.test(base.slice(0, dot))) return ''
  return base.slice(dot).toLowerCase()
}

/** `os.stat(...).st_mtime` — CPython builds it as `sec + nsec * 1e-9` in double precision. */
export function pyMtime(st: fs.BigIntStats): number {
  const sec = st.mtimeNs / 1_000_000_000n
  const nsec = st.mtimeNs % 1_000_000_000n
  return Number(sec) + Number(nsec) * 1e-9
}

/** Python's `round(x)` on a float: half to even. */
export function pyRound(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff > 0.5) return f + 1
  if (diff < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** Python's `int(str)` for a query value; null where Python raises ValueError. */
export function pyInt(raw: string): number | null {
  const s = raw.trim()
  if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) return null
  return Number.parseInt(s.replace(/_/g, ''), 10)
}

const STRERROR: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  EPERM: [1, 'Operation not permitted'],
  EACCES: [13, 'Permission denied'],
  EBUSY: [16, 'Resource busy'],
  EISDIR: [21, 'Is a directory'],
  ENOTDIR: [20, 'Not a directory'],
  EROFS: [30, 'Read-only file system'],
}

/** `str(OSError)` — `[Errno 2] No such file or directory: '/x'`. */
export function pyOSErrorText(e: unknown, file: string): string {
  const err = e as NodeJS.ErrnoException
  const known = err?.code ? STRERROR[err.code] : undefined
  if (!known) return err?.message ?? String(e)
  return `[Errno ${known[0]}] ${known[1]}: ${pyRepr(file)}`
}

function pyRepr(s: string): string {
  const q = s.includes('\'') && !s.includes('"') ? '"' : '\''
  const body = s.replace(/\\/g, '\\\\').replace(q === '\'' ? /'/g : /"/g, `\\${q}`)
  return `${q}${body}${q}`
}

/** `os.path.join(a, b)` — no normalisation, an absolute `b` wins. */
function pyJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b
  if (a === '' || a.endsWith('/')) return a + b
  return `${a}/${b}`
}

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p) }
  catch { return null }
}


// ------------------------------------------------------------------ listings

export interface OutputItem { filename: string, subfolder: string, type: 'output', size: number, mtime: number }
export interface InputItem { filename: string, path: string, type: 'input', size: number, mtime: number }

/** Newest first; ties keep walk order (Python's sort is stable under reverse=True). */
function byMtimeDesc<T extends { mtime: number }>(items: T[]): T[] {
  return items.sort((a, b) => b.mtime - a.mtime)
}

/**
 * `os.walk(output_dir)` top-down: each folder's files in scandir order, then
 * its subfolders in scandir order. Symlinked folders are listed but not
 * entered (followlinks=False); an unreadable folder is skipped silently.
 */
function walkFiles(top: string, visit: (root: string, file: string) => void): void {
  let entries: fs.Dirent[]
  try { entries = listdirEntries(top) }
  catch { return }
  const dirs: string[] = []
  const files: string[] = []
  for (const e of entries) {
    let isDir = e.isDirectory()
    if (e.isSymbolicLink() || (!e.isFile() && !isDir)) isDir = statOrNull(path.join(top, e.name))?.isDirectory() ?? false
    ;(isDir ? dirs : files).push(e.name)
  }
  for (const f of files) visit(top, f)
  for (const d of dirs) {
    const sub = pyJoin(top, d)
    let link = false
    try { link = fs.lstatSync(sub).isSymbolicLink() }
    catch {}
    if (!link) walkFiles(sub, visit)
  }
}

export function outputListing(outputDir: string): MediaResult {
  const items: OutputItem[] = []
  walkFiles(outputDir, (root, fname) => {
    if (fname.startsWith('.')) return
    if (!MEDIA_EXTS.has(pyExt(fname))) return
    let st: fs.BigIntStats
    try { st = fs.statSync(pyJoin(root, fname), { bigint: true }) }
    catch { return }
    const rel = path.relative(outputDir, root)
    items.push({
      filename: fname,
      subfolder: rel === '' ? '' : rel,
      type: 'output',
      size: Number(st.size),
      mtime: pyMtime(st),
    })
  })
  return { status: 200, body: { items: byMtimeDesc(items) } }
}

export function inputListing(inputDir: string): MediaResult {
  const items: InputItem[] = []
  let entries: fs.Dirent[]
  try { entries = listdirEntries(inputDir) }
  catch (e) { return { status: 500, body: { error: pyOSErrorText(e, inputDir), items: [] } } }
  for (const e of entries) {
    const fname = e.name
    if (fname.startsWith('.')) continue
    const full = pyJoin(inputDir, fname)
    if (!statOrNull(full)?.isFile()) continue
    if (!MEDIA_EXTS.has(pyExt(fname))) continue
    let st: fs.BigIntStats
    try { st = fs.statSync(full, { bigint: true }) }
    catch { continue }
    items.push({ filename: fname, path: full, type: 'input', size: Number(st.size), mtime: pyMtime(st) })
  }
  return { status: 200, body: { items: byMtimeDesc(items) } }
}

// -------------------------------------------------------------------- deletes

/** `_input_file_delete_route` / `_output_file_delete_route`. */
export function deleteFile(root: string, subfolder: string, filename: string): MediaResult {
  const target = pySafeResolve(root, subfolder, filename)
  if (target === null) return { status: 400, body: { error: 'invalid filename' } }
  if (!statOrNull(target)?.isFile()) return { status: 200, body: { ok: true, missing: true } }
  try {
    fs.unlinkSync(target)
  }
  catch (e) {
    return { status: 500, body: { error: pyOSErrorText(e, target) } }
  }
  return { status: 200, body: { ok: true } }
}

// -------------------------------------------------------------- asset library

/** `_assets_file()` — creates the user folder, like `os.makedirs(exist_ok=True)`. */
export function assetsFile(userDirectory: string): string {
  fs.mkdirSync(userDirectory, { recursive: true })
  return path.join(userDirectory, 'timeline_assets.json')
}

/** `_load_assets()` — a missing or unreadable file is an empty library. */
export function loadAssets(userDirectory: string): Json {
  const p = assetsFile(userDirectory)
  if (!fs.existsSync(p)) return []
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
  catch { return [] }
}

/**
 * `_save_assets()` — `json.dump(assets, f, indent=2)`. Written atomically
 * (temp file in the same dir + rename), like `projects.ts`'s
 * `atomicWriteJson` (both via paths.ts `writeFileAtomic`), so a reader never
 * observes a half-written file.
 */
export function saveAssets(userDirectory: string, assets: Json): void {
  writeFileAtomic(assetsFile(userDirectory), pyDumps(assets, 2), { mode: 0o600 })
}

/** Python's `a[k]` on an asset record: a TypeError/KeyError (a 500) when it isn't there. */
function field(a: Json, k: string): Json {
  if (a === null || typeof a !== 'object' || Array.isArray(a) || !(k in a)) throw new TypeError(`asset record has no '${k}'`)
  return a[k]
}

/** Python iterates whatever `json.load` returned; only a list of records is usable. */
function records(assets: Json): Json[] {
  if (Array.isArray(assets)) return assets
  if (assets !== null && typeof assets === 'object') return Object.keys(assets)
  throw new TypeError('the asset library is not iterable')
}

/** `next((a for a in assets if a["id"] == id), None)` */
function findAsset(assets: Json, id: string): Json | undefined {
  return records(assets).find((a: Json) => field(a, 'id') === id)
}

export interface ProbeInfo { kind: 'image' | 'video' | 'audio', duration_sec: number | null, width: number | null, height: number | null }

/**
 * `_probe_media`: an image's size with sharp; a video's size and length and a
 * sound's length from the media tools (`native`). Without them, video and
 * audio come back with their kind and null duration/size.
 */
export async function probeMediaNative(file: string, native: NativeMedia | null = null): Promise<ProbeInfo> {
  return (await probeKept(file, native)).info
}

/**
 * `probeMediaNative`, and whether its numbers may be recorded: `keep` is false
 * when the media tools gave nulls for Sailor's own reason (a cap, the time
 * limit, busy slots, a tool failure), so the import answers but records
 * nothing, and a re-import probes again (R5.6 fix round 1).
 */
async function probeKept(file: string, native: NativeMedia | null): Promise<{ info: ProbeInfo, keep: boolean }> {
  const ext = pyExt(file)
  const info: ProbeInfo = { kind: 'video', duration_sec: null, width: null, height: null }
  let keep = true
  const fromTools = async (kind: 'video' | 'audio') => {
    const r = await native!.probe(file, kind)
    info.duration_sec = r.duration_sec
    info.width = r.width
    info.height = r.height
    keep = r.keep
  }
  if (VIDEO_EXTS.has(ext)) {
    info.kind = 'video'
    if (native) await fromTools('video')
  }
  else if (IMAGE_EXTS.has(ext)) {
    info.kind = 'image'
    try {
      const meta = await sharp(file).metadata()
      if (meta.width && meta.height) {
        info.width = meta.width
        info.height = meta.height
      }
    }
    catch {}
  }
  else if (AUDIO_EXTS.has(ext)) {
    info.kind = 'audio'
    if (native) await fromTools('audio')
  }
  return { info, keep }
}

export function isImageFile(file: string): boolean {
  return IMAGE_EXTS.has(pyExt(file))
}

export function assetsListRoute(userDirectory: string): MediaResult {
  return { status: 200, body: { assets: loadAssets(userDirectory) } }
}

/**
 * `_asset_import_route`. With the media tools (`native`) a video/audio file is
 * probed here. Without them `engine` is called for it (a stand-in answer; since
 * C5 the route passes one that answers null) — on null the asset is recorded
 * without duration or size.
 */
export async function assetImportRoute(
  userDirectory: string,
  inputDir: string,
  body: Json,
  engine: () => Promise<MediaResult | null>,
  native: NativeMedia | null = null,
): Promise<MediaResult> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body is not an object')
  let p: Json = body.path
  if (!truthy(p)) {
    return { status: 400, body: { error: 'missing \'path\'' } }
  }
  if (typeof p !== 'string') throw new TypeError('path is not a string')
  if (!p.startsWith('/')) p = pyJoin(inputDir, p)
  if (!statOrNull(p)) return { status: 404, body: { error: `not found: ${p}` } }

  if (!isImageFile(p) && !native) {
    const forwarded = await engine()
    if (forwarded) return forwarded
  }
  const { info, keep } = await probeKept(p, native)

  const assets = loadAssets(userDirectory)
  const existing = records(assets).find((a: Json) => field(a, 'path') === p)
  if (existing) return { status: 200, body: { asset: refilled(userDirectory, existing, native, info, keep), created: false } }

  const asset = {
    id: randomUUID(),
    path: p,
    kind: info.kind,
    name: p.slice(p.lastIndexOf('/') + 1),
    duration_sec: info.duration_sec,
    width: info.width,
    height: info.height,
    thumbnail_path: null,
    waveform_path: null,
  }
  // Re-read right before writing: `probeMediaNative`/`engine()` above awaited,
  // so a record another request (or ComfyUI, when it is still in the loop)
  // wrote to the SAME file in that window would otherwise be clobbered by
  // writing out our now-stale snapshot. Re-checking `path` against the fresh
  // read also catches a concurrent import of the same file.
  const latest = loadAssets(userDirectory)
  const latestExisting = records(latest).find((a: Json) => field(a, 'path') === p)
  if (latestExisting) return { status: 200, body: { asset: refilled(userDirectory, latestExisting, native, info, keep), created: false } }
  // The probe failed for Sailor's own reason (R5.6 fix round 2): recorded as Python would with the nulls,
  // so the id is a real asset, and marked so the next import or route read probes it again.
  if (!keep) (asset as Json)[PROBE_AGAIN] = true
  latest.push(asset)
  saveAssets(userDirectory, latest)
  return { status: 200, body: { asset, created: true } }
}

/**
 * A Sailor-only field on an asset record (R5.6 fix round 2): its probe failed
 * for Sailor's own reason (a cap, the time limit, busy slots, a tool failure),
 * so its length and size are nulls for now. The next import of the same file,
 * or a thumbnail or waveform read of the asset, probes it again; a probe that
 * succeeds fills them in and removes the field. Python's readers ignore it.
 * A file Python can't read either is recorded with nulls and no mark.
 */
export const PROBE_AGAIN = 'sailor_probe_again'

function marked(a: Json): boolean {
  return a !== null && typeof a === 'object' && !Array.isArray(a) && a[PROBE_AGAIN] === true
}

/**
 * A marked record, filled from a probe that succeeded (re-read fresh and
 * matched by id, so another writer's records survive): its numbers written,
 * the mark gone. Anything else comes back as it is.
 */
function refilled(userDirectory: string, record: Json, native: NativeMedia | null, info: ProbeInfo, keep: boolean): Json {
  if (!native || !keep || !marked(record)) return record
  const latest = loadAssets(userDirectory)
  const rec = records(latest).find((a: Json) => a !== null && typeof a === 'object' && a.id === record.id)
  if (!marked(rec)) return rec ?? record
  rec.duration_sec = info.duration_sec
  rec.width = info.width
  rec.height = info.height
  delete rec[PROBE_AGAIN]
  saveAssets(userDirectory, latest)
  return rec
}

/** A route reading a marked asset probes it again first (R5.6 fix round 2). */
async function probeMarkedAgain(userDirectory: string, asset: Json, native: NativeMedia | null): Promise<void> {
  if (!native || !marked(asset)) return
  const { info, keep } = await probeKept(String(field(asset, 'path')), native)
  refilled(userDirectory, asset, native, info, keep)
}

/** `_asset_delete_route` — always rewrites the file, even when nothing matched. */
export function assetDeleteRoute(userDirectory: string, assetId: string): MediaResult {
  // Re-read immediately before applying the change, same reasoning as
  // assetImportRoute: nothing awaits between this read and the write below,
  // but reloading here (rather than reusing an earlier read) keeps the two
  // writers to this file to the same "read fresh, then write" discipline.
  const assets = loadAssets(userDirectory)
  const kept = records(assets).filter((a: Json) => field(a, 'id') !== assetId)
  saveAssets(userDirectory, kept)
  return { status: 200, body: { ok: true } }
}

// ------------------------------------------------------------------ thumbnails

/** `_thumb_cache_dir()` — user/timeline_thumbs, created on first use. */
export function thumbCacheDir(userDirectory: string): string {
  const d = path.join(userDirectory, 'timeline_thumbs')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** The input-thumbnail cache name: `input_<sha1("<filename>:<int mtime>")>.png`. */
export function inputThumbName(filename: string, mtimeSeconds: number): string {
  const key = createHash('sha1').update(`${filename}:${Math.trunc(mtimeSeconds)}`, 'utf8').digest('hex')
  return `input_${key}.png`
}

/** `<asset_id>.<count>.json` */
export function assetThumbsName(assetId: string, count: number): string {
  return `${assetId}.${count}.json`
}

/** `wave_<asset_id>.<buckets>.json` */
export function waveformName(assetId: string, buckets: number): string {
  return `wave_${assetId}.${buckets}.json`
}

/**
 * `_gen_thumbnails` for an image: one PNG, 48 px high, width rounded half-even
 * from the aspect, RGB (alpha dropped), bilinear. Null where the Python
 * returned [] (an unreadable image).
 */
export async function imageThumbnailPng(file: string): Promise<Buffer | null> {
  try {
    const meta = await sharp(file).metadata()
    const w = meta.width
    const h = meta.pageHeight ?? meta.height
    if (!w || !h) return null
    const tw = Math.max(1, pyRound(w * THUMB_HEIGHT_PX / h))
    return await sharp(file)
      .removeAlpha()
      .toColourspace('srgb')
      .resize(tw, THUMB_HEIGHT_PX, { fit: 'fill', kernel: 'linear' })
      .png({ compressionLevel: 9 })
      .toBuffer()
  }
  catch {
    return null
  }
}

/** A cache file name built from a request value must stay inside the cache folder. */
function cacheFile(dir: string, name: string): string | null {
  if (name.includes('/') || name.includes('\\')) return null
  const full = resolveInside(dir, name)
  return full && path.dirname(full) === path.resolve(dir) ? full : null
}

function readJsonFile(file: string | null): { ok: true, value: Json } | { ok: false } {
  if (!file || !fs.existsSync(file)) return { ok: false }
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) } }
  catch { return { ok: false } }
}

const EMPTY_404: MediaResult = { status: 404, body: '', text: true }

/**
 * `_input_thumbnail_route`. A non-image file is rendered by the media tools
 * (`native`) when they are ready (a sound, or a file they can't read, 404s as
 * in Python), else by `engine` (PyAV); null = not reachable.
 */
export async function inputThumbnailRoute(
  userDirectory: string,
  inputDirRaw: string,
  filename: string,
  engine: () => Promise<MediaResult | null>,
  native: NativeMedia | null = null,
): Promise<MediaResult> {
  const inputDir = path.resolve(inputDirRaw)
  const p = path.resolve(inputDir, filename)
  if (!filename || !p.startsWith(inputDir + path.sep) || !statOrNull(p)?.isFile()) return EMPTY_404

  const st = fs.statSync(p, { bigint: true })
  const cachePng = path.join(thumbCacheDir(userDirectory), inputThumbName(filename, pyMtime(st)))
  if (!fs.existsSync(cachePng)) {
    if (!isImageFile(p) && !native) return (await engine()) ?? MEDIA_UNAVAILABLE
    const png = isImageFile(p) ? await imageThumbnailPng(p) : (await native!.thumbnails(p, 1)).pngs[0] ?? null
    if (!png) return EMPTY_404
    try { writeFileAtomic(cachePng, png) }
    catch { return EMPTY_404 }
  }
  return {
    status: 200,
    body: fs.readFileSync(cachePng),
    headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' },
  }
}

/** `_asset_thumbs_route`. A video goes to the media tools (`native`) when ready, else to `engine`. */
export async function assetThumbnailsRoute(
  userDirectory: string,
  query: URLSearchParams,
  engine: () => Promise<MediaResult | null>,
  native: NativeMedia | null = null,
): Promise<MediaResult> {
  const assetId = query.get('asset_id')
  const parsed = pyInt(query.get('count') ?? '5')
  const count = parsed === null ? 5 : Math.max(1, Math.min(20, parsed))
  if (!assetId) return { status: 400, body: { error: 'missing asset_id' } }

  const file = cacheFile(thumbCacheDir(userDirectory), assetThumbsName(assetId, count))
  const cached = readJsonFile(file)
  if (cached.ok) return { status: 200, body: cached.value }

  const asset = findAsset(loadAssets(userDirectory), assetId)
  if (!asset) return { status: 404, body: { error: 'asset not found' } }

  const assetPath = String(field(asset, 'path'))
  await probeMarkedAgain(userDirectory, asset, native)
  let pngs: Buffer[]
  let keep = true
  if (isImageFile(assetPath)) {
    const png = await imageThumbnailPng(assetPath)
    pngs = png ? [png] : []
  }
  else if (native) {
    const r = await native.thumbnails(assetPath, count)
    pngs = r.pngs
    keep = r.cache
  }
  else return (await engine()) ?? MEDIA_UNAVAILABLE
  const thumbs = pngs.map(png => `data:image/png;base64,${png.toString('base64')}`)
  const payload = { thumbnails: thumbs, asset_id: assetId, count }
  if (file && keep) {
    try { writeFileAtomic(file, pyDumps(payload)) }
    catch {}
  }
  return { status: 200, body: payload }
}

/**
 * The waveform cache file: `json.dump({"peaks": [...], "asset_id": ..., "buckets": n})`,
 * each peak a Python float (`0.0`, `1.0` keep their point).
 */
export function waveformJson(p: { peaks: number[], asset_id: string, buckets: number }): string {
  return pyJsonDumps({ obj: [
    ['peaks', p.peaks.map(x => ({ float: x }))],
    ['asset_id', p.asset_id],
    ['buckets', { int: String(p.buckets) }],
  ] })
}

/** `_asset_waveform_route` — peaks from the media tools (`native`) when ready, else from `engine`. */
export async function assetWaveformRoute(
  userDirectory: string,
  query: URLSearchParams,
  engine: () => Promise<MediaResult | null>,
  native: NativeMedia | null = null,
): Promise<MediaResult> {
  const assetId = query.get('asset_id')
  const parsed = pyInt(query.get('buckets') ?? '256')
  const buckets = parsed === null ? 256 : Math.max(16, Math.min(2048, parsed))
  if (!assetId) return { status: 400, body: { error: 'missing asset_id' } }

  const file = cacheFile(thumbCacheDir(userDirectory), waveformName(assetId, buckets))
  const cached = readJsonFile(file)
  if (cached.ok) return { status: 200, body: cached.value }

  const asset = findAsset(loadAssets(userDirectory), assetId)
  if (!asset) return { status: 404, body: { error: 'asset not found' } }
  if (!native) return (await engine()) ?? MEDIA_UNAVAILABLE
  await probeMarkedAgain(userDirectory, asset, native)
  const r = await native.waveform(String(field(asset, 'path')), buckets)
  const payload = { peaks: r.peaks, asset_id: assetId, buckets }
  if (file && r.cache) {
    try { writeFileAtomic(file, waveformJson(payload)) }
    catch {}
  }
  return { status: 200, body: payload }
}

// ------------------------------------------------------------------ the table

/** The media paths served natively (exact paths; anything below them is aiohttp's 404). */
export const MEDIA_PREFIXES = [
  '/sailor/output_listing',
  '/sailor/input_listing',
  '/sailor/input_file',
  '/sailor/output_file',
  '/sailor/assets',
  '/sailor/asset_import',
  '/sailor/input_thumbnail',
  '/sailor/asset_thumbnails',
  '/sailor/asset_waveform',
]

export type MediaHandler =
  | { name: 'outputListing' | 'inputListing' | 'inputFileDelete' | 'outputFileDelete' | 'assetsList' | 'assetImport' | 'inputThumbnail' | 'assetThumbnails' | 'assetWaveform' }
  | { name: 'assetDelete', assetId: string }

export type MediaMatch = { kind: 'route', handler: MediaHandler } | { kind: 'notFound' } | { kind: 'badMethod' }

/** The aiohttp route table for the media paths. HEAD is served as GET. */
export function matchMediaRoute(p: string, method: string, decodeSegment: (s: string) => string): MediaMatch {
  const verb = method === 'HEAD' ? 'GET' : method
  const only = (want: string, handler: MediaHandler): MediaMatch =>
    verb === want ? { kind: 'route', handler } : { kind: 'badMethod' }
  switch (p) {
    case '/sailor/output_listing': return only('GET', { name: 'outputListing' })
    case '/sailor/input_listing': return only('GET', { name: 'inputListing' })
    case '/sailor/input_file': return only('DELETE', { name: 'inputFileDelete' })
    case '/sailor/output_file': return only('DELETE', { name: 'outputFileDelete' })
    case '/sailor/assets': return only('GET', { name: 'assetsList' })
    case '/sailor/asset_import': return only('POST', { name: 'assetImport' })
    case '/sailor/input_thumbnail': return only('GET', { name: 'inputThumbnail' })
    case '/sailor/asset_thumbnails': return only('GET', { name: 'assetThumbnails' })
    case '/sailor/asset_waveform': return only('GET', { name: 'assetWaveform' })
  }
  if (p.startsWith('/sailor/assets/')) {
    // aiohttp matches `{asset_id}` = `[^{}/]+` against the decoded path (an encoded `/` stays `%2F`).
    const seg = p.slice('/sailor/assets/'.length)
    const id = decodeSegment(seg)
    if (!seg || seg.includes('/') || /[{}]/.test(id)) return { kind: 'notFound' }
    return only('DELETE', { name: 'assetDelete', assetId: id })
  }
  return { kind: 'notFound' }
}

export interface MediaContext {
  userDir: string
  inputDir: string
  outputDir: string
}

export function mediaContext(): MediaContext | null {
  const user = engineFolder('user')
  const input = engineFolder('input')
  const output = engineFolder('output')
  return user && input && output ? { userDir: user, inputDir: input, outputDir: output } : null
}

/** Serve one matched media route. `body` is the request body, parsed and as sent (asset_import only). */
export async function runMediaRoute(ctx: MediaContext, h: MediaHandler, event: H3Event, _canonicalPath: string, body?: { value: unknown, raw: Buffer }): Promise<MediaResult> {
  const q = event.path.indexOf('?')
  const query = new URLSearchParams(q === -1 ? '' : event.path.slice(q + 1))
  // No engine to ask (R10.9 for hosted; step 4, C5 everywhere): a thumbnail or waveform the media tools can't
  // make is refused in plain words; an import is recorded without its length and size.
  const engine = async () => MEDIA_UNAVAILABLE
  const engineForImport = async () => null
  // R5.6 (no family, ruling l): the four video/sound routes read with Sailor's own tools once they're ready.
  const reads = h.name === 'assetImport' || h.name === 'inputThumbnail' || h.name === 'assetThumbnails' || h.name === 'assetWaveform'
  const native = reads ? await nativeMediaFor(ctx, event) : null
  switch (h.name) {
    case 'outputListing': return outputListing(ctx.outputDir)
    case 'inputListing': return inputListing(ctx.inputDir)
    case 'inputFileDelete': return deleteFile(ctx.inputDir, '', query.get('filename') ?? '')
    case 'outputFileDelete': return deleteFile(ctx.outputDir, query.get('subfolder') ?? '', query.get('filename') ?? '')
    case 'assetsList': return assetsListRoute(ctx.userDir)
    case 'assetImport': return assetImportRoute(ctx.userDir, ctx.inputDir, body?.value, engineForImport, native)
    case 'assetDelete': return assetDeleteRoute(ctx.userDir, h.assetId)
    case 'inputThumbnail': return inputThumbnailRoute(ctx.userDir, ctx.inputDir, query.get('filename') ?? '', engine, native)
    case 'assetThumbnails': return assetThumbnailsRoute(ctx.userDir, query, engine, native)
    case 'assetWaveform': return assetWaveformRoute(ctx.userDir, query, engine, native)
  }
}

/**
 * The media tools' reader for these routes, or null when the tools are
 * missing (or switched off: NUXT_MEDIA_TOOLS=off). Locally a file may be
 * anywhere (Python opens any asset path); hosted, only inside the input folder
 * (the gate has already checked it is the person's own).
 */
async function nativeMediaFor(ctx: MediaContext, event: H3Event): Promise<NativeMedia | null> {
  if (!(await mediaTools())) return null
  let nativeMedia: typeof import('../media/thumbnails').nativeMedia
  try {
    // Loaded here, not at the top: the media module reaches the gate's modules, which import this one.
    ({ nativeMedia } = await import('../media/thumbnails'))
  }
  catch (e) {
    // As without the tools: 503 in plain words (R5.6 fix round 1).
    console.error('[media] media.route.unavailable: the media module failed to load', e)
    return null
  }
  const userId = (event.context as { userId?: unknown } | undefined)?.userId
  return nativeMedia({ roots: isHosted() ? [ctx.inputDir] : ['/'], userId: typeof userId === 'string' ? userId : null, signal: requestClosed(event) })
}

/**
 * Aborted when the person leaves before the answer is sent (the response
 * closes unfinished): their route jobs, waiting or running, stop (R5.6 fix
 * round 1). Undefined without a Node response (tests' plain events).
 */
export function requestClosed(event: H3Event): AbortSignal | undefined {
  const res = (event as { node?: { res?: { once?: unknown, writableEnded?: boolean } } }).node?.res
  if (!res || typeof res.once !== 'function') return undefined
  const ac = new AbortController()
  ;(res as { once(ev: string, fn: () => void): void }).once('close', () => {
    if (!res.writableEnded) ac.abort()
  })
  return ac.signal
}
