// Non-destructive geometry modifiers, applied CPU-side to the real vertices.
//
// This is deliberately NOT a vertex shader: passes.ts renders the depth and
// normal outputs with scene.overrideMaterial, so a shader deformation would be
// invisible in two of the three exported images. Raycasting (selection and the
// gizmo), bounding boxes, shadows and the gradient bbox uniforms all read real
// geometry too.
//
// Stage order: subdivide is pinned first and the cloner pinned last (structural —
// subdivide splits faces before anything deforms them, the cloner folds the finished
// geometry into copies). The deform stages between them (taper/twist/bend/noise/jitter)
// run in the STACK's list order, so twist-then-bend ≠ bend-then-twist and two twists
// both apply. A legacy flat bag folds to canonical order (`modifierStackOf`), which is
// this exact fixed sequence — that is what keeps `applyModifiers` byte-identical.
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js'
import { meshDataFromGeometry, geometryFromMeshData, type MeshData } from '~/lib/scene3d/mesh'
import { remesh, boundsOf } from '~/lib/scene3d/voxel'
import { mergeMeshes, type MergeOp } from '~/lib/scene3d/voxel/merge'
import { modifierValue, totalClones } from '~/lib/scene3d/primParams'
import { modifierStackOf, type ModifierInstance, type ModifierKind } from '~/lib/scene3d/modifierStack'
import { varyWeights, varyColorAt, varyStepFactor, type VarySettings } from '~/lib/vary'
import { stripAlpha } from '~/lib/color/convert'

/** Rough ceiling for the final merged geometry. `totalClones` (the doc value
 *  the panel shows back) is never reduced; subdivision stops early, and
 *  `clampedClones` below is the render-time guard on the cloner itself. */
const VERTEX_BUDGET = 300_000

// `totalClones` moved to primParams.ts — it is pure arithmetic over the modifier bag,
// with no three in it, and the inspector panel needs it to know whether the Cloner's cost
// readout has anything to say. Re-exported here so every existing caller is unaffected.
export { totalClones }

/** The clone count actually rendered, and whether the budget reduced it.
 *
 *  `totalClones` reports what the USER set and stays unclamped — the doc's
 *  value is the user's choice and the panel shows it back. This is the
 *  render-time guard on top: subdivision already yields to VERTEX_BUDGET, but
 *  the cloner never did, which was safe only while every base geometry was a
 *  few thousand vertices. A 40k-vertex `mesh` primitive at cloneCount 100 is
 *  4M vertices and hangs the tab.
 *
 *  Callers MUST surface `clamped` — the surface's clone-cost warning does. A
 *  silent reduction reads as a rendering bug. */
export function clampedClones(
  modifiers: Record<string, number> | undefined,
  baseVertexCount: number,
): { count: number; clamped: boolean } {
  const requested = totalClones(modifiers)
  if (baseVertexCount <= 0) return { count: requested, clamped: false }
  const affordable = Math.max(1, Math.floor(VERTEX_BUDGET / baseVertexCount))
  return affordable >= requested
    ? { count: requested, clamped: false }
    : { count: affordable, clamped: true }
}

export function hasModifiers(modifiers: Record<string, number> | undefined): boolean {
  if (!modifiers) return false
  const m = (k: string) => modifierValue(modifiers, k)
  // The cloner is active when it produces more than one copy, which lets grid
  // mode switch on from its own counts without touching cloneCount.
  return m('taper') !== 0 || m('twist') !== 0 || m('bend') !== 0 || m('noise') !== 0 || m('jitter') !== 0 || totalClones(modifiers) > 1
}

// --- deterministic 3D value noise (no dependency, stable across runs) --------

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(seed, 2654435761)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
const smooth = (t: number): number => t * t * (3 - 2 * t)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Value noise in [-1, 1]. */
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

// --- stages ------------------------------------------------------------------

/** Split every triangle into four at its edge midpoints, then re-weld so the
 *  result stays indexed and can still be shaded smoothly. */
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

/** Per-vertex extent helper: [min, size] along an axis, guarded against zero. */
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
    const t = (pos.getComponent(i, axis) - min) / size          // 0..1
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
    const t = (pos.getComponent(i, axis) - min) / size - 0.5     // -0.5..0.5
    const ang = total * t
    const cos = Math.cos(ang), sin = Math.sin(ang)
    const u = pos.getComponent(i, p1), v = pos.getComponent(i, p2)
    pos.setComponent(i, p1, u * cos - v * sin)
    pos.setComponent(i, p2, u * sin + v * cos)
  }
  pos.needsUpdate = true
}

/** Circular bend about `axis`: the shape curves along (axis+2)%3 and bulges
 *  along (axis+1)%3. The centre of the shape stays put. */
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

/** Per-vertex random displacement keyed on the (quantised) vertex position, so
 *  coincident/welded vertices move together and the mesh stays watertight — it
 *  just facets. Unlike valueNoise this does NOT interpolate, so neighbours are
 *  uncorrelated: sharp, crystalline facets rather than smooth lumps.
 *  mode 0 = random 3D direction; mode 1 = along the vertex normal. */
