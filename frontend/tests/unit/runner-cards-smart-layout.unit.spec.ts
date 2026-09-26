/**
 * R1.6: Smart Layout, ported against the real Python node
 * (scripts/runner_cards_fixtures.py → fixtures/runner-cards.json, key
 * `smart_layout`): the pure functions deep-equal Python's; the render
 * requests JSON-value-equal the bodies Python POSTs, image layers compared by
 * their pixels; each render decoded to RGB and named as Python's live
 * previews. The render itself moved out of the route unchanged (a snapshot
 * of the route's bytes before the move). And run by the engine behind `cards`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { CARD_MAX_PIXELS, isRunnerEligible } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { brandOf, livePreviewName, smartLayoutPixels } from '#shared/runner/smartLayout'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore } from '~~/server/runner/results'
import {
  LAYOUT_TOO_LARGE, autopopulateForTemplate, outputLabels, parseLayout, parseTextLayers, resolveOutputs,
  smartLayoutRenderer, smartLayoutRequests,
} from '~~/server/runner/cards/smartLayout'
import { renderTemplatePng } from '~~/server/templates/renderPng'
import type { RenderRequest } from '~~/server/templates/schema'
import type { OutputFile } from '~~/server/runner/types'

type Via = 'provider' | 'card' | 'load'
interface Frame { w: number; h: number; mode: 'RGB' | 'RGBA'; px: string }
interface ExecuteCase {
  name: string; inputs: Record<string, string>; node_id: string
  error?: string
  bodies: Record<string, unknown>[]
  frames: Record<string, Frame>
  files: Record<string, string>; via: Record<string, Via>; names: Record<string, string>
  outputs?: { shape: number[]; rgb8: string }[]
  ui?: { images: OutputFile[]; animated: boolean[] }
  previews?: { filename: string; mode: string; px: string }[]
}
interface Fixtures {
  layouts: Record<string, string>
  parse_layout: { layout: string; out?: unknown; error?: string }[]
  parse_text_layers: { text: string; default_role: string; out: Record<string, string> }[]
  autopopulate: { layout: string; props: Record<string, string>; out?: unknown; error?: string }[]
  resolve_outputs: { layout: string; aspects: string; out?: unknown; labels?: string[]; error?: string }[]
  execute: ExecuteCase[]
  render: string
}
const FX = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as { smart_layout: Fixtures }).smart_layout
const SNAP = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-smart-layout-render.json'), 'utf8')) as { request: RenderRequest; png_sha256: string; png_bytes: number }

const NO: ReadonlySet<RunnerFamily> = new Set()
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`
const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const text = (t: string) => ({ class_type: 'Text', inputs: { text: t } })
const emptyImage = () => ({ class_type: 'EmptyImage', inputs: { width: 40, height: 24, batch_size: 1, color: 0x336699 } })
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const previewImage = (from: [string, number]) => ({ class_type: 'PreviewImage', inputs: { images: from } })
const smartLayout = (over: Record<string, unknown> = {}) => ({ class_type: 'SmartLayout', inputs: { layout: '', aspects: '300x250,320x50', brand_kit: '', ...over } })
const sourceNode = (via: Via, name: string) => via === 'provider' ? generate() : via === 'card' ? card(name) : loadImage(name)

async function decode(bytes: Uint8Array): Promise<{ w: number; h: number; channels: number; px: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, channels: info.channels, px: new Uint8Array(data) }
}

/** A Python error message for one of its own internals (not a message the node writes). */
const internal = (e: string) => /^'.+' object /.test(e)

/** Ours throws as Python's does: the same words, or for JSON Python can't read, the same line. */
function expectSameError(run: () => unknown, python: string): void {
  const m = /^Layout JSON is malformed at line (\d+):/.exec(python)
  if (m) expect(run).toThrow(new RegExp(`^Layout JSON is malformed at line ${m[1]}:`))
  else expect(run).toThrow(python)
}

