import type { H3Event } from 'h3'
import { createError, readFormData } from 'h3'

export interface UploadedFile {
  /** Raw bytes of the uploaded part. */
  data: Buffer
  /** Client-supplied filename, if the part carried one. */
  filename?: string
  /** Client-supplied content type, if the part carried one. */
  type?: string
}

export interface UploadForm {
  /** Bytes of a file field, or null if absent/empty/not-a-file. */
  file(field: string): Promise<UploadedFile | null>
  /** Every file part under a field, in order, skipping empty/non-file parts. */
  files(field: string): Promise<UploadedFile[]>
  /** Trimmed value of a text field, or '' if absent. */
  text(field: string): string
  /** Every part name, in body order, duplicates included. */
  names(): string[]
  /** Every TEXT part as [name, value], in body order, duplicates included. */
  textEntries(): [string, string][]
}

function wrapFormData(form: FormData): UploadForm {
  return {
    async file(field) {
      const part = form.get(field)
      if (!part || typeof part === 'string') return null

      const data = Buffer.from(await part.arrayBuffer())
      if (data.byteLength === 0) return null

      // `File` carries name/type; a bare `Blob` part leaves them blank.
      return {
        data,
        filename: (part as File).name || undefined,
        type: part.type || undefined,
      }
    },
    async files(field) {
      const out: UploadedFile[] = []
      for (const part of form.getAll(field)) {
        if (typeof part === 'string') continue
        const data = Buffer.from(await part.arrayBuffer())
        if (data.byteLength === 0) continue
        out.push({
          data,
          filename: (part as File).name || undefined,
          type: part.type || undefined,
        })
      }
      return out
    },
    text(field) {
      const part = form.get(field)
      return typeof part === 'string' ? part.trim() : ''
    },
    names() {
      return Array.from(form.keys())
    },
    textEntries() {
      const out: [string, string][] = []
      for (const [name, value] of form.entries()) {
        if (typeof value === 'string') out.push([name, value])
      }
      return out
    },
  }
}

/**
 * Read a multipart/form-data request body.
 *
 * Deliberately NOT h3's readMultipartFormData: that one parses the body a byte
 * at a time into a plain JS array (`buffer.push(currByte)`), and V8 caps a
 * fast-elements array at 2^26 entries — so every upload over 64 MiB died with
 * "RangeError: Invalid array length" before the route ever ran, and everything
 * under it still cost ~8 bytes of heap per byte of file. readFormData hands the
 * body to undici's native parser instead, which streams and has no such cap.
 *
 * The body can only be consumed once, so call this once per request and pull
 * every field off the returned form.
 */
export async function readUploadForm(event: H3Event): Promise<UploadForm> {
  let form: FormData
  try {
    form = await readFormData(event)
  }
  catch {
    // A body that isn't form data is the caller's mistake, not a server fault.
    throw createError({ statusCode: 400, statusMessage: 'Expected multipart form data' })
  }
  return wrapFormData(form)
}

/**
 * The same parse, for a body that has ALREADY been buffered.
 *
 * The hosted upload gate (server/utils/engineGate.ts) must read the raw bytes
 * before it can forward them unchanged, and a request body can only be consumed
 * once — so it cannot also call readUploadForm. This runs the identical undici
 * parser over the buffer it holds, so the gate's reading of a body and the rest
 * of the app's agree by construction.
 *
 * Which non-canonical Content-Disposition spellings undici refuses depends on
 * the Node version (Node 26's undici 8 accepts `name= "x"`, `name*=…`, `NAME=`
 * and unquoted values), so a caller that must agree with ANOTHER parser runs
 * assertCanonicalMultipart over the same bytes first; see LC3 and the R1 table
 * in tests/unit/engine-upload-ownership.unit.spec.ts.
 */
export async function parseUploadForm(body: Uint8Array, contentType: string): Promise<UploadForm> {
  let form: FormData
  try {
    form = await new Response(body as unknown as BodyInit, {
      headers: { 'content-type': contentType },
    }).formData()
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Expected multipart form data' })
  }
  return wrapFormData(form)
}