function applyJitter(geo: THREE.BufferGeometry, amount: number, mode: number, seed: number): void {
  if (mode === 1 && !geo.getAttribute('normal')) geo.computeVertexNormals()
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const Q = 4096 // quantisation: near-identical floats hash identically
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

/** Linear shear: displace `movedAxis` proportionally to how far the vertex sits along
 *  `driveAxis` (measured from that axis' minimum, so the bottom face is unmoved and the
 *  top slides by `amount · extent`). Unlike taper, which SCALES the cross-section, this
 *  is a pure skew — parallel faces stay parallel and the vertex count is untouched.
 *  `pair` indexes shearAxis' options ['xy','xz','yx','yz','zx','zy']: the first letter is
 *  the moved axis, the second the axis it slides along. */
const SHEAR_MOVED = [0, 0, 1, 1, 2, 2] // x x y y z z
const SHEAR_DRIVE = [1, 2, 0, 2, 0, 1] // y z x z x y
function applyShear(geo: THREE.BufferGeometry, amount: number, pair: number): void {
  if (amount === 0) return
  const p = ((Math.round(pair) % 6) + 6) % 6
  const moved = SHEAR_MOVED[p]!, drive = SHEAR_DRIVE[p]!
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [min] = extentOf(geo, drive)
  for (let i = 0; i < pos.count; i++) {
    const d = pos.getComponent(i, drive) - min
    pos.setComponent(i, moved, pos.getComponent(i, moved) + amount * d)
  }
  pos.needsUpdate = true
}

/** Spherify: lerp each vertex toward its projection on the object's bounding sphere by
 *  `amount` (0..1). Centre is the bbox centre; the RADIUS is the MEAN vertex distance from
 *  that centre — so at 1 every vertex lands on one sphere (a box bulges to a ball) and the
 *  result keeps roughly the original overall size rather than snapping to the single
 *  furthest corner (as a max-distance radius would). A vertex exactly at the centre has no
 *  direction to project and is left where it is. Vertex count unchanged. */
function applySpherify(geo: THREE.BufferGeometry, amount: number): void {
  if (amount === 0) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2
  let sum = 0
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx, dy = pos.getY(i) - cy, dz = pos.getZ(i) - cz
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  const radius = pos.count > 0 ? sum / pos.count : 0
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx, dy = pos.getY(i) - cy, dz = pos.getZ(i) - cz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-9) continue
    const s = radius / len
    // Target on the sphere: centre + dir·radius. Lerp from the current position by amount.
    pos.setXYZ(
      i,
      cx + dx * (1 + amount * (s - 1)),
      cy + dy * (1 + amount * (s - 1)),
      cz + dz * (1 + amount * (s - 1)),
    )
  }
  pos.needsUpdate = true
}

/** Laplacian smoothing: each vertex eases toward the average of its edge-neighbours,
 *  `strength` (0..1) per pass, `iterations` passes.
 *
 *  Adjacency is welded on a QUANTISED position key (4 decimals) so the many coincident
 *  corner vertices a BufferGeometry carries (a box has 24 positions for 8 real corners)
 *  collapse into one graph node and move together — smoothing on the raw attribute would
 *  treat those duplicates as isolated and never relax the seams. Edges come from the index
 *  when present; for a NON-INDEXED geometry every consecutive position triple is one
 *  triangle, so its three corners are pairwise neighbours. The relaxed node positions are
 *  written back to EVERY original vertex sharing that node, so the vertex count and the
 *  geometry's structure are untouched. */
function applySmooth(geo: THREE.BufferGeometry, strength: number, iterations: number): void {
  if (strength === 0 || iterations < 1) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  if (n === 0) return
  const Q = 1e4
  const keyOf = (i: number): string =>
    `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`

  // Map each original vertex to a graph node (first index seen for its key is the node id).
  const nodeOf = new Map<string, number>()
  const vertNode = new Int32Array(n)
  const nodePos: number[] = [] // flat xyz per node
  for (let i = 0; i < n; i++) {
    const k = keyOf(i)
    let id = nodeOf.get(k)
    if (id === undefined) {
      id = nodePos.length / 3
      nodeOf.set(k, id)
      nodePos.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    }
    vertNode[i] = id
  }
  const nodeCount = nodePos.length / 3

  // Neighbour node sets, from index triples (or consecutive triples when non-indexed).
  const neighbours: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>())
  const idx = geo.index
  const triCount = idx ? idx.count : n
  const corner = (t: number): number => (idx ? idx.getX(t) : t)
  for (let t = 0; t + 3 <= triCount; t += 3) {
    const a = vertNode[corner(t)]!, b = vertNode[corner(t + 1)]!, c = vertNode[corner(t + 2)]!
    if (a !== b) { neighbours[a]!.add(b); neighbours[b]!.add(a) }
    if (b !== c) { neighbours[b]!.add(c); neighbours[c]!.add(b) }
    if (a !== c) { neighbours[a]!.add(c); neighbours[c]!.add(a) }
  }

  // Relax the node positions in place, iteration by iteration (Jacobi: read the previous
  // pass, write the next), then push each node back onto every vertex that shares it.
  let cur = nodePos
  for (let it = 0; it < iterations; it++) {
    const next = cur.slice()
    for (let nd = 0; nd < nodeCount; nd++) {
      const nb = neighbours[nd]!
      if (nb.size === 0) continue
      let ax = 0, ay = 0, az = 0
      for (const m of nb) { ax += cur[m * 3]!; ay += cur[m * 3 + 1]!; az += cur[m * 3 + 2]! }
      const inv = 1 / nb.size
      const cx = cur[nd * 3]!, cy = cur[nd * 3 + 1]!, cz = cur[nd * 3 + 2]!
      next[nd * 3] = cx + strength * (ax * inv - cx)
      next[nd * 3 + 1] = cy + strength * (ay * inv - cy)
      next[nd * 3 + 2] = cz + strength * (az * inv - cz)
    }
    cur = next
  }

  for (let i = 0; i < n; i++) {
    const nd = vertNode[i]!
    pos.setXYZ(i, cur[nd * 3]!, cur[nd * 3 + 1]!, cur[nd * 3 + 2]!)
  }
  pos.needsUpdate = true
}

/** Melt: a gravity-weighted sag along `axis` (the "down" direction). The higher a vertex
 *  sits above the floor (that axis' minimum), the more it sinks toward the floor AND the
 *  more it spreads outward in the other two axes about their centre — so a tall shape
 *  slumps into a wide puddle. At `amount` 1 every vertex drops to the floor and the
 *  originally-tall material spreads to twice its width. Vertex count unchanged. */
function applyMelt(geo: THREE.BufferGeometry, amount: number, axis: number): void {
  if (amount === 0) return
  const ax = ((Math.round(axis) % 3) + 3) % 3
  const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [min, size] = extentOf(geo, ax)
  const b = geo.boundingBox! // extentOf just computed it
  const c1 = (b.min.getComponent(a1) + b.max.getComponent(a1)) / 2
  const c2 = (b.min.getComponent(a2) + b.max.getComponent(a2)) / 2
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getComponent(i, ax) - min       // height above the floor, 0..size
    const sink = amount * h                        // higher vertices sink further
    pos.setComponent(i, ax, pos.getComponent(i, ax) - sink)
    const spread = 1 + sink / size                 // 1 (base) .. 1+amount (top) → wider puddle
    pos.setComponent(i, a1, c1 + (pos.getComponent(i, a1) - c1) * spread)
    pos.setComponent(i, a2, c2 + (pos.getComponent(i, a2) - c2) * spread)
  }
  pos.needsUpdate = true
}

