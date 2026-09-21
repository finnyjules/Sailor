/**
 * bayer_dither.frag — the SHIMMER build variant.
 *
 * The Frame compositor's Assemble transition runs the Dither effect over a layer and slides
 * its threshold pattern under the blocks, so the dithered tones shimmer (Julien: "I LOVE the
 * colour shimmer"). That is a BUILD VARIANT (`#define SAILOR_SHIMMER 1`, injected by
 * renderFieldWithBase's `variant` argument, cached as its own program `bayer_dither#SHIMMER`),
 * never a Shader Studio dial: with the macro undefined the compiler sees the pre-shimmer
 * shader line for line, so the classic effect cannot change — the lesson of ascii_dither's
 * matte mode, where ANY shared-source edit shifted an undefined-behaviour render.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAG = readFileSync(resolve(HERE, '../../../shader_effects/bayer_dither.frag'), 'utf8')
const PRE = readFileSync(resolve(HERE, 'fixtures/bayer_dither.pre-shimmer.frag'), 'utf8')

/** The frag as the given build's preprocessor sees it, comments and blank lines removed. */
function build(src: string, shimmer: boolean): string[] {
  const out: string[] = []
  let mode: 'plain' | 'in' | 'else' = 'plain'
  for (const raw of src.split('\n')) {
    const t = raw.trim()
    if (t === '#ifdef SAILOR_SHIMMER') { mode = 'in'; continue }
    if (t === '#else' && mode !== 'plain') { mode = 'else'; continue }
    if (t === '#endif' && mode !== 'plain') { mode = 'plain'; continue }
    if ((mode === 'in' && !shimmer) || (mode === 'else' && shimmer)) continue
    const line = raw.replace(/\/\/.*$/, '').trimEnd()
    if (line.trim() !== '') out.push(line)
  }
  return out
}

describe('bayer_dither.frag — classic build', () => {
  it('uses no conditional compilation other than SAILOR_SHIMMER, balanced', () => {
    const c = FRAG.split('\n').map((l) => l.trim()).filter((l) => /^#\s*(if|ifdef|ifndef|elif|else|endif)\b/.test(l))
    for (const l of c) expect(['#ifdef SAILOR_SHIMMER', '#else', '#endif']).toContain(l)
    expect(c.filter((l) => l === '#endif')).toHaveLength(c.filter((l) => l.startsWith('#ifdef')).length)
    expect(c.filter((l) => l.startsWith('#ifdef')).length).toBeGreaterThanOrEqual(2)
  })
  it('is the pre-shimmer shader, line for line', () => {
    expect(build(FRAG, false)).toEqual(build(PRE, false))
    expect(build(FRAG, false).join('\n')).not.toContain('u_shimmer')
  })
  it('the fixture really is the pre-shimmer shader', () => {
    expect(PRE.split('\n')[0]).toBe('#version 300 es')
    expect(PRE).not.toContain('SAILOR_SHIMMER')
    expect(build(PRE, false).length).toBeGreaterThan(40)
  })
})

describe('bayer_dither.frag — shimmer build', () => {
  const lines = build(FRAG, true).join('\n')
  it('declares the two whole-cell offsets', () => {
    expect(lines).toContain('uniform float u_shimmerX;')
    expect(lines).toContain('uniform float u_shimmerY;')
  })
  it('slides the THRESHOLD pattern, not the sampled picture', () => {
    expect(lines).toContain('ditherThreshold(dc + ivec2(int(floor(u_shimmerX + 0.5)), int(floor(u_shimmerY + 0.5))), pat)')
    // the colour is still sampled at the un-shifted cell centre
    expect(lines).toContain('vec2 cuv = (vec2(dc) + 0.5) * cell / u_resolution;')
    expect(lines).not.toContain('ditherThreshold(dc, pat)')
  })
})
