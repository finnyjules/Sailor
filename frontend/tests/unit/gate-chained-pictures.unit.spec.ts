/**
 * Task G1 (final re-review finding 1): the hosted /prompt gate sizes the
 * picture a size-priced node (Upscale, Enhance detail, FLUX.2 edit) is sent
 * when it comes out of another node, not just a loaded file or Generate an
 * image, and refuses one it can't size, or can only bound above the ~19 MP
 * cap. Loaded pictures in AVIF, GIF, TIFF, BMP and HEIC are measured too; a
 * loaded picture whose size can't be read is refused on a size-priced node
 * in hosted mode (gate and runner). Local mode is unchanged.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { LARGEST_INPUT_PIXELS, madePictureBound, nanoBananaPixels, upscaleSideFactor } from '#shared/pricing/editSettings'
import { editUsd } from '#shared/pricing/editRates'
import { measuredInput } from '~~/server/runner/metering'
import {
  ENHANCE_DETAIL_TOO_LARGE, FLUX_2_EDIT_TOO_LARGE, SEEDANCE_TOO_MANY_REFERENCES, UPSCALE_TOO_LARGE, measuredInputProblems, tooManyPicturesWords, unreadableInputWords, unsizedInputWords,
} from '~~/server/runner/requestRules'
import {
  ISOBMFF_HEAD_BYTES, MAX_HOPS, MAX_MEASURED_FILES, SEEDANCE_REFERENCE_READS, createGateReads, graphInputPixels, graphInputSizes, isobmffIspePixels, picturePixels, pictureRule, pictureSize, pyRound, tiffFirstIfdUnique,
} from '~~/server/utils/graphInputPixels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { GRAPH_FILE_READERS, extractFileRefs } from '~~/server/utils/engineFileSurface'
import { INPUTS_TOO_LARGE, MEASURED_REF_UNRENAMABLE, SNAPSHOT_NAME, __resetSnapshotSweepForTests, createGateSnapshots, rewriteMeasuredInputs, sourcePath } from '~~/server/utils/gateSnapshots'
import { seedanceReferenceSeconds } from '~~/server/utils/graphInputSeconds'
import { SETTING_UNREADABLE, STEPS_UNAVAILABLE, STEP_UNKNOWN, normalizeHostedPrompt } from '~~/server/utils/hostedPrompt'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { makeKit, ofType } from './__runner__/kit'

const MP = 1_000_000
const SINK = { class_type: 'SaveImage', inputs: {} }
const FAL_EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
type P = Record<string, { class_type: string, inputs: Record<string, unknown> }>

/** A read of named files: each name's pixels, or null (read, but not sized). */
const files = (sizes: Record<string, number | null>) => async (v: string) => (Object.prototype.hasOwnProperty.call(sizes, v) ? sizes[v]! : null)
const load = (image: string) => ({ class_type: 'LoadImage', inputs: { image } })
const flux2Edit = (from: string) => ({ class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: [from, 0], prompt: 'warmer' } })
const upscale = (from: string, inputs: Record<string, unknown>) => ({ class_type: 'UpscaleImageNode', inputs: { image: [from, 0], ...inputs } })

describe('the probe (final re-review finding 1)', () => {
  const probe: P = {
    1: load('photo.jpg'),
    2: upscale('1', { model: 'Topaz', topaz_upscale_factor: '2x' }),
    3: flux2Edit('2'),
    4: SINK,
  }

  it('16 MP photo → Topaz 2× → Flux 2 Pro edit: sized at 64 MP and refused before any hold', async () => {
    const read = files({ 'photo.jpg': 16 * MP })
    expect(await graphInputPixels(probe, read)).toEqual({ 2: 16 * MP, 3: 64 * MP })
    const held: number[] = []
    const forwarded: unknown[] = []
    const reads = createGateReads()
    const res = await meterGraphSubmit('u', { prompt: probe }, {
      priceGraph,
      measureInputSizes: p => graphInputSizes(p, read, reads),
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async (_u: string, credits: number) => { held.push(credits); return { ok: true as const, holdId: 1 } },
      getAvailable: async () => 0,
      forward: async (b: unknown) => { forwarded.push(b); return { status: 200, body: { prompt_id: 'p' } } },
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }) as { status: number, body: any }
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe(FLUX_2_EDIT_TOO_LARGE)
    expect(Object.keys(res.body.node_errors)).toEqual(['3'])
    expect(held).toEqual([])
    expect(forwarded).toHaveLength(0)
  })

  it('a picture the gate can\'t size (Recraft Crisp → Flux 2 Pro): refused before any hold', async () => {
    const p: P = { 1: load('photo.jpg'), 2: upscale('1', { model: 'Recraft Crisp' }), 3: flux2Edit('2'), 4: SINK }
    const read = files({ 'photo.jpg': MP })
    const held: number[] = []
    const reads = createGateReads()
    const res = await meterGraphSubmit('u', { prompt: p }, {
      priceGraph,
      measureInputSizes: q => graphInputSizes(q, read, reads),
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async (_u: string, credits: number) => { held.push(credits); return { ok: true as const, holdId: 1 } },
      getAvailable: async () => 0,
      forward: async () => ({ status: 200, body: { prompt_id: 'p' } }),
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }) as { status: number, body: any }
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe(unsizedInputWords('EditImageNode'))
    expect(held).toEqual([])
    // Step 3, R10.9: the live hosted /prompt handler that wired this up is gone (hosted never reaches the engine).
    const src = readFileSync(join(process.cwd(), 'server/utils/meterGraphRun.ts'), 'utf8')
    expect(src).not.toContain('measureInputPixels: prompt')
  })

  it('a smaller photo through the same chain: the edit is charged at least what fal bills for the real size', async () => {
    // 4.5 MP → Topaz 2× = 18 MP, just under the cap.
    const read = files({ 'photo.jpg': 4.5 * MP })
    const px = await graphInputPixels(probe, read)
    expect(px[3]).toBe(18 * MP)
    expect(measuredInputProblems(probe as unknown as ApiPrompt, px)).toEqual([])
    const charged = priceGraph(probe, { inputPixels: px }).breakdown.find(b => b.action === 'EditImageNode:Flux 2 Pro')!.credits
    const falBill = editUsd({ endpoint: 'fal-ai/flux-2-pro/edit', tier: null, inputPixels: 18 * MP, outputPixels: 2048 * 2048 })!
    expect(charged).toBeGreaterThanOrEqual(Math.ceil(falBill * 100))
    // Before Task G1 the gate priced this edit at the cap whatever came in;
    // the same holds now, as 18 MP is under it, so nothing is charged less.
    expect(charged).toBe(priceGraph(probe).breakdown.find(b => b.action === 'EditImageNode:Flux 2 Pro')!.credits)
  })

  it('Topaz 2× → Enhance detail on Faithful: sized at 64 MP and refused', async () => {
    const p: P = { 1: load('photo.jpg'), 2: upscale('1', { model: 'Topaz', topaz_upscale_factor: '2x' }), 3: { class_type: 'EnhanceDetailNode', inputs: { model: 'Faithful', image: ['2', 0] } } }
    const px = await graphInputPixels(p, files({ 'photo.jpg': 16 * MP }))
    expect(px[3]).toBe(64 * MP)
    expect(measuredInputProblems(p as unknown as ApiPrompt, px).map(x => x.message)).toEqual([ENHANCE_DETAIL_TOO_LARGE])
  })
})

describe('each Upscale engine, chained', () => {
  const at = async (inputs: Record<string, unknown>, photo = 1 * MP) =>
    graphInputSizes({ 1: load('p.jpg'), 2: upscale('1', inputs), 3: flux2Edit('2') }, files({ 'p.jpg': photo }))

  it('Topaz: None, 2x, 4x, 6x, the default (2x), and a linked factor (its largest, 6x)', async () => {
    for (const [f, side] of [['None', 1], ['2x', 2], ['4x', 4], ['6x', 6], [undefined, 2], [['9', 0], 6]] as const) {
      const s = await at({ model: 'Topaz', ...(f === undefined ? {} : { topaz_upscale_factor: f }) })
      expect(s.pixels[3], String(f)).toBe(MP * side * side)
    }
  })

  it('Clarity, Crystal and Real-ESRGAN: scale_factor per side (default 2, linked 10)', async () => {
    for (const model of ['Clarity', 'Crystal', 'Real-ESRGAN']) {
      expect((await at({ model, scale_factor: 3 })).pixels[3], model).toBe(9 * MP)
      expect((await at({ model })).pixels[3], model).toBe(4 * MP)
      const linked = await at({ model, scale_factor: ['9', 0] })
      expect(linked.pixels[3], model).toBe(100 * MP)
      expect(measuredInputProblems({ 1: load('p.jpg'), 2: upscale('1', { model }), 3: flux2Edit('2') } as unknown as ApiPrompt, linked.pixels).map(x => x.nodeId)).toEqual(['3'])
    }
  })

  it('Recraft Crisp (its output size is not documented) and an engine the node doesn\'t offer: refused downstream', async () => {
    expect(upscaleSideFactor('Recraft Crisp', {})).toBeNull()
    for (const model of ['Recraft Crisp', 'Magic']) {
      const s = await at({ model })
      expect(s.pixels, model).toEqual({ 2: MP })
      expect(s.problems, model).toEqual([{ nodeId: '3', classType: 'EditImageNode', input: 'input_image', message: unsizedInputWords('EditImageNode') }])
    }
  })

  it('Upscale into Upscale: the second is sized on the first\'s output', async () => {
    const p: P = { 1: load('p.jpg'), 2: upscale('1', { model: 'Real-ESRGAN', scale_factor: 2 }), 3: upscale('2', { model: 'Crystal', scale_factor: 1 }) }
    const s = await graphInputSizes(p, files({ 'p.jpg': 16 * MP }))
    expect(s.pixels).toEqual({ 2: 16 * MP, 3: 64 * MP })
    expect(measuredInputProblems(p as unknown as ApiPrompt, s.pixels).map(x => x.message)).toEqual([UPSCALE_TOO_LARGE])
  })
})

