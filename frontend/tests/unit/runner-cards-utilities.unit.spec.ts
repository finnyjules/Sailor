/**
 * R1.4: the picture utilities (Empty image, Get image size, Image to mask,
 * Text mask with a source), ported against the real Python nodes
 * (scripts/runner_cards_fixtures.py → fixtures/runner-cards.json, keys
 * `empty_image`, `get_image_size`, `image_to_mask`, `text_mask_source`), and
 * run by the engine behind `cards`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { IMAGE_NO_ALPHA, tensorChannels } from '~~/server/runner/cards/utilities'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

type Via = 'provider' | 'card' | 'load'
interface Image8 { w: number; h: number; rgb8?: string; fill?: [number, number, number] }
interface Frame8 { w: number; h: number; channels: 3 | 4; px8: string }
interface Mask16 { w: number; h: number; mask16: string }
interface EmptyCase { name: string; width: number; height: number; batch_size: number; color: number; shape: number[]; image: Image8 }
interface Sourced { name: string; via: Via; files: Record<string, string>; names: string[] }
interface SizeCase extends Sourced { values: [number, number, number]; progress_text: string[] }
interface ToMaskCase extends Sourced { channel: string; channels: number; error?: true; masks?: Mask16[] }
interface SourceMaskCase extends Sourced { params: string; render?: string; images: Frame8[]; mask: Mask16 }
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as {
  empty_image: EmptyCase[]; get_image_size: SizeCase[]; image_to_mask: ToMaskCase[]; text_mask_source: SourceMaskCase[]
}

const NO: ReadonlySet<RunnerFamily> = new Set()
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
const REFS_CARDS: ReadonlySet<RunnerFamily> = new Set(['ref-edits', 'cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const u16 = (s: string) => { const b = Buffer.from(s, 'base64'); return [...new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2)] }
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`
const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const emptyImage = (over: Record<string, unknown> = {}) => ({ class_type: 'EmptyImage', inputs: { width: 64, height: 32, batch_size: 1, color: 0x336699, ...over } })
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
const sourceNode = (via: Via, name: string) => via === 'provider' ? generate() : via === 'card' ? card(name) : loadImage(name)

/** Runs a node's derive plan; `src` is the node at the end of its picture wire, whose files are `srcFiles`. */
async function derived(prompt: ApiPrompt, nodeId: string, files: Record<string, Uint8Array>, srcFiles: string[] = []) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([name, b]) => [`input:${name}`, b]))
  let seq = 0
  const plan: NodePlan = await planNode({
    prompt, nodeId, families: CARDS, gateOpen: false,
    filesFrom: link => link[0] === 'src' ? srcFiles.map(inputFile) : [], toUrl: async () => '',
  })
  expect(plan.kind).toBe('derive')
  const io: DeriveIO = {
    read: async (f) => {
      const b = store.get(keyOf(f))
      if (!b) throw new Error(`no such file ${keyOf(f)}`)
      return b
    },
    keep: async (bytes, ext) => {
      const f: OutputFile = { filename: `k${++seq}.${ext}`, subfolder: 'run_x', type: 'kept' }
      store.set(keyOf(f), bytes)
      return f
    },
    saveAsset: async () => { throw new Error('no assets') },
    savePreview: async () => { throw new Error('no previews') },
    hosted: false, signal: new AbortController().signal, nodeId, runWorkflow: null,
  }
  const made: Derived = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)
  const filesOfValue = (v: RunnerValue | undefined): OutputFile[] => {
    if (!v || (v.kind !== 'files' && v.kind !== 'mask')) throw new Error(`not a file value: ${JSON.stringify(v)}`)
    return v.files
  }
  return { made, filesOfValue, bytes: (f: OutputFile) => store.get(keyOf(f))! }
}

async function expectFrame(bytes: Uint8Array, want: Frame8, label: string): Promise<void> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height, info.channels], label).toEqual([want.w, want.h, want.channels])
  expect(Buffer.compare(data, Buffer.from(want.px8, 'base64')), label).toBe(0)
}

