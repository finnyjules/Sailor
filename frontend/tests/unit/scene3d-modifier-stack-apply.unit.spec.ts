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

// ---------------------------------------------------------------------------
// S2 Task 2 — in-place deformers: shear, spherify, smooth (Laplacian), melt.
// Each mutates positions and MUST leave the vertex count unchanged. A deform-only
// stack never welds, so positions stay in the base geometry's order and can be
// compared index-for-index against a fresh copy of the same primitive.
// ---------------------------------------------------------------------------
const shearRow = (pair = 0, amount = 0): ModifierInstance => {
  const r = createModifier('shear'); r.shearAxis = pair; r.shear = amount; return r
}
const spherifyRow = (amount = 0): ModifierInstance => {
  const r = createModifier('spherify'); r.spherify = amount; return r
}
const smoothRow = (strength = 0, iterations = 1): ModifierInstance => {
  const r = createModifier('smooth'); r.smoothStrength = strength; r.smoothIterations = iterations; return r
}
const meltRow = (amount = 0, axis = 1): ModifierInstance => {
  const r = createModifier('melt'); r.melt = amount; r.meltAxis = axis; return r
}
const latticeRow = (bulge = 0, axis = 1, bias = 0): ModifierInstance => {
  const r = createModifier('lattice'); r.latticeBulge = bulge; r.latticeAxis = axis; r.latticeBias = bias; return r
}
/** Distinct vertex positions, rounded to 4 decimals — the same tolerance `applySmooth` welds on. */
function countDistinct(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  const s = new Set<string>()
  for (let i = 0; i < p.count; i++) {
    s.add(`${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`)
  }
  return s.size
}

describe('shear deformer', () => {
  it('displaces the moved axis proportional to the drive axis (floor unmoved), count unchanged', () => {
    const base = new THREE.BoxGeometry(1, 1, 1)
    const bp = base.getAttribute('position') as THREE.BufferAttribute
    // shearAxis 0 = 'xy': X moves proportional to Y, measured from the Y minimum (-0.5).
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shearRow(0, 0.5)])
    const op = out.getAttribute('position') as THREE.BufferAttribute
    expect(op.count).toBe(bp.count)
    const minY = -0.5
    for (let i = 0; i < bp.count; i++) {
      expect(op.getX(i)).toBeCloseTo(bp.getX(i) + 0.5 * (bp.getY(i) - minY), 5)
      expect(op.getY(i)).toBeCloseTo(bp.getY(i), 5) // drive + third axes untouched
      expect(op.getZ(i)).toBeCloseTo(bp.getZ(i), 5)
    }
    // A bottom-face vertex (Y = min) is unmoved in X; a top-face one is displaced by amount·extent.
    const topX: number[] = [], botX: number[] = []
    for (let i = 0; i < bp.count; i++) {
      if (Math.abs(bp.getY(i) - 0.5) < 1e-6) topX.push(op.getX(i) - bp.getX(i))
      if (Math.abs(bp.getY(i) + 0.5) < 1e-6) botX.push(op.getX(i) - bp.getX(i))
    }
    expect(botX.length).toBeGreaterThan(0)
    for (const d of botX) expect(d).toBeCloseTo(0, 6)
    for (const d of topX) expect(d).toBeCloseTo(0.5, 6)
  })
})

