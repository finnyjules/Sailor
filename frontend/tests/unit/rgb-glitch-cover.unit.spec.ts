/**
 * rgb_glitch.frag — the COVER build variant.
 *
 * A settle transition recovers real transparency by running the effect over the layer's colour
 * AND over its coverage, then dividing. This effect darkens its glitching bands by a FIXED 25%;
 * applied to both renders the divide cancels it out of the colour and lands it on the ALPHA —
 * dark scanlines became transparency flicker. The coverage render therefore uses a build
 * (`#define SAILOR_COVER 1`, injected through renderFieldWithBase's `variant`) that skips that
 * one line. With the macro undefined the compiler sees the original shader, line for line.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAG = readFileSync(resolve(HERE, '../../../shader_effects/rgb_glitch.frag'), 'utf8')
const PRE = readFileSync(resolve(HERE, 'fixtures/rgb_glitch.pre-cover.frag'), 'utf8')

function build(src: string, cover: boolean): string[] {
  const out: string[] = []
  let mode: 'plain' | 'in' | 'else' = 'plain'
  for (const raw of src.split('\n')) {
    const t = raw.trim()
    if (t === '#ifndef SAILOR_COVER') { mode = 'in'; continue }
    if (t === '#else' && mode !== 'plain') { mode = 'else'; continue }
    if (t === '#endif' && mode !== 'plain') { mode = 'plain'; continue }
    if ((mode === 'in' && cover) || (mode === 'else' && !cover)) continue
    const line = raw.replace(/\/\/.*$/, '').trimEnd()
    if (line.trim() !== '') out.push(line)
  }
  return out
}

describe('rgb_glitch.frag', () => {
  it('classic build is the original shader, line for line', () => {
    expect(build(FRAG, false)).toEqual(build(PRE, false))
    expect(PRE).not.toContain('SAILOR_COVER')
    expect(build(PRE, false).length).toBeGreaterThan(15)
  })
  it('the only conditional compilation is one balanced SAILOR_COVER region', () => {
    const c = FRAG.split('\n').map((l) => l.trim()).filter((l) => /^#\s*(if|ifdef|ifndef|elif|else|endif)\b/.test(l))
    expect(c).toEqual(['#ifndef SAILOR_COVER', '#endif'])
  })
  it('the COVER build drops exactly the band-darkening line and nothing else', () => {
    const classic = build(FRAG, false), cover = build(FRAG, true)
    const dropped = classic.filter((l) => !cover.includes(l))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain('col *= 1.0 - 0.25 * glitchOn')
  })
})