async function expectMask(bytes: Uint8Array, want: Mask16, label: string): Promise<void> {
  const m = await decodeMask(bytes)
  expect([m.w, m.h], label).toEqual([want.w, want.h])
  expect([...m.data].map(v => Math.round(v * 65535)), label).toEqual(u16(want.mask16))
}

describe('Empty image (nodes.py EmptyImage)', () => {
  for (const c of FX.empty_image) {
    it(`matches Python: ${c.name}`, async () => {
      const prompt: ApiPrompt = { e: emptyImage({ width: c.width, height: c.height, batch_size: c.batch_size, color: c.color }) }
      const { made, filesOfValue, bytes } = await derived(prompt, 'e', {})
      expect(made.ui).toBeNull()
      const files = filesOfValue(made.values[0])
      expect(made.values[0]!.kind).toBe('files')
      // One kept PNG, listed batch_size times.
      expect(files).toHaveLength(c.shape[0]!)
      expect(new Set(files.map(keyOf)).size).toBe(1)
      const { data, info } = await sharp(bytes(files[0]!)).raw().toBuffer({ resolveWithObject: true })
      expect([info.height, info.width, info.channels]).toEqual(c.shape.slice(1))
      if (c.image.fill) {
        const [r, g, b] = c.image.fill
        for (let i = 0; i < data.length; i += 3) expect([data[i], data[i + 1], data[i + 2]]).toEqual([r, g, b])
      }
      else expect(Buffer.compare(data, Buffer.from(c.image.rgb8!, 'base64'))).toBe(0)
    })
  }

  it('reads its settings as ComfyUI converts them (int())', async () => {
    const { made, filesOfValue, bytes } = await derived({ e: emptyImage({ width: '5', height: 3.9, batch_size: true, color: '255' }) }, 'e', {})
    const files = filesOfValue(made.values[0])
    expect(files).toHaveLength(1)
    const { data, info } = await sharp(bytes(files[0]!)).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, data[0], data[1], data[2]]).toEqual([5, 3, 0, 0, 255])
  })
})

/** The prompt for a picture utility fed by a source of this kind. */
const fed = (c: Sourced, node: ApiPrompt[string]): ApiPrompt => ({ src: sourceNode(c.via, c.names[0]!), u: node })
const filesOf = (c: Sourced) => Object.fromEntries(Object.entries(c.files).map(([k, v]) => [k, b64(v)]))

describe('Get image size (comfy_extras/nodes_images.py GetImageSize)', () => {
  for (const c of FX.get_image_size) {
    it(`matches Python: ${c.name}`, async () => {
      const { made } = await derived(fed(c, { class_type: 'GetImageSize', inputs: { image: ['src', 0] } }), 'u', filesOf(c), c.names)
      expect(made.values).toEqual({
        0: { kind: 'number', value: c.values[0], int: true },
        1: { kind: 'number', value: c.values[1], int: true },
        2: { kind: 'number', value: c.values[2], int: true },
      })
      // Python also sends its size text to the node; the runner shows none (a known difference).
      expect(c.progress_text).toHaveLength(1)
      expect(made.ui).toBeNull()
    })
  }

  it('an empty Image card is Python\'s 1×1 blank', async () => {
    const { made } = await derived({ src: card(''), u: { class_type: 'GetImageSize', inputs: { image: ['src', 0] } } }, 'u', {})
    expect([0, 1, 2].map(s => (made.values[s] as { value: number }).value)).toEqual([1, 1, 1])
  })
})

