/**
 * GET /view, served by Sailor from the engine folders instead of ComfyUI — a
 * port of `view_image` in server.py (and the aiohttp FileResponse it returns).
 *
 * Resolution, exactly as the Python does it:
 *   1. no `filename` → 404; a `blake3:` hash → 404 (the asset store is only
 *      there with `--enable-assets`, which Sailor never runs).
 *   2. a trailing `[output]` / `[input]` / `[temp]` annotation picks the folder
 *      and outranks `type` (folder_paths.annotated_filepath).
 *   3. an empty name, a leading `/` or any `..` → 400.
 *   4. otherwise `type` picks the folder (absent = output; anything but
 *      input/output/temp = 400).
 *   5. a `subfolder` that leaves the folder → 403.
 *   6. the file is `<folder>/<subfolder>/<basename(name)>`; not a file → 404.
 *
 * The bytes go out the way aiohttp's FileResponse sent them: the guessed
 * content type (Python's mimetypes table on this machine, with the same
 * download-forcing for html/js/css), `Content-Disposition: filename="…"`, an
 * ETag of `<mtime_ns hex>-<size hex>`, Last-Modified, `Accept-Ranges: bytes`,
 * single byte ranges (206 / 416) and conditional 304s.
 *
 * Not ported: `preview=` and `channel=` re-encodings (no Sailor code asks for
 * them; the plain file is served) and aiohttp's `.gz`/`.br` sidecar lookup.
 */
import fs from 'node:fs'
import path from 'node:path'
import { annotatedFilepath, engineFolder } from './paths'

/**
 * `mimetypes.guess_type` as the engine's Python answers it on the dev machine
 * (macOS system tables included), lower-cased extension → type. Anything not
 * listed was `None` there, i.e. application/octet-stream.
 */
const PY_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/x-wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.flac': 'audio/x-flac', '.m4a': 'audio/mp4a-latm', '.aac': 'audio/x-aac', '.opus': 'audio/ogg',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.obj': 'application/x-tgif', '.stl': 'application/vnd.ms-pki.stl',
  '.bin': 'application/octet-stream', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.xml': 'application/xml',
}

/** server.py: these are forced to download instead of display. */
const FORCE_DOWNLOAD = new Set(['text/html', 'text/html-sandboxed', 'application/xhtml+xml', 'text/javascript', 'text/css'])

export function viewContentType(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const type = (dot > 0 ? PY_MIME[filename.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream'
  return FORCE_DOWNLOAD.has(type) ? 'application/octet-stream' : type
}

/** `get_directory_by_type` over the native engine folders. */
function dirByType(type: string | null | undefined): string | null {
  return type === 'output' || type === 'temp' || type === 'input' ? engineFolder(type) : null
}

/** `os.path.commonpath((os.path.abspath(child), parent)) == parent` for an absolute, normalised parent. */
function staysInside(parent: string, child: string): boolean {
  const base = path.resolve(parent)
  const full = path.resolve(base, child)
  return full === base || full.startsWith(base === path.sep ? base : base + path.sep)
}

/** One value per query key, as aiohttp's `query[key]` / `.get()` (first occurrence). */
export type ViewQuery = Record<string, string | string[] | undefined>
function first(q: ViewQuery, key: string): string | undefined {
  const v = q[key]
  return Array.isArray(v) ? v[0] : v
}

export type ViewTarget =
  | { kind: 'status', status: 400 | 403 | 404 }
  | { kind: 'file', file: string, filename: string, type: string, subfolder: string }

/**
 * The file a /view query names, or the status the Python answered instead.
 * `type` and `subfolder` in the result are the folder actually used, for the
 * disk-cache fallback key.
 */
export function resolveViewTarget(query: ViewQuery): ViewTarget {
  const raw = first(query, 'filename')
  if (raw === undefined) return { kind: 'status', status: 404 }
  if (raw.startsWith('blake3:')) return { kind: 'status', status: 404 }

  const { name, type: annotated } = annotatedFilepath(raw)
  if (!name) return { kind: 'status', status: 400 }
  if (name[0] === '/' || name.includes('..')) return { kind: 'status', status: 400 }

  const type = annotated ?? (first(query, 'type') ?? 'output')
  let dir = dirByType(type)
  if (!dir) return { kind: 'status', status: 400 }

  const subfolder = first(query, 'subfolder')
  if (subfolder !== undefined) {
    if (!staysInside(dir, subfolder)) return { kind: 'status', status: 403 }
    dir = path.resolve(dir, subfolder)
  }

  const filename = pyBasename(name)
  const file = path.join(dir, filename)
  if (!filename || !isFile(file)) return { kind: 'status', status: 404 }
  return { kind: 'file', file, filename, type, subfolder: subfolder ?? '' }
}

/** `os.path.basename`: everything after the last `/` (so `a/` → ''). */
function pyBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** `os.path.isfile`: follows symlinks; any error is False. */
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() }
  catch { return false }
}

