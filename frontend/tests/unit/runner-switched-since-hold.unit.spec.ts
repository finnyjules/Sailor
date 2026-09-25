/**
 * Final review finding 2 (final fix F2): a node whose model depends on a
 * runner switch that changed after its leg's hold was taken is refused at its
 * turn, before anything is read or sent, and its hold is released. One shared
 * check (server/runner/switches.ts) for every switch-moved node: Rotate
 * camera, Product shot, Blend scene's Nano Banana 2 (a runner-only model) and
 * Topaz (whose F23 check it generalises). The leg records the families its
 * hold was priced with (LegRecord.families).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { TOPAZ_VIDEO_SWITCHED_OFF } from '#shared/runner/topazVideo'
import { switchedOffWords, switchedOnWords, switchedSinceHold } from '~~/server/runner/switches'
import { createFakeLedger, makeKit, ofType, until } from './__runner__/kit'

const set = (...f: RunnerFamily[]): ReadonlySet<RunnerFamily> => new Set(f)
const rotate = { class_type: 'RotateCameraNode', inputs: { image: ['11', 0], camera: '{"yaw":90,"pitch":0,"roll":0}', seed: 0 } }
const product = { class_type: 'ProductShotNode', inputs: { image: ['11', 0], scene_prompt: 'on a rock', aspect: 'Square', product_size: '60', keep_product_exact: false, seed: 5 } }
const blend = (model: string) => ({ class_type: 'BlendSceneNode', inputs: { model, image: ['11', 0], output_format: 'png', seed: 0 } })

describe('the check', () => {
  it('the words: plain, sentence case, the model\'s own name', () => {
    expect(switchedOffWords('Bria Product Shot')).toBe('Bria Product Shot in Sailor was switched off after you pressed Run, so this step wasn’t sent. Run it again.')
    expect(switchedOnWords('Qwen Image Edit 2511')).toBe('Qwen Image Edit 2511 in Sailor was switched on after you pressed Run, so this step wasn’t sent. Run it again.')
  })

  it('a class moved onto a newer model: refused when its switch differs from the hold\'s, either way', () => {
    const angles = set('ref-edits', 'qwen-2511-angles')
    expect(switchedSinceHold(rotate, angles, angles)).toBeNull()
    expect(switchedSinceHold(rotate, set('ref-edits'), angles)).toBe(switchedOffWords('Qwen Image Edit 2511'))
    // Held for the 2509 call, and the newer model switched on since: its price would be the newer one's.
    expect(switchedSinceHold(rotate, angles, set('ref-edits'))).toBe(switchedOnWords('Qwen Image Edit 2511'))
    expect(switchedSinceHold(rotate, set('ref-edits'), set('ref-edits'))).toBeNull()
    expect(switchedSinceHold(product, set('bria-product-shot'), set('bria-product-shot'))).toBeNull()
    expect(switchedSinceHold(product, NO_FAMILIES, set('bria-product-shot'))).toBe(switchedOffWords('Bria Product Shot'))
    expect(switchedSinceHold({ class_type: 'EnhanceVideoNode', inputs: {} }, NO_FAMILIES, set('topaz-video'))).toBe(TOPAZ_VIDEO_SWITCHED_OFF)
  })

  it('a leg written before the families were recorded: refused only when the class has no other way in (as Topaz was)', () => {
    expect(switchedSinceHold(product, NO_FAMILIES)).toBe(switchedOffWords('Bria Product Shot'))
    expect(switchedSinceHold(product, set('bria-product-shot'))).toBeNull()
    // Rotate camera also runs its 2509 call under ref-edits: which one was held for is unknown, so it goes.
    expect(switchedSinceHold(rotate, set('ref-edits'))).toBeNull()
    expect(switchedSinceHold(rotate, set('ref-edits', 'qwen-2511-angles'))).toBeNull()
  })

  it('a runner-only model whose switch is off now (Blend scene on Nano Banana 2); a model not behind a switch of its own is never refused', () => {
    expect(switchedSinceHold(blend('Nano Banana 2'), set('fal-edit'), set('fal-edit', 'nano-banana-2-blend'))).toBe(switchedOffWords('Nano Banana 2'))
    expect(switchedSinceHold(blend('Nano Banana 2'), set('nano-banana-2-blend'), set('nano-banana-2-blend'))).toBeNull()
    expect(switchedSinceHold(blend('Flux 2 Pro'), set('fal-edit'), set('fal-edit'))).toBeNull()
    expect(switchedSinceHold(undefined, NO_FAMILIES)).toBeNull()
  })
})

describe('the engine: switched after the hold, before the node\'s turn', () => {
  const take = (node: { class_type: string, inputs: Record<string, unknown> }): ApiPrompt => ({
    11: { class_type: 'Image', inputs: { image: 'photo.png' } },
    1: node,
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  /** Runs `node` with `before` on; the switches become `after` right after the hold is taken. */
  const run = async (node: { class_type: string, inputs: Record<string, unknown> }, before: ReadonlySet<RunnerFamily>, after: ReadonlySet<RunnerFamily>) => {
    let families = before
    const ledger = createFakeLedger(5000)
    const hold = ledger.hold
    ledger.hold = (async (...a: Parameters<typeof hold>) => { const res = await hold(...a); families = after; return res }) as typeof hold
    const k = makeKit({ hosted: true, ledger, deps: { families: () => families } })
    const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#808080' } }).png().toBuffer()
    writeFileSync(join(k.root, 'input', 'photo.png'), png)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [take(node)], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await until(() => ofType(k.seen, 'execution_error').length + ofType(k.seen, 'execution_success').length >= 1)
    await k.engine.settled(runId)
    return { k, runId }
  }
  const nothingSent = (k: ReturnType<typeof makeKit>) => {
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  }

  it('Product shot, Bria switched off: refused, not run on the retired SDXL engine', async () => {
    const { k } = await run(product, set('bria-product-shot'), NO_FAMILIES)
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([switchedOffWords('Bria Product Shot')])
    nothingSent(k)
  })

  it('Rotate camera, 2511 switched off (ref-edits still on): refused, not the 2509 call\'s different look', async () => {
    const { k } = await run(rotate, set('ref-edits', 'qwen-2511-angles'), set('ref-edits'))
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([switchedOffWords('Qwen Image Edit 2511')])
    nothingSent(k)
  })

  it('Rotate camera, 2511 switched on after a 2509 hold: refused, never charged above its hold', async () => {
    const { k } = await run(rotate, set('ref-edits'), set('ref-edits', 'qwen-2511-angles'))
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([switchedOnWords('Qwen Image Edit 2511')])
    nothingSent(k)
  })

  it('Blend scene on Nano Banana 2, its switch off: refused', async () => {
    const { k } = await run(blend('Nano Banana 2'), set('nano-banana-2-blend'), NO_FAMILIES)
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([switchedOffWords('Nano Banana 2')])
    nothingSent(k)
  })

  it('nothing changed: the node runs, and the leg records the families it was held with', async () => {
    const on = set('bria-product-shot')
    const { k, runId } = await run(product, on, on)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    expect(k.fal.reqs.size).toBe(1)
    expect((await k.store.get(runId))!.legs[0]!.families).toEqual(['bria-product-shot'])
  })
})
