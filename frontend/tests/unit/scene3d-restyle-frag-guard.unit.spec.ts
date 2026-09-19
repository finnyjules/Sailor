import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyRestyleProjection } from '~/lib/scene3d/restyleProjection'
import { createTreatment, type AiRestyleTreatment } from '~/lib/scene3d/treatments'

/**
 * Source-guard for the S7.1 PROJECTIVE restyle injection (`restyleProjection.ts`). S7 v1's
 * `RESTYLE_FRAG` in treatmentStage.ts was REMOVED — the restyle moved from a stage composite to a
 * per-object material injection — so this guard scans the newly-built VERTEX + FRAGMENT program.
 *
 * The S4/S5 "invisible layer" trap: a JS number reaching GLSL as a BARE INTEGER in a float context
 * (e.g. `6.2831853 / 3`). GLSL ES performs NO implicit int->float conversion, so ANGLE (which backs
 * Chromium/Playwright) rejects the program; it never links, the material silently renders nothing.
 * The CPU twins would still pass — only the GPU sees the type error. Rather than regex the source
 * text, this builds the ACTUAL injected program (onBeforeCompile against three's physical ShaderLib)
 * and scans the lines this module added, so a bare-int in either the vertex or fragment injection is
 * caught the same way a browser would reject it.
 */

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const stamped = (): AiRestyleTreatment => ({
  ...(createTreatment('aiRestyle') as AiRestyleTreatment),
  resultRef: 'guard.png',
  projViewProj: [...IDENTITY16], projRect: [0, 0, 100, 100], projSize: [100, 100], projForward: [0, 0, -1],
})

const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm
function resolveIncludes(src: string): string {
  return src.replace(INCLUDE, (_m, name: string) => resolveIncludes(THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk] ?? ''))
}
function build(): { frag: string; vert: string; uniforms: Record<string, unknown> } {
  const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
  applyRestyleProjection(m, stamped(), (() => { const t = new THREE.Texture(); t.colorSpace = THREE.NoColorSpace; return t })())
  const lib = THREE.ShaderLib.physical
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader }
  m.onBeforeCompile(shader as never, null as never)
  return { frag: resolveIncludes(shader.fragmentShader), vert: resolveIncludes(shader.vertexShader), uniforms: shader.uniforms }
}

describe('restyleProjection injected GLSL (the bare-int-operand / invisible-layer regression guard)', () => {
  const { frag, vert, uniforms } = build()
  const injected = [
    ...frag.split('\n').filter((l) => l.includes('rst') || l.includes('uRestyle')),
    ...vert.split('\n').filter((l) => l.includes('vRestyle')),
  ]

  it('locates the projective injection and it is non-trivial', () => {
    expect(uniforms.uRestyleTex).toBeDefined()
    expect(uniforms.uRestyleProjVP).toBeDefined()
    expect(injected.length).toBeGreaterThan(8)
  })

  it('never divides or multiplies by a BARE integer in a float context (would be a float/int type error)', () => {
    // The GLITCH_FRAG-guard matcher: `* 3)` / `/ 3;` is the fingerprint of a JS number interpolated
    // without a decimal point. A JS number reaches the shader as a float literal only WITH a decimal.
    for (const line of injected) {
      expect(line, `suspicious bare-int operand: ${line}`).not.toMatch(/[*/]\s*\d+\s*[);]/)
    }
  })

  it('never int/int-divides (both operands bare integers)', () => {
    for (const line of injected) {
      expect(line, `suspicious int/int division: ${line}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
    }
  })

  it('emits its numeric constants as proper GLSL float literals (decimal point present)', () => {
    // The crop maths + gate carry float constants (0.5, 0.25, 0.0, 1.0); a bare integer there would
    // be the exact trap above.
    expect(injected.join('\n')).toMatch(/\d+\.\d+/)
    expect(injected.join('\n')).toContain('1.0')
  })
})
