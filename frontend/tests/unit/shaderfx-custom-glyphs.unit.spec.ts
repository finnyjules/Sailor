/**
 * CUSTOM GLYPHS (Task 15) — `buildCustomAtlas` moved VERBATIM out of `ShaderStudioSurface.vue`
 * into `~/lib/shaderfx/customGlyphs`, so both Shader Studio and the Frame's shader path
 * (`~/lib/shaderfill/field.ts`, via the dither transition's painters) build the identical atlas
 * from the identical function. It is not unit-testable beyond its constant without a real
 * `<canvas>` (text rasterization, `getImageData`) — the two things pinned here are that
 * constant, and that the move actually happened rather than leaving a second private copy
 * behind to drift from this one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CUSTOM_CHARS as LIB_DEFAULT } from '~/lib/shaderfx/customGlyphs'
import { DEFAULT_CUSTOM_CHARS as REVEAL_DEFAULT } from '~/lib/motionx/reveal'

const SURFACE = fileURLToPath(new URL('../../app/components/vue-canvas/ShaderStudioSurface.vue', import.meta.url))

describe('DEFAULT_CUSTOM_CHARS', () => {
  it('is the same string in the DOM-heavy lib and in the DOM-free reveal barrel\'s own copy', () => {
    expect(LIB_DEFAULT).toBe(REVEAL_DEFAULT)
    expect(LIB_DEFAULT).toBe(' .:-=+*#%@')
  })
})

describe('ShaderStudioSurface.vue — the atlas builder moved out, not copied', () => {
  const src = readFileSync(SURFACE, 'utf8')

  it('imports buildCustomAtlas from the shared lib', () => {
    expect(src).toMatch(/import\s*\{\s*buildCustomAtlas\s*\}\s*from\s*'~\/lib\/shaderfx\/customGlyphs'/)
  })

  it('no longer declares its own copy of the builder or its private cache', () => {
    expect(src).not.toMatch(/function\s+buildCustomAtlas\s*\(/)
    expect(src).not.toContain('customAtlasCache')
    expect(src).not.toContain('CUSTOM_CW')
    expect(src).not.toContain('CUSTOM_COLS')
  })

  it('still calls buildCustomAtlas for the ASCII Custom shape (u_shape 14)', () => {
    expect(src).toMatch(/buildCustomAtlas\(layer\?\.customChars/)
  })
})
