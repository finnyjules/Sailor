/**
 * The library catalog, PURE — manifest lookups and nothing else. No resolver
 * installs, no imports beyond the static JSON and its types.
 *
 * Split out of `library-fonts.ts` because that file installs itself into two
 * resolver hooks at import time, and one of them lives in
 * `~/lib/scene3d/outlines` — which imports three.js. `fontToken.ts` needs only
 * `resolveLibraryFace`/`libraryFontUrl`, but importing them from the old module
 * dragged three (and the whole 3D outline stack) into `config.ts` and therefore
 * into the node, the baker, the agent adapter and every headless bake. Anything
 * that just wants to LOOK UP a face imports this module; only the app's startup
 * plugin needs the registering one.
 */
import manifest from './library-fonts.manifest.json'
import type { LibraryManifest, LibraryFamily, LibraryFace, LibraryFoundry } from '~~/shared/library-fonts'

export type { LibraryManifest, LibraryFamily, LibraryFace, LibraryFoundry }

export const LIBRARY_FONTS = manifest as unknown as LibraryManifest

const byFamily = new Map<string, LibraryFamily>(LIBRARY_FONTS.families.map(f => [f.family, f]))

export const FEATURED_FOUNDRY_ID = 'bram-naus'

export function librariesByFoundry(): { foundry: LibraryFoundry; families: LibraryFamily[] }[] {
  return LIBRARY_FONTS.foundries.map(foundry => ({
    foundry,
    families: LIBRARY_FONTS.families.filter(f => f.foundry === foundry.id),
  }))
}

/**
 * Search filter over the library catalog, grouped by foundry — pure, no DOM/network.
 * Shared by every library-font picker (FontPicker's Pangram tab first, more to follow)
 * so the "narrow families by substring, drop empty foundry groups" rule lives in one
 * place instead of being re-typed per component. Excludes the Featured foundry — the
 * Pangram tab stays licensed-only; Featured families surface via `featuredFamilies`.
 */
export function filterLibraryGroups(query: string): { foundry: LibraryFoundry; families: LibraryFamily[] }[] {
  const q = query.trim().toLowerCase()
  return librariesByFoundry()
    .filter(g => g.foundry.id !== FEATURED_FOUNDRY_ID)
    .map(g => ({
      foundry: g.foundry,
      families: q ? g.families.filter(f => f.family.toLowerCase().includes(q)) : g.families,
    }))
    .filter(g => g.families.length)
}

/** Featured (curated free) families, filtered by name and ordered by curation number. */
export function featuredFamilies(query: string): LibraryFamily[] {
  const q = query.trim().toLowerCase()
  return LIBRARY_FONTS.families
    .filter(f => f.foundry === FEATURED_FOUNDRY_ID)
    .filter(f => (q ? f.family.toLowerCase().includes(q) : true))
    .sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || a.family.localeCompare(b.family))
}

export function libraryFamily(family: string): LibraryFamily | null {
  return byFamily.get(family) ?? null
}

export function libraryFontUrl(faceId: string): string {
  return `/api/library-font/${encodeURIComponent(faceId)}`
}

/**
 * Nearest face for family + weight. When `italic` is specified, only faces of
 * that slant are considered; if none exist, falls back to the other slant so a
 * family that ships italics-only still resolves. Nearest weight by abs distance.
 */
export function resolveLibraryFace(family: string, weight = 400, italic?: boolean): LibraryFace | null {
  const fam = byFamily.get(family)
  if (!fam || !fam.faces.length) return null
  let pool = fam.faces
  if (italic !== undefined) {
    const slant = fam.faces.filter(f => f.italic === italic)
    pool = slant.length ? slant : fam.faces
  }
  return pool.reduce((best, f) =>
    Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best, pool[0]!)
}

/** Build a `local:` outline token. Weight/italic omitted → nearest resolves later. */
export function libraryToken(family: string, weight?: number, italic?: boolean): string {
  let t = `local:${family}`
  if (weight !== undefined) t += `@${weight}${italic ? 'i' : ''}`
  return t
}
