// Byte-identity proof for Task 2 of the Scene3D modifier-stack slice.
//
// `applyModifiers(geo, bag, vary)` was rewritten as a thin wrapper over the new
// `applyModifierStack(geo, stack, {vary})`, folding the legacy flat bag through
// `modifierStackOf`. This spec proves the rewrite is byte-identical to the
// PRE-REFACTOR pipeline for every primitive × every legacy bag, and that the new
// stack genuinely reorders (twist-then-bend ≠ bend-then-twist) and duplicates
// (two twists ≠ one twist) while the no-op cases still return the SAME geometry.
//
// The oracle `applyModifiersLegacy` below is the pre-refactor `applyModifiers`
// (commit 7483f7853), copied VERBATIM together with its private deform/subdivide
// helpers. It reuses only the genuinely-unchanged exported helpers (clampedClones,
// planClones, mergeClones, totalClones, modifierValue) — the thing under test is the
// ORCHESTRATION (fold + list-order iteration), so the oracle must run the old fixed
// order against its own copies of the deform maths. If those exported helpers ever
// change, the cloner-recipes / clone-budget specs guard them independently.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  applyModifiers, applyModifierStack,
  clampedClones, planClones, mergeClones, totalClones,
} from '~/lib/scene3d/modifiers'
import { modifierValue } from '~/lib/scene3d/primParams'
import { modifierStackOf, createModifier, type ModifierInstance } from '~/lib/scene3d/modifierStack'
import type { VarySettings } from '~/lib/vary'

const VERTEX_BUDGET = 300_000

