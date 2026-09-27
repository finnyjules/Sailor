/**
 * Live previews through the runner (step 3, R2.11): /api/runs/preview works
 * the target effect and the local chain behind it out on the files the canvas
 * shows, with the same derive plans a full run uses, and answers the target's
 * ui. No hold, no record, no ledger entry, no run event; nothing on disk but
 * the target's live_preview_<id>.png; what the nodes made is let go when it
 * answers (done, failed or stopped).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import sharp from 'sharp'
import { createApp, eventHandler, toWebHandler } from 'h3'
import type { ApiPrompt } from '#shared/runner/graph'
import { parseFamilies, type RunnerFamily } from '#shared/runner/families'
import { EFFECT_PICTURE_TOO_LARGE_HOSTED } from '#shared/runner/effects'
import { PREVIEW_NEEDS_FULL_RUN, PREVIEW_SUPERSEDED } from '#shared/runner/livePreview'
import { __setPreviewDepsForTests, PREVIEW_NOT_YOURS, PREVIEW_PICTURE_GONE, PREVIEW_TOO_MANY, previewsInFlight, runPreview, type PreviewDeps } from '~~/server/runner/preview'
import { userSubfolder } from '~~/server/runner/results'
import route from '~~/server/api/runs/preview.post'
import { makeKit, ofType, until } from './__runner__/kit'
import { synth } from './__runner__/effectsParity'

const FAM = parseFamilies('cards,effects-tone,effects-blur,effects-noise,live-previews')
const card = (image = 'fox.png') => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const blur = (from: [string, number], radius = 2) => ({ class_type: 'Blur', inputs: { image: from, type: 'gaussian', radius, angle: 0, length: 0, strength: 1 } })
const curves = (from: [string, number], midtones = 1.3) => ({ class_type: 'AdjustCurves', inputs: { image: from, blacks: 0.05, midtones, whites: 0.9 } })
const noise = (from: [string, number]) => ({ class_type: 'AddNoise', inputs: { image: from, amount: 0.3, type: 'gaussian', monochromatic: false } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const input = (filename: string) => ({ filename, subfolder: '', type: 'input' as const })

/** An opaque RGB PNG. */
async function png(w: number, h: number, seed: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(Buffer.from(synth(w, h, 3, seed)), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer())
}

