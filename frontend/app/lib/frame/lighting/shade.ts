/**
 * Frame light layers, stage 1: how a light layer becomes shader numbers, and a pure TypeScript
 * mirror of the per-pixel lighting in `lightingPass.ts` (no shadows — the shadow walk needs
 * the lift map) so the maths can be tested without WebGL.
 *
 * Space: Frame widths. A point is (x, y·aspect, z) with x, y Frame fractions and
 * aspect = H / W, exactly as the approved prototype (scratchpad lightproto/light-layer.html).
 */
import type { FrameLighting, LightLayer } from './settings'

export type Vec3 = [number, number, number]

/** One light ready for the shader. type: 1 lamp, 2 spot, 3 sun (the prototype's codes). */
export interface PackedLight {
  type: 1 | 2 | 3
  /** Lamp/spot: position (x, y·aspect, z). Sun: the direction toward the light (unnormalised). */
  pos: Vec3
  /** Linear-light colour × brightness. */
  color: Vec3
  reach: number
  /** Spot aim point on the Frame (x, y·aspect). */
  aim: [number, number]
  cosOuter: number
  cosInner: number
}

const TYPE_CODE = { lamp: 1, spot: 2, sun: 3 } as const

export function hexToLinear(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.pow(v / 255, 2.2)) as Vec3
}

/** Verbatim from the prototype's render(): sun direction, lamp/spot height, cone cosines. */
export function packLight(layer: LightLayer, aspect: number): PackedLight {
  const l = layer.light
  let pos: Vec3
  if (l.type === 'sun') {
    // Direction from the sun's dot toward the Frame's centre, tilted up by height.
    let dx = layer.x - 0.5, dy = (layer.y - 0.5) * aspect
    const m = Math.hypot(dx, dy) || 1
    dx /= m; dy /= m
    const el = 0.12 + l.height * 1.3
    pos = [dx * Math.cos(el), dy * Math.cos(el), Math.sin(el)]
  } else {
    pos = [layer.x, layer.y * aspect, 0.04 + l.height * 0.9]
  }
  const color = hexToLinear(l.color).map(v => v * l.brightness) as Vec3
  return {
    type: TYPE_CODE[l.type],
    pos,
    color,
    reach: l.reach,
    aim: [l.aimX, l.aimY * aspect],
    cosOuter: Math.cos(l.cone),
    cosInner: Math.cos(l.cone * (1 - l.edge * 0.9)),
  }
}

export const MAX_SHADER_LIGHTS = 6

/** The pass's uniforms: uA = (x, y·aspect, z, type), uB = (linear rgb × brightness, reach),
 *  uC = (aimX, aimY·aspect, cosOuter, cosInner). Unused slots are zero. */
export function packLightUniforms(lights: readonly LightLayer[], lighting: FrameLighting, aspect: number, liftScale: number) {
  const uA = new Float32Array(MAX_SHADER_LIGHTS * 4)
  const uB = new Float32Array(MAX_SHADER_LIGHTS * 4)
  const uC = new Float32Array(MAX_SHADER_LIGHTS * 4)
  const on = lights.slice(0, MAX_SHADER_LIGHTS)
  on.forEach((layer, i) => {
    const p = packLight(layer, aspect)
    uA.set([p.pos[0], p.pos[1], p.pos[2], p.type], i * 4)
    uB.set([p.color[0], p.color[1], p.color[2], p.reach], i * 4)
    uC.set([p.aim[0], p.aim[1], p.cosOuter, p.cosInner], i * 4)
  })
  return { uA, uB, uC, uCount: on.length, uDark: lighting.darkness, uAspect: aspect, uLiftScale: liftScale }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Ambient: what is left of the picture's own light at this Darkness. */
export const ambient = (darkness: number) => 1 - darkness * 0.92

/**
 * One light's contribution (linear rgb) at P = (x, y·aspect, z), flat normal, no shadow —
 * the loop body of the shader: falloff r²/(r²+d²·3), spot cone smoothstep, wrapped n·L.
 */
export function lightAt(p: PackedLight, P: Vec3): Vec3 {
  const n: Vec3 = [0, 0, 1]
  let L: Vec3
  let att = 1
  if (p.type === 3) {
    L = norm(p.pos)
  } else {
    const d = sub(p.pos, P)
    const dist = len(d)
    L = norm(d)
    const r = p.reach
    att = r * r / (r * r + dist * dist * 3)
    if (p.type === 2) {
      const axis = norm(sub([p.aim[0], p.aim[1], 0], p.pos))
      const c = dot([-L[0], -L[1], -L[2]], axis)
      att *= smoothstep(p.cosOuter, p.cosInner, c)
    }
  }
  const ndl = Math.max(dot(n, L) * 0.85 + 0.15, 0)
  if (att * ndl < 0.002) return [0, 0, 0]
  return [p.color[0] * att * ndl, p.color[1] * att * ndl, p.color[2] * att * ndl]
}

/**
 * One pixel, unshadowed: sRGB albedo in, sRGB out. Mirrors the shader's tail: linear albedo ×
 * (ambient + lights), tone `col/(1+col·0.18)`, then floored at the ambient-only value so the
 * tone curve never takes away light Darkness left in place (Darkness 0 never darkens).
 */
export function shadePixel(albedo: Vec3, lights: readonly PackedLight[], P: Vec3, darkness: number): Vec3 {
  const amb = ambient(darkness)
  const acc: Vec3 = [amb, amb, amb]
  for (const p of lights.slice(0, MAX_SHADER_LIGHTS)) {
    const c = lightAt(p, P)
    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
  }
  return albedo.map((s, i) => {
    const a = Math.pow(s, 2.2)
    const col = a * acc[i]!
    const toned = Math.max(col / (1 + col * 0.18), a * amb)
    return Math.pow(toned, 1 / 2.2)
  }) as Vec3
}

/** The walk's constants, shared with the GLSL (a test greps LIGHTING_FRAG for each). */
export const WALK_STEPS = 56
export const WALK_STEP = 0.0075

/**
 * The screen-space shadow toward one light — the shader's walk, mirrored. `L` is the unit
 * direction toward the light, `maxT` the walk's reach (Frame widths; 2 for a sun), `height(u, v)`
 * the lift field in Frame widths at Frame fractions, `maxLift` the tallest lift on the Frame.
 * The walk stops once the ray is above `maxLift` (nothing left to hit) — exact, not a guess:
 * past that point `above` is negative for every sample and the soft term is 0.
 * Returns the shadow factor (1 = lit, 0.15 = fully shadowed).
 */
export function shadowWalk(
  P: Vec3, L: Vec3, maxT: number, height: (u: number, v: number) => number, aspect: number, maxLift: number, jitter = 0,
): number {
  let sh = 1
  const lxy = Math.hypot(L[0], L[1])
  if (!(maxLift > 0) || !(lxy > 1e-4)) return sh
  const dir = [L[0] / lxy, L[1] / lxy], slope = L[2] / lxy
  for (let k = 1; k <= WALK_STEPS; k++) {
    const t = (k - jitter) * WALK_STEP
    if (t > maxT) break
    if (P[2] + t * slope > maxLift) break
    const qx = P[0] + dir[0]! * t, qy = P[1] + dir[1]! * t
    const u = qx, v = qy / aspect
    if (u < 0 || u > 1 || v < 0 || v > 1) break
    const above = height(u, v) - (P[2] + t * slope)
    sh = Math.min(sh, 1 - smoothstep(0, 0.02 + t * 0.25, above) * 0.85)
  }
  return sh
}