// ---------------------------------------------------------------------------
// The pre-refactor private helpers, copied verbatim from 7483f7853 so the oracle
// is a genuine independent reproduction of the old behaviour.
// ---------------------------------------------------------------------------
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(seed, 2654435761)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
const smooth = (t: number): number => t * t * (3 - 2 * t)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi)
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed)
  const x00 = mix(c(0, 0, 0), c(1, 0, 0), u)
  const x10 = mix(c(0, 1, 0), c(1, 1, 0), u)
  const x01 = mix(c(0, 0, 1), c(1, 0, 1), u)
  const x11 = mix(c(0, 1, 1), c(1, 1, 1), u)
  return mix(mix(x00, x10, v), mix(x01, x11, v), w) * 2 - 1
}
function subdivideOnce(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo
  const pos = src.getAttribute('position')
  const uv = src.getAttribute('uv')
  const outPos: number[] = []
  const outUv: number[] = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), bc = new THREE.Vector3(), ca = new THREE.Vector3()
  const push = (v: THREE.Vector3) => { outPos.push(v.x, v.y, v.z) }
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos as THREE.BufferAttribute, i)
    b.fromBufferAttribute(pos as THREE.BufferAttribute, i + 1)
    c.fromBufferAttribute(pos as THREE.BufferAttribute, i + 2)
    ab.addVectors(a, b).multiplyScalar(0.5)
    bc.addVectors(b, c).multiplyScalar(0.5)
    ca.addVectors(c, a).multiplyScalar(0.5)
    push(a); push(ab); push(ca)
    push(ab); push(b); push(bc)
    push(ca); push(bc); push(c)
    push(ab); push(bc); push(ca)
    if (uv) {
      const u0 = uv.getX(i), v0 = uv.getY(i)
      const u1 = uv.getX(i + 1), v1 = uv.getY(i + 1)
      const u2 = uv.getX(i + 2), v2 = uv.getY(i + 2)
      const uab = (u0 + u1) / 2, vab = (v0 + v1) / 2
      const ubc = (u1 + u2) / 2, vbc = (v1 + v2) / 2
      const uca = (u2 + u0) / 2, vca = (v2 + v0) / 2
      outUv.push(u0, v0, uab, vab, uca, vca)
      outUv.push(uab, vab, u1, v1, ubc, vbc)
      outUv.push(uca, vca, ubc, vbc, u2, v2)
      outUv.push(uab, vab, ubc, vbc, uca, vca)
    }
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  if (src !== geo) src.dispose()
  const welded = mergeVertices(out)
  if (welded !== out) out.dispose()
  return welded
}
function extentOf(geo: THREE.BufferGeometry, axis: number): [number, number] {
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  const min = b.min.getComponent(axis)
  const size = b.max.getComponent(axis) - min
  return [min, size > 1e-6 ? size : 1]
}
function applyTaper(geo: THREE.BufferGeometry, amount: number, axis: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [min, size] = extentOf(geo, axis)
  const p1 = (axis + 1) % 3
  const p2 = (axis + 2) % 3
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getComponent(i, axis) - min) / size
    const s = Math.max(0, 1 + amount * (t - 0.5) * 2)
    pos.setComponent(i, p1, pos.getComponent(i, p1) * s)
    pos.setComponent(i, p2, pos.getComponent(i, p2) * s)
  }
  pos.needsUpdate = true
}
function applyTwist(geo: THREE.BufferGeometry, degrees: number, axis: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [min, size] = extentOf(geo, axis)
  const p1 = (axis + 1) % 3
  const p2 = (axis + 2) % 3
  const total = (degrees * Math.PI) / 180
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getComponent(i, axis) - min) / size - 0.5
    const ang = total * t
    const cos = Math.cos(ang), sin = Math.sin(ang)
    const u = pos.getComponent(i, p1), v = pos.getComponent(i, p2)
    pos.setComponent(i, p1, u * cos - v * sin)
    pos.setComponent(i, p2, u * sin + v * cos)
  }
  pos.needsUpdate = true
}
function applyBend(geo: THREE.BufferGeometry, degrees: number, axis: number): void {
  const total = (degrees * Math.PI) / 180
  if (Math.abs(total) < 1e-6) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const lengthAxis = (axis + 2) % 3
  const bulgeAxis = (axis + 1) % 3
  const [min, size] = extentOf(geo, lengthAxis)
  const centre = min + size / 2
  const radius = size / total
  for (let i = 0; i < pos.count; i++) {
    const s = pos.getComponent(i, lengthAxis) - centre
    const b = pos.getComponent(i, bulgeAxis)
    const phi = s / radius
    const r = radius - b
    pos.setComponent(i, lengthAxis, r * Math.sin(phi))
    pos.setComponent(i, bulgeAxis, radius - r * Math.cos(phi))
  }
  pos.needsUpdate = true
}
function applyNoise(geo: THREE.BufferGeometry, amount: number, scale: number, seed: number): void {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals()
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const d = valueNoise(x * scale, y * scale, z * scale, seed) * amount
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d)
  }
  pos.needsUpdate = true
}
function applyJitter(geo: THREE.BufferGeometry, amount: number, mode: number, seed: number): void {
  if (mode === 1 && !geo.getAttribute('normal')) geo.computeVertexNormals()
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const Q = 4096
  const q = (n: number) => Math.round(n * Q)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const qx = q(x), qy = q(y), qz = q(z)
    if (mode === 1 && nrm) {
      const d = (hash3(qx, qy, qz, seed) * 2 - 1) * amount
      pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d)
    } else {
      const dx = (hash3(qx, qy, qz, seed) * 2 - 1) * amount
      const dy = (hash3(qx, qy, qz, seed + 1) * 2 - 1) * amount
      const dz = (hash3(qx, qy, qz, seed + 2) * 2 - 1) * amount
      pos.setXYZ(i, x + dx, y + dy, z + dz)
    }
  }
  pos.needsUpdate = true
}

