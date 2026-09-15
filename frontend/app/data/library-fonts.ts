/**
 * Shared client catalog over the committed font-library manifest, PLUS the
 * registration side: this module is what installs the catalog into the two
 * resolver hooks (the CSS world's family list, the outline world's face
 * resolver). The lookups themselves live in `./library-fonts-lookup` and are
 * re-exported here so existing importers keep working.
 *
 * Import the LOOKUP module, not this one, unless you actually need
 * `registerLibraryFonts`: `setLibraryFaceResolver` comes from
 * `~/lib/scene3d/outlines`, so importing this file pulls three.js into your
 * bundle even if all you wanted was a face id.
 */
import { LIBRARY_FONTS, resolveLibraryFace } from './library-fonts-lookup'
import { setLibraryFamilies } from '~/lib/font/resolveFamily'
import { setLibraryFaceResolver } from '~/lib/scene3d/outlines'

export {
  LIBRARY_FONTS,
  FEATURED_FOUNDRY_ID,
  librariesByFoundry,
  filterLibraryGroups,
  featuredFamilies,
  libraryFamily,
  libraryFontUrl,
  resolveLibraryFace,
  libraryToken,
} from './library-fonts-lookup'
export type { LibraryManifest, LibraryFamily, LibraryFace, LibraryFoundry } from './library-fonts-lookup'

/** Install this module into the two resolver hooks. Called once at startup. */
export function registerLibraryFonts(): void {
  setLibraryFamilies(LIBRARY_FONTS.families.map(f => ({
    family: f.family,
    weights: [...new Set(f.faces.map(x => x.weight))].sort((a, b) => a - b),
    axes: [], // static instances — no continuous wght axis
  })))
  setLibraryFaceResolver((family, weight, italic) => {
    const face = resolveLibraryFace(family, weight, italic)
    return face ? face.id : null
  })
}