/**
 * The one Content-Disposition shape every real client sends: browsers,
 * undici's own FormData encoder, Python requests/aiohttp and curl all write
 * `form-data; name="x"` with an optional `; filename="y"`, single space after
 * each `;`, `=` touching both sides, a plain quoted value.
 */
const CANONICAL_DISPOSITION = /^form-data; name="([^"\\\r\n]*)"(?:; filename="([^"\r\n]*)")?$/

/** The multipart boundary from a Content-Type header, or null. */
function boundaryOf(contentType: string): string | null {
  const [type, ...params] = contentType.split(';')
  if (type?.trim().toLowerCase() !== 'multipart/form-data') return null
  let found: string | null = null
  for (const p of params) {
    const eq = p.indexOf('=')
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'boundary') continue
    if (found !== null) return null // two boundaries: which one each parser takes is a guess
    let v = p.slice(eq + 1).trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    found = v
  }
  return found && found.length <= 70 ? found : null
}

/**
 * Refuse a multipart body unless every part's headers are in the canonical
 * shape above (LC3).
 *
 * The hosted upload gate decides ownership from the field names it parses, so
 * its security cannot rest on WHICH Content-Disposition spellings the parser of
 * the day happens to reject. It used to: Node's bundled undici refused
 * `name= "x"` and `name*=utf-8''x`, which made "undici fails ⇒ 400" a complete
 * defence. Node 26 (undici 8) accepts both, plus duplicate `name` parameters
 * (last one wins) — while aiohttp and other lax parsers resolve the same bytes
 * their own way. So the rule is now ours and version-independent: anything but
 * the canonical shape is a body two parsers could read differently, and is
 * refused with a 400.
 *
 * Deliberately a SUPERSET scan: every occurrence of `--boundary` starts a
 * segment that is checked, whether or not a given parser would treat it as a
 * part, and a header block with a bare CR or LF (which a line-reader that
 * splits on `\n` would see as extra header lines) is refused outright. A
 * backslash in a part NAME is refused too: aiohttp un-escapes it and undici
 * does not. Filenames keep theirs — browsers and undici send `a\b.png` raw,
 * and the gate and the native writer read the filename from the same parse;
 * a backslash before a closing quote cannot smuggle a parameter, because
 * anything after the filename's first `"` breaks the shape.
 */
export function assertCanonicalMultipart(body: Uint8Array, contentType: string): void {
  const refuse = (): never => {
    throw createError({ statusCode: 400, statusMessage: 'Expected multipart form data' })
  }
  const boundary = boundaryOf(contentType)
  if (!boundary) refuse()
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1')
  const segments = text.split(`--${boundary}`)
  if (segments.length < 2) refuse()
  for (const segment of segments.slice(1)) {
    // The close delimiter `--boundary--`; whatever follows is epilogue, but it
    // is still checked if it looks like a part (it can only contain more
    // `--boundary` occurrences, which are their own segments).
    if (segment.startsWith('--')) continue
    const end = segment.indexOf('\r\n\r\n')
    if (end < 0) refuse()
    const block = segment.slice(0, end)
    // Bare CR / bare LF inside the header block.
    if (/\r(?!\n)|(?<!\r)\n/.test(block)) refuse()
    const lines = block.split('\r\n')
    // lines[0] is the rest of the delimiter line: transport padding only.
    if (!/^[ \t]*$/.test(lines[0]!)) refuse()
    let dispositions = 0
    for (const line of lines.slice(1)) {
      // An obs-folded continuation line, or a header with no colon.
      if (/^[ \t]/.test(line) || !line.includes(':')) refuse()
      const name = line.slice(0, line.indexOf(':')).trim().toLowerCase()
      if (name !== 'content-disposition') continue
      dispositions++
      const m = /^content-disposition: (.*)$/i.exec(line)
      if (!m || !CANONICAL_DISPOSITION.test(m[1]!)) refuse()
    }
    if (dispositions !== 1) refuse()
  }
}

/** Convenience for routes whose body is a single file field. */
export async function readUploadedFile(
  event: H3Event,
  field = 'file',
): Promise<UploadedFile | null> {
  return (await readUploadForm(event)).file(field)
}