describe('spherify deformer', () => {
  // A plain cube has ONLY corner vertices, all already equidistant from the centre, so it
  // would spherify to itself. A segmented box carries face-centre, edge and corner vertices
  // at DIFFERENT radii — the honest input for a bulge-toward-a-ball test.
  const segBox = () => new THREE.BoxGeometry(1, 1, 1, 3, 3, 3)

  it('at 1 puts every vertex the same distance from the centre, count unchanged', () => {
    const base = segBox().getAttribute('position') as THREE.BufferAttribute
    const out = applyModifierStack(segBox(), [spherifyRow(1)])
    const p = out.getAttribute('position') as THREE.BufferAttribute
    expect(p.count).toBe(base.count)
    // The input genuinely spans several radii (else the assertion is vacuous).
    const rawDists: number[] = []
    for (let i = 0; i < base.count; i++) rawDists.push(Math.hypot(base.getX(i), base.getY(i), base.getZ(i)))
    expect(Math.max(...rawDists) - Math.min(...rawDists)).toBeGreaterThan(0.1)
    const dists: number[] = []
    for (let i = 0; i < p.count; i++) dists.push(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)))
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length
    expect(mean).toBeGreaterThan(0)
    for (const d of dists) expect(d).toBeCloseTo(mean, 4) // all on one sphere
  })

  it('at 0.5 lands partway — differs from both the box and the full sphere', () => {
    const box = segBox()
    const half = applyModifierStack(segBox(), [spherifyRow(0.5)])
    const full = applyModifierStack(segBox(), [spherifyRow(1)])
    expect(comparePositions(box, half).diffs).toBeGreaterThan(0) // moved off the box
    expect(comparePositions(half, full).diffs).toBeGreaterThan(0) // but not all the way
  })
})

describe('smooth (Laplacian) deformer', () => {
  it('shrinks the bounding box, and more iterations shrink it further; count unchanged', () => {
    const base = new THREE.BoxGeometry(1, 1, 1); base.computeBoundingBox()
    const baseSize = base.boundingBox!.getSize(new THREE.Vector3())
    const one = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [smoothRow(0.5, 1)])
    const five = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [smoothRow(0.5, 5)])
    expect(one.getAttribute('position').count).toBe(base.getAttribute('position').count)
    one.computeBoundingBox(); five.computeBoundingBox()
    const s1 = one.boundingBox!.getSize(new THREE.Vector3())
    const s5 = five.boundingBox!.getSize(new THREE.Vector3())
    expect(s1.x).toBeLessThan(baseSize.x)
    expect(s5.x).toBeLessThan(s1.x)
    expect(comparePositions(one, five).diffs).toBeGreaterThan(0) // iterations>1 differs from 1
  })

  it('welds coincident corners so a NON-INDEXED geometry stays watertight (no seam splitting)', () => {
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed()
    const distinctBefore = countDistinct(g)
    expect(g.index).toBeNull()
    const out = applyModifierStack(g, [smoothRow(0.5, 3)])
    // Same number of position entries (deformer, count unchanged) …
    expect(out.getAttribute('position').count).toBe(g.getAttribute('position').count)
    // … and the same number of DISTINCT corners: coincident vertices moved together.
    expect(countDistinct(out)).toBe(distinctBefore)
  })
})

describe('melt deformer', () => {
  it('at 1 drops the top to the floor and spreads the footprint wider; count unchanged', () => {
    const base = new THREE.BoxGeometry(1, 3, 1); base.computeBoundingBox()
    const bb = base.boundingBox!
    const out = applyModifierStack(new THREE.BoxGeometry(1, 3, 1), [meltRow(1, 1)]) // down = Y
    expect(out.getAttribute('position').count).toBe(base.getAttribute('position').count)
    out.computeBoundingBox()
    const ob = out.boundingBox!
    expect(ob.max.y).toBeLessThan(bb.max.y)          // top lowered
    expect(ob.max.y).toBeCloseTo(bb.min.y, 5)        // everything collapses to the floor at 1
    expect(ob.max.x - ob.min.x).toBeGreaterThan(bb.max.x - bb.min.x) // footprint spread wider …
    expect(ob.max.z - ob.min.z).toBeGreaterThan(bb.max.z - bb.min.z) // … in both cross axes
  })

  it('respects meltAxis — melting down X collapses the X extent, not Y', () => {
    const base = new THREE.BoxGeometry(3, 1, 1); base.computeBoundingBox()
    const bb = base.boundingBox!
    const out = applyModifierStack(new THREE.BoxGeometry(3, 1, 1), [meltRow(1, 0)]) // down = X
    out.computeBoundingBox()
    const ob = out.boundingBox!
    expect(ob.max.x).toBeCloseTo(bb.min.x, 5)         // collapsed along X
    expect(ob.max.y - ob.min.y).toBeGreaterThan(bb.max.y - bb.min.y) // spread along Y
  })
})

