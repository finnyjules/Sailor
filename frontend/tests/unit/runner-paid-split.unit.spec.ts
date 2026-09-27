/**
 * R3.7: Separate background and foreground (family `layers`) — the remover's
 * cut-out, its alpha grown by PIL's MaxFilter into the mask, and the fill
 * engine (LaMa or Bria Eraser) on the picture without its alpha — against
 * what the real Python sends and returns (fixtures/runner-paid-split.json,
 * scripts/runner_paid_fixtures.py --group split), priced on both paths from
 * Replicate's pages, charged for the calls that finished.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, PAID_PICTURE_SLOTS, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { PHOTO_FILL_SLUGS, PHOTO_FILLS, SPLIT_CLASS, SPLIT_CUTOUT_SLUG } from '#shared/runner/layers'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { PAID_NODE_CLASSES, paidCalls, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { callCredits } from '#shared/pricing/pipelinePrice'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { SPLIT_NO_BACKGROUND, SPLIT_NO_SUBJECT } from '~~/server/runner/generators/splitLayers'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { maxFilterCore, maxFilterL } from '~~/server/runner/pixels/maxFilter'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

/** A split case: a paid case, plus what the fixture adds for this group. */
type SplitCase = PaidCase & {
  /** Each alpha-dropped picture Python encoded (`PNG:<sha256>`), by its decoded pixels. */
  made: Record<string, { shape: number[]; sha256: string }>
  picture_modes?: Record<string, string>
}
interface MaxFilterRow { w: number; h: number; size: number; sha256: string; out?: string }
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-split.json'), 'utf8')) as {
  cases: SplitCase[]; maxfilter: MaxFilterRow[]; masks: Record<string, string>
}
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'layers'])
const LAMA = PHOTO_FILL_SLUGS['LaMa (fast)']
const BRIA = PHOTO_FILL_SLUGS['Bria Eraser (quality)']
const IMAGE_URL = 'https://fal.storage/image.png'
const IMAGE_FILE: OutputFile = { filename: 'image.png', subfolder: '', type: 'input' }

