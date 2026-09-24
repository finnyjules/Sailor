// @vitest-environment happy-dom
// prepareExportEngine and the Frame preview's deadline — with a stand-in engine that records
// the order of what it is asked to do (the real one needs WebGL).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

const calls: string[] = []
const settleOpts: Array<{ timeoutMs?: number }> = []
let failSetSize = false
let lastEngine: { dispose: ReturnType<typeof vi.fn> } | null = null
/** What the stand-in engine reports: loads in flight after a sync, and what a settle returns. */
let pendingAfterSync = false
let settleResult: Array<{ kind: string; name: string; reason: string }> = []

vi.mock('~/lib/scene3d/engine', () => ({
  SceneEngine: class {
    scene = new THREE.Scene()
    grid = new THREE.Object3D()
    camera = new THREE.PerspectiveCamera()
    renderer = { domElement: { tag: 'canvas' }, setPixelRatio: () => { calls.push('setPixelRatio') } }
    dispose = vi.fn(() => { calls.push('dispose') })
    constructor() { lastEngine = this as never }
    setSize() { calls.push('setSize'); if (failSetSize) throw new Error('context lost') }
    setRestyleTextures(m: Map<string, unknown>) { calls.push(`setRestyleTextures:${m.size}`) }
    syncFromDoc() { calls.push('syncFromDoc') }
    hasPendingAssets() { calls.push('hasPendingAssets'); return pendingAfterSync }
    refreshShaderFields(t: number) { calls.push(`refreshShaderFields:${t}`) }
    async settleAllAssets(opts: { timeoutMs?: number }) { calls.push('settleAllAssets'); settleOpts.push(opts); return settleResult }
    applyCameraFromDoc() {}
    applyObjectOpacities() {}
    setMotionVelocities() {}
    setGhostPoses() {}
    render() { calls.push('render') }
  },
}))

const {
  prepareExportEngine, renderExportFrameSettled, createRestyleLoader, ensureShaderCatalog, openSceneExport,
  settleFrameLoads, sceneShaderEffectIds, SceneExportFailed,
  EXPORT_TIMEOUT_MS, PREVIEW_TIMEOUT_MS, RETRY_AFTER_MS,
} = await import('~/lib/scene3d/exportRender')
const { SceneEngine } = await import('~/lib/scene3d/engine')
const { defaultDoc, createPrimitive } = await import('~/lib/scene3d/config')
const { createTreatment } = await import('~/lib/scene3d/treatments')
import type { ExportIO } from '~/lib/scene3d/exportRender'
import type { SceneDoc } from '~/lib/scene3d/config'
import type { AiRestyleTreatment } from '~/lib/scene3d/treatments'

function restyledDoc(ref = 'r.png', shaderFill = false): SceneDoc {
  const doc = defaultDoc()
  const o = createPrimitive('box', doc.objects)
  o.treatments = [{ ...(createTreatment('aiRestyle') as AiRestyleTreatment), resultRef: ref, enabled: true }]
  if (shaderFill) o.material = { ...o.material, type: 'shaderFill', shader: { effect: 'x' } } as never
  doc.objects.push(o)
  return doc
}

const never = <T>() => new Promise<T>(() => {})

beforeEach(() => { calls.length = 0; settleOpts.length = 0; failSetSize = false; lastEngine = null; pendingAfterSync = false; settleResult = [] })
afterEach(() => { vi.useRealTimers() })

