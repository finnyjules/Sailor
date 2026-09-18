import { join, resolve, sep } from 'node:path'
import manifest from '~~/app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '~~/shared/library-fonts'

const m = manifest as unknown as LibraryManifest

/** Face id → relative src, built once. */
const srcById = new Map<string, string>(
  m.families.flatMap(f => f.faces.map(face => [face.id, face.src] as const)),
)

export function libraryManifest(): LibraryManifest { return m }

/**
 * Absolute path for a face id under `fontsRoot`, or null if the id is unknown
 * or the resolved path escapes the root (defence in depth — ids come from the
 * manifest, but never trust the join).
 */
export function resolveLibraryFontPath(id: string, fontsRoot: string): string | null {
  const src = srcById.get(id)
  if (!src) return null
  const rootAbs = resolve(fontsRoot)
  const full = resolve(join(rootAbs, src))
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null
  return full
}

/** Repo-root Assets/Fonts, overridable for other machines. */
export function libraryFontsRoot(): string {
  return process.env.SAILOR_FONTS_ROOT || resolve(process.cwd(), '..', m.fontsRoot)
}

/**
 * Resolve a family (+ optional weight/italic) to an on-disk OTF path via the
 * manifest. Server-side mirror of the client's `resolveLibraryFace` (same
 * nearest-weight-honouring-slant logic in app/data/library-fonts.ts) — used
 * by the satori template renderer so library families don't fall through to
 * a Google-fonts lookup that 404s.
 */
export function resolveLibraryFaceByFamily(
  family: string,
  weight = 400,
  italic = false,
  fontsRoot = libraryFontsRoot(),
): { path: string; weight: number; italic: boolean } | null {
  const fam = m.families.find(f => f.family === family)
  if (!fam || !fam.faces.length) return null
  const slant = fam.faces.filter(f => f.italic === italic)
  const pool = slant.length ? slant : fam.faces
  const face = pool.reduce((best, f) =>
    Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best, pool[0]!)
  const path = resolveLibraryFontPath(face.id, fontsRoot)
  if (!path) return null
  return { path, weight: face.weight, italic: face.italic }
}