describe('Image to mask (comfy_extras/nodes_mask.py ImageToMask)', () => {
  for (const c of FX.image_to_mask) {
    it(`matches Python: ${c.name}`, async () => {
      const run = derived(fed(c, { class_type: 'ImageToMask', inputs: { image: ['src', 0], channel: c.channel } }), 'u', filesOf(c), c.names)
      if (c.error) {
        await expect(run).rejects.toThrow(IMAGE_NO_ALPHA)
        return
      }
      const { made, filesOfValue, bytes } = await run
      expect(made.values[0]!.kind).toBe('mask')
      const files = filesOfValue(made.values[0])
      expect(files).toHaveLength(c.masks!.length)
      for (const [i, m] of c.masks!.entries()) await expectMask(bytes(files[i]!), m, `${c.name}, mask ${i}`)
    })
  }

  it('the message reads plainly', () => {
    expect(IMAGE_NO_ALPHA).toBe('This picture has no alpha channel to make a mask from')
  })
})

describe('Text mask with a source (comfy_extras/nodes_text_mask.py)', () => {
  for (const c of FX.text_mask_source) {
    it(`matches Python: ${c.name}`, async () => {
      const files = filesOf(c)
      const rendered = (JSON.parse(c.params) as { rendered: string }).rendered
      if (c.render) files[rendered] = b64(c.render)
      const { made, filesOfValue, bytes } = await derived(fed(c, { class_type: 'TextMask', inputs: { params: c.params, source: ['src', 0] } }), 'u', files, c.names)
      expect(made.ui).toBeNull()
      const images = filesOfValue(made.values[0])
      expect(images).toHaveLength(c.images.length)
      for (const [i, want] of c.images.entries()) await expectFrame(bytes(images[i]!), want, `${c.name}, image ${i}`)
      expect(made.values[1]!.kind).toBe('mask')
      const [mask] = filesOfValue(made.values[1])
      await expectMask(bytes(mask!), c.mask, `${c.name}, mask`)
    })
  }

  it('a missing render fails the node even with a source', async () => {
    const c = FX.text_mask_source[0]!
    const node = { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'gone.png' }), source: ['src', 0] } }
    await expect(derived(fed(c, node), 'u', filesOf(c), c.names)).rejects.toThrow('Text mask couldn’t load its picture')
  })
})

