/**
 * R3.6: layers from one call, and outpaint (family `layers`) — Separate text
 * from image (Ideogram Layerize), Layerize an image (fal Seedream 5 Pro
 * Layerize) and Expand / outpaint (Flux Fill Pro, Bria Expand) — against
 * what their real Python sends and returns (fixtures/runner-paid-layers.json,
 * scripts/runner_paid_fixtures.py --group layers), priced on both paths from
 * the providers' pages.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { LAYERS_CLASSES, OUTPAINT_ASPECT_RATIOS, OUTPAINT_DIRECTIONS, OUTPAINT_SLUGS, SEEDREAM_IMAGE_SIZES, SEEDREAM_MAX_IMAGES, type LayersClass } from '#shared/runner/layers'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { PAID_NODE_CLASSES, paidNoCall, seedreamCallAnswered } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { callCredits } from '#shared/pricing/pipelinePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { parsePyJson } from '#shared/runner/pyJson'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { outputKey, savedInputKey } from '~~/server/utils/graphRuns'
import { shortUserHash } from '~~/server/utils/meterGraphRun'
import { PAID_TEXT_INPUTS, extraPromptTexts } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineIO } from '~~/server/runner/executors'
import { assertFilesOwned, collectInputFiles, savedInputOwned, type OwnershipCheck } from '~~/server/runner/inputs'
import { answerTimeout } from '~~/server/runner/answerDownload'
import {
  LAYERIZE_NO_OUTPUT, LAYERIZE_NO_PICTURE, SEEDREAM_ANSWER_UNREADABLE, SEEDREAM_TOO_MANY_LAYERS, layerDataError, layerDataText, layerDataWhy, layerizeUrls, parseSeedreamLayers,
  seedreamAnsweredUsd, seedreamImagesMade,
} from '~~/server/runner/generators/layers'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-layers.json'), 'utf8')) as { cases: PaidCase[] }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'layers'])
const SEEDREAM = 'bytedance/seedream/v5/pro/layerize'

type Raw = { __body__: string }
const isRaw = (a: unknown): a is Raw => !!a && typeof a === 'object' && typeof (a as Raw).__body__ === 'string'
/** A case's answer as the fake providers serve it: the body text, and what JSON.parse reads of it. */
const answerOf = (c: PaidCase): { result: unknown; raw: string } => {
  const a = c.answers[0]
  const raw = isRaw(a) ? a.__body__ : JSON.stringify(a)
  return { result: JSON.parse(raw), raw }
}
const caseNamed = (name: string) => CASES.find(c => c.name === name)!

/** A LoadImage feeding the node's picture, as the kit's cases do. */
function withPicture(c: PaidCase): ApiPrompt {
  return {
    p_image: { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } },
    n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['p_image', 0] } },
  }
}

async function planOf(c: PaidCase): Promise<NodePlan> {
  return planNode({
    prompt: withPicture(c), nodeId: 'n', gateOpen: false,
    filesFrom: link => (link[0] === 'p_image' ? [{ filename: 'image.png', subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
}

/** Python's `IMG:image` is the handed-off picture. */
const asPython = (payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], ['image'])[0]!.payload

/**
 * A pipeline run by hand on a case: its one call answered with the case's
 * answer, its downloads served from the case, its saves written down.
 */
async function runPipeline(c: PaidCase, plan: Extract<NodePlan, { kind: 'pipeline' }>) {
  const calls: Parameters<PipelineIO['call']>[0][] = []
  const downloads: { url: string; kind?: string; optional?: boolean }[] = []
  const saves: { prefix: string; ext: string; folder: string; bytes: Uint8Array }[] = []
  let n = 0
  const io = {
    signal: new AbortController().signal,
    call: async (x: Parameters<PipelineIO['call']>[0]) => {
      calls.push(x)
      const { result, raw } = answerOf(c)
      return { result, raw, urls: [] }
    },
    download: async (url: string, o?: { kind?: string; optional?: true }) => {
      downloads.push({ url, ...(o?.kind ? { kind: o.kind } : {}), ...(o?.optional ? { optional: true } : {}) })
      const link = c.links?.[url]
      if (link !== undefined) {
        if (typeof link === 'object' && 'raise' in link) throw new Error('Could not download the result (it broke off)')
        if (typeof link === 'object') throw new Error(`Could not download the result (${link.status})`)
        return { bytes: new TextEncoder().encode(link), contentType: 'application/json' }
      }
      if (c.files?.[url]) return { bytes: new Uint8Array(Buffer.from(c.files[url]!, 'base64')), contentType: 'image/png' }
      throw new Error(`GET ${url} is not served`)
    },
    saveAsset: async (bytes: Uint8Array, o: { prefix: string; ext: string; folder?: string }) => {
      saves.push({ prefix: o.prefix, ext: o.ext, folder: o.folder ?? 'output', bytes })
      const count = saves.filter(s => s.prefix === o.prefix).length
      return { filename: `${o.prefix}_${String(count + n * 0).padStart(5, '0')}_.${o.ext}`, subfolder: '', type: (o.folder ?? 'output') as OutputFile['type'] }
    },
    read: async () => new Uint8Array(Buffer.from(c.picture_files!.image!, 'base64')),
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
  } as unknown as PipelineIO
  n++
  const made = await plan.run(io)
  return { made, calls, downloads, saves }
}

async function rgbaOf(bytes: Uint8Array): Promise<Buffer> {
  return (await sharp(bytes).ensureAlpha().raw().toBuffer())
}

/** A PNG of w × h (one colour). */
async function png(w: number, h: number, channels: 3 | 4 = 3): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels, background: channels === 4 ? { r: 10, g: 20, b: 30, alpha: 0.5 } : { r: 10, g: 20, b: 30 } } }).png().toBuffer()
}

