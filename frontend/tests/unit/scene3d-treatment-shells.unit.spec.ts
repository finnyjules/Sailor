import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createPrimitive } from '~/lib/scene3d/config'
import { createTreatment } from '~/lib/scene3d/treatments'
import {
  syncTreatmentShells, isTreatmentShell, ownMeshes, beginDataPassView, SURFACE_HIDDEN_LAYER, dashPatternOn,
} from '~/lib/scene3d/treatmentShells'

function primitiveRoot(): { mesh: THREE.Mesh; obj: ReturnType<typeof createPrimitive> } {
  const obj = createPrimitive('box')
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  mesh.userData.sceneId = obj.id
  mesh.userData.realMaterial = mesh.material
  return { mesh, obj }
}
const shells = (m: THREE.Object3D) => m.children.filter(isTreatmentShell) as THREE.Mesh[]
const kinds = (m: THREE.Object3D) => shells(m).map((s) => s.userData.treatmentShell)

describe('syncTreatmentShells', () => {
  it('adds one shell per enabled edge treatment, sharing the source geometry, no raycast, no shadows', () => {
    const { mesh, obj } = primitiveRoot()
    obj.treatments = [createTreatment('rimLight'), createTreatment('outline'), createTreatment('blur')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['rimLight', 'outline'])
    for (const s of shells(mesh)) {
      expect(s.geometry).toBe(mesh.geometry)
      expect(s.castShadow).toBe(false)
      expect(s.receiveShadow).toBe(false)
      const hits: THREE.Intersection[] = []
      s.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)), hits)
      expect(hits).toHaveLength(0)
    }
    expect((shells(mesh)[1]!.material as THREE.Material).side).toBe(THREE.BackSide)
  })
  it('is idempotent: a second sync with the same treatments keeps the same shell instances', () => {
    const { mesh, obj } = primitiveRoot()
    obj.treatments = [createTreatment('rimLight')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const first = shells(mesh)[0]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(shells(mesh)[0]).toBe(first)
  })
  it('rebuilds when a dial changes and when the geometry is swapped, disposing old shell materials', () => {
    const { mesh, obj } = primitiveRoot()
    const rim = createTreatment('rimLight') as Extract<ReturnType<typeof createTreatment>, { kind: 'rimLight' }>
    obj.treatments = [rim]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const oldMat = shells(mesh)[0]!.material as THREE.Material
    let disposed = false
    oldMat.addEventListener('dispose', () => { disposed = true })
    rim.strength = 2
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(disposed).toBe(true)
    expect(((shells(mesh)[0]!.material as THREE.ShaderMaterial).uniforms.uStrength!.value)).toBe(2)
    const before = shells(mesh)[0]
    mesh.geometry = new THREE.SphereGeometry(1)
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(shells(mesh)[0]).not.toBe(before)
    expect(shells(mesh)[0]!.geometry).toBe(mesh.geometry)
  })
  it('removes shells and restores layers when treatments go away or are disabled', () => {
    const { mesh, obj } = primitiveRoot()
    const wire = createTreatment('wireframe') as Extract<ReturnType<typeof createTreatment>, { kind: 'wireframe' }>
    wire.showSurface = false
    obj.treatments = [wire]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['wireframe'])
    expect(mesh.layers.isEnabled(0)).toBe(false)
    expect(mesh.layers.isEnabled(SURFACE_HIDDEN_LAYER)).toBe(true)
    wire.enabled = false
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual([])
    expect(mesh.layers.isEnabled(0)).toBe(true)
    expect(mesh.layers.isEnabled(SURFACE_HIDDEN_LAYER)).toBe(false)
  })
  it('x-ray overrides the mounted material, re-applies after the engine resets it, and restores on removal', () => {
    const { mesh, obj } = primitiveRoot()
    const real = mesh.material
    obj.treatments = [createTreatment('xray')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).not.toBe(real)
    expect((mesh.material as THREE.Material).userData.keepTransparent).toBe(true)
    const xm = mesh.material
    mesh.material = real // what syncObject does every sync
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).toBe(xm)
    obj.treatments = []
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(mesh.material).toBe(real)
    expect(mesh.userData.xrayMaterial).toBeUndefined()
  })
  it('x-ray is not applied in Light View', () => {
    const { mesh, obj } = primitiveRoot()
    const real = mesh.material
    obj.treatments = [createTreatment('xray')]
    syncTreatmentShells(mesh, obj, { lightView: true })
    expect(mesh.material).toBe(real)
  })
  it('dashedOutline rides the inverted-hull outline shell (one BackSide shell, dash uniforms fed)', () => {
    const { mesh, obj } = primitiveRoot()
    const dash = createTreatment('dashedOutline') as Extract<ReturnType<typeof createTreatment>, { kind: 'dashedOutline' }>
    obj.treatments = [dash]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['dashedOutline'])
    const shell = shells(mesh)[0]!
    expect(shell.geometry).toBe(mesh.geometry)
    expect((shell.material as THREE.Material).side).toBe(THREE.BackSide)
    const u = (shell.material as THREE.ShaderMaterial).uniforms
    expect(u.uDash!.value).toBe(dash.dash)
    expect(u.uGap!.value).toBe(dash.gap)
    expect(u.uThickness!.value).toBe(dash.width)
  })
  it('silhouetteCutout is a flat FrontSide fill shell, adding a BackSide keyline only when border > 0', () => {
    const { mesh, obj } = primitiveRoot()
    const cut = createTreatment('silhouetteCutout') as Extract<ReturnType<typeof createTreatment>, { kind: 'silhouetteCutout' }>
    obj.treatments = [cut]
    syncTreatmentShells(mesh, obj, { lightView: false })
    // border 0 by default → fill only, and it is a front-side opaque shell (not the object material)
    expect(kinds(mesh)).toEqual(['silhouetteCutout'])
    const fill = shells(mesh)[0]!.material as THREE.MeshBasicMaterial
    expect(fill.side).toBe(THREE.FrontSide)
    expect(fill.polygonOffset).toBe(true)
    expect(mesh.material).toBe(mesh.userData.realMaterial) // flat fill never swaps the object material
    // a keyline appears once border > 0
    cut.border = 0.5
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(kinds(mesh)).toEqual(['silhouetteCutout', 'silhouetteCutout'])
    expect((shells(mesh)[1]!.material as THREE.Material).side).toBe(THREE.BackSide)
  })
  it('ownMeshes skips a nested child object\'s root and existing shells', () => {
    const { mesh, obj } = primitiveRoot()
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    child.userData.sceneId = 'other'
    mesh.add(child)
    obj.treatments = [createTreatment('outline')]
    syncTreatmentShells(mesh, obj, { lightView: false })
    expect(ownMeshes(mesh)).toEqual([mesh])
    expect(shells(child)).toHaveLength(0)
  })
})