/** Lattice / cage DEFORMER: a real 3×3×3 trilinear control cage spanning the geometry's own
 *  bounding box. Each vertex is expressed as normalized (u,v,w) ∈ [0,1]³ within that box and
 *  replaced by the TRILINEAR blend of the 8 corner control points of the 2×2×2 cell it falls in
 *  — the exact interpolation that reproduces the input when the cage is undisplaced (identity).
 *
 *  The 27 control points are displaced PROCEDURALLY from three dials (an 81-slider hand-cage is
 *  unusable): `bulge` pushes the MIDDLE ring perpendicular to `axis` outward (+, barrel) or inward
 *  (−, pincushion); `bias` lifts one end layer's ring so the fattest cross-section shifts toward
 *  that end (asymmetric bulge). At bias 0 the two end caps along the axis stay put.
 *
 *  FOLLOW-UP: interactive on-canvas 3×3×3 cage handles (dragging the 27 control points directly)
 *  reuse this SAME trilinear engine — this task ships the engine plus the procedural dials.
 *
 *  DEFORMER: mutates positions in place, vertex count unchanged. Computes its OWN bbox at entry
 *  because the pipeline's bbox recompute runs AFTER the middle loop (so geo.boundingBox may be
 *  stale/null here). bulge 0 returns early so the identity stays byte-identical. */
function applyLattice(geo: THREE.BufferGeometry, bulge: number, axis: number, bias: number): void {
  if (bulge === 0) return // undisplaced cage is the identity — keep positions byte-identical
  const ax = ((Math.round(axis) % 3) + 3) % 3
  const p1 = (ax + 1) % 3
  const p2 = (ax + 2) % 3
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  const min = [b.min.x, b.min.y, b.min.z]
  const size = [
    Math.max(b.max.x - b.min.x, 1e-6),
    Math.max(b.max.y - b.min.y, 1e-6),
    Math.max(b.max.z - b.min.z, 1e-6),
  ]

  // Radial gain: at bulge 1 the peak ring's outer control points move out by a quarter of the
  // shape's width — a strong but bounded barrel.
  const K = 0.5
  // How strongly each of the 3 layers ALONG the axis bulges. `bias` slides the peak of a tent
  // profile from the middle (bias 0) toward an end (bias ±1): peak position runs 0..2 along the
  // axis, and each layer's weight falls off linearly with its distance from that peak. At bias 0
  // the peak is the middle layer and BOTH end caps have zero weight (a symmetric barrel/pincushion
  // that leaves the caps put); a nonzero bias lifts one end layer's ring so the fattest
  // cross-section shifts toward that end (asymmetric bulge).
  const peak = 1 + Math.max(-1, Math.min(1, bias)) // 0 = bottom layer, 1 = middle, 2 = top
  const layerWeight = (lay: number): number => Math.max(0, 1 - Math.abs(lay - peak))

  // 27 control points, cp[i][j][k] (each 0..2) → [x,y,z], starting on the undisplaced grid and
  // displaced radially in the perpendicular plane by the dials.
  const cp: number[][][][] = []
  for (let i = 0; i < 3; i++) {
    cp[i] = []
    for (let j = 0; j < 3; j++) {
      cp[i]![j] = []
      for (let k = 0; k < 3; k++) {
        const grid = [i, j, k]
        const base = [
          min[0]! + (i / 2) * size[0]!,
          min[1]! + (j / 2) * size[1]!,
          min[2]! + (k / 2) * size[2]!,
        ]
        const lay = grid[ax]!        // 0..2 position along the bulge axis
        const d1 = grid[p1]! - 1     // -1,0,1 radial offset in the perpendicular plane
        const d2 = grid[p2]! - 1
        const w = bulge * layerWeight(lay) * K
        base[p1]! += d1 * (size[p1]! / 2) * w
        base[p2]! += d2 * (size[p2]! / 2) * w
        cp[i]![j]![k] = base
      }
    }
  }

  // Trilinear deform: for each vertex find its (u,v,w) within the box and the 2×2×2 cell it lands
  // in, then blend the 8 corner control points. With the undisplaced cage this is exactly the
  // input — the identity guaranteed by the early return above.
  const cellOf = (t: number): [number, number] => {
    const s = Math.min(Math.max(t, 0), 1) * 2 // 0..2, clamped so out-of-box verts stay in a cell
    const c = Math.min(Math.floor(s), 1)      // cell 0 or 1
    return [c, s - c]                          // [cellIndex, fraction 0..1]
  }
  for (let v = 0; v < pos.count; v++) {
    const [ci, fi] = cellOf((pos.getX(v) - min[0]!) / size[0]!)
    const [cj, fj] = cellOf((pos.getY(v) - min[1]!) / size[1]!)
    const [ck, fk] = cellOf((pos.getZ(v) - min[2]!) / size[2]!)
    let ox = 0, oy = 0, oz = 0
    for (let di = 0; di < 2; di++) {
      const wi = di === 0 ? 1 - fi : fi
      for (let dj = 0; dj < 2; dj++) {
        const wj = dj === 0 ? 1 - fj : fj
        for (let dk = 0; dk < 2; dk++) {
          const wk = dk === 0 ? 1 - fk : fk
          const wgt = wi * wj * wk
          const P = cp[ci + di]![cj + dj]![ck + dk]!
          ox += P[0]! * wgt
          oy += P[1]! * wgt
          oz += P[2]! * wgt
        }
      }
    }
    pos.setXYZ(v, ox, oy, oz)
  }
  pos.needsUpdate = true
}

// --- geometry producers ------------------------------------------------------

/** Reverse the winding of every triangle in a NON-INDEXED geometry by swapping the first and
 *  third vertex of each triple across every attribute. A reflection is orientation-reversing,
 *  so the reflected copy's faces would point inward; flipping the winding back makes
 *  `computeVertexNormals` derive OUTWARD normals again for it. */
function reverseWinding(geo: THREE.BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.getAttribute(name) as THREE.BufferAttribute
    const size = attr.itemSize
    const arr = attr.array as ArrayLike<number> & { [i: number]: number }
    for (let t = 0; t + 3 <= attr.count; t += 3) {
      for (let k = 0; k < size; k++) {
        const i0 = t * size + k
        const i2 = (t + 2) * size + k
        const tmp = arr[i0]!
        arr[i0] = arr[i2]!
        arr[i2] = tmp
      }
    }
    attr.needsUpdate = true
  }
}