describe('the other picture-making nodes', () => {
  const into = async (source: { class_type: string, inputs: Record<string, unknown> }, sizes: Record<string, number | null> = { 'p.jpg': 30 * MP }) =>
    graphInputSizes({ 1: load('p.jpg'), 2: source, 3: flux2Edit('2') }, files(sizes))

  it('Enhance detail, every engine: in place', async () => {
    for (const model of ['Creative', 'Faithful', 'Diffusion Refine']) {
      const s = await into({ class_type: 'EnhanceDetailNode', inputs: { model, image: ['1', 0] } }, { 'p.jpg': 3 * MP })
      expect(s.pixels[3], model).toBe(3 * MP)
    }
    expect((await into({ class_type: 'EnhanceDetailNode', inputs: { model: 'Other', image: ['1', 0] } })).problems.map(x => x.nodeId)).toEqual(['3'])
  })

  it('the Frame: its width × height; else its first connected layer; baked for motion or a linked size: refused', async () => {
    expect((await into({ class_type: 'Compositor', inputs: { layer1: ['1', 0], width: 1080, height: 1920 } })).pixels[3]).toBe(1080 * 1920)
    const big = await into({ class_type: 'Compositor', inputs: { width: 8192, height: 8192 } })
    expect(big.pixels[3]).toBe(8192 * 8192)
    expect(measuredInputProblems({ 2: { class_type: 'Compositor', inputs: {} }, 3: flux2Edit('2') } as unknown as ApiPrompt, big.pixels).map(x => x.message)).toEqual([FLUX_2_EDIT_TOO_LARGE])
    // Slot 1 empty: the first connected slot sets the canvas.
    expect((await into({ class_type: 'Compositor', inputs: { layer3: ['1', 0], width: 0, height: 0 } })).pixels[3]).toBe(30 * MP)
    expect((await into({ class_type: 'Compositor', inputs: {} })).pixels[3]).toBe(256)
    for (const inputs of [
      { layer1: ['1', 0], motion_params: JSON.stringify({ rendered: ['f0.png'], fps: 30 }) },
      { layer1: ['1', 0], width: ['9', 0], height: 1080 },
    ]) expect((await into({ class_type: 'Compositor', inputs })).problems.map(x => x.message)).toEqual([unsizedInputWords('EditImageNode')])
    // A motion setting that bakes nothing leaves the static composite.
    expect((await into({ class_type: 'Compositor', inputs: { layer1: ['1', 0], motion_params: '{"rendered": []}' } })).pixels[3]).toBe(30 * MP)
  })

  it('Resize, Scale by and Crop, rounded per side as Python rounds (R5)', async () => {
    const dims = (width: number, height: number) => async (v: string) => (v === 'p.jpg' ? { pixels: width * height, width, height } : null)
    const via = async (source: { class_type: string, inputs: Record<string, unknown> }, w: number, h: number) =>
      graphInputSizes({ 1: load('p.jpg'), 2: source, 3: flux2Edit('2') }, dims(w, h))
    expect((await via({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 2000, height: 1000 } }, 6000, 5000)).pixels[3]).toBe(2 * MP)
    // One side 0 keeps the aspect: round(6000 × 1000 / 5000) = 1200.
    expect((await via({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } }, 6000, 5000)).pixels[3]).toBe(1200 * 1000)
    expect((await via({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 0 } }, 6000, 5000)).pixels[3]).toBe(30 * MP)
    // Without the input's sides, one side 0 can't be sized.
    expect((await into({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 2000, height: 0 } })).problems).toHaveLength(1)
    // 3 × 3 at 0.5: round(1.5) = 2 per side, so 4 pixels (not 3 × 3 × 0.25 = 2.25).
    expect((await via({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: 0.5 } }, 3, 3)).pixels[3]).toBe(4)
    // round(2.5) = 2 (to even), round(3.5) = 4.
    expect(pyRound(2.5)).toBe(2)
    expect(pyRound(3.5)).toBe(4)
    expect((await via({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: 0.5 } }, 5, 7)).pixels[3]).toBe(2 * 4)
    // Without the sides, a fractional factor is a bound no shape can exceed.
    const loose = await into({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: 0.5 } }, { 'p.jpg': 9 })
    expect(loose.pixels[3]).toBeGreaterThanOrEqual(pyRound(9 * 0.5) * pyRound(1 * 0.5))
    expect(loose.pixels[3]).toBeGreaterThanOrEqual(4)
    expect((await into({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: ['9', 0] } })).pixels[3]).toBe(30 * MP * 64)
    // Crop: the slice from (min(x, W−1), min(y, H−1)).
    expect((await via({ class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1000, height: 1000, x: 0, y: 0 } }, 6000, 5000)).pixels[3]).toBe(MP)
    expect((await via({ class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1000, height: 1000, x: 5500, y: 9999 } }, 6000, 5000)).pixels[3]).toBe(500 * 1)
    // A fractional Upscale factor is rounded up per side (never below the service's).
    const clarity = await via({ class_type: 'UpscaleImageNode', inputs: { model: 'Clarity', scale_factor: 1.5, image: ['1', 0] } }, 3, 3)
    expect(clarity.pixels[3]).toBe(5 * 5)
  })

  it('Image cards and Remove background hand the picture on at its size', async () => {
    expect((await into({ class_type: 'Image', inputs: { image: '', images: ['1', 0] } })).pixels[3]).toBe(30 * MP)
    expect((await into({ class_type: 'RemoveBackgroundNode', inputs: { image: ['1', 0] } })).pixels[3]).toBe(30 * MP)
  })

  it('a Nano Banana action hands its picture on when there is nothing to change; otherwise a 1K picture', async () => {
    const through = await into({ class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: '  ' } })
    expect(through.pixels[3]).toBe(30 * MP)
    const edited = await into({ class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: 'the car' } })
    expect(edited.pixels[3]).toBe(nanoBananaPixels('1K', undefined))
    expect(edited.problems).toEqual([])
  })

  it('Blend scene keeping protected layers is resized onto its input; otherwise its model\'s largest', async () => {
    expect((await into({ class_type: 'BlendSceneNode', inputs: { model: 'Flux Kontext Pro', image: ['1', 0], keep_subject: ['1', 1] } })).pixels[3]).toBe(30 * MP)
    expect((await into({ class_type: 'BlendSceneNode', inputs: { model: 'Flux Kontext Pro', image: ['1', 0] } })).pixels[3]).toBe(LARGEST_INPUT_PIXELS)
  })

  it('generators and edits: priced on their stated largest, never above the cap, never refused', async () => {
    expect((await into({ class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }, { 'p.jpg': 4 * MP })).pixels[3]).toBe(2048 * 2048)
    expect((await into({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0], resolution: '4K' } })).pixels[3]).toBe(LARGEST_INPUT_PIXELS)
    expect((await into({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0], resolution: '1K' } })).pixels[3]).toBe(nanoBananaPixels('1K', undefined))
    expect((await into({ class_type: 'DevelopImageNode', inputs: { input_image: ['1', 0], resolution: '2K' } })).pixels[3]).toBe(nanoBananaPixels('2K', undefined))
    expect((await into({ class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', aspect_ratio: '1:1', model_options: '{"resolution":"1K"}' } })).problems).toEqual([])
    for (const ct of ['GenerateImageNode', 'EditImageNode', 'DevelopImageNode', 'BlendSceneNode', 'GenerateFromReferencesNode', 'RestyleWithLoRANode', 'RelightNode', 'LensReframe', 'TextEditNode']) {
      const b = madePictureBound(ct, {})
      expect(b, ct).not.toBeNull()
      expect(b!, ct).toBeLessThanOrEqual(LARGEST_INPUT_PIXELS)
    }
  })

  it('a node whose picture size can\'t be known before it runs: refused on a size-priced node, in plain words', async () => {
    for (const source of [
      { class_type: 'OutpaintImageNode', inputs: { image: ['1', 0] } },
      { class_type: 'FixFacesNode', inputs: { image: ['1', 0] } },
      { class_type: 'RestyleFromImageNode', inputs: { model: 'Style Transfer · IP-Adapter', image: ['1', 0] } },
      { class_type: 'RestyleFromImageNode', inputs: { model: ['9', 0], image: ['1', 0] } },
    ]) {
      const s = await into(source)
      expect(s.pixels[3], source.class_type).toBeUndefined()
      expect(s.problems, source.class_type).toEqual([{ nodeId: '3', classType: 'EditImageNode', input: 'input_image', message: unsizedInputWords('EditImageNode') }])
    }
    expect(unsizedInputWords('EditImageNode')).toBe('Sailor can\'t tell how big the picture going into Flux 2 Pro will be, and Flux 2 Pro is charged by its size. Run the steps before it first, then use a picture of up to about 19 megapixels.')
    expect(unsizedInputWords('UpscaleImageNode')).toContain('going into Upscale an image will be')
    expect(unsizedInputWords('EnhanceDetailNode')).toContain('going into Enhance detail will be')
  })

  it('a node not priced by size is never refused for what feeds it', async () => {
    const s = await graphInputSizes({ 1: { class_type: 'OutpaintImageNode', inputs: {} }, 2: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0] } } }, files({}))
    expect(s).toEqual({ pixels: {}, problems: [] })
  })

  it('a loop, and a chain longer than MAX_HOPS: refused, never followed forever', async () => {
    const loop: P = { 1: { class_type: 'Image', inputs: { image: '', images: ['2', 0] } }, 2: { class_type: 'Image', inputs: { image: '', images: ['1', 0] } }, 3: flux2Edit('2') }
    expect((await graphInputSizes(loop, files({}))).problems.map(x => x.nodeId)).toEqual(['3'])
    const chain: P = { 0: load('p.jpg') }
    for (let i = 1; i <= MAX_HOPS; i++) chain[i] = { class_type: 'Image', inputs: { image: '', images: [String(i - 1), 0] } }
    chain.edit = flux2Edit(String(MAX_HOPS))
    expect((await graphInputSizes(chain, files({ 'p.jpg': MP }))).problems.map(x => x.nodeId)).toEqual(['edit'])
    delete chain[MAX_HOPS]
    chain.edit = flux2Edit(String(MAX_HOPS - 1))
    expect((await graphInputSizes(chain, files({ 'p.jpg': MP }))).pixels).toEqual({ edit: MP })
  })
})