// The pre-refactor `applyModifiers` body, verbatim (fixed subdivide→taper→twist→
// bend→noise→jitter→cloner order, guarded by !== 0). hasModifiers is inlined so the
// oracle does not depend on the new module's no-op decision.
function hasModifiersLegacy(modifiers: Record<string, number> | undefined): boolean {
  if (!modifiers) return false
  const m = (k: string) => modifierValue(modifiers, k)
  return m('taper') !== 0 || m('twist') !== 0 || m('bend') !== 0 || m('noise') !== 0 || m('jitter') !== 0 || totalClones(modifiers) > 1
}
function applyModifiersLegacy(
  geo: THREE.BufferGeometry,
  modifiers: Record<string, number> | undefined,
  vary?: VarySettings,
): THREE.BufferGeometry {
  if (!hasModifiersLegacy(modifiers)) return geo
  const m = (k: string) => modifierValue(modifiers, k)
  const taper = m('taper'), twist = m('twist'), bend = m('bend'), noise = m('noise'), jitter = m('jitter')
  const requested = totalClones(modifiers)
  const deforms = taper !== 0 || twist !== 0 || bend !== 0 || noise !== 0 || jitter !== 0
  let out = geo.clone()
  if (deforms) {
    const iterations = Math.round(m('subdivide'))
    const ceiling = VERTEX_BUDGET / Math.max(1, requested)
    for (let i = 0; i < iterations; i++) {
      if (out.getAttribute('position').count * 4 > ceiling) break
      const next = subdivideOnce(out)
      out.dispose()
      out = next
    }
  }
  if (taper !== 0) applyTaper(out, taper, Math.round(m('taperAxis')))
  if (twist !== 0) applyTwist(out, twist, Math.round(m('twistAxis')))
  if (bend !== 0) applyBend(out, bend, Math.round(m('bendAxis')))
  if (noise !== 0) applyNoise(out, noise, m('noiseScale'), Math.round(m('noiseSeed')))
  if (jitter !== 0) applyJitter(out, jitter, Math.round(m('jitterMode')), Math.round(m('jitterSeed')))
  if (deforms) {
    out.computeVertexNormals()
    out.computeBoundingBox()
    out.computeBoundingSphere()
  }
  const { count } = clampedClones(modifiers, out.getAttribute('position').count)
  if (count > 1) {
    const recipes = planClones(count, {
      mode: Math.round(m('cloneMode')),
      offset: [m('cloneOffsetX'), m('cloneOffsetY'), m('cloneOffsetZ')],
      radius: m('cloneRadius'),
      axis: Math.round(m('cloneAxis')),
      gridCount: [Math.round(m('cloneCountX')), Math.round(m('cloneCountY')), Math.round(m('cloneCountZ'))],
      spacing: [m('cloneSpacingX'), m('cloneSpacingY'), m('cloneSpacingZ')],
      stepRot: [m('cloneStepRotX'), m('cloneStepRotY'), m('cloneStepRotZ')],
      stepScale: m('cloneStepScale'),
    }, vary)
    const cloned = mergeClones(out, recipes)
    out.dispose()
    out = cloned
    out.computeBoundingBox()
    out.computeBoundingSphere()
  }
  return out
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A representative primitive set spanning the topologies the deform/subdivide
// helpers care about:
//  - box      indexed cuboid, few verts (exercises the subdivide re-weld and the
//             extent-based deforms on a shape with a clean bounding box);
//  - sphere   dense indexed, curved — every deform's per-vertex maths at scale;
//  - cylinder caps + side wall, an axis with real extent (taper/twist/bend along it);
//  - torus    fully closed genus-1 surface (bend wrapping, noise/jitter on a tube);
//  - extrude  irregular, bevelled, carries UVs — this stands in for text, which the
//             engine builds as ExtrudeGeometry too, so it covers the same code path.
function extrudeShape(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape()
  s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(0.5, 0.2)
  s.lineTo(0, 0.6); s.lineTo(-0.5, 0.2); s.closePath()
  return new THREE.ExtrudeGeometry(s, { depth: 0.4, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, steps: 2 })
}
const primitives: Record<string, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1.4, 0.8, 2, 3, 2),
  sphere: () => new THREE.SphereGeometry(0.8, 16, 12),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.7, 1.5, 16, 3),
  torus: () => new THREE.TorusGeometry(0.6, 0.22, 12, 20),
  extrude: () => extrudeShape(),
}