/** Mirror PRODUCER: duplicate the geometry, reflect the copy across the plane `coord = offset`
 *  on `axis` (c' = 2·offset − c), flip that copy's winding so its faces stay outward, merge the
 *  two halves and weld the shared seam with `mergeVertices`. Returns a NEW geometry (pre-weld it
 *  is double the vertex count); normals are dropped so the seam welds on position/uv alone and
 *  are recomputed once by the pipeline. Over the vertex budget it is a no-op (returns `geo`),
 *  exactly as the cloner clamps rather than freezing the tab. */
function applyMirror(geo: THREE.BufferGeometry, axis: number, offset: number): THREE.BufferGeometry {
  const ax = ((Math.round(axis) % 3) + 3) % 3
  // The merge runs on toNonIndexed() copies (~6× the unique count for a manifold),
  // so measure the real pre-weld output — the non-indexed count, doubled — like
  // radial/shatter/voxelise gate on their true output, not the indexed vertex count.
  if ((geo.index?.count ?? geo.getAttribute('position').count) * 2 > VERTEX_BUDGET) return geo

  const original = geo.index ? geo.toNonIndexed() : geo.clone()
  const flipped = geo.index ? geo.toNonIndexed() : geo.clone()
  const fp = flipped.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < fp.count; i++) fp.setComponent(i, ax, 2 * offset - fp.getComponent(i, ax))
  fp.needsUpdate = true
  reverseWinding(flipped)

  // Weld on position (+uv) alone — stale/flipped normals would keep coincident seam vertices
  // apart. The pipeline runs computeVertexNormals after any producer, so fresh normals return.
  original.deleteAttribute('normal')
  flipped.deleteAttribute('normal')
  const merged = mergeGeometries([original, flipped], false)
  original.dispose()
  flipped.dispose()
  if (!merged) return geo
  const welded = mergeVertices(merged)
  if (welded !== merged) merged.dispose()
  return welded
}

/** Radial array PRODUCER: repeat the geometry `count` times evenly rotated about `axis` through
 *  the origin, each copy first pushed `radius` outward from that axis (0 = rotate in place). It
 *  reuses `planClones`' radial recipe (mode 1: translate outward on (axis+1)%3, then spin by
 *  i/count·2π about the axis) and `mergeClones` to fold the copies into ONE geometry — the same
 *  path the pinned cloner's radial mode takes, but run here in the orderable middle so later
 *  rows (and the cloner itself) see the arrayed result. Copies rarely share vertices, so it does
 *  not weld — a plain merge, whose position count is exactly count × the base.
 *
 *  BUDGET: like the cloner, the copy count is clamped so count × baseVertexCount never exceeds
 *  VERTEX_BUDGET; if the budget cannot even afford two copies it is a no-op (returns `geo`),
 *  exactly as mirror yields rather than freezing the tab. Returns a NEW geometry. */
function applyRadialArray(geo: THREE.BufferGeometry, count: number, axis: number, radius: number): THREE.BufferGeometry {
  const requested = Math.max(2, Math.min(24, Math.round(count)))
  const base = geo.getAttribute('position').count
  if (base <= 0) return geo
  const affordable = Math.max(1, Math.floor(VERTEX_BUDGET / base))
  const n = Math.min(requested, affordable)
  if (n < 2) return geo // budget cannot afford even two copies → leave the geometry untouched
  const recipes = planClones(n, {
    mode: 1,
    offset: [0, 0, 0],
    radius,
    axis: ((Math.round(axis) % 3) + 3) % 3,
    gridCount: [1, 1, 1],
    spacing: [0, 0, 0],
    stepRot: [0, 0, 0],
    stepScale: 1,
  })
  // mergeClones clones `geo` per recipe and merges; it never disposes `geo` (the caller does).
  return mergeClones(geo, recipes)
}

/** Shatter / explode PRODUCER: split every triangle into an independent face and push it OUTWARD
 *  along its own face normal by a seeded amount, for an exploded-faces look. The geometry is made
 *  non-indexed (`toNonIndexed`) so each face owns its three vertices and can move alone; the
 *  offset per face is `amount × jitter` where `jitter ∈ [0.5, 1]` from a deterministic hash of the
 *  face index and `seed`, so every face separates (never a zero offset) yet the result is stable
 *  across runs. Faces are NOT welded — the vertex count is exactly 3 × triangleCount.
 *
 *  NORMALS: left to the pipeline's `computeVertexNormals`. Because the output is non-indexed and
 *  no vertices are shared, that recompute assigns each vertex its own triangle's face normal —
 *  i.e. FLAT per-face shading, which is exactly the faceted look a shatter wants, so no separate
 *  flat-normal pass is needed.
 *
 *  BUDGET: the non-indexed count is known before converting (index.count, or the existing position
 *  count when already non-indexed); over VERTEX_BUDGET it is a no-op (returns `geo`). `amount ≤ 0`
 *  is also a no-op returning `geo` unchanged. Returns a NEW geometry when it fires. */