describe('prepareExportEngine — the export\'s first frame has everything', () => {
  it('sets the restyle map BEFORE the sync, warms the shader fields, and only then settles', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: async () => {} }
    const { failures } = await prepareExportEngine(restyledDoc('r.png', true), { width: 64, height: 64, io })
    expect(failures).toEqual([])
    const i = (name: string) => calls.findIndex((c) => c.startsWith(name))
    expect(calls).toContain('setRestyleTextures:1')
    expect(i('setRestyleTextures')).toBeLessThan(i('syncFromDoc'))
    expect(i('syncFromDoc')).toBeLessThan(i('refreshShaderFields'))
    expect(calls).toContain('refreshShaderFields:0')
    expect(i('refreshShaderFields')).toBeLessThan(i('settleAllAssets'))
  })

  it('the restyle and catalog waits are inside the one export deadline, and the settle gets what is left', async () => {
    vi.useFakeTimers()
    const io: ExportIO = { loadRestyle: () => never(), loadShaderCatalog: () => never() }
    const p = prepareExportEngine(restyledDoc('slow.png', true), { width: 64, height: 64, io })
    await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS)
    const { failures } = await p
    expect(failures).toEqual([
      { kind: 'restyle', name: 'slow.png', reason: "didn't finish loading" },
      { kind: 'shader', name: 'Shader effects', reason: "didn't finish loading" },
    ])
    expect(settleOpts[0]!.timeoutMs).toBeLessThanOrEqual(0)
  })

  it('names a failed catalog fetch as a shader asset', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: async () => { throw new Error('offline') } }
    const { failures } = await prepareExportEngine(restyledDoc('r.png', true), { width: 64, height: 64, io })
    expect(failures).toEqual([{ kind: 'shader', name: 'Shader effects', reason: 'offline' }])
  })

  it('disposes the engine when preparing it throws (no leaked WebGL context)', async () => {
    failSetSize = true
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture() }
    await expect(prepareExportEngine(restyledDoc(), { width: 64, height: 64, io })).rejects.toThrow('context lost')
    expect(lastEngine!.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('renderExportFrameSettled — a slow backend never blocks the Frame preview', () => {
  it('renders by the deadline with what is in hand when the restyle and the catalog stall', async () => {
    vi.useFakeTimers()
    const io: ExportIO = { loadRestyle: () => never(), loadShaderCatalog: () => never() }
    const engine = new SceneEngine(null as never, 1, 1)
    let done = false
    const p = renderExportFrameSettled(engine, restyledDoc('stall.png', true), 0, {
      timeoutMs: PREVIEW_TIMEOUT_MS, restyle: createRestyleLoader(io), io,
    }).then((c) => { done = true; return c })
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(await p).toBeTruthy()
    expect(calls).toContain('setRestyleTextures:0')      // drawn plain for now
    expect(calls.at(-1)).toBe('render')
    expect(settleOpts.at(-1)!.timeoutMs).toBeLessThanOrEqual(0)
  })

  it('a restyle that lands after the deadline shows on a later frame', async () => {
    vi.useFakeTimers()
    let resolve!: (t: THREE.Texture) => void
    const io: ExportIO = { loadRestyle: vi.fn(() => new Promise<THREE.Texture>((r) => { resolve = r })) }
    const loader = createRestyleLoader(io)
    const engine = new SceneEngine(null as never, 1, 1)
    const doc = restyledDoc('late.png')
    const first = renderExportFrameSettled(engine, doc, 0, { timeoutMs: PREVIEW_TIMEOUT_MS, restyle: loader, io })
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    await first
    expect(calls).toContain('setRestyleTextures:0')
    resolve(new THREE.Texture())
    await renderExportFrameSettled(engine, doc, 0.5, { timeoutMs: PREVIEW_TIMEOUT_MS, restyle: loader, io })
    expect(calls.filter((c) => c.startsWith('setRestyleTextures')).at(-1)).toBe('setRestyleTextures:1')
    expect(io.loadRestyle).toHaveBeenCalledTimes(1)
  })
})

describe('createRestyleLoader onLate', () => {
  it('calls back when a result an apply stopped waiting for lands (a card redraws), not for an on-time one', async () => {
    vi.useFakeTimers()
    let resolve!: (t: THREE.Texture) => void
    const io: ExportIO = { loadRestyle: () => new Promise<THREE.Texture>((r) => { resolve = r }) }
    const onLate = vi.fn()
    const loader = createRestyleLoader(io, { onLate })
    const engine = new SceneEngine(null as never, 1, 1)
    const applied = loader.apply(engine, restyledDoc('late.png'), { deadline: Date.now() + 100 })
    await vi.advanceTimersByTimeAsync(100)
    await applied
    expect(onLate).not.toHaveBeenCalled()
    resolve(new THREE.Texture())
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).toHaveBeenCalledTimes(1)

    const onTime = vi.fn()
    const quick = createRestyleLoader({ loadRestyle: async () => new THREE.Texture() }, { onLate: onTime })
    await quick.apply(engine, restyledDoc('quick.png'), { deadline: Date.now() + 100 })
    expect(onTime).not.toHaveBeenCalled()
  })
})

describe('retries after a cool-down, not every frame and not never', () => {
  it('a failed restyle load is tried again after RETRY_AFTER_MS', async () => {
    vi.useFakeTimers()
    let fail = true
    const io: ExportIO = { loadRestyle: vi.fn(async () => { if (fail) throw new Error('404'); return new THREE.Texture() }) }
    const loader = createRestyleLoader(io)
    const engine = new SceneEngine(null as never, 1, 1)
    const doc = restyledDoc('flaky.png')
    await loader.apply(engine, doc)
    await loader.apply(engine, doc)
    expect(io.loadRestyle).toHaveBeenCalledTimes(1)
    fail = false
    vi.advanceTimersByTime(RETRY_AFTER_MS)
    await loader.apply(engine, doc)
    expect(io.loadRestyle).toHaveBeenCalledTimes(2)
    expect(calls.filter((c) => c.startsWith('setRestyleTextures')).at(-1)).toBe('setRestyleTextures:1')
  })

  it('a failed catalog fetch backs off on the preview path, but an export always tries', async () => {
    vi.useFakeTimers()
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: vi.fn(async () => { throw new Error('offline') }) }
    const doc = restyledDoc('r.png', true)
    const preview = { retryAfterMs: RETRY_AFTER_MS }
    expect(await ensureShaderCatalog(doc, io, preview)).toEqual([{ kind: 'shader', name: 'Shader effects', reason: 'offline' }])
    expect(await ensureShaderCatalog(doc, io, preview)).toEqual([{ kind: 'shader', name: 'Shader effects', reason: 'offline' }])
    expect(io.loadShaderCatalog).toHaveBeenCalledTimes(1)
    await ensureShaderCatalog(doc, io)                     // an export: no back-off
    expect(io.loadShaderCatalog).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(RETRY_AFTER_MS)
    await ensureShaderCatalog(doc, io, preview)
    expect(io.loadShaderCatalog).toHaveBeenCalledTimes(3)
  })
})

