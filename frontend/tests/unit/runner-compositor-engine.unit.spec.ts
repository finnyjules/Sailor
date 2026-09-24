/**
 * The Frame render on the runner, family `frame`: which workflows it takes
 * (the one rule table), how a wired picture's source picks its decode, and
 * the engine end to end on the kit (hosted, fake fal and ledger, real
 * files): rendered locally, saved as a temp live preview, charged nothing,
 * handed on to the next node. Pixel parity with Python is
 * runner-compositor.unit.spec.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  COMPOSITOR_BLEND_MODES, HOSTED_MAX_FRAME_ARTBOARD_PIXELS, IMAGE_OUTPUT_CLASSES, LOCAL_RENDER_TYPES, MAX_FRAME_COPIES,
  MAX_FRAME_WORK, PROVIDER_TYPES, RUNNER_NODE_RULES,
  clonerCopies, isRunnerEligible, nodeRuleAllows, runnerTakesNode,
} from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { nodesNeedingEngine } from '~~/app/lib/runner/needsEngine'
import { collectInputFiles } from '~~/server/runner/inputs'
import { nodeCredits, stageEstimate, unpricedProviderNode } from '~~/server/runner/metering'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import { decodeLoadMask, decodePicture, encodePreviewPng } from '~~/server/runner/compositor/decode'
import { renderFrame } from '~~/server/runner/compositor/render'
import { nextLivePreview } from '~~/server/runner/results'
import type { OutputFile } from '~~/server/runner/types'
import { makeKit, ofType } from './__runner__/kit'
import { existsSync } from 'node:fs'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { MAX_QUEUED_CALLS } from '~~/server/runner/engine'
import { userSubfolder } from '~~/server/runner/results'
import { FRAME_TIMEOUT_MESSAGE, __frameWorkerForTests, __setFrameTimeoutForTests, renderFrameInWorker, workerScript } from '~~/server/runner/compositor/worker'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { MAX_CANVAS_PIXELS, composeFrame, inThreadBackend } from '~~/server/runner/compositor/render'
import { compositorCore, core, plane } from '~~/server/runner/compositor/plane'

const FRAME: ReadonlySet<RunnerFamily> = new Set(['frame'])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/** Every widget the canvas sends for a Compositor (graphToPrompt writes all 16 slots), plus overrides. */
function frameWidgets(over: Record<string, unknown> = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  for (let i = 1; i <= 16; i++) {
    Object.assign(w, {
      [`layer${i}_x`]: 0, [`layer${i}_y`]: 0, [`layer${i}_rotation`]: 0, [`layer${i}_scale`]: 1,
      [`layer${i}_opacity`]: 1, [`layer${i}_blend`]: 'normal', [`layer${i}_z`]: i, [`layer${i}_protect`]: false, [`layer${i}_cloner`]: '',
    })
  }
  return { ...w, width: 0, height: 0, motion_params: '', ...over }
}
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const frame = (inputs: Record<string, unknown>) => ({ class_type: 'Compositor', inputs: frameWidgets(inputs) })

/** Image card 1 → Frame 3 (plus a baked local layer: LoadImage 2 on slot 2, IMAGE and MASK) → Image card 4. */
function frameFlow(over: Record<string, unknown> = {}): ApiPrompt {
  return {
    1: card('base.png'),
    2: loadImage('sailor_local_3_1_1.png'),
    3: frame({ layer1: ['1', 0], layer2: ['2', 0], layer2_mask: ['2', 1], layer2_z: 5, ...over }),
    4: outCard('3'),
  }
}