describe('loaded pictures the gate can\'t size', () => {
  it('read but not sized: refused on a size-priced node, in plain words', async () => {
    const s = await graphInputSizes({ 1: load('x.svg'), 2: flux2Edit('1') }, files({ 'x.svg': null }))
    expect(s).toEqual({ pixels: {}, problems: [{ nodeId: '2', classType: 'EditImageNode', input: 'input_image', message: unreadableInputWords('EditImageNode') }] })
    expect(unreadableInputWords('EditImageNode')).toBe('Sailor can\'t read the size of this picture, and Flux 2 Pro is charged by its size. Save it as a PNG, JPEG or WebP and try again.')
  })

  it('past the read budget: refused (R6), not priced at the cap', async () => {
    const p: P = {}
    for (let i = 0; i <= MAX_MEASURED_FILES; i++) {
      p[`l${i}`] = load(`f${i}.jpg`)
      p[`e${i}`] = flux2Edit(`l${i}`)
    }
    const s = await graphInputSizes(p, async () => MP)
    expect(Object.keys(s.pixels)).toHaveLength(MAX_MEASURED_FILES)
    expect(s.problems).toEqual([{ nodeId: `e${MAX_MEASURED_FILES}`, classType: 'EditImageNode', input: 'input_image', message: tooManyPicturesWords('EditImageNode') }])
    expect(tooManyPicturesWords('EditImageNode')).toBe('This run has more pictures than Sailor can check at once, and Flux 2 Pro is charged by its picture\'s size. Run fewer pictures at a time.')
  })

  it('a read that throws: can\'t be sized, refused (R6)', async () => {
    const s = await graphInputSizes({ 1: load('a.jpg'), 2: flux2Edit('1') }, async () => { throw new Error('disk') })
    expect(s.problems.map(x => x.message)).toEqual([unreadableInputWords('EditImageNode')])
  })
})

describe('header readers', () => {
  const box = (type: string, payload: Uint8Array, full = false) => {
    const body = full ? new Uint8Array([0, 0, 0, 0, ...payload]) : payload
    const out = new Uint8Array(8 + body.length)
    new DataView(out.buffer).setUint32(0, out.length)
    out.set(Buffer.from(type, 'ascii'), 4)
    out.set(body, 8)
    return out
  }
  const ispe = (w: number, h: number) => {
    const p = new Uint8Array(8)
    new DataView(p.buffer).setUint32(0, w)
    new DataView(p.buffer).setUint32(4, h)
    return box('ispe', p, true)
  }
  const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
  const u16 = (n: number) => [n >> 8 & 255, n & 255]
  const u32 = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]
  /** pitm (version 0): the primary item's id. */
  const pitm = (id: number) => box('pitm', new Uint8Array(u16(id)), true)
  /** ipma (version 0, 1-byte indices): item id → its 1-based ipco property indices. */
  const ipma = (entries: [number, number[]][]) =>
    box('ipma', new Uint8Array([...u32(entries.length), ...entries.flatMap(([id, ix]) => [...u16(id), ix.length, ...ix.map(i => i & 0x7F)])]), true)
  /** ftyp + meta { hdlr, pitm, iprp { ipco { props }, ipma } } (+ trailing bytes). */
  const heif = (brand: string, primary: number, props: Uint8Array[], assoc: [number, number[]][], tail = new Uint8Array(0)) => cat(
    box('ftyp', new Uint8Array([...Buffer.from(brand), 0, 0, 0, 0, ...Buffer.from('mif1'), ...Buffer.from(brand)])),
    box('meta', cat(box('hdlr', new Uint8Array(20), true), pitm(primary), box('iprp', cat(box('ipco', cat(...props)), ipma(assoc)))), true),
    tail,
  )
  const free = (n: number) => box('free', new Uint8Array(n))

  it('a tiled HEIC: the primary item\'s size (the grid), never a tile\'s or a thumbnail\'s (R1)', async () => {
    // Items: 1 = the grid (primary), 2… = tiles, 9 = thumbnail. The tile's ispe comes first.
    const heic = heif('heic', 1, [ispe(512, 512), ispe(320, 240), ispe(4032, 3024)], [[2, [1]], [9, [2]], [1, [3]]])
    expect(isobmffIspePixels(heic)).toBe(4032 * 3024)
    expect(await picturePixels(heic)).toBe(4032 * 3024)
    // A primary item with no size of its own: can't be sized.
    expect(isobmffIspePixels(heif('heic', 1, [ispe(4032, 3024)], [[2, [1]]]))).toBeNull()
    // No pitm: can't be sized.
    expect(isobmffIspePixels(cat(box('ftyp', new Uint8Array([...Buffer.from('avif'), 0, 0, 0, 0])), box('meta', box('iprp', cat(box('ipco', ispe(10, 10)), ipma([[1, [1]]]))), true)))).toBeNull()
  })

  it('the review\'s decoy AVIF: a 10 × 10 decoy, 70 KB of padding, the real 3000 × 2000 after it (R1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g1-decoy-'))
    // ipco: [1] decoy ispe (no item), [2] a 70 KB free box, [3] the real ispe; the primary item → [3].
    const decoy = heif('avif', 1, [ispe(10, 10), free(70 * 1024), ispe(3000, 2000)], [[1, [3]]], new Uint8Array(1000))
    writeFileSync(join(dir, 'decoy.avif'), decoy)
    // The gate (a header read from disk) and the runner (the bytes it holds) both read 6 MP.
    expect(await picturePixels(join(dir, 'decoy.avif'))).toBe(3000 * 2000)
    expect(await picturePixels(decoy)).toBe(3000 * 2000)
    // The same with the padding past the gate's header read: the gate can't size it (refused);
    // the runner, holding the whole file, still reads 6 MP.
    const far = heif('avif', 1, [ispe(10, 10), free(ISOBMFF_HEAD_BYTES + 1024), ispe(3000, 2000)], [[1, [3]]])
    writeFileSync(join(dir, 'far.avif'), far)
    expect(await picturePixels(join(dir, 'far.avif'))).toBeNull()
    expect(await picturePixels(far)).toBe(3000 * 2000)
    const f: OutputFile = { filename: 'far.avif', subfolder: '', type: 'output' }
    const node = { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }
    expect(await measuredInput(node, () => [f], async () => far, FAL_EDIT)).toEqual({ pixels: 3000 * 2000, unreadable: false })
  })

  it('a meta box cut short by the read: can\'t be sized, never a partial answer (R1)', () => {
    const whole = heif('avif', 1, [ispe(10, 10), free(4096), ispe(3000, 2000)], [[1, [3]]])
    expect(isobmffIspePixels(whole.subarray(0, 200))).toBeNull()
    // Even when what was read looks complete (ipma first, the primary's size first in ipco),
    // a meta / iprp / ipco running past the bytes read is refused: the rest is unseen.
    const early = cat(
      box('ftyp', new Uint8Array([...Buffer.from('avif'), 0, 0, 0, 0])),
      box('meta', cat(pitm(1), box('iprp', cat(ipma([[1, [1]]]), box('ipco', cat(ispe(3000, 2000), free(4096)))))), true),
    )
    expect(isobmffIspePixels(early)).toBe(3000 * 2000)
    expect(isobmffIspePixels(early.subarray(0, early.length - 100))).toBeNull()
  })

  it('AVIF, GIF, TIFF and BMP made by sharp are measured from their bytes', async () => {
    const make = (fmt: 'avif' | 'gif' | 'tiff') => sharp({ create: { width: 60, height: 40, channels: 3, background: '#888' } }).toFormat(fmt).toBuffer()
    for (const fmt of ['avif', 'gif', 'tiff'] as const) expect(await picturePixels(new Uint8Array(await make(fmt))), fmt).toBe(2400)
  })

  it('a broken PNG (the signature, then nothing): not sized', async () => {
    expect(await picturePixels(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]))).toBeNull()
  })
})

