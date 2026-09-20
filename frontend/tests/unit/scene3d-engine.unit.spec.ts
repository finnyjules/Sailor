import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — three vendors this lib without type declarations.
import opentype from 'three/examples/jsm/libs/opentype.module.js'
import { sunDirection, geometryFor, geoKeyFor, booleanRefKeys, baseSizeFor, baseVertexCountFor, buildGeometry, lightFor, SceneEngine } from '~/lib/scene3d/engine'
import { PRIMITIVE_KINDS, createPrimitive, createLight, createGlbObject, createSvgPathObject, contentDigest, type PrimitiveKind, type PrimitiveObject, type GlbObject } from '~/lib/scene3d/config'
import { PRIMITIVE_PARAMS, varySettingsFor } from '~/lib/scene3d/primParams'
import { modifierStackOf, writeModifierStack, createModifier, type ModifierInstance } from '~/lib/scene3d/modifierStack'
import { loadFont, type Font } from '~/lib/scene3d/outlines'
import { encodeMesh, meshDataFromGeometry } from '~/lib/scene3d/mesh'
import { loadMesh, meshCacheClear } from '~/lib/scene3d/meshCache'

// vitest runs in node, so parse a real .otf off disk rather than fetching —
// same approach as scene3d-outlines.unit.spec.ts.
const fontPath = (rel: string) => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url))
function parseFont(rel: string): Font {
  const buf = readFileSync(fontPath(rel))
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as Font
}
const TEST_FONT = parseFont('fonts/ABCROM-Bold.otf')

describe('scene3d sun direction', () => {
  it('points straight up at 90° elevation', () => {
    const [x, y, z] = sunDirection(0, 90)
    expect(y).toBeCloseTo(1)
    expect(Math.hypot(x, z)).toBeCloseTo(0)
  })
  it('is a unit vector at arbitrary angles', () => {
    const [x, y, z] = sunDirection(123, 34)
    expect(Math.hypot(x, y, z)).toBeCloseTo(1)
    expect(y).toBeCloseTo(Math.sin((34 * Math.PI) / 180))
  })
})

const sizeOf = (g: THREE.BufferGeometry): [number, number, number] => {
  g.computeBoundingBox()
  const b = g.boundingBox!
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]
}