// ── The published inputs (each page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const uri = { type: 'string', format: 'uri' }
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  'ideogram-ai/layerize': publishedInput({
    seed: { type: 'integer', maximum: 2147483647 }, prompt: { type: 'string' }, font_name_h1: { type: 'string' }, font_name_h2: { type: 'string' },
    font_name_body: { type: 'string' }, font_name_small: { type: 'string' }, flat_graphic_image: uri,
  }, ['flat_graphic_image']),
  'black-forest-labs/flux-fill-pro': publishedInput({
    mask: uri, seed: { type: 'integer' }, image: uri, steps: { type: 'integer', default: 50, maximum: 50, minimum: 15 }, prompt: { type: 'string' },
    guidance: { type: 'number', default: 60, maximum: 100, minimum: 1.5 },
    outpaint: { enum: ['None', ...OUTPAINT_DIRECTIONS], type: 'string', default: 'None' },
    output_format: { enum: ['jpg', 'png'], type: 'string', default: 'jpg' },
    safety_tolerance: { type: 'integer', default: 2, maximum: 6, minimum: 1 }, prompt_upsampling: { type: 'boolean', default: false },
  }, ['prompt', 'image']),
  'bria/expand-image': publishedInput({
    seed: { type: 'integer' }, sync: { type: 'boolean', default: true }, image: uri, prompt: { type: 'string' }, image_url: { type: 'string' },
    canvas_size: { type: 'array' }, aspect_ratio: { enum: ['none', ...OUTPAINT_ASPECT_RATIOS], type: 'string', default: '1:1' },
    preserve_alpha: { type: 'boolean', default: true }, negative_prompt: { type: 'string' }, content_moderation: { type: 'boolean', default: false },
    original_image_size: { type: 'array' }, original_image_location: { type: 'array' },
  }, []),
  [SEEDREAM]: publishedInput({
    sync_mode: { type: 'boolean', default: false }, enhance_prompt_mode: { enum: ['standard', 'fast'], type: 'string', default: 'standard' },
    image_url: { type: 'string' }, image_size: { enum: [...SEEDREAM_IMAGE_SIZES], type: 'string', default: 'auto' },
    enable_safety_checker: { type: 'boolean', default: true }, prompt: { type: 'string', default: '' },
  }, ['image_url']),
}

/** Python's picture output: the URL it came from, the input (`IMG:image`), or an alpha-dropped tensor's sha256. */
type PyPicture = { image: string } | { tensor: { shape: number[]; sha256: string } }

