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
import { SPLIT_NO_BACKGROUND, SPLIT_NO_SUBJECT, SPLIT_SIZES_DIFFER } from '~~/server/runner/generators/splitLayers'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { maxFilterCore, maxFilterL } from '~~/server/runner/pixels/maxFilter'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { PICTURE_CMYK, pilRaw, pilRgba } from '~~/server/runner/pictures/pythonView'
import { pilPixels, pilPixelsCore } from '~~/server/runner/pixels/pilPixels'
import { cardPictureFiles } from '~~/server/runner/cards/bakeReplay'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

/** A split case: a paid case, plus what the fixture adds for this group. */
type SplitCase = PaidCase & {
  /** Each alpha-dropped picture Python encoded (`PNG:<sha256>`), by its decoded pixels. */
  made: Record<string, { shape: number[]; sha256: string }>
  /** Each picture input as Python's tensor holds it (the loader's view, EXIF turned; or RGBA as downloaded), by its 8-bit pixels. */
  loaded: Record<string, { shape: number[]; sha256: string }>
  picture_modes?: Record<string, string>
}
interface MaxFilterRow { w: number; h: number; size: number; sha256: string; out?: string }
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-split.json'), 'utf8')) as {
  cases: SplitCase[]; maxfilter: MaxFilterRow[]; masks: Record<string, string>
}
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'layers'])
/** With a Remove background upstream (a node whose Python picture is RGBA): its family too. */
const ON_WITH_REMOVER: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'layers', 'image-repair'])
const LAMA = PHOTO_FILL_SLUGS['LaMa (fast)']
const BRIA = PHOTO_FILL_SLUGS['Bria Eraser (quality)']
const IMAGE_URL = 'https://fal.storage/image.png'
const IMAGE_FILE: OutputFile = { filename: 'image.png', subfolder: '', type: 'input' }
/** Where the upstream Remove background's answer is served from (the case's input picture, RGBA). */
const REMOVED_URL = 'https://r.test/upstream/removed.png'
const CUTOUT_URL = 'https://r.test/split/cutout.png'
const BACKGROUND_URL = 'https://r.test/split/background.png'
/** The case the runner refuses where Python sends a mask of another shape (fix round 1). */
const SIZES_DIFFER_CASE = 'split · a cut-out larger than the picture'