// The legacy bag matrix. Each entry is a plain flat bag exactly as an old scene stores.
const bags: Record<string, Record<string, number> | undefined> = {
  'taper': { taper: 0.6, taperAxis: 1 },
  'twist': { twist: 75, twistAxis: 1 },
  'bend': { bend: 60, bendAxis: 2 },
  'noise': { noise: 0.12, noiseScale: 3, noiseSeed: 7 },
  'jitter-random': { jitter: 0.08, jitterMode: 0, jitterSeed: 4 },
  'jitter-normal': { jitter: 0.08, jitterMode: 1, jitterSeed: 4 },
  'taper+twist': { taper: 0.4, taperAxis: 0, twist: 45, twistAxis: 1 },
  'twist+bend': { twist: 50, twistAxis: 1, bend: 40, bendAxis: 2 },
  'subdivide+twist': { subdivide: 2, twist: 90, twistAxis: 1 },
  'noise+jitter': { noise: 0.1, noiseScale: 2.5, noiseSeed: 3, jitter: 0.05, jitterMode: 1, jitterSeed: 9 },
  'full-bag': {
    subdivide: 1, taper: 0.3, taperAxis: 1, twist: 60, twistAxis: 1, bend: 30, bendAxis: 2,
    noise: 0.07, noiseScale: 2, noiseSeed: 5, jitter: 0.04, jitterMode: 0, jitterSeed: 1,
  },
  'cloner-linear': { cloneCount: 4, cloneMode: 0, cloneOffsetX: 1.2, cloneOffsetY: 0, cloneOffsetZ: 0 },
  'cloner-radial': { cloneCount: 6, cloneMode: 1, cloneRadius: 1.5, cloneAxis: 1 },
  'cloner-grid': { cloneMode: 2, cloneCountX: 2, cloneCountY: 2, cloneCountZ: 2, cloneSpacingX: 1.2, cloneSpacingY: 1.2, cloneSpacingZ: 1.2 },
  'cloner-steps': { cloneCount: 5, cloneMode: 0, cloneOffsetX: 1, cloneStepRotY: 20, cloneStepScale: 0.9 },
  'deform+cloner': { twist: 40, twistAxis: 1, subdivide: 1, cloneCount: 3, cloneMode: 0, cloneOffsetX: 1.3 },
  'subdivide-only(noop)': { subdivide: 4 },
  'all-zero(noop)': { taper: 0, twist: 0, bend: 0, noise: 0, jitter: 0, cloneCount: 1 },
  'undefined(noop)': undefined,
}

const positions = (g: THREE.BufferGeometry): Float32Array => g.getAttribute('position').array as Float32Array
/** Exact Float32 equality across the whole position buffer, returning the count of
 *  differing floats (0 ⇒ byte-identical) and the max absolute delta seen. */
function comparePositions(a: THREE.BufferGeometry, b: THREE.BufferGeometry): { lenEqual: boolean; diffs: number; maxDelta: number } {
  const pa = positions(a), pb = positions(b)
  if (pa.length !== pb.length) return { lenEqual: false, diffs: Math.max(pa.length, pb.length), maxDelta: Infinity }
  let diffs = 0, maxDelta = 0
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) { diffs++; maxDelta = Math.max(maxDelta, Math.abs((pa[i] as number) - (pb[i] as number))) }
  }
  return { lenEqual: true, diffs, maxDelta }
}

// ---------------------------------------------------------------------------
// Byte-identity: the wrapper reproduces the pre-refactor pipeline exactly.
// ---------------------------------------------------------------------------
describe('applyModifiers wrapper is byte-identical to the pre-refactor pipeline', () => {
  let combos = 0
  let worstDelta = 0
  for (const [primName, makeGeo] of Object.entries(primitives)) {
    for (const [bagName, bag] of Object.entries(bags)) {
      it(`${primName} × ${bagName}`, () => {
        const gOracle = makeGeo()
        const gNew = makeGeo()
        const outOracle = applyModifiersLegacy(gOracle, bag)
        const outNew = applyModifiers(gNew, bag)
        const cmp = comparePositions(outOracle, outNew)
        expect(cmp.lenEqual).toBe(true)
        expect(cmp.diffs).toBe(0)
        combos++
        worstDelta = Math.max(worstDelta, cmp.maxDelta)
      })
    }
  }
  it('covered the full primitive × bag matrix with zero deltas', () => {
    expect(combos).toBe(Object.keys(primitives).length * Object.keys(bags).length)
    expect(worstDelta).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// No-op cases return the SAME geometry object (byte-identity depends on it).
// ---------------------------------------------------------------------------
describe('no-op stacks return the same geometry object', () => {
  it('wrapper: undefined / all-zero / subdivide-only bags pass geo through unchanged', () => {
    const g1 = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifiers(g1, undefined)).toBe(g1)
    const g2 = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifiers(g2, { taper: 0, twist: 0, cloneCount: 1 })).toBe(g2)
    const g3 = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifiers(g3, { subdivide: 4 })).toBe(g3)
  })
  it('stack: an empty stack, and a stack of only disabled rows, pass geo through', () => {
    const g1 = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g1, [])).toBe(g1)
    const disabled = createModifier('twist'); disabled.twist = 90; disabled.enabled = false
    const g2 = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g2, [disabled])).toBe(g2)
  })
})

