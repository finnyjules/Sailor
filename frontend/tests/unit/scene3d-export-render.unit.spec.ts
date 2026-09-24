import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import {
  restyleRefs, restyleTextureMap, hideEditorHelpers, renderExportFrame, createRestyleLoader,
  loadRestyleTextures, type ExportIO,
} from '~/lib/scene3d/exportRender'
import { renderMotionFrame } from '~/lib/scene3d/motion/render'
import { defaultDoc, createPrimitive, type SceneDoc } from '~/lib/scene3d/config'
import { createTreatment, type AiRestyleTreatment } from '~/lib/scene3d/treatments'
import { restyleViewUrl } from '~/lib/scene3d/restyleCache'
import type { SceneEngine } from '~/lib/scene3d/engine'

function restyle(resultRef: string, enabled = true): AiRestyleTreatment {
  return { ...(createTreatment('aiRestyle') as AiRestyleTreatment), resultRef, enabled }
}

function docWith(...treatmentsPerObject: Array<Array<ReturnType<typeof createTreatment>>>): SceneDoc {
  const doc = defaultDoc()
  for (const ts of treatmentsPerObject) {
    const o = createPrimitive('box', doc.objects)
    o.treatments = ts
    doc.objects.push(o)
  }
  return doc
}

describe('restyleRefs', () => {
  it('lists every restyle result the scene points at, once each, skipping empty ones', () => {
    const doc = docWith(
      [restyle('restyle_a.png'), createTreatment('blur')],
      [restyle('')],
      [restyle('restyle_a.png')],
    )
    expect(restyleRefs(doc)).toEqual(['restyle_a.png'])
  })
  it('no restyle → empty', () => {
    expect(restyleRefs(defaultDoc())).toEqual([])
    expect(restyleRefs(docWith([createTreatment('blur')]))).toEqual([])
  })
  it('a switched-off restyle is not loaded (the engine would not draw it)', () => {
    expect(restyleRefs(docWith([restyle('off.png', false)]))).toEqual([])
  })
})

describe('restyleTextureMap', () => {
  it('maps each restyled object to its loaded result (the engine keys restyle by object id)', () => {
    const doc = docWith([restyle('a.png')], [restyle('b.png')], [restyle('a.png')], [createTreatment('blur')])
    const a = new THREE.Texture(), b = new THREE.Texture()
    const m = restyleTextureMap(doc, new Map([['a.png', a], ['b.png', b]]))
    expect([...m.entries()]).toEqual([
      [doc.objects[0]!.id, a], [doc.objects[1]!.id, b], [doc.objects[2]!.id, a],
    ])
  })
  it('an object whose result did not load is simply left out (drawn plain)', () => {
    const doc = docWith([restyle('a.png')])
    expect(restyleTextureMap(doc, new Map()).size).toBe(0)
  })
})

describe('restyleViewUrl', () => {
  it('is the input-dir /view URL the editor loads restyle results from', () => {
    expect(restyleViewUrl('restyle a.png')).toBe('/view?filename=restyle%20a.png&type=input')
  })
})

describe('loadRestyleTextures', () => {
  it('loads each ref once and names every one that fails', async () => {
    const tex = new THREE.Texture()
    const io: ExportIO = {
      loadRestyle: vi.fn(async (ref: string) => { if (ref === 'bad.png') throw new Error('404'); return tex }),
    }
    const { textures, failures } = await loadRestyleTextures(['good.png', 'bad.png'], io)
    expect(textures.get('good.png')).toBe(tex)
    expect(textures.has('bad.png')).toBe(false)
    expect(failures).toEqual([{ kind: 'restyle', name: 'bad.png', reason: '404' }])
  })
})

/** A stand-in engine: just the surface renderMotionFrame touches, recording what the render saw. */
function stubEngine() {
  const scene = new THREE.Scene()
  const gizmo = new THREE.Object3D(); gizmo.userData.isGizmoHelper = true
  const hiddenGizmo = new THREE.Object3D(); hiddenGizmo.userData.isGizmoHelper = true; hiddenGizmo.visible = false
  const mesh = new THREE.Mesh()
  scene.add(gizmo, hiddenGizmo, mesh)
  const grid = new THREE.Object3D()
  const canvas = { tag: 'canvas' }
  const seen: Array<{ elapsed: number | undefined; grid: boolean; gizmo: boolean; mesh: boolean }> = []
  const restyleMaps: Array<Map<string, THREE.Texture>> = []
  const engine = {
    scene, grid,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: canvas },
    // syncFromDoc re-shows the grid for a shadow floor, as the real engine does.
    syncFromDoc: vi.fn(() => { grid.visible = true }),
    applyCameraFromDoc: vi.fn(),
    applyObjectOpacities: vi.fn(),
    setMotionVelocities: vi.fn(),
    setGhostPoses: vi.fn(),
    refreshShaderFields: vi.fn(),
    setRestyleTextures: vi.fn((m: Map<string, THREE.Texture>) => { restyleMaps.push(m) }),
    render: vi.fn((elapsed?: number) => {
      seen.push({ elapsed, grid: grid.visible, gizmo: gizmo.visible, mesh: mesh.visible })
    }),
  }
  return { engine: engine as unknown as SceneEngine, raw: engine, seen, grid, gizmo, hiddenGizmo, mesh, canvas, restyleMaps }
}