const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no case ${name}`)
  return c
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const isRgba = (c: SplitCase) => c.picture_modes?.image === 'RGBA'

/** The node fed by a LoadImage of `image.png` (an RGB picture), or by an Image card (the file as it is: an RGBA picture). */
function promptOf(c: SplitCase, source: 'LoadImage' | 'Image' = 'LoadImage'): ApiPrompt {
  return {
    p_image: source === 'LoadImage'
      ? { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
      : { class_type: 'Image', inputs: { image: 'image.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
    n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['p_image', 0] } },
  }
}

async function planOf(c: SplitCase): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: promptOf(c), nodeId: 'n', gateOpen: false,
    filesFrom: link => (link[0] === 'p_image' ? [IMAGE_FILE] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
  if (p.kind !== 'pipeline') throw new Error('Separate background and foreground is a pipeline')
  return p
}

/** Decoded pixels: the raw bytes, and their shape as numpy has it ([h, w] for one channel). */
async function pixels(png: Uint8Array): Promise<{ data: Buffer; shape: number[]; channels: number }> {
  // (sharp decodes a greyscale PNG to sRGB unless asked for its one channel.)
  const grey = (await sharp(png).metadata()).channels === 1
  const { data, info } = await (grey ? sharp(png).toColourspace('b-w') : sharp(png)).raw().toBuffer({ resolveWithObject: true })
  return { data, shape: info.channels === 1 ? [info.height, info.width] : [info.height, info.width, info.channels], channels: info.channels }
}

/** Python's mask: the PNG in its data URL. */
const pyMaskPng = (dataUrl: string) => {
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  return b64(dataUrl.slice('data:image/png;base64,'.length))
}

interface SentCall { provider: string; endpoint: string; payload: Record<string, unknown> }

/**
 * The calls the runner sent against Python's, in order: the cut-out's payload
 * deep-equal and wire-equal (its picture the handed-off file, Python's
 * `IMG:image`); the fill's endpoint, its keys, its mask's pixels exactly
 * (PIL's and sharp's PNG encoders write other bytes for the same pixels) and
 * its picture: the same file as the cut-out's when Python sends the same
 * tensor, else an RGB copy whose pixels are Python's.
 */
async function expectSplitCalls(sent: SentCall[], c: SplitCase, bytesOf: (url: string) => Uint8Array | undefined): Promise<void> {
  expect(sent.length, 'the number of calls').toBe(c.calls.length)
  for (const [i, py] of c.calls.entries()) {
    const got = sent[i]!
    expect([got.provider, got.endpoint], `call ${i + 1}`).toEqual([py.provider, py.endpoint])
    if (i === 0) {
      const payload = { ...got.payload, image: got.payload.image === IMAGE_URL ? 'IMG:image' : got.payload.image }
      expect(payload).toEqual(py.payload)
      expect(wireText(payload)).toBe(py.payload_json)
      continue
    }
    expect(Object.keys(got.payload)).toEqual(Object.keys(py.payload))
    // The mask: Python's pixels exactly, an 8-bit greyscale PNG.
    const mine = bytesOf(String(got.payload.mask))
    expect(mine, 'the mask was handed off').toBeDefined()
    const [a, b] = await Promise.all([pixels(mine!), pixels(pyMaskPng(String(py.payload.mask)))])
    expect(a.channels).toBe(1)
    expect(a.shape).toEqual(b.shape)
    expect(sha(a.data), `${c.name}: mask pixels`).toBe(sha(b.data))
    const meta = await sharp(mine!).metadata()
    expect([meta.format, meta.depth, meta.channels]).toEqual(['png', 'uchar', 1])
    // The picture without its alpha.
    const pyImage = String(py.payload.image)
    if (pyImage === 'IMG:image') {
      expect(got.payload.image).toBe(IMAGE_URL)
    }
    else {
      const want = c.made[pyImage]!
      expect(want, pyImage).toBeDefined()
      expect(got.payload.image).not.toBe(IMAGE_URL)
      const copy = await pixels(bytesOf(String(got.payload.image))!)
      expect(copy.shape).toEqual(want.shape)
      expect(sha(copy.data), `${c.name}: the RGB copy`).toBe(want.sha256)
    }
  }
}

/** The subject is the cut-out as downloaded; the background Python's alpha-dropped tensor, byte for byte. */
async function expectOutputs(c: SplitCase, subject: Uint8Array, background: Uint8Array): Promise<void> {
  const [pySubject, pyBackground] = c.output as [{ image: string }, { tensor: { shape: number[]; sha256: string } }]
  expect(Buffer.compare(Buffer.from(subject), Buffer.from(b64(c.files![pySubject.image]!))), `${c.name}: subject`).toBe(0)
  const bg = await pixels(background)
  expect([1, ...bg.shape]).toEqual(pyBackground.tensor.shape)
  expect(sha(bg.data), `${c.name}: background`).toBe(pyBackground.tensor.sha256)
}

/**
 * The pipeline run by hand: its calls answered with the case's answers in
 * order, its downloads served from the case, its hand-offs and saves written down.
 */
async function runByHand(c: SplitCase) {
  const plan = await planOf(c)
  const calls: PipelineCall[] = []
  const downloads: string[] = []
  const handed = new Map<string, Uint8Array>()
  const saves: { prefix: string; ext: string; bytes: Uint8Array; file: OutputFile }[] = []
  const kept = new Map<string, Uint8Array>()
  const io = {
    signal: new AbortController().signal,
    call: async (x: PipelineCall) => {
      calls.push(x)
      const a = c.answers[calls.length - 1]
      if (!a) throw new Error(`${c.name}: more calls than Python`)
      return { result: a, raw: JSON.stringify(a), urls: [] }
    },
    download: async (url: string) => {
      downloads.push(url)
      const f = c.files?.[url]
      if (!f) throw new Error(`GET ${url} is not served`)
      return { bytes: b64(f), contentType: 'image/png' }
    },
    keep: async (bytes: Uint8Array, ext: string) => {
      const f: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      kept.set(f.filename, bytes)
      return f
    },
    read: async (f: OutputFile) => (f.type === 'kept' ? kept.get(f.filename)! : b64(c.picture_files!.image!)),
    handOff: async (bytes: Uint8Array, name: string) => {
      const url = `https://fal.storage/${name}`
      handed.set(url, bytes)
      return url
    },
    saveAsset: async (bytes: Uint8Array, o: { prefix: string; ext: string }) => {
      const file: OutputFile = { filename: `${o.prefix}_00001_.${o.ext}`, subfolder: '', type: 'output' }
      saves.push({ prefix: o.prefix, ext: o.ext, bytes, file })
      return file
    },
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, downloads, handed, saves }
}

