/**
 * POST /sailor/font_subset, served by Sailor instead of ComfyUI — a port of
 * `_font_subset_route` (comfy_extras/nodes_timeline.py:1853).
 *
 * Request `{ font: "<base64>", text: "<the piece's text>" }`, response
 * `{ font: "<base64>", before: <bytes in>, after: <bytes out> }`, with the
 * Python's own 400s for a missing, oversized, undecodable or unreadable font.
 *
 * The font is cut to `text`'s characters UNION basic Latin (U+0020..U+007E),
 * every GSUB/GPOS feature kept (the Python's `layout_features = ["*"]`),
 * hinting kept, same container as the input (ttf/otf/woff/woff2 in, the same
 * out). The cutter is `subset-font` (harfbuzz's hb-subset in WebAssembly), the
 * maintained equivalent of fontTools' subsetter: it keeps cmap, name, OS/2 and
 * post, so the result is a font a browser accepts, not fontkit's PDF-embedding
 * subset. fontkit still parses the input first, so bytes that are not a font
 * (or a collection, which fontTools also refuses) get a 400.
 *
 * Subsetting is a size optimisation: if harfbuzz cannot cut a font that parses
 * (an exotic table), the route answers the whole font rather than an error,
 * and the export (which falls back to the full font anyway) is unaffected.
 */
/// <reference path="../../app/lib/vectortype/fontkit.d.ts" />
import * as fontkit from 'fontkit'
import subsetFont from 'subset-font'

export interface SubsetResult {
  status: number
  body: unknown
}

/** `MAX_FONT_SUBSET_BYTES` */
export const MAX_FONT_SUBSET_BYTES = 20 * 1024 * 1024

/** `_BASIC_LATIN_CODEPOINTS`: space .. tilde, always kept. */
const BASIC_LATIN = Array.from({ length: 0x7F - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i)).join('')

/** `base64.b64decode(s, validate=True)` — strict: base64 alphabet only, exact padding. */
export function strictB64Decode(s: string): Buffer {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(s)) throw new Error('string argument should contain only ASCII characters')
  if (s.startsWith('=')) throw new Error('Leading padding not allowed')
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('Only base64 data is allowed')
  const firstPad = s.indexOf('=')
  if (firstPad !== -1 && /[^=]/.test(s.slice(firstPad))) throw new Error('Discontinuous padding not allowed')
  const data = firstPad === -1 ? s.length : firstPad
  const pads = s.length - data
  if (data % 4 === 1) {
    throw new Error(`Invalid base64-encoded string: number of data characters (${data}) cannot be 1 more than a multiple of 4`)
  }
  const needed = (4 - (data % 4)) % 4
  if (pads < needed) throw new Error('Incorrect padding')
  if (pads > needed) throw new Error('Excess padding not allowed')
  return Buffer.from(s, 'base64')
}

/** `subset_font_bytes`: the checks (empty, oversized, not a font), then the cut. */
export async function subsetFontBytes(fontBytes: Buffer, text: string): Promise<Buffer> {
  if (!fontBytes.length) throw new Error('subset_font_bytes: no font bytes given')
  if (fontBytes.length > MAX_FONT_SUBSET_BYTES) {
    throw new Error(`subset_font_bytes: font is ${fontBytes.length} bytes, over the ${MAX_FONT_SUBSET_BYTES}-byte cap`)
  }
  const font = fontkit.create(fontBytes) as any
  // fontTools' TTFont refuses a collection without a font number.
  if (Array.isArray(font?.fonts)) throw new Error('specify a font number between 0 and ' + (font.fonts.length - 1) + ' (inclusive)')
  try {
    return Buffer.from(await subsetFont(fontBytes, BASIC_LATIN + text))
  }
  catch (e) {
    console.warn('[font_subset] could not cut this font, answering it whole:', e instanceof Error ? e.message : e)
    return fontBytes
  }
}

/** `_font_subset_route`, given the parsed JSON body. A non-object body is aiohttp's 500 (the caller's guard). */
export async function fontSubsetRoute(data: unknown): Promise<SubsetResult> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('\'data\' has no attribute \'get\'')
  const body = data as Record<string, unknown>
  const fontB64 = body.font
  if (!fontB64 || typeof fontB64 !== 'string') return { status: 400, body: { error: 'missing \'font\'' } }
  if (fontB64.length > MAX_FONT_SUBSET_BYTES * 2) return { status: 400, body: { error: 'font is too large' } }

  const text = typeof body.text === 'string' ? body.text : ''

  let fontBytes: Buffer
  try { fontBytes = strictB64Decode(fontB64) }
  catch (e) { return { status: 400, body: { error: `undecodable font: ${(e as Error).message}` } } }

  let out: Buffer
  try { out = await subsetFontBytes(fontBytes, text) }
  catch (e) { return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } } }

  return { status: 200, body: { font: out.toString('base64'), before: fontBytes.length, after: out.length } }
}
