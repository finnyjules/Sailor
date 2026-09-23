// The export-settling wiring (Task 2 review fixes): each engine load site reports a failed load
// by kind and object name, a superseded load reports nothing, and `settleAllAssets` returns by
// its deadline, names what is still loading, and counts only this engine's texture loads.
// Same stand-in `this` trick as scene3d-engine.unit.spec.ts — the REAL prototype methods run
// against a host that mirrors just the fields they touch — with the three loaders swapped for
// promises the test settles by hand.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { SceneEngine } from '~/lib/scene3d/engine'
import { createPrimitive, createGlbObject, type PrimitiveObject, type GlbObject } from '~/lib/scene3d/config'
import { AssetTracker, REASON_DIDNT_FINISH } from '~/lib/scene3d/assetTracker'
import { textureLoads, trackTextureLoad } from '~/lib/scene3d/materials'

const loads = vi.hoisted(() => {
  const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  return {
    map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defer: (k: string): Promise<any> => new Promise((resolve, reject) => { map.set(k, { resolve, reject }) }),
  }
})
vi.mock('~/lib/scene3d/glb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/scene3d/glb')>()),
  loadGlb: (url: string) => loads.defer(`glb:${url}`),
}))
vi.mock('~/lib/scene3d/outlines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/scene3d/outlines')>()),
  loadFont: (url: string) => loads.defer(`font:${url}`),
}))
vi.mock('~/lib/scene3d/meshCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/scene3d/meshCache')>()),
  loadMesh: (_encoded: string, key: string) => loads.defer(`mesh:${key}`),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = SceneEngine.prototype as any
let hostSeq = 0
const makeHost = () => ({
  id: `test-engine-${++hostSeq}`,
  objectRoots: new Map<string, THREE.Object3D>(),
  glbTokens: new Map<string, number>(),
  fontTokens: new Map<string, number>(),
  meshTokens: new Map<string, number>(),
  decalTokens: new Map<string, number>(),
  pendingDecals: new Map<string, Promise<void>>(),
  assets: new AssetTracker(),
  textureMark: textureLoads.mark,
  geometryForObject: proto.geometryForObject,
  syncObject: proto.syncObject,
  pendingDecalNames: proto.pendingDecalNames,
  restyleSpecFor: proto.restyleSpecFor,
  restyleTextures: new Map<string, THREE.Texture>(),
  token: 0,
  deferGeometry: false,
  lightView: false,
  clay: new THREE.MeshStandardMaterial(),
  scene: { add() {}, remove() {} },
})
type Host = ReturnType<typeof makeHost>
const sync = (host: Host, obj: PrimitiveObject | GlbObject) => proto.syncObject.call(host, obj)
const settleAll = (host: Host, opts?: { timeoutMs?: number }) => proto.settleAllAssets.call(host, opts)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { loads.map.clear() })

describe('engine load sites report failures by name', () => {
  it('a GLB load that rejects is a model failure named after the object', async () => {
    const host = makeHost()
    const obj = createGlbObject('http://127.0.0.1:1/Sneaker.glb', [])
    sync(host, obj)
    loads.map.get(`glb:${obj.url}`)!.reject(new Error('HTTP 403'))
    expect(await settleAll(host)).toEqual([{ kind: 'model', name: 'Sneaker', reason: 'HTTP 403' }])
  })

  it('a superseded GLB load that rejects is not a failure', async () => {
    const host = makeHost()
    const obj = createGlbObject('http://127.0.0.1:1/Old.glb', [])
    sync(host, obj)
    sync(host, { ...obj, url: 'http://127.0.0.1:1/New.glb' }) // url change: the old load is stale
    loads.map.get('glb:http://127.0.0.1:1/Old.glb')!.reject(new Error('HTTP 404'))
    await tick()
    expect(host.assets.failures()).toEqual([])
  })

  it('a font load that rejects is a font failure named by its font', async () => {
    const host = makeHost()
    const url = '/fonts/__assets-test-broken.otf'
    const obj: PrimitiveObject = { ...createPrimitive('text', []), content: { text: 'Hi', font: url } }
    sync(host, obj)
    loads.map.get(`font:${url}`)!.reject(new Error('offline'))
    expect(await settleAll(host)).toEqual([{ kind: 'font', name: url, reason: 'offline' }])
  })

  it('a superseded font load that rejects is not a failure', async () => {
    const host = makeHost()
    const a = '/fonts/__assets-test-a.otf'
    const b = '/fonts/__assets-test-b.otf'
    const obj: PrimitiveObject = { ...createPrimitive('text', []), content: { text: 'Hi', font: a } }
    sync(host, obj)
    sync(host, { ...obj, content: { text: 'Hi', font: b } })
    expect(loads.map.has(`font:${b}`)).toBe(true) // the newer load started, superseding a
    loads.map.get(`font:${a}`)!.reject(new Error('offline'))
    await tick()
    expect(host.assets.failures()).toEqual([])
  })

  it('a mesh decode that rejects is a mesh failure named after the object', async () => {
    const host = makeHost()
    const obj: PrimitiveObject = { ...createPrimitive('mesh', []), name: 'Bust', content: { mesh: 'x', meshKey: 'k-broken' } }
    sync(host, obj)
    loads.map.get('mesh:k-broken')!.reject(new Error('bad mesh'))
    expect(await settleAll(host)).toEqual([{ kind: 'mesh', name: 'Bust', reason: 'bad mesh' }])
  })

  it('a superseded mesh decode that rejects is not a failure', async () => {
    const host = makeHost()
    const obj: PrimitiveObject = { ...createPrimitive('mesh', []), name: 'Bust', content: { mesh: 'x', meshKey: 'k-a' } }
    sync(host, obj)
    sync(host, { ...obj, content: { mesh: 'y', meshKey: 'k-b' } })
    expect(loads.map.has('mesh:k-b')).toBe(true)
    loads.map.get('mesh:k-a')!.reject(new Error('bad mesh'))
    await tick()
    expect(host.assets.failures()).toEqual([])
  })
})