// ── The published inputs (each page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const uri = { type: 'string', format: 'uri' }
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  [SPLIT_CUTOUT_SLUG]: publishedInput({
    image: uri, format: { type: 'string', default: 'png' }, reverse: { type: 'boolean', default: false },
    threshold: { type: 'number', default: 0 }, background_type: { type: 'string', default: 'rgba' },
  }, ['image']),
  [LAMA]: publishedInput({ mask: uri, image: uri }, ['image', 'mask']),
  [BRIA]: publishedInput({
    mask: uri, sync: { type: 'boolean', default: true }, image: uri, mask_url: { type: 'string' }, image_url: { type: 'string' },
    mask_type: { enum: ['manual', 'automatic'], type: 'string', default: 'manual' }, preserve_alpha: { type: 'boolean', default: true },
    content_moderation: { type: 'boolean', default: false },
  }, []),
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('covers both fill engines, mask_grow 0, 1, 12 and 50, RGB and RGBA inputs, the cut-outs PIL reads its own way, and the failures', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set([SPLIT_CLASS]))
    for (const fill of ['LaMa', 'Bria']) {
      for (const grow of [0, 1, 12, 50]) {
        for (const mode of ['RGB', 'RGBA']) expect(names.has(`split · ${fill} · mask_grow ${grow} · ${mode} input`), `${fill} ${grow} ${mode}`).toBe(true)
      }
    }
    for (const n of ['a picture 50 px wide, mask_grow 50', 'a cut-out with no alpha (no matte call)', 'a cut-out in CMYK JPEG', 'a cut-out in 16-bit grey',
      'a cut-out in grey and alpha', 'a cut-out in palette with transparency', 'a background in CMYK JPEG', 'a background in 16-bit grey',
      'a cut-out answer with no output', 'a background answer with no output']) expect(names.has(`split · ${n}`), n).toBe(true)
    // Every case that calls calls the remover first, with the fill engine its setting names second.
    for (const c of CASES) {
      expect(c.calls[0]!.endpoint).toBe(SPLIT_CUTOUT_SLUG)
      if (c.calls[1]) expect(c.calls[1].endpoint).toBe(PHOTO_FILL_SLUGS[c.widgets.background_fill as keyof typeof PHOTO_FILL_SLUGS])
    }
    // MaxFilter alone: masks from 1 × 1 to 320 × 200, sizes 3, 25 and 101.
    expect(FIXTURE.maxfilter.length).toBe(15)
    expect(new Set(FIXTURE.maxfilter.map(r => r.size))).toEqual(new Set([3, 25, 101]))
  })

  // R3.2's note, proven: a downloaded picture is always read as RGBA, so the remover's matte is never asked for.
  it('Python never makes the third (matte) call: a cut-out with no alpha is read as fully opaque, and the fill follows', async () => {
    const c = caseNamed('split · a cut-out with no alpha (no matte call)')
    const cutout = await sharp(b64(c.files!['https://r.test/split/cutout.png']!)).metadata()
    expect(cutout.hasAlpha).toBe(false)
    expect(c.calls.map(x => [x.endpoint, (x.payload as { background_type?: string }).background_type ?? null])).toEqual([[SPLIT_CUTOUT_SLUG, 'rgba'], [LAMA, null]])
    const mask = await pixels(pyMaskPng(String(c.calls[1]!.payload.mask)))
    expect(mask.data.every(v => v === 255)).toBe(true)
    for (const x of CASES) expect(x.calls.some(k => (k.payload as { background_type?: string }).background_type === 'map'), x.name).toBe(false)
  })
})