// ---------------------------------------------------------------------------
// The stack genuinely reorders and duplicates.
// ---------------------------------------------------------------------------
const twistRow = (deg: number, axis = 1): ModifierInstance => {
  const r = createModifier('twist'); r.twist = deg; r.twistAxis = axis; return r
}
const bendRow = (deg: number, axis = 2): ModifierInstance => {
  const r = createModifier('bend'); r.bend = deg; r.bendAxis = axis; return r
}

describe('the stack applies deform rows in list order', () => {
  it('two twists in a stack change the geometry beyond a single twist', () => {
    const one = applyModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 2, 20, 6), [twistRow(45)])
    const two = applyModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 2, 20, 6), [twistRow(45), twistRow(45)])
    const cmp = comparePositions(one, two)
    expect(cmp.lenEqual).toBe(true)
    expect(cmp.diffs).toBeGreaterThan(0)
    // Two 45° twists compose to a single 90° twist (each twist rotates by total·t about the
    // same axis, and twisting leaves the axis extent unchanged so t is stable). They match to
    // within float accumulation — proving BOTH rows applied rather than one being dropped.
    const ninety = applyModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 2, 20, 6), [twistRow(90)])
    const compose = comparePositions(two, ninety)
    expect(compose.lenEqual).toBe(true)
    expect(compose.maxDelta).toBeLessThan(1e-5)
    // And clearly closer to the 90° twist than a single 45° twist is (both applied).
    expect(compose.maxDelta).toBeLessThan(comparePositions(one, ninety).maxDelta)
  })

  it('twist-then-bend differs from bend-then-twist (order is not re-sorted)', () => {
    const tb = applyModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 2, 20, 6), [twistRow(90), bendRow(60)])
    const bt = applyModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 2, 20, 6), [bendRow(60), twistRow(90)])
    const cmp = comparePositions(tb, bt)
    expect(cmp.lenEqual).toBe(true)
    expect(cmp.diffs).toBeGreaterThan(0)
  })

  it('a folded legacy bag matches the equivalent hand-built canonical stack', () => {
    const bag = { subdivide: 1, twist: 60, twistAxis: 1, bend: 30, bendAxis: 2 }
    const viaBag = applyModifiers(new THREE.BoxGeometry(1, 1.4, 0.8, 2, 3, 2), bag)
    const viaStack = applyModifierStack(new THREE.BoxGeometry(1, 1.4, 0.8, 2, 3, 2), modifierStackOf({ modifiers: bag }))
    expect(comparePositions(viaBag, viaStack).diffs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// enabled:false deform counts as ABSENT (no subdivide, no normals recompute path).
// ---------------------------------------------------------------------------
describe('disabled rows are skipped', () => {
  it('a disabled deform beside a cloner leaves the cloner running with no subdivision', () => {
    const disabledTwist = createModifier('twist'); disabledTwist.twist = 90; disabledTwist.enabled = false
    const sub = createModifier('subdivide'); sub.subdivide = 3
    const cloner = createModifier('cloner'); cloner.cloneCount = 3; cloner.cloneMode = 0; cloner.cloneOffsetX = 1.2
    const stack: ModifierInstance[] = [sub, disabledTwist, cloner]
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), stack)
    // No enabled deform ⇒ subdivide must NOT run: 3 clones of a 1×1×1 box are exactly
    // 3 × the base vertex count, so any subdivision would multiply this.
    const base = new THREE.BoxGeometry(1, 1, 1).getAttribute('position').count
    expect(out.getAttribute('position').count).toBe(base * 3)
  })
})

// ---------------------------------------------------------------------------
// mirror — the first geometry PRODUCER. It duplicates the shape, reflects the
// copy across a plane, flips winding so faces stay outward, and welds the seam.
// These prove it duplicates (vertex count), reflects (symmetric bounds), keeps
// faces outward (sampled face normals), compounds across axes, is skipped when
// disabled, and that a producer still leaves the pipeline's bounds recomputed.
// ---------------------------------------------------------------------------
const mirrorRow = (axis = 0, offset = 0): ModifierInstance => {
  const r = createModifier('mirror'); r.mirrorAxis = axis; r.mirrorOffset = offset; return r
}
/** Every indexed triangle as [aPos, bPos, cPos]. */
function triangles(geo: THREE.BufferGeometry): [THREE.Vector3, THREE.Vector3, THREE.Vector3][] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const idx = geo.index
  const out: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = []
  const n = idx ? idx.count : pos.count
  for (let i = 0; i + 3 <= n; i += 3) {
    const g = (o: number) => idx ? idx.getX(i + o) : i + o
    out.push([
      new THREE.Vector3().fromBufferAttribute(pos, g(0)),
      new THREE.Vector3().fromBufferAttribute(pos, g(1)),
      new THREE.Vector3().fromBufferAttribute(pos, g(2)),
    ])
  }
  return out
}