const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no case ${name}`)
  return c
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const isRgba = (c: SplitCase) => c.picture_modes?.image === 'RGBA'
const isExif = (c: SplitCase) => /EXIF/.test(c.name)

/**
 * Where the node's picture comes from, as Python's tensor would have it:
 * a LoadImage or an Image card (the loader's view: EXIF turned, RGB), or a
 * Remove background upstream (a downloaded picture: RGBA, not turned) for
 * the RGBA cases (fix round 1: an Image card is RGB in Python).
 */
type Source = 'LoadImage' | 'Image' | 'Removed'
const sourceOf = (c: SplitCase): Source => (isRgba(c) ? 'Removed' : 'LoadImage')

function promptOf(c: SplitCase, source: Source = sourceOf(c)): ApiPrompt {
  const n = { class_type: c.class_type, inputs: { ...c.widgets, image: ['p_image', 0] } }
  if (source === 'Image') {
    return { p_image: { class_type: 'Image', inputs: { image: 'image.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }, n }
  }
  const load = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
  if (source === 'LoadImage') return { p_image: load, n }
  return {
    p_load: load,
    p_image: { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['p_load', 0] } },
    n,
  }
}

async function planOf(c: SplitCase): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: promptOf(c), nodeId: 'n', gateOpen: false,
    // The picture the source hands on: the loader's file, or the remover's saved answer.
    filesFrom: link => (link[0] === 'p_image' ? [isRgba(c) ? { ...IMAGE_FILE, type: 'output' as const } : IMAGE_FILE] : []),
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
 * The calls the runner sent against Python's, in order:
 *  - the cut-out's picture is Python's picture (`IMG:image`) by its pixels
 *    (the loader's view, EXIF turned, or the RGBA download), and its payload
 *    otherwise deep-equal and wire-equal;
 *  - the fill's endpoint and keys, its mask's pixels exactly (PIL's and
 *    sharp's PNG encoders write other bytes for the same pixels), and its
 *    picture: the cut-out's own when Python sends the same tensor, else an
 *    RGB copy whose pixels are Python's;
 *  - the mask and the fill picture have one shape (fix round 1).
 */
async function expectSplitCalls(sent: SentCall[], c: SplitCase, bytesOf: (url: string) => Uint8Array | undefined): Promise<void> {
  const want = c.name === SIZES_DIFFER_CASE ? 1 : c.calls.length
  expect(sent.length, 'the number of calls').toBe(want)
  const picture = String(sent[0]!.payload.image)
  for (const [i, py] of c.calls.slice(0, want).entries()) {
    const got = sent[i]!
    expect([got.provider, got.endpoint], `call ${i + 1}`).toEqual([py.provider, py.endpoint])
    if (i === 0) {
      expect(py.payload.image).toBe('IMG:image')
      const bytes = bytesOf(picture)
      expect(bytes, 'the picture was handed off').toBeDefined()
      const px = await pixels(bytes!)
      expect(px.shape).toEqual(c.loaded.image!.shape)
      expect(sha(px.data), `${c.name}: Python's picture`).toBe(c.loaded.image!.sha256)
      const payload = { ...got.payload, image: 'IMG:image' }
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
      expect(got.payload.image).toBe(picture)
    }
    else {
      const made = c.made[pyImage]!
      expect(made, pyImage).toBeDefined()
      expect(got.payload.image).not.toBe(picture)
      const copy = await pixels(bytesOf(String(got.payload.image))!)
      expect(copy.shape).toEqual(made.shape)
      expect(sha(copy.data), `${c.name}: the RGB copy`).toBe(made.sha256)
    }
    // One shape for the mask and the picture it is laid on.
    const fill = await pixels(bytesOf(String(got.payload.image))!)
    expect(a.shape, `${c.name}: mask and fill picture`).toEqual(fill.shape.slice(0, 2))
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
  it('covers both fill engines, mask_grow 0, 1, 12 and 50, RGB and RGBA inputs, EXIF-turned photos, the cut-outs PIL reads its own way, and the failures', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set([SPLIT_CLASS]))
    for (const fill of ['LaMa', 'Bria']) {
      for (const grow of [0, 1, 12, 50]) {
        for (const mode of ['RGB', 'RGBA']) expect(names.has(`split · ${fill} · mask_grow ${grow} · ${mode} input`), `${fill} ${grow} ${mode}`).toBe(true)
      }
    }
    for (const n of ['a picture 50 px wide, mask_grow 50', 'a cut-out with no alpha (no matte call)', 'a cut-out in CMYK JPEG', 'a cut-out in 16-bit grey',
      'a cut-out in grey and alpha', 'a cut-out in palette with transparency', 'a background in CMYK JPEG', 'a background in 16-bit grey',
      'an EXIF-6 JPEG from the loader', 'an EXIF-3 PNG from the loader',
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

  it('the EXIF photos: Python\'s picture is the turned one (a 36 × 48 JPEG tagged 6 is sent 48 × 36)', async () => {
    const six = caseNamed('split · an EXIF-6 JPEG from the loader')
    const stored = await sharp(b64(six.picture_files!.image!)).metadata()
    expect([stored.width, stored.height, stored.orientation]).toEqual([36, 48, 6])
    expect(six.loaded.image!.shape).toEqual([36, 48, 3])
    const three = caseNamed('split · an EXIF-3 PNG from the loader')
    expect((await sharp(b64(three.picture_files!.image!)).metadata()).orientation).toBe(3)
  })

  // R3.2's note, proven: a downloaded picture is always read as RGBA, so the remover's matte is never asked for.
  it('Python never makes the third (matte) call: a cut-out with no alpha is read as fully opaque, and the fill follows', async () => {
    const c = caseNamed('split · a cut-out with no alpha (no matte call)')
    const cutout = await sharp(b64(c.files![CUTOUT_URL]!)).metadata()
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

describe('the per-pixel work on the Frame\'s worker (fix round 1)', () => {
  it('Split\'s mask and RGB copy come from the worker, as PIL reads the picture (CMYK and 16-bit grey included); Stop stops the core', async () => {
    for (const name of ['split · a cut-out in CMYK JPEG', 'split · a cut-out in 16-bit grey', 'split · Bria · mask_grow 12 · RGB input']) {
      const c = caseNamed(name)
      const raw = await pilRaw(b64(c.files![CUTOUT_URL]!))
      const inThread = pilPixels.alphaOf(raw)
      const grown = await pixelsInWorker(undefined, w => w.splitMask({ ...raw, data: raw.data.slice() }, 25))
      expect(sha(grown), name).toBe(sha(maxFilterL(inThread, raw.width, raw.height, 25)))
      const rgb = await pixelsInWorker(undefined, w => w.rgbOf({ ...raw, data: raw.data.slice() }))
      const { data } = await pilRgba(b64(c.files![CUTOUT_URL]!))
      expect(sha(rgb), name).toBe(sha(Uint8Array.from({ length: raw.width * raw.height * 3 }, (_, i) => data[Math.floor(i / 3) * 4 + (i % 3)]!)))
    }
    const cmyk = await pilRaw(b64(caseNamed('split · a cut-out in CMYK JPEG').files![CUTOUT_URL]!))
    expect(cmyk.kind).toBe('cmyk')
    expect(() => pilPixelsCore().toRgba(cmyk, () => true)).toThrow('Stopped')
    expect(() => pilPixelsCore().rgbOf({ ...cmyk, kind: 'rgba' }, () => true)).toThrow('Stopped')
  })
})

describe('every fixture case: what Python sends and returns (the plan, run by hand)', () => {
  const offSchema: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const r = await runByHand(c)
    if (c.name === SIZES_DIFFER_CASE) {
      // The documented difference (fix round 1): Python sends a 60 × 45 mask with a 48 × 36 picture; the runner refuses before the fill.
      await expect(r.run()).rejects.toThrow(SPLIT_SIZES_DIFFER)
    }
    else if (c.error) {
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
    // A copy is handed off for an RGBA download (its RGB) or a turned photo (the loader's picture); a plain RGB PNG is sent as it is.
    expect([...r.handed.keys()].includes('https://fal.storage/split_image.png')).toBe(isRgba(c) || isExif(c))
  })

  it('every payload fits its published schema', () => {
    expect(offSchema).toEqual([])
  })
})

// ── Through the engine (cards and layers on) ────────────────────────────────

type CallKind = 'cutout' | 'fill' | 'upstream'
const kindOf = (slug: string, payload: Record<string, unknown>): CallKind =>
  (slug !== SPLIT_CUTOUT_SLUG ? 'fill' : payload.background_type === 'rgba' ? 'cutout' : 'upstream')

interface KitRunOptions {
  hosted?: boolean
  source?: Source
  /** Before each submission (by what it is): fail it, hold it, hang it. */
  onSubmit?: (kind: CallKind, replicate: ReturnType<typeof createFakeReplicate>) => Promise<void> | void
  /** A download that fails outright. */
  failUrl?: string
  ownership?: { ownsInput: () => Promise<boolean>; ownsOutput: () => Promise<boolean> }
}

/**
 * A fake Replicate answering in submission order: the upstream Remove
 * background (when there is one) with the case's input picture, then the
 * case's own answers; `onSubmit` sees each submission first.
 */
function replicateFor(c: SplitCase, o: { upstream?: boolean; onSubmit?: KitRunOptions['onSubmit'] } = {}) {
  const queue: unknown[] = [...(o.upstream ? [{ output: REMOVED_URL }] : []), ...c.answers]
  const answerOf = new Map<unknown, unknown>()
  const replicate = createFakeReplicate({
    bodyText: ({ input }) => JSON.stringify({ id: 'p', status: 'succeeded', ...(answerOf.get(input) as object) }),
  })
  const submit = replicate.client.submit
  replicate.client.submit = (async (slug: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
    await o.onSubmit?.(kindOf(slug, payload), replicate)
    answerOf.set(payload, queue.shift())
    return (submit as (...a: unknown[]) => Promise<unknown>)(slug, payload, ...rest)
  }) as typeof submit
  return replicate
}

/** The case's served files, and the upstream remover's answer (the input picture as downloaded). */
const servedFor = (c: SplitCase): Record<string, string> => ({ ...c.files, [REMOVED_URL]: c.picture_files!.image! })

async function kitRun(c: SplitCase, o: KitRunOptions = {}) {
  const source = o.source ?? sourceOf(c)
  const replicate = replicateFor(c, { upstream: source === 'Removed', onSubmit: o.onSubmit })
  const served = servedFor(c)
  const gets: string[] = []
  const download = vi.fn(async (url: string) => {
    gets.push(url)
    if (url === o.failUrl) throw new Error('Could not download the result (500)')
    return { bytes: b64(served[url]!), contentType: 'image/png' }
  })
  const families = source === 'Removed' ? ON_WITH_REMOVER : ON
  const k = makeKit({ hosted: o.hosted, replicate, deps: { families: () => families, download, ...(o.ownership ? { ownership: o.ownership } : {}) } })
  writeFileSync(join(k.root, 'input', 'image.png'), b64(c.picture_files!.image!))
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c, source)], ...START })
  return { k, runId, replicate, gets, download }
}