function applyShatter(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  if (amount <= 0) return geo
  const nonIndexedCount = geo.index ? geo.index.count : geo.getAttribute('position').count
  if (nonIndexedCount > VERTEX_BUDGET) return geo

  // `src` is a new geometry when `geo` was indexed; when already non-indexed toNonIndexed returns
  // `geo` itself, so clone to avoid mutating the caller's geometry in place.
  const src = geo.index ? geo.toNonIndexed() : geo.clone()
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3()
  for (let t = 0; t + 3 <= pos.count; t += 3) {
    a.fromBufferAttribute(pos, t)
    b.fromBufferAttribute(pos, t + 1)
    c.fromBufferAttribute(pos, t + 2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    nrm.crossVectors(ab, ac)
    if (nrm.lengthSq() < 1e-20) continue // degenerate triangle: no direction to explode along
    nrm.normalize()
    // Seeded per-face displacement in [0.5, 1]·amount so every face separates, deterministically.
    const d = amount * (0.5 + 0.5 * hash3(t / 3, 0, 0, Math.round(seed)))
    for (let k = 0; k < 3; k++) {
      pos.setXYZ(t + k, pos.getX(t + k) + nrm.x * d, pos.getY(t + k) + nrm.y * d, pos.getZ(t + k) + nrm.z * d)
    }
  }
  pos.needsUpdate = true
  return src
}

/** Decimate PRODUCER: reduce the triangle count with three's `SimplifyModifier` (quadric edge
 *  collapse). `fraction` is the share of vertices to REMOVE (0 = no-op, capped at 0.95). The
 *  geometry is welded first (`mergeVertices`) because the simplifier needs shared topology — a
 *  box's 24 split corners would otherwise collapse nothing. Normals are dropped before welding so
 *  coincident corners actually merge (the pipeline recomputes normals after every producer);
 *  UVs are kept and this build of SimplifyModifier carries them through the collapse.
 *
 *  FLOORED so it never collapses the shape to nothing: `removeCount` keeps at least MIN_VERTS
 *  (12 verts ≈ 4 faces) alive. A fraction that resolves to `removeCount ≤ 0` (or the mesh is
 *  already at the floor) is a no-op returning `geo`. It only reduces, so there is no budget
 *  concern. Returns a NEW geometry when it fires. */
const DECIMATE_MIN_VERTS = 12
function applyDecimate(geo: THREE.BufferGeometry, fraction: number): THREE.BufferGeometry {
  const f = Math.max(0, Math.min(0.95, fraction))
  if (f <= 0) return geo

  const src = geo.clone()
  src.deleteAttribute('normal') // recomputed by the pipeline; lets coincident corners weld
  const welded = mergeVertices(src)
  src.dispose()

  const count = welded.getAttribute('position').count
  const removeCount = Math.min(Math.floor(count * f), count - DECIMATE_MIN_VERTS)
  if (removeCount <= 0) { welded.dispose(); return geo } // nothing usable to remove → leave it

  const simplified = new SimplifyModifier().modify(welded, removeCount)
  welded.dispose()
  return simplified
}

/** Voxelise PRODUCER: remesh the shape through the voxel SDF at `resolution` cells along its
 *  longest axis, giving a uniform, chunky, watertight remesh (the same engine the Remesh action
 *  and Merge use). `resolution` 0 = no-op. Steps: `meshDataFromGeometry` → `remesh(data, res)` →
 *  `geometryFromMeshData`.
 *
 *  BUDGET — the resolution is capped BEFORE remeshing. Surface nets allocates an SDF lattice of
 *  ~resolution³ cells, so the cap uses the conservative res³ output estimate: VOXEL_RESOLUTION_MAX
 *  = 64 because 64³ = 262,144 < VERTEX_BUDGET (300,000). The actual surface-nets output scales with
 *  surface area (~resolution²) and is far lower, so this is a safe ceiling with headroom. The param
 *  spec's max is the same 64, so the slider has no dead range; this internal clamp is the true
 *  guarantee regardless of a stored value.
 *
 *  FALLBACK — an open / non-watertight input (a plane, a shell) makes the SDF meaningless, so
 *  `remesh` reports `open: true` and returns the data UNCHANGED; we return `geo` untouched rather
 *  than shipping a mangled mesh. Returns a NEW geometry only when it actually remeshes. */
const VOXEL_RESOLUTION_MAX = 64
function applyVoxelise(geo: THREE.BufferGeometry, resolution: number): THREE.BufferGeometry {
  const res = Math.min(VOXEL_RESOLUTION_MAX, Math.round(resolution))
  if (res < 1) return geo // 0 = no-op

  const data = meshDataFromGeometry(geo)
  const { data: out, open } = remesh(data, res)
  if (open) return geo // non-watertight input: remesh bailed → leave the shape untouched
  return geometryFromMeshData(out)
}

/** The three boolean ops, indexed to match `booleanOp`'s spec options ['union','subtract',
 *  'intersect']. Anything out of range falls back to union. */
const BOOLEAN_OPS: readonly MergeOp[] = ['union', 'subtract', 'intersect']
function booleanOpOf(index: number): MergeOp {
  return BOOLEAN_OPS[index] ?? 'union'
}

/** The same 64-cell ceiling voxelise uses: a merge lattice covering the COMBINED bounds has at
 *  most ~resolution³ nodes (the cell size is combinedLongest/resolution, so a cubic union hits the
 *  worst case), and 64³ = 262,144 < VERTEX_BUDGET. The param spec's max is the same 64. */
const BOOLEAN_RESOLUTION_MAX = 64

/** Cap the merge resolution against the COMBINED bounds of both meshes, so a small object merged
 *  into a big one still samples finely enough while the lattice allocation stays bounded. The
 *  merge lattice's cell size is `combinedLongest / resolution`, so the node count is estimated per
 *  axis as `combinedDim / cell + padding`; shrink the resolution until that product is within the
 *  vertex budget. `mergeMeshes`' own retry ladder is the final guarantee on the OUTPUT size, but
 *  this keeps the up-front lattice from ballooning for a lopsided union. */
function cappedBooleanResolution(a: MeshData, b: MeshData, requested: number): number {
  let res = Math.max(1, Math.min(BOOLEAN_RESOLUTION_MAX, Math.round(requested)))
  const ba = boundsOf(a)
  const bb = boundsOf(b)
  const dims = [0, 1, 2].map((k) => Math.max(ba.hi[k]!, bb.hi[k]!) - Math.min(ba.lo[k]!, bb.lo[k]!))
  const longest = Math.max(dims[0]!, dims[1]!, dims[2]!, 1e-6)
  while (res > 1) {
    const cell = longest / res
    const nodes = dims.reduce((n, d) => n * (Math.ceil(d / cell) + 5), 1)
    if (nodes <= VERTEX_BUDGET) break
    res -= 1
  }
  return res
}

/** Boolean PRODUCER: combine `geo` with `siblingGeo` (already transformed into THIS object's local
 *  space by the engine) through the voxel distance field. `op` is union/subtract/intersect;
 *  `blend` rounds the join with a smooth-min fillet; `resolution` is the cells along the combined
 *  longest axis. Steps: `meshDataFromGeometry` both → cap resolution to the vertex budget using the
 *  combined bounds → `mergeMeshes` → `geometryFromMeshData`.
 *
 *  FALLBACK — `mergeMeshes` reports `open: true` when either input is not a closed surface (the SDF
 *  is meaningless) and `failed: true` when the retry ladder hit the resolution floor and the
 *  combined field is still over the vertex cap. In BOTH cases we return `geo` UNCHANGED rather than
 *  shipping a mangled or oversized mesh — a documented no-op, never a throw. Returns a NEW geometry
 *  only when it actually merges. */
function applyBoolean(
  geo: THREE.BufferGeometry, siblingGeo: THREE.BufferGeometry, op: MergeOp, blend: number, resolution: number,
): THREE.BufferGeometry {
  const self = meshDataFromGeometry(geo)
  const sibling = meshDataFromGeometry(siblingGeo)
  const res = cappedBooleanResolution(self, sibling, resolution)
  const { data, open, failed } = mergeMeshes([self, sibling], op, Math.max(0, blend), res)
  if (open || failed) return geo // open surface, or too dense to keep → leave the shape untouched
  return geometryFromMeshData(data)
}

/** The per-boolean-row context the ENGINE supplies to `applyModifierStack`: the sibling geometry a
 *  boolean row combines with, already resolved from `refObjectId` and baked into THIS object's
 *  local space (and with the sibling's OWN boolean rows treated as no-ops — the cycle guard). Only
 *  `boolean` rows read it; every other kind ignores `ctx`. A ctx-less call (the measuring helpers,
 *  unit tests without a sibling) makes every boolean a no-op, which is what keeps the S1 legacy
 *  byte-identity oracle green — a legacy bag never contains a boolean row. */
export interface ModifierApplyCtx {
  /** The sibling geometry for `row`, or null when it cannot be resolved (missing / self-reference /
   *  non-primitive / not yet loaded) — in which case the boolean is a no-op. */
  siblingGeoFor(row: ModifierInstance): THREE.BufferGeometry | null
}

export interface ClonerSettings {
  /** 0 linear, 1 radial, 2 grid. */
  mode: number
  offset: [number, number, number]
  radius: number
  axis: number
  gridCount: [number, number, number]
  spacing: [number, number, number]
  /** Per-copy rotation step in degrees, accumulated linearly. */
  stepRot: [number, number, number]
  /** Per-copy uniform scale factor, accumulated geometrically. */
  stepScale: number
}

/** One copy's placement, plus whatever the Vary drivers resolved for it.
 *
 *  THIS IS THE REUSABLE UNIT. Today one consumer (`mergeClones`) folds recipes
 *  into a single merged geometry, which is what keeps a cloned object ONE mesh
 *  and leaves treatments, outlines, sculpt, decals, picking and GLB export
 *  untouched. A future InstancedMesh renderer (for thousands of copies, or
 *  per-copy motion) consumes the SAME list without touching the drivers, the
 *  palette logic or the UI. */
export interface CloneRecipe {
  index: number
  matrix: THREE.Matrix4
  weight: number
  color?: string
}

/** Copy `i` gets `place(i) . rotationStep(i) . scaleStep(i)`, so each copy spins
 *  and shrinks about its own origin and is only then placed. With the default
 *  step values both step matrices are exactly the identity, which makes the
 *  product bit-identical to the pre-step placement matrix.
 *
 *  Vary scales the STEP transforms by each copy's weight. In sequence mode
 *  `varyStepFactor` returns 1, so the accumulate-by-index maths below runs
 *  verbatim and every scene saved before Vary existed renders bit-identically —
 *  that identity is asserted by the unit tests and must not regress. */
export function planClones(total: number, s: ClonerSettings, vary?: VarySettings): CloneRecipe[] {
  const steps: number[] = []
  for (let i = 0; i < total; i++) steps.push(i)
  const weights = vary ? varyWeights(steps, vary) : steps.map(() => 0)

  const out: CloneRecipe[] = []
  const axisVec = new THREE.Vector3(s.axis === 0 ? 1 : 0, s.axis === 1 ? 1 : 0, s.axis === 2 ? 1 : 0)
  const radialDir = (s.axis + 1) % 3
  const [nx, ny] = s.gridCount
  const rad = (deg: number) => (deg * Math.PI) / 180

  for (let i = 0; i < total; i++) {
    const m = new THREE.Matrix4()
    if (s.mode === 1) {
      const ang = (i / total) * Math.PI * 2
      const outv = new THREE.Vector3()
      outv.setComponent(radialDir, s.radius)
      m.makeTranslation(outv.x, outv.y, outv.z)
      const spin = new THREE.Matrix4().makeRotationAxis(axisVec, ang)
      m.copy(spin.multiply(m))
    } else if (s.mode === 2) {
      // The grid is centred on the origin rather than growing away from it, so
      // adding a column keeps the object where the user put it.
      const ix = i % nx
      const iy = Math.floor(i / nx) % ny
      const iz = Math.floor(i / (nx * ny))
      m.makeTranslation(
        (ix - (s.gridCount[0] - 1) / 2) * s.spacing[0],
        (iy - (s.gridCount[1] - 1) / 2) * s.spacing[1],
        (iz - (s.gridCount[2] - 1) / 2) * s.spacing[2],
      )
    } else {
      m.makeTranslation(s.offset[0] * i, s.offset[1] * i, s.offset[2] * i)
    }

    const w = weights[i] ?? 0
    // 1 in sequence mode — the existing maths, untouched.
    const f = vary ? varyStepFactor(w, vary) : 1
    const euler = new THREE.Euler(
      rad(s.stepRot[0]) * i * f, rad(s.stepRot[1]) * i * f, rad(s.stepRot[2]) * i * f,
    )
    const rot = new THREE.Matrix4().makeRotationFromEuler(euler)
    // Damping a geometric accumulation means damping the EXPONENT, so f=0 lands
    // on exactly 1 (no scaling) rather than on stepScale^i.
    const k = s.stepScale ** (i * f)
    const scl = new THREE.Matrix4().makeScale(k, k, k)

    out.push({
      index: i,
      matrix: m.multiply(rot).multiply(scl),
      weight: w,
      color: vary ? varyColorAt(w, i, vary) : undefined,
    })
  }
  return out
}

/** Fold the recipes into ONE geometry. When any recipe carries a colour, a
 *  per-vertex `color` attribute is written first, filled with that copy's colour
 *  across the whole copy — which is how a merged mesh shows N colours through a
 *  single material: `materialFor` turns on `vertexColors` and mixes toward that
 *  attribute in the shader (see `applyVaryTint` in materials.ts).
 *
 *  The RAW palette colour goes into the attribute; `vary.strength` is NOT baked in and
 *  is not this function's business at all. The material's own base colour — the other
 *  end of the blend — is not known here, and baking the strength would put a material
 *  property into the vertex data, re-merging every clone on every slider tick. The
 *  engine passes the strength straight to `materialFor`/`updateMaterial`, which apply
 *  it as a shader uniform.
 *
 *  `userData.varyTint` is the STAMP that tells materials.ts this `color` attribute
 *  is a Cloner-baked one rather than a model's own `COLOR_0` (see `hasVertexTint`). */
export function mergeClones(geo: THREE.BufferGeometry, recipes: CloneRecipe[]): THREE.BufferGeometry {
  if (recipes.length === 0) return geo.clone()
  const tinted = recipes.some((r) => r.color !== undefined)
  const copies: THREE.BufferGeometry[] = []
  for (const r of recipes) {
    const copy = geo.clone()
    if (tinted) {
      // Color.set(hexString) already performs three's sRGB→linear ingest
      // conversion (ColorManagement is enabled by default since r152), so the
      // sRGB palette hex lands in the linear working space with no further
      // conversion — the same convention materials.ts documents from the other
      // direction around line 948 ("getHex(SRGBColorSpace) undoes three's
      // sRGB→linear ingest").
      //
      // The colour picker (StudioColor) emits 8-digit #rrggbbaa hex, and
      // sanitizeVaryPalette (config.ts) deliberately admits 3/6/8-digit forms
      // into a saved palette, so an alpha-suffixed swatch genuinely reaches
      // here. THREE.Color.set only parses 3- and 6-digit hex — anything else
      // it WARNS and leaves the Color unchanged, it does not throw — so the
      // alpha must be stripped before handing the string to three. Do not
      // "simplify" this back out.
      //
      // `c` is constructed fresh per recipe (not hoisted above the loop) so
      // that an unparseable swatch — set() failing silently — cannot inherit
      // the previous copy's colour out of a reused instance. In practice a
      // garbage swatch never reaches set(): stripAlpha is total and clamps
      // anything it cannot parse to black, so black is the fallback you will
      // actually observe. The fresh instance is defence for any future caller
      // that skips the strip.
      const c = new THREE.Color()
      c.set(stripAlpha(r.color ?? '#ffffff'))
      const n = copy.getAttribute('position').count
      const arr = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b }
      copy.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    }
    copy.applyMatrix4(r.matrix)
    copies.push(copy)
  }
  const merged = mergeGeometries(copies)
  for (const cp of copies) cp.dispose()
  // mergeGeometries returns null if the inputs disagree on attributes; the
  // copies are clones of one geometry, so that cannot happen here.
  const out = merged ?? geo.clone()
  // Stamp only when the attribute was actually written — an untinted clone set must
  // stay indistinguishable from a plain geometry so its material is built unchanged.
  //
  // Assign a FRESH userData object rather than mutating `out.userData` in place: on
  // the `merged ?? geo.clone()` fallback (unreachable today — mergeGeometries only
  // returns null when the copies disagree on attributes, and they are clones of one
  // geometry), `BufferGeometry.copy` assigns `this.userData = source.userData` BY
  // REFERENCE, so `out.userData` IS the caller's `geo.userData` object and an in-place
  // stamp would mutate the caller's own geometry too.
  if (tinted) {
    out.userData = { ...out.userData, varyTint: true }
  }
  return out
}