// ---------------------------------------------------------------------------
// S2 Task 5 — lattice cage deformer: a real 3×3×3 trilinear control cage driven
// by Bulge / Axis / Bias. A DEFORMER — vertex count unchanged, mutates in place.
// ---------------------------------------------------------------------------
describe('lattice cage deformer', () => {
  // A plain box has only 8 corner vertices at the cell boundaries — a segmented box carries
  // vertices across the whole cage, including the equator the bulge acts on.
  const segBox = () => new THREE.BoxGeometry(1, 2, 1, 4, 6, 4)
  // Radial distance from the bulge axis (Y) in the perpendicular (X,Z) plane.
  const radiusXZ = (p: THREE.BufferAttribute, i: number) => Math.hypot(p.getX(i), p.getZ(i))

  it('all dials zero → positions byte-identical to the input (identity)', () => {
    const base = segBox()
    const out = applyModifierStack(segBox(), [latticeRow(0, 1, 0)])
    const cmp = comparePositions(base, out)
    expect(cmp.lenEqual).toBe(true)
    expect(cmp.diffs).toBe(0)
  })

  it('bulge > 0 bows the equator outward while the end caps stay put (barrel); count unchanged', () => {
    const base = segBox().getAttribute('position') as THREE.BufferAttribute
    const out = applyModifierStack(segBox(), [latticeRow(0.8, 1, 0)]) // bulge about Y
    const p = out.getAttribute('position') as THREE.BufferAttribute
    expect(p.count).toBe(base.count)
    // Equator vertices (Y ≈ 0, the middle layer) move OUTWARD in the X/Z plane …
    let equatorTested = 0
    for (let i = 0; i < base.count; i++) {
      if (Math.abs(base.getY(i)) < 1e-6 && radiusXZ(base, i) > 1e-6) {
        expect(radiusXZ(p, i)).toBeGreaterThan(radiusXZ(base, i) + 1e-4)
        equatorTested++
      }
    }
    expect(equatorTested).toBeGreaterThan(0)
    // … while cap vertices (Y = ±1, the end layers along the axis) are unmoved.
    let capsTested = 0
    for (let i = 0; i < base.count; i++) {
      if (Math.abs(Math.abs(base.getY(i)) - 1) < 1e-6) {
        expect(p.getX(i)).toBeCloseTo(base.getX(i), 5)
        expect(p.getY(i)).toBeCloseTo(base.getY(i), 5)
        expect(p.getZ(i)).toBeCloseTo(base.getZ(i), 5)
        capsTested++
      }
    }
    expect(capsTested).toBeGreaterThan(0)
  })

  it('bulge < 0 pinches the equator inward (pincushion); count unchanged', () => {
    const base = segBox().getAttribute('position') as THREE.BufferAttribute
    const out = applyModifierStack(segBox(), [latticeRow(-0.8, 1, 0)])
    const p = out.getAttribute('position') as THREE.BufferAttribute
    expect(p.count).toBe(base.count)
    let tested = 0
    for (let i = 0; i < base.count; i++) {
      if (Math.abs(base.getY(i)) < 1e-6 && radiusXZ(base, i) > 1e-6) {
        expect(radiusXZ(p, i)).toBeLessThan(radiusXZ(base, i) - 1e-4)
        tested++
      }
    }
    expect(tested).toBeGreaterThan(0)
  })

  it('bias shifts the fattest cross-section toward one end of the axis', () => {
    // Widest radius per Y-layer: with no bias the peak sits at the middle; a positive bias lifts
    // the fattest ring toward the +Y end.
    const widestAt = (bias: number): number => {
      const out = applyModifierStack(segBox(), [latticeRow(0.8, 1, bias)])
      const p = out.getAttribute('position') as THREE.BufferAttribute
      let bestY = 0, bestR = -1
      for (let i = 0; i < p.count; i++) {
        const r = radiusXZ(p, i)
        if (r > bestR) { bestR = r; bestY = p.getY(i) }
      }
      return bestY
    }
    const centred = widestAt(0)
    const biasedUp = widestAt(0.9)
    const biasedDown = widestAt(-0.9)
    expect(Math.abs(centred)).toBeLessThan(0.25)   // symmetric bulge peaks near the equator
    expect(biasedUp).toBeGreaterThan(centred + 0.2) // fattest ring moves toward +Y
    expect(biasedDown).toBeLessThan(centred - 0.2)  // and toward −Y for a negative bias
  })

  it('respects latticeAxis — bulging about X leaves the X caps put and swells the middle', () => {
    const base = new THREE.BoxGeometry(2, 1, 1, 6, 4, 4).getAttribute('position') as THREE.BufferAttribute
    const out = applyModifierStack(new THREE.BoxGeometry(2, 1, 1, 6, 4, 4), [latticeRow(0.8, 0, 0)]) // axis X
    const p = out.getAttribute('position') as THREE.BufferAttribute
    // The X end caps (X = ±1) stay put …
    let caps = 0
    for (let i = 0; i < base.count; i++) {
      if (Math.abs(Math.abs(base.getX(i)) - 1) < 1e-6) {
        expect(p.getX(i)).toBeCloseTo(base.getX(i), 5)
        caps++
      }
    }
    expect(caps).toBeGreaterThan(0)
    // … while the mid-slice (X ≈ 0) bows outward in the Y/Z plane.
    let mids = 0
    for (let i = 0; i < base.count; i++) {
      if (Math.abs(base.getX(i)) < 1e-6 && Math.hypot(base.getY(i), base.getZ(i)) > 1e-6) {
        expect(Math.hypot(p.getY(i), p.getZ(i))).toBeGreaterThan(Math.hypot(base.getY(i), base.getZ(i)) + 1e-4)
        mids++
      }
    }
    expect(mids).toBeGreaterThan(0)
  })

  it('a disabled lattice row is skipped (no-op returns the same geometry object)', () => {
    const disabled = latticeRow(0.8, 1, 0); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })
})

