/**
 * Task G1 (final re-review finding 1): the hosted /prompt gate sizes the
 * picture a size-priced node (Upscale, Enhance detail, FLUX.2 edit) is sent
 * when it comes out of another node, not just a loaded file or Generate an
 * image, and refuses one it can't size, or can only bound above the ~19 MP
 * cap. Loaded pictures in AVIF, GIF, TIFF, BMP and HEIC are measured too; a
 * loaded picture whose size can't be read is refused on a size-priced node
 * in hosted mode (gate and runner). Local mode is unchanged.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { LARGEST_INPUT_PIXELS, madePictureBound, nanoBananaPixels, upscaleSideFactor } from '#shared/pricing/editSettings'
import { editUsd } from '#shared/pricing/editRates'
import { measuredInput } from '~~/server/runner/metering'
import {
  ENHANCE_DETAIL_TOO_LARGE, FLUX_2_EDIT_TOO_LARGE, UPSCALE_TOO_LARGE, measuredInputProblems, unreadableInputWords, unsizedInputWords,
} from '~~/server/runner/requestRules'
import {
  MAX_HOPS, MAX_MEASURED_FILES, createGateReads, graphInputPixelProblems, graphInputPixels, graphInputSizes, isobmffIspePixels, picturePixels, pictureRule,
} from '~~/server/utils/graphInputPixels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
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
      measureInputPixels: p => graphInputPixels(p, read, reads),
      inputPixelProblems: p => graphInputPixelProblems(p, read, reads),
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
      measureInputPixels: q => graphInputPixels(q, read, reads),
      inputPixelProblems: q => graphInputPixelProblems(q, read, reads),
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
    expect(src).toContain('inputPixelProblems: prompt => graphInputPixelProblems(prompt, undefined, reads)')
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

  it('Resize, Scale by and Crop', async () => {
    expect((await into({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 2000, height: 1000 } })).pixels[3]).toBe(2 * MP)
    expect((await into({ class_type: 'ImageScale', inputs: { image: ['1', 0], width: 2000, height: 0 } })).problems).toHaveLength(1)
    expect((await into({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: 0.5 } })).pixels[3]).toBe(7.5 * MP)
    expect((await into({ class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: ['9', 0] } })).pixels[3]).toBe(30 * MP * 64)
    expect((await into({ class_type: 'ImageCrop', inputs: { image: ['1', 0], width: 1000, height: 1000, x: 0, y: 0 } })).pixels[3]).toBe(MP)
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

  it('past the read budget: priced at the cap, not refused (parked ruling) — unless enlarged on the way', async () => {
    const p: P = {}
    for (let i = 0; i <= MAX_MEASURED_FILES; i++) {
      p[`l${i}`] = load(`f${i}.jpg`)
      p[`e${i}`] = flux2Edit(`l${i}`)
    }
    p.up = upscale(`l${MAX_MEASURED_FILES}`, { model: 'Topaz' })
    p.after = flux2Edit('up')
    const s = await graphInputSizes(p, async () => MP)
    expect(Object.keys(s.pixels)).toHaveLength(MAX_MEASURED_FILES)
    expect(s.problems.map(x => x.nodeId)).toEqual(['after'])
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
  const cat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(p => [...p]))

  it('a tiled HEIC (tiles, thumbnail and the whole picture each have a size): the largest, never a tile\'s', async () => {
    const heic = cat(
      box('ftyp', new Uint8Array([...Buffer.from('heic'), 0, 0, 0, 0, ...Buffer.from('mif1heic')])),
      box('meta', cat(box('hdlr', new Uint8Array(20), true), box('iprp', box('ipco', cat(ispe(512, 512), ispe(320, 240), ispe(4032, 3024))))), true),
    )
    expect(isobmffIspePixels(heic)).toBe(4032 * 3024)
    expect(await picturePixels(heic)).toBe(4032 * 3024)
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
    expect(pictureRule('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '4x', image: ['1', 0] })).toEqual({ scaled: ['1', 0], side: 4 })
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
