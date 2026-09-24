// @vitest-environment happy-dom
// prepareExportEngine and the Frame preview's deadline — with a stand-in engine that records
// the order of what it is asked to do (the real one needs WebGL).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

const calls: string[] = []
const settleOpts: Array<{ timeoutMs?: number }> = []
let failSetSize = false
let lastEngine: { dispose: ReturnType<typeof vi.fn> } | null = null

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
    refreshShaderFields(t: number) { calls.push(`refreshShaderFields:${t}`) }
    async settleAllAssets(opts: { timeoutMs?: number }) { calls.push('settleAllAssets'); settleOpts.push(opts); return [] }
    applyCameraFromDoc() {}
    applyObjectOpacities() {}
    setMotionVelocities() {}
    setGhostPoses() {}
    render() { calls.push('render') }
  },
}))

const {
  prepareExportEngine, renderExportFrameSettled, createRestyleLoader, ensureShaderCatalog,
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

beforeEach(() => { calls.length = 0; settleOpts.length = 0; failSetSize = false; lastEngine = null })
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