describe('tensorChannels and pictureSourceOf', () => {
  const raw = (source: 'provider' | 'card' | 'load' | 'rgb' | 'blank', alpha = 255) =>
    ({ raw: true as const, source, w: 1, h: 1, data: source === 'blank' ? null : new Uint8Array([1, 2, 3, alpha]) })
  it('provider 4; card 4 only when a pixel is see-through; load, rgb and blank 3', () => {
    expect(tensorChannels(raw('provider'))).toBe(4)
    expect(tensorChannels(raw('card'))).toBe(3)
    expect(tensorChannels(raw('card', 254))).toBe(4)
    expect(tensorChannels(raw('load', 0))).toBe(3)
    expect(tensorChannels(raw('rgb', 0))).toBe(3)
    expect(tensorChannels(raw('blank'))).toBe(3)
  })

  it('Empty image is a picture Python built (rgb); Text mask with a source hands on its source\'s channels', () => {
    const p: ApiPrompt = {
      e: emptyImage(), g: generate(), l: loadImage('a.png'),
      m1: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'r.png' }), source: ['g', 0] } },
      m2: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'r.png' }), source: ['l', 0] } },
      m3: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: '' }), source: ['g', 0] } },
      m4: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'r.png' }) } },
    }
    expect(pictureSourceOf(p, ['e', 0])).toBe('rgb')
    expect(pictureSourceOf(p, ['m1', 0])).toBe('provider')
    expect(pictureSourceOf(p, ['m2', 0])).toBe('load')
    // A blank render is Python's 16×16 black, whatever the source.
    expect(pictureSourceOf(p, ['m3', 0])).toBe('rgb')
    expect(pictureSourceOf(p, ['m4', 0])).toBe('rgb')
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('eligibility', () => {
  const utilities = (): [string, ApiPrompt][] => [
    ['EmptyImage', { u: emptyImage(), 2: edit(['u', 0]), 3: outCard('2') }],
    ['GetImageSize', { 0: card('a.png'), u: { class_type: 'GetImageSize', inputs: { image: ['0', 0] } }, 2: edit(['0', 0]), 3: outCard('2') }],
    ['ImageToMask', { 0: card('a.png'), u: { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'red' } }, 2: edit(['0', 0]), 3: outCard('2') }],
    ['TextMask', { 0: card('a.png'), u: { class_type: 'TextMask', inputs: { params: '{}', source: ['0', 0] } }, 2: edit(['u', 0]), 3: outCard('2') }],
  ]

  it('each utility is known only with cards on', () => {
    for (const [cls, p] of utilities()) {
      expect(runnerTakesNode(p, 'u', EDIT), cls).toBe(false)
      expect(runnerTakesWorkflow(p, EDIT), cls).toBe(false)
      expect(runnerTakesNode(p, 'u', EDIT_CARDS), cls).toBe(true)
      expect(isRunnerEligible(p, EDIT_CARDS), cls).toBe(true)
    }
  })

  it('Empty image: settings over the runner\'s caps (ComfyUI allows them) or wired leave it to the engine', () => {
    const take = (over: Record<string, unknown>) => runnerTakesNode({ u: emptyImage(over), 2: edit(['u', 0]) }, 'u', EDIT_CARDS)
    expect(take({ width: 8192, height: 8192, batch_size: 64, color: 0xFFFFFF })).toBe(true)
    expect(take({ width: 8193 })).toBe(false)
    expect(take({ height: 16384 })).toBe(false)
    expect(take({ batch_size: 65 })).toBe(false)
    expect(take({ color: 0x1000000 })).toBe(false)
    expect(take({ width: 0 })).toBe(false)
    expect(take({ width: ['9', 0] })).toBe(false)
  })

  it('the caps are not ComfyUI errors: a width ComfyUI allows is not pruned as invalid', () => {
    const p: ApiPrompt = { u: emptyImage({ width: 10000 }), 2: edit(['u', 0]), 3: outCard('2') }
    expect(runnerTakesWorkflow(p, EDIT_CARDS)).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual(['u'])
  })

  it('Get image size and Image to mask need a picture wired; a video or a mask is not one', () => {
    for (const cls of ['GetImageSize', 'ImageToMask']) {
      const node = (image?: [string, number]) => ({ class_type: cls, inputs: { channel: 'alpha', ...(image ? { image } : {}) } })
      expect(runnerTakesNode({ u: node() }, 'u', CARDS), cls).toBe(false)
      expect(runnerTakesNode({ v: { class_type: 'Video', inputs: { video: 'a.mp4' } }, u: node(['v', 0]) }, 'u', CARDS), cls).toBe(false)
      expect(runnerTakesNode({ t: { class_type: 'TextMask', inputs: { params: '{}' } }, u: node(['t', 1]) }, 'u', CARDS), cls).toBe(false)
      expect(runnerTakesNode({ e: emptyImage(), u: node(['e', 0]) }, 'u', CARDS), cls).toBe(true)
    }
    expect(runnerTakesNode({ 0: card('a.png'), u: { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'luma' } } }, 'u', CARDS)).toBe(false)
  })

  it('Get image size\'s numbers and Image to mask\'s mask are not pictures', () => {
    const p: ApiPrompt = { 0: card('a.png'), g: { class_type: 'GetImageSize', inputs: { image: ['0', 0] } }, m: { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'red' } } }
    expect(isRunnerEligible({ ...p, 2: edit(['g', 0]), 3: outCard('2') }, EDIT_CARDS)).toBe(false)
    expect(isRunnerEligible({ ...p, 2: edit(['m', 0]), 3: outCard('2') }, EDIT_CARDS)).toBe(false)
  })

  it('Empty image feeds a Frame (with cards on)', () => {
    const p: ApiPrompt = { u: emptyImage(), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['u', 0] }) }, o: outCard('f') }
    expect(isRunnerEligible(p, new Set<RunnerFamily>(['frame', 'cards']))).toBe(true)
    expect(isRunnerEligible(p, new Set<RunnerFamily>(['frame']))).toBe(false)
  })
})

