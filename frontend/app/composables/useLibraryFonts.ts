/**
 * CSS/DOM half of the font library: inject an @font-face per face of a family
 * so templates / Compositor / motion text render the real licensed faces.
 * Mirrors useUploadedFonts.ensure() — one <style> block per family, idempotent.
 */
import type { LibraryFamily } from '~~/shared/library-fonts'
import { libraryFamily, libraryFontUrl } from '~/data/library-fonts'

function cssEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** All @font-face rules for a family (one per face). Pure — unit-tested. */
export function familyFaceCss(fam: LibraryFamily): string {
  return fam.faces.map(face =>
    `@font-face{font-family:'${cssEscape(fam.family)}';`
    + `font-weight:${face.weight};`
    + `font-style:${face.italic ? 'italic' : 'normal'};`
    + `font-display:swap;`
    + `src:url('${libraryFontUrl(face.id)}') format('opentype')}`,
  ).join('')
}

const ensured = new Set<string>() // family ids with an injected block

function ensure(family: string | null | undefined): void {
  if (!family || typeof document === 'undefined') return
  const fam = libraryFamily(family)
  if (!fam || ensured.has(fam.id)) return
  const style = document.createElement('style')
  style.dataset.libraryFont = fam.id
  style.textContent = familyFaceCss(fam)
  document.head.appendChild(style)
  ensured.add(fam.id)
}

export function useLibraryFonts() {
  return { ensure }
}