describe('the rule table', () => {
  it('names where each picture comes from', () => {
    expect(pictureRule('LoadImage', { image: 'a.png' })).toEqual({ file: 'a.png' })
    expect(pictureRule('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '4x', image: ['1', 0] })).toEqual({ scaled: ['1', 0], side: 4, round: 'up' })
    expect(pictureRule('SomethingElse', {})).toEqual({ unsized: true })
  })
})

describe('the runner (hosted refuses a picture whose size it can\'t read; local sends it)', () => {
  const broken = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
  const f: OutputFile = { filename: 'a.png', subfolder: '', type: 'output' }
  const node = { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }

  it('measuredInput: read but not sized is `unreadable`; a failed read or no file is not', async () => {
    expect(await measuredInput(node, () => [f], async () => broken, FAL_EDIT)).toEqual({ unreadable: true })
    expect(await measuredInput(node, () => [f], async () => { throw new Error('gone') }, FAL_EDIT)).toEqual({ unreadable: false })
    expect(await measuredInput(node, () => [], async () => broken, FAL_EDIT)).toEqual({ unreadable: false })
    const png = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#888' } }).png().toBuffer())
    expect(await measuredInput(node, () => [f], async () => png, FAL_EDIT)).toEqual({ pixels: 100, unreadable: false })
    // Not size-priced: nothing read.
    expect(await measuredInput({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0] } }, () => [f], async () => broken, FAL_EDIT)).toEqual({ unreadable: false })
  })

  const take = (): ApiPrompt => ({
    11: { class_type: 'Image', inputs: { image: 'photo.png' } },
    1: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['11', 0], prompt: 'warmer', output_format: 'png', seed: 0 } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const run = async (hosted: boolean) => {
    const k = makeKit({ hosted, deps: { families: () => FAL_EDIT } })
    writeFileSync(join(k.root, 'input', 'photo.png'), broken)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [take()], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    return k
  }

  it('hosted: fails in plain words, nothing uploaded or sent, the hold released', async () => {
    const k = await run(true)
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([unreadableInputWords('EditImageNode')])
    expect(k.fal.reqs.size + k.replicate.reqs.size).toBe(0)
    expect(k.upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('local: unchanged, the picture is sent', async () => {
    const k = await run(false)
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).not.toContain(unreadableInputWords('EditImageNode'))
    expect(k.fal.reqs.size).toBe(1)
  })
})

describe('switched off: the ComfyUI path runs no runner family', () => {
  it('Rotate camera is not size-priced at the gate, so nothing feeding it is refused', async () => {
    const s = await graphInputSizes({ 1: { class_type: 'OutpaintImageNode', inputs: {} }, 2: { class_type: 'RotateCameraNode', inputs: { image: ['1', 0] } } }, files({}))
    expect(s).toEqual({ pixels: {}, problems: [] })
    expect(NO_FAMILIES.size).toBe(0)
  })
})

// ── G1 fix round 1 ────────────────────────────────────────────────────────

/** The committed node catalog (what the gate falls back to), for the normalisation. */
const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>
const normalised = (p: P) => {
  const n = normalizeHostedPrompt(p, CATALOG)
  if ('problems' in n) throw new Error(`refused: ${JSON.stringify(n.problems)}`)
  return n.prompt as P
}

describe('the hosted normalisation: what is priced is what ComfyUI runs (R2, R4)', () => {
  const frame = (inputs: Record<string, unknown>): P => ({ 1: { class_type: 'Compositor', inputs }, 2: flux2Edit('1'), 3: SINK })

  it('the review\'s Frame widths — text, a decimal, wrapped — are read as ComfyUI\'s int() reads them', async () => {
    // '4_096': Python's int() reads underscores (shared/runner/pyText.ts, fix round 2).
    for (const width of ['4096', 4096.5, { __value__: 4096 }, { __value__: '4096' }, ' 4096 ', '4_096']) {
      const p = normalised(frame({ width, height: 4096 }))
      expect(p[1]!.inputs.width, JSON.stringify(width)).toBe(4096)
      const s = await graphInputSizes(p, files({}))
      expect(s.pixels[2], JSON.stringify(width)).toBe(4096 * 4096)
    }
    // 8192 as text: 67 MP, refused as too large (it was priced as a 16 × 16 blank before).
    const big = normalised(frame({ width: '8192', height: '8192' }))
    const s = await graphInputSizes(big, files({}))
    expect(measuredInputProblems(big as unknown as ApiPrompt, s.pixels).map(x => x.message)).toEqual([FLUX_2_EDIT_TOO_LARGE])
  })

  it('a value int() or float() reads in a way this can\'t match exactly: refused, in plain words', () => {
    for (const width of ['4__096', 'inf', '4096.5', null, [1], { a: 1 }, '٤٠٩٦']) {
      if (Array.isArray(width)) continue // a list is a link: left to ComfyUI
      const n = normalizeHostedPrompt(frame({ width, height: 4096 }), CATALOG)
      expect('problems' in n && n.problems.map(x => [x.nodeId, x.input, x.message]), JSON.stringify(width)).toEqual([['1', 'width', SETTING_UNREADABLE]])
    }
    expect(SETTING_UNREADABLE).toBe('One of this step\'s settings has a value Sailor can\'t read. Set it again, then run once more.')
  })

  it('a wrapped Nano Banana 2 resolution "4K" is unwrapped, and priced as 4K', async () => {
    const p = normalised({
      1: load('p.jpg'),
      2: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0], resolution: { __value__: '4K' } } },
      3: flux2Edit('2'),
    })
    expect(p[2]!.inputs.resolution).toBe('4K')
    expect((await graphInputSizes(p, files({ 'p.jpg': MP }))).pixels[3]).toBe(LARGEST_INPUT_PIXELS)
  })

  it('a wrapped link into a size-priced node becomes a link, and is sized and refused like any other', async () => {
    const p = normalised({ 1: load('p.jpg'), 2: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: { __value__: ['1', 0] } } } })
    expect(p[2]!.inputs.input_image).toEqual(['1', 0])
    const s = await graphInputSizes(p, files({ 'p.jpg': 48 * MP }))
    expect(s.pixels).toEqual({ 2: 48 * MP })
    expect(measuredInputProblems(p as unknown as ApiPrompt, s.pixels).map(x => x.message)).toEqual([FLUX_2_EDIT_TOO_LARGE])
  })

  it('text for a text setting stays as it is; anything else there is refused (str() can\'t be matched)', () => {
    expect(normalised({ 1: { class_type: 'RemoveObjectNode', inputs: { image: ['9', 0], target: { __value__: 'the car' } } } })[1]!.inputs.target).toBe('the car')
    const n = normalizeHostedPrompt({ 1: { class_type: 'RemoveObjectNode', inputs: { image: ['9', 0], target: 5 } } }, CATALOG)
    expect('problems' in n && n.problems[0]!.message).toBe(SETTING_UNREADABLE)
  })

  it('a step the catalog doesn\'t know, a wrapper on an input the step doesn\'t declare, or no catalog: refused', () => {
    const unknown = normalizeHostedPrompt({ 1: { class_type: 'NotANode', inputs: {} } }, CATALOG)
    expect('problems' in unknown && unknown.problems[0]!.message).toBe(STEP_UNKNOWN)
    const stray = normalizeHostedPrompt({ 1: { class_type: 'Compositor', inputs: { size: { __value__: 9 } } } }, CATALOG)
    expect('problems' in stray && stray.problems[0]!.input).toBe('size')
    const none = normalizeHostedPrompt({ 1: load('p.jpg') }, null)
    expect('problems' in none && none.problems[0]!.message).toBe(STEPS_UNAVAILABLE)
  })

  it('a prompt already in ComfyUI\'s form is unchanged (and the caller\'s object is never touched)', () => {
    const p: P = { 1: load('p.jpg'), 2: { class_type: 'UpscaleImageNode', inputs: { model: 'Topaz', image: ['1', 0], scale_factor: 2, seed: 3, face_enhance: false, prompt: 'x' } }, 3: SINK }
    const before = structuredClone(p)
    expect(normalised(p)).toEqual(before)
    const w: P = frame({ width: '4096', height: 4096 })
    normalised(w)
    expect(w[1]!.inputs.width).toBe('4096')
  })

  it('the gate forwards the normalised prompt, and prices it', async () => {
    const forwarded: any[] = []
    const held: number[] = []
    const read = files({ 'p.jpg': MP })
    const reads = createGateReads()
    const prompt: P = { 1: load('p.jpg'), 2: { class_type: 'Compositor', inputs: { layer1: ['1', 0], width: '4096', height: { __value__: 4096 } } }, 3: flux2Edit('2'), 4: SINK }
    const res = await meterGraphSubmit('u', { prompt, client_id: 'c' }, {
      priceGraph,
      normalizePrompt: p => normalizeHostedPrompt(p, CATALOG),
      measureInputSizes: p => graphInputSizes(p, read, reads),
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async (_u: string, credits: number) => { held.push(credits); return { ok: true as const, holdId: 1 } },
      getAvailable: async () => 0,
      forward: async (b: unknown) => { forwarded.push(b); return { status: 200, body: { prompt_id: 'p' } } },
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    })
    expect(res.status).toBe(200)
    expect(forwarded[0].client_id).toBe('c')
    expect(forwarded[0].prompt[2].inputs.width).toBe(4096)
    expect(forwarded[0].prompt[2].inputs.height).toBe(4096)
    const expected = priceGraph(forwarded[0].prompt, { inputPixels: { 3: 4096 * 4096 } }).credits
    expect(held).toEqual([expected])
    expect(expected).toBeGreaterThan(priceGraph(prompt, { inputPixels: { 3: 256 } }).credits)
  })

  it('a refused normalisation: 400 in ComfyUI\'s shape, nothing held or sent', async () => {
    const forwarded: unknown[] = []
    const res = await meterGraphSubmit('u', { prompt: frame({ width: '4096.5', height: 4096 }) }, {
      priceGraph,
      normalizePrompt: p => normalizeHostedPrompt(p, CATALOG),
      spendGuard: async () => {}, validateFileRefs: async () => { throw new Error('not reached') }, moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => { throw new Error('not reached') },
      getAvailable: async () => 0,
      forward: async (b: unknown) => { forwarded.push(b); return { status: 200, body: { prompt_id: 'p' } } },
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }) as { status: number, body: any }
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe(SETTING_UNREADABLE)
    expect(forwarded).toHaveLength(0)
  })
})

