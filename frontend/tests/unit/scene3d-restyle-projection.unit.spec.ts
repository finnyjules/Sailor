import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  applyRestyleProjection, updateRestyleUniforms, restyleProjectionKey,
  projectRestyleUV, restyleFrontFacing,
} from '~/lib/scene3d/restyleProjection'
import { createTreatment, type AiRestyleTreatment } from '~/lib/scene3d/treatments'

// A stamped aiRestyle treatment: an IDENTITY projector, a 100×100 bake canvas, the full frame as the
// crop rect, forward down -Z (a camera looking at the origin from +Z). With this projector the maths
// collapse to `u = 0.5*x + 0.5`, `v = 0.5 - 0.5*y` for a world point [x, y, 0] (see the closed forms
// in the projectRestyleUV cases below), which makes the twin assertable by hand.
const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const stamped = (overrides: Partial<AiRestyleTreatment> = {}): AiRestyleTreatment => ({
  ...(createTreatment('aiRestyle') as AiRestyleTreatment),
  resultRef: 'r-1.png',
  projViewProj: [...IDENTITY16],
  projRect: [0, 0, 100, 100],
  projSize: [100, 100],
  projForward: [0, 0, -1],
  ...overrides,
})

const fakeTex = (): THREE.Texture => {
  const t = new THREE.Texture()
  t.colorSpace = THREE.NoColorSpace
  return t
}

// ── CPU twin: projectRestyleUV ───────────────────────────────────────────────────
describe('projectRestyleUV (CPU twin of the shader projection)', () => {
  const rect: [number, number, number, number] = [0, 0, 100, 100]
  const size: [number, number] = [100, 100]

  it('projects the projector-axis centre to the crop-square centre', () => {
    const uv = projectRestyleUV([0, 0, 0], IDENTITY16, rect, size)
    expect(uv).not.toBeNull()
    expect(uv![0]).toBeCloseTo(0.5, 6)
    expect(uv![1]).toBeCloseTo(0.5, 6)
  })

  it('maps a known off-centre world point to the expected UV (u = 0.5x+0.5, v = 0.5-0.5y)', () => {
    // [1, 1, 0] -> NDC (1, 1) -> full (1, 1) -> pix (100, 0) -> uv (1, 0).
    const uv = projectRestyleUV([1, 1, 0], IDENTITY16, rect, size)
    expect(uv).not.toBeNull()
    expect(uv![0]).toBeCloseTo(1, 6)
    expect(uv![1]).toBeCloseTo(0, 6)
    // [-1, -1, 0] -> NDC (-1, -1) -> full (0, 0) -> pix (0, 100) -> uv (0, 1).
    const uv2 = projectRestyleUV([-1, -1, 0], IDENTITY16, rect, size)
    expect(uv2).not.toBeNull()
    expect(uv2![0]).toBeCloseTo(0, 6)
    expect(uv2![1]).toBeCloseTo(1, 6)
  })

  it('returns null for a point that projects outside the crop square', () => {
    // [2, 0, 0] -> NDC x = 2 -> full x = 1.5 -> uv.x = 1.5, out of [0,1].
    expect(projectRestyleUV([2, 0, 0], IDENTITY16, rect, size)).toBeNull()
  })

  it('returns null for a point BEHIND the projector (clip w <= 0)', () => {
    // A projector whose w-row picks up z (column-major: m[11] = 1, m[15] = 0), so w = z.
    const wIsZ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]
    expect(projectRestyleUV([0, 0, -1], wIsZ, rect, size)).toBeNull() // w = -1
    // ...and a point in front (w > 0) still projects.
    expect(projectRestyleUV([0, 0, 1], wIsZ, rect, size)).not.toBeNull()
  })

  it('agrees with a real THREE camera view-projection for a point on the object', () => {
    // An independent oracle: build a perspective camera looking at the origin, project a world point
    // through its viewProj by hand (Vector3.applyMatrix4 does the perspective divide), and check the
    // twin lands the same crop UV. Guards the column-major indexing against a transpose bug.
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    cam.position.set(0, 0, 4)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    const p = new THREE.Vector3(0.2, -0.1, 0)
    const ndc = p.clone().applyMatrix4(vp) // perspective divide inside applyMatrix4
    const expFull = [ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5]
    const expPix = [expFull[0]! * 200, (1 - expFull[1]!) * 200]
    const rct: [number, number, number, number] = [0, 0, 200, 200]
    const side = 200, off = [0, 0]
    const exp = [(expPix[0]! - 0 + off[0]!) / side, (expPix[1]! - 0 + off[1]!) / side]
    const uv = projectRestyleUV([0.2, -0.1, 0], vp.toArray(), rct, [200, 200])
    expect(uv).not.toBeNull()
    expect(uv![0]).toBeCloseTo(exp[0]!, 5)
    expect(uv![1]).toBeCloseTo(exp[1]!, 5)
  })

  it('honours a non-square crop rect via the square-pad offset (matches v1 crop maths)', () => {
    // A wide rect (w=80, h=40) inside a 100×100 canvas: side = 80, off = (0, 20). A point at the
    // canvas centre (pix 50,50): uv = ((50-10)+0)/80, ((50-30)+20)/80 = (0.5, 0.5).
    const wideRect: [number, number, number, number] = [10, 30, 80, 40]
    const uv = projectRestyleUV([0, 0, 0], IDENTITY16, wideRect, size)
    expect(uv).not.toBeNull()
    expect(uv![0]).toBeCloseTo(0.5, 6)
    expect(uv![1]).toBeCloseTo(0.5, 6)
  })
})