describe('PIL\'s MaxFilter (maxFilterL)', () => {
  it.each(FIXTURE.maxfilter.map(r => [`${r.w}×${r.h} at ${r.size}`, r] as const))('%s: Python\'s pixels exactly (the edge rule)', (_n, r) => {
    const mask = b64(FIXTURE.masks[`${r.w}x${r.h}`]!)
    // The mask touches every edge and corner.
    expect(mask[0]).toBeGreaterThan(0)
    expect(mask[r.w * r.h - 1]).toBeGreaterThan(0)
    const out = maxFilterL(mask, r.w, r.h, r.size)
    if (r.out) expect([...out]).toEqual([...b64(r.out)])
    expect(sha(out)).toBe(r.sha256)
  })

  it('on the Frame\'s worker, the same pixels', async () => {
    const r = FIXTURE.maxfilter.find(x => x.w === 320 && x.size === 25)!
    const out = await pixelsInWorker(undefined, w => w.maxFilter(b64(FIXTURE.masks['320x200']!), 320, 200, 25))
    expect(sha(out)).toBe(r.sha256)
  })

  it('size 1 changes nothing; an even or wrong size and a wrong length are refused; Stop stops it', () => {
    const m = b64(FIXTURE.masks['37x23']!)
    expect([...maxFilterL(m, 37, 23, 1)]).toEqual([...m])
    expect(() => maxFilterL(m, 37, 23, 4)).toThrow('whole number')
    expect(() => maxFilterL(m, 37, 22, 3)).toThrow('not the size')
    expect(() => maxFilterCore().maxFilterL(m, 37, 23, 3, () => true)).toThrow('Stopped')
  })
})

describe('every fixture case: what Python sends and returns (the plan, run by hand)', () => {
  const offSchema: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const r = await runByHand(c)
    if (c.error) {
      await expect(r.run()).rejects.toThrow(c.calls.length === 1 ? SPLIT_NO_SUBJECT : SPLIT_NO_BACKGROUND)
    }
    else {
      const made = await r.run()
      const subject = r.saves.find(s => s.prefix === 'split_subject')!
      const background = r.saves.find(s => s.prefix === 'split_background')!
      expect(background.ext).toBe('png')
      expect(subject.ext).toBe('png')
      await expectOutputs(c, subject.bytes, background.bytes)
      // Slot 0 the subject, slot 1 the background; shown in that order (Python's ui, save_generation_output's prefixes).
      expect(made.values).toEqual({ 0: { kind: 'files', files: [subject.file] }, 1: { kind: 'files', files: [background.file] } })
      expect(made.ui).toEqual({ images: [subject.file, background.file], animated: [false] })
      expect((c.ui as { images: { prefix: string }[] }).images.map(i => i.prefix)).toEqual(['split_subject', 'split_background'])
      // Python downloads the cut-out, then the background: so does the runner.
      expect(r.downloads).toEqual((c.gets ?? []).map(g => g.url))
    }
    await expectSplitCalls(r.calls.map(x => ({ provider: x.provider, endpoint: x.endpoint, payload: x.payload })), c, u => r.handed.get(u) ?? (u === IMAGE_URL ? b64(c.picture_files!.image!) : undefined))
    for (const x of r.calls) {
      const errs = checkPayload(PUBLISHED[x.endpoint]!, x.payload)
      if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
      expect(x.backup).toBeUndefined()
      expect(x.media).toBe('image')
      // Each call's price basis is its own card's.
      expect(x.usd).toBe(paidCallUsd({ endpoint: x.endpoint }))
    }
    // An RGBA picture's copy is handed off; an RGB PNG is sent again as it is.
    expect([...r.handed.keys()].includes('https://fal.storage/split_image.png')).toBe(isRgba(c))
  })

  it('every payload fits its published schema', () => {
    expect(offSchema).toEqual([])
  })
})