async function kitDone(c: SplitCase, o: KitRunOptions = {}) {
  const r = await kitRun(c, o)
  await r.k.engine.settled(r.runId)
  const rec = (await r.k.store.get(r.runId))!.takes[0]!.nodes.n!
  const uploads = new Map((r.k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([bytes, name]) => [`https://fal.storage/${name}`, bytes]))
  // Split's own calls (an upstream Remove background's call is its own node's).
  const sent = r.replicate.submitted().filter(x => kindOf(x.endpoint, x.payload) !== 'upstream').map(x => ({ provider: 'replicate', endpoint: x.endpoint, payload: x.payload }))
  return { ...r, rec, sent, uploads }
}

const readOut = (k: { root: string }, f: OutputFile) => new Uint8Array(readFileSync(join(k.root, f.type, f.subfolder, f.filename)))
/** What the ledger charged: a released hold charged nothing. */
const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

describe('every fixture case through the engine (cards and layers on)', () => {
  const calling = CASES.filter(c => !c.error && c.name !== SIZES_DIFFER_CASE)

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, kept and priced', async (_n, c) => {
    // An RGBA picture comes from a node whose Python picture is RGBA: a Remove background upstream.
    const { k, rec, sent, uploads } = await kitDone(c)
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

  // Fix round 1, finding 1: a phone photo behind an Image card is Python's loader picture (EXIF turned), for both calls.
  it.each(CASES.filter(isExif).map(c => [c.name, c] as const))('%s behind an Image card — the turned picture to both calls, Python\'s mask and outputs', async (_n, c) => {
    const { k, rec, sent, uploads } = await kitDone(c, { source: 'Image' })
    expect(rec.status, rec.error ?? '').toBe('done')
    await expectSplitCalls(sent, c, u => uploads.get(u))
    expect(sent[0]!.payload.image).toBe('https://fal.storage/split_image.png')
    expect(sent[1]!.payload.image).toBe(sent[0]!.payload.image)
    await expectOutputs(c, readOut(k, rec.outputs[0]!), readOut(k, rec.outputs[1]!))
  })
})