describe('the fixture', () => {
  it('covers every class, image size, direction, ratio and answer shape the brief names', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(LAYERS_CLASSES))
    for (const p of ['blank', 'spaced']) expect(names.has(`layerize · prompt ${p}`), p).toBe(true)
    for (const s of [0, 1, 2 ** 31 - 1]) expect(names.has(`layerize · seed ${s}`), String(s)).toBe(true)
    for (const a of ['picture first', 'JSON first', 'no extension', 'no JSON link', 'JSON link fails']) expect(names.has(`layerize · answer · ${a}`), a).toBe(true)
    for (const s of [...SEEDREAM_IMAGE_SIZES, '8K']) expect(names.has(`seedream · image_size ${s}`), s).toBe(true)
    for (const a of ['17 layers', 'a layer without bounding_box', 'a non-dict layer', 'no images (the input is the preview)']) expect(names.has(`seedream · ${a}`), a).toBe(true)
    for (const d of OUTPAINT_DIRECTIONS) expect(names.has(`outpaint · Flux Fill ${d}`), d).toBe(true)
    for (const r of OUTPAINT_ASPECT_RATIOS) expect(names.has(`outpaint · Bria Expand ${r}`), r).toBe(true)
    for (const m of ['Flux Fill', 'Bria Expand']) for (const s of [0, 42]) expect(names.has(`outpaint · ${m} seed ${s}`)).toBe(true)
    expect(names.has('outpaint · Flux Fill RGBA answer')).toBe(true)
    expect(CASES.every(c => c.calls.length === 1)).toBe(true)
    expect(new Set(CASES.map(c => c.calls[0]!.endpoint))).toEqual(new Set(['ideogram-ai/layerize', SEEDREAM, ...Object.values(OUTPAINT_SLUGS)]))
    expect(CASES.length).toBeGreaterThanOrEqual(55)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const offSchema: string[] = []
  const deviations: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c)
    const py = c.calls[0]!
    if (c.class_type === 'OutpaintImageNode') {
      if (plan.kind !== 'provider') throw new Error('Outpaint is one call')
      expect({ provider: plan.provider, endpoint: plan.endpoint, payload: asPython(plan.payload) }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
      expect(wireText(asPython(plan.payload))).toBe(py.payload_json)
      const errs = checkPayload(PUBLISHED[plan.endpoint]!, plan.payload)
      if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
      expect(plan.media).toBe('image')
      expect(plan.take).toBe('first')
      expect(plan.rgb).toBe(true)
      expect(plan.backup).toBeUndefined()
      expect(plan.urlsOf!(c.answers[0])).toEqual(['https://r.test/outpaint.png'])
      expect(c.ui).toBeNull()
      expect(plan.uiFor([])).toBeNull()
      return
    }
    if (plan.kind !== 'pipeline') throw new Error('A layerizer is a pipeline')
    if (c.error) {
      // Python's raise after its call, in the runner's plain words.
      const want = c.error.message === 'Layerize returned no output.' ? LAYERIZE_NO_OUTPUT : LAYERIZE_NO_PICTURE
      await expect(runPipeline(c, plan)).rejects.toThrow(want)
      return
    }
    if (c.name === 'seedream · a name that is a list') {
      // Fix round 1 (R3.4's ruling): Python prints the list's repr; the runner fails plainly, in Seedream's words.
      deviations.push(c.name)
      await expect(runPipeline(c, plan)).rejects.toThrow(SEEDREAM_ANSWER_UNREADABLE)
      return
    }
    const { made, calls, downloads, saves } = await runPipeline(c, plan)
    expect(calls.length).toBe(1)
    expect({ provider: calls[0]!.provider, endpoint: calls[0]!.endpoint, payload: asPython(calls[0]!.payload) }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    expect(wireText(asPython(calls[0]!.payload))).toBe(py.payload_json)
    const errs = checkPayload(PUBLISHED[calls[0]!.endpoint]!, calls[0]!.payload)
    if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
    expect(calls[0]!.backup).toBeUndefined()
    // The downloads are Python's GETs, in order.
    expect(downloads.map(d => d.url)).toEqual((c.gets ?? []).map(g => g.url))
    const [pic, pyJson] = c.output as [PyPicture, string]
    const json = (made.values[1] as Extract<RunnerValue, { kind: 'json' }>).text
    if (c.name === 'layerize · answer · JSON link fails' || c.name === 'layerize · answer · JSON link 404') {
      // The documented difference: the runner's own words for why (Python prints aiohttp's; a 404's body Python keeps).
      deviations.push(c.name)
      expect(json).toBe(layerDataError(c.name.endsWith('404') ? 'could not download the result (404)' : 'could not download the result (it broke off)'))
      expect(JSON.parse(json).error).toMatch(/^failed to fetch layer data: /)
    }
    else {
      expect(json).toBe(pyJson)
    }
    // Slot 0: the picture Python chose (the URL it downloaded, or the input).
    const files = (made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files
    expect(files.length).toBe(1)
    const shownPrefix = c.class_type === 'LayerizeGraphicNode' ? 'layerize' : 'seedream_layerize'
    const previewSave = saves.find(s => s.prefix === shownPrefix)!
    if ('image' in pic && pic.image === 'IMG:image') {
      expect(Buffer.compare(Buffer.from(previewSave.bytes), Buffer.from(c.picture_files!.image!, 'base64'))).toBe(0)
    }
    else if ('image' in pic) {
      expect(Buffer.compare(Buffer.from(previewSave.bytes), Buffer.from(c.files![pic.image]!, 'base64'))).toBe(0)
    }
    // The ui: its picture, and the JSON as text when Python shows it.
    const ui = c.ui as { images: unknown[]; text?: string[] }
    expect(made.ui).toEqual({ images: files, animated: [false], ...(ui.text ? { text: [json] } : {}) })
    expect(!!ui.text).toBe(!!(made.ui as { text?: unknown }).text)
    if (c.class_type === 'SeedreamLayerizeNode') {
      // Each layer as Python saves it: an RGBA PNG in the input folder, the decoded pixels exactly, in order.
      const layers = saves.filter(s => s.prefix === 'seedream_layer')
      expect(layers.every(s => s.folder === 'input' && s.ext === 'png')).toBe(true)
      const named = (JSON.parse(pyJson) as { layers: { filename: string }[] }).layers
      expect(layers.length).toBe(named.length)
      // Python's own pixels (fix round 1): the sha256 of what save_image_to_input wrote, recorded by the fixture.
      const pySaved = (c as PaidCase & { saved_inputs: { file: string; shape: number[]; sha256: string }[] }).saved_inputs
      expect((pySaved ?? []).map(x => x.file)).toEqual(named.map(l => l.filename))
      for (const [i, s] of layers.entries()) {
        const { data, info } = await sharp(s.bytes).raw().toBuffer({ resolveWithObject: true })
        expect(info.channels).toBe(4)
        expect([info.height, info.width, 4]).toEqual(pySaved[i]!.shape)
        expect(createHash('sha256').update(data).digest('hex'), `layer ${i}`).toBe(pySaved[i]!.sha256)
      }
    }
  })

  it('every payload fits its published schema', () => {
    expect(offSchema).toEqual([])
  })

  it('the only differences are the runner\'s own words for a layer JSON that couldn\'t be fetched', () => {
    expect(deviations.sort()).toEqual(['layerize · answer · JSON link 404', 'layerize · answer · JSON link fails', 'seedream · a name that is a list'])
  })
})