// ── Through the engine (cards and layers on) ────────────────────────────────

interface KitRunOptions {
  hosted?: boolean
  source?: 'LoadImage' | 'Image'
  /** The fill call fails at the provider. */
  failFill?: boolean
  /** The background can't be downloaded. */
  failBackground?: boolean
  ownership?: { ownsInput: () => Promise<boolean>; ownsOutput: () => Promise<boolean> }
}

function answersFor(c: SplitCase) {
  return createFakeReplicate({
    bodyText: ({ model }) => JSON.stringify({ id: 'p', status: 'succeeded', ...(c.answers[model === SPLIT_CUTOUT_SLUG ? 0 : 1] as object) }),
  })
}

async function kitRun(c: SplitCase, o: KitRunOptions = {}) {
  const replicate = answersFor(c)
  if (o.failFill) {
    const submit = replicate.client.submit
    replicate.client.submit = (async (slug: string, ...rest: unknown[]) => {
      if (slug !== SPLIT_CUTOUT_SLUG) replicate.failNext(1)
      return (submit as (...a: unknown[]) => Promise<unknown>)(slug, ...rest)
    }) as typeof submit
  }
  const gets: string[] = []
  const download = vi.fn(async (url: string) => {
    gets.push(url)
    if (o.failBackground && url.includes('background')) throw new Error('Could not download the result (500)')
    return { bytes: b64(c.files![url]!), contentType: 'image/png' }
  })
  const k = makeKit({ hosted: o.hosted, replicate, deps: { families: () => ON, download, ...(o.ownership ? { ownership: o.ownership } : {}) } })
  writeFileSync(join(k.root, 'input', 'image.png'), b64(c.picture_files!.image!))
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c, o.source)], ...START })
  await k.engine.settled(runId)
  const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
  const uploads = new Map((k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([bytes, name]) => [`https://fal.storage/${name}`, bytes]))
  const sent = replicate.submitted().map(r => ({ provider: 'replicate', endpoint: r.endpoint, payload: r.payload }))
  return { k, rec, sent, uploads, gets, download, replicate }
}

const readOut = (k: { root: string }, f: OutputFile) => new Uint8Array(readFileSync(join(k.root, f.type, f.subfolder, f.filename)))

describe('every fixture case through the engine (cards and layers on)', () => {
  const calling = CASES.filter(c => !c.error)

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, kept and priced', async (_n, c) => {
    // An RGBA picture comes from a node that keeps its alpha: here an Image card, which hands its file on as it is.
    const { k, rec, sent, uploads } = await kitRun(c, { source: isRgba(c) ? 'Image' : 'LoadImage' })
    expect(rec.status, rec.error ?? '').toBe('done')
    await expectSplitCalls(sent, c, u => uploads.get(u))
    const price = priceNode(c.class_type, { ...c.widgets, image: ['p_image', 0] })
    if ('refused' in price) throw new Error(price.refused)
    expect(rec.credits).toBe(price.credits)
    const [subject, background] = [rec.values![0], rec.values![1]] as Extract<RunnerValue, { kind: 'files' }>[]
    expect(subject!.files[0]!.filename).toMatch(/^split_subject_\d{5}_\.png$/)
    expect(background!.files[0]!.filename).toMatch(/^split_background_\d{5}_\.png$/)
    await expectOutputs(c, readOut(k, subject!.files[0]!), readOut(k, background!.files[0]!))
    expect(rec.outputs).toEqual([subject!.files[0], background!.files[0]])
    const shown = ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')?.output
    expect(shown).toEqual({ images: rec.outputs, animated: [false] })
  })
})