describe('openSceneExport — a Frame export\'s 3D session', () => {
  it('renders every frame on an engine of its own, over a snapshot of the scene, and close() disposes it once', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: async () => {} }
    const preview = new SceneEngine(null as never, 1, 1)   // the node's shared preview engine
    const doc = restyledDoc('r.png')
    const session = await openSceneExport(doc, { width: 320, height: 180 }, io)
    const own = lastEngine as unknown as InstanceType<typeof SceneEngine>
    expect(own).not.toBe(preview)
    expect(session.failures).toEqual([])
    const synced: number[] = []
    vi.spyOn(own, 'syncFromDoc').mockImplementation(((d: SceneDoc) => { synced.push(d.objects.length) }) as never)
    doc.objects.push(createPrimitive('sphere', doc.objects))   // an edit after the session opened
    calls.length = 0
    expect(await session.frame(0.5)).toBeTruthy()
    expect(calls).toContain('render')
    expect(new Set(synced)).toEqual(new Set([1]))              // the snapshot, not the edit
    expect(own.dispose).not.toHaveBeenCalled()
    session.close(); session.close()
    expect(own.dispose).toHaveBeenCalledTimes(1)
    expect(preview.dispose).not.toHaveBeenCalled()
    await expect(session.frame(0)).rejects.toThrow()
  })

  it('a frame whose sync starts nothing does not settle; one that starts a load waits for it, then renders', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture() }
    const session = await openSceneExport(restyledDoc('r.png'), { width: 64, height: 64 }, io)
    calls.length = 0; settleOpts.length = 0
    await session.frame(0.25)
    expect(calls).not.toContain('settleAllAssets')
    pendingAfterSync = true                                     // this frame rebuilt a decal
    calls.length = 0
    await session.frame(0.5)
    const i = (name: string) => calls.indexOf(name)
    expect(i('syncFromDoc')).toBeLessThan(i('hasPendingAssets'))
    expect(i('hasPendingAssets')).toBeLessThan(i('settleAllAssets'))
    expect(i('settleAllAssets')).toBeLessThan(i('render'))
    expect(settleOpts.at(-1)!.timeoutMs).toBe(EXPORT_TIMEOUT_MS)
    session.close()
  })

  it('a load a frame started that fails stops the session with it (the Frame blocks), rendering nothing', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture() }
    const session = await openSceneExport(restyledDoc('r.png'), { width: 64, height: 64 }, io)
    pendingAfterSync = true
    settleResult = [{ kind: 'decal', name: 'Logo', reason: 'HTTP 404' }]
    calls.length = 0
    const err = await session.frame(0.5).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SceneExportFailed)
    expect((err as InstanceType<typeof SceneExportFailed>).assetFailures).toEqual(settleResult)
    expect(calls).not.toContain('render')
    session.close()
  })
})