describe('mirror producer', () => {
  it('doubles the vertex count when the halves do not overlap (across X, offset far)', () => {
    // offset 1 pushes the copy to [1.5,2.5]: the two welded halves share no seam, so the result
    // is exactly 2× a single welded half. `applyMirror` welds each half on position+uv (normals
    // dropped), so the expected half count is mergeVertices of a normal-stripped non-indexed box.
    const oneHalf = (() => { const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed(); g.deleteAttribute('normal'); return mergeVertices(g) })()
    const expected = oneHalf.getAttribute('position').count * 2
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, 1)])
    expect(out.getAttribute('position').count).toBe(expected)
  })

  it('yields bounds symmetric about x = offset', () => {
    for (const offset of [0, 0.3, -0.4]) {
      const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, offset)])
      out.computeBoundingBox()
      const b = out.boundingBox!
      const mid = (b.min.x + b.max.x) / 2
      expect(Math.abs(mid - offset)).toBeLessThan(1e-5)
    }
  })

  it('recomputes bounds after a producer runs (boundingBox present)', () => {
    const out = applyModifierStack(new THREE.SphereGeometry(0.8, 12, 8), [mirrorRow(1, 0.5)])
    expect(out.boundingBox).not.toBeNull()
    expect(out.boundingSphere).not.toBeNull()
  })

  it('keeps winding outward — every reflected face normal points away from its cube', () => {
    // Two separate unit cubes at centres (0,0,0) and (2,0,0) (offset 1 across X). For every
    // triangle the geometric (winding-derived) normal must point OUT of the cube it belongs to.
    // If the reflected half's winding were NOT flipped its faces would point inward (dot < 0).
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, 1)])
    const c1 = new THREE.Vector3(0, 0, 0), c2 = new THREE.Vector3(2, 0, 0)
    let checked = 0
    for (const [a, b, c] of triangles(out)) {
      const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize()
      const centroid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3)
      const centre = centroid.x < 1 ? c1 : c2
      const outward = new THREE.Vector3().subVectors(centroid, centre)
      expect(normal.dot(outward)).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('two mirror rows on different axes compound', () => {
    const oneAxis = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, 1)])
    const twoAxes = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, 1), mirrorRow(1, 1)])
    // The second mirror duplicates the already-mirrored geometry, so the count grows again.
    expect(twoAxes.getAttribute('position').count).toBe(oneAxis.getAttribute('position').count * 2)
    twoAxes.computeBoundingBox()
    const b = twoAxes.boundingBox!
    expect(Math.abs((b.min.x + b.max.x) / 2 - 1)).toBeLessThan(1e-5) // symmetric about x = 1
    expect(Math.abs((b.min.y + b.max.y) / 2 - 1)).toBeLessThan(1e-5) // and about y = 1
  })

  it('a disabled mirror row is skipped (no-op returns the same geometry)', () => {
    const disabled = mirrorRow(0, 1); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })

  it('subdivide runs before a mirror-only stack, so the copy inherits the finer mesh', () => {
    // A producer counts as a middle row, so subdivide (pinned first) runs: the pre-subdivide box
    // is 24 verts; one subdivide quadruples faces, and mirror (offset far) then doubles it.
    const sub = createModifier('subdivide'); sub.subdivide = 1
    const plain = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [mirrorRow(0, 1)])
    const subdivided = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [sub, mirrorRow(0, 1)])
    expect(subdivided.getAttribute('position').count).toBeGreaterThan(plain.getAttribute('position').count)
  })
})