describe('the new deformers each no-op when disabled', () => {
  it('a disabled shear / spherify / smooth / melt row returns the SAME geometry object', () => {
    for (const make of [() => shearRow(0, 0.5), () => spherifyRow(1), () => smoothRow(0.5, 3), () => meltRow(1, 1)]) {
      const row = make(); row.enabled = false
      const g = new THREE.BoxGeometry(1, 1, 1)
      expect(applyModifierStack(g, [row])).toBe(g)
    }
  })
})

// ---------------------------------------------------------------------------
// S2 Task 3 — geometry producers: radial array (N rotated copies about an axis)
// and shatter (per-face split + seeded outward offset). Each returns a NEW
// geometry with a changed vertex buffer, budget-clamped like mirror/the cloner.
// ---------------------------------------------------------------------------
const arrayRow = (count = 6, axis = 1, radius = 0): ModifierInstance => {
  const r = createModifier('array'); r.radialCount = count; r.radialAxis = axis; r.radialRadius = radius; return r
}
const shatterRow = (amount = 0, seed = 0): ModifierInstance => {
  const r = createModifier('shatter'); r.shatter = amount; r.shatterSeed = seed; return r
}

describe('radial array producer', () => {
  it('folds N copies into one geometry — vertex count is exactly N × base', () => {
    const base = new THREE.BoxGeometry(1, 1, 1).getAttribute('position').count
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [arrayRow(4, 1, 1)])
    expect(out.getAttribute('position').count).toBe(base * 4)
  })

  it('has the array axis N-fold rotational symmetry — every vertex maps onto another under a 1/N turn', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 0.6, 0.4), [arrayRow(4, 1, 1)]) // 4 copies about Y, offset out
    const pos = out.getAttribute('position') as THREE.BufferAttribute
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i))
    // Rotating the whole point set by 90° about Y must land every vertex on an existing vertex:
    // copy i's placement becomes copy (i+1)'s, and each copy is a clone of the same base.
    const axisVec = new THREE.Vector3(0, 1, 0)
    const turn = (Math.PI * 2) / 4
    for (const p of pts) {
      const r = p.clone().applyAxisAngle(axisVec, turn)
      const hit = pts.some((q) => q.distanceTo(r) < 1e-4)
      expect(hit).toBe(true)
    }
    // The offset ring is genuinely off-axis (else the symmetry test is vacuous): some vertex sits
    // more than half a unit out from the Y axis.
    expect(pts.some((p) => Math.hypot(p.x, p.z) > 0.5)).toBe(true)
    // 4 copies at 0/90/180/270° cancel: the centroid lies on the Y axis.
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length
    expect(Math.abs(cx)).toBeLessThan(1e-4)
    expect(Math.abs(cz)).toBeLessThan(1e-4)
  })

  it('a disabled array row is skipped (no-op returns the same geometry)', () => {
    const disabled = arrayRow(6, 1, 1); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })

  it('clamps the copy count to the vertex budget rather than blowing past it', () => {
    // A dense sphere whose base count makes 24 copies exceed VERTEX_BUDGET: the count is clamped to
    // the largest N with N × base ≤ budget, so the result is exactly that many copies of the base.
    const makeGeo = () => new THREE.SphereGeometry(1, 200, 120)
    const base = makeGeo().getAttribute('position').count
    const affordable = Math.floor(VERTEX_BUDGET / base)
    expect(affordable).toBeGreaterThan(1)
    expect(affordable).toBeLessThan(24) // the budget really does bite before the max count
    const out = applyModifierStack(makeGeo(), [arrayRow(24, 1, 1)])
    expect(out.getAttribute('position').count).toBe(base * affordable)
    expect(out.getAttribute('position').count).toBeLessThanOrEqual(VERTEX_BUDGET)
  })
})