// --- pipeline ----------------------------------------------------------------

/** The orderable middle of the stack splits two ways. subdivide (pinned first) and cloner
 *  (pinned last) are handled structurally around them.
 *  - DEFORMERS mutate positions in place, leaving the vertex count untouched (the 5 legacy rows).
 *  - PRODUCERS return a NEW geometry with a changed vertex buffer (mirror; later array/voxelise/…).
 *  The subdivide + normals/bounds gate keys off "any enabled middle row" (deformer OR producer),
 *  NOT deformers alone — a producer like mirror wants to duplicate the already-subdivided geometry,
 *  and any producer that changed the count still needs fresh normals/bounds. For a LEGACY bag the
 *  middle rows are EXACTLY the deforms, so "any middle row" and "any deform" coincide and the
 *  byte-identity oracle is untouched. */
const DEFORM_KINDS: readonly ModifierKind[] = ['taper', 'twist', 'bend', 'noise', 'jitter', 'shear', 'spherify', 'smooth', 'melt', 'lattice']
const PRODUCER_KINDS: readonly ModifierKind[] = ['array', 'shatter', 'mirror', 'decimate', 'voxelise', 'boolean']
const isDeformKind = (k: ModifierKind): boolean => (DEFORM_KINDS as readonly string[]).includes(k)
const isProducerKind = (k: ModifierKind): boolean => (PRODUCER_KINDS as readonly string[]).includes(k)
/** An enabled middle row is either a deformer or a producer — the reorderable region between the
 *  pinned subdivide and cloner. This is the set the loop walks and the subdivide gate counts. */
