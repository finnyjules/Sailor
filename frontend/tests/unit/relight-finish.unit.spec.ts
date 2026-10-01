/**
 * Relight stage 3 ("Finish", Task 2 + fix round 1): the pure apply/revert patch builders and
 * `canFinishRelight` (`app/lib/relight/finish.ts`), the `skipTint` draw option
 * (`useCompositorLayers.ts`'s `drawLayerContent`, exercised through the `__drawLayerContentForTest`
 * seam), and the client request (`app/composables/useRelightFinish.ts`), `fetch` stubbed — no real
 * fal call. `renderRelightPair` itself needs a live decoded image, a built depth field and a
 * WebGL2 context; the existing harness has no cheap way to fake all three, so it is left to
 * Task 4's browser test (per the brief).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { finishApplyPatch, finishRevertPatch, canFinishRelight, finishBoxSize, type FinishableLayer } from '~/lib/relight/finish'
import { requestRelightFinish } from '~/composables/useRelightFinish'
import { effectStackOf } from '~/lib/compositor/effectStack'
import {
  __drawLayerContentForTest, __setImageForTest, __clearImageCacheForTest, createImageLayer,
  type LocalLayer,
} from '~/composables/useCompositorLayers'

const relightFx = (id = 'fx:relight:0') => ({ id, type: 'relight' as const, visible: true, lights: [], keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true })
const blurFx = (id = 'fx:layer_blur:0') => ({ id, type: 'layer_blur' as const, visible: true, radius: 4 })

describe('canFinishRelight', () => {
  it('accepts a plain image layer with a filename and no clip', () => {
    expect(canFinishRelight({ kind: 'image', filename: 'a.png' })).toBe(true)
  })

  it('rejects a wired layer (no stable file for fal — depth keys it by a /view URL, not a filename)', () => {
    expect(canFinishRelight({ kind: 'wired' })).toBe(false)
  })

  it('rejects an image layer with no filename', () => {
    expect(canFinishRelight({ kind: 'image', filename: '' })).toBe(false)
    expect(canFinishRelight({ kind: 'image' })).toBe(false)
  })

  it('rejects an image layer carrying a living-image clip', () => {
    expect(canFinishRelight({ kind: 'image', filename: 'a.png', clip: { dir: 'x', frames: 3 } })).toBe(false)
  })

  it('rejects every other layer kind', () => {
    expect(canFinishRelight({ kind: 'text', filename: 'a.png' })).toBe(false)
    expect(canFinishRelight({ kind: 'brush' })).toBe(false)
  })
})

describe('finishApplyPatch', () => {
  it('sets a centred cover crop (not undefined) — the model may return a slightly different aspect', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', crop: { fit: 'cover', fx: 0.3, fy: 0.7 }, effects: [relightFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.crop).toEqual({ fit: 'cover' })
  })

  it('sets a centred cover crop even when the layer previously had no crop (a stretch)', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.crop).toEqual({ fit: 'cover' })
  })

  it('sets the new filename', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.filename).toBe('result.png')
  })

  it('removes the Relight entry and keeps every other effect', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx(), blurFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.effects.map(e => e.type)).toEqual(['layer_blur'])
  })

  it('removes the Relight entry from a LEGACY (id-less) stack by the id the live stack mints for it', () => {
    // No `id` field on either entry: effectStackOf's old-shape branch mints deterministic
    // `fx:<type>:<ordinal>` ids — Task 3 must read the id from the SAME `effectStackOf` call
    // the live Relight panel uses, not assume a caller-chosen id.
    const layer: FinishableLayer = {
      id: 'l1', filename: 'orig.png',
      effects: [
        { type: 'relight', visible: true, lights: [], keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true },
        { type: 'layer_blur', visible: true, radius: 4 },
      ] as unknown as FinishableLayer['effects'],
    }
    const mintedId = effectStackOf(layer).find(e => e.type === 'relight')!.id
    expect(mintedId).toBe('fx:relight:0')
    const patch = finishApplyPatch(layer, 'result.png', mintedId)
    expect(patch.effects.map(e => e.type)).toEqual(['layer_blur'])
  })

  it('is a no-op on the stack when the given relightId is not present', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [blurFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.effects.map(e => e.type)).toEqual(['layer_blur'])
  })

  it('clears a layer\'s REAL legacy tornEdge/feather fields once applied (writeStackToLayer retires them)', () => {
    const layer = {
      id: 'l1', filename: 'orig.png', effects: [relightFx()],
      tornEdge: { amount: 0.5, seed: 1 }, feather: { amount: 0.3 },
    } as unknown as FinishableLayer
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    const merged = { ...layer, ...patch }
    expect(merged.tornEdge).toBeUndefined()
    expect(merged.feather).toBeUndefined()
  })

  it('does not touch tint/tintBlend/tintOpacity — Finish keeps them live on the layer (ruling 1)', () => {
    const layer = {
      id: 'l1', filename: 'orig.png', effects: [relightFx()],
      tint: '#ff0000', tintBlend: 'multiply', tintOpacity: 0.6,
    } as unknown as FinishableLayer
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch).not.toHaveProperty('tint')
    expect(patch).not.toHaveProperty('tintBlend')
    expect(patch).not.toHaveProperty('tintOpacity')
    const merged = { ...layer, ...patch } as typeof layer
    expect(merged.tint).toBe('#ff0000')
    expect(merged.tintBlend).toBe('multiply')
    expect(merged.tintOpacity).toBe(0.6)
  })
})

describe('Finish and Frame lights (light layers stage 2 final review)', () => {
  it('the result is unlit — it already carries the Frame\'s light and Darkness', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    expect(finishApplyPatch(layer, 'result.png', 'fx:relight:0').lit).toBe(false)
  })

  it('Revert restores the photo\'s own lit — absent stays absent, false stays false', () => {
    const absent: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    const r1 = finishRevertPatch(absent)
    expect(r1.lit).toBeUndefined()
    const applied = { ...absent, ...finishApplyPatch(absent, 'result.png', 'fx:relight:0') }
    const reverted = JSON.parse(JSON.stringify({ ...applied, ...r1 }))
    expect('lit' in reverted).toBe(false)
    const off: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()], lit: false }
    expect(finishRevertPatch(off).lit).toBe(false)
    const on: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()], lit: true }
    expect(finishRevertPatch(on).lit).toBe(true)
  })
})

describe('finishRevertPatch', () => {
  it('captures the layer\'s current filename, crop and full stack (Relight included)', () => {
    const crop = { fit: 'cover' as const, fx: 0.3, fy: 0.7 }
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', crop, effects: [relightFx(), blurFx()] }
    const patch = finishRevertPatch(layer)
    expect(patch.filename).toBe('orig.png')
    expect(patch.crop).toEqual(crop)
    expect(patch.effects.map(e => e.type)).toEqual(['relight', 'layer_blur'])
  })

  it('preserves an absent crop as undefined (no crop ⇒ stretch, not a fabricated cover)', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    const patch = finishRevertPatch(layer)
    expect(patch.crop).toBeUndefined()
  })

  it('applying then reverting round-trips back to the original stack and crop', () => {
    const crop = { fit: 'cover' as const, fx: 0.5, fy: 0.5 }
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', crop, effects: [relightFx(), blurFx()] }
    const revert = finishRevertPatch(layer)
    const applied: FinishableLayer = { ...layer, ...finishApplyPatch(layer, 'result.png', 'fx:relight:0') }
    const reverted = { ...applied, ...revert }
    expect(reverted.filename).toBe('orig.png')
    expect(reverted.crop).toEqual(crop)
    expect(reverted.effects.map((e: { type: string }) => e.type)).toEqual(['relight', 'layer_blur'])
  })
})

// ── `drawLayerContent`'s `skipTint` option (ruling 1) ────────────────────────────────────────
// The cheapest seam available: a fake `document.createElement('canvas')` (same pattern as
// foil-fill-render.unit.spec.ts), asserting on CANVAS CREATION COUNT rather than pixels —
// `drawTintedImage` always allocates its own offscreen canvas to composite the tint before
// stamping it onto the passed context; the untinted branches (`skipTint: true`, or no tint at
// all) never allocate one. happy-dom's real `getContext('2d')` returns `null` (confirmed), which
// would make both paths converge on the same fallback — so `document` is stubbed here instead of
// relying on a DOM environment.
function stubCtx(): CanvasRenderingContext2D {
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    transform: vi.fn(), setTransform: vi.fn(), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), rect: vi.fn(),
    ellipse: vi.fn(), clip: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), roundRect: vi.fn(), setLineDash: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
    putImageData: vi.fn(), measureText: vi.fn(() => ({ width: 1 })), fillText: vi.fn(), strokeText: vi.fn(),
    globalCompositeOperation: 'source-over', globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000',
    imageSmoothingEnabled: true, lineWidth: 1,
  } as unknown as CanvasRenderingContext2D
}

describe('drawLayerContent skipTint (the Finish pair\'s untinted render)', () => {
  let canvasesCreated = 0
  beforeEach(() => {
    canvasesCreated = 0
    __clearImageCacheForTest()
    __setImageForTest('photo.png', { complete: true, naturalWidth: 100, naturalHeight: 50 } as any)
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag !== 'canvas') return {}
        canvasesCreated++
        const c: any = { width: 0, height: 0 }
        c.getContext = () => stubCtx()
        return c
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); __clearImageCacheForTest() })

  const tintedLayer = (): LocalLayer =>
    createImageLayer('photo.png', 2, { tint: '#ff0000', tintOpacity: 1 }) as unknown as LocalLayer

  it('a tinted layer draws through drawTintedImage (allocates an offscreen canvas) by default', () => {
    __drawLayerContentForTest(stubCtx(), tintedLayer(), 100)
    expect(canvasesCreated).toBeGreaterThan(0)
  })

  it('skipTint:true skips drawTintedImage entirely (no offscreen canvas allocated)', () => {
    __drawLayerContentForTest(stubCtx(), tintedLayer(), 100, { skipTint: true })
    expect(canvasesCreated).toBe(0)
  })

  it('an untinted layer never allocates one either way (skipTint is a pure no-op for it)', () => {
    const plain = createImageLayer('photo.png', 2) as unknown as LocalLayer
    __drawLayerContentForTest(stubCtx(), plain, 100)
    expect(canvasesCreated).toBe(0)
    __drawLayerContentForTest(stubCtx(), plain, 100, { skipTint: true })
    expect(canvasesCreated).toBe(0)
  })
})

describe('requestRelightFinish', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const ORIGINAL = 'data:image/png;base64,AAAA'
  const GUIDE = 'data:image/png;base64,BBBB'

  it('sends { original, guide } and returns { ok: true, image }', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/api/inpaint/relight-finish')
      expect(JSON.parse(init.body)).toEqual({ original: ORIGINAL, guide: GUIDE })
      return { ok: true, status: 200, json: async () => ({ images: ['data:image/png;base64,RESULT'] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toEqual({ ok: true, image: 'data:image/png;base64,RESULT' })
  })

  it('503 { off: true } (kill switch) maps to a quiet ok:false with off:true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ off: true }) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toMatchObject({ ok: false, off: true, status: 503 })
  })

  it('400 (bad input) maps to ok:false with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'original image is required' }) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toEqual({ ok: false, status: 400, message: 'original image is required' })
  })

  it('402 maps to ok:false with the balance message, no off flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, json: async () => ({ message: 'not enough credits' }) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toEqual({ ok: false, status: 402, message: 'not enough credits' })
  })

  it('502 (provider failure) maps to ok:false with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'nano-banana-2: boom' }) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toEqual({ ok: false, status: 502, message: 'nano-banana-2: boom' })
  })

  it('429 rate limit maps to ok:false, status carried through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ message: 'slow down' }) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res).toEqual({ ok: false, status: 429, message: 'slow down' })
  })

  it('a network throw maps to ok:false, never rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res.ok).toBe(false)
    expect((res as { message: string }).message).toContain('offline')
  })

  it('a 200 with no images array is treated as a failure, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
    const res = await requestRelightFinish(ORIGINAL, GUIDE)
    expect(res.ok).toBe(false)
  })
})

describe('finishBoxSize', () => {
  it('a stretched, uncropped layer keeps its own aspect, not the photo\'s', () => {
    // tall box (1 × 2 W units), landscape source 2000×1000, whole image shown
    const s = finishBoxSize(1, 2, 1, 1, 2000, 1000, 1536)!
    expect(s.h / s.w).toBeCloseTo(2, 2)
    expect(Math.max(s.w, s.h)).toBe(1536)
  })
  it('a cover-cropped box reads at the source\'s own resolution, never upscaled', () => {
    // 16:9 box showing the middle 9/16 of a 1000×1000 source's height → 1000×562.5 source px
    const s = finishBoxSize(1, 9 / 16, 1, 9 / 16, 1000, 1000, 1536)!
    expect(s).toEqual({ w: 1000, h: 563 })
  })
  it('caps the long edge at maxEdge for a big photo', () => {
    const s = finishBoxSize(1, 1, 1, 1, 4000, 4000, 1536)!
    expect(s).toEqual({ w: 1536, h: 1536 })
  })
  it('degenerate inputs → null', () => {
    expect(finishBoxSize(0, 1, 1, 1, 100, 100, 1536)).toBeNull()
    expect(finishBoxSize(1, 1, 1, 1, 0, 100, 1536)).toBeNull()
  })
})