describe('shatter producer', () => {
  it('makes the geometry non-indexed with 3 × triangleCount vertices and pushes faces outward', () => {
    const src = new THREE.BoxGeometry(1, 1, 1)
    const triCount = src.index!.count / 3
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0.5, 3)])
    expect(out.index).toBeNull()
    expect(out.getAttribute('position').count).toBe(triCount * 3)
    // Faces move OUTWARD: the mean vertex distance from the centre grows versus the base.
    const meanDist = (geo: THREE.BufferGeometry): number => {
      const p = geo.getAttribute('position') as THREE.BufferAttribute
      geo.computeBoundingBox()
      const b = geo.boundingBox!
      const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2
      let s = 0
      for (let i = 0; i < p.count; i++) s += Math.hypot(p.getX(i) - cx, p.getY(i) - cy, p.getZ(i) - cz)
      return s / p.count
    }
    expect(meanDist(out)).toBeGreaterThan(meanDist(new THREE.BoxGeometry(1, 1, 1)))
  })

  it('is deterministic — same seed identical, different seed differs', () => {
    const a = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0.5, 7)])
    const b = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0.5, 7)])
    const cmp = comparePositions(a, b)
    expect(cmp.lenEqual).toBe(true)
    expect(cmp.diffs).toBe(0)
    const c = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0.5, 8)])
    expect(comparePositions(a, c).diffs).toBeGreaterThan(0)
  })

  it('amount 0 leaves the geometry unchanged — never even converts to non-indexed', () => {
    // An enabled row is still a middle row, so the stack works on a clone; but applyShatter returns
    // early at amount 0, so the geometry stays indexed and its positions match the base exactly.
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0, 5)])
    expect(out.index).not.toBeNull()
    expect(comparePositions(out, new THREE.BoxGeometry(1, 1, 1)).diffs).toBe(0)
  })

  it('a disabled shatter row is skipped (no-op returns the same geometry)', () => {
    const disabled = shatterRow(0.5, 3); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })

  it('yields flat per-face normals — each triangle carries one constant normal after the pipeline recompute', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [shatterRow(0.4, 2)])
    const nrm = out.getAttribute('normal') as THREE.BufferAttribute
    expect(nrm).toBeTruthy()
    // Non-indexed + no shared vertices ⇒ computeVertexNormals gives all three of a triangle's
    // vertices the SAME normal (flat shading), the faceted look a shatter wants.
    for (let t = 0; t + 3 <= nrm.count; t += 3) {
      const n0 = new THREE.Vector3().fromBufferAttribute(nrm, t)
      const n1 = new THREE.Vector3().fromBufferAttribute(nrm, t + 1)
      const n2 = new THREE.Vector3().fromBufferAttribute(nrm, t + 2)
      expect(n0.distanceTo(n1)).toBeLessThan(1e-5)
      expect(n0.distanceTo(n2)).toBeLessThan(1e-5)
    }
  })
})