const isMiddleKind = (k: ModifierKind): boolean => isDeformKind(k) || isProducerKind(k)

/** Run one enabled middle row against `geo`. A DEFORMER mutates `geo` and returns the SAME
 *  object; a PRODUCER returns a NEW geometry (the caller disposes the old one on identity
 *  change). This is the single dispatch that generalizes the old deform-only switch.
 *
 *  `ctx` carries the resolved sibling geometry a `boolean` row needs (see `ModifierApplyCtx`).
 *  EVERY case except `boolean` ignores it, so a ctx-less call leaves a boolean a no-op. */
function applyMiddleRow(geo: THREE.BufferGeometry, row: ModifierInstance, ctx?: ModifierApplyCtx): THREE.BufferGeometry {
  const m = (k: string) => modifierValue(row, k)
  switch (row.kind) {
    case 'taper': applyTaper(geo, m('taper'), Math.round(m('taperAxis'))); return geo
    case 'twist': applyTwist(geo, m('twist'), Math.round(m('twistAxis'))); return geo
    case 'bend': applyBend(geo, m('bend'), Math.round(m('bendAxis'))); return geo
    case 'noise': applyNoise(geo, m('noise'), m('noiseScale'), Math.round(m('noiseSeed'))); return geo
    case 'jitter': applyJitter(geo, m('jitter'), Math.round(m('jitterMode')), Math.round(m('jitterSeed'))); return geo
    case 'shear': applyShear(geo, m('shear'), Math.round(m('shearAxis'))); return geo
    case 'spherify': applySpherify(geo, m('spherify')); return geo
    case 'smooth': applySmooth(geo, m('smoothStrength'), Math.round(m('smoothIterations'))); return geo
    case 'melt': applyMelt(geo, m('melt'), Math.round(m('meltAxis'))); return geo
    case 'lattice': applyLattice(geo, m('latticeBulge'), Math.round(m('latticeAxis')), m('latticeBias')); return geo
    case 'array': return applyRadialArray(geo, m('radialCount'), Math.round(m('radialAxis')), m('radialRadius'))
    case 'shatter': return applyShatter(geo, m('shatter'), Math.round(m('shatterSeed')))
    case 'mirror': return applyMirror(geo, Math.round(m('mirrorAxis')), m('mirrorOffset'))
    case 'decimate': return applyDecimate(geo, m('decimate'))
    case 'voxelise': return applyVoxelise(geo, Math.round(m('voxelResolution')))
    case 'boolean': {
      // The engine resolves `refObjectId` → the sibling geometry (baked into this object's local
      // space, cycle-guarded). A ctx-less call or an unresolved sibling → the boolean is a no-op.
      const sibling = ctx?.siblingGeoFor(row) ?? null
      if (!sibling) return geo
      return applyBoolean(geo, sibling, booleanOpOf(Math.round(m('booleanOp'))), m('booleanBlend'), Math.round(m('booleanResolution')))
    }
    default: return geo
  }
}