describe('scene3d parametric geometry', () => {
  // The pre-parametric calls are the oracle: at default params the factory must
  // still produce exactly these meshes, so old scenes render unchanged.
  // 'text'/'shape' are brand-new extruded kinds with no pre-parametric fixed
  // geometry to pin against — they're covered by their own describe block below.
  const ORIGINALS: Partial<Record<PrimitiveKind, () => THREE.BufferGeometry>> = {
    box: () => new THREE.BoxGeometry(1, 1, 1),
    sphere: () => new THREE.SphereGeometry(0.5, 48, 32),
    cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 48),
    cone: () => new THREE.ConeGeometry(0.5, 1, 48),
    torus: () => new THREE.TorusGeometry(0.5, 0.18, 24, 64),
    plane: () => new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    capsule: () => new THREE.CapsuleGeometry(0.35, 0.5, 8, 24),
    pyramid: () => new THREE.ConeGeometry(0.55, 1, 4, 1).rotateY(Math.PI / 4),
    prism: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 3),
    icosahedron: () => new THREE.IcosahedronGeometry(0.55),
    octahedron: () => new THREE.OctahedronGeometry(0.55),
    dodecahedron: () => new THREE.DodecahedronGeometry(0.55),
    torusKnot: () => new THREE.TorusKnotGeometry(0.4, 0.12, 128, 16),
    ring: () => new THREE.RingGeometry(0.22, 0.5, 48).rotateX(-Math.PI / 2),
  }

  it('reproduces the pre-parametric geometry at default params', () => {
    for (const kind of Object.keys(ORIGINALS) as PrimitiveKind[]) {
      const got = geometryFor(kind)
      const want = ORIGINALS[kind]!()
      expect(got.getAttribute('position').count, `${kind} vertex count`)
        .toBe(want.getAttribute('position').count)
      const [gx, gy, gz] = sizeOf(got)
      const [wx, wy, wz] = sizeOf(want)
      expect(gx, `${kind} width`).toBeCloseTo(wx, 5)
      expect(gy, `${kind} height`).toBeCloseTo(wy, 5)
      expect(gz, `${kind} depth`).toBeCloseTo(wz, 5)
    }
  })

  it('builds every kind at both ends of every parameter range', () => {
    // Guards against a param wired to a three.js argument that rejects its own
    // extreme (a 0-segment ring, a degenerate radius) — each must still build.
    for (const kind of PRIMITIVE_KINDS) {
      for (const spec of PRIMITIVE_PARAMS[kind]) {
        for (const v of [spec.min, spec.max]) {
          const g = geometryFor(kind, { [spec.key]: v })
          expect(g.getAttribute('position').count, `${kind}.${spec.key}=${v}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('drives the side count of radial shapes from detail', () => {
    const hex = geometryFor('cylinder', { detail: 6 })
    const many = geometryFor('cylinder', { detail: 48 })
    expect(hex.getAttribute('position').count).toBeLessThan(many.getAttribute('position').count)
    // A 6-sided cylinder is a hexagonal prism. Three starts its ring at +Z, so
    // the hexagon spans the full diameter on Z and only flat-to-flat (0.866) on
    // X — narrower than the 1.0 circumscribed diameter of the smooth one.
    expect(sizeOf(hex)[0]).toBeLessThan(sizeOf(many)[0])
  })

  it('rounds the box corners and keeps its overall size', () => {
    const plain = geometryFor('box')
    const round = geometryFor('box', { cornerRadius: 0.2, cornerSides: 4 })
    expect(round.getAttribute('position').count).toBeGreaterThan(plain.getAttribute('position').count)
    const [w, h, d] = sizeOf(round)
    expect(w).toBeCloseTo(1, 3)
    expect(h).toBeCloseTo(1, 3)
    expect(d).toBeCloseTo(1, 3)
  })

  it('cuts a partial sweep with arc', () => {
    const full = geometryFor('torus')
    const half = geometryFor('torus', { arc: 180 })
    // The torus sweeps in XY from +X: half of it keeps the full X span but
    // loses the lower half of its Y span.
    expect(sizeOf(half)[1]).toBeLessThan(sizeOf(full)[1])
  })

  it('subdivides the polyhedra toward a sphere', () => {
    const flat = geometryFor('icosahedron')
    const smooth = geometryFor('icosahedron', { detail: 2 })
    expect(smooth.getAttribute('position').count).toBeGreaterThan(flat.getAttribute('position').count)
  })

  it('reports unscaled base dimensions', () => {
    const [w, h, d] = baseSizeFor('box')
    expect(w).toBeCloseTo(1)
    expect(h).toBeCloseTo(1)
    expect(d).toBeCloseTo(1)
    // A fatter tube makes the whole torus bigger, so Size must follow params.
    expect(baseSizeFor('torus', { tube: 0.4 })[0])
      .toBeGreaterThan(baseSizeFor('torus', { tube: 0.05 })[0])
  })

  it('rounds the rim of a cylinder and keeps its footprint', () => {
    const plain = geometryFor('cylinder')
    const round = geometryFor('cylinder', { cornerRadius: 0.2, cornerSides: 3 })
    expect(round.getAttribute('position').count).not.toBe(plain.getAttribute('position').count)
    const [w, h, d] = sizeOf(round)
    expect(h).toBeLessThanOrEqual(1.0001)
    expect(Math.max(w, d)).toBeCloseTo(1, 1)
  })

  it('rounds the edges of a prism into a valid faceted solid', () => {
    const round = geometryFor('prism', { detail: 6, cornerRadius: 0.15, cornerSides: 3 })
    expect(round.getAttribute('position').count).toBeGreaterThan(0)
    expect(sizeOf(round)[1]).toBeCloseTo(1, 1)
  })

  it('keeps cylinder/cone/prism/pyramid identical at cornerRadius 0', () => {
    for (const kind of ['cylinder', 'cone', 'prism', 'pyramid'] as const) {
      const a = geometryFor(kind).getAttribute('position').count
      const b = geometryFor(kind, { cornerRadius: 0 }).getAttribute('position').count
      expect(b, kind).toBe(a)
    }
  })

  it('rounds the polyhedra edges and preserves their footprint', () => {
    for (const kind of ['icosahedron', 'octahedron', 'dodecahedron'] as const) {
      const plain = geometryFor(kind)
      const round = geometryFor(kind, { cornerRadius: 0.15, cornerSides: 3 })
      expect(round.getAttribute('position').count, kind).toBeGreaterThan(0)
      expect(round.getAttribute('uv'), `${kind} uv`).toBeTruthy()
      // The rounded hull is a convex hull with flat faces + rounded edges/corners,
      // which produces substantially more triangles than the plain polyhedron. If
      // the rounding wiring were absent (factory falling back to the plain
      // geometry at cornerRadius > 0), this would fail.
      expect(round.getAttribute('position').count, `${kind} should have more geometry when rounded`)
        .toBeGreaterThan(plain.getAttribute('position').count)
      // size preserved within a small tolerance
      plain.computeBoundingSphere(); round.computeBoundingSphere()
      expect(round.boundingSphere!.radius, kind).toBeCloseTo(plain.boundingSphere!.radius, 1)
    }
  })

  it('keeps the polyhedra identical at cornerRadius 0', () => {
    for (const kind of ['icosahedron', 'octahedron', 'dodecahedron'] as const) {
      const a = geometryFor(kind).getAttribute('position').count
      const b = geometryFor(kind, { cornerRadius: 0 }).getAttribute('position').count
      expect(b, kind).toBe(a)
    }
  })
})

describe('scene3d facet geometry variant', () => {
  it('leaves the smooth variant untouched', () => {
    const geo = buildGeometry('box', { cornerRadius: 0.2 }, undefined, 'smooth')
    expect(geo.getAttribute('aFaceMin')).toBeUndefined()
    expect(geo.getAttribute('aFaceMax')).toBeUndefined()
  })

  // The facet gradient reads aFaceMin/aFaceMax to ramp across each face. A
  // PARAMETER edit rebuilds the geometry through this same step, so the
  // attributes must come back on non-default params too — not just on a
  // smooth↔facet flip.
  it.each([
    ['box', { cornerRadius: 0.25, cornerSides: 4 }],
    ['prism', { detail: 6 }],
    ['torus', { tube: 0.3, detail: 24 }],
    ['sphere', { detail: 12 }],
  ] as const)('bakes face extents after a %s param rebuild', (kind, params) => {
    const geo = buildGeometry(kind, params as Record<string, number>, undefined, 'facet')
    const pos = geo.getAttribute('position')
    const min = geo.getAttribute('aFaceMin')
    const max = geo.getAttribute('aFaceMax')

    expect(geo.index).toBeNull() // facet variant is always non-indexed
    expect(min.itemSize).toBe(3)
    expect(max.itemSize).toBe(3)
    expect(min.count).toBe(pos.count)
    expect(max.count).toBe(pos.count)

    for (let v = 0; v < pos.count; v += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const lo = min.getComponent(v, axis)
        const hi = max.getComponent(v, axis)
        expect(lo).toBeLessThanOrEqual(hi)
        // Same value on all 3 verts of the face, and it brackets each vertex.
        for (let k = 0; k < 3; k++) {
          expect(min.getComponent(v + k, axis)).toBe(lo)
          expect(max.getComponent(v + k, axis)).toBe(hi)
          const c = pos.getComponent(v + k, axis)
          expect(c).toBeGreaterThanOrEqual(lo)
          expect(c).toBeLessThanOrEqual(hi)
        }
      }
    }
  })

  it('tracks the param change in the baked extents', () => {
    const spanX = (p: Record<string, number>): number => {
      const a = buildGeometry('torus', p, undefined, 'facet').getAttribute('aFaceMax')
      let m = -Infinity
      for (let i = 0; i < a.count; i++) m = Math.max(m, a.getComponent(i, 0))
      return m
    }
    expect(spanX({ tube: 0.4 })).toBeGreaterThan(spanX({ tube: 0.05 }))
  })
})

describe('scene3d engine modifier integration', () => {
  it('builds undeformed geometry when no modifiers are set', () => {
    const plain = buildGeometry('box', undefined, undefined, 'smooth')
    const alsoPlain = buildGeometry('box', undefined, {}, 'smooth')
    expect(alsoPlain.getAttribute('position').count).toBe(plain.getAttribute('position').count)
  })

  it('applies modifiers to the built geometry', () => {
    const plain = buildGeometry('box', undefined, undefined, 'smooth')
    const arrayed = buildGeometry('box', undefined, { cloneCount: 3 }, 'smooth')
    expect(arrayed.getAttribute('position').count).toBe(plain.getAttribute('position').count * 3)
  })

  it('still produces face extents for the faceted variant after deformation', () => {
    const g = buildGeometry('box', undefined, { twist: 90, subdivide: 1 }, 'facet')
    expect(g.getAttribute('aFaceMin')).toBeTruthy()
    expect(g.getAttribute('aFaceMax')).toBeTruthy()
    expect(g.getAttribute('aFaceMin').count).toBe(g.getAttribute('position').count)
  })

  it('reports base size including modifiers', () => {
    const plain = baseSizeFor('box')
    const arrayed = baseSizeFor('box', undefined, { cloneCount: 3, cloneOffsetX: 2 })
    expect(arrayed[0]).toBeGreaterThan(plain[0])
  })

  // Task 4 shipped `text` resolving through geometryFor's font-cache peek, but
  // baseSizeFor/baseVertexCountFor never threaded `content` through to it — so
  // the Size row and the clone-cost warning kept measuring the 0.3 placeholder
  // cube for text objects even once the real font had resolved. This pins the
  // fix: same fontCacheGet(content.font) peek as geometryForObject, seeded here
  // by awaiting loadFont(url) directly (outlines.ts's cache is module-level).
  it("measures a text object's real glyph geometry once its font resolves, not the 0.3 placeholder", async () => {
    const bytes = readFileSync(fontPath('fonts/ABCROM-Bold.otf'))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }))
    vi.stubGlobal('fetch', fetchMock)

    // Unique url so this never rides another spec's already-resolved cache entry.
    const url = '/fonts/__engine-basesize-test.otf'
    const content = { text: 'Hi', font: url }

    // Unresolved (cache miss): both helpers fall back to the placeholder cube.
    const [pw, ph, pd] = baseSizeFor('text', undefined, undefined, content)
    expect(pw).toBeCloseTo(0.3)
    expect(ph).toBeCloseTo(0.3)
    expect(pd).toBeCloseTo(0.3)
    const placeholderVerts = baseVertexCountFor('text', undefined, undefined, content)

    await loadFont(url) // seeds outlines.ts's resolved-font cache synchronously peekable via fontCacheGet

    const [w, h] = baseSizeFor('text', undefined, undefined, content)
    expect(w).not.toBeCloseTo(0.3)
    expect(h).not.toBeCloseTo(0.3)
    expect(baseVertexCountFor('text', undefined, undefined, content)).not.toBe(placeholderVerts)

    vi.unstubAllGlobals()
  })
})

// syncObject needs a live WebGL context to reach through SceneEngine's
// constructor (WebGLRenderer + PMREM), which jsdom has no way to provide. The
// method itself only touches objectRoots / scene / glbTokens, so the deferral
// behaviour is exercised against a stand-in `this` — the real prototype method,
// no reimplementation.
describe('scene3d engine deferred geometry', () => {
  const objectFor = (detail: number): PrimitiveObject => ({
    ...createPrimitive('sphere', []),
    params: { detail },
    modifiers: { cloneCountX: 3, cloneCountY: 3, cloneCountZ: 3 },
  })
  const makeHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    token: 0,
    deferGeometry: false,
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)

  it('rebuilds geometry on a param change when not deferring', () => {
    const host = makeHost()
    const obj = objectFor(16)
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const before = mesh.geometry.getAttribute('position').count
    sync(host, { ...obj, params: { detail: 48 } })
    expect(mesh.geometry.getAttribute('position').count).not.toBe(before)
  })

  it('skips the rebuild while deferring, and leaves the stale key so release catches up', () => {
    const host = makeHost()
    const obj = objectFor(16)
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const before = mesh.geometry.getAttribute('position').count
    const keyBefore = mesh.userData.geoKey

    host.deferGeometry = true
    sync(host, { ...obj, params: { detail: 32 } })
    sync(host, { ...obj, params: { detail: 48 } })
    expect(mesh.geometry.getAttribute('position').count).toBe(before)
    expect(mesh.userData.geoKey).toBe(keyBefore) // stale on purpose

    host.deferGeometry = false
    sync(host, { ...obj, params: { detail: 48 } })
    const finalCount = mesh.geometry.getAttribute('position').count
    expect(finalCount).not.toBe(before)
    // The catch-up build matches the final slider value exactly, not an
    // intermediate one from during the drag.
    expect(finalCount).toBe(
      buildGeometry('sphere', { detail: 48 }, obj.modifiers, 'smooth').getAttribute('position').count,
    )
  })

  it('keeps transform, visibility and material live while deferring', () => {
    const host = makeHost()
    const obj = objectFor(16)
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh

    host.deferGeometry = true
    sync(host, {
      ...obj,
      params: { detail: 48 },
      position: [1, 2, 3],
      visible: false,
      material: { ...obj.material, color: '#ff0000' },
    })
    expect(mesh.position.toArray()).toEqual([1, 2, 3])
    expect(mesh.visible).toBe(false)
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHexString()).toBe('ff0000')
  })
})

// Finding 1 (Task 5 review): every existing Vary test calls buildGeometry /
// materialFor / updateMaterial DIRECTLY with an explicit vary argument, and none
// constructs anything through syncObject — so deleting `varySettingsFor(obj)` from
// the real `geometryForObject` call, or the strength argument from the real
// `materialFor`/`updateMaterial` calls, would go completely unnoticed by the suite
// while killing the feature in the running app. This closes that gap by driving the
// actual prototype methods (the same stand-in `this` trick as the deferred-geometry
// block above — syncObject only touches objectRoots/scene/tokens, no WebGL needed).
describe('scene3d engine Cloner Vary integration', () => {
  const makeHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    token: 0,
    deferGeometry: false,
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)

  const varyObj = (modifiers: Record<string, number>): PrimitiveObject => ({
    ...createPrimitive('box', []),
    modifiers,
    varyPalette: ['#ff0000', '#00ff00'],
  })

  it('reaches the built mesh: varySettingsFor(obj) threads through geometryForObject into buildGeometry', () => {
    const host = makeHost()
    const obj = varyObj({ cloneCount: 3, varyColor: 1 })
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    expect(mesh.geometry.getAttribute('color')).toBeDefined()
    expect(mesh.geometry.userData.varyTint).toBe(true)
  })

  it('reaches the built material: colour strength updates the uniform without rebuilding geometry', () => {
    const host = makeHost()
    const obj = varyObj({ cloneCount: 3, varyColor: 1, varyColorStrength: 0.4 })
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const geoBefore = mesh.geometry
    const matBefore = mesh.userData.realMaterial as THREE.Material
    const uniformOf = (m: THREE.Material) =>
      (m.userData.varyUniforms as { uVaryStrength: { value: number } } | undefined)?.uVaryStrength.value
    expect(uniformOf(matBefore)).toBeCloseTo(0.4)

    // Only varyColorStrength moves — geoKeyFor deliberately excludes it, so the
    // geometry object identity must not change; the material updates in place.
    sync(host, { ...obj, modifiers: { ...obj.modifiers, varyColorStrength: 0.9 } })
    expect(mesh.geometry).toBe(geoBefore)
    const matAfter = mesh.userData.realMaterial as THREE.Material
    expect(uniformOf(matAfter)).toBeCloseTo(0.9)
  })
})

describe('scene3d engine light view clay mode', () => {
  const makeHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    token: 0,
    deferGeometry: false,
    lightView: false,
    clay: new THREE.MeshStandardMaterial(),
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)

  it('swaps object meshes to clay in Light View and restores on exit', () => {
    const host = makeHost() as any
    host.lightView = false
    host.clay = new THREE.MeshStandardMaterial()
    const obj = { ...createPrimitive('box', []) }
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const real = mesh.material
    expect(real).not.toBe(host.clay)
    host.lightView = true
    sync(host, obj)
    expect(mesh.material).toBe(host.clay)
    host.lightView = false
    sync(host, obj)
    expect(mesh.material).not.toBe(host.clay)
  })

  it('attaches a Light-View widget to a light root, shown only in Light View', () => {
    const host = makeHost() as any
    host.lightView = true
    host.clay = new THREE.MeshStandardMaterial()
    host.selectedId = null
    const obj = createLight('spot', [])
    ;(SceneEngine.prototype as any).syncObject.call(host, obj)
    const root = host.objectRoots.get(obj.id) as THREE.Object3D
    const widget = root.children.find((c: THREE.Object3D) => c.userData.isGizmoHelper && c.type === 'Group')
    expect(widget).toBeTruthy()
    expect(widget!.visible).toBe(true)
  })

  it('hides the Light-View widget when Light View is off', () => {
    const host = makeHost() as any
    host.lightView = false
    host.clay = new THREE.MeshStandardMaterial()
    host.selectedId = null
    const obj = createLight('point', [])
    ;(SceneEngine.prototype as any).syncObject.call(host, obj)
    const root = host.objectRoots.get(obj.id) as THREE.Object3D
    const widget = root.children.find((c: THREE.Object3D) => c.userData.isGizmoHelper && c.type === 'Group')
    expect(widget).toBeTruthy()
    expect(widget!.visible).toBe(false)
  })
})

describe('scene3d engine GLB material override', () => {
  const makeHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    token: 0,
    deferGeometry: false,
    lightView: false,
    clay: new THREE.MeshStandardMaterial(),
    // The GLB material path asks the engine for the object's AI-restyle spec (S7, 1caae874f).
    // No restyle here: an empty texture map resolves every object to null.
    restyleTextures: new Map<string, THREE.Texture>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    restyleSpecFor: (SceneEngine.prototype as any).restyleSpecFor,
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: GlbObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)
  // Sync once to create the placeholder root (the async GLB fetch fails fast and
  // is swallowed), then graft a mesh under it — the same shape a finished load
  // leaves behind, minus the network.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadedGlb = (host: any) => {
    const obj = createGlbObject('http://127.0.0.1:1/m.glb', [])
    sync(host, obj)
    const root = host.objectRoots.get(obj.id) as THREE.Object3D
    const baked = new THREE.MeshStandardMaterial({ color: '#00ff00' })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baked)
    root.add(mesh)
    return { obj, root, mesh, baked }
  }

  it('keeps the baked material when the override is off', () => {
    const host = makeHost()
    const { obj, mesh, baked } = loadedGlb(host)
    sync(host, obj)
    expect(mesh.material).toBe(baked)
  })

  it('swaps meshes to a studio material when the override is on', () => {
    const host = makeHost()
    const { obj, mesh, baked } = loadedGlb(host)
    obj.materialOverride = true
    obj.material.color = '#ff0000'
    sync(host, obj)
    expect(mesh.material).not.toBe(baked)
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHexString()).toBe('ff0000')
  })

  it('updates the override in place on a parameter edit', () => {
    const host = makeHost()
    const { obj, mesh } = loadedGlb(host)
    obj.materialOverride = true
    sync(host, obj)
    const first = mesh.material
    obj.material.color = '#0000ff'
    sync(host, obj)
    expect(mesh.material).toBe(first) // same instance, mutated
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHexString()).toBe('0000ff')
  })

  it('rebuilds the override on a material type change', () => {
    const host = makeHost()
    const { obj, mesh } = loadedGlb(host)
    obj.materialOverride = true
    sync(host, obj)
    obj.material.type = 'toon'
    sync(host, obj)
    expect((mesh.material as THREE.Material).type).toBe('MeshToonMaterial')
  })

  it('restores the baked material when the override is turned off', () => {
    const host = makeHost()
    const { obj, mesh, baked } = loadedGlb(host)
    obj.materialOverride = true
    sync(host, obj)
    expect(mesh.material).not.toBe(baked)
    obj.materialOverride = false
    sync(host, obj)
    expect(mesh.material).toBe(baked)
  })

  it('disposes the baked material on teardown even while the override renders', () => {
    const host = makeHost()
    const { obj, baked } = loadedGlb(host)
    obj.materialOverride = true
    sync(host, obj)
    let disposed = false
    baked.addEventListener('dispose', () => { disposed = true })
    // A url change retypes the source in place → the old root is torn down.
    sync(host, { ...obj, url: 'http://127.0.0.1:1/other.glb' })
    expect(disposed).toBe(true)
  })

  it('layers Light View clay over the override and restores it on exit', () => {
    const host = makeHost() as ReturnType<typeof makeHost> & { lightView: boolean }
    const { obj, mesh, baked } = loadedGlb(host)
    obj.materialOverride = true
    sync(host, obj)
    const override = mesh.material
    host.lightView = true
    sync(host, obj)
    expect(mesh.material).toBe(host.clay)
    host.lightView = false
    sync(host, obj)
    expect(mesh.material).toBe(override)
    expect(mesh.material).not.toBe(baked)
  })
})

describe('scene3d light factory', () => {
  it('maps each light kind to the right THREE light with its params', () => {
    const point = lightFor(createLight('point', []))
    expect(point).toBeInstanceOf(THREE.PointLight)
    const spotObj = createLight('spot', []); spotObj.angle = 0.5; spotObj.penumbra = 0.4
    const spot = lightFor(spotObj) as THREE.SpotLight
    expect(spot).toBeInstanceOf(THREE.SpotLight)
    expect(spot.angle).toBeCloseTo(0.5)
    expect(spot.penumbra).toBeCloseTo(0.4)
    const rect = lightFor(createLight('rect', []))
    expect(rect).toBeInstanceOf(THREE.RectAreaLight)
  })

  it('applies color and intensity', () => {
    const o = createLight('point', []); o.color = '#ff0000'; o.intensity = 3.5
    const l = lightFor(o) as THREE.PointLight
    expect(l.color.getHexString()).toBe('ff0000')
    expect(l.intensity).toBe(3.5)
  })
})

describe('scene3d text/shape geometry', () => {
  it('extrudes real glyph geometry from a resolved font, matching the depth param', () => {
    const geo = geometryFor('text', { depth: 0.4, bevel: 0, size: 1, letterSpacing: 0 }, { text: 'A', font: '/fonts/ABCROM-Bold.otf' }, TEST_FONT)
    expect(geo.getAttribute('position').count).toBeGreaterThan(0)
    const [, , d] = sizeOf(geo)
    expect(d).toBeCloseTo(0.4, 2)
  })

  it('falls back to the small placeholder box without a resolved font', () => {
    const withFont = geometryFor('text', { depth: 0.4 }, { text: 'A', font: '/fonts/ABCROM-Bold.otf' }, TEST_FONT)
    const noFont = geometryFor('text', { depth: 0.4 }, { text: 'A', font: '/fonts/ABCROM-Bold.otf' }, null)
    expect(noFont.getAttribute('position').count).toBeGreaterThan(0)
    // The placeholder is a fixed small cube, not the real (much larger, and
    // depth-param-driven) extruded glyph geometry.
    expect(noFont.getAttribute('position').count).not.toBe(withFont.getAttribute('position').count)
    const [w, h, d] = sizeOf(noFont)
    expect(w).toBeCloseTo(h, 5)
    expect(d).toBeCloseTo(w, 5) // a cube, not shaped by the depth param
    expect(d).not.toBeCloseTo(0.4, 2)
  })

  it('also falls back to the placeholder for empty text, even with a resolved font', () => {
    const geo = geometryFor('text', {}, { text: '', font: '/fonts/ABCROM-Bold.otf' }, TEST_FONT)
    expect(geo.getAttribute('position').count).toBeGreaterThan(0) // still a valid, buildable mesh
  })

  it('extrudes real polygon geometry for shape, matching the depth param', () => {
    const geo = geometryFor('shape', { depth: 0.35, bevel: 0, sides: 6, roundness: 0, star: 0 })
    expect(geo.getAttribute('position').count).toBeGreaterThan(0)
    const [, , d] = sizeOf(geo)
    expect(d).toBeCloseTo(0.35, 2)
  })
})

describe('scene3d geoKeyFor', () => {
  it('changes when content.text changes', () => {
    const obj = createPrimitive('text', [])
    const a = geoKeyFor(obj, 'smooth')
    const b = geoKeyFor({ ...obj, content: { ...obj.content, text: 'Something else' } }, 'smooth')
    expect(b).not.toBe(a)
  })

  it('changes when content.font changes', () => {
    const obj = createPrimitive('text', [])
    const a = geoKeyFor(obj, 'smooth')
    const b = geoKeyFor({ ...obj, content: { ...obj.content, font: '/fonts/NeueMontreal/PPNeueMontreal-Regular.otf' } }, 'smooth')
    expect(b).not.toBe(a)
  })

  it('still changes on a geometry param edit, same as every other kind', () => {
    const obj = createPrimitive('text', [])
    const a = geoKeyFor(obj, 'smooth')
    const b = geoKeyFor({ ...obj, params: { ...obj.params, depth: 0.9 } }, 'smooth')
    expect(b).not.toBe(a)
  })

  it('is unchanged by fields unrelated to geometry (name, position, visibility)', () => {
    const obj = createPrimitive('text', [])
    const a = geoKeyFor(obj, 'smooth')
    const b = geoKeyFor({ ...obj, name: 'Renamed', position: [1, 2, 3], visible: false }, 'smooth')
    expect(b).toBe(a)
  })

  it('is unaffected by content for a kind that never carries any (no gratuitous invalidation)', () => {
    const box = createPrimitive('box', [])
    const a = geoKeyFor(box, 'smooth')
    const b = geoKeyFor({ ...box }, 'smooth')
    expect(b).toBe(a)
    expect(box.content).toBeUndefined()
  })

  // An svgPath's `d` is dropped from the key and stood in for by its `pathKey`
  // digest, to keep multi-KB string work off the per-sync drag path. If that
  // substitution ever broke — pathKey missing, or the spread dropping it — every
  // imported path would share one key and be served another path's geometry.
  describe('svgPath: the pathKey digest stands in for the raw d', () => {
    const D_A = `M0 0 L${'10 0 L10 10 L0 10 L'.repeat(60)}0 0 Z`
    const D_B = `M0 0 L${'20 0 L20 20 L0 20 L'.repeat(60)}0 0 Z`

    it('differs for two paths, so one import cannot serve another path geometry', () => {
      const a = geoKeyFor(createSvgPathObject(D_A, []), 'smooth')
      const b = geoKeyFor(createSvgPathObject(D_B, []), 'smooth')
      expect(a).not.toBe(b)
    })

    it('does not carry the raw d — that is the whole point of the digest', () => {
      const key = geoKeyFor(createSvgPathObject(D_A, []), 'smooth')
      expect(key).not.toContain(D_A)
      expect(key).not.toContain(D_A.slice(0, 64))
      expect(key.length).toBeLessThan(D_A.length)
      expect(key).toContain(contentDigest(D_A))
    })

    it('matches for the same d on two different objects, so the cache still hits', () => {
      const a = geoKeyFor(createSvgPathObject(D_A, []), 'smooth')
      const b = geoKeyFor(createSvgPathObject(D_A, []), 'smooth')
      expect(a).toBe(b)
    })

    // The key is meant to cover `content` wholesale (minus `path`), so adding a
    // geometry-affecting field to PrimitiveContent should invalidate for free.
    // Asserted rather than assumed: the same `d` under the two fill rules is two
    // different geometries, and a key that ignored the rule would hand an
    // evenodd object the nonzero mesh — a filled-in counter, no error.
    it('differs for the same d under evenodd vs nonzero', () => {
      const even = geoKeyFor(createSvgPathObject(D_A, [], { fillRule: 'evenodd' }), 'smooth')
      const nz = geoKeyFor(createSvgPathObject(D_A, [], { fillRule: 'nonzero' }), 'smooth')
      expect(even).not.toBe(nz)
      // 'nonzero' is stored as ABSENCE, so it must key identically to no rule.
      expect(nz).toBe(geoKeyFor(createSvgPathObject(D_A, []), 'smooth'))
    })
  })
})

describe('scene3d geoKeyFor keys on the modifier stack', () => {
  // A legacy bag whose fold spans a deform, subdivide's guard, and a cloner — enough kinds
  // that order and presence both matter.
  const bag = () => ({ subdivide: 2, twist: 45, bend: 30, cloneCount: 3, varyColorStrength: 0.4 })
  const bagObj = (): PrimitiveObject => ({ ...createPrimitive('box', []), modifiers: bag() })

  it('hashes a stored modifierStack identically to its equivalent folded legacy bag (no rebuild on persist)', () => {
    const legacy = bagObj()
    // Exactly what writeModifierStack persists on the first edit: the folded stack is stored and
    // the bag is KEPT (Vary lives in it). modifierStackOf prefers the stack, so the bag's geometry
    // keys are dead-but-harmless; the key must be identical so persisting rebuilds no geometry.
    const persisted: PrimitiveObject = { ...legacy, ...writeModifierStack(modifierStackOf(legacy)) }
    expect(persisted.modifiers).toEqual(legacy.modifiers)
    expect(persisted.modifierStack!.length).toBeGreaterThan(0)
    expect(geoKeyFor(persisted, 'smooth')).toBe(geoKeyFor(legacy, 'smooth'))
  })

  it('changes when two modifiers are reordered (order is part of the key, not a set)', () => {
    const stack = modifierStackOf(bagObj())
    const twist = stack.findIndex((r) => r.kind === 'twist')
    const bend = stack.findIndex((r) => r.kind === 'bend')
    expect(twist).toBeGreaterThanOrEqual(0)
    expect(bend).toBeGreaterThanOrEqual(0)
    const swapped = [...stack]
    ;[swapped[twist], swapped[bend]] = [swapped[bend]!, swapped[twist]!]
    const a = geoKeyFor({ ...createPrimitive('box', []), modifierStack: stack }, 'smooth')
    const b = geoKeyFor({ ...createPrimitive('box', []), modifierStack: swapped }, 'smooth')
    expect(b).not.toBe(a)
  })

  it('changes when a modifier is duplicated (two twists both apply)', () => {
    const stack = modifierStackOf(bagObj())
    const twist = stack.find((r) => r.kind === 'twist')!
    const dup: ModifierInstance = { ...twist, id: 'mod:twist:dup' }
    const withDup = [...stack, dup]
    const a = geoKeyFor({ ...createPrimitive('box', []), modifierStack: stack }, 'smooth')
    const b = geoKeyFor({ ...createPrimitive('box', []), modifierStack: withDup }, 'smooth')
    expect(b).not.toBe(a)
  })

  it("changes when a row's enabled toggles", () => {
    const stack = modifierStackOf(bagObj())
    const toggled = stack.map((r) => (r.kind === 'twist' ? { ...r, enabled: false } : r))
    const a = geoKeyFor({ ...createPrimitive('box', []), modifierStack: stack }, 'smooth')
    const b = geoKeyFor({ ...createPrimitive('box', []), modifierStack: toggled }, 'smooth')
    expect(b).not.toBe(a)
  })

  it('does NOT change when varyColorStrength changes (still a material uniform, excluded)', () => {
    const a = geoKeyFor(bagObj(), 'smooth')
    const b = geoKeyFor({ ...createPrimitive('box', []), modifiers: { ...bag(), varyColorStrength: 0.9 } }, 'smooth')
    expect(b).toBe(a)
  })

  // Vary bakes into GEOMETRY (per-clone colour attribute + varyStepFactor positions), so the
  // numeric vary dials must be back in the key — Task 3 dropped them, Task 3b restores them.
  it('changes when a vary numeric dial changes (they bake into clone geometry)', () => {
    const base = geoKeyFor(bagObj(), 'smooth')
    for (const dial of ['varyColor', 'varySeed', 'varyFalloffCenter', 'varyMode', 'varyColorSpread', 'varyFalloffRadius'] as const) {
      const changed = geoKeyFor({ ...createPrimitive('box', []), modifiers: { ...bag(), [dial]: 0.7 } }, 'smooth')
      expect(changed, `${dial} must change the geometry key`).not.toBe(base)
    }
  })

  it('bag↔stack parity holds for vary: a written-stack object (bag kept) keys identically', () => {
    // Fix 1 keeps the bag on write, so the vary dials (read from the bag, not the stack) are the
    // same for a legacy object and its persisted-stack equivalent — the key stays identical.
    const legacy: PrimitiveObject = { ...createPrimitive('box', []), modifiers: { ...bag(), varyColor: 1, varySeed: 7, varyFalloffCenter: 0.3 }, varyPalette: ['#ff0000', '#00ff00'] }
    const persisted: PrimitiveObject = { ...legacy, ...writeModifierStack(modifierStackOf(legacy)) }
    expect(geoKeyFor(persisted, 'smooth')).toBe(geoKeyFor(legacy, 'smooth'))
  })

  it('an all-zero bag and an empty stack produce the same modifier-empty key', () => {
    const zeroBag = geoKeyFor({ ...createPrimitive('box', []), modifiers: { twist: 0, bend: 0, cloneCount: 1 } }, 'smooth')
    const emptyStack = geoKeyFor({ ...createPrimitive('box', []), modifierStack: [] }, 'smooth')
    const noMods = geoKeyFor(createPrimitive('box', []), 'smooth')
    expect(zeroBag).toBe(emptyStack)
    expect(zeroBag).toBe(noMods)
  })

  it('a legacy object key is stable across two calls', () => {
    const obj = bagObj()
    expect(geoKeyFor(obj, 'smooth')).toBe(geoKeyFor(obj, 'smooth'))
  })
})

// Task 3b Fix 2: the render path now threads the ordered stack into buildGeometry, so a WRITTEN
// stack actually renders (not the base, not the stale bag), while a legacy object stays byte-
// identical (its stack is the folded bag). These drive buildGeometry directly, the same as
// geometryForObject does at the real render site.
describe('scene3d buildGeometry renders the modifier stack', () => {
  const posOf = (g: THREE.BufferGeometry) => g.getAttribute('position').array as Float32Array
  // A bag with two DIFFERENT deforms whose order matters, so a reorder is observable.
  const bag = () => ({ twist: 60, bend: 40 })
  const bagObj = (): PrimitiveObject => ({ ...createPrimitive('box', []), modifiers: bag() })

  it('a written-stack object renders the SAME geometry as its legacy bag (not the empty base)', () => {
    const legacy = bagObj()
    const written: PrimitiveObject = { ...legacy, ...writeModifierStack(modifierStackOf(legacy)) }

    const fromStack = buildGeometry('box', legacy.params, undefined, 'smooth', undefined, null, undefined, modifierStackOf(written))
    const fromBag = buildGeometry('box', legacy.params, legacy.modifiers, 'smooth', undefined, null, undefined, modifierStackOf(legacy))
    const base = buildGeometry('box', legacy.params, undefined, 'smooth')

    // Renders its stack: byte-identical to the legacy bag geometry…
    expect(posOf(fromStack)).toEqual(posOf(fromBag))
    // …and NOT the unmodified base (twist+bend actually applied).
    expect(posOf(fromStack).length === posOf(base).length && posOf(fromStack).every((v, i) => v === posOf(base)[i])).toBe(false)
  })

  it('a REORDERED written stack renders differently than the folded-bag order', () => {
    const legacy = bagObj()
    const canonical = modifierStackOf(legacy) // twist before bend (MODIFIER_ORDER)
    const ti = canonical.findIndex((r) => r.kind === 'twist')
    const bi = canonical.findIndex((r) => r.kind === 'bend')
    const reordered = [...canonical]
    ;[reordered[ti], reordered[bi]] = [reordered[bi]!, reordered[ti]!]

    const inOrder = buildGeometry('box', legacy.params, undefined, 'smooth', undefined, null, undefined, canonical)
    const swapped = buildGeometry('box', legacy.params, undefined, 'smooth', undefined, null, undefined, reordered)
    const a = posOf(inOrder), b = posOf(swapped)
    expect(a.length === b.length && a.every((v, i) => v === b[i])).toBe(false)
  })

  it('Vary survives a write: varySettingsFor reads the SAME settings before and after writeModifierStack', () => {
    const legacy: PrimitiveObject = {
      ...createPrimitive('box', []),
      modifiers: { twist: 30, cloneCount: 3, varyMode: 1, varySeed: 5, varyColor: 1, varyColorSpread: 1, varyFalloffCenter: 0.3, varyFalloffRadius: 0.7, varyColorStrength: 0.4 },
      varyPalette: ['#ff0000', '#00ff00'],
    }
    const written: PrimitiveObject = { ...legacy, ...writeModifierStack(modifierStackOf(legacy)) }
    // The bag is kept, so every vary field — mode/seed/colour/spread/falloff/strength — plus the
    // palette read identically after the write; Vary is not stripped on the first stack edit.
    expect(varySettingsFor(written)).toEqual(varySettingsFor(legacy))
  })
})

// Task 6 (boolean): geoKeyFor is pure and cannot reach the doc, so the sibling contribution to
// the cache key is folded in at the engine call site via `booleanRefKeys(obj, doc)`. A boolean
// object must rebuild when its sibling is EDITED or MOVED — neither shows up in the object's own
// fields — and a missing / self sibling must fold to a stable token, never throw.
describe('scene3d booleanRefKeys folds the sibling into the geo cache key', () => {
  const boolObj = (refObjectId?: string): PrimitiveObject => {
    const row = createModifier('boolean')
    if (refObjectId) row.refObjectId = refObjectId
    return { ...createPrimitive('box', []), id: 'A', ...writeModifierStack([row]) }
  }
  const sibling = (over: Partial<PrimitiveObject> = {}): PrimitiveObject => ({ ...createPrimitive('sphere', []), id: 'B', ...over })

  it('is empty for an object with no boolean rows (non-boolean keys stay byte-identical)', () => {
    expect(booleanRefKeys(createPrimitive('box', []), { objects: [] } as any)).toBe('')
  })

  it('folds a stable "none" token for a missing / self / null-doc sibling (never throws)', () => {
    expect(booleanRefKeys(boolObj(), null)).toContain('none') // no refObjectId set
    expect(booleanRefKeys(boolObj('nope'), { objects: [] } as any)).toContain('none') // ref not in doc
    expect(booleanRefKeys(boolObj('A'), { objects: [boolObj('A')] } as any)).toContain('none') // self-ref
  })

  it('changes when the sibling is EDITED (its params feed the key)', () => {
    const a = boolObj('B')
    const before = booleanRefKeys(a, { objects: [a, sibling()] } as any)
    const after = booleanRefKeys(a, { objects: [a, sibling({ params: { ...createPrimitive('sphere', []).params, sweep: 90 } })] } as any)
    expect(after).not.toBe(before)
  })

  it('changes when the sibling MOVES (the relative transform feeds the key)', () => {
    const a = boolObj('B')
    const before = booleanRefKeys(a, { objects: [a, sibling()] } as any)
    const after = booleanRefKeys(a, { objects: [a, sibling({ position: [1, 2, 3] })] } as any)
    expect(after).not.toBe(before)
  })

  it('changes when THIS object moves too (the relative transform is inverse(self)·sibling)', () => {
    const a = boolObj('B')
    const before = booleanRefKeys(a, { objects: [a, sibling()] } as any)
    const moved = { ...a, position: [2, 0, 0] as [number, number, number] }
    const after = booleanRefKeys(moved, { objects: [moved, sibling()] } as any)
    expect(after).not.toBe(before)
  })
})

// The font-load path mirrors the GLB path's placeholder/token/re-sync
// machinery exactly (see the GLB material-override describe block above),
// but for `text` the async result must land as mesh.geometry itself, not a
// grafted child — so the round trip goes through syncObject end-to-end
// rather than a pure function.
describe('scene3d engine text font async re-sync', () => {
  const makeHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refreshTextGeometry: (SceneEngine.prototype as any).refreshTextGeometry,
    token: 0,
    deferGeometry: false,
    lightView: false,
    clay: new THREE.MeshStandardMaterial(),
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refresh = (host: any, url: string) => (SceneEngine.prototype as any).refreshTextGeometry.call(host, url)

  it('shows the placeholder immediately, then swaps in the real glyph geometry once the font resolves', async () => {
    const host = makeHost() as any
    const bytes = readFileSync(fontPath('fonts/ABCROM-Bold.otf'))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }))
    vi.stubGlobal('fetch', fetchMock)

    // A URL unique to this test so it never hits another spec's cached entry
    // (outlines.ts's font cache is module-level and persists for the run).
    const url = '/fonts/__engine-resync-test-a.otf'
    const obj: PrimitiveObject = { ...createPrimitive('text', []), content: { text: 'Hi', font: url } }

    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const placeholderCount = mesh.geometry.getAttribute('position').count
    expect(placeholderCount).toBeGreaterThan(0)

    // Awaiting the SAME url resolves the identical in-flight promise the
    // engine's own loadFont(url) call kicked off (loadFont dedupes by url) —
    // by the time it settles here, the engine's own .then (attached first)
    // has already run and rebuilt the mesh's geometry in place.
    await loadFont(url)

    expect(mesh.geometry.getAttribute('position').count).not.toBe(placeholderCount)
    expect(host.fontTokens.has(obj.id)).toBe(false) // resolved: no load left in flight

    vi.unstubAllGlobals()
  })

  it('drops a stale font resolution when the object is removed before it resolves', async () => {
    const host = makeHost() as any
    const bytes = readFileSync(fontPath('fonts/ABCROM-Bold.otf'))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const url = '/fonts/__engine-resync-test-b.otf'
    const obj: PrimitiveObject = { ...createPrimitive('text', []), content: { text: 'Hi', font: url } }

    sync(host, obj)
    // Mirrors syncFromDoc's teardown-on-removal cleanup.
    host.objectRoots.delete(obj.id)
    host.fontTokens.delete(obj.id)

    // Must not throw despite the root being gone by the time the load settles.
    await expect(loadFont(url)).resolves.toBeTruthy()

    vi.unstubAllGlobals()
  })

  // Task 5's Final-review follow-up: loadFont doesn't cache failures, so a
  // font that failed once and later resolves is never retried by the engine
  // itself — the Surface's font watch calling loadFont(url) again on a later
  // effect run IS the retry, and refreshTextGeometry is what it must call to
  // heal the mesh (the engine has no other way back in).
  it('refreshTextGeometry heals a placeholder mesh once a previously-failed font resolves', async () => {
    const host = makeHost() as any
    const url = '/fonts/__engine-refresh-test.otf'
    const obj: PrimitiveObject = { ...createPrimitive('text', []), content: { text: 'Hi', font: url } }

    // First sync: the font has never been fetched, so this is a cache miss —
    // geometryForObject draws the placeholder and kicks off its own
    // loadFont(url), which fails (no fetch stub yet).
    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const placeholderCount = mesh.geometry.getAttribute('position').count
    await expect(loadFont(url)).rejects.toThrow() // same in-flight rejection, dedup'd by url
    // The mesh is still the placeholder — nothing in the engine retries on its own.
    expect(mesh.geometry.getAttribute('position').count).toBe(placeholderCount)

    // Retry succeeds this time (loadFont doesn't cache the failure, so a
    // fresh fetch attempt is made) — mirrors the Surface's font watch firing
    // again and its loadFont(url) call landing.
    const bytes = readFileSync(fontPath('fonts/ABCROM-Bold.otf'))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })))
    await loadFont(url)
    vi.unstubAllGlobals()

    // Bumping fontGen alone (the Surface's own success handler) wouldn't
    // touch mesh.geometry — refreshTextGeometry is the piece that does.
    refresh(host, url)
    expect(mesh.geometry.getAttribute('position').count).not.toBe(placeholderCount)
  })
})

// The `mesh` primitive's async decode mirrors the font path's placeholder/
// token/re-sync machinery exactly (see the describe block above) but goes
// through meshCache's loadMesh instead of outlines.ts's loadFont. Same host
// shape, minus the font-only members, plus meshTokens.
describe('scene3d engine mesh decode async re-sync', () => {
  const makeMeshHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    meshTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    token: 0,
    deferGeometry: false,
    lightView: false,
    clay: new THREE.MeshStandardMaterial(),
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)

  const meshObj = (mesh: string, key: string): PrimitiveObject => ({
    ...createPrimitive('mesh', []),
    content: { mesh, meshKey: key },
  })

  beforeEach(() => { meshCacheClear() })

  it('shows the 0.3 placeholder box on a cache miss, then swaps in the real geometry once the decode resolves', async () => {
    const host = makeMeshHost() as any
    const encoded = await encodeMesh(meshDataFromGeometry(new THREE.SphereGeometry(0.5, 32, 24)))
    const key = contentDigest(encoded)
    const obj = meshObj(encoded, key)

    sync(host, obj)
    const mesh = host.objectRoots.get(obj.id) as THREE.Mesh
    const placeholderCount = mesh.geometry.getAttribute('position').count
    expect(placeholderCount).toBeGreaterThan(0)

    // Awaiting the SAME key resolves the identical in-flight promise the
    // engine's own loadMesh(encoded, key) call kicked off (loadMesh dedupes by
    // key) — by the time it settles here, the engine's own .then (attached
    // first) has already run and rebuilt the mesh's geometry in place.
    await loadMesh(encoded, key)

    expect(mesh.geometry.getAttribute('position').count).not.toBe(placeholderCount)
    expect(host.meshTokens.has(obj.id)).toBe(false) // resolved: no load left in flight
  })

  it('drops a stale mesh resolution when the object is removed before it resolves', async () => {
    const host = makeMeshHost() as any
    const encoded = await encodeMesh(meshDataFromGeometry(new THREE.SphereGeometry(0.5, 32, 24)))
    const key = contentDigest(encoded)
    const obj = meshObj(encoded, key)

    sync(host, obj)
    // Mirrors syncFromDoc's teardown-on-removal cleanup.
    host.objectRoots.delete(obj.id)
    host.meshTokens.delete(obj.id)

    // Must not throw despite the root being gone by the time the decode settles.
    await expect(loadMesh(encoded, key)).resolves.toBeTruthy()
  })

  it('does not let a stale (superseded) decode overwrite geometry from a newer one', async () => {
    const host = makeMeshHost() as any
    // Both real payloads are picked with vertex counts far from the 24-vertex
    // 0.3 placeholder box, so a wrongly-applied late resolution is distinguishable
    // from "still showing the placeholder" rather than coincidentally matching it.
    const encodedA = await encodeMesh(meshDataFromGeometry(new THREE.SphereGeometry(0.5, 32, 24)))
    const keyA = contentDigest(encodedA)
    const encodedB = await encodeMesh(meshDataFromGeometry(new THREE.SphereGeometry(0.5, 16, 12)))
    const keyB = contentDigest(encodedB)

    // First sync starts decoding A and stamps meshTokens[id] = tokA.
    const objA = meshObj(encodedA, keyA)
    sync(host, objA)
    const mesh = host.objectRoots.get(objA.id) as THREE.Mesh
    const placeholderCount = mesh.geometry.getAttribute('position').count

    // Content changes before A resolves — same id, new meshKey. This starts
    // decoding B and overwrites meshTokens[id] with tokB, superseding A.
    const objB = { ...objA, content: { mesh: encodedB, meshKey: keyB } }
    sync(host, objB)

    // A's decode lands first. Its token no longer matches meshTokens[id]
    // (tokB now), so its .then must bail without touching mesh.geometry.
    await loadMesh(encodedA, keyA)
    expect(mesh.geometry.getAttribute('position').count).toBe(placeholderCount) // still B's placeholder, untouched by A

    // B's own decode then resolves and swaps in its real geometry.
    await loadMesh(encodedB, keyB)
    expect(mesh.geometry.getAttribute('position').count).not.toBe(placeholderCount)
  })
})

// C2 (final review): setSculptOverride forced a rebuild only when SETTING the
// override, on the theory that a clear is always followed by the session's one
// doc write (Apply/Exit), and THAT write's new meshKey drives the normal
// geoKey-gated rebuild back to the real mesh. Exit-without-stroking skips that
// write entirely (`session.dirty` is false), so nothing ever resynced — the
// object kept rendering the override's raw session geometry (no modifiers
// applied) until an unrelated edit happened to change the geoKey. This test
// drives setSculptOverride directly, set then clear, with NO intervening doc
// mutation — reproducing exactly that gap.
describe('scene3d engine sculpt override clear (C2)', () => {
  const makeSculptHost = () => ({
    objectRoots: new Map<string, THREE.Object3D>(),
    glbTokens: new Map<string, number>(),
    fontTokens: new Map<string, number>(),
    decalTokens: new Map<string, number>(),
    meshTokens: new Map<string, number>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geometryForObject: (SceneEngine.prototype as any).geometryForObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncObject: (SceneEngine.prototype as any).syncObject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSculptOverride: (SceneEngine.prototype as any).setSculptOverride,
    sculptOverride: null as { id: string; positions: Float32Array; indices: Uint32Array } | null,
    token: 0,
    deferGeometry: false,
    lightView: false,
    clay: new THREE.MeshStandardMaterial(),
    scene: { add() {}, remove() {} },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = (host: any, obj: PrimitiveObject) => (SceneEngine.prototype as any).syncObject.call(host, obj)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setOverride = (host: any, id: string | null, positions: Float32Array | null, indices: Uint32Array | null) =>
    (SceneEngine.prototype as any).setSculptOverride.call(host, id, positions, indices)

  beforeEach(() => { meshCacheClear() })

  it('rebuilds the modifier-applied geometry when the override clears with no intervening doc write', async () => {
    const host = makeSculptHost() as any
    // A mesh primitive with a modifier (cloneCount triples vertex count) so a
    // bypass of buildGeometry/applyModifiers is unmistakable in the count alone.
    const encoded = await encodeMesh(meshDataFromGeometry(new THREE.SphereGeometry(0.5, 16, 12)))
    const key = contentDigest(encoded)
    await loadMesh(encoded, key) // warm the cache so the initial sync is a hit, not a placeholder
    const obj: PrimitiveObject = {
      ...createPrimitive('mesh', []),
      content: { mesh: encoded, meshKey: key },
      modifiers: { cloneCount: 3 },
    }
    sync(host, obj)
    const meshNode = host.objectRoots.get(obj.id) as THREE.Mesh
    const modifierAppliedCount = meshNode.geometry.getAttribute('position').count
    const singleCopyCount = buildGeometry('mesh', obj.params, undefined, 'smooth', obj.content).getAttribute('position').count
    expect(modifierAppliedCount).toBe(singleCopyCount * 3) // sanity: the cloner really did run

    // Enter sculpt: SET the override with a tiny raw triangle buffer — its own
    // vertex count (3), unrelated to the modifier-applied count above, so the
    // override taking effect is unambiguous.
    const overridePositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const overrideIndices = new Uint32Array([0, 1, 2])
    setOverride(host, obj.id, overridePositions, overrideIndices)
    expect(meshNode.geometry.getAttribute('position').count).toBe(3)

    // Exit sculpt WITHOUT stroking: CLEAR the override. No doc mutation happens
    // in between (obj/content/modifiers are untouched) — before the fix this
    // left the mesh rendering the override's raw 3-vertex geometry forever.
    setOverride(host, null, null, null)
    expect(meshNode.geometry.getAttribute('position').count).toBe(modifierAppliedCount)
  })
})