// ------------------------------------------------------------ the response

export interface ViewResponse {
  status: number
  headers: Record<string, string>
  /** Bytes to send: [start, end] inclusive, or undefined for no body. */
  range?: { start: number, end: number }
}

function httpDate(ms: number): string {
  return new Date(ms).toUTCString()
}

function parseHttpDate(v: string | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t / 1000 : null
}

/** aiohttp `_etag_match` (weak comparison for If-None-Match). */
function etagMatches(etag: string, header: string): boolean {
  const tags = header.split(',').map(s => s.trim()).filter(Boolean)
  return tags.some(t => t === '*' || t.replace(/^W\//, '') === `"${etag}"`)
}

/** aiohttp `http_range`: one `bytes=a-b`; anything else is a 416. */
function parseRange(v: string): { start: number | null, end: number | null } | 'invalid' {
  const m = /^bytes=(\d*)-(\d*)$/.exec(v)
  if (!m) return 'invalid'
  let start: number | null = m[1] ? Number(m[1]) : null
  let end: number | null = m[2] ? Number(m[2]) : null
  if (start === null && end !== null) { start = -end; end = null }
  if (start !== null && end !== null) {
    end += 1
    if (start >= end) return 'invalid'
  }
  if (start === null && end === null) return 'invalid'
  return { start, end }
}

/**
 * aiohttp FileResponse for a resolved file, given the request headers
 * (lower-cased names). Pure apart from one stat.
 */
export function viewFileResponse(target: { file: string, filename: string }, req: Record<string, string | undefined>): ViewResponse {
  const st = fs.statSync(target.file, { bigint: true })
  const size = Number(st.size)
  const mtimeSec = Number(st.mtimeNs) / 1e9
  const etag = `${st.mtimeNs.toString(16)}-${st.size.toString(16)}`
  // aiohttp's last_modified setter rounds a float mtime UP to the second.
  const lastModified = httpDate(Math.ceil(mtimeSec) * 1000)
  const base: Record<string, string> = {
    'content-disposition': `filename="${target.filename}"`,
    'content-type': viewContentType(target.filename),
  }

  const inm = req['if-none-match']
  const ims = parseHttpDate(req['if-modified-since'])
  if ((inm !== undefined && etagMatches(etag, inm)) || (inm === undefined && ims !== null && mtimeSec <= ims)) {
    return { status: 304, headers: { ...base, 'etag': `"${etag}"`, 'last-modified': lastModified } }
  }

  let status = 200
  let start = 0
  let count = size
  const ifRange = parseHttpDate(req['if-range'])
  if (req['if-range'] === undefined || (ifRange !== null && mtimeSec <= ifRange)) {
    const rangeHeader = req.range
    if (rangeHeader !== undefined) {
      const r = parseRange(rangeHeader)
      if (r === 'invalid') return { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } }
      if (r.start !== null) {
        if (r.start < 0 && r.end === null) {
          start = Math.max(0, r.start + size)
          count = size - start
        }
        else {
          start = r.start
          count = Math.min(r.end ?? size, size) - start
        }
        if (start >= size) return { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } }
        status = 206
      }
    }
  }

  const headers: Record<string, string> = {
    ...base,
    'etag': `"${etag}"`,
    'last-modified': lastModified,
    'content-length': String(count),
    'accept-ranges': 'bytes',
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${start + count - 1}/${size}`
  return { status, headers, range: count > 0 ? { start, end: start + count - 1 } : undefined }
}