describe('eligibility: family frame', () => {
  it('takes a Frame workflow only with frame on; free local classes are not providers', () => {
    const p = frameFlow()
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, new Set(RUNNER_FAMILIES.filter(f => f !== 'frame')))).toBe(false)
    expect(isRunnerEligible(p, FRAME)).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    expect(PROVIDER_TYPES.has('Compositor')).toBe(false)
    expect(LOCAL_RENDER_TYPES.has('Compositor')).toBe(true)
    expect(LOCAL_RENDER_TYPES.has('LoadImage')).toBe(false)
    // A LoadImage alone is not work.
    expect(isRunnerEligible({ 1: loadImage('a.png') }, FRAME)).toBe(false)
  })

  it('nodesNeedingEngine names the Frame and its LoadImage when frame is off, nothing when on', () => {
    const titleOf = (id: string) => `#${id}`
    expect(nodesNeedingEngine(frameFlow(), { runnerOn: true, families: NO_FAMILIES, titleOf })).toEqual(['#2', '#3'])
    expect(nodesNeedingEngine(frameFlow(), { runnerOn: true, families: FRAME, titleOf })).toEqual([])
  })

  const refused: Array<[string, ApiPrompt, string]> = [
    ['baked motion (motion_params.rendered)', frameFlow({ motion_params: JSON.stringify({ fps: 24, rendered: ['slate_1_0001.png'] }) }), '3'],
    ['motion JSON the browser cannot read but mentions rendered', frameFlow({ motion_params: '{"rendered": [NaN]}' }), '3'],
    ['layer 1 unwired (ComfyUI refuses: layer1 is required)', { 1: card('a.png'), 3: frame({ layer2: ['1', 0] }) }, '3'],
    ['a scale above 3', frameFlow({ layer1_scale: 3.5 }), '3'],
    ['an offset below -1.5', frameFlow({ layer2_x: -1.6 }), '3'],
    ['a z beyond 1000', frameFlow({ layer1_z: 1001 }), '3'],
    ['a width beyond 8192', frameFlow({ width: 9000, height: 10 }), '3'],
    ['a width that is not a whole number', frameFlow({ width: '12.5' }), '3'],
    ['a blend not in the list', frameFlow({ layer1_blend: 'lighter' }), '3'],
    ['a missing required widget', (() => { const p = frameFlow(); delete p['3']!.inputs.layer9_rotation; return p })(), '3'],
    ['a wired widget', { ...frameFlow({ layer1_x: ['1', 0] }) }, '3'],
    ['a mask from an Image card', { ...frameFlow({ layer2_mask: ['1', 1] }) }, '3'],
    ['a LoadImage feeding something else', { ...frameFlow(), 5: { class_type: 'DevelopImageNode', inputs: { input_image: ['2', 0] } } }, '2'],
  ]
  it.each(refused)('%s → ComfyUI', (_l, p, badId) => {
    expect(isRunnerEligible(p, ALL)).toBe(false)
    expect(runnerTakesNode(p, badId, ALL)).toBe(false)
  })

  it('refuses a workflow reading the protect_mask or the video output', () => {
    const mask = { ...frameFlow(), 5: { class_type: 'BlendSceneNode', inputs: { model: 'Flux 2 Pro', image: ['3', 0], keep_subject: ['3', 1] } } }
    const video = { ...frameFlow(), 5: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['3', 2] } } }
    for (const p of [mask, video]) {
      expect(runnerTakesNode(p, '3', ALL)).toBe(false)
      expect(isRunnerEligible(p, ALL)).toBe(false)
    }
  })

  it('takes a Frame on a generated picture, and one read by a provider', () => {
    const p: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 3, model_options: '{}' } },
      3: frame({ layer1: ['1', 0], overlay: ['1', 0] }),
      5: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['3', 0], prompt: 'warmer', output_format: 'png', seed: 0 } },
    }
    expect(isRunnerEligible(p, ALL)).toBe(true)
    // The strings the canvas can send for numbers and toggles still validate.
    expect(isRunnerEligible(frameFlow({ layer1_x: '0.25', layer1_protect: 'false', width: '64', height: 32.9 }), FRAME)).toBe(true)
    expect(COMPOSITOR_BLEND_MODES).toHaveLength(10)
  })
})