// ── CPU twin: restyleFrontFacing ─────────────────────────────────────────────────
describe('restyleFrontFacing (CPU twin of the front-facing gate)', () => {
  const forward: [number, number, number] = [0, 0, -1] // projector looks down -Z

  it('a normal facing straight at the projector is ~1', () => {
    expect(restyleFrontFacing([0, 0, 1], forward)).toBeCloseTo(1, 6)
  })

  it('a back-facing normal is 0', () => {
    expect(restyleFrontFacing([0, 0, -1], forward)).toBe(0)
  })

  it('the terminator (grazing) sits strictly between 0 and 1', () => {
    // n.z = 0.125 -> -dot = 0.125 -> smoothstep(0, 0.25, 0.125) = 0.5.
    const n: [number, number, number] = [Math.sqrt(1 - 0.125 * 0.125), 0, 0.125]
    const face = restyleFrontFacing(n, forward)
    expect(face).toBeGreaterThan(0)
    expect(face).toBeLessThan(1)
    expect(face).toBeCloseTo(0.5, 5)
  })

  it('a normal exactly perpendicular to the projector is 0 (smoothstep low edge)', () => {
    expect(restyleFrontFacing([1, 0, 0], forward)).toBe(0)
  })

  it('does not require a pre-normalized normal', () => {
    const unit = restyleFrontFacing([0, 0, 1], forward)
    const scaled = restyleFrontFacing([0, 0, 5], forward)
    expect(scaled).toBeCloseTo(unit, 6)
  })
})

// ── restyleProjectionKey ─────────────────────────────────────────────────────────
describe('restyleProjectionKey', () => {
  it('is empty when there is no cached texture (byte-identical)', () => {
    expect(restyleProjectionKey(stamped(), null)).toBe('')
    expect(restyleProjectionKey(stamped(), undefined)).toBe('')
  })

  it('is empty when the projector is unstamped (projViewProj empty)', () => {
    expect(restyleProjectionKey(stamped({ projViewProj: [] }), fakeTex())).toBe('')
  })

  it('is keyed by resultRef when a texture and projector are present', () => {
    expect(restyleProjectionKey(stamped({ resultRef: 'abc.png' }), fakeTex())).toBe('|rst:abc.png')
  })

  it('changes when the resultRef changes (a fresh bake is a rebuild boundary)', () => {
    const tex = fakeTex()
    expect(restyleProjectionKey(stamped({ resultRef: 'a.png' }), tex))
      .not.toBe(restyleProjectionKey(stamped({ resultRef: 'b.png' }), tex))
  })
})

