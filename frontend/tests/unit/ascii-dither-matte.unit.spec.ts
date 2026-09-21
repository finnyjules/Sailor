import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_PASS_DEFAULTS } from '~/lib/shaderfx/renderer'

/**
 * Matte mode is a DEFAULT-OFF addition to the ASCII shader, added for the Frame
 * compositor's dither transition (the Pixels style rebuilds a layer out of
 * characters and has to composite it over the frame with real transparency).
 *
 * Two things must stay true and neither is observable from a unit test that can
 * only run GL in a browser:
 *   1. With `u_matte == 0` the shader writes EXACTLY the pixels it writes today —
 *      the browser golden-parity suite (tests/shaderfx-golden.spec.ts, Playwright)
 *      diffs this effect's RGB against server goldens at default params, and the
 *      python backend renders the same frag with its own GL where an unset float
 *      uniform is 0, so `u_matte` is off there forever.
 *   2. The matte branch is actually wired where the design says it is — the
 *      density multiply has to sit between the brightness clamp and the Invert
 *      flip, or a transparent cell still lights a glyph.
 *
 * So this pins the SOURCE. It is a contract test on the frag text, deliberately
 * exact about ordering, in the same spirit as shader-manifest-uniforms.unit.spec.ts.
 */
const FRAG = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../shader_effects/ascii_dither.frag'),
  'utf8',
)

const lineOf = (needle: string): number => {
  const lines = FRAG.split('\n')
  const i = lines.findIndex(l => l.includes(needle))
  expect(i, `expected ascii_dither.frag to contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('ascii_dither.frag — matte mode', () => {
  it('declares the u_matte switch', () => {
    expect(FRAG).toMatch(/^uniform float u_matte;/m)
  })

  it('samples the cell ONCE as a vec4 and keeps the classic rgb read', () => {
    expect(FRAG).toContain('vec4 src = texture(u_image0, clamp(cuv, 0.0, 1.0));')
    expect(FRAG).toContain('vec3 col = src.rgb;')
  })

  it('multiplies density by the source alpha between the brightness clamp and the Invert flip', () => {
    const brightness = lineOf('float g = clamp(lum + jitter + u_brightness, 0.0, 1.0);')
    const alpha = lineOf('if (matte) g = clamp(mix(0.5, lum, 0.5) + jitter + u_brightness, 0.0, 1.0) * src.a;')
    const invert = lineOf('if (u_invert > 0.5) g = 1.0 - g;')
    expect(alpha).toBeGreaterThan(brightness)
    expect(alpha).toBeLessThan(invert)
  })

  it('hoists glyph so it is in scope at the matte output', () => {
    expect(lineOf('float glyph = 0.0;')).toBeLessThan(lineOf('if (shp >= 15) {'))
  })

  it('writes straight alpha for both shape families', () => {
    // an empty cell (zero density) is fully transparent — the shapes' centre hairline must not become ink
    expect(FRAG).toContain('fragColor0 = vec4(clamp(col, 0.0, 1.0), g > 0.0 ? clamp(glyph, 0.0, 1.0) : 0.0);')
    expect(FRAG).toContain('fragColor0 = vec4(clamp(fx, 0.0, 1.0), src.a * step(0.001, g));')
  })

  it('returns before the underlay block in matte mode', () => {
    expect(lineOf('int mode = int(u_underlay + 0.5);')).toBeGreaterThan(lineOf('bool matte = u_matte > 0.5;'))
    expect(lineOf('fragColor0 = vec4(clamp(fx, 0.0, 1.0), src.a * step(0.001, g));'))
      .toBeLessThan(lineOf('int mode = int(u_underlay + 0.5);'))
  })

  it('leaves the classic path as the last word of main', () => {
    // The final statement of main() is still the opaque underlay write — matte mode
    // is an early return ABOVE it, never a rewrite of it.
    const trimmed = FRAG.trimEnd()
    expect(trimmed.endsWith('    fragColor0 = vec4(clamp(outc, 0.0, 1.0), 1.0);\n}')).toBe(true)
  })

  it('leaves the classic ink expression untouched', () => {
    expect(FRAG).toContain('col / max(lum, 1e-3)')
    expect(FRAG).toContain('vec3 ink = mix(vec3(1.0), col / max(lum, 1e-3), step(0.5, u_colored));')
  })
})

/**
 * `shaderFx` is a shared singleton and its programs are CACHED, so a uniform that
 * one caller writes and the next caller does not rewrite keeps its last value.
 * Shader Studio composes its own passes and never goes through `buildPasses`, so
 * nothing on that path would ever write `u_matte: 0` — the renderer has to.
 */
describe('renderer — mode switches are reset before every draw', () => {
  it('exports BUILTIN_PASS_DEFAULTS with u_matte off', () => {
    expect(BUILTIN_PASS_DEFAULTS).toBeTypeOf('object')
    expect(BUILTIN_PASS_DEFAULTS.u_matte).toBe(0)
  })

  it('writes the defaults BEFORE the pass dict, so a pass can still set the switch', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../app/lib/shaderfx/renderer.ts'),
      'utf8',
    )
    const defaults = src.indexOf('for (const [name, value] of Object.entries(BUILTIN_PASS_DEFAULTS))')
    const own = src.indexOf('for (const [name, value] of Object.entries(pass.uniforms))')
    expect(defaults).toBeGreaterThanOrEqual(0)
    expect(own).toBeGreaterThanOrEqual(0)
    expect(defaults).toBeLessThan(own)
  })
})