describe('the start of the take (fix round 1, finding 7)', () => {
  it('an Image card\'s file behind Split is checked by its header before the hold: a CMYK JPEG is refused in plain words', async () => {
    const c = caseNamed('split · LaMa · mask_grow 12 · RGB input')
    const replicate = replicateFor(c)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), b64(caseNamed('split · a cut-out in CMYK JPEG').files![CUTOUT_URL]!))
    const p = promptOf(c, 'Image')
    expect(cardPictureFiles(p, ON)).toEqual([{ nodeId: 'p_image', classType: 'Image', file: IMAGE_FILE }])
    expect(cardPictureFiles(p, new Set(['cards']))).toEqual([])
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(PICTURE_CMYK)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
  })
})

const BRIA_CASE = 'split · Bria · mask_grow 12 · RGB input'

describe('hold and charge (hosted)', () => {
  it('held and charged both calls: LaMa 2 credits, Bria Eraser 9', async () => {
    for (const [name, credits] of [['split · LaMa · mask_grow 12 · RGB input', 2], [BRIA_CASE, 9]] as const) {
      const { k, rec } = await kitDone(caseNamed(name), { hosted: true })
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(rec.credits).toBe(credits)
      expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'done']])
      expect(charged(k)).toEqual([[credits, credits]])
    }
  })

  it('a cut-out that fails at the provider charges nothing; no fill is sent', async () => {
    const { k, rec, sent } = await kitDone(caseNamed(BRIA_CASE), { hosted: true, onSubmit: (kind, rep) => { if (kind === 'cutout') rep.failNext(1) } })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'error']])
    expect(sent.map(s => s.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect(charged(k)).toEqual([[9, 0]])
  })

  it('a cut-out that can\'t be downloaded wasn\'t delivered: nothing charged, no fill sent', async () => {
    const { k, rec, sent } = await kitDone(caseNamed(BRIA_CASE), { hosted: true, failUrl: CUTOUT_URL })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status, !!x.lost])).toEqual([['cutout', 'done', true]])
    expect(sent.map(s => s.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect(charged(k)).toEqual([[9, 0]])
  })

  it('a fill that fails at the provider charges the cut-out only (1 of 9)', async () => {
    const { k, rec } = await kitDone(caseNamed(BRIA_CASE), { hosted: true, onSubmit: (kind, rep) => { if (kind === 'fill') rep.failNext(1) } })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'error']])
    expect(charged(k)).toEqual([[9, 1]])
    // Nothing saved as an asset: the cut-out was only kept for the run.
    expect(readdirSync(join(k.root, 'output'), { recursive: true }).filter(f => String(f).includes('split_'))).toEqual([])
  })

  it('a background that can\'t be downloaded: the fill wasn\'t delivered, so the cut-out alone is charged', async () => {
    const { k, rec } = await kitDone(caseNamed('split · Bria · mask_grow 1 · RGB input'), { hosted: true, failUrl: BACKGROUND_URL })
    expect(rec.status).toBe('error')
    expect(rec.calls!.map(x => [x.key, x.status, !!x.lost])).toEqual([['cutout', 'done', false], ['fill', 'done', true]])
    expect(charged(k)).toEqual([[9, 1]])
  })

  it('a cut-out answer with no picture fails plainly after its call, which is charged; no fill is sent', async () => {
    const { k, rec, sent } = await kitDone(caseNamed('split · a cut-out answer with no output'), { hosted: true })
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(SPLIT_NO_SUBJECT)
    expect(rec.error).not.toMatch(/Node|_|Replicate/)
    expect(sent.map(s => s.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect(charged(k)).toEqual([[2, 1]])
  })

  it('a cut-out of another size than the picture is refused before the fill is paid for; the cut-out is charged', async () => {
    const { k, rec, sent } = await kitDone(caseNamed(SIZES_DIFFER_CASE), { hosted: true })
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(SPLIT_SIZES_DIFFER)
    expect(sent.map(s => s.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect(charged(k)).toEqual([[2, 1]])
  })

  it('a picture that isn\'t the user\'s own is refused before the hold', async () => {
    const c = caseNamed('split · LaMa · mask_grow 12 · RGB input')
    const replicate = replicateFor(c)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, ownership: { ownsInput: async () => false, ownsOutput: async () => false } } })
    writeFileSync(join(k.root, 'input', 'image.png'), b64(c.picture_files!.image!))
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
  })
})

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 2000 && !(await ok()); i++) await new Promise(r => setTimeout(r, 5))
  expect(await ok(), 'the run reached the point').toBe(true)
}
const callOf = async (k: { store: { get(id: string): Promise<any> } }, runId: string, key: string) =>
  ((await k.store.get(runId))!.takes[0]!.nodes.n!.calls ?? []).find((x: { key: string }) => x.key === key) as { status: string; request: unknown } | undefined