describe('with cards off, the needs-the-engine list is unchanged', () => {
  // Checked against HEAD before R1.4 (89e18d876).
  const e = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'x' } })
  const cases: [string, ApiPrompt, string[]][] = [
    ['Empty image → Edit image', { u: emptyImage(), e: e(['u', 0]) }, ['u']],
    ['Get image size → Edit image', { 0: card('a.png'), u: { class_type: 'GetImageSize', inputs: { image: ['0', 0] } }, e: e(['u', 0]) }, ['u']],
    ['Image to mask → Edit image', { 0: card('a.png'), u: { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'red' } }, e: e(['u', 0]) }, ['u']],
    ['Text mask with a source → Edit image', { 0: card('a.png'), u: { class_type: 'TextMask', inputs: { params: '{}', source: ['0', 0] } }, e: e(['u', 0]) }, ['u']],
  ]
  for (const [label, p, want] of cases) {
    it(label, () => {
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set<RunnerFamily>(['fal-edit', 'frame']), titleOf: id => id })).toEqual(want)
    })
  }
  it('with no families at all, nothing is taken', () => {
    expect(isRunnerEligible({ u: emptyImage(), e: e(['u', 0]) }, NO)).toBe(false)
  })
})

// ── The engine ───────────────────────────────────────────────────────────────

const put = (root: string, name: string, bytes: Uint8Array) => {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('the engine (cards on)', () => {
  it('Empty image → Generate from references: taken, and hands off the one kept PNG; nothing charged for the card', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => REFS_CARDS } })
    const p: ApiPrompt = {
      e: emptyImage({ width: 40, height: 24, batch_size: 3, color: 0x10A0FF }),
      2: { class_type: 'GenerateFromReferencesNode', inputs: { model: 'nano-banana-2', prompt: 'a poster', image_1: ['e', 0], seed: 0, size: '2K', aspect_ratio: 'match_input_image' } },
      3: outCard('2'),
    }
    expect(isRunnerEligible(p, REFS_CARDS)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const rec = run.takes[0]!.nodes.e!
    expect(rec.credits).toBe(0)
    const v = rec.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.files).toHaveLength(3)
    expect(new Set(v.files.map(keyOf)).size).toBe(1)
    expect(v.files[0]!.type).toBe('kept')
    const sent = JSON.stringify(k.fal.submitted()[0]!.payload)
    expect(sent).toContain(`https://fal.storage/${v.files[0]!.filename}`)
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const { data, info } = await sharp(uploads[0]![0]).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels, data[0], data[1], data[2]]).toEqual([40, 24, 3, 0x10, 0xA0, 0xFF])
  })

  it('a card picture a utility reads is refused at the start when the runner can\'t read it exactly', async () => {
    const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { refused: { name: string; file: string }[] }
    const k = makeKit({ hosted: true, deps: { families: () => EDIT_CARDS } })
    put(k.root, 'deep.png', b64(VALUES.refused.find(c => c.name === 'a 16-bit greyscale PNG')!.file))
    for (const u of [
      { class_type: 'GetImageSize', inputs: { image: ['0', 0] } },
      { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'red' } },
      { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'r.png' }), source: ['0', 0] } },
    ]) {
      const p: ApiPrompt = { 0: card('deep.png'), u, 2: edit(['0', 0]), 3: outCard('2') }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), u.class_type)
        .rejects.toMatchObject({ statusCode: 400, message: 'This picture is 16-bit. Save it as an 8-bit picture and load it again.' })
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('Image to mask on a picture with no alpha fails the node in plain words', async () => {
    const c = FX.image_to_mask.find(x => x.error)!
    const k = makeKit({ hosted: false, deps: { families: () => EDIT_CARDS } })
    put(k.root, c.names[0]!, b64(c.files[c.names[0]!]!))
    const p: ApiPrompt = {
      0: loadImage(c.names[0]!), u: { class_type: 'ImageToMask', inputs: { image: ['0', 0], channel: 'alpha' } },
      2: edit(['0', 0]), 3: outCard('2'),
    }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.u!.error).toBe(IMAGE_NO_ALPHA)
  })
})