// ---------------------------------------------------------------------------
// S2 Task 4 — geometry producers via engines: decimate (three SimplifyModifier,
// welded + floored reduction) and voxelise (meshData → voxel remesh → geometry,
// resolution capped to the vertex budget, open input falls back to the input).
// ---------------------------------------------------------------------------
const decimateRow = (fraction = 0): ModifierInstance => {
  const r = createModifier('decimate'); r.decimate = fraction; return r
}
const voxeliseRow = (resolution = 0): ModifierInstance => {
  const r = createModifier('voxelise'); r.voxelResolution = resolution; return r
}
const triCount = (geo: THREE.BufferGeometry): number =>
  (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3

describe('decimate producer', () => {
  it('drops the triangle and vertex count on a subdivided box, bounds ~preserved', () => {
    const makeGeo = () => new THREE.BoxGeometry(1, 1, 1, 8, 8, 8)
    const base = makeGeo(); base.computeBoundingBox()
    const bb = base.boundingBox!
    const out = applyModifierStack(makeGeo(), [decimateRow(0.5)])
    expect(triCount(out)).toBeLessThan(triCount(base))
    expect(out.getAttribute('position').count).toBeLessThan(base.getAttribute('position').count)
    out.computeBoundingBox()
    const ob = out.boundingBox!
    // Simplification pulls the surface in a touch but the overall box is preserved.
    expect(ob.min.distanceTo(bb.min)).toBeLessThan(0.25)
    expect(ob.max.distanceTo(bb.max)).toBeLessThan(0.25)
  })

  it('carries UVs through the collapse and yields recomputed normals', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1, 8, 8, 8), [decimateRow(0.5)])
    const uv = out.getAttribute('uv') as THREE.BufferAttribute | undefined
    const nrm = out.getAttribute('normal') as THREE.BufferAttribute | undefined
    expect(nrm).toBeTruthy() // the pipeline recomputes normals after every producer
    expect(nrm!.count).toBe(out.getAttribute('position').count)
    if (uv) expect(uv.count).toBe(out.getAttribute('position').count) // no broken attribute shipped
  })

  it('floors the reduction so an over-decimate never collapses to nothing', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), [decimateRow(0.95)])
    expect(out.getAttribute('position').count).toBeGreaterThanOrEqual(12) // DECIMATE_MIN_VERTS
    expect(triCount(out)).toBeGreaterThanOrEqual(4)
  })

  it('fraction 0 leaves the geometry unchanged (positions identical to the base)', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1, 4, 4, 4), [decimateRow(0)])
    expect(comparePositions(out, new THREE.BoxGeometry(1, 1, 1, 4, 4, 4)).diffs).toBe(0)
  })

  it('is deterministic — the same fraction gives the same mesh', () => {
    const a = applyModifierStack(new THREE.BoxGeometry(1, 1, 1, 6, 6, 6), [decimateRow(0.4)])
    const b = applyModifierStack(new THREE.BoxGeometry(1, 1, 1, 6, 6, 6), [decimateRow(0.4)])
    const cmp = comparePositions(a, b)
    expect(cmp.lenEqual).toBe(true)
    expect(cmp.diffs).toBe(0)
  })

  it('a disabled decimate row is skipped (no-op returns the same geometry)', () => {
    const disabled = decimateRow(0.5); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })
})