describe('a Nano Banana action whose deciding text is linked (R3)', () => {
  const text = { 5: { class_type: 'PrimitiveString', inputs: { value: '' } } }
  for (const [ct, inputs, from] of [
    ['RemoveObjectNode', { image: ['1', 0], target: ['5', 0] }, 'image'],
    ['TextEditNode', { image: ['1', 0], find: ['5', 0], replace: 'x' }, 'image'],
    ['RecolorObjectNode', { image: ['1', 0], target: 'the car', color: ['5', 0] }, 'image'],
    ['SwapBackgroundNode', { product: ['1', 0], scene_prompt: ['5', 0] }, 'product'],
  ] as const) {
    it(`${ct}: the larger of the picture handed on (${from}) and a 1K picture`, async () => {
      const p = (px: number) => graphInputSizes({ ...text, 1: load('p.jpg'), 2: { class_type: ct, inputs }, 3: flux2Edit('2') }, files({ 'p.jpg': px }))
      // The review's case: 60 MP handed on — sized at 60 MP, above the cap, refused (was 1.18 MP).
      const big = await p(60 * MP)
      expect(big.pixels[3]).toBeUndefined()
      expect(big.problems.map(x => x.message)).toEqual([unsizedInputWords('EditImageNode')])
      // A small picture: priced on the 1K picture it may make.
      expect((await p(0.25 * MP)).pixels[3]).toBe(nanoBananaPixels('1K', undefined))
      // A 4 MP picture: priced on the 4 MP it may hand on.
      expect((await p(4 * MP)).pixels[3]).toBe(4 * MP)
    })
  }

  it('the wrapped empty text of the review, once normalised, is a certain hand-on at full size', async () => {
    const p = normalised({ 1: load('p.jpg'), 2: { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: { __value__: '' } } }, 3: flux2Edit('2') })
    const s = await graphInputSizes(p, files({ 'p.jpg': 60 * MP }))
    expect(s.pixels[3]).toBe(60 * MP)
    expect(measuredInputProblems(p as unknown as ApiPrompt, s.pixels).map(x => x.message)).toEqual([FLUX_2_EDIT_TOO_LARGE])
  })

  it('a reference wired to Swap background decides it: a call, so the 1K bound alone', async () => {
    const s = await graphInputSizes({ ...text, 1: load('p.jpg'), 2: { class_type: 'SwapBackgroundNode', inputs: { product: ['1', 0], background_reference: ['1', 0], scene_prompt: ['5', 0] } }, 3: flux2Edit('2') }, files({ 'p.jpg': 60 * MP }))
    expect(s.pixels[3]).toBe(nanoBananaPixels('1K', undefined))
  })
})

// ── G1 fix round 2 ────────────────────────────────────────────────────────

describe('a wrapper inside a wrapper: refused, never unwrapped twice (fix round 2, 1)', () => {
  it('the re-review\'s wrapped link and wrapped resolution', () => {
    for (const p of [
      { 1: load('p.jpg'), 2: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: { __value__: { __value__: ['1', 0] } } } } },
      { 1: load('p.jpg'), 2: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0], resolution: { __value__: { __value__: '4K' } } } } },
      // Deeper, and inside a list, and on an input the class doesn't declare.
      { 2: { class_type: 'EditImageNode', inputs: { model: { __value__: { a: [{ __value__: 'Flux 2 Pro' }] } } } } },
      { 2: { class_type: 'EditImageNode', inputs: { input_image: ['1', { __value__: 0 }] } } },
      { 2: { class_type: 'EditImageNode', inputs: { extra: { deep: { __value__: 1 } } } } },
    ] as P[]) {
      const n = normalizeHostedPrompt(p, CATALOG)
      expect('problems' in n && n.problems.map(x => [x.nodeId, x.message]), JSON.stringify(p)).toEqual([['2', SETTING_UNREADABLE]])
    }
  })

  it('Load3D: a picture dict wrapped once is unwrapped (the file check then sees it); wrapped twice, refused', () => {
    const once = normalised({ 1: { class_type: 'Load3D', inputs: { model_file: 'a.glb', image: { __value__: { image: 'someone-else.png' } }, width: 1024, height: 1024 } } })
    expect(once[1]!.inputs.image).toEqual({ image: 'someone-else.png' })
    // The file check's own reader names the file on the normalised value (it named none on the wrapper).
    const spec = GRAPH_FILE_READERS.Load3D!.find(x => x.input === 'image')!
    expect(extractFileRefs(spec, once[1]!.inputs.image)).toEqual(['someone-else.png'])
    expect(extractFileRefs(spec, { __value__: { __value__: { image: 'someone-else.png' } } })).toEqual([])
    const twice = normalizeHostedPrompt({ 1: { class_type: 'Load3D', inputs: { model_file: 'a.glb', image: { __value__: { __value__: { image: 'someone-else.png' } } }, width: 1024, height: 1024 } } }, CATALOG)
    expect('problems' in twice && twice.problems.map(x => [x.input, x.message])).toEqual([['image', SETTING_UNREADABLE]])
  })

  it('every hosted check reads the normalised prompt: the file check, the sizing, the price, and what is sent', async () => {
    const seen: Record<string, any> = {}
    const read = files({ 'p.jpg': MP })
    const prompt: P = { 1: load('p.jpg'), 2: { class_type: 'Load3D', inputs: { model_file: 'a.glb', image: { __value__: { image: 'x.png' } }, width: 1024, height: 1024 } }, 3: flux2Edit('1'), 4: SINK }
    const res = await meterGraphSubmit('u', { prompt }, {
      priceGraph: (p, o) => { seen.price = p; return priceGraph(p, o) },
      normalizePrompt: p => normalizeHostedPrompt(p, CATALOG),
      measureInputSizes: p => { seen.sizes = p; return graphInputSizes(p, read) },
      spendGuard: async () => {}, validateFileRefs: async (p) => { seen.files = p }, moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => ({ ok: true as const, holdId: 1 }),
      getAvailable: async () => 0,
      forward: async (b: any) => { seen.sent = b.prompt; return { status: 200, body: { prompt_id: 'p' } } },
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    })
    expect(res.status).toBe(200)
    for (const k of ['files', 'sizes', 'price', 'sent']) expect(seen[k]![2].inputs.image, k).toEqual({ image: 'x.png' })
    // One object throughout: what is checked is what is sent.
    expect(seen.files).toBe(seen.sent)
    expect(prompt[2]!.inputs.image).toEqual({ __value__: { image: 'x.png' } })
  })
})