describe('settleFrameLoads', () => {
  it('syncs at t01 and returns [] without waiting when nothing started loading', async () => {
    const engine = new SceneEngine(null as never, 1, 1)
    expect(await settleFrameLoads(engine, restyledDoc(), 0.5)).toEqual([])
    expect(calls).toEqual(['syncFromDoc', 'hasPendingAssets'])
  })
})

describe('shader effects are waited for, and one that never gets its images is named', () => {
  function shaderDoc(effectId: string): SceneDoc {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    o.material = { ...o.material, type: 'shaderFill', shader: { effectId, params: {}, anchor: 'object' } } as never
    doc.objects.push(o)
    return doc
  }

  it('lists a shader fill\'s and a shader relief\'s effects, once each', () => {
    const doc = shaderDoc('liquid')
    const r = createPrimitive('sphere', doc.objects)
    r.material = { ...r.material, relief: { source: 'shader', spec: { effectId: 'grain', params: {}, anchor: 'object' } } } as never
    doc.objects.push(r)
    const again = createPrimitive('box', doc.objects)
    again.material = { ...again.material, type: 'shaderFill', shader: { effectId: 'liquid', params: {}, anchor: 'object' } } as never
    doc.objects.push(again)
    expect(sceneShaderEffectIds(doc).sort()).toEqual(['grain', 'liquid'])
  })

  it('an effect whose images arrive is waited for; one that never does is named by its label', async () => {
    const ready = vi.fn(async (id: string) => id !== 'stuck')
    const io: ExportIO = {
      loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: async () => {},
      shaderEffectReady: ready, shaderEffectLabel: id => (id === 'stuck' ? 'Liquid chrome' : id),
    }
    expect((await prepareExportEngine(shaderDoc('fine'), { width: 8, height: 8, io })).failures).toEqual([])
    const { failures } = await prepareExportEngine(shaderDoc('stuck'), { width: 8, height: 8, io })
    expect(failures).toEqual([{ kind: 'shader', name: 'Liquid chrome', reason: "didn't finish loading" }])
    expect(ready.mock.calls[1]![1]).toBeGreaterThan(0)          // inside the export deadline
    expect(ready.mock.calls[1]![1]).toBeLessThanOrEqual(EXPORT_TIMEOUT_MS)
  })

  it('does not wait for the effects when the catalog itself failed (that is the one failure worth naming)', async () => {
    const ready = vi.fn(async () => false)
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: async () => { throw new Error('offline') }, shaderEffectReady: ready }
    const { failures } = await prepareExportEngine(shaderDoc('x'), { width: 8, height: 8, io })
    expect(failures).toEqual([{ kind: 'shader', name: 'Shader effects', reason: 'offline' }])
    expect(ready).not.toHaveBeenCalled()
  })
})