describe('hold and charge (hosted)', () => {
  it('held and charged both calls: LaMa 2 credits, Bria Eraser 9', async () => {
    for (const [name, credits] of [['split · LaMa · mask_grow 12 · RGB input', 2], ['split · Bria · mask_grow 12 · RGB input', 9]] as const) {
      const { k, rec } = await kitRun(caseNamed(name), { hosted: true })
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(rec.credits).toBe(credits)
      expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'done']])
      expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[credits, credits]])
    }
  })

  it('a fill that fails at the provider charges the cut-out only (1 of 9)', async () => {
    const { k, rec } = await kitRun(caseNamed('split · Bria · mask_grow 12 · RGB input'), { hosted: true, failFill: true })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'error']])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[9, 1]])
    // Nothing saved as an asset: the cut-out was only kept for the run.
    expect(readdirSync(join(k.root, 'output'), { recursive: true }).filter(f => String(f).includes('split_'))).toEqual([])
  })

  it('a background that can\'t be downloaded: the fill wasn\'t delivered, so the cut-out alone is charged', async () => {
    const { k, rec } = await kitRun(caseNamed('split · Bria · mask_grow 1 · RGB input'), { hosted: true, failBackground: true })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status, !!x.lost])).toEqual([['cutout', 'done', false], ['fill', 'done', true]])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[9, 1]])
  })

  it('a cut-out answer with no picture fails plainly after its call, which is charged; no fill is sent', async () => {
    const { k, rec, sent } = await kitRun(caseNamed('split · a cut-out answer with no output'), { hosted: true })
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(SPLIT_NO_SUBJECT)
    expect(rec.error).not.toMatch(/Node|_|Replicate/)
    expect(sent.map(s => s.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[2, 1]])
  })

  it('a picture that isn\'t the user\'s own is refused before the hold', async () => {
    const c = caseNamed('split · LaMa · mask_grow 12 · RGB input')
    const replicate = answersFor(c)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, ownership: { ownsInput: async () => false, ownsOutput: async () => false } } })
    writeFileSync(join(k.root, 'input', 'image.png'), b64(c.picture_files!.image!))
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.client.submit).not.toHaveBeenCalled()
  })
})

describe('resumed after a restart', () => {
  it('a restart after the cut-out goes on at the fill: the cut-out isn\'t sent or downloaded again, the fill is sent once', async () => {
    const c = caseNamed('split · Bria · mask_grow 12 · RGB input')
    const replicate = answersFor(c)
    const hang = { on: true }
    const submit = replicate.client.submit
    replicate.client.submit = (async (slug: string, ...rest: unknown[]) => {
      if (hang.on && slug !== SPLIT_CUTOUT_SLUG) await new Promise<void>(() => {})
      return (submit as (...a: unknown[]) => Promise<unknown>)(slug, ...rest)
    }) as typeof submit
    const gets: string[] = []
    const download = async (url: string) => {
      gets.push(url)
      return { bytes: b64(c.files![url]!), contentType: 'image/png' }
    }
    // The run store and its kept bytes on disk, as the server keeps them (index.ts): both survive the restart.
    const dir = mkdtempSync(join(tmpdir(), 'runner-split-resume-'))
    const kept = createFileKeptBytes(join(dir, 'kept'))
    const k1 = makeKit({ hosted: true, dir, replicate, deps: { families: () => ON, download, kept } })
    writeFileSync(join(k1.root, 'input', 'image.png'), b64(c.picture_files!.image!))
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [promptOf(c)], ...START })
    const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 1000 && !(await ok()); i++) await new Promise(r => setTimeout(r, 5)) }
    await until(async () => (await k1.store.get(runId))!.takes[0]!.nodes.n!.calls?.some(x => x.key === 'fill') ?? false)
    const mid = (await k1.store.get(runId))!.takes[0]!.nodes.n!
    expect(mid.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'sent']])
    expect(gets).toEqual(['https://r.test/split/cutout.png'])
    hang.on = false
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger, deps: { families: () => ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(replicate.submitted().map(r => r.endpoint)).toEqual([SPLIT_CUTOUT_SLUG, BRIA])
    // The cut-out's bytes were kept for the run: downloaded once, never again.
    expect(gets).toEqual(['https://r.test/split/cutout.png', 'https://r.test/split/background.png'])
    await expectOutputs(c, readOut(k2, rec.outputs[0]!), readOut(k2, rec.outputs[1]!))
    expect([...k1.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[9, 9]])
  })
})