describe('which decode a wired picture gets', () => {
  const p: ApiPrompt = {
    1: card('a.png'),
    2: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell' } },
    3: outCard('2'),
    4: { class_type: 'ComfyGateNode', inputs: { data_in: ['3', 0] } },
    5: loadImage('b.png'),
    6: frame({ layer1: ['1', 0] }),
    7: { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: '  ' } },
    8: { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: 'the cup' } },
    9: card(''),
  }
  it.each([
    ['a loaded Image card', ['1', 0], 'card'],
    ['a generator', ['2', 0], 'provider'],
    ['an Image card showing a generator, through a Gate', ['4', 0], 'provider'],
    ['a LoadImage', ['5', 0], 'load'],
    ['another Frame', ['6', 0], 'rgb'],
    ['a nano action that passes its picture on', ['7', 0], 'card'],
    ['a nano action that makes one', ['8', 0], 'provider'],
    ['an empty Image card (Python’s 1×1 placeholder)', ['9', 0], 'blank'],
  ] as const)('%s', (_l, link, want) => {
    expect(pictureSourceOf(p, [link[0], link[1]])).toBe(want)
  })
})

describe('money: the Frame is free, its stage pays the render credit', () => {
  it('prices at 0 and is never an unpriced provider; its stage holds the base credit (as the Python path charges)', () => {
    const p = frameFlow()
    expect(nodeCredits(p['3']!)).toBe(0)
    expect(unpricedProviderNode(p)).toBeNull()
    expect(stageEstimate(p, Object.keys(p), true)).toBe(BASE_RENDER_CREDITS)
    // No base when it is not owed (already charged, or no output card), and nothing without a Frame in the stage.
    expect(stageEstimate(p, Object.keys(p), false)).toBe(0)
    expect(stageEstimate(p, ['1', '2', '4'], true)).toBe(0)
  })
  it('the injected LoadImage file is checked for ownership', () => {
    expect(collectInputFiles(frameFlow())).toEqual([
      { filename: 'base.png', subfolder: '', type: 'input' },
      { filename: 'sailor_local_3_1_1.png', subfolder: '', type: 'input' },
    ])
  })
  it('numbers live previews after the highest there', () => {
    expect(nextLivePreview(['live_preview_3_00002.png', 'live_preview_3_00010.png', 'live_preview_31_00099.png', 'live_preview_3.png'], 'live_preview_3')).toBe(11)
  })
})

// ── The engine ────────────────────────────────────────────────────────────

const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-compositor.json', import.meta.url)), 'utf8')) as { assets: Record<string, string> }
const asset = (name: string) => Buffer.from(FIX.assets[name]!, 'base64')

async function pixels(root: string, f: OutputFile): Promise<Buffer> {
  return (await sharp(join(root, f.type, f.subfolder, f.filename)).raw().toBuffer())
}