describe('voxelise producer', () => {
  it('remeshes a closed box into a new geometry, bounds ~preserved', () => {
    const makeGeo = () => new THREE.BoxGeometry(1, 1, 1)
    const base = makeGeo(); base.computeBoundingBox()
    const bb = base.boundingBox!
    const out = applyModifierStack(makeGeo(), [voxeliseRow(16)])
    // A remesh is a genuinely different vertex buffer, not the base returned back.
    expect(out.getAttribute('position').count).not.toBe(base.getAttribute('position').count)
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    out.computeBoundingBox()
    const ob = out.boundingBox!
    expect(ob.min.distanceTo(bb.min)).toBeLessThan(0.3)
    expect(ob.max.distanceTo(bb.max)).toBeLessThan(0.3)
  })

  it('resolution 0 leaves the geometry unchanged', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [voxeliseRow(0)])
    expect(comparePositions(out, new THREE.BoxGeometry(1, 1, 1)).diffs).toBe(0)
  })

  it('returns the input for an open (non-watertight) surface — the remesh refuses it', () => {
    // A single-quad plane is not a closed surface, so the SDF is meaningless: voxelise falls back.
    const out = applyModifierStack(new THREE.PlaneGeometry(1, 1), [voxeliseRow(16)])
    expect(comparePositions(out, new THREE.PlaneGeometry(1, 1)).diffs).toBe(0)
  })

  it('caps the resolution so the remesh output stays under the vertex budget', () => {
    // At the maximum resolution (64, so 64³ < VERTEX_BUDGET) the surface-nets output must still fit.
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [voxeliseRow(64)])
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    expect(out.getAttribute('position').count).toBeLessThanOrEqual(VERTEX_BUDGET)
  })

  it('a disabled voxelise row is skipped (no-op returns the same geometry)', () => {
    const disabled = voxeliseRow(16); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled])).toBe(g)
  })
})

// ---------------------------------------------------------------------------
// Boolean producer — combines the shape with a SIBLING geometry supplied through
// `opts.ctx` (the engine resolves refObjectId → sibling geo, baked into local space).
// Every merge here works in a SHARED coordinate frame: the sibling is translated
// directly, standing in for the engine's local-space bake. A ctx-less call, or a ctx
// that resolves nothing, leaves the boolean a no-op.
// ---------------------------------------------------------------------------
const booleanRow = (op = 0, resolution = 24, blend = 0): ModifierInstance => {
  const r = createModifier('boolean')
  r.booleanOp = op; r.booleanResolution = resolution; r.booleanBlend = blend
  return r
}
const ctxOf = (sibling: THREE.BufferGeometry | null) => ({ siblingGeoFor: () => sibling })
const boundsOfGeo = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox! }