describe('prices (ruling (a))', () => {
  it('the fill engines\' cards, read from their pages; the cut-out is Remove background\'s card; none duplicates another card', () => {
    expect(PAID_RATES[LAMA]).toEqual({
      unit: 'gpu_ceiling', usd: 0.0007, note: 'T4 at $0.000225/s; page: approximately $0.00068 to run (read 2026-09-27), rounded up to the next $0.0001',
      service: 'replicate', source: 'https://replicate.com/zylim0702/remove-object', read: '2026-09-27', confidence: 'estimate',
    })
    expect(PAID_RATES[BRIA]).toEqual({
      unit: 'per_call', usd: 0.04, service: 'replicate', source: 'https://replicate.com/bria/eraser', read: '2026-09-27', confidence: 'verified',
    })
    expect(PAID_RATES[SPLIT_CUTOUT_SLUG]).toMatchObject({ unit: 'gpu_ceiling', usd: 0.0004, confidence: 'estimate' })
    for (const e of [LAMA, BRIA]) expect(otherCardFor(e), e).toBeNull()
  })

  it('priced by its calls with no flat row; the price book moved on', () => {
    expect(PAID_NODE_CLASSES).toContain(SPLIT_CLASS)
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, SPLIT_CLASS)).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-split')
  })

  it('the hold is the cut-out and the fill, each call\'s own credits: LaMa 1 + 1, Bria Eraser 1 + 8; a wired, missing or unknown engine at the dearer', () => {
    expect([callCredits({ usd: 0.0004 }), callCredits({ usd: 0.0007 }), callCredits({ usd: 0.04 })]).toEqual([1, 1, 8])
    const img = { image: ['p', 0], mask_grow: 12 }
    const want: [Record<string, unknown>, number][] = [
      [{ background_fill: 'LaMa (fast)' }, 2],
      [{ background_fill: 'Bria Eraser (quality)' }, 9],
      [{ background_fill: ['x', 0] }, 9],
      [{}, 9],
      [{ background_fill: 'Flux Fill' }, 9],
    ]
    for (const [inputs, credits] of want) {
      expect((priceNode(SPLIT_CLASS, { ...img, ...inputs }) as { credits: number }).credits, JSON.stringify(inputs)).toBe(credits)
      expect(priceGraph({ 1: { class_type: SPLIT_CLASS, inputs: { ...img, ...inputs } } }).nodes!['1'], JSON.stringify(inputs)).toBe(credits)
    }
    // Two calls, never the matte a cut-out without alpha would need (it can't happen).
    for (const fill of PHOTO_FILLS) {
      const p = paidCalls(SPLIT_CLASS, { ...img, background_fill: fill }, {})
      expect(p).toEqual({ steps: [{ call: { endpoint: SPLIT_CUTOUT_SLUG }, times: 1 }, { call: { endpoint: PHOTO_FILL_SLUGS[fill] }, times: 1 }] })
    }
  })

  it('nothing is free: every run makes its calls', () => {
    expect(paidNoCall(SPLIT_CLASS, {})).toBe(false)
  })
})

describe('moderation', () => {
  it('sends no text of the user\'s: nothing to moderate', () => {
    expect(Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, SPLIT_CLASS)).toBe(false)
    expect(extraPromptTexts({ n: { class_type: SPLIT_CLASS, inputs: { background_fill: 'LaMa (fast)', mask_grow: 12 } } })).toEqual([])
  })
})

