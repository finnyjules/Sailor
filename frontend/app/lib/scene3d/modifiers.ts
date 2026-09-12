// Non-destructive geometry modifiers, applied CPU-side to the real vertices.
//
// This is deliberately NOT a vertex shader: passes.ts renders the depth and
// normal outputs with scene.overrideMaterial, so a shader deformation would be
// invisible in two of the three exported images. Raycasting (selection and the
// gizmo), bounding boxes, shadows and the gradient bbox uniforms all read real
// geometry too.
//
// Stage order is fixed: subdivide → taper → twist → bend → noise → jitter → cloner.
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { modifierValue, totalClones } from '~/lib/scene3d/primParams'
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

export function applyModifiers(
  geo: THREE.BufferGeometry,
  modifiers: Record<string, number> | undefined,
  vary?: VarySettings,
): THREE.BufferGeometry {
  if (!hasModifiers(modifiers)) return geo
  const m = (k: string) => modifierValue(modifiers, k)

  const taper = m('taper'), twist = m('twist'), bend = m('bend'), noise = m('noise'), jitter = m('jitter')
  const requested = totalClones(modifiers)
  const deforms = taper !== 0 || twist !== 0 || bend !== 0 || noise !== 0 || jitter !== 0

  let out = geo.clone()

  // Subdivision only earns its vertices when something deforms them, and it
  // yields to the budget so a dense shape in a big clone set cannot freeze the app.
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
    // `vary.strength` is deliberately NOT passed down: it is a material uniform, not
    // vertex data — mergeClones' doc explains why, and engine.ts hands it to the
    // material directly.
    const cloned = mergeClones(out, recipes)
    out.dispose()
    out = cloned
    out.computeBoundingBox()
    out.computeBoundingSphere()
  }

  return out
}