/** Every file under a folder, relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

function kitFor(o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily> } = {}) {
  const families = o.families ?? FAM
  const kit = makeKit({ hosted: o.hosted, deps: { families: () => families } })
  const owned = new Set<string>()
  const deps: PreviewDeps = {
    runnerOn: () => true,
    families: () => families,
    hosted: () => !!o.hosted,
    results: kit.deps.results,
    ownership: {
      ownsInput: async (_u, f) => owned.has(`input:${f.filename}`),
      ownsOutput: async (_u, f) => owned.has(`output:${f.filename}`),
    },
  }
  const put = (type: 'input' | 'output' | 'temp', name: string, bytes: Uint8Array) => {
    const p = join(kit.root, type, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, bytes)
  }
  return { kit, deps, owned, put }
}

const chain = (): ApiPrompt => ({ 1: card(), 2: blur(['1', 0]), 3: curves(['2', 0]) })

afterEach(() => { __setPreviewDepsForTests(null); delete process.env.NUXT_RUNNER_ENABLED })

describe('runPreview', () => {
  it('Image card → Blur → Adjust curves: answers Adjust curves’ ui, with the pixels a full run writes, and nothing else', async () => {
    const fox = await png(37, 23, 7)
    const { kit, deps, put } = kitFor()
    put('input', 'fox.png', fox)
    const rootBefore = filesUnder(kit.root)
    const runsBefore = filesUnder(kit.dir)

    const res = await runPreview({ userId: null, body: { canvasId: 'c1', nodeId: '3', prompt: chain(), pinned: { 1: [input('fox.png')] } } }, deps)
    expect(res.ui).toEqual({ images: [{ filename: 'live_preview_3.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })

    // Only the target's preview is written (not Blur's), and nothing is left in the run store.
    expect(filesUnder(kit.root)).toEqual([...rootBefore, 'temp/sailor_runner/live_preview_3.png'].sort())
    expect(filesUnder(kit.dir)).toEqual(runsBefore)
    // Free: no hold, no ledger entry, no record, no run event.
    expect(kit.ledger.hold).not.toHaveBeenCalled()
    expect(kit.ledger.settle).not.toHaveBeenCalled()
    expect(kit.graphRuns.create).not.toHaveBeenCalled()
    expect(kit.records.write).not.toHaveBeenCalled()
    expect(kit.seen).toEqual([])
    expect(previewsInFlight()).toEqual({ requests: 0, bytes: 0 })

    // The full run of the same workflow writes the same file, byte for byte.
    const full = kitFor()
    full.put('input', 'fox.png', fox)
    await full.kit.engine.startRun({ userId: null, takes: [chain()], workflow: null, canvasId: 'c1', projectUuid: null, projectName: null })
    await until(() => ofType(full.kit.seen, 'execution_success').length > 0 || ofType(full.kit.seen, 'execution_error').length > 0, 60_000)
    expect(ofType(full.kit.seen, 'execution_error')).toEqual([])
    const fromRun = readFileSync(join(full.kit.root, 'temp/sailor_runner/live_preview_3.png'))
    const fromPreview = readFileSync(join(kit.root, 'temp/sailor_runner/live_preview_3.png'))
    expect(Buffer.compare(fromPreview, fromRun)).toBe(0)
  })

  it('Add noise draws the same noise as a full run (the seed is the node id and what it reads)', async () => {
    const fox = await png(29, 31, 3)
    const prompt: ApiPrompt = { 1: card(), 4: noise(['1', 0]) }
    const a = kitFor()
    a.put('input', 'fox.png', fox)
    await runPreview({ userId: null, body: { canvasId: 'c1', nodeId: '4', prompt, pinned: { 1: [input('fox.png')] } } }, a.deps)
    const b = kitFor()
    b.put('input', 'fox.png', fox)
    await b.kit.engine.startRun({ userId: null, takes: [prompt], workflow: null, canvasId: 'c1', projectUuid: null, projectName: null })
    await until(() => ofType(b.kit.seen, 'execution_success').length > 0, 60_000)
    const p = readFileSync(join(a.kit.root, 'temp/sailor_runner/live_preview_4.png'))
    expect(Buffer.compare(p, readFileSync(join(b.kit.root, 'temp/sailor_runner/live_preview_4.png')))).toBe(0)
  })

  it('Generate an image → Blur works on the provider’s pinned output file', async () => {
    const { kit, deps, put } = kitFor()
    put('output', 'generate_image_00001_.png', await png(19, 17, 5))
    const res = await runPreview({ userId: null, body: { canvasId: 'c1', nodeId: '2', prompt: { 7: generate(), 2: blur(['7', 0]) }, pinned: { 7: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }] } } }, deps)
    expect(res.ui).toEqual({ images: [{ filename: 'live_preview_2.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })
    expect(kit.fal.submitted()).toEqual([])
  })

  it('a provider node that isn’t pinned needs a full run (409); so does a Shader effect or live-previews off', async () => {
    const { deps, put } = kitFor()
    put('input', 'fox.png', await png(8, 8, 1))
    await expect(runPreview({ userId: null, body: { nodeId: '2', prompt: { 7: generate(), 2: blur(['7', 0]) }, pinned: {} } }, deps))
      .rejects.toMatchObject({ statusCode: 409, message: PREVIEW_NEEDS_FULL_RUN })
    const shaderFam = parseFamilies('cards,effects-blur,shader-bake,live-previews')
    const shader = kitFor({ families: shaderFam })
    await expect(runPreview({ userId: null, body: { nodeId: '2', prompt: { 1: card(), 5: { class_type: 'ShaderEffect', inputs: { image: ['1', 0] } }, 2: blur(['5', 0]) }, pinned: { 1: [input('fox.png')] } } }, shader.deps))
      .rejects.toMatchObject({ statusCode: 409 })
    const off = kitFor({ families: parseFamilies('cards,effects-tone,effects-blur') })
    await expect(runPreview({ userId: null, body: { nodeId: '3', prompt: chain(), pinned: { 1: [input('fox.png')] } } }, off.deps))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('refuses a request it can’t read, and a pinned kept file, with 400', async () => {
    const { deps } = kitFor()
    for (const body of [null, { nodeId: '3' }, { nodeId: '9', prompt: chain(), pinned: {} }, { nodeId: '3', prompt: chain(), pinned: { 1: [{ filename: 'a.bin', subfolder: 'run_x', type: 'kept' }] } }, { nodeId: '3', prompt: chain(), pinned: { 1: [input('../x.png')] } }]) {
      await expect(runPreview({ userId: null, body }, deps)).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(runPreview({ userId: null, body: { nodeId: '3', prompt: chain(), pinned: { 1: [input('gone.png')] } } }, deps))
      .rejects.toMatchObject({ statusCode: 400, message: PREVIEW_PICTURE_GONE })
  })

  it('hosted: a pinned file of another user is refused (403); a temp preview of the user’s own is read (200)', async () => {
    const { deps, put, owned } = kitFor({ hosted: true })
    const bytes = await png(16, 12, 9)
    put('input', 'theirs.png', bytes)
    put('input', 'mine.png', bytes)
    owned.add('input:mine.png')
    const own = userSubfolder('user_1', true)
    put('temp', `${own}/live_preview_2.png`, bytes)
    put('temp', 'u_someoneelse/live_preview_2.png', bytes)
    const body = (pin: unknown) => ({ canvasId: 'c1', nodeId: '3', prompt: chain(), pinned: { 1: [pin] } })
    await expect(runPreview({ userId: 'user_1', body: body(input('theirs.png')) }, deps)).rejects.toMatchObject({ statusCode: 403 })
    await expect(runPreview({ userId: 'user_1', body: body({ filename: 'live_preview_2.png', subfolder: 'u_someoneelse', type: 'temp' }) }, deps))
      .rejects.toMatchObject({ statusCode: 403, message: PREVIEW_NOT_YOURS })
    await expect(runPreview({ userId: null, body: body(input('mine.png')) }, deps)).rejects.toMatchObject({ statusCode: 401 })
    const res = await runPreview({ userId: 'user_1', body: body({ filename: 'live_preview_2.png', subfolder: own, type: 'temp' }) }, deps)
    expect(res.ui).toEqual({ images: [{ filename: 'live_preview_3.png', subfolder: own, type: 'temp' }], animated: [false] })
    expect((await runPreview({ userId: 'user_1', body: body(input('mine.png')) }, deps)).ui).toBeTruthy()
  })

  it('hosted: the effect caps apply as on a full run (a picture over 4096² is refused, 413) and nothing is kept', async () => {
    const { deps, put, owned } = kitFor({ hosted: true })
    const big = new Uint8Array(await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#336699' } }).png({ compressionLevel: 1 }).toBuffer())
    put('input', 'big.png', big)
    owned.add('input:big.png')
    await expect(runPreview({ userId: 'user_1', body: { canvasId: 'c1', nodeId: '3', prompt: chain(), pinned: { 1: [input('big.png')] } } }, deps))
      .rejects.toMatchObject({ statusCode: 413, message: EFFECT_PICTURE_TOO_LARGE_HOSTED, data: { nodeId: '2', classType: 'Blur' } })
    expect(previewsInFlight()).toEqual({ requests: 0, bytes: 0 })
  })

  it('two requests for one node: the first is stopped (409), the second answers; nothing is left held', async () => {
    const { kit, deps, put } = kitFor()
    put('input', 'fox.png', await png(96, 64, 2))
    const body = (midtones: number) => ({ canvasId: 'c1', nodeId: '3', prompt: { ...chain(), 3: curves(['2', 0], midtones) }, pinned: { 1: [input('fox.png')] } })
    const first = runPreview({ userId: null, body: body(1.1) }, deps)
    const second = runPreview({ userId: null, body: body(1.6) }, deps)
    await expect(first).rejects.toMatchObject({ statusCode: 409, message: PREVIEW_SUPERSEDED, data: { reason: 'superseded' } })
    expect((await second).ui).toEqual({ images: [{ filename: 'live_preview_3.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })
    expect(previewsInFlight()).toEqual({ requests: 0, bytes: 0 })
    // The file on disk is the second one's.
    const again = kitFor()
    again.put('input', 'fox.png', readFileSync(join(kit.root, 'input/fox.png')))
    await runPreview({ userId: null, body: body(1.6) }, again.deps)
    expect(Buffer.compare(readFileSync(join(kit.root, 'temp/sailor_runner/live_preview_3.png')), readFileSync(join(again.kit.root, 'temp/sailor_runner/live_preview_3.png')))).toBe(0)
  })

  it('at most two previews in flight per user; the browser going away stops one and lets go of it', async () => {
    const { deps, put } = kitFor()
    put('input', 'fox.png', await png(64, 48, 4))
    // The same node id on three canvases: three nodes.
    const body = (canvasId: string) => ({ canvasId, nodeId: '3', prompt: chain(), pinned: { 1: [input('fox.png')] } })
    const gone = new AbortController()
    const a = runPreview({ userId: 'u', body: body('c1'), signal: gone.signal }, deps)
    const b = runPreview({ userId: 'u', body: body('c2') }, deps)
    const c = runPreview({ userId: 'u', body: body('c3') }, deps)
    await expect(c).rejects.toMatchObject({ statusCode: 429, message: PREVIEW_TOO_MANY })
    gone.abort()
    await expect(a).rejects.toMatchObject({ statusCode: 409, data: { reason: 'stopped' } })
    expect((await b).ui).toBeTruthy()
    expect(previewsInFlight()).toEqual({ requests: 0, bytes: 0 })
  })
})

describe('POST /api/runs/preview', () => {
  const handler = () => {
    const app = createApp()
    app.use(eventHandler(() => {}))
    app.use(route)
    return toWebHandler(app)
  }
  const post = (body: string) => handler()(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))

  it('is hidden while the runner is off, refuses a body over 2 MB (413) and one that isn’t JSON (400), and answers the ui', async () => {
    expect((await post('{}')).status).toBe(404)
    process.env.NUXT_RUNNER_ENABLED = 'true'
    const { deps, put } = kitFor()
    __setPreviewDepsForTests(deps)
    put('input', 'fox.png', await png(12, 9, 6))
    expect((await post('x'.repeat(2 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await post('{nope')).status).toBe(400)
    const refused = await post(JSON.stringify({ nodeId: '2', prompt: { 7: generate(), 2: blur(['7', 0]) }, pinned: {} }))
    expect(refused.status).toBe(409)
    const res = await post(JSON.stringify({ canvasId: 'c1', nodeId: '3', prompt: chain(), pinned: { 1: [input('fox.png')] } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ui: { images: [{ filename: 'live_preview_3.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] } })
  })
})