describe('with layers off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but layers', RUNNER_FAMILIES.filter(f => f !== 'layers')],
  ]
  const isMine = (ct: string) => ct === SPLIT_CLASS
  /** The same prompt as before R3.7: the class had no rule row and was no picture (renamed to one that has neither). */
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
  const sample = CASES[0]!

  it('the class is left to the engine and named by the needs-the-engine list; on, the runner takes it', () => {
    const p = promptOf(sample)
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
    expect(RUNNER_OUTPUT_CLASSES.has(SPLIT_CLASS)).toBe(true)
    expect(IMAGE_OUTPUT_CLASSES.has(SPLIT_CLASS)).toBe(false)
    // Its two pictures are pictures only while layers is on: not in PICTURE_OUTPUTS (cards alone).
    expect(Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, SPLIT_CLASS)).toBe(false)
    expect(PAID_PICTURE_FAMILY[SPLIT_CLASS]).toBe('layers')
    expect(PAID_PICTURE_SLOTS[SPLIT_CLASS]).toEqual([0, 1])
    expect(RUNNER_NODE_RULES[SPLIT_CLASS]!.family).toBe('layers')
    expect(outputKindsFor(ON)[SPLIT_CLASS]).toBeUndefined()
    expect(RUNNER_ROUTES[SPLIT_CLASS]).toMatchObject({ first: 'replicate', backup: null })
  })

  it('both pictures feed the runner while layers is on (a Preview image on each slot); off, the engine takes the chain', () => {
    for (const slot of [0, 1]) {
      const p: ApiPrompt = { ...promptOf(sample), s: { class_type: 'PreviewImage', inputs: { images: ['n', slot] } } }
      expect(runnerTakesNode(p, 's', ON), `slot ${slot}`).toBe(true)
      expect(isRunnerEligible(p, ON), `slot ${slot}`).toBe(true)
      expect(runnerTakesNode(p, 's', new Set(['cards'])), `slot ${slot}`).toBe(false)
    }
    const third: ApiPrompt = { ...promptOf(sample), s: { class_type: 'PreviewImage', inputs: { images: ['n', 2] } } }
    expect(runnerTakesNode(third, 's', ON)).toBe(false)
  })

  it('an engine the node doesn\'t offer, a mask_grow out of range, or a wired setting is left to the engine (ComfyUI refuses it before running)', () => {
    for (const w of [{ background_fill: 'Flux Fill' }, { mask_grow: 51 }, { mask_grow: -1 }, { mask_grow: ['x', 0] }, { background_fill: ['x', 0] }]) {
      const p = promptOf({ ...sample, widgets: { ...sample.widgets, ...w } })
      expect(runnerTakesNode(p, 'n', ON), JSON.stringify(w)).toBe(false)
    }
  })

  it('over synthetic chains: into a Frame (either slot), into Outpaint, from Remove background', () => {
    const p = promptOf(sample)
    sameAsBefore(p, 'alone')
    for (const slot of [0, 1]) sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', slot], width: 0, height: 0 } } }, `→ Frame ${slot}`)
    sameAsBefore({ ...p, o: { class_type: 'OutpaintImageNode', inputs: { model: 'Flux Fill', prompt: '', direction: 'Zoom out 1.5x', aspect_ratio: '16:9', seed: 0, image: ['n', 1] } } }, '→ Outpaint')
    sameAsBefore({
      ...p,
      r: { class_type: 'RemoveBackgroundNode', inputs: { model: 'Remove Background', image: ['p_image', 0] } },
      n: { ...p.n!, inputs: { ...p.n!.inputs, image: ['r', 0] } },
    }, 'Remove background →')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Separate background and foreground spliced in beside each)', async () => {
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
          d_sp: { class_type: SPLIT_CLASS, inputs: { background_fill: 'LaMa (fast)', mask_grow: 12, image: ['d_img', 0] } },
          d_f: { class_type: 'Compositor', inputs: { layer1: ['d_sp', 1], layer2: ['d_sp', 0], width: 0, height: 0 } },
        }, `${uuid} + Split → Frame`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`split families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})
