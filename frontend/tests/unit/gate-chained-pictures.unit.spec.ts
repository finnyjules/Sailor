/**
 * Task G1 (final re-review finding 1): the hosted /prompt gate sizes the
 * picture a size-priced node (Upscale, Enhance detail, FLUX.2 edit) is sent
 * when it comes out of another node, not just a loaded file or Generate an
 * image, and refuses one it can't size, or can only bound above the ~19 MP
 * cap. Loaded pictures in AVIF, GIF, TIFF, BMP and HEIC are measured too; a
 * loaded picture whose size can't be read is refused on a size-priced node
 * in hosted mode (gate and runner). Local mode is unchanged.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  ENHANCE_DETAIL_TOO_LARGE, FLUX_2_EDIT_TOO_LARGE, UPSCALE_TOO_LARGE, measuredInputProblems, tooManyPicturesWords, unreadableInputWords, unsizedInputWords,
} from '~~/server/runner/requestRules'
import {
  ISOBMFF_HEAD_BYTES, MAX_HOPS, MAX_MEASURED_FILES, createGateReads, graphInputPixels, graphInputSizes, isobmffIspePixels, picturePixels, pictureRule, pyRound,
} from '~~/server/utils/graphInputPixels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
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

  it('a picture the gate can\'t size (Recraft Crisp → Flux 2 Pro): refused before any hold, and the live handler asks', async () => {
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
    const src = readFileSync(join(process.cwd(), 'server/utils/meterGraphRun.ts'), 'utf8')
    expect(src).toContain('measureInputSizes: prompt => graphInputSizes(prompt, undefined, reads)')
    expect(src).toContain('normalizePrompt: prompt => normalizeHostedPrompt(prompt, storedNodeCatalog())')
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
    for (const width of ['4096', 4096.5, { __value__: 4096 }, { __value__: '4096' }, ' 4096 ']) {
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
    for (const width of ['4_096', 'inf', '4096.5', null, [1], { a: 1 }, '٤٠٩٦']) {
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
    const res = await meterGraphSubmit('u', { prompt: frame({ width: '4_096', height: 4096 }) }, {
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