describe('every fixture case through the engine (cards and layers on)', () => {
  // (An image_size the node doesn't offer never reaches the runner: ComfyUI's validation refuses it, below.)
  const calling = CASES.filter(c => !c.error && c.name !== 'seedream · image_size 8K' && c.name !== 'seedream · a name that is a list')

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, kept and priced', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    expect(normalizeSent(run.sent, ['image'])).toEqual([{ provider: c.calls[0]!.provider, endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(normalizeSent(run.sent, ['image'])[0]!.payload)).toBe(c.calls[0]!.payload_json)
    const price = priceNode(c.class_type, { ...c.widgets, image: ['p_image', 0] })
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
    if (c.class_type === 'OutpaintImageNode') {
      // Alpha dropped: the kept PNG is Python's RGB tensor, byte for byte.
      expect(run.values).toBeUndefined()
      expect(run.files.length).toBe(1)
      return
    }
    const json = (run.values![1] as Extract<RunnerValue, { kind: 'json' }>).text
    if (!/JSON link (fails|404)/.test(c.name)) expect(json).toBe((c.output as [unknown, string])[1])
    expect(run.values![0]!.kind).toBe('files')
  })

  it('Outpaint with an RGBA answer keeps Python\'s RGB picture (sha256 of its 8-bit bytes)', async () => {
    // Fix round 1: a CMYK JPEG and a 16-bit greyscale PNG, which PIL reads its own way.
    for (const name of ['outpaint · Flux Fill RGBA answer', 'outpaint · Bria Expand RGBA answer', 'outpaint · Flux Fill Zoom out 2x', 'outpaint · Flux Fill CMYK JPEG answer', 'outpaint · Bria Expand 16-bit grey answer']) {
      const c = caseNamed(name)
      const k = makeKit({
        replicate: createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', ...(c.answers[0] as object) }) }),
        deps: { families: () => ON, download: async (url: string) => ({ bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' }) },
      })
      writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(c)], ...START })
      await k.engine.settled(runId)
      const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(rec.outputs[0]!.filename).toMatch(/^outpaint_\d{5}_\.png$/)
      const kept = readFileSync(join(k.root, 'output', rec.outputs[0]!.subfolder, rec.outputs[0]!.filename))
      const { data, info } = await sharp(kept).raw().toBuffer({ resolveWithObject: true })
      expect(info.channels).toBe(3)
      const want = (c.output as [{ tensor: { shape: number[]; sha256: string } }])[0].tensor
      expect([1, info.height, info.width, 3]).toEqual(want.shape)
      expect(createHash('sha256').update(data).digest('hex'), name).toBe(want.sha256)
      // Python returns no ui: nothing shown.
      expect(ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')).toBeUndefined()
    }
  })
})

describe('what comes back', () => {
  it('Layerize picks the picture by extension, else the first that isn\'t the JSON', () => {
    const j = 'https://r.test/l.json'
    expect(layerizeUrls({ output: ['https://r.test/b.png', j] })).toEqual({ urls: ['https://r.test/b.png', j], image: 'https://r.test/b.png', json: j })
    expect(layerizeUrls({ output: [j, 'https://r.test/B.JPEG?x=1.json'] }).image).toBe('https://r.test/B.JPEG?x=1.json')
    expect(layerizeUrls({ output: [j, 'https://r.test/bg'] }).image).toBe('https://r.test/bg')
    expect(layerizeUrls({ output: [j] })).toEqual({ urls: [j], image: null, json: j })
    expect(layerizeUrls({ output: [3, null, 'https://r.test/b.webp'] }).urls).toEqual(['https://r.test/b.webp'])
    expect(layerizeUrls({ output: null }).urls).toEqual([])
  })

  it('the layer JSON is read as aiohttp reads it: UTF-8 strictly, a BOM kept; ASCII; anything else a failed fetch', () => {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('{"a": 1}')])
    expect(layerDataText(bom, 'application/json')).toBe('﻿{"a": 1}')
    expect(layerDataText(new TextEncoder().encode('café'), null)).toBe('café')
    expect(layerDataText(new TextEncoder().encode('{}'), 'application/json; charset=US-ASCII')).toBe('{}')
    expect(() => layerDataText(new Uint8Array([0xff, 0xfe]), 'application/json')).toThrow('UTF-8')
    expect(() => layerDataText(new TextEncoder().encode('x'), 'text/plain; charset=shift_jis')).toThrow('character set')
    // The runner's words for why, never a library's.
    expect(layerDataWhy(new Error('Could not download the result (503)'))).toBe('could not download the result (503)')
    expect(layerDataWhy(new Error(answerTimeout('json')))).toBe('the data the service made took longer than 30 seconds to download')
    expect(layerDataWhy(new TypeError('fetch failed: ECONNRESET 10.0.0.1'))).toBe('the connection failed')
    expect(layerDataError('the connection failed')).toBe('{"error": "failed to fetch layer data: the connection failed"}')
  })

  it('Seedream\'s answer as parse_seedream_layers reads it; malformed answers fail plainly', () => {
    const odd = parseSeedreamLayers(parsePyJson(answerOf(caseNamed('seedream · odd numbers and names')).raw))
    expect(odd.layers.map(l => [l.z_index.int, l.name])).toEqual([['0', ''], ['1', 'Café — 猫'], ['3', '5']])
    expect(odd.width).toEqual({ int: '64' })
    for (const bad of ['[1]', '{"layers": 5}', '{"layers": [{"image": "x"}]}', '{"layers": [{"image": {"url": "u"}, "z_index": null}]}', '{"images": {"a": 1}}']) {
      expect(() => parseSeedreamLayers(parsePyJson(bad)), bad).toThrow('can’t read')
    }
    expect(parseSeedreamLayers(parsePyJson('null')).layers).toEqual([])
    expect(parseSeedreamLayers(parsePyJson('{"layers": {"k": 1}, "images": "ab"}'))).toEqual({ layers: [], width: { int: '0' }, height: { int: '0' } })
    expect(parseSeedreamLayers(parsePyJson('{"layers": [{"image": {"url": "u", "width": "1_024"}, "z_index": 1e300}]}')).layers[0]!.z_index.int)
      .toBe(BigInt(1e300).toString())
  })
})