describe('hideEditorHelpers', () => {
  it('hides the grid and every visible gizmo helper, and returns what it hid', () => {
    const s = stubEngine()
    const hidden = hideEditorHelpers(s.engine)
    expect(s.grid.visible).toBe(false)
    expect(s.gizmo.visible).toBe(false)
    expect(s.mesh.visible).toBe(true)
    expect(hidden).toContain(s.grid)
    expect(hidden).toContain(s.gizmo)
    expect(hidden).not.toContain(s.hiddenGizmo)
  })
})

describe('renderExportFrame', () => {
  it('draws once, after the sync, with the grid and gizmos hidden — then gives the editor its helpers back', () => {
    const s = stubEngine()
    const doc = docWith([])
    const out = renderExportFrame(s.engine, doc, 0.5)
    expect(out).toBe(s.canvas)
    expect(s.raw.render).toHaveBeenCalledTimes(1)
    expect(s.seen[0]).toMatchObject({ grid: false, gizmo: false, mesh: true })
    // Restored afterwards: the editor's own engine renders its viewport again after an export.
    expect(s.grid.visible).toBe(true)
    expect(s.gizmo.visible).toBe(true)
    expect(s.hiddenGizmo.visible).toBe(false)
  })

  it('moves film grain with the scene clock (elapsed = t01 × loop duration); a still scene stays at 0', () => {
    const still = stubEngine()
    renderExportFrame(still.engine, docWith([]), 0.5)
    expect(still.seen[0]!.elapsed).toBe(0)

    const anim = stubEngine()
    const doc = docWith([])
    doc.objects[0]!.motion = { loop: { kind: 'spin', speed: 1 } } as never
    doc.motion.duration = 4
    renderExportFrame(anim.engine, doc, 0.25)
    expect(anim.seen[0]!.elapsed).toBe(1)
  })

  it('restores the helpers even when the render throws', () => {
    const s = stubEngine()
    s.raw.render.mockImplementation(() => { throw new Error('context lost') })
    expect(() => renderExportFrame(s.engine, docWith([]), 0)).toThrow('context lost')
    expect(s.gizmo.visible).toBe(true)
  })
})

describe('renderMotionFrame without options (existing callers)', () => {
  it('still renders at elapsed 0 with the grid as the sync left it', () => {
    const s = stubEngine()
    renderMotionFrame(s.engine, docWith([]), 0.5)
    expect(s.raw.render).toHaveBeenCalledTimes(1)
    expect(s.raw.render.mock.calls[0]).toEqual([])
    expect(s.seen[0]).toMatchObject({ grid: true, gizmo: true })
  })
})

describe('createRestyleLoader (the Frame preview: a long-lived engine)', () => {
  it('loads each result once across frames and hands the engine the object → texture map', async () => {
    const tex = new THREE.Texture()
    const io: ExportIO = { loadRestyle: vi.fn(async () => tex) }
    const loader = createRestyleLoader(io)
    const s = stubEngine()
    const doc = docWith([restyle('a.png')])
    await loader.apply(s.engine, doc)
    await loader.apply(s.engine, doc)
    expect(io.loadRestyle).toHaveBeenCalledTimes(1)
    expect(s.restyleMaps.at(-1)!.get(doc.objects[0]!.id)).toBe(tex)
  })

  it('a changed result is loaded fresh and the dropped one is released', async () => {
    const texA = new THREE.Texture(), texB = new THREE.Texture()
    const disposeA = vi.spyOn(texA, 'dispose')
    const io: ExportIO = { loadRestyle: vi.fn(async (r: string) => (r === 'a.png' ? texA : texB)) }
    const loader = createRestyleLoader(io)
    const s = stubEngine()
    const doc = docWith([restyle('a.png')])
    await loader.apply(s.engine, doc)
    ;(doc.objects[0]!.treatments![0] as AiRestyleTreatment).resultRef = 'b.png'
    await loader.apply(s.engine, doc)
    expect(s.restyleMaps.at(-1)!.get(doc.objects[0]!.id)).toBe(texB)
    expect(disposeA).toHaveBeenCalled()
  })

  it('a result that fails to load is not retried every frame, and the object draws plain', async () => {
    const io: ExportIO = { loadRestyle: vi.fn(async () => { throw new Error('gone') }) }
    const loader = createRestyleLoader(io)
    const s = stubEngine()
    const doc = docWith([restyle('gone.png')])
    await loader.apply(s.engine, doc)
    await loader.apply(s.engine, doc)
    expect(io.loadRestyle).toHaveBeenCalledTimes(1)
    expect(s.restyleMaps.at(-1)!.size).toBe(0)
  })

  it('a scene with no restyle loads nothing and clears the engine map', async () => {
    const io: ExportIO = { loadRestyle: vi.fn() }
    const loader = createRestyleLoader(io)
    const s = stubEngine()
    await loader.apply(s.engine, docWith([]))
    expect(io.loadRestyle).not.toHaveBeenCalled()
    expect(s.restyleMaps.at(-1)!.size).toBe(0)
  })
})