// ── Byte-identity: the S7.1 non-negotiable ───────────────────────────────────────
// `applyRestyleProjection` with an EMPTY projViewProj (or no texture) must be a COMPLETE no-op —
// same onBeforeCompile, same customProgramCacheKey, no userData stamp — so an object with an
// uncached / unrun restyle builds/compiles exactly as it did before this feature existed. Written
// RED-first against a version of `applyRestyleProjection` with no early-out (which injects
// unconditionally); only once the `!tex || !t.projViewProj.length` guard is in place does this pass.
describe('applyRestyleProjection: byte-identical when absent', () => {
  it('does not touch onBeforeCompile, the cache key, or userData when projViewProj is empty', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const beforeCompile = m.onBeforeCompile
    const beforeKey = String(m.customProgramCacheKey())
    applyRestyleProjection(m, stamped({ projViewProj: [] }), fakeTex())
    expect(m.onBeforeCompile).toBe(beforeCompile)
    expect(String(m.customProgramCacheKey())).toBe(beforeKey)
    expect(m.userData.restyleUniforms).toBeUndefined()
  })

  it('does not touch the material when the texture is null (present-but-uncached)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const beforeCompile = m.onBeforeCompile
    const beforeKey = String(m.customProgramCacheKey())
    applyRestyleProjection(m, stamped(), null)
    expect(m.onBeforeCompile).toBe(beforeCompile)
    expect(String(m.customProgramCacheKey())).toBe(beforeKey)
    expect(m.userData.restyleUniforms).toBeUndefined()
  })

  it('two independently built materials compile identically after applyRestyleProjection with an empty projector', () => {
    const a = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const b = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(a, stamped({ projViewProj: [] }), fakeTex())
    expect(String(a.customProgramCacheKey())).toBe(String(b.customProgramCacheKey()))
  })
})

// ── The injection reaches the compiled program, in the right place ───────────────
const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm
function resolveIncludes(src: string): string {
  return src.replace(INCLUDE, (_m, name: string) => resolveIncludes(THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk] ?? ''))
}
function compiled(m: THREE.Material): { frag: string; vert: string; uniforms: Record<string, unknown> } {
  const lib = THREE.ShaderLib.physical
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader }
  m.onBeforeCompile(shader as never, null as never)
  return { frag: resolveIncludes(shader.fragmentShader), vert: resolveIncludes(shader.vertexShader), uniforms: shader.uniforms }
}

describe('applyRestyleProjection: the projection reaches the compiled program', () => {
  it('binds the six uniforms and injects the fragment body before dithering, after gl_FragColor', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(m, stamped(), fakeTex())
    const { frag, uniforms } = compiled(m)
    for (const k of ['uRestyleTex', 'uRestyleProjVP', 'uRestyleRect', 'uRestyleSize', 'uRestyleForward', 'uRestyleMix']) {
      expect(uniforms[k], `${k} not bound`).toBeDefined()
    }
    const bodyIdx = frag.indexOf('rstRestyle')
    expect(bodyIdx, 'restyle body missing from fragment').toBeGreaterThan(-1)
    const glFragColorAssign = frag.indexOf('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(glFragColorAssign, 'gl_FragColor assignment missing').toBeGreaterThan(-1)
    expect(glFragColorAssign).toBeLessThan(bodyIdx)
  })

  it('injects the two world varyings into the vertex shader, after their source chunks', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(m, stamped(), fakeTex())
    const { vert } = compiled(m)
    expect(vert).toContain('vRestyleWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
    expect(vert).toContain('vRestyleWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );')
    // world pos must be written AFTER `transformed` exists (project_vertex consumes begin_vertex).
    expect(vert.indexOf('vRestyleWorldPos =')).toBeGreaterThan(vert.indexOf('transformed = vec3( position )'))
  })

  it('chains onto the base material — the physical shader body is still present', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(m, stamped(), fakeTex())
    const { frag } = compiled(m)
    expect(frag).toContain('#define STANDARD')
    expect(frag).toContain('ReflectedLight reflectedLight')
  })

  it('the injected cache key folds in restyleProjectionKey', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const plainKey = String(m.customProgramCacheKey())
    applyRestyleProjection(m, stamped({ resultRef: 'z.png' }), fakeTex())
    expect(String(m.customProgramCacheKey())).not.toBe(plainKey)
    expect(String(m.customProgramCacheKey())).toContain('|rst:z.png')
  })

  it('samples the result RAW (no srgbToLinear) — display-space anchor, NoColorSpace texture', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(m, stamped(), fakeTex())
    const { frag } = compiled(m)
    const bodyIdx = frag.indexOf('{\n  vec4 rstClip')
    const body = frag.slice(bodyIdx, frag.indexOf('\n}', bodyIdx))
    expect(body).not.toMatch(/srgbToLinear|srgbEOTF/)
  })
})