describe('dashPatternOn (CPU twin of the dashed-outline stipple)', () => {
  it('marks the dash run and clears the gap run, repeating each period', () => {
    // dash 4, gap 4 → period 8: [0,4] on, (4,8) off, then repeats.
    expect(dashPatternOn(0, 4, 4)).toBe(true)
    expect(dashPatternOn(3, 4, 4)).toBe(true)
    expect(dashPatternOn(6, 4, 4)).toBe(false)
    expect(dashPatternOn(8, 4, 4)).toBe(true) // next period
    expect(dashPatternOn(14, 4, 4)).toBe(false)
  })
  it('gap 0 is a solid outline (always on)', () => {
    for (const s of [0, 1, 7, 33, 128]) expect(dashPatternOn(s, 8, 0), String(s)).toBe(true)
  })
  it('is deterministic and handles negative coordinates by wrapping', () => {
    expect(dashPatternOn(-2, 4, 4)).toBe(dashPatternOn(6, 4, 4)) // -2 ≡ 6 (mod 8)
  })
})

describe('beginDataPassView', () => {
  it('hides rim/outline/wireframe shells and shows a wireframe-hidden surface, then restores', () => {
    const scene = new THREE.Scene()
    const { mesh, obj } = primitiveRoot()
    scene.add(mesh)
    const wire = createTreatment('wireframe') as Extract<ReturnType<typeof createTreatment>, { kind: 'wireframe' }>
    wire.showSurface = false
    obj.treatments = [createTreatment('rimLight'), wire]
    syncTreatmentShells(mesh, obj, { lightView: false })
    const restore = beginDataPassView(scene)
    expect(shells(mesh).every((s) => !s.visible)).toBe(true)
    expect(mesh.layers.isEnabled(0)).toBe(true)
    restore()
    expect(shells(mesh).every((s) => s.visible)).toBe(true)
    expect(mesh.layers.isEnabled(0)).toBe(false)
  })
})
