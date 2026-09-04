/**
 * The ONE grammar for `config.fontId`. Three shapes, because Vector Type reads
 * OUTLINES and each source hands them over differently:
 *   - a bare id is a curated variable family (`VARIABLE_FONTS_BY_ID`), served
 *     from the fonts repo path we verified by hand — the only way to get a
 *     VARIABLE file out of Google;
 *   - `google:Family@400` is ONE static cut of any Google family, through the
 *     css2 → gstatic proxy (`/api/fonts/google-file`), so it has no axes;
 *   - `local:Family@400i` is the library's own token (see
 *     `app/data/library-fonts.ts`), resolved to a face id through the manifest.
 * `google:` carries its prefix so a family name can never be mistaken for a
 * curated id, and vice versa. Anything else is invalid and the config parser
 * falls back to the default — a saved project never silently changes font.
 */
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { libraryFontUrl, resolveLibraryFace } from '~/data/library-fonts'

export const VT_GOOGLE_FILE_ROUTE = '/api/fonts/google-file'

export type VtFontRef =
  | { kind: 'catalog'; id: string }
  | { kind: 'google'; family: string; weight: number }
  | { kind: 'local'; family: string; weight?: number; italic?: boolean }

/** The proxy URL for a catalog id. Never a raw upstream URL — the server
 *  resolves the id against the catalog itself. Lives here (not `font.ts`) so
 *  `font.ts` can import `fontToken` (Task 2) without a cycle; re-exported from
 *  `font.ts` so existing imports keep working. */
export function variableFontUrl(id: string): string {
  return `/api/fonts/variable?id=${encodeURIComponent(id)}`
}

const WEIGHT_RE = /^(.+?)@(\d{3})(i?)$/

export function parseVtFontToken(token: unknown): VtFontRef | null {
  if (typeof token !== 'string' || !token) return null
  if (token.startsWith('google:')) {
    const m = WEIGHT_RE.exec(token.slice(7))
    if (!m || m[3]) return null                       // a Google cut needs an explicit weight; italic is not in scope
    return { kind: 'google', family: m[1]!, weight: Number(m[2]) }
  }
  if (token.startsWith('local:')) {
    const body = token.slice(6)
    if (!body) return null
    const m = WEIGHT_RE.exec(body)
    if (!m) return body.includes('@') ? null : { kind: 'local', family: body }
    return { kind: 'local', family: m[1]!, weight: Number(m[2]), italic: m[3] === 'i' }
  }
  return VARIABLE_FONTS_BY_ID[token] ? { kind: 'catalog', id: token } : null
}

export function formatVtFontToken(ref: VtFontRef): string {
  if (ref.kind === 'catalog') return ref.id
  if (ref.kind === 'google') return `google:${ref.family}@${ref.weight}`
  return ref.weight === undefined ? `local:${ref.family}` : `local:${ref.family}@${ref.weight}${ref.italic ? 'i' : ''}`
}

export function isVtFontToken(token: unknown): boolean { return parseVtFontToken(token) !== null }

/** The file route for a ref. Never a raw upstream URL: every shape goes through
 *  a server route that resolves an id or validates a family against a catalog. */
export function vtFontFileUrl(ref: VtFontRef): string | null {
  if (ref.kind === 'catalog') return variableFontUrl(ref.id)
  if (ref.kind === 'google') return `${VT_GOOGLE_FILE_ROUTE}?family=${encodeURIComponent(ref.family)}&weight=${ref.weight}`
  const face = resolveLibraryFace(ref.family, ref.weight ?? 400, ref.italic)
  return face ? libraryFontUrl(face.id) : null
}

export function vtFontRefLabel(ref: VtFontRef): string {
  if (ref.kind === 'catalog') return VARIABLE_FONTS_BY_ID[ref.id]?.label ?? ref.id
  if (ref.kind === 'google') return `${ref.family} ${ref.weight}`
  const face = resolveLibraryFace(ref.family, ref.weight ?? 400, ref.italic)
  return face ? `${ref.family} ${face.style}` : ref.family
}