describe('AVIF / HEIF sequences: refused, since the engine decodes the track (fix round 2, 2)', () => {
  const box = (type: string, payload: Uint8Array | number[], full = false) => {
    const body = Buffer.from(full ? [0, 0, 0, 0, ...payload] : [...payload])
    const out = Buffer.alloc(8 + body.length)
    out.writeUInt32BE(out.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    return out
  }
  const u32 = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]
  const ispe = (w: number, h: number) => box('ispe', [...u32(w), ...u32(h)], true)
  /**
   * The re-review's case, made without Pillow: a still item whose ispe says
   * 10 × 10, plus (optionally) a `moov` track of 3000 × 2000 (tkhd's width and
   * height, 16.16 fixed point) — the frames the engine's libavif decodes.
   */
  const avif = (brand: string, withTrack: boolean) => Buffer.concat([
    box('ftyp', [...Buffer.from(brand), 0, 0, 0, 0, ...Buffer.from('avifmif1msf1')]),
    box('meta', Buffer.concat([box('pitm', [0, 1], true), box('iprp', Buffer.concat([box('ipco', ispe(10, 10)), box('ipma', [...u32(1), 0, 1, 1, 1], true)]))]), true),
    ...(withTrack ? [box('moov', box('trak', box('tkhd', [...new Array(72).fill(0), ...u32(3000 << 16), ...u32(2000 << 16)], true)))] : []),
    box('mdat', new Array(64).fill(7)),
  ])

  it('the 2-frame sequence (brand avis, a track) and the same with mif1 or msf1: can\'t be sized, from disk or bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g1-avis-'))
    for (const brand of ['avis', 'mif1', 'msf1', 'avif']) {
      const bytes = avif(brand, true)
      writeFileSync(join(dir, `${brand}.avif`), bytes)
      expect(await picturePixels(join(dir, `${brand}.avif`)), brand).toBeNull()
      expect(await picturePixels(new Uint8Array(bytes)), brand).toBeNull()
    }
  })

  it('a sequence brand with no track is refused too; a still brand with no track is sized', async () => {
    for (const brand of ['avis', 'msf1', 'hevc', 'heim']) expect(await picturePixels(new Uint8Array(avif(brand, false))), brand).toBeNull()
    for (const brand of ['avif', 'mif1', 'heic']) expect(await picturePixels(new Uint8Array(avif(brand, false))), brand).toBe(100)
  })

  it('the gate refuses the sequence before a size-priced node; the runner refuses it in hosted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g1-avis2-'))
    writeFileSync(join(dir, 'seq.avif'), avif('avis', true))
    const s = await graphInputSizes({ 1: load('seq.avif'), 2: upscale('1', { model: 'Topaz', topaz_upscale_factor: '6x' }) }, v => picturePixels(join(dir, v)))
    expect(s.pixels).toEqual({})
    expect(s.problems.map(x => x.message)).toEqual([unreadableInputWords('UpscaleImageNode')])
    const f: OutputFile = { filename: 'seq.avif', subfolder: '', type: 'output' }
    const node = { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }
    expect(await measuredInput(node, () => [f], async () => new Uint8Array(avif('avis', true)), FAL_EDIT)).toEqual({ unreadable: true })
  })

  it('a top-level box running past the end of the file: can\'t be walked, refused', async () => {
    const bytes = avif('avif', false)
    expect(await picturePixels(new Uint8Array(bytes.subarray(0, bytes.length - 10)))).toBeNull()
  })
})

describe('side order: a loaded file\'s width may be its height to the engine (fix round 2, 3)', () => {
  /** A PNG with a `Raw profile type exif` text chunk — Pillow reads its orientation, sharp doesn't. */
  const withRawExif = async (w: number, h: number) => {
    const png = await sharp({ create: { width: w, height: h, channels: 3, background: '#888' } }).png().toBuffer()
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    const crc = (b: Buffer) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
    // "Exif\0\0" + a little-endian TIFF with one IFD entry: Orientation (0x0112) = 6.
    const exif = Buffer.from('457869660000' + '49492a0008000000' + '0100' + '120103000100000006000000' + '00000000', 'hex')
    const text = Buffer.concat([Buffer.from('Raw profile type exif\0'), Buffer.from(`\nexif\n${String(exif.length).padStart(8)}\n${exif.toString('hex')}\n`)])
    const body = Buffer.concat([Buffer.from('tEXt'), text])
    const chunk = Buffer.concat([Buffer.alloc(4), body, Buffer.alloc(4)])
    chunk.writeUInt32BE(text.length, 0)
    chunk.writeUInt32BE(crc(body), chunk.length - 4)
    return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)])
  }

  it('the re-review\'s 100 × 3000 PNG → Resize to height 1000 → Flux 2 Pro: sized for either order, so refused (was 33,000 px)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g1-orient-'))
    writeFileSync(join(dir, 'rawexif.png'), await withRawExif(100, 3000))
    // sharp reads it upright: 100 × 3000 (the engine turns it to 3000 × 100).
    const meta = await sharp(join(dir, 'rawexif.png')).metadata()
    expect([meta.width, meta.height, meta.orientation]).toEqual([100, 3000, undefined])
    const read = (v: string) => engineFileSizeAt(join(dir, v))
    const p: P = { 1: load('rawexif.png'), 2: { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } }, 3: flux2Edit('2'), 4: upscale('2', { model: 'Topaz' }) }
    const s = await graphInputSizes(p, read)
    // round(3000 × 1000 / 100) = 30000 × 1000: 30 MP, above the cap, so both size-priced nodes are refused.
    expect(s.pixels).toEqual({})
    expect(s.problems.map(x => x.nodeId).sort()).toEqual(['3', '4'])
  })

  it('Crop: each order cropped on its own; the larger count taken (fix round 3)', async () => {
    const read = async () => ({ pixels: 100 * 3000, width: 100, height: 3000 })
    const s = await graphInputSizes({ 1: load('a.png'), 2: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 2000, height: 2000, x: 0, y: 0 } }, 3: flux2Edit('2') }, read)
    // Upright: 100 × 2000; turned: 2000 × 100 — 200,000 either way (not a merged 2000 × 2000).
    expect(s.pixels[3]).toBe(100 * 2000)
  })

  it('an order-certain picture (a Frame\'s own size) is still exact', async () => {
    const s = await graphInputSizes({ 1: { class_type: 'Compositor', inputs: { width: 100, height: 3000 } }, 2: { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } }, 3: flux2Edit('2') }, files({}))
    expect(s.pixels[3]).toBe(33 * 1000)
  })
})

async function engineFileSizeAt(path: string) {
  const { pictureSize } = await import('~~/server/utils/graphInputPixels')
  return pictureSize(path)
}

// ── G1 fix round 3 ────────────────────────────────────────────────────────

describe('every shape a picture may have is carried through the chain (fix round 3, R1)', () => {
  const plain = async () => ({ pixels: 100 * 3000, width: 100, height: 3000 })

  it('the re-review\'s plain 100 × 3000 → Resize h1000 → Resize w1000 → Flux 2 Pro and Topaz: 30.3 MP possible, both refused', async () => {
    const p: P = {
      1: load('tall.png'),
      2: { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } },
      3: { class_type: 'ImageScale', inputs: { image: ['2', 0], width: 1000, height: 0 } },
      4: flux2Edit('3'),
      5: upscale('3', { model: 'Topaz' }),
    }
    const s = await graphInputSizes(p, plain)
    // Upright: 100 × 3000 → 33 × 1000 → 1000 × 30303. Turned: 3000 × 100 → 30000 × 1000 → 1000 × 33.
    expect(s.pixels).toEqual({})
    expect(s.problems.map(x => [x.nodeId, x.message])).toEqual([['4', unsizedInputWords('EditImageNode')], ['5', unsizedInputWords('UpscaleImageNode')]])
  })

  it('the re-review\'s Crop 3000 × 3000 → Resize h1000: 30 MP possible, refused', async () => {
    const p: P = {
      1: load('tall.png'),
      2: { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 3000, height: 3000, x: 0, y: 0 } },
      3: { class_type: 'ImageScale', inputs: { image: ['2', 0], width: 0, height: 1000 } },
      4: flux2Edit('3'),
    }
    const s = await graphInputSizes(p, plain)
    expect(s.pixels).toEqual({})
    expect(s.problems.map(x => x.nodeId)).toEqual(['4'])
  })

  it('a square picture has one shape, and stays exact through the chain', async () => {
    const s = await graphInputSizes({ 1: load('sq.png'), 2: { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } }, 3: { class_type: 'ImageScale', inputs: { image: ['2', 0], width: 500, height: 0 } }, 4: flux2Edit('3') },
      async () => ({ pixels: 2000 * 2000, width: 2000, height: 2000 }))
    expect(s.pixels[4]).toBe(500 * 500)
  })

  it('both orders small: priced on the larger count, never refused', async () => {
    const s = await graphInputSizes({ 1: load('a.png'), 2: { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 0, height: 1000 } }, 3: flux2Edit('2') },
      async () => ({ pixels: 3000 * 2000, width: 3000, height: 2000 }))
    // 1500 × 1000 or 667 × 1000.
    expect(s.pixels[3]).toBe(1500 * 1000)
    expect(s.problems).toEqual([])
  })
})