describe('prices (ruling (a))', () => {
  it('a card per endpoint, read from its page; none duplicates another card', () => {
    expect(PAID_RATES['ideogram-ai/layerize']).toEqual({
      unit: 'per_call', usd: 0.09, service: 'replicate', source: 'https://replicate.com/ideogram-ai/layerize', read: '2026-09-27', confidence: 'estimate',
    })
    expect(PAID_RATES[SEEDREAM]).toEqual({
      unit: 'per_output_image', perImage: 0.03375, large: { fromPixels: 1536 * 1536, perImage: 0.0675 },
      service: 'fal', source: 'https://fal.ai/models/bytedance/seedream/v5/pro/layerize', read: '2026-09-27', confidence: 'estimate',
    })
    expect(PAID_RATES['black-forest-labs/flux-fill-pro']).toMatchObject({ unit: 'per_call', usd: 0.05, confidence: 'verified' })
    expect(PAID_RATES['bria/expand-image']).toMatchObject({ unit: 'per_call', usd: 0.04, confidence: 'verified' })
    for (const e of ['ideogram-ai/layerize', SEEDREAM, ...Object.values(OUTPAINT_SLUGS)]) expect(otherCardFor(e), e).toBeNull()
  })

  it('priced by their calls with no flat row; the price book moved on', () => {
    for (const c of LAYERS_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
    }
    expect(PRICE_BOOK_VERSION).toBe('r3-audio-gen')
  })

  it('credits on both paths: Layerize 18, Outpaint 10 or 8 by engine (a wired one at the dearest), Seedream 87 at auto_1K and 173 otherwise', () => {
    const img = { image: ['p', 0] }
    const want: [string, Record<string, unknown>, number][] = [
      ['LayerizeGraphicNode', { model: 'Ideogram Layerize', prompt: '', seed: 0 }, 18],
      ['OutpaintImageNode', { model: 'Flux Fill' }, 10],
      ['OutpaintImageNode', { model: 'Bria Expand' }, 8],
      ['OutpaintImageNode', { model: ['x', 0] }, 10],
      ['OutpaintImageNode', {}, 10],
      ['SeedreamLayerizeNode', { image_size: 'auto_1K' }, creditsForUsd(17 * 0.03375)],
      ...(['auto', 'auto_1.5K', 'auto_2K', '8K', undefined] as const).map(s => ['SeedreamLayerizeNode', s ? { image_size: s } : {}, creditsForUsd(17 * 0.0675)] as [string, Record<string, unknown>, number]),
    ]
    for (const [c, inputs, credits] of want) {
      expect((priceNode(c, { ...img, ...inputs }) as { credits: number }).credits, `${c} ${JSON.stringify(inputs)}`).toBe(credits)
      expect(priceGraph({ 1: { class_type: c, inputs: { ...img, ...inputs } } }).nodes!['1'], c).toBe(credits)
    }
    expect(creditsForUsd(17 * 0.03375)).toBe(87)
    expect(creditsForUsd(17 * 0.0675)).toBe(173)
  })

  it('a Seedream answer is priced by the pictures that came back and their area, from the same card', () => {
    const two = answerOf(caseNamed('seedream · image_size auto'))
    expect(seedreamImagesMade(parsePyJson(two.raw))).toBe(2)
    // 64 × 48 is under 1536²: two pictures at $0.03375.
    expect(seedreamAnsweredUsd(two.result, two.raw)).toBe(paidCallUsd(seedreamCallAnswered(2, 64 * 48)))
    expect(seedreamAnsweredUsd(two.result, two.raw)).toBe(0.0675)
    const big = JSON.stringify({ images: [{ url: 'u', width: 2048, height: 2048 }], layers: [{ image: { url: 'u', width: 2048, height: 2048 }, z_index: 0 }] })
    expect(seedreamAnsweredUsd(JSON.parse(big), big)).toBe(0.0675)
    // The area not known: the dearer rate.
    expect(paidCallUsd(seedreamCallAnswered(3, null))).toBe(tidy(3 * 0.0675))
    expect(seedreamAnsweredUsd({}, 'not json')).toBeNull()
  })

  it('nothing is free: every class makes its call', () => {
    for (const c of LAYERS_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
  })
})

function tidy(usd: number) { return Math.round(usd * 1e8) / 1e8 }

describe('hold and charge (hosted)', () => {
  async function seedreamRun(answer: Raw, o: { failDownload?: string } = {}) {
    const c = caseNamed('seedream · image_size auto')
    const fal = createFakeFal({ bodyText: () => answer.__body__ })
    const download = vi.fn(async (url: string) => {
      if (url === o.failDownload) throw new Error('Could not download the result (500)')
      return { bytes: new Uint8Array(await png(4, 3, 4)), contentType: 'image/png' }
    })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON, download } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(c)], ...START })
    await k.engine.settled(runId)
    return { k, run: (await k.store.get(runId))!, c }
  }

  it('Seedream: held at 17 pictures at the dearer rate (173), charged the 2 that came back (14)', async () => {
    const { k, run } = await seedreamRun(caseNamed('seedream · image_size auto').answers[0] as Raw)
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.credits).toBe(173)
    expect(rec.calls!.map(x => [x.status, x.usd])).toEqual([['done', 0.0675]])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[173, callCredits({ usd: 0.0675 })]])
    expect(callCredits({ usd: 0.0675 })).toBe(14)
  })

  it('an answer claiming more pictures than the hold covers is charged the hold, reported', async () => {
    // 17 layers (all it keeps) but 20 pictures listed: priced at 20, above the hold of 17.
    const layers = Array.from({ length: 17 }, (_, i) => ({ image: { url: `https://r.test/l${i}.png`, width: 4000, height: 4000 }, z_index: i }))
    const images = Array.from({ length: 20 }, (_, i) => ({ url: `https://r.test/i${i}.png`, width: 4000, height: 4000 }))
    const body = JSON.stringify({ images, layers })
    const { k, run } = await seedreamRun({ __body__: body })
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[173, 173]])
    expect((k.deps.reportError as ReturnType<typeof vi.fn>).mock.calls.some(([, ctx]) => (ctx as { site: string }).site === 'runner.charge.above-hold')).toBe(true)
  })

  // Fix round 1, ruling 1: a name Sailor refuses fails the node plainly; the finished call is charged as answered.
  it('a layer name that is a list fails plainly and is charged the pictures made at their own rate (the reviewer\'s 31, not 61)', async () => {
    const layers = Array.from({ length: 6 }, (_, i) => ({ image: { url: `https://r.test/l${i}.png`, width: 64, height: 48 }, z_index: i, ...(i === 3 ? { name: ['a', 1.0, null] } : {}) }))
    const { k, run } = await seedreamRun({ __body__: JSON.stringify({ images: [{ url: 'https://r.test/flat.png', width: 64, height: 48 }], layers }) })
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(SEEDREAM_ANSWER_UNREADABLE)
    expect(rec.calls![0]!.usd).toBe(tidy(6 * 0.03375))
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[173, 31]])
    expect(creditsForUsd(6 * 0.0675)).toBe(61)
    // Nothing was downloaded: the node stopped at the answer.
    expect((k.deps.download as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
  })

  // Fix round 1, ruling 8: fal makes at most 17; more is refused before any layer is downloaded.
  it('an answer of 18 layers is refused before downloading any; charged as answered, never above the hold', async () => {
    const layers = Array.from({ length: 18 }, (_, i) => ({ image: { url: `https://r.test/l${i}.png`, width: 64, height: 48 }, z_index: i }))
    const { k, run } = await seedreamRun({ __body__: JSON.stringify({ images: [], layers }) })
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(SEEDREAM_TOO_MANY_LAYERS)
    expect(rec.error).not.toMatch(/Node|_/)
    expect((k.deps.download as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
    expect(readdirSync(join(k.root, 'input'), { recursive: true }).filter(f => String(f).includes('seedream_layer'))).toEqual([])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[173, creditsForUsd(18 * 0.03375)]])
  })

  it('a layer that can\'t be downloaded fails the node; its call was not delivered, so not charged', async () => {
    const { k, run } = await seedreamRun(caseNamed('seedream · image_size auto').answers[0] as Raw, { failDownload: 'https://r.test/seedream/layer_1.png' })
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(rec.calls![0]!.lost).toBe(true)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('Layerize: a layer JSON that fails leaves the node done and its call charged (18)', async () => {
    const c = caseNamed('layerize · answer · JSON link fails')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', ...(c.answers[0] as object) }) })
    const download = vi.fn(async (url: string, o?: { kind?: string }) => {
      if (o?.kind === 'json') throw new Error('Could not download the result (502)')
      return { bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' }
    })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(c)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.values![1]).toEqual({ kind: 'json', text: layerDataError('could not download the result (502)') })
    expect(rec.calls![0]!.lost).toBeUndefined()
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[18, 18]])
    // The JSON was fetched with its own kind (1 MiB, 30 seconds), the picture as a picture.
    expect(download.mock.calls.map(x => [x[0], (x[1] as { kind?: string } | undefined)?.kind])).toEqual([
      ['https://r.test/layerize/bg.png', 'image'], ['https://r.test/layerize/layers.json', 'json'],
    ])
    // Shown: the picture and the error JSON as text.
    const shownUi = ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')?.output
    expect(shownUi).toEqual({ images: rec.outputs, animated: [false], text: [layerDataError('could not download the result (502)')] })
    expect(rec.outputs.length).toBe(1)
  })
})