describe('the engine renders a Frame (hosted, frame on)', () => {
  it('renders on the worker, saves a temp live preview in the user’s folder, charges the render credit only, and the next card shows it', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => FRAME } })
    writeFileSync(join(k.root, 'input', 'base.png'), asset('wide.png'))
    writeFileSync(join(k.root, 'input', 'sailor_local_3_1_1.png'), asset('overlay.png'))
    const prompt = frameFlow({ layer1_rotation: 10, layer1_scale: 0.9 })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)

    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const rec = run.takes[0]!.nodes['3']!
    expect(rec.status).toBe('done')
    expect(rec.credits).toBe(0)
    expect(rec.endpoint).toBeNull()
    // Hosted: the user's own subfolder of temp/ (/view serves temp by type, subfolder and name).
    const sub = userSubfolder(k.userId, true)
    expect(sub).toMatch(/^u_/)
    expect(rec.outputs).toEqual([{ filename: 'live_preview_3_00001.png', subfolder: sub, type: 'temp' }])
    expect(existsSync(join(k.root, 'temp', sub, 'live_preview_3_00001.png'))).toBe(true)
    // Rendered off the main thread.
    expect(__frameWorkerForTests()).not.toBeNull()
    // No provider and no generation record; the stage holds and settles the render credit only.
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.records.write).not.toHaveBeenCalled()
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[BASE_RENDER_CREDITS, 'settled', BASE_RENDER_CREDITS]])
    expect(run.charges[0]!.actual).toBe(BASE_RENDER_CREDITS)
    // The Frame card gets save_live_preview's ui; the card after it shows the same file.
    const executed = ofType(k.seen, 'executed')
    expect(executed.find(m => m.data.node === '3')!.data.output).toEqual({ images: rec.outputs, animated: [false] })
    expect((executed.find(m => m.data.node === '4')!.data.output as { images: OutputFile[] }).images).toEqual(rec.outputs)

    // The pixels are renderFrame's, from the same decodes.
    const want = await renderFrame(prompt['3']!.inputs, {
      layers: [await decodePicture(asset('wide.png'), 'card'), await decodePicture(asset('overlay.png'), 'load'), ...Array(14).fill(null)],
      masks: [null, await decodeLoadMask(asset('overlay.png')), ...Array(14).fill(null)],
      overlay: null,
      overlayMask: null,
    })
    const wantPng = await sharp(await encodePreviewPng(want.image)).raw().toBuffer()
    expect((await pixels(k.root, rec.outputs[0]!)).equals(wantPng)).toBe(true)

    // A second run numbers the next preview.
    const again = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(again.runId)
    expect((await k.store.get(again.runId))!.takes[0]!.nodes['3']!.outputs[0]!.filename).toBe('live_preview_3_00002.png')
  })

  it('a generated picture → Frame → an edit: the composite is handed off, only the providers are charged', async () => {
    const png = await sharp(asset('big.png')).png().toBuffer()
    const k = makeKit({
      hosted: true,
      deps: { families: () => new Set<RunnerFamily>(['frame', 'fal-edit']), download: async () => ({ bytes: new Uint8Array(png), contentType: 'image/png' }) },
    })
    const prompt: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      3: frame({ layer1: ['1', 0], layer1_opacity: 0.5, width: 40, height: 30 }),
      5: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['3', 0], prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } },
      6: outCard('5'),
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const composite = run.takes[0]!.nodes['3']!.outputs[0]!
    expect(composite.type).toBe('temp')
    // The edit received the composite as a fal storage link.
    expect(k.upload).toHaveBeenCalledWith(expect.anything(), composite.filename, 'image/png')
    const edit = k.fal.submitted().find(r => r.endpoint.includes('nano-banana-2'))!
    expect((edit.payload as { image_urls: string[] }).image_urls).toEqual([`https://fal.storage/${composite.filename}`])
    // Charged: generator + edit + base; the Frame adds nothing.
    const expected = nodeCredits(prompt['1']!) + nodeCredits(prompt['5']!) + 1
    expect(run.charges.reduce((s, c) => s + (c.actual ?? 0), 0)).toBe(expected)
    // The composite is a 40×30 RGB PNG, half the generated picture on black.
    const meta = await sharp(join(k.root, 'temp', composite.subfolder, composite.filename)).metadata()
    expect([meta.width, meta.height, meta.channels]).toEqual([40, 30, 3])
  })

  it('a LoadImage whose file is gone is refused before anything runs or is held', async () => {
    const png = await sharp(asset('big.png')).png().toBuffer()
    const k = makeKit({ hosted: true, deps: { families: () => FRAME, download: async () => ({ bytes: new Uint8Array(png), contentType: 'image/png' }) } })
    const prompt: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: loadImage('sailor_local_3_1_1.png'),
      3: frame({ layer1: ['1', 0], layer2: ['2', 0], layer2_mask: ['2', 1] }),
      4: outCard('3'),
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START }))
      .rejects.toMatchObject({ statusCode: 400, message: 'A picture this Frame needs is missing. Run it again.' })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a Frame that fails to render charges nothing (the hold is released)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => FRAME } })
    writeFileSync(join(k.root, 'input', 'base.png'), Buffer.from('not a picture'))
    writeFileSync(join(k.root, 'input', 'sailor_local_3_1_1.png'), asset('overlay.png'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [frameFlow()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('error')
    expect(run.takes[0]!.nodes['3']!.error).toMatch(/could not be read/)
    expect(run.takes[0]!.nodes['4']!.status).toBe('skipped')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.state])).toEqual([[BASE_RENDER_CREDITS, 'released']])
    expect(run.charges[0]!.actual).toBe(0)
  })

  it('local mode holds and charges nothing', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => FRAME } })
    writeFileSync(join(k.root, 'input', 'base.png'), asset('wide.png'))
    writeFileSync(join(k.root, 'input', 'sailor_local_3_1_1.png'), asset('overlay.png'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [frameFlow()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes['3']!.outputs[0]!.subfolder).toBe('')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('Frame renders count against the queued-calls limit', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => FRAME } })
    const prompt: ApiPrompt = { 1: card('base.png') }
    for (let i = 0; i <= MAX_QUEUED_CALLS; i++) prompt[String(100 + i)] = frame({ layer1: ['1', 0] })
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toMatchObject({ statusCode: 429 })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('with frame off, the server refuses the Frame workflow (the browser runs it on ComfyUI)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => new Set<RunnerFamily>(['fal-edit']) } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [frameFlow()], ...START })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('server health: caps, sources, Stop', () => {
  const cl = (c: Record<string, unknown>) => JSON.stringify({ enabled: true, ...c })
  it('counts copies as the Python cloner stamps them', () => {
    expect(clonerCopies('')).toBe(1)
    expect(clonerCopies('{bad')).toBe(1)
    expect(clonerCopies(JSON.stringify({ enabled: false, countX: 50 }))).toBe(1)
    expect(clonerCopies(cl({ mode: 'linear', countX: 4, countY: 3 }))).toBe(12)
    expect(clonerCopies(cl({ mode: 'linear', countX: 4, countY: 3, mirrorX: true, mirrorY: true }))).toBe(35)
    expect(clonerCopies(cl({ mode: 'radial', count: 12 }))).toBe(12)
    expect(clonerCopies(cl({ mode: 'linear', countX: '3.5' }))).toBeNull()
    expect(clonerCopies(cl({ mode: 'linear', countX: -4 }))).toBe(1)
  })

  it(`more than ${MAX_FRAME_COPIES} copies across the layers goes to ComfyUI; exactly ${MAX_FRAME_COPIES} stays`, () => {
    // frameFlow wires two layers: 15 × 17 on layer 1 plus layer 2's one copy is 256.
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ countX: 15, countY: 17 }) }), FRAME)).toBe(true)
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ countX: 16, countY: 16 }) }), FRAME)).toBe(false)
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ countX: 15, countY: 17 }), layer2_cloner: cl({ countX: 2 }) }), FRAME)).toBe(false)
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ countX: 9, countY: 16, mirrorX: true }) }), FRAME)).toBe(false)
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ mode: 'radial', count: 300 }) }), FRAME)).toBe(false)
    expect(isRunnerEligible(frameFlow({ layer1_cloner: cl({ countX: 'many' }) }), FRAME)).toBe(false)
    // An unwired slot's cloner stamps nothing.
    expect(isRunnerEligible(frameFlow({ layer9_cloner: cl({ countX: 400 }) }), FRAME)).toBe(true)
  })

  it('an explicit artboard over 8192² goes to ComfyUI', () => {
    expect(isRunnerEligible(frameFlow({ width: 8192, height: 8192 }), FRAME)).toBe(true)
    expect(isRunnerEligible(frameFlow({ width: 8192, height: 8193 }), FRAME)).toBe(false)
    // The product cap on its own (the widgets' 8192 max would catch this shape first).
    const row = { ...RUNNER_NODE_RULES.Compositor!, widgets: {}, frameLimits: { maxCopies: 256, maxArtboardPixels: 100 } }
    expect(nodeRuleAllows('Compositor', row, { layer1: ['1', 0], width: 10, height: 10 }, FRAME)).toBe(true)
    expect(nodeRuleAllows('Compositor', row, { layer1: ['1', 0], width: 11, height: 10 }, FRAME)).toBe(false)
  })

  it('a canvas sized from a layer over 8192² fails plainly, without allocating it', async () => {
    const huge = { c: 3, h: 8193, w: 8193, data: new Float32Array(0) }
    await expect(composeFrame({}, { layers: [async () => huge, ...Array(15).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null }, inThreadBackend(), { protect: false }))
      .rejects.toThrow('This Frame is larger than 8192 × 8192, too large to render')
    expect(MAX_CANVAS_PIXELS).toBe(8192 * 8192)
  })

  it('a picture over 8192² is refused by the decoder, plainly', async () => {
    const png = await sharp({ create: { width: 8193, height: 8193, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer()
    await expect(decodePicture(new Uint8Array(png), 'provider')).rejects.toThrow('A picture for the Frame is larger than 8192 × 8192, too large to render')
  }, 30_000)

  it('only pictures go into a layer or the overlay: a Video card or a video generator sends the workflow to ComfyUI', () => {
    const video = { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'p', aspect_ratio: '16:9', duration: '8', seed: 0, model_options: '{}' } }
    const videoCard = { class_type: 'Video', inputs: { file: 'clip.mp4', export: false, filename_prefix: 'v' } }
    const gate = (from: string) => ({ class_type: 'ComfyGateNode', inputs: { data_in: [from, 0], bypass: false } })
    const refused: ApiPrompt[] = [
      { ...frameFlow(), 5: videoCard, 3: frame({ layer1: ['1', 0], layer2: ['5', 0] }) },
      { ...frameFlow(), 5: video, 3: frame({ layer1: ['5', 0] }) },
      { ...frameFlow(), 5: video, 6: gate('5'), 3: frame({ layer1: ['1', 0], overlay: ['6', 0] }) },
      { ...frameFlow(), 3: frame({ layer1: ['1', 1] }) },
    ]
    for (const p of refused) {
      expect(runnerTakesNode(p, '3', ALL)).toBe(false)
      expect(isRunnerEligible(p, ALL)).toBe(false)
    }
    // A picture through a Gate is fine.
    expect(isRunnerEligible({ ...frameFlow(), 6: gate('1'), 3: frame({ layer1: ['6', 0] }) }, ALL)).toBe(true)
  })

  it('the worker script is self-contained: the core source names no helper from outside it', () => {
    const src = compositorCore.toString()
    expect(src).not.toMatch(/\b__\w+\(|\brequire\(|\bimport\b/)
    // It builds and runs on its own, with nothing in scope.
    const fresh = new Function(`return (${src})()`)() as ReturnType<typeof compositorCore>
    expect(fresh.blendValue(0.25, 0.5, 'multiply')).toBe(Math.fround(0.125))
  })

  it('every runner image class is a picture source (drift guard); the video ones are not', () => {
    for (const c of PROVIDER_TYPES) expect(IMAGE_OUTPUT_CLASSES.has(c)).toBe(c !== 'GenerateVideoNode')
    expect(IMAGE_OUTPUT_CLASSES.has('Video')).toBe(false)
  })

  it('Stop: an aborted render stops between layers, and between copies on the worker', async () => {
    const pic = () => { const p = plane(3, 64, 64); p.data.fill(0.5); return p }
    const done = new AbortController()
    done.abort()
    await expect(renderFrameInWorker({}, { layers: [async () => pic(), ...Array(15).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null }, { signal: done.signal }))
      .rejects.toThrow('Stopped')
    // Stop pressed while the second layer is being read: nothing after it is painted.
    const ctl = new AbortController()
    const later: Array<(() => Promise<ReturnType<typeof pic>>) | null> = [async () => pic(), async () => { ctl.abort(); return pic() }, async () => { throw new Error('read after Stop') }]
    await expect(renderFrameInWorker({}, { layers: [...later, ...Array(13).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null }, { signal: ctl.signal }))
      .rejects.toThrow('Stopped')
    // Stop during a layer's copies: the worker's flag is read before each copy.
    const mid = new AbortController()
    const many = JSON.stringify({ enabled: true, countX: 200, spacingX: 0.001 })
    const run = renderFrameInWorker({ layer1_cloner: many }, { layers: [async () => { const p = plane(3, 512, 512); setTimeout(() => mid.abort(), 5); return p }, ...Array(15).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null }, { signal: mid.signal })
    await expect(run).rejects.toThrow('Stopped')
    // The worker is still usable afterwards.
    const ok = await renderFrameInWorker({}, { layers: [async () => pic(), ...Array(15).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null })
    expect([ok.h, ok.w, ok.px.length]).toEqual([64, 64, 64 * 64 * 3])
  }, 30_000)
})

describe('fix round 2: the worker does the pixels, work caps, watchdog', () => {
  const noLayers = (first: () => Promise<any>) => ({ layers: [first, ...Array(15).fill(null)], masks: Array(16).fill(null), overlay: null, overlayMask: null })
  const cl = (c: Record<string, unknown>) => JSON.stringify({ enabled: true, ...c })

  it(`work: copies × explicit canvas pixels ≤ ${MAX_FRAME_WORK} (256 × 4 MP), else ComfyUI`, () => {
    expect(MAX_FRAME_WORK).toBe(256 * 4 * 1024 * 1024)
    // 4096² with frameFlow's two layers: 63 + 1 copies is exactly the limit; 64 + 1 is over.
    expect(isRunnerEligible(frameFlow({ width: 4096, height: 4096, layer1_cloner: cl({ countX: 63 }) }), FRAME)).toBe(true)
    expect(isRunnerEligible(frameFlow({ width: 4096, height: 4096, layer1_cloner: cl({ countX: 64 }) }), FRAME)).toBe(false)
  })

  it('work, for a canvas sized from layer 1, fails plainly in the render before anything is painted', async () => {
    const big = { c: 3, h: 4096, w: 4096, data: new Float32Array(0) }
    let begun = false
    const backend = { ...inThreadBackend(), async begin() { begun = true } }
    await expect(composeFrame({ layer1_cloner: cl({ countX: 65 }) }, noLayers(async () => big), backend, { protect: false }))
      .rejects.toThrow('This Frame asks for too many copies at this size to render (at most 256 copies of 4 megapixels)')
    expect(begun).toBe(false)
  })

  it('hosted: the artboard cap is 4096² (eligibility, the server, and a layer-sized canvas)', async () => {
    expect(HOSTED_MAX_FRAME_ARTBOARD_PIXELS).toBe(4096 * 4096)
    const p = frameFlow({ width: 4097, height: 4096 })
    expect(isRunnerEligible(p, FRAME)).toBe(true)
    expect(isRunnerEligible(p, FRAME, { hosted: true })).toBe(false)
    expect(isRunnerEligible(frameFlow({ width: 4096, height: 4096 }), FRAME, { hosted: true })).toBe(true)
    const k = makeKit({ hosted: true, deps: { families: () => FRAME } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, data: { reason: 'not-eligible' } })
    const wide = { c: 3, h: 4096, w: 4097, data: new Float32Array(0) }
    await expect(composeFrame({}, noLayers(async () => wide), inThreadBackend(), { protect: false, maxCanvasPixels: HOSTED_MAX_FRAME_ARTBOARD_PIXELS }))
      .rejects.toThrow('This Frame is larger than 4096 × 4096, too large to render')
  })

  it('finish makes no protect plane unless asked', () => {
    const cv = core.createCanvas(8, 8)
    expect(core.finish(cv, false).protect).toBeNull()
    expect(core.finish(core.createCanvas(8, 8), true).protect!.data.length).toBe(64)
  })

  it('a render that fails in the worker lets its canvas go; the next render is fine', async () => {
    const broken = { raw: true as const, source: 'provider' as const, w: 4, h: 4, data: null }
    await expect(renderFrameInWorker({}, noLayers(async () => broken))).rejects.toThrow('A picture for the Frame is missing')
    const ok = await renderFrameInWorker({}, noLayers(async () => { const q = plane(3, 8, 8); q.data.fill(1); return q }))
    expect([...ok.px.slice(0, 3)]).toEqual([255, 255, 255])
  })

  it('the worker killed mid-render: that render fails plainly, the next gets a fresh worker', async () => {
    const heavy = renderFrameInWorker({ layer1_cloner: cl({ countX: 200, spacingX: 0.001 }) }, noLayers(async () => plane(3, 512, 512)))
    await new Promise(r => setTimeout(r, 30))
    const w = __frameWorkerForTests()!
    expect(w).not.toBeNull()
    await w.terminate()
    await expect(heavy).rejects.toThrow(/The Frame renderer stopped/)
    const ok = await renderFrameInWorker({}, noLayers(async () => plane(3, 8, 8)))
    expect([ok.w, ok.h]).toEqual([8, 8])
    expect(__frameWorkerForTests()).not.toBe(w)
  }, 30_000)

  it('the watchdog: a render past its time limit terminates the worker and fails plainly; the next render starts fresh', async () => {
    __setFrameTimeoutForTests(50)
    try {
      const before = (await renderFrameInWorker({}, noLayers(async () => plane(3, 8, 8))), __frameWorkerForTests())!
      const exited = new Promise<boolean>((res) => { before.once('exit', () => res(true)); setTimeout(() => res(false), 5000) })
      await expect(renderFrameInWorker({ layer1_cloner: cl({ countX: 200, spacingX: 0.001 }) }, noLayers(async () => plane(3, 512, 512))))
        .rejects.toThrow(FRAME_TIMEOUT_MESSAGE)
      // The stuck worker is terminated, not just abandoned.
      expect(await exited).toBe(true)
      __setFrameTimeoutForTests(null)
      const ok = await renderFrameInWorker({}, noLayers(async () => plane(3, 8, 8)))
      expect([ok.w, ok.h]).toEqual([8, 8])
      expect(__frameWorkerForTests()).not.toBe(before)
    }
    finally { __setFrameTimeoutForTests(null) }
  }, 30_000)

  it('the main thread hands raw RGBA8 over: the loaders the plan makes decode no pixel', async () => {
    const { decodeRaw, decodeRawMask } = await import('~~/server/runner/compositor/decode')
    const r = await decodeRaw(new Uint8Array(asset('disc.png')), 'card')
    expect(r).toMatchObject({ raw: true, source: 'card', w: 40, h: 40 })
    expect(r.data).toBeInstanceOf(Uint8Array)
    expect(r.data!.byteLength).toBe(40 * 40 * 4)
    expect(r.data!.buffer.byteLength).toBe(40 * 40 * 4) // its own buffer: transferable
    expect(await decodeRawMask(new Uint8Array(asset('land.png')))).toEqual({ raw: true, source: 'nomask', w: 64, h: 64, data: null })
  })
})

// ── The esbuild guard: plane.ts built the way Nitro builds server code ────

describe('esbuild guard: the worker core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const planeSrc = readFileSync(fileURLToPath(new URL('../../server/runner/compositor/plane.ts', import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'frame-esbuild-'))

  // One small composite in this thread, as the reference.
  const job = () => {
    const pic = { raw: true, source: 'card', w: 3, h: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0, 200, 100, 50, 255, 1, 2, 3, 4]) }
    const copies = [{ x: 0.1, y: 0, rot: 30, scl: 0.8, op: 0.9, tint: null, tintStrength: 1 }]
    return { pic, copies }
  }
  const reference = (() => {
    const { pic, copies } = job()
    const cv = core.createCanvas(5, 7)
    core.paint(cv, pic as any, null, 'screen', copies, false)
    return [...core.toPreview8(core.finish(cv, false).image)]
  })()

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text core runs, in a Worker too, pixel for pixel`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        let code = (await esb.transform(planeSrc, { loader: 'ts', target: 'es2019', format: 'esm' })).code
        if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
        const file = join(dir, `plane-${minify}.mjs`)
        writeFileSync(file, code)
        const mod = await import(`${pathToFileURL(file).href}?${Math.random()}`) as { compositorCore: () => ReturnType<typeof compositorCore> }
        expect(typeof mod.compositorCore).toBe('function')
        // Rebuilt from its own source text, with nothing in scope.
        const built = new Function(`return (${mod.compositorCore.toString()})()`)() as ReturnType<typeof compositorCore>
        const { pic, copies } = job()
        const cv = built.createCanvas(5, 7)
        built.paint(cv, pic as any, null, 'screen', copies, false)
        expect([...built.toPreview8(built.finish(cv, false).image)]).toEqual(reference)
        // And as the worker's own script.
        const w = new Worker(workerScript(mod.compositorCore), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const j = job()
          expect((await reply({ id: 1, op: 'begin', ch: 5, cw: 7 })).error).toBeUndefined()
          expect((await reply({ id: 2, op: 'paint', image: j.pic, mask: null, blend: 'screen', copies: j.copies, protect: false })).error).toBeUndefined()
          const done = await reply({ id: 3, op: 'finish' })
          expect([...done.value.px]).toEqual(reference)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})
