// @vitest-environment happy-dom
// bakeSceneFrames — the 3D web export's bake — with the export renderer's GPU-facing seams
// (prepareExportEngine, settleFrameLoads, renderExportFrame) replaced, so what it asks for, in
// what order, and what it hands back are checked without WebGL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'
import type { SceneDoc } from '~/lib/scene3d/config'

const prepared: SceneDoc[] = []
const rendered: Array<{ doc: SceneDoc; t01: number }> = []
let prepareFailures: AssetFailure[] = []
let lateFailures: (t01: number) => AssetFailure[] = () => []
const engine = { dispose: vi.fn(), setCinematic: vi.fn() }
const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(new Blob(['frame'], { type: 'image/webp' })))
const canvas = { toBlob } as unknown as HTMLCanvasElement

vi.mock('~/lib/scene3d/exportRender', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/scene3d/exportRender')>()
  return {
    ...real,
    prepareExportEngine: vi.fn(async (doc: SceneDoc) => { prepared.push(doc); return { engine, failures: prepareFailures } }),
    settleFrameLoads: vi.fn(async (_e: unknown, _d: SceneDoc, t01: number) => lateFailures(t01)),
    renderExportFrame: vi.fn((_e: unknown, doc: SceneDoc, t01: number) => { rendered.push({ doc, t01 }); return canvas }),
  }
})

const { bakeSceneFrames } = await import('~/lib/scene3d/bakeFrames')
const { defaultDoc, createPrimitive } = await import('~/lib/scene3d/config')

function spinningDoc(): SceneDoc {
  const doc = defaultDoc()
  const o = createPrimitive('box', doc.objects)
  o.motion = { loop: { kind: 'spin', speed: 1 } } as never
  doc.objects.push(o)
  doc.motion.duration = 1
  return doc
}

beforeEach(() => {
  prepared.length = 0; rendered.length = 0; prepareFailures = []; lateFailures = () => []
  engine.dispose.mockClear(); toBlob.mockClear()
})

describe('bakeSceneFrames', () => {
  it('stops with the failures before encoding any frame when preparing names one', async () => {
    prepareFailures = [{ kind: 'model', name: 'robot.glb', reason: 'glb fetch failed: 404' }]
    const onProgress = vi.fn()
    const out = await bakeSceneFrames(spinningDoc(), { width: 32, height: 32, fps: 24, transparent: false, onProgress })
    expect(out.failures).toEqual(prepareFailures)
    expect(out.frames).toEqual([])
    expect(rendered).toEqual([])
    expect(toBlob).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(engine.dispose).toHaveBeenCalledTimes(1)         // no leaked WebGL context
  })

  it('a transparent bake renders on a transparent background without touching the caller\'s doc', async () => {
    const doc = spinningDoc()
    doc.background = '#223344' as never
    const before = JSON.stringify(doc)
    const out = await bakeSceneFrames(doc, { width: 32, height: 32, fps: 24, transparent: true })
    expect(out.failures).toEqual([])
    expect(out.frames).toHaveLength(24)
    expect(prepared[0]!.background).toBe('transparent')
    expect(rendered.every(r => r.doc.background === 'transparent')).toBe(true)
    expect(JSON.stringify(doc)).toBe(before)
    expect(doc.background).toBe('#223344')
  })

  it('an opaque bake keeps the scene\'s own background', async () => {
    const doc = spinningDoc()
    doc.background = '#223344' as never
    await bakeSceneFrames(doc, { width: 32, height: 32, fps: 24, transparent: false })
    expect(prepared[0]!.background).toBe('#223344')
  })

  it('a load a later frame starts is waited for before that frame renders, and one that fails stops the bake by name', async () => {
    const late: AssetFailure = { kind: 'decal', name: 'Logo', reason: 'HTTP 404' }
    lateFailures = t01 => (t01 >= 0.5 ? [late] : [])
    const out = await bakeSceneFrames(spinningDoc(), { width: 32, height: 32, fps: 4, transparent: false })
    expect(out.failures).toEqual([late])
    expect(out.frames).toEqual([])
    expect(rendered.map(r => r.t01)).toEqual([0, 0.25])     // the failing frame is never rendered
    expect(engine.dispose).toHaveBeenCalledTimes(1)
  })
})