describe('a TIFF repeating a tag in its first directory: refused (fix round 3, R2)', () => {
  /** A classic little-endian uncompressed RGB TIFF with the given IFD0 entries (tag, type, value), then its strip. */
  const tiff = (entries: [number, number, number][], strip: number) => {
    const n = entries.length
    const ifd = 8
    const dataAt = ifd + 2 + n * 12 + 4
    const buf = Buffer.alloc(dataAt + strip)
    buf.write('II', 0, 'ascii')
    buf.writeUInt16LE(42, 2)
    buf.writeUInt32LE(ifd, 4)
    buf.writeUInt16LE(n, ifd)
    entries.forEach(([tag, type, value], i) => {
      const at = ifd + 2 + i * 12
      buf.writeUInt16LE(tag, at)
      buf.writeUInt16LE(type, at + 2)
      buf.writeUInt32LE(1, at + 4)
      if (type === 3) buf.writeUInt16LE(value === -1 ? dataAt : value, at + 8)
      else buf.writeUInt32LE(value === -1 ? dataAt : value, at + 8)
    })
    return buf
  }
  const tags = (w: number[], h: number[]): [number, number, number][] => [
    ...w.map(v => [256, 4, v] as [number, number, number]),
    ...h.map(v => [257, 4, v] as [number, number, number]),
    [258, 3, 8], [259, 3, 1], [262, 3, 2], [273, 4, -1], [277, 3, 3], [278, 4, 10], [279, 4, 300],
  ]

  it('the re-review\'s file (256 = 10, 256 = 3000, 257 = 10, 257 = 2000): not sized, from disk or bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g1-tiff-'))
    const bad = tiff(tags([10, 3000], [10, 2000]), 300)
    writeFileSync(join(dir, 'twice.tif'), bad)
    expect(await tiffFirstIfdUnique(new Uint8Array(bad))).toBe(false)
    expect(await picturePixels(join(dir, 'twice.tif'))).toBeNull()
    expect(await picturePixels(new Uint8Array(bad))).toBeNull()
    // The gate refuses it before a size-priced node; the runner's measuring does too.
    const s = await graphInputSizes({ 1: load('twice.tif'), 2: upscale('1', { model: 'Topaz', topaz_upscale_factor: '6x' }) }, v => picturePixels(join(dir, v)))
    expect(s.problems.map(x => x.message)).toEqual([unreadableInputWords('UpscaleImageNode')])
    const f: OutputFile = { filename: 'twice.tif', subfolder: '', type: 'output' }
    expect(await measuredInput({ class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }, () => [f], async () => new Uint8Array(bad), FAL_EDIT)).toEqual({ unreadable: true })
  })

  it('a TIFF naming each tag once is sized (sharp\'s own, and a hand-made one)', async () => {
    expect(await tiffFirstIfdUnique(new Uint8Array(tiff(tags([10], [10]), 300)))).toBe(true)
    expect(await picturePixels(new Uint8Array(tiff(tags([10], [10]), 300)))).toBe(100)
    const real = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#888' } }).tiff().toBuffer()
    expect(await tiffFirstIfdUnique(new Uint8Array(real))).toBe(true)
    expect(await picturePixels(new Uint8Array(real))).toBe(2400)
  })

  it('a first directory past the end of the file: refused', async () => {
    const t = tiff(tags([10], [10]), 0)
    t.writeUInt32LE(99999, 4)
    expect(await tiffFirstIfdUnique(new Uint8Array(t))).toBe(false)
  })
})

describe('the run reads exactly the bytes it was priced on (fix round 3, R3 + R4)', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'g1-snap-'))
    for (const d of ['input', 'output', 'temp']) mkdirSync(join(root, d))
    const folder = (name: 'input' | 'output' | 'temp') => join(root, name)
    return { root, folder, snaps: createGateSnapshots({ folder, token: 'run1' }) }
  }
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#888' } }).png().toBuffer()

  it('a measured picture is copied under its sha-256, measured from the copy; overwriting the original after submit changes nothing', async () => {
    const { root, folder, snaps } = setup()
    const small = await png(100, 100)
    writeFileSync(join(root, 'input', 'mine.png'), small)
    const copy = (await snaps.take({ value: 'mine.png', literalInput: false }))!
    const sha = createHash('sha256').update(small).digest('hex')
    expect(copy.name).toBe(`g1-run1-${sha}.png`)
    expect(copy.path).toBe(join(root, 'input', copy.name))
    // The owner overwrites their file with a 48 MP picture once the prompt is queued.
    writeFileSync(join(root, 'input', 'mine.png'), await png(8000, 6000))
    expect(readFileSync(copy.path).equals(small)).toBe(true)
    expect(await picturePixels(copy.path)).toBe(100 * 100)
    // ComfyUI resolves the unannotated copy name in the input folder (LoadImage, the Image card, the /view refs).
    expect(sourcePath({ value: copy.name, literalInput: false }, folder)).toBe(copy.path)
    expect(sourcePath({ value: copy.name, literalInput: true }, folder)).toBe(copy.path)
    await snaps.release()
    expect(existsSync(copy.path)).toBe(false)
  })

  it('an output file and an annotated value are copied into the input folder; the same file once', async () => {
    const { root, snaps } = setup()
    writeFileSync(join(root, 'output', 'made.png'), await png(10, 10))
    const a = (await snaps.take({ value: 'made.png [output]', literalInput: false }))!
    expect(a.path.startsWith(join(root, 'input'))).toBe(true)
    writeFileSync(join(root, 'input', 'x.png'), await png(12, 12))
    const b1 = (await snaps.take({ value: 'x.png', literalInput: false }))!
    const b2 = (await snaps.take({ value: 'x.png [input]', literalInput: false }))!
    expect(b2).toEqual(b1)
    expect(readdirSync(join(root, 'input')).filter(n => n.startsWith('g1-')).length).toBe(2)
    await snaps.release()
    expect(readdirSync(join(root, 'input')).filter(n => n.startsWith('g1-'))).toEqual([])
  })

  it('the forwarded prompt names the copies: file inputs, and /view references in the options, nothing else changed', () => {
    const names = new Map([['engine:a.png', 'g1-r-aaa.png'], ['engine:s.wav', 'g1-r-bbb.wav'], ['view:v.mp4', 'g1-r-ccc.mp4'], ['view:ref.mp4', 'g1-r-ddd.mp4']])
    const snaps = { nameFor: (s: { value: string, literalInput: boolean }) => names.get(`${s.literalInput ? 'view' : 'engine'}:${s.value}`) ?? null }
    const options = '{"engine": "sync", "face_video": "/view?filename=v.mp4&type=input", "note": 1.0}'
    const seedance = '{"video_urls": ["/view?filename=ref.mp4&type=input", "https://x/y.mp4"], "image_urls": ["/view?filename=other.png&type=input"]}'
    const prompt: P = {
      1: load('a.png'),
      2: { class_type: 'Image', inputs: { image: 'unmeasured.png' } },
      3: { class_type: 'LoadAudio', inputs: { audio: 's.wav' } },
      4: { class_type: 'LipSyncNode', inputs: { audio: ['3', 0], model_options: options, prompt: 'a.png' } },
      5: { class_type: 'GenerateVideoNode', inputs: { model: 'seedance-2.0', model_options: seedance } },
    }
    const r = rewriteMeasuredInputs(prompt, snaps)
    if (!('prompt' in r)) throw new Error('refused')
    expect(r.prompt[1]!.inputs.image).toBe('g1-r-aaa.png')
    expect(r.prompt[2]!.inputs.image).toBe('unmeasured.png')
    expect(r.prompt[3]!.inputs.audio).toBe('g1-r-bbb.wav')
    // Only the reference's own string changes: the rest of the text (1.0 included) is byte for byte the same.
    expect(r.prompt[4]!.inputs.model_options).toBe('{"engine": "sync", "face_video": "/view?filename=g1-r-ccc.mp4&type=input", "note": 1.0}')
    expect(r.prompt[4]!.inputs.prompt).toBe('a.png')
    expect(JSON.parse(r.prompt[5]!.inputs.model_options)).toEqual({ video_urls: ['/view?filename=g1-r-ddd.mp4&type=input', 'https://x/y.mp4'], image_urls: ['/view?filename=other.png&type=input'] })
    // The caller's prompt is untouched.
    expect(prompt[1]!.inputs.image).toBe('a.png')
  })

  it('a measured reference written in a form that can\'t be swapped exactly: refused', () => {
    const snaps = { nameFor: (s: { value: string, literalInput: boolean }) => (s.literalInput && s.value === 'v.mp4' ? 'g1-r-ccc.mp4' : null) }
    // "\/" escapes: the same string to JSON, but not the same text.
    const r = rewriteMeasuredInputs({ 4: { class_type: 'LipSyncNode', inputs: { model_options: '{"face_video": "\\/view?filename=v.mp4&type=input"}' } } }, snaps)
    expect('problems' in r && r.problems.map(x => x.message)).toEqual([MEASURED_REF_UNRENAMABLE])
  })

  it('the gate forwards the copies, prices them, and releases them only when the run ends', async () => {
    const { root, folder } = setup()
    writeFileSync(join(root, 'input', 'mine.png'), await png(1000, 1000))
    const snaps = createGateSnapshots({ folder, token: 'run2' })
    const released: string[] = []
    const forwarded: any[] = []
    let settle: (() => void) | undefined
    const deps = {
      priceGraph,
      normalizePrompt: (p: unknown) => normalizeHostedPrompt(p, CATALOG),
      measureInputSizes: (p: any) => graphInputSizes(p, async v => { const c = await snaps.take({ value: v, literalInput: false }); return c ? pictureSize(c.path) : null }),
      finalizePrompt: (p: any) => rewriteMeasuredInputs(p, snaps),
      releaseInputs: async () => { released.push('now'); await snaps.release() },
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => ({ ok: true as const, holdId: 1 }),
      getAvailable: async () => 0,
      forward: async (b: any) => { forwarded.push(b); return { status: 200, body: { prompt_id: 'p' } } },
      registerRun: async () => {},
      startSettle: () => { settle = () => { void snaps.release() } },
      releaseHold: async () => {},
    }
    const prompt: P = { 1: { ...load('mine.png'), is_changed: 'pinned' } as any, 2: flux2Edit('1'), 3: SINK }
    const res = await meterGraphSubmit('u', { prompt }, deps)
    expect(res.status).toBe(200)
    const sent = forwarded[0].prompt
    expect(sent[1].inputs.image).toMatch(/^g1-run2-[0-9a-f]{64}\.png$/)
    // is_changed never reaches the engine.
    expect(Object.keys(sent[1]).sort()).toEqual(['class_type', 'inputs'])
    // The copy is still there for the queued run; released when its watcher ends.
    expect(released).toEqual([])
    expect(existsSync(join(root, 'input', sent[1].inputs.image))).toBe(true)
    settle!()
    await new Promise(r => setTimeout(r, 20))
    expect(existsSync(join(root, 'input', sent[1].inputs.image))).toBe(false)
  })

  it('a refused or unqueued run releases its copies at once', async () => {
    for (const forward of [
      async () => ({ status: 400, body: { error: 'x' } }),
      async () => { throw new Error('engine down') },
    ]) {
      const released: string[] = []
      await meterGraphSubmit('u', { prompt: { 1: load('a.png'), 2: SINK } }, {
        priceGraph, releaseInputs: async () => { released.push('now') },
        spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
        hold: async () => ({ ok: true as const, holdId: 1 }), getAvailable: async () => 0,
        forward, registerRun: async () => {}, startSettle: () => { throw new Error('not reached') }, releaseHold: async () => {},
      }).catch(() => null)
      expect(released).toEqual(['now'])
    }
  })

  it('is_changed and any other node-level key are dropped by the normalisation; _meta is kept', () => {
    const n = normalised({ 1: { class_type: 'LoadImage', inputs: { image: 'a.png' }, is_changed: 'pinned', _meta: { title: 'Photo' }, extra: 1 } as any })
    expect(n[1]).toEqual({ class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'Photo' } })
  })

  it('the live hosted handler that forwarded the copies to the engine is gone (step 3, R10.9)', () => {
    const src = readFileSync(join(process.cwd(), 'server/utils/meterGraphRun.ts'), 'utf8')
    expect(src).not.toMatch(/handleMeteredPrompt|createGateSnapshots\(\)|\bfetch\(/)
  })
})