afterEach(() => { vi.restoreAllMocks() })

// ── The pure functions ───────────────────────────────────────────────────────

describe('the pure functions (nodes_smart_layout.py)', () => {
  it('the fixtures cover the starter, v1, v2, v3 and broken layouts, and blank, unknown and repeated aspects', () => {
    expect(Object.keys(FX.layouts).length).toBeGreaterThanOrEqual(12)
    expect(FX.resolve_outputs.some(r => r.aspects === '' && r.out)).toBe(true)
    expect(FX.resolve_outputs.some(r => r.aspects === 'nope' && r.error)).toBe(true)
    expect(FX.resolve_outputs.some(r => r.aspects === '1x1, 1x1' && r.out)).toBe(true)
    expect(FX.execute.length).toBeGreaterThanOrEqual(7)
  })

  for (const c of FX.parse_layout) {
    it(`_parse_layout: ${c.layout}`, () => {
      const raw = FX.layouts[c.layout]!
      if (c.error) expectSameError(() => parseLayout(raw), c.error)
      else expect(parseLayout(raw)).toEqual(c.out)
    })
  }

  it('_parse_layout: a blank layout is a fresh copy of the starter each time', () => {
    const a = parseLayout('')
    ;(a.elements as unknown[]).push({ id: 'x' })
    expect(parseLayout('').elements).toEqual([])
  })

  for (const c of FX.parse_text_layers) {
    it(`_parse_text_layers: ${JSON.stringify(c.text)} (${c.default_role})`, () => {
      expect(parseTextLayers(c.text, c.default_role)).toEqual(c.out)
    })
  }

  for (const c of FX.autopopulate) {
    it(`_autopopulate_for_template: ${c.layout} with ${Object.keys(c.props).join(', ') || 'no layers'}`, () => {
      const run = () => {
        const t = parseLayout(FX.layouts[c.layout]!)
        autopopulateForTemplate(t, { ...c.props })
        return t
      }
      if (c.error) expectSameError(run, c.error)
      else expect(run()).toEqual(c.out)
    })
  }

  for (const c of FX.resolve_outputs) {
    it(`_resolve_outputs and _output_labels: ${c.layout}, aspects ${JSON.stringify(c.aspects)}`, () => {
      const run = () => {
        const t = parseLayout(FX.layouts[c.layout]!)
        const outs = resolveOutputs(t, c.aspects)
        return { out: outs, labels: outputLabels(outs, t) }
      }
      if (c.error) expectSameError(run, c.error)
      else expect(run()).toEqual({ out: c.out, labels: c.labels })
    })
  }

  it('the errors compared by their words are the node’s own; Python’s internals only by failing', () => {
    const errors = [...FX.autopopulate, ...FX.resolve_outputs, ...FX.parse_layout].flatMap(r => r.error ? [r.error] : [])
    expect(errors.some(internal)).toBe(true)
    expect(errors.some(e => e.startsWith('Unknown format(s)'))).toBe(true)
  })

  it('live preview names keep letters and numbers of any script, `_`, `-` and `.`', () => {
    expect(livePreviewName('17', 'Story / tall', 0)).toBe('live_preview_17_Story___tall.png')
    expect(livePreviewName('17', 'Écran à 2', 3)).toBe('live_preview_17_Écran_à_2.png')
    expect(livePreviewName('17', '', 3)).toBe('live_preview_17_3.png')
    expect(livePreviewName('17', 'v1.2-final', 0)).toBe('live_preview_17_v1.2-final.png')
  })

  it('the brand: the kit strictly, blank keys and values dropped, the wired brand over it', () => {
    expect(brandOf('primary=#f00\nJust', 'primary=#0f0\naccent=#00f\nempty=\n=v\n# c=1')).toEqual({ primary: '#f00', accent: '#00f' })
    expect(brandOf('Just a word', '')).toEqual({ headline: 'Just a word' })
    expect(brandOf(null, null)).toEqual({})
  })
})