/** Apply an ORDERED modifier stack to `geo`, returning new geometry (or the SAME `geo`
 *  when nothing enabled would change it — the byte-identity no-op).
 *
 *  The stack is walked in LIST order for the deform rows: subdivide runs first (pinned),
 *  then every enabled deform in the order they appear (so twist-then-bend ≠ bend-then-twist
 *  and two twists both apply), then the cloner runs last (pinned). A row read like a
 *  mini-bag via `modifierValue` — its params are flattened onto the instance.
 *
 *  Each instance carries flat number params; `enabled === false` rows are skipped entirely,
 *  exactly as the Frame effect stack skips a hidden effect. `vary` stays a MATERIAL uniform
 *  and is only threaded to `planClones`; `vary.strength` never becomes vertex data. */
export function applyModifierStack(
  geo: THREE.BufferGeometry,
  stack: ModifierInstance[],
  opts: { vary?: VarySettings; ctx?: ModifierApplyCtx } = {},
): THREE.BufferGeometry {
  const vary = opts.vary
  const ctx = opts.ctx
  const enabled = stack.filter((mo) => mo.enabled !== false)
  // The orderable middle: every enabled deformer OR producer, in the stack's list order. For a
  // LEGACY bag these are EXACTLY the 5 deforms (mirror never folds from a flat bag), so this set
  // and the old `deforms` set are identical — the byte-identity oracle is untouched.
  const middleRows = enabled.filter((mo) => isMiddleKind(mo.kind))
  const anyMiddle = middleRows.length > 0
  // At most one of each pinned kind is meaningful; take the first enabled.
  const subdivideRow = enabled.find((mo) => mo.kind === 'subdivide')
  const clonerRow = enabled.find((mo) => mo.kind === 'cloner')

  // `requested` couples the cloner count to the subdivision budget, exactly as before:
  // a dense shape in a big clone set must not blow the vertex budget. Read it from the
  // enabled cloner row (which carries the clone* keys), or 1 when there is none.
  const requested = clonerRow ? totalClones(clonerRow) : 1

  // No-op — mirror `hasModifiers`: no middle row runs and the cloner makes at most one copy.
  // Returning the SAME object (no clone) is the byte-identity contract.
  if (!anyMiddle && requested <= 1) return geo

  let out = geo.clone()

  // Subdivision only earns its vertices when a middle row will use them, and it yields to the
  // budget so a dense shape in a big clone set cannot freeze the app. It runs BEFORE the middle
  // rows so a producer like mirror duplicates the already-subdivided geometry. Iterations come
  // from the subdivide row (absent ⇒ 0, exactly as a subdivide-of-0 folded to no row).
  if (anyMiddle) {
    const iterations = subdivideRow ? Math.round(modifierValue(subdivideRow, 'subdivide')) : 0
    const ceiling = VERTEX_BUDGET / Math.max(1, requested)
    for (let i = 0; i < iterations; i++) {
      if (out.getAttribute('position').count * 4 > ceiling) break
      const next = subdivideOnce(out)
      out.dispose()
      out = next
    }
  }

  // Middle rows IN LIST ORDER — the heart of the stack. Each dispatches through `applyMiddleRow`:
  // a deformer mutates `out` in place (returns the same object) while a producer returns a NEW
  // geometry, which we swap in and dispose the old one. A folded legacy bag lists only deforms in
  // canonical order — exactly the old fixed sequence — so the buffer stays identical.
  for (const row of middleRows) {
    const next = applyMiddleRow(out, row, ctx)
    if (next !== out) {
      out.dispose()
      out = next
    }
  }

  if (anyMiddle) {
    out.computeVertexNormals()
    out.computeBoundingBox()
    out.computeBoundingSphere()
  }

  if (clonerRow) {
    const m = (k: string) => modifierValue(clonerRow, k)
    const { count } = clampedClones(clonerRow, out.getAttribute('position').count)
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
      // `vary.strength` is deliberately NOT passed down: it is a material uniform, not
      // vertex data — mergeClones' doc explains why, and engine.ts hands it to the
      // material directly.
      const cloned = mergeClones(out, recipes)
      out.dispose()
      out = cloned
      out.computeBoundingBox()
      out.computeBoundingSphere()
    }
  }

  return out
}

/** Thin wrapper: fold the legacy flat bag into its canonical-order stack and apply it.
 *  `modifierStackOf` emits exactly the rows `applyModifiers` used to run, in the fixed
 *  order it ran them, so this is byte-identical to the pre-stack pipeline for every bag —
 *  including the all-zero / subdivide-only cases, which fold to an empty stack and return
 *  the SAME `geo`. Every existing caller (engine.ts buildGeometry, estimateVertexCount)
 *  is unaffected. */
export function applyModifiers(
  geo: THREE.BufferGeometry,
  modifiers: Record<string, number> | undefined,
  vary?: VarySettings,
): THREE.BufferGeometry {
  return applyModifierStack(geo, modifierStackOf({ modifiers }), { vary })
}
