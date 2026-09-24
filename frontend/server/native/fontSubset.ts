/**
 * POST /sailor/font_subset, served by Sailor instead of ComfyUI — a port of
 * `_font_subset_route` (comfy_extras/nodes_timeline.py:1853).
 *
 * Request `{ font: "<base64>", text: "<the piece's text>" }`, response
 * `{ font: "<base64>", before: <bytes in>, after: <bytes out> }`, with the
 * Python's own 400s for a missing, oversized, undecodable or unreadable font.
 *
 * The answer's font is the ORIGINAL font, unsubsetted, for every font kind.
 * The Python subsets with fontTools, which keeps cmap, name, OS/2, post and
 * every GSUB/GPOS feature. fontkit's `createSubset()` cannot stand in for it:
 *
 *   - TrueType outlines (TTFSubset) come back as a PDF-embedding font with
 *     only head/hhea/loca/maxp/cvt/prep/glyf/hmtx/fpgm — no cmap (so no
 *     character maps to any glyph), no name/OS/2/post (browsers reject the
 *     font), and no GSUB/GPOS/kern (kerning and ligatures gone);
 *   - CFF outlines (CFFSubset) come back as a bare CFF table, not a font
 *     file at all.
 *
 * Neither contains the requested characters in a form a browser can use, and
 * the export inlines this font into a web page. The route is a size
 * optimisation, not a correctness requirement (the export falls back to the
 * full font on any failure), so the safe answer is the full font: `before`
 * equals `after`. fontkit still parses the font, so bytes that are not a font
 * get the same 400 the Python gives.
 *
 * So the route (smallRoutes.ts) runs these checks, then hands a good font to
 * the local engine while it is running — real subsetting, exactly as before —
 * and answers with this whole font only when the engine is not there.
 */
/// <reference path="../../app/lib/vectortype/fontkit.d.ts" />
import * as fontkit from 'fontkit'

export interface SubsetResult {
  status: number
  body: unknown
}

/** `MAX_FONT_SUBSET_BYTES` */
export const MAX_FONT_SUBSET_BYTES = 20 * 1024 * 1024

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

/**
 * `subset_font_bytes`'s checks (empty, oversized, not a font), then the font
 * itself — see the header for why nothing is cut. `text` is accepted and
 * unused: every character of it is in the answer because the whole font is.
 */
export function subsetFontBytes(fontBytes: Buffer, _text: string): Buffer {
  if (!fontBytes.length) throw new Error('subset_font_bytes: no font bytes given')
  if (fontBytes.length > MAX_FONT_SUBSET_BYTES) {
    throw new Error(`subset_font_bytes: font is ${fontBytes.length} bytes, over the ${MAX_FONT_SUBSET_BYTES}-byte cap`)
  }
  const font = fontkit.create(fontBytes) as any
  // fontTools' TTFont refuses a collection without a font number.
  if (Array.isArray(font?.fonts)) throw new Error('specify a font number between 0 and ' + (font.fonts.length - 1) + ' (inclusive)')
  return fontBytes
}

/** `_font_subset_route`, given the parsed JSON body. A non-object body is aiohttp's 500 (the caller's guard). */
export function fontSubsetRoute(data: unknown): SubsetResult {
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
  try { out = subsetFontBytes(fontBytes, text) }
  catch (e) { return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } } }

  return { status: 200, body: { font: out.toString('base64'), before: fontBytes.length, after: out.length } }
}