describe('settleAllAssets', () => {
  it('a load that never settles: returns within the deadline, naming it', async () => {
    const host = makeHost()
    const obj = createGlbObject('http://127.0.0.1:1/Stalled.glb', [])
    sync(host, obj) // its loadGlb never settles
    const start = Date.now()
    const failures = await settleAll(host, { timeoutMs: 50 })
    expect(Date.now() - start).toBeLessThan(1000)
    expect(failures).toEqual([{ kind: 'model', name: 'Stalled', reason: REASON_DIDNT_FINISH }])
  })

  it('a decal still building at the deadline is named from its object', async () => {
    const host = makeHost()
    const root = new THREE.Group()
    root.userData.decalObj = { name: 'Sticker' }
    host.objectRoots.set('d1', root)
    host.pendingDecals.set('d1#7', new Promise<void>(() => {}))
    expect(await settleAll(host, { timeoutMs: 20 })).toEqual([{ kind: 'decal', name: 'Sticker', reason: REASON_DIDNT_FINISH }])
  })

  it("another engine's texture loads are neither waited on nor reported", async () => {
    const host = makeHost()
    const other = `${host.id}-other`
    trackTextureLoad('theirs-stalled.jpg', other) // never settles
    trackTextureLoad('theirs-broken.jpg', other).failed()()
    textureLoads.fail('texture', 'theirs-too.jpg', 'HTTP 404', other)
    trackTextureLoad('mine-broken.jpg', host.id).failed()()
    const start = Date.now()
    const failures = await settleAll(host, { timeoutMs: 5000 })
    expect(Date.now() - start).toBeLessThan(1000)
    expect(failures).toEqual([{ kind: 'texture', name: 'mine-broken.jpg', reason: 'could not load the image' }])
  })

  it('a shared texture load joined by this engine counts for it', async () => {
    const host = makeHost()
    const track = trackTextureLoad('shared-broken.jpg', `${host.id}-first`)
    track.addOwner(host.id) // a second engine hit the cache while the file was downloading
    track.failed()()
    expect(await settleAll(host)).toEqual([{ kind: 'texture', name: 'shared-broken.jpg', reason: 'could not load the image' }])
  })

  it('texture failures recorded before this engine existed are not its', async () => {
    const early = makeHost()
    textureLoads.fail('texture', 'early.jpg', 'HTTP 404', early.id)
    const host = { ...makeHost(), id: early.id } // same id, later mark (a fence, should an id ever repeat)
    expect(await settleAll(host)).toEqual([])
  })

  it('nothing in flight: returns at once', async () => {
    const host = makeHost()
    expect(await settleAll(host)).toEqual([])
  })
})

describe('trackTextureLoad', () => {
  it('the load callback throws: the error still reaches the caller, and the tracked load still settles', async () => {
    const owner = `track-${++hostSeq}`
    const t = trackTextureLoad('throws-on-load.jpg', owner)
    expect(t.loaded(() => { throw new Error('boom') })).toThrow('boom')
    expect(await textureLoads.settle({ owner, deadline: Date.now() + 1000 })).toEqual([])
    expect(textureLoads.pendingFor(owner)).toBe(0)
  })

  it('the error callback throws: the error still reaches the caller, and the failure is recorded', async () => {
    const owner = `track-${++hostSeq}`
    const t = trackTextureLoad('throws-on-error.jpg', owner)
    expect(t.failed(() => { throw new Error('boom') })).toThrow('boom')
    expect(await textureLoads.settle({ owner, deadline: Date.now() + 1000 })).toEqual([
      { kind: 'texture', name: 'throws-on-error.jpg', reason: 'could not load the image' },
    ])
  })

  it('stillWanted false (the material was disposed): settles quietly, no failure', async () => {
    const owner = `track-${++hostSeq}`
    const t = trackTextureLoad('disposed.jpg', owner)
    let ran = false
    t.failed(() => { ran = true }, () => false)()
    expect(ran).toBe(true) // the site's own handler still runs
    expect(await textureLoads.settle({ owner, deadline: Date.now() + 1000 })).toEqual([])
    expect(textureLoads.pendingFor(owner)).toBe(0)
  })
})
