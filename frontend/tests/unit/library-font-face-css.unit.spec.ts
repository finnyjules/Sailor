import { describe, it, expect } from 'vitest'
import { familyFaceCss } from '../../app/composables/useLibraryFonts'
import type { LibraryFamily } from '../../shared/library-fonts'

const fam: LibraryFamily = {
  id: 'pangram-pp-mori', family: 'PP Mori', foundry: 'pangram',
  faces: [
    { id: 'pangram-ppmori-book', weight: 375, style: 'Book', italic: false, postscriptName: 'PPMori-Book', src: 'x/Book.otf' },
    { id: 'pangram-ppmori-bookitalic', weight: 375, style: 'Book Italic', italic: true, postscriptName: 'PPMori-BookItalic', src: 'x/BookItalic.otf' },
  ],
}

describe('familyFaceCss', () => {
  const css = familyFaceCss(fam)
  it('emits one @font-face per face, quoting the family', () => {
    expect(css.match(/@font-face/g)?.length).toBe(2)
    expect(css).toContain("font-family:'PP Mori'")
  })
  it('sets weight, style and the route url per face', () => {
    expect(css).toContain('font-weight:375')
    expect(css).toContain('font-style:italic')
    expect(css).toContain("url('/api/library-font/pangram-ppmori-book')")
    expect(css).toContain("url('/api/library-font/pangram-ppmori-bookitalic')")
  })
  it('emits an .otf face as format(opentype)', () => {
    expect(css).toContain("format('opentype')")
  })
})

describe('familyFaceCss format() by extension', () => {
  it('emits format(woff2) for a .woff2 src', () => {
    const woff2Fam: LibraryFamily = {
      id: 'bram-naus-sora', family: 'Sora', foundry: 'bram-naus',
      faces: [
        { id: 'bram-naus-sora-regular', weight: 400, style: 'Regular', italic: false, postscriptName: 'Sora-Regular', src: 'y/Sora-Regular.woff2' },
      ],
    }
    expect(familyFaceCss(woff2Fam)).toContain("format('woff2')")
  })

  it('emits format(truetype) for a .ttf src', () => {
    const ttfFam: LibraryFamily = {
      id: 'bram-naus-lexend', family: 'Lexend', foundry: 'bram-naus',
      faces: [
        { id: 'bram-naus-lexend-regular', weight: 400, style: 'Regular', italic: false, postscriptName: 'Lexend-Regular', src: 'y/Lexend-Regular.ttf' },
      ],
    }
    expect(familyFaceCss(ttfFam)).toContain("format('truetype')")
  })
})