// ── Source guard: the S4 ANGLE float/int lesson (built vertex + fragment) ─────────
describe('applyRestyleProjection: no bare-int GLSL operand in the injected lines', () => {
  it('neither the vertex nor fragment injection divides/multiplies by a bare integer', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyRestyleProjection(m, stamped(), fakeTex())
    const { frag, vert } = compiled(m)
    const lines = [
      ...frag.split('\n').filter((l) => l.includes('rst') || l.includes('uRestyle')),
      ...vert.split('\n').filter((l) => l.includes('vRestyle')),
    ]
    for (const line of lines) {
      expect(line, `suspicious bare-int operand: ${line}`).not.toMatch(/[*/]\s*\d+\s*[);]/)
      expect(line, `suspicious int/int division: ${line}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
    }
  })
})

// ── updateRestyleUniforms ─────────────────────────────────────────────────────────
describe('updateRestyleUniforms', () => {
  it('writes mix in place when the texture, resultRef and projector are unchanged', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const tex = fakeTex()
    const t = stamped({ mix: 0.3 })
    applyRestyleProjection(m, t, tex)
    expect(updateRestyleUniforms(m, { ...t, mix: 0.9 }, tex)).toBe(true)
    const bag = m.userData.restyleUniforms as { u: Record<string, { value: unknown }> }
    expect(bag.u.uRestyleMix!.value).toBe(0.9)
  })

  it('returns false (rebuild) when the texture instance changed (a fresh bake)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = stamped()
    applyRestyleProjection(m, t, fakeTex())
    expect(updateRestyleUniforms(m, t, fakeTex())).toBe(false)
  })

  it('returns false (rebuild) when the resultRef changed at the same texture', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const tex = fakeTex()
    applyRestyleProjection(m, stamped({ resultRef: 'a.png' }), tex)
    expect(updateRestyleUniforms(m, stamped({ resultRef: 'b.png' }), tex)).toBe(false)
  })

  it('returns false (rebuild) when the projector matrix changed', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const tex = fakeTex()
    applyRestyleProjection(m, stamped(), tex)
    const moved = [...IDENTITY16]; moved[12] = 0.5 // a translated projector
    expect(updateRestyleUniforms(m, stamped({ projViewProj: moved }), tex)).toBe(false)
  })

  it('returns false (rebuild) when a first texture arrives on a material that had none', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    expect(updateRestyleUniforms(m, stamped(), fakeTex())).toBe(false)
  })

  it('returns true (no-op) when no injection is bound and none is wanted (byte-identical steady state)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    expect(updateRestyleUniforms(m, stamped({ projViewProj: [] }), null)).toBe(true)
  })

  it('returns false (rebuild) when a bound injection is no longer wanted (texture cleared)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = stamped()
    applyRestyleProjection(m, t, fakeTex())
    expect(updateRestyleUniforms(m, t, null)).toBe(false)
  })
})
