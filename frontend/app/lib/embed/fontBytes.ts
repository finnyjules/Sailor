/**
 * Font byte helpers shared by every embed export path (Space Type, Frame). No Vue imports —
 * this module travels wherever an export builder needs raw font bytes turned into base64, or
 * base64 turned into a text-subsetted face.
 */

/** Base64-encode an ArrayBuffer without blowing the call stack on a ~200KB font file
 *  (String.fromCharCode(...bytes) spread would stack-overflow on the full array). */
export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * POST a font (base64) + the piece's text to the ComfyUI-side `/sailor/font_subset`
 * route (comfy_extras/nodes_timeline.py's subset_font_bytes) and return the
 * subsetted font as base64. Subsets to `text`'s characters UNION the full basic-Latin
 * range — see that route's docstring and
 * docs/superpowers/plans/2026-08-04-embed-font-subsetting.md for why basic Latin is
 * kept even for text that doesn't use it (so the export doesn't foreclose rendering
 * text it wasn't built with, if it's ever wired to something dynamic).
 *
 * Returns null on ANY failure — network error, non-200, or a malformed body — and
 * NEVER throws: subsetting is a size optimization, not a correctness requirement, and
 * the caller falls back to the full font on null. Every failure path logs via
 * console.error first, though: a silent fallback here would leave someone staring at
 * a 296 KB export with no way to find out why it isn't ~40 KB.
 */
export async function subsetFontBase64(fontB64: string, text: string, logTag = '[embed]'): Promise<string | null> {
  let res: Response
  try {
    res = await fetch('/sailor/font_subset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ font: fontB64, text }),
    })
  } catch (e) {
    console.error(`${logTag} font subset request failed, falling back to the full font`, e)
    return null
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`${logTag} font subset returned HTTP ${res.status}, falling back to the full font`, body)
    return null
  }
  let data: any
  try {
    data = await res.json()
  } catch (e) {
    console.error(`${logTag} font subset response was not valid JSON, falling back to the full font`, e)
    return null
  }
  if (!data || typeof data.font !== 'string' || !data.font) {
    console.error(`${logTag} font subset response missing "font", falling back to the full font`, data)
    return null
  }
  return data.font
}