describe('Stop (hosted)', () => {
  it('Stop while the cut-out runs: nothing charged, no fill sent', async () => {
    const c = caseNamed(BRIA_CASE)
    const { k, runId, replicate } = await kitRun(c, { hosted: true, onSubmit: (kind, rep) => { if (kind === 'cutout') rep.holdNext(1) } })
    await until(async () => !!(await callOf(k, runId, 'cutout'))?.request)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([SPLIT_CUTOUT_SLUG])
    expect(replicate.submitted()[0]!.cancelled).toBe(true)
    expect(charged(k)).toEqual([[9, 0]])
  })

  it('Stop while the fill runs: the fill is cancelled, the cut-out charged (1)', async () => {
    const c = caseNamed(BRIA_CASE)
    const { k, runId, replicate } = await kitRun(c, { hosted: true, onSubmit: (kind, rep) => { if (kind === 'fill') rep.holdNext(1) } })
    await until(async () => !!(await callOf(k, runId, 'fill'))?.request)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(replicate.submitted().map(x => [x.endpoint, x.cancelled])).toEqual([[SPLIT_CUTOUT_SLUG, false], [BRIA, true]])
    expect(charged(k)).toEqual([[9, 1]])
  })
})

describe('resumed after a restart', () => {
  type Point = 'the cut-out in flight' | 'the fill not yet sent' | 'the fill in flight' | 'the fill done, its picture not yet downloaded'
  const POINTS: Point[] = ['the cut-out in flight', 'the fill not yet sent', 'the fill in flight', 'the fill done, its picture not yet downloaded']

  it.each(POINTS.map(p => [p] as const))('restarted with %s: each call sent once, the cut-out downloaded once, done and charged 9 of 9', async (point) => {
    const c = caseNamed(BRIA_CASE)
    const hang = { on: true }
    const never = () => new Promise<never>(() => {})
    const replicate = replicateFor(c, { onSubmit: async (kind) => { if (hang.on && point === 'the fill not yet sent' && kind === 'fill') await never() } })
    const gets: string[] = []
    const download = async (url: string) => {
      gets.push(url)
      if (hang.on && point === 'the fill done, its picture not yet downloaded' && url === BACKGROUND_URL) await never()
      return { bytes: b64(c.files![url]!), contentType: 'image/png' }
    }
    // The first server stops following a job at the point (its polls never answer): the second takes over.
    const status = replicate.client.status
    const hungStatus = (async (url: string, ...rest: unknown[]) => {
      const id = /^replicate:\/\/(pred\d+)/.exec(url)![1]!
      const endpoint = replicate.reqs.get(id)?.endpoint
      if ((point === 'the cut-out in flight' && endpoint === SPLIT_CUTOUT_SLUG) || (point === 'the fill in flight' && endpoint === BRIA)) return never()
      return (status as (...a: unknown[]) => Promise<unknown>)(url, ...rest)
    }) as typeof status
    // The run store and its kept bytes on disk, as the server keeps them (index.ts): both survive the restart.
    const dir = mkdtempSync(join(tmpdir(), 'runner-split-resume-'))
    const k1 = makeKit({ hosted: true, dir, replicate: { ...replicate, client: { ...replicate.client, status: hungStatus } }, deps: { families: () => ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
    writeFileSync(join(k1.root, 'input', 'image.png'), b64(c.picture_files!.image!))
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [promptOf(c)], ...START })
    const reached: Record<Point, () => Promise<boolean>> = {
      'the cut-out in flight': async () => !!(await callOf(k1, runId, 'cutout'))?.request,
      'the fill not yet sent': async () => (await callOf(k1, runId, 'fill'))?.status === 'sent',
      'the fill in flight': async () => !!(await callOf(k1, runId, 'fill'))?.request,
      'the fill done, its picture not yet downloaded': async () => gets.includes(BACKGROUND_URL),
    }
    await until(reached[point])
    await new Promise(r => setTimeout(r, 30))
    hang.on = false
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, replicate, ledger: k1.ledger, deps: { families: () => ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(replicate.submitted().map(r => r.endpoint)).toEqual([SPLIT_CUTOUT_SLUG, BRIA])
    // The cut-out's bytes were kept for the run: downloaded once, never again.
    expect(gets.filter(u => u === CUTOUT_URL)).toEqual([CUTOUT_URL])
    expect(gets.filter(u => u === BACKGROUND_URL).length).toBe(point === 'the fill done, its picture not yet downloaded' ? 2 : 1)
    await expectOutputs(c, readOut(k2, rec.outputs[0]!), readOut(k2, rec.outputs[1]!))
    expect(charged(k1)).toEqual([[9, 9]])
  })
})

describe('prices (ruling (a))', () => {
  it('the fill engines\' cards, read from their pages; the cut-out is Remove background\'s card; none duplicates another card', () => {
    expect(PAID_RATES[LAMA]).toEqual({
      // R7.11: raised from $0.0007 after the live check measured 3.14–3.20 s on T4 at 1152² ($0.00072).
      unit: 'gpu_ceiling', usd: 0.0015, note: 'T4 at $0.000225/s; page: approximately $0.00068 to run (read 2026-09-27); live check 2026-10-01: 3.14–3.20 s at 1152² = $0.00072; ceiling 6.7 s (about 2.1× measured)',
      service: 'replicate', source: 'https://replicate.com/zylim0702/remove-object', read: '2026-10-01', confidence: 'verified',
    })
    expect(PAID_RATES[BRIA]).toEqual({
      unit: 'per_call', usd: 0.04, service: 'replicate', source: 'https://replicate.com/bria/eraser', read: '2026-09-27', confidence: 'verified',
    })
    expect(PAID_RATES[SPLIT_CUTOUT_SLUG]).toMatchObject({ unit: 'gpu_ceiling', usd: 0.0008, confidence: 'verified' })
    for (const e of [LAMA, BRIA]) expect(otherCardFor(e), e).toBeNull()
  })

  it('priced by its calls with no flat row; the price book moved on', () => {
    expect(PAID_NODE_CLASSES).toContain(SPLIT_CLASS)
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, SPLIT_CLASS)).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-sound-in')
  })

  it('the hold is the cut-out and the fill, each call\'s own credits: LaMa 1 + 1, Bria Eraser 1 + 8; a wired, missing or unknown engine at the dearer', () => {
    expect([callCredits({ usd: 0.0008 }), callCredits({ usd: 0.0015 }), callCredits({ usd: 0.04 })]).toEqual([1, 1, 8])
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