describe('Layerize\'s layers_json feeds a Text card byte-identically', () => {
  it('Separate text from image → Text card (source): the card hands on the JSON text as it came', async () => {
    const c = caseNamed('layerize · prompt non-ASCII')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', ...(c.answers[0] as object) }) })
    const download = async (url: string) => (c.links?.[url] !== undefined
      ? { bytes: new TextEncoder().encode(c.links[url] as string), contentType: 'application/json' }
      : { bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' })
    const k = makeKit({ replicate, deps: { families: () => ON, download } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const p: ApiPrompt = { ...withPicture(c), t: { class_type: 'Text', inputs: { text: '', source: ['n', 1] } } }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.t!.status, nodes.t!.error ?? '').toBe('done')
    const pyJson = (c.output as [unknown, string])[1]
    expect(nodes.n!.values![1]).toEqual({ kind: 'json', text: pyJson })
    expect((nodes.t!.values![0] as { text: string }).text).toBe(pyJson)
  })
})

describe('Seedream\'s layers: the user\'s own input files (ruling (o))', () => {
  it('hosted: saved in the user\'s input subfolder, named so in the JSON, recorded as theirs; another user is refused them', async () => {
    const c = caseNamed('seedream · image_size auto_1K')
    const fal = createFakeFal({ bodyText: () => (c.answers[0] as Raw).__body__ })
    const download = async (url: string) => ({ bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON, download } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(c)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    const sub = `u_${shortUserHash(k.userId!)}`
    const json = JSON.parse((rec.values![1] as { text: string }).text) as { layers: { filename: string }[] }
    expect(json.layers.map(l => l.filename)).toEqual([`${sub}/seedream_layer_00001_.png`, `${sub}/seedream_layer_00002_.png`])
    for (const l of json.layers) expect(existsSync(join(k.root, 'input', l.filename)), l.filename).toBe(true)
    // The layers are recorded as this run's own (the ownership rows), not listed as the node's outputs.
    const created = (k.graphRuns.create.mock.calls as unknown as [{ promptId: string; userId: string }][]).map(x => x[0])
    const appended = k.graphRuns.appendOutput.mock.calls as unknown as [string, string][]
    for (const l of json.layers) {
      // Under the runner's own record kind (fix round 1), never an `input:` key a history could carry.
      expect(appended.map(a => a[1])).toContain(savedInputKey({ filename: l.filename.split('/')[1]!, subfolder: sub }))
      expect(appended.map(a => a[1])).not.toContain(outputKey({ filename: l.filename.split('/')[1]!, subfolder: sub, type: 'input' }))
    }
    expect(rec.outputs.every(f => f.type === 'output')).toBe(true)
    // Ownership as the server checks it: uploads by owner, else the keys the user's runs recorded.
    const ownedBy = (userId: string) => new Set(appended.filter(([stage]) => created.some(r => r.promptId === stage && r.userId === userId)).map(a => a[1]))
    const check: OwnershipCheck = {
      ownsInput: async () => false,
      ownsOutput: async () => false,
      ownsSaved: async (userId, f) => savedInputOwned(userId, f, ownedBy(userId)),
    }
    const frame: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: json.layers[1]!.filename, upload: 'image' } },
      f: { class_type: 'Compositor', inputs: { layer1: ['l', 0], width: 0, height: 0 } },
    }
    const files = collectInputFiles(frame)
    expect(files).toEqual([{ filename: 'seedream_layer_00002_.png', subfolder: sub, type: 'input' }])
    await expect(assertFilesOwned(files, k.userId, true, check)).resolves.toBeUndefined()
    await expect(assertFilesOwned(files, 'user_2', true, check)).rejects.toThrow('isn’t one of yours')
    // Without the saved-file record (an older server), an input file is owned only by its upload.
    await expect(assertFilesOwned(files, k.userId, true, { ownsInput: async () => false, ownsOutput: async () => true })).rejects.toThrow('isn’t one of yours')
    // Hardening (fix round 1): an `input:` key (what a ComfyUI history could hold) never counts, nor the runner's
    // kind for a file outside the user's own subfolder.
    const f = files[0]!
    expect(savedInputOwned(k.userId!, f, new Set([outputKey(f)]))).toBe(false)
    expect(savedInputOwned(k.userId!, { ...f, subfolder: 'u_other' }, new Set([savedInputKey({ ...f, subfolder: 'u_other' })]))).toBe(false)
    expect(savedInputOwned(k.userId!, f, new Set([savedInputKey(f)]))).toBe(true)
  })

  it('locally: saved at the input folder\'s root with Python\'s names, the JSON byte-identical', async () => {
    const run = await runPaidCase(caseNamed('seedream · 17 layers'), { families: ON })
    const json = JSON.parse((run.values![1] as { text: string }).text) as { layers: { filename: string }[] }
    expect(json.layers.map(l => l.filename)).toEqual(Array.from({ length: 17 }, (_, i) => `seedream_layer_${String(i + 1).padStart(5, '0')}_.png`))
  })
})

describe('moderation', () => {
  it('lists each class\'s prompt', () => {
    for (const c of LAYERS_CLASSES) expect(PAID_TEXT_INPUTS[c], c).toEqual(['prompt'])
    expect(extraPromptTexts({ n: { class_type: 'OutpaintImageNode', inputs: { prompt: 'a forest' } } })).toEqual(['a forest'])
  })

  it('a hosted run moderates the prompt at the start; a flagged one is refused before the hold', async () => {
    for (const c of [caseNamed('layerize · prompt spaced'), caseNamed('seedream · prompt'), caseNamed('outpaint · Bria Expand prompt spaced')]) {
      const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
      const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
      writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
      const p = withPicture({ ...c, widgets: { ...c.widgets, prompt: 'a forbidden thing' } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), c.name).rejects.toThrow()
      expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      expect(k.fal.client.submit).not.toHaveBeenCalled()
    }
  })
})

describe('with layers off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but layers', RUNNER_FAMILIES.filter(f => f !== 'layers')],
  ]
  const isMine = (ct: string) => (LAYERS_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.6: the classes had no rule row and were no picture (renamed to one that has neither). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isMine(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isMine(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const sample = (c: LayersClass) => CASES.find(x => x.class_type === c && !x.error)!

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of LAYERS_CLASSES) {
      const p = withPicture(sample(c))
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c), c).toBe(c !== 'OutpaintImageNode')
      expect(IMAGE_OUTPUT_CLASSES.has(c)).toBe(false)
      expect(PAID_PICTURE_FAMILY[c]).toBe('layers')
      const rule = RUNNER_NODE_RULES[c]!
      if (c === 'SeedreamLayerizeNode') expect(rule.family).toBe('layers')
      else expect(new Set(Object.values(rule.models!))).toEqual(new Set(['layers']))
    }
    // Only while layers is on: the layerizers' slot 1 is JSON.
    expect(outputKindsFor(ON).LayerizeGraphicNode).toEqual({ 1: 'json' })
    expect(outputKindsFor(new Set(['cards'])).LayerizeGraphicNode).toBeUndefined()
    expect(RUNNER_ROUTES['LayerizeGraphicNode:Ideogram Layerize']).toMatchObject({ first: 'replicate', backup: null })
    expect(RUNNER_ROUTES.SeedreamLayerizeNode).toMatchObject({ first: 'fal', backup: null })
    for (const m of Object.keys(OUTPAINT_SLUGS)) expect(RUNNER_ROUTES[`OutpaintImageNode:${m}`], m).toMatchObject({ first: 'replicate', backup: null })
  })

  it('an image_size the node doesn\'t offer, or a wired setting, is left to the engine (ComfyUI refuses it before running)', () => {
    const p = withPicture({ ...sample('SeedreamLayerizeNode'), widgets: { prompt: '', image_size: '8K' } })
    expect(runnerTakesNode(p, 'n', ON)).toBe(false)
    const q = withPicture({ ...sample('OutpaintImageNode'), widgets: { ...sample('OutpaintImageNode').widgets, seed: ['x', 0] } })
    expect(runnerTakesNode(q, 'n', ON)).toBe(false)
  })

  it('over synthetic chains: into a Frame, into Outpaint, the JSON into a Text card, a Text card into the prompt', () => {
    for (const c of LAYERS_CLASSES) {
      const p = withPicture(sample(c))
      sameAsBefore(p, `${c} alone`)
      sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, `${c} → Frame`)
      sameAsBefore({ ...p, o: { class_type: 'OutpaintImageNode', inputs: { ...sample('OutpaintImageNode').widgets, image: ['n', 0] } } }, `${c} → Outpaint`)
      if (c !== 'OutpaintImageNode') sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: '', source: ['n', 1] } } }, `${c} → Text`)
      sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, prompt: ['t', 0] } } }, `Text → ${c}`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Layerize and Outpaint spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({
          ...p,
          d_img: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
          d_ly: { class_type: 'LayerizeGraphicNode', inputs: { ...sample('LayerizeGraphicNode').widgets, image: ['d_img', 0] } },
          d_op: { class_type: 'OutpaintImageNode', inputs: { ...sample('OutpaintImageNode').widgets, image: ['d_ly', 0] } },
        }, `${uuid} + Layerize → Outpaint`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`layers families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

// Fix round 1, ruling 6: a resumed node reuses the layers it saved, under their names.
describe('Seedream resumed after a restart', () => {
  it('the layers saved before the restart are reused, not downloaded or saved again; the rest follow in order', async () => {
    const c = caseNamed('seedream · 17 layers')
    const fal = createFakeFal({ bodyText: () => (c.answers[0] as Raw).__body__ })
    const hang = { on: true }
    const got: string[] = []
    const download = async (url: string) => {
      if (hang.on && url.endsWith('/layer_3.png')) await new Promise<void>(() => {})
      got.push(url)
      return { bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' }
    }
    const k1 = makeKit({ hosted: true, fal, deps: { families: () => ON, download } })
    writeFileSync(join(k1.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [withPicture(c)], ...START })
    const until = async (ok: () => boolean) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise(r => setTimeout(r, 5)) }
    await until(() => got.length === 3)
    await new Promise(r => setTimeout(r, 30))
    const mid = (await k1.store.get(runId))!.takes[0]!.nodes.n!
    expect(Object.keys(mid.calls![0]!.saved ?? {})).toEqual(['layer-0', 'layer-1', 'layer-2'])
    hang.on = false
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, ledger: k1.ledger, deps: { families: () => ON, download } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    // Each layer downloaded once, in order; the call sent once.
    const layerGets = got.filter(u => /layer_\d+\.png$/.test(u))
    expect(layerGets).toEqual(Array.from({ length: 17 }, (_, i) => `https://r.test/seedream/layer_${i}.png`))
    expect(fal.submitted().length).toBe(1)
    // Seventeen files, named 1 to 17 as the JSON says: none saved twice.
    const sub = `u_${shortUserHash(k1.userId!)}`
    const onDisk = readdirSync(join(k1.root, 'input', sub)).filter(f => f.startsWith('seedream_layer')).sort()
    const named = (JSON.parse((rec.values![1] as { text: string }).text) as { layers: { filename: string }[] }).layers.map(l => l.filename)
    expect(onDisk).toEqual(Array.from({ length: 17 }, (_, i) => `seedream_layer_${String(i + 1).padStart(5, '0')}_.png`))
    expect(named).toEqual(onDisk.map(f => `${sub}/${f}`))
  })
})