describe('a hung load costs the Frame preview ONE wait, not one per frame', () => {
  it('after one timed-out pull, the next pull does not wait; once nothing is pending it waits again', async () => {
    vi.useFakeTimers()
    let resolve!: (t: THREE.Texture) => void
    const io: ExportIO = { loadRestyle: vi.fn(() => new Promise<THREE.Texture>((r) => { resolve = r })) }
    const loader = createRestyleLoader(io)
    const engine = new SceneEngine(null as never, 1, 1)
    const doc = restyledDoc('hung.png')
    const stall = { stalled: false }
    const opts = { timeoutMs: PREVIEW_TIMEOUT_MS, restyle: loader, io, stall }

    const first = renderExportFrameSettled(engine, doc, 0, opts)
    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS)
    await first
    expect(stall.stalled).toBe(true)

    // Still hung: the next pull renders at once — no timer has to run.
    let done = false
    const second = renderExportFrameSettled(engine, doc, 0.1, opts).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    await second
    expect(settleOpts.at(-1)!.timeoutMs).toBe(0)
    expect(stall.stalled).toBe(true)

    // It lands: this pull finds nothing pending and clears the stall …
    resolve(new THREE.Texture())
    await vi.advanceTimersByTimeAsync(0)
    await renderExportFrameSettled(engine, doc, 0.2, opts)
    expect(stall.stalled).toBe(false)
    expect(calls.filter(c => c.startsWith('setRestyleTextures')).at(-1)).toBe('setRestyleTextures:1')
    // … and the one after it gets the full deadline back.
    await renderExportFrameSettled(engine, doc, 0.3, opts)
    expect(settleOpts.at(-1)!.timeoutMs).toBe(PREVIEW_TIMEOUT_MS)
  })

  it('an engine asset that did not finish stalls too; a loaded shader catalog never does', async () => {
    const io: ExportIO = { loadRestyle: async () => new THREE.Texture(), loadShaderCatalog: vi.fn(async () => {}) }
    const engine = new SceneEngine(null as never, 1, 1)
    const stall = { stalled: false }
    const doc = restyledDoc('r.png', true)
    settleResult = [{ kind: 'model', name: 'm.glb', reason: "didn't finish loading" }]
    await renderExportFrameSettled(engine, doc, 0, { timeoutMs: PREVIEW_TIMEOUT_MS, io, stall })
    expect(stall.stalled).toBe(true)
    settleResult = [{ kind: 'model', name: 'm.glb', reason: 'HTTP 404' }]     // failed, not pending
    await renderExportFrameSettled(engine, doc, 0, { timeoutMs: PREVIEW_TIMEOUT_MS, io, stall })
    expect(stall.stalled).toBe(false)
    // The catalog loaded on the first pull; with no time left it still counts as in hand.
    stall.stalled = true
    settleResult = []
    await renderExportFrameSettled(engine, doc, 0, { timeoutMs: PREVIEW_TIMEOUT_MS, io, stall })
    expect(stall.stalled).toBe(false)
    expect(io.loadShaderCatalog).toHaveBeenCalledTimes(1)
  })

  it('hands back what could not load, by name', async () => {
    const io: ExportIO = { loadRestyle: async () => { throw new Error('gone') } }
    const session = await openSceneExport(restyledDoc('lost.png'), { width: 64, height: 64 }, io)
    expect(session.failures).toEqual([{ kind: 'restyle', name: 'lost.png', reason: 'gone' }])
    session.close()
  })
})
