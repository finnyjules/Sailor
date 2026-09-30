/**
 * Relight stage 3 ("Finish", Task 2): the pure apply/revert patch builders
 * (`app/lib/relight/finish.ts`) and the client request (`app/composables/useRelightFinish.ts`),
 * `fetch` stubbed — no real fal call. `renderRelightPair` itself needs live decoded images, a
 * built depth field and a WebGL2 context; the existing harness has no cheap way to fake all
 * three, so it is left to Task 4's browser test (per the brief).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { finishApplyPatch, finishRevertPatch, type FinishableLayer } from '~/lib/relight/finish'
import { requestRelightFinish } from '~/composables/useRelightFinish'

const relightFx = (id = 'fx:relight:0') => ({ id, type: 'relight' as const, visible: true, lights: [], keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true })
const blurFx = (id = 'fx:layer_blur:0') => ({ id, type: 'layer_blur' as const, visible: true, radius: 4 })

describe('finishApplyPatch', () => {
  it('resets crop to undefined so the result fills the box unscaled/uncropped', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', crop: { fit: 'cover', fx: 0.3, fy: 0.7 }, effects: [relightFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.crop).toBeUndefined()
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

  it('retires the legacy tornEdge/feather fields (writeStackToLayer convention)', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [relightFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.tornEdge).toBeUndefined()
    expect(patch.feather).toBeUndefined()
  })

  it('is a no-op on the stack when the given relightId is not present', () => {
    const layer: FinishableLayer = { id: 'l1', filename: 'orig.png', effects: [blurFx()] }
    const patch = finishApplyPatch(layer, 'result.png', 'fx:relight:0')
    expect(patch.effects.map(e => e.type)).toEqual(['layer_blur'])
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