// ── G1 follow-up (re-review 3) ────────────────────────────────────────────

describe('what one request may copy (follow-up 1)', () => {
  const seedanceNode = (names: string[]) => ({
    class_type: 'GenerateVideoNode',
    inputs: { model: 'seedance-2.0', model_options: JSON.stringify({ audio_urls: names.map(n => `/view?filename=${n}&type=input`) }) },
  })

  it('Seedance references share one read limit per prompt; past it, refused in plain words (the re-review\'s 20 nodes × 3 sounds)', async () => {
    const p: P = {}
    for (let i = 0; i < 20; i++) p[`s${i}`] = seedanceNode([`a${i}.wav`, `b${i}.wav`, `c${i}.wav`])
    const read: string[] = []
    const problems = await seedanceReferenceSeconds(p, async (f) => { read.push(f.value); return 1 }, { strict: true, reads: createGateReads() })
    expect(read).toHaveLength(SEEDANCE_REFERENCE_READS)
    expect(SEEDANCE_REFERENCE_READS).toBe(12)
    // The first four nodes (12 references) are read; the other 16 are refused.
    expect(problems).toHaveLength(16)
    expect(new Set(problems.map(x => x.message))).toEqual(new Set([SEEDANCE_TOO_MANY_REFERENCES]))
    expect(SEEDANCE_TOO_MANY_REFERENCES).toBe('This run has more Seedance 2.0 reference videos and sounds than Sailor can check at once. Run fewer at a time.')
  })

  it('the same reference in many nodes is read once and counts once', async () => {
    const p: P = {}
    for (let i = 0; i < 20; i++) p[`s${i}`] = seedanceNode(['same.wav'])
    const read: string[] = []
    expect(await seedanceReferenceSeconds(p, async (f) => { read.push(f.value); return 1 }, { strict: true, reads: createGateReads() })).toEqual([])
    expect(read).toEqual(['same.wav'])
  })

  it('a request\'s copies stop at the byte limit: nothing past it is copied, and the request is refused plainly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'g1-budget-'))
    for (const d of ['input', 'output', 'temp']) mkdirSync(join(root, d))
    const folder = (name: 'input' | 'output' | 'temp') => join(root, name)
    for (const n of ['a', 'b', 'c']) writeFileSync(join(root, 'input', `${n}.wav`), Buffer.alloc(400, n))
    const snaps = createGateSnapshots({ folder, token: 'b'.repeat(24), maxBytes: 1000 })
    expect(await snaps.take({ value: 'a.wav', literalInput: false })).not.toBeNull()
    expect(await snaps.take({ value: 'b.wav', literalInput: false })).not.toBeNull()
    expect(snaps.overBudget()).toBe(false)
    expect(await snaps.take({ value: 'c.wav', literalInput: false })).toBeNull()
    expect(snaps.overBudget()).toBe(true)
    // Only two copies were made.
    expect(readdirSync(join(root, 'input')).filter(n => n.startsWith('g1-'))).toHaveLength(2)
    await snaps.release()
    expect(INPUTS_TOO_LARGE).toBe('This run uses more file data than Sailor can check at once. Run fewer or smaller files at a time.')
  })

  it('the gate refuses an over-limit request with that message, before the hold, and releases the copies', async () => {
    let held = false
    let released = false
    // The limit is passed while the pictures are measured (the copy of the next one isn't made).
    let over = false
    const res = await meterGraphSubmit('u', { prompt: { 1: load('a.png'), 2: flux2Edit('1'), 3: SINK } }, {
      priceGraph,
      measureInputSizes: async () => { over = true; return { pixels: {}, problems: [{ nodeId: '2', classType: 'EditImageNode', input: 'input_image', message: unreadableInputWords('EditImageNode') }] } },
      inputsRefusal: () => (over ? INPUTS_TOO_LARGE : null),
      releaseInputs: async () => { released = true },
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => { held = true; return { ok: true as const, holdId: 1 } }, getAvailable: async () => 0,
      forward: async () => ({ status: 200, body: { prompt_id: 'p' } }), registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }) as { status: number, body: any }
    expect(res.status).toBe(400)
    // The byte limit's own words, not the "can't read the size" the uncopied file would otherwise give.
    expect(res.body.error.message).toBe(INPUTS_TOO_LARGE)
    expect(held).toBe(false)
    expect(released).toBe(true)
  })

  it('a caller with no credit is refused before anything is copied or measured; a free prompt isn\'t asked', async () => {
    let measured = false
    const deps = {
      priceGraph,
      availableBeforeMeasuring: async () => 0,
      measureInputSizes: async () => { measured = true; return { pixels: {}, problems: [] } },
      referenceSecondsProblems: async () => { measured = true; return [] },
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => ({ ok: true as const, holdId: 1 }), getAvailable: async () => 0,
      forward: async () => ({ status: 200, body: { prompt_id: 'p' } }), registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }
    const err = await meterGraphSubmit('u', { prompt: { 1: load('a.png'), 2: flux2Edit('1'), 3: SINK } }, deps).then(() => null, e => e)
    expect(err?.statusCode).toBe(402)
    expect(measured).toBe(false)
    // Nothing that costs anything (no output, no paid node): not asked, runs on.
    let asked = false
    const res = await meterGraphSubmit('u', { prompt: { 1: load('a.png') } }, { ...deps, availableBeforeMeasuring: async () => { asked = true; return 0 } })
    expect(asked).toBe(false)
    expect(res.status).toBe(200)
    // A caller with credit goes on to measuring as before.
    measured = false
    await meterGraphSubmit('u', { prompt: { 1: load('a.png'), 2: flux2Edit('1'), 3: SINK } }, { ...deps, availableBeforeMeasuring: async () => 500 })
    expect(measured).toBe(true)
  })
})

describe('the leftover sweep deletes only the copies\' own names (follow-up 2)', () => {
  it('an old upload that merely starts with g1- is kept; an old copy (and its temporary) is removed; a fresh copy is kept', async () => {
    const root = mkdtempSync(join(tmpdir(), 'g1-sweep-'))
    for (const d of ['input', 'output', 'temp']) mkdirSync(join(root, d))
    const input = join(root, 'input')
    const token = 'a'.repeat(24)
    const oldCopy = `g1-${token}-${'c'.repeat(64)}.png`
    const oldTmp = `g1-${token}-${'d'.repeat(16)}.tmp`
    const freshCopy = `g1-${'e'.repeat(24)}-${'f'.repeat(64)}.wav`
    const uploads = ['g1-holiday.png', `g1-${token}.png`, `g1-${token}-${'c'.repeat(63)}.png`, `g1-${'g'.repeat(24)}-${'c'.repeat(64)}.png`, `g1-${token}-${'c'.repeat(64)}.png.bak`]
    for (const n of [oldCopy, oldTmp, freshCopy, ...uploads]) writeFileSync(join(input, n), 'x')
    const old = (Date.now() - 5 * 60 * 60 * 1000) / 1000
    for (const n of [oldCopy, oldTmp, ...uploads]) utimesSync(join(input, n), old, old)
    expect(uploads.some(n => SNAPSHOT_NAME.test(n))).toBe(false)
    expect([oldCopy, oldTmp, freshCopy].every(n => SNAPSHOT_NAME.test(n))).toBe(true)
    writeFileSync(join(input, 'src.png'), 'y')
    __resetSnapshotSweepForTests()
    await createGateSnapshots({ folder: n => join(root, n), token: 'b'.repeat(24) }).take({ value: 'src.png', literalInput: false })
    const left = readdirSync(input)
    expect(left).not.toContain(oldCopy)
    expect(left).not.toContain(oldTmp)
    for (const n of [freshCopy, ...uploads]) expect(left, n).toContain(n)
  })
})
