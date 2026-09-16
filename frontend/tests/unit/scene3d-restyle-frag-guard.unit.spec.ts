import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Source-guard for the S7 restyle composite fragment (`RESTYLE_FRAG` in treatmentStage.ts).
 *
 * This mirrors the `GLITCH_FRAG` source-guard in scene3d-treatment-stage.unit.spec.ts: the S4/S5
 * "invisible layer" trap is a JS number reaching the GLSL as a BARE INTEGER in a float context
 * (e.g. `6.2831853 / 3`). GLSL ES performs NO implicit int->float conversion, so ANGLE (which
 * backs Chromium/Playwright) rejects the program; it never links, `this.pass(restyleMat, ...)`
 * writes nothing, and the whole restyled object goes empty. The CPU-side maths would still pass
 * its unit twins — only the GPU sees the type error. This guard scans the shipped GLSL text.
 *
 * `RESTYLE_FRAG` is NOT exported (Tasks 1-3 are committed; this coverage task must not touch
 * source), so we read the module text and extract the template literal, then apply the exact same
 * matcher the GLITCH_FRAG guard uses.
 */

const STAGE_SRC = readFileSync(
  fileURLToPath(new URL('../../app/lib/scene3d/treatmentStage.ts', import.meta.url)),
  'utf8',
)

/** Extract the `const RESTYLE_FRAG = ` template-literal body (GLSL has no backtick, so the
 *  non-greedy match to the first backtick is exact). */
function extractRestyleFrag(src: string): string {
  const m = src.match(/const RESTYLE_FRAG = `([\s\S]*?)`/)
  if (!m) throw new Error('RESTYLE_FRAG template literal not found in treatmentStage.ts')
  return m[1]!
}

describe('RESTYLE_FRAG source (the bare-int-operand / invisible-layer regression guard)', () => {
  const frag = extractRestyleFrag(STAGE_SRC)

  it('locates the RESTYLE_FRAG GLSL and it is non-trivial', () => {
    expect(frag.length).toBeGreaterThan(200)
    // It really is the restyle composite: samples the result texture and blends by uMix.
    expect(frag).toContain('uResultTex')
    expect(frag).toContain('uMix')
  })

  it('never divides or multiplies by a BARE integer in a float context (would be a float/int type error)', () => {
    // Same matcher as the GLITCH_FRAG guard: `* 3)` or `/ 3;` next to an arithmetic operator is
    // the fingerprint of the S4/S5 bug (a JS number interpolated without a decimal point). A JS
    // number reaches the shader as a float literal only if it carries a decimal point.
    expect(frag).not.toMatch(/[*/]\s*\d+\s*[);]/)
  })

  it('emits its numeric constants as proper GLSL float literals (decimal point present)', () => {
    // The srgb->linear decode carries float constants (1.055, 12.92, 2.4, 0.04045); a bare integer
    // there would be the exact trap above. At least one decimal float literal must be present.
    expect(frag).toMatch(/\d+\.\d+/)
    // And every `mix(...)` / arithmetic constant that guards coverage stays a float, e.g. `max(side, 1.0)`.
    expect(frag).toContain('1.0')
  })
})
