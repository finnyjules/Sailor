import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { SHADER_LOOK_WORDS, resolveShaderLook } from '~/lib/compositor/shaderLooks'
import { setShaderFxCatalog, effectReadsInput } from '~/lib/shaderfx/catalogStore'

/**
 * F-cap Task 2 — the compositor agent's curated shader-look vocabulary.
 *
 * Every curated look must (a) resolve (by its word AND by its effectId) and (b) name a REAL
 * catalog effect whose GLSL actually SAMPLES `u_image0` (`effectReadsInput` — the same picker-
 * eligibility gate F5/F6 use). We validate (b) against the ON-DISK catalog: the manifest is
 * source/-free, so we load each curated effect's `.frag` and hand it to the store — exactly what
 * `effectReadsInput` reads, so a typo'd or generative id fails here rather than shipping a dead
 * look. This is the "PREFER calling effectReadsInput" path (Step 0) with a real catalog behind it.
 */

// frontend/tests/unit/ → repo root is three levels up (see tests/shaderfx-golden.spec.ts).
const thisDir = fileURLToPath(new URL('.', import.meta.url))
const CATALOG_DIR = path.resolve(thisDir, '..', '..', '..', 'shader_effects')

function loadCatalog() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'manifest.json'), 'utf-8')) as {
    effects: { id: string }[]
  }
  const ids = new Set(manifest.effects.map(e => e.id))
  const effects = SHADER_LOOK_WORDS.map((l) => {
    // Guard: a curated id that is not even in the manifest is a hard error.
    expect(ids.has(l.effectId), `curated effectId "${l.effectId}" is missing from the catalog manifest`).toBe(true)
    const source = fs.readFileSync(path.join(CATALOG_DIR, `${l.effectId}.frag`), 'utf-8')
    return { id: l.effectId, name: l.word, source }
  })
  return { effects } as any
}

describe('SHADER_LOOK_WORDS (curated compositor shader looks)', () => {
  beforeAll(() => setShaderFxCatalog(loadCatalog()))

  it('has a healthy curated set (~6-8 looks) with no duplicate words or ids', () => {
    expect(SHADER_LOOK_WORDS.length).toBeGreaterThanOrEqual(6)
    expect(SHADER_LOOK_WORDS.length).toBeLessThanOrEqual(8)
    expect(new Set(SHADER_LOOK_WORDS.map(l => l.word.toLowerCase())).size).toBe(SHADER_LOOK_WORDS.length)
    expect(new Set(SHADER_LOOK_WORDS.map(l => l.effectId)).size).toBe(SHADER_LOOK_WORDS.length)
  })

  it('every curated effectId is a real INPUT-SAMPLING catalog effect (effectReadsInput true)', () => {
    for (const l of SHADER_LOOK_WORDS) {
      expect(effectReadsInput(l.effectId), `${l.word} → ${l.effectId} must sample u_image0`).toBe(true)
    }
  })

  it('resolveShaderLook maps every curated WORD to its effectId (case- and separator-insensitive)', () => {
    for (const l of SHADER_LOOK_WORDS) {
      expect(resolveShaderLook(l.word)).toBe(l.effectId)
      expect(resolveShaderLook(l.word.toUpperCase())).toBe(l.effectId)
      // spaces / underscores / hyphens are interchangeable
      expect(resolveShaderLook(l.word.replace(/ /g, '_'))).toBe(l.effectId)
      expect(resolveShaderLook(` ${l.word.replace(/ /g, '-')} `)).toBe(l.effectId)
    }
  })

  it('resolveShaderLook also accepts a curated effectId directly', () => {
    for (const l of SHADER_LOOK_WORDS) {
      expect(resolveShaderLook(l.effectId)).toBe(l.effectId)
    }
  })

  it('resolveShaderLook returns null for garbage / uncurated ids', () => {
    for (const junk of ['', '   ', 'not a real look', 'plasma', 'aurora', 'starfield', 'chromatic', '💥']) {
      expect(resolveShaderLook(junk), junk).toBeNull()
    }
    // A real catalog effect that is simply NOT in the curated set stays rejected.
    expect(resolveShaderLook('kaleidoscope')).toBeNull()
  })
})