describe('boolean producer', () => {
  it('a ctx-less call leaves the boolean a no-op (positions unchanged)', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [booleanRow(0)]) // no opts.ctx
    expect(comparePositions(out, g).diffs).toBe(0)
  })

  it('a disabled boolean row is skipped entirely (same geometry object)', () => {
    const disabled = booleanRow(0); disabled.enabled = false
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [disabled], { ctx: ctxOf(new THREE.BoxGeometry(1, 1, 1)) })).toBe(g)
  })

  it('a ctx that resolves no sibling (null) is a no-op (positions unchanged)', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [booleanRow(0)], { ctx: ctxOf(null) })
    expect(comparePositions(out, g).diffs).toBe(0)
  })

  it('union grows the bounds to cover BOTH meshes in the shared frame', () => {
    const self = new THREE.BoxGeometry(1, 1, 1) // bounds [-0.5, 0.5]
    const sibling = new THREE.BoxGeometry(1, 1, 1).translate(0.6, 0, 0) // bounds [0.1, 1.1]
    const out = applyModifierStack(self, [booleanRow(0, 28)], { ctx: ctxOf(sibling) })
    expect(out).not.toBe(self)
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    const b = boundsOfGeo(out)
    // The union spans from the left box's min to the right box's max on X (fillet/grid softening
    // keeps this within a cell or so of the exact extents).
    expect(b.min.x).toBeLessThan(-0.3)
    expect(b.max.x).toBeGreaterThan(0.9)
    expect(Math.abs(b.min.y + 0.5)).toBeLessThan(0.2)
    expect(Math.abs(b.max.y - 0.5)).toBeLessThan(0.2)
  })

  it('subtract carves the sibling out of the base (the FIRST input), shrinking its extent', () => {
    const self = new THREE.BoxGeometry(1, 1, 1) // [-0.5, 0.5]
    const sibling = new THREE.BoxGeometry(1, 1, 1).translate(0.6, 0, 0) // removes the right side
    const out = applyModifierStack(self, [booleanRow(1, 28)], { ctx: ctxOf(sibling) })
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    const b = boundsOfGeo(out)
    // The right half is gone, so the max X pulls in well short of the original 0.5.
    expect(b.max.x).toBeLessThan(0.35)
    expect(b.min.x).toBeLessThan(-0.3) // the left side survives
  })

  it('intersect keeps only the overlap region', () => {
    const self = new THREE.BoxGeometry(1, 1, 1) // [-0.5, 0.5]
    const sibling = new THREE.BoxGeometry(1, 1, 1).translate(0.6, 0, 0) // overlap X ~[0.1, 0.5]
    const out = applyModifierStack(self, [booleanRow(2, 28)], { ctx: ctxOf(sibling) })
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    const b = boundsOfGeo(out)
    // Only the thin overlap slab remains: it sits on the positive-X side, well inside both boxes.
    expect(b.min.x).toBeGreaterThan(-0.2)
    expect(b.max.x).toBeLessThan(0.7)
  })

  it('an open (non-watertight) input falls back to the base unchanged', () => {
    // A single-quad plane has no interior, so the SDF is meaningless: mergeMeshes reports open and
    // applyBoolean returns the base untouched.
    const sibling = new THREE.BoxGeometry(1, 1, 1)
    const out = applyModifierStack(new THREE.PlaneGeometry(1, 1), [booleanRow(0, 24)], { ctx: ctxOf(sibling) })
    expect(comparePositions(out, new THREE.PlaneGeometry(1, 1)).diffs).toBe(0)
  })

  it('caps the merge against the COMBINED bounds so the output stays within budget', () => {
    // Two overlapping boxes whose union spans ~3 units — a combined bounds larger than either mesh
    // — merged at the maximum resolution. The cap (using the union bounds) must keep the output
    // within the vertex budget.
    const self = new THREE.BoxGeometry(2, 2, 2)
    const sibling = new THREE.BoxGeometry(2, 2, 2).translate(1, 0, 0)
    const out = applyModifierStack(self, [booleanRow(0, 64)], { ctx: ctxOf(sibling) })
    expect(out.getAttribute('position').count).toBeGreaterThan(0)
    expect(out.getAttribute('position').count).toBeLessThanOrEqual(VERTEX_BUDGET)
  }, 15000)
})

describe('facet producer', () => {
  const facetRow = (facetCount: number, facetJitter = 0, facetSeed = 0): ModifierInstance =>
    ({ ...createModifier('facet'), facetCount, facetJitter, facetSeed })
  const vcount = (g: THREE.BufferGeometry) => g.getAttribute('position').count

  it('a disabled facet row returns the input untouched (byte-identity)', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifierStack(g, [{ ...facetRow(60), enabled: false }])).toBe(g)
  })

  it('re-cuts the shape into a solid faceted hull with UVs implied by the pipeline', () => {
    const out = applyModifierStack(new THREE.BoxGeometry(1, 1, 1), [facetRow(80)])
    expect(vcount(out)).toBeGreaterThanOrEqual(12)
    // a real re-cut, not the passthrough box (24)
    expect(vcount(out)).toBeGreaterThan(24)
  })

  it('more facets adds vertices', () => {
    const low = vcount(applyModifierStack(new THREE.SphereGeometry(0.6, 24, 16), [facetRow(12)]))
    const high = vcount(applyModifierStack(new THREE.SphereGeometry(0.6, 24, 16), [facetRow(200)]))
    expect(high).toBeGreaterThan(low)
  })

  it('is deterministic per seed and varies with the seed under jitter', () => {
    const mk = (seed: number) => Array.from(
      applyModifierStack(new THREE.SphereGeometry(0.6, 24, 16), [facetRow(80, 0.5, seed)]).getAttribute('position').array,
    )
    expect(mk(3)).toEqual(mk(3))
    expect(mk(3)).not.toEqual(mk(7))
  })
})