// ── execute: the requests, the pictures, the previews ────────────────────────

const LINKED = (key: string) => `src_${key}`

/** The node as the runner plans it: each image layer wired from its source node, the rest as Python got them. */
function promptOf(c: ExecuteCase): ApiPrompt {
  const inputs: Record<string, unknown> = {}
  const p: ApiPrompt = {}
  for (const [k, v] of Object.entries(c.inputs)) {
    if (k.startsWith('image_layer_')) {
      p[LINKED(k)] = sourceNode(c.via[k]!, c.names[k]!)
      inputs[k] = [LINKED(k), 0]
    }
    else inputs[k] = v
  }
  p[c.node_id] = { class_type: 'SmartLayout', inputs }
  return p
}

/** A body with each image layer's data URL (or placeholder) replaced by `{frame: key}`, as the fixture records Python's. */
function framed(body: RenderRequest | Record<string, unknown>): Record<string, unknown> {
  const b = JSON.parse(JSON.stringify(body)) as { props: Record<string, unknown> }
  for (const k of Object.keys(b.props)) if (k.startsWith('image_layer_')) b.props[k] = { frame: k }
  return b as unknown as Record<string, unknown>
}

async function runExecute(c: ExecuteCase) {
  const prompt = promptOf(c)
  const root = mkdtempSync(join(tmpdir(), 'runner-smart-layout-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => false })
  const store = new Map<string, Uint8Array>(Object.entries(c.files).map(([name, b]) => [`input:${name}`, b64(b)]))
  const plan: NodePlan = await planNode({
    prompt, nodeId: c.node_id, families: CARDS, gateOpen: false,
    // The batch: Python saves the tensor's first frame, the runner reads the first file.
    filesFrom: link => {
      const key = Object.keys(c.names).find(k => LINKED(k) === link[0])
      return key ? [inputFile(c.names[key]!), inputFile('second_frame.png')] : []
    },
    toUrl: async () => '',
  })
  expect(plan.kind).toBe('derive')
  const kept = new Map<string, Uint8Array>()
  const io: DeriveIO = {
    read: async (f) => {
      const b = store.get(keyOf(f)) ?? kept.get(keyOf(f))
      if (b) return b
      return results.read(f)
    },
    keep: async (bytes) => {
      const f: OutputFile = { filename: `${sha256(bytes)}.png`, subfolder: '', type: 'kept' }
      kept.set(keyOf(f), bytes)
      return f
    },
    saveAsset: async () => { throw new Error('Smart Layout saves no asset') },
    savePreview: async () => { throw new Error('no unique live previews') },
    savePreviewAs: (bytes, a) => results.savePreviewAs(bytes, { filename: a.filename, userId: null }),
    hosted: false, signal: new AbortController().signal, nodeId: c.node_id, runWorkflow: null, runPrompt: prompt,
  }
  const made: Derived = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)
  return { made, root, io }
}

describe('execute (SmartLayoutNode.execute, the renderer answering a 2×2 RGBA PNG)', () => {
  for (const c of FX.execute) {
    it(`the request bodies are Python’s: ${c.name}`, () => {
      const inputs = Object.fromEntries(Object.entries(c.inputs).filter(([k]) => !k.startsWith('image_layer_')))
      const urls = Object.fromEntries(Object.keys(c.inputs).filter(k => k.startsWith('image_layer_')).map(k => [k, `layer:${k}`]))
      if (c.error) {
        expectSameError(() => smartLayoutRequests(inputs, urls), c.error)
        return
      }
      expect(smartLayoutRequests(inputs, urls).map(framed)).toEqual(c.bodies)
    })

    it(`the node matches Python: ${c.name}`, async () => {
      const sent: RenderRequest[] = []
      vi.spyOn(smartLayoutRenderer, 'render').mockImplementation(async (req) => {
        sent.push(JSON.parse(JSON.stringify(req)) as RenderRequest)
        return b64(FX.render)
      })
      if (c.error) {
        await expect(runExecute(c)).rejects.toThrow(/^(Unknown format|Layout JSON is malformed)/)
        expect(sent).toEqual([])
        return
      }
      const { made, root } = await runExecute(c)
      // The bodies, and each image layer by its pixels.
      expect(sent.map(framed)).toEqual(c.bodies)
      for (const body of sent) {
        for (const [k, url] of Object.entries(body.props ?? {})) {
          if (!k.startsWith('image_layer_')) continue
          expect(String(url).startsWith('data:image/png;base64,'), k).toBe(true)
          const got = await decode(b64(String(url).split(',')[1]!))
          const want = c.frames[k]!
          expect([got.w, got.h, got.channels], k).toEqual([want.w, want.h, want.mode.length])
          expect(Buffer.compare(got.px, b64(want.px)), `${k} pixels`).toBe(0)
        }
      }
      // The value: a list, one RGB picture per output, Python's pixels.
      const value = made.values[0]!
      expect(value).toMatchObject({ kind: 'files', list: true })
      const files = (value as { files: OutputFile[] }).files
      expect(files.length).toBe(c.outputs!.length)
      // The previews: Python's names, in output order, its pixels.
      const ui = made.ui as { images: OutputFile[]; animated: boolean[] }
      expect(ui.images.map(f => [f.filename, f.type])).toEqual(c.ui!.images.map(f => [f.filename, f.type]))
      expect(ui.animated).toEqual(c.ui!.animated)
      for (let i = 0; i < c.outputs!.length; i++) {
        const [, h, w] = c.outputs![i]!.shape
        const shown = await decode(new Uint8Array(readFileSync(join(root, 'temp', ui.images[i]!.subfolder, ui.images[i]!.filename))))
        expect([shown.w, shown.h, shown.channels]).toEqual([w, h, 3])
        expect(Buffer.compare(shown.px, b64(c.outputs![i]!.rgb8))).toBe(0)
      }
      for (const p of c.previews!) {
        const i = ui.images.findIndex(f => f.filename === p.filename)
        const shown = await decode(new Uint8Array(readFileSync(join(root, 'temp', ui.images[i]!.subfolder, p.filename))))
        expect(Buffer.compare(shown.px, b64(p.px)), p.filename).toBe(0)
      }
    })
  }

  it('a text layer that is only blanks is left out, as Python leaves it', () => {
    const [req] = smartLayoutRequests({ layout: '', aspects: '1x1', text_layer_1: ' \n\t', text_layer_2: 'x' }, {})
    expect(Object.keys(req!.props!)).toEqual(['text_layer_2'])
  })
})

// ── The render, moved out of the route ───────────────────────────────────────

describe('renderTemplatePng (server/templates/renderPng.ts)', () => {
  it('gives the same bytes as the route did before the move', async () => {
    const png = await renderTemplatePng(SNAP.request)
    expect([png.length, sha256(png)]).toEqual([SNAP.png_bytes, SNAP.png_sha256])
  })

  it('the route answers with those bytes', async () => {
    const headers: Record<string, string> = {}
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', async () => SNAP.request)
    vi.stubGlobal('setHeader', (_e: unknown, k: string, v: string) => { headers[k] = v })
    vi.stubGlobal('createError', (e: { statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
    try {
      const route = (await import('~~/server/api/render-template.post')).default as unknown as (e: unknown) => Promise<Uint8Array>
      const png = await route({})
      expect(sha256(png)).toBe(SNAP.png_sha256)
      expect(headers['Content-Type']).toBe('image/png')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('eligibility', () => {
  it('Smart Layout counts as work: cards and a Smart Layout alone run in the runner', () => {
    expect(isRunnerEligible({ t: text('Spring drop'), l: smartLayout({ text_layer_1: ['t', 0] }) }, CARDS)).toBe(true)
    expect(isRunnerEligible({ l: smartLayout(), s: saveImage(['l', 0]), p: previewImage(['l', 0]) }, CARDS)).toBe(true)
    expect(runnerTakesWorkflow({ e: emptyImage(), l: smartLayout({ image_layer_1: ['e', 0] }) }, CARDS)).toBe(true)
  })

  it('its list may be read only by Save image and Preview image: an Edit image reading it is left to the engine', () => {
    const p: ApiPrompt = { l: smartLayout(), e: edit(['l', 0]) }
    expect(isRunnerEligible(p, EDIT_CARDS)).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual(['l'])
    const frame = { class_type: 'Compositor', inputs: { layer1: ['l', 0] } }
    expect(isRunnerEligible({ l: smartLayout(), f: frame } as ApiPrompt, new Set<RunnerFamily>(['frame', 'cards']))).toBe(false)
  })

  it('with cards off it is left to the engine, and the needs-the-engine list is unchanged', () => {
    const p: ApiPrompt = { 0: card('a.png'), 2: edit(['0', 0]), l: smartLayout({ image_layer_1: ['2', 0] }) }
    for (const fam of [NO, EDIT]) {
      expect(isRunnerEligible(p, fam)).toBe(false)
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
    }
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT, titleOf: id => id })).toEqual(['l'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual([])
  })

  it('wires and widgets as the node takes them: text into text layers and brand, pictures into image layers', () => {
    expect(isRunnerEligible({ e: emptyImage(), l: smartLayout({ text_layer_1: ['e', 0] }) }, CARDS)).toBe(false)
    expect(isRunnerEligible({ t: text('x'), l: smartLayout({ image_layer_1: ['t', 0] }) }, CARDS)).toBe(false)
    expect(isRunnerEligible({ t: text('primary=#f00'), l: smartLayout({ brand: ['t', 0] }) }, CARDS)).toBe(true)
    expect(isRunnerEligible({ t: text('x'), l: smartLayout({ layout: ['t', 0] }) }, CARDS)).toBe(false)
    expect(isRunnerEligible({ l: { class_type: 'SmartLayout', inputs: { layout: '' } } }, CARDS)).toBe(false)
  })

  it('a layout only Python reads (NaN), or outputs past the pixel cap, are left to the engine', () => {
    expect(isRunnerEligible({ l: smartLayout({ layout: '{"formats": {"a": {"w": NaN, "h": 1}}}', aspects: 'a' }) }, CARDS)).toBe(false)
    const huge = JSON.stringify({ version: 2, formats: { big: { w: 20000, h: 20000 } }, elements: [] })
    expect(smartLayoutPixels({ layout: huge, aspects: 'big' })).toBeGreaterThan(CARD_MAX_PIXELS)
    expect(isRunnerEligible({ l: smartLayout({ layout: huge, aspects: 'big' }) }, CARDS)).toBe(false)
    const odd = JSON.stringify({ version: 2, formats: { a: { w: '1080', h: 1080 } }, elements: [] })
    expect(isRunnerEligible({ l: smartLayout({ layout: odd, aspects: 'a' }) }, CARDS)).toBe(false)
    // A first format hidden by JS's key order (integer keys first), with no aspects to name one.
    const order = JSON.stringify({ version: 2, formats: { b: { w: 8, h: 8 }, 1: { w: 9, h: 9 } }, elements: [] }).replace('{"1":{"w":9,"h":9},"b"', '{"b":{"w":8,"h":8},"1"')
    expect(isRunnerEligible({ l: smartLayout({ layout: order, aspects: '' }) }, CARDS)).toBe(false)
    expect(isRunnerEligible({ l: smartLayout({ layout: order, aspects: 'b' }) }, CARDS)).toBe(true)
    // A layout Python refuses runs here and fails the same way.
    expect(isRunnerEligible({ l: smartLayout({ layout: '{', aspects: '1x1' }) }, CARDS)).toBe(true)
    // The starter's three default aspects are well within it.
    expect(smartLayoutPixels({ layout: '', aspects: '1x1,9x16,16x9' })).toBe(1080 * 1080 + 1080 * 1920 * 2)
  })
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards on)', () => {
  it('Text → Smart Layout → Save image renders two aspects and saves two files', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { t: text('Spring drop'), l: smartLayout({ text_layer_1: ['t', 0], brand_kit: 'primary=#ff3300' }), s: saveImage(['l', 0]) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const nodes = run.takes[0]!.nodes
    expect(nodes.l!.credits ?? 0).toBe(0)
    expect(nodes.l!.values?.[0]).toMatchObject({ kind: 'files', list: true })
    expect(nodes.s!.outputs.map(f => f.filename)).toEqual(['ComfyUI_00001_.png', 'ComfyUI_00002_.png'])
    const sizes = await Promise.all(nodes.s!.outputs.map(async f => sharp(readFileSync(join(k.root, 'output', f.subfolder, f.filename))).metadata()))
    expect(sizes.map(m => [m.width, m.height, m.channels])).toEqual([[300, 250, 3], [320, 50, 3]])
    const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 'l')!
    const ui = (shown.data as { output: { images: OutputFile[] } }).output
    expect(ui.images.map(f => f.filename)).toEqual(['live_preview_l_MPU.png', 'live_preview_l_Mobile_banner.png'])
    // The saved files are the previews' pixels: Save image writes the RGB render as it is.
    for (let i = 0; i < 2; i++) {
      const saved = await decode(new Uint8Array(readFileSync(join(k.root, 'output', nodes.s!.outputs[i]!.subfolder, nodes.s!.outputs[i]!.filename))))
      const preview = await decode(new Uint8Array(readFileSync(join(k.root, 'temp', ui.images[i]!.subfolder, ui.images[i]!.filename))))
      expect(Buffer.compare(saved.px, preview.px)).toBe(0)
    }
  }, 60_000)

  it('the previews are overwritten by the next run, under the same names', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { l: smartLayout({ aspects: '320x50' }) }
    const names: string[] = []
    for (let i = 0; i < 2; i++) {
      const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
      await k.engine.settled(runId)
      expect((await k.store.get(runId))!.status).toBe('done')
      const shown = ofType(k.seen, 'executed').filter(m => (m.data as { node: string }).node === 'l').at(-1)!
      names.push(...(shown.data as { output: { images: OutputFile[] } }).output.images.map(f => keyOf(f)))
    }
    expect(names[0]).toBe(names[1])
  }, 60_000)

  it('an unknown aspect fails the node in Python’s words, before any render', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const render = vi.spyOn(smartLayoutRenderer, 'render')
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: smartLayout({ aspects: '1x1,nope' }) }], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.l!.error).toMatch(/^Unknown format\(s\) \['nope'\]\. Template defines: \[/)
    expect(render).not.toHaveBeenCalled()
  })

  it('outputs past the pixel cap fail the node before any render (the backstop to eligibility)', async () => {
    const render = vi.spyOn(smartLayoutRenderer, 'render')
    const huge = JSON.stringify({ version: 2, formats: { big: { w: 20000, h: 20000 } }, elements: [] })
    await expect(planNode({
      prompt: { l: smartLayout({ layout: huge, aspects: 'big' }) }, nodeId: 'l', families: CARDS, gateOpen: false,
      filesFrom: () => [], toUrl: async () => '',
    })).rejects.toThrow(LAYOUT_TOO_LARGE)
    expect(render).not.toHaveBeenCalled()
  })

  it('writes nothing outside temp: the previews are not the run’s outputs', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ l: smartLayout({ aspects: '320x50' }) }], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(k.graphRuns.appendOutput).not.toHaveBeenCalled()
    const shown = ofType(k.seen, 'executed').find(m => (m.data as { node: string }).node === 'l')!
    const [img] = (shown.data as { output: { images: OutputFile[] } }).output.images
    expect(img!.type).toBe('temp')
    expect(img!.subfolder).toMatch(/^u_/)
  }, 60_000)
})
