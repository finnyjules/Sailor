/**
 * R1.3: the bake-replay cards (3D Studio, Text on path, Text mask without a
 * source) and LoadImage feeding anything, ported against the real Python
 * nodes (scripts/runner_cards_fixtures.py → fixtures/runner-cards.json, keys
 * `scene3d`, `text_on_path`, `text_mask`, `load_image`, `pil_luma`), and run
 * by the engine behind `cards`.
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
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { pilLuma } from '~~/server/runner/cards/bakeReplay'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { PICTURE_32_BIT } from '~~/server/runner/pictures/pythonView'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { collectInputFiles } from '~~/server/runner/inputs'
import { pictureSourceOf } from '~~/server/runner/compositor/plan'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

interface Image8 { w: number; h: number; rgb8?: string; fill?: [number, number, number] }
interface Mask16 { w: number; h: number; mask16: string }
interface Scene3DCase { name: string; beauty_image: string; depth_image: string; normal_image: string; files: Record<string, string>; outputs: Image8[] }
interface BakeCase { name: string; params: string; file?: string; error?: true; image?: Image8; mask?: Mask16 }
interface LoadImageCase { name: string; image_name: string; file: string; image: Image8; mask: Mask16 }
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as {
  scene3d: Scene3DCase[]; text_on_path: BakeCase[]; text_mask: BakeCase[]; load_image: LoadImageCase[]; pil_luma: [number, number, number, number][]
}

const NO: ReadonlySet<RunnerFamily> = new Set()
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const FRAME: ReadonlySet<RunnerFamily> = new Set(['frame'])
const FRAME_CARDS: ReadonlySet<RunnerFamily> = new Set(['frame', 'cards'])
const EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const VALUES = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { refused: { name: string; file: string }[] }
/** One of R0.7's refused files (16-bit, CMYK, see-through GIF, BMP, 32-bit TIFFs). */
const refusedFile = (name: string) => b64(VALUES.refused.find(c => c.name === name)!.file)
const u16 = (s: string) => { const b = Buffer.from(s, 'base64'); return [...new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2)] }
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`

/** Runs a node's derive plan over input files held in memory; kept bytes are kept in memory too. */
async function derived(prompt: ApiPrompt, nodeId: string, inputs: Record<string, Uint8Array>, families: ReadonlySet<RunnerFamily> = CARDS) {
  const store = new Map<string, Uint8Array>(Object.entries(inputs).map(([name, b]) => [`input:${name}`, b]))
  let seq = 0
  const plan: NodePlan = await planNode({
    prompt, nodeId, families, gateOpen: false,
    filesFrom: () => [], toUrl: async () => '',
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
  /** The value's first file (R11.9c fix round 3: `n` files, an animated LoadImage's batch). */
  const bytesOf = (v: RunnerValue | undefined, n = 1): Uint8Array => {
    if (!v || (v.kind !== 'files' && v.kind !== 'mask')) throw new Error(`not a file value: ${JSON.stringify(v)}`)
    expect(v.files).toHaveLength(n)
    return store.get(keyOf(v.files[0]!))!
  }
  return { made, bytesOf }
}

async function expectImage(bytes: Uint8Array, want: Image8, label: string): Promise<void> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height, info.channels], label).toEqual([want.w, want.h, 3])
  if (want.fill) {
    const [r, g, b] = want.fill
    let off = 0
    for (let i = 0; i < data.length; i += 3) if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b) off++
    expect(off, label).toBe(0)
  }
  else expect(Buffer.compare(data, Buffer.from(want.rgb8!, 'base64')), label).toBe(0)
}

async function expectMask(bytes: Uint8Array, want: Mask16, label: string): Promise<void> {
  const m = await decodeMask(bytes)
  expect([m.w, m.h], label).toEqual([want.w, want.h])
  expect([...m.data].map(v => Math.round(v * 65535)), label).toEqual(u16(want.mask16))
}

describe('pilLuma (PIL convert("L"))', () => {
  it('matches PIL for 256 random triples', () => {
    expect(FX.pil_luma).toHaveLength(256)
    for (const [r, g, b, l] of FX.pil_luma) expect(pilLuma(r, g, b), `${r},${g},${b}`).toBe(l)
  })
})

describe('3D Studio (comfy_extras/nodes_scene3d.py)', () => {
  for (const c of FX.scene3d) {
    it(`matches Python: ${c.name}`, async () => {
      const prompt: ApiPrompt = {
        s: { class_type: 'Scene3DStudio', inputs: { scene_state: '{}', beauty_image: c.beauty_image, depth_image: c.depth_image, normal_image: c.normal_image, glb_url: '' } },
      }
      const files = Object.fromEntries(Object.entries(c.files).map(([k, v]) => [k, b64(v)]))
      const { made, bytesOf } = await derived(prompt, 's', files)
      expect(made.ui).toBeNull()
      expect(Object.keys(made.values).sort()).toEqual(['0', '1', '2'])
      for (const slot of [0, 1, 2]) {
        expect(made.values[slot]!.kind).toBe('files')
        await expectImage(bytesOf(made.values[slot]), c.outputs[slot]!, `${c.name}, slot ${slot}`)
      }
    })
  }

  it('hands a bake that already is Python\'s picture on untouched (an RGB PNG)', async () => {
    const c = FX.scene3d[0]!
    const prompt: ApiPrompt = { s: { class_type: 'Scene3DStudio', inputs: { beauty_image: '', depth_image: '', normal_image: c.normal_image } } }
    const { made } = await derived(prompt, 's', { [c.normal_image]: b64(c.files[c.normal_image]!) })
    expect(made.values[2]).toEqual({ kind: 'files', files: [{ filename: c.normal_image, subfolder: '', type: 'input' }] })
  })

  it('refuses a bake there that can\'t be read here (16-bit, not a picture) rather than hand on the placeholder; a missing one is the placeholder', async () => {
    const prompt: ApiPrompt = { s: { class_type: 'Scene3DStudio', inputs: { beauty_image: 'b.png', depth_image: '', normal_image: '' } } }
    await expect(derived(prompt, 's', { 'b.png': refusedFile('a 16-bit greyscale PNG') }))
      .rejects.toThrow('3D Studio’s saved picture is 16-bit, which Sailor can’t read. Open 3D Studio and bake it again.')
    await expect(derived(prompt, 's', { 'b.png': new TextEncoder().encode('not a picture') }))
      .rejects.toThrow('3D Studio’s saved picture is a kind of file Sailor can’t read. Open 3D Studio and bake it again.')
    await expect(derived(prompt, 's', { 'b.png': refusedFile('a BMP') })).rejects.toThrow('is a kind of file Sailor can’t read')
    // Not there at all: Python's placeholder.
    const { made, bytesOf } = await derived(prompt, 's', {})
    await expectImage(bytesOf(made.values[0]), { w: 1024, h: 1024, fill: [128, 128, 128] }, 'missing')
  })
})

describe('the Text cards\' render names', () => {
  it('a render named by something other than text fails the node (Python loads str(rendered), no such file)', async () => {
    const prompt: ApiPrompt = { t: { class_type: 'TextOnPath', inputs: { params: JSON.stringify({ rendered: ['a.png'] }) } } }
    await expect(derived(prompt, 't', {})).rejects.toThrow('Text on path couldn’t load its picture')
    // Python's falsy values are no render.
    for (const rendered of [0, false, null, [], {}]) {
      const p: ApiPrompt = { t: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered }) } } }
      const { made } = await derived(p, 't', {})
      expect(Object.keys(made.values), JSON.stringify(rendered)).toEqual(['0', '1'])
    }
  })
})

describe('Text on path (comfy_extras/nodes_text_on_path.py)', () => {
  for (const c of FX.text_on_path) {
    it(`matches Python: ${c.name}`, async () => {
      const prompt: ApiPrompt = { t: { class_type: 'TextOnPath', inputs: { params: c.params } } }
      const files: Record<string, Uint8Array> = c.file ? { [JSON.parse(c.params).rendered]: b64(c.file) } : {}
      if (c.error) {
        await expect(derived(prompt, 't', files)).rejects.toThrow('Text on path couldn’t load its picture. Change a setting to bake it again.')
        return
      }
      const { made, bytesOf } = await derived(prompt, 't', files)
      expect(made.values[0]!.kind).toBe('files')
      expect(made.values[1]!.kind).toBe('mask')
      await expectImage(bytesOf(made.values[0]), c.image!, c.name)
      await expectMask(bytesOf(made.values[1]), c.mask!, c.name)
    })
  }
})

describe('Text mask without a source (comfy_extras/nodes_text_mask.py)', () => {
  for (const c of FX.text_mask) {
    it(`matches Python: ${c.name}`, async () => {
      const prompt: ApiPrompt = { t: { class_type: 'TextMask', inputs: { params: c.params } } }
      const files: Record<string, Uint8Array> = c.file ? { [JSON.parse(c.params).rendered]: b64(c.file) } : {}
      if (c.error) {
        await expect(derived(prompt, 't', files)).rejects.toThrow('Text mask couldn’t load its picture. Change a setting to bake it again.')
        return
      }
      const { made, bytesOf } = await derived(prompt, 't', files)
      expect(made.values[0]!.kind).toBe('files')
      expect(made.values[1]!.kind).toBe('mask')
      await expectImage(bytesOf(made.values[0]), c.image!, c.name)
      await expectMask(bytesOf(made.values[1]), c.mask!, c.name)
    })
  }
})

describe('LoadImage as a card (nodes.py LoadImage.load_image)', () => {
  for (const c of FX.load_image) {
    it(`matches Python: ${c.name}`, async () => {
      // Feeding an edit: not only Frames, so it runs as a card.
      const prompt: ApiPrompt = {
        l: { class_type: 'LoadImage', inputs: { image: c.image_name, upload: 'image' } },
        e: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['l', 0], prompt: 'warmer' } },
      }
      const { made, bytesOf } = await derived(prompt, 'l', { [c.image_name]: b64(c.file) })
      expect(made.values[0]!.kind).toBe('files')
      expect(made.values[1]!.kind).toBe('mask')
      // R11.9c fix round 5 (I2): an edit reads the first picture alone (Python's tensor[0]), so an animation's
      // frame 0 is all LoadImage decodes for it (the fixture holds that frame, as a provider is sent it).
      await expectImage(bytesOf(made.values[0], 1), c.image, c.name)
      await expectMask(bytesOf(made.values[1], 1), c.mask, c.name)
      // R11.9c fix round 3 (B1): read by Save image, a GIF's frames are LoadImage's batch, a picture and a mask each;
      // the first is the same frame. An APNG is read as its first frame (sharp reads no APNG frames).
      if (c.name === 'a two-frame GIF') {
        const batch = await derived({ ...prompt, s: { class_type: 'SaveImage', inputs: { images: ['l', 0], filename_prefix: 'ComfyUI' } } }, 'l', { [c.image_name]: b64(c.file) })
        await expectImage(batch.bytesOf(batch.made.values[0], 2), c.image, c.name)
        await expectMask(batch.bytesOf(batch.made.values[1], 2), c.mask, c.name)
      }
    })
  }

  it('feeding only Frames with cards off, hands its file on as before', async () => {
    const prompt: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } },
      f: { class_type: 'Compositor', inputs: { layer1: ['l', 0], layer1_mask: ['l', 1] } },
    }
    const plan = await planNode({ prompt, nodeId: 'l', families: FRAME, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
    expect(plan).toEqual({ kind: 'pass', files: [{ filename: 'a.png', subfolder: '', type: 'input' }], ui: null })
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

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
const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const maskedFrame = (): ApiPrompt => ({
  1: card('base.png'),
  2: loadImage('baked.png'),
  3: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['1', 0], layer2: ['2', 0], layer2_mask: ['2', 1], overlay: ['2', 0], overlay_mask: ['2', 1] }) },
  4: outCard('3'),
})
const scene3d = (over: Record<string, unknown> = {}) => ({
  class_type: 'Scene3DStudio', inputs: { scene_state: '{}', beauty_image: 'beauty.png', depth_image: '', normal_image: '', glb_url: '', ...over },
})

describe('eligibility', () => {
  it('a LoadImage feeding an edit is taken only with cards on', () => {
    const p: ApiPrompt = { 1: loadImage('a.png'), 2: edit(['1', 0]), 3: outCard('2') }
    expect(isRunnerEligible(p, EDIT)).toBe(false)
    expect(isRunnerEligible(p, EDIT_CARDS)).toBe(true)
    // Its mask feeding an edit's picture is not a picture.
    expect(isRunnerEligible({ ...p, 2: edit(['1', 1]) }, EDIT_CARDS)).toBe(false)
  })

  it('a masked Frame is taken exactly as before, with cards on and off', () => {
    expect(isRunnerEligible(maskedFrame(), FRAME)).toBe(true)
    expect(isRunnerEligible(maskedFrame(), FRAME_CARDS)).toBe(true)
    expect(isRunnerEligible(maskedFrame(), NO)).toBe(false)
    // A mask from anything but a LoadImage stays refused.
    const bad = maskedFrame()
    bad.t = { class_type: 'TextOnPath', inputs: { params: '{}' } }
    bad[3]!.inputs.layer2_mask = ['t', 1]
    expect(isRunnerEligible(bad, FRAME_CARDS)).toBe(false)
  })

  it('the bake-replay cards are known only with cards on', () => {
    for (const n of [scene3d(), { class_type: 'TextOnPath', inputs: { params: '{}' } }, { class_type: 'TextMask', inputs: { params: '{}' } }]) {
      const p: ApiPrompt = { c: n, 2: edit(['c', 0]), 3: outCard('2') }
      expect(runnerTakesNode(p, 'c', EDIT), n.class_type).toBe(false)
      expect(runnerTakesWorkflow(p, EDIT), n.class_type).toBe(false)
      expect(runnerTakesNode(p, 'c', EDIT_CARDS), n.class_type).toBe(true)
      expect(isRunnerEligible(p, EDIT_CARDS), n.class_type).toBe(true)
    }
  })

  it('a Text mask with a picture wired as its source is taken (R1.4); a mask as its source is not', () => {
    const p: ApiPrompt = { 0: card('a.png'), c: { class_type: 'TextMask', inputs: { params: '{}', source: ['0', 0] } }, 2: edit(['c', 0]) }
    expect(runnerTakesNode(p, 'c', EDIT_CARDS)).toBe(true)
    expect(runnerTakesNode({ ...p, t: { class_type: 'TextOnPath', inputs: { params: '{}' } }, c: { class_type: 'TextMask', inputs: { params: '{}', source: ['t', 1] } } }, 'c', EDIT_CARDS)).toBe(false)
  })

  it('params Python reads but JSON.parse does not (NaN) are left to the engine', () => {
    const p: ApiPrompt = { c: { class_type: 'TextOnPath', inputs: { params: '{"rendered": "a.png", "k": NaN}' } }, 2: edit(['c', 0]) }
    expect(runnerTakesNode(p, 'c', EDIT_CARDS)).toBe(false)
    p.c!.inputs.params = '{"rendered": "a.png"'
    expect(runnerTakesNode(p, 'c', EDIT_CARDS)).toBe(true)
  })

  it('every 3D Studio output is a picture a Frame can take; the Text cards\' pictures too', () => {
    for (const slot of [0, 1, 2]) {
      const p: ApiPrompt = { s: scene3d(), 3: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['s', slot] }) }, 4: outCard('3') }
      expect(isRunnerEligible(p, FRAME_CARDS), `slot ${slot}`).toBe(true)
      expect(isRunnerEligible(p, FRAME), `slot ${slot}`).toBe(false)
      expect(pictureSourceOf(p, ['s', slot])).toBe('load')
    }
    const t: ApiPrompt = { t: { class_type: 'TextOnPath', inputs: { params: '{}' } }, m: { class_type: 'TextMask', inputs: { params: '{}' } } }
    expect(pictureSourceOf(t, ['t', 0])).toBe('load')
    expect(pictureSourceOf(t, ['m', 0])).toBe('rgb')
    const onLayer = (from: string, slot: number): ApiPrompt => ({ ...t, 3: { class_type: 'Compositor', inputs: frameWidgets({ layer1: [from, slot] }) }, 4: outCard('3') })
    expect(isRunnerEligible(onLayer('t', 0), FRAME_CARDS)).toBe(true)
    expect(isRunnerEligible(onLayer('m', 0), FRAME_CARDS)).toBe(true)
    // Their masks are not pictures.
    expect(isRunnerEligible(onLayer('t', 1), FRAME_CARDS)).toBe(false)
  })

  it('names every bake file and render for the ownership check', () => {
    const p: ApiPrompt = {
      s: scene3d({ beauty_image: 'b.png', depth_image: 'sub/d.png [output]', normal_image: '  ' }),
      t: { class_type: 'TextOnPath', inputs: { params: JSON.stringify({ rendered: 'top.png' }) } },
      m: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'tm.png [temp]' }) } },
      x: { class_type: 'TextMask', inputs: { params: 'not json' } },
    }
    expect(collectInputFiles(p)).toEqual([
      { filename: 'b.png', subfolder: '', type: 'input' },
      { filename: 'd.png', subfolder: 'sub', type: 'output' },
      { filename: 'top.png', subfolder: '', type: 'input' },
      { filename: 'tm.png', subfolder: '', type: 'temp' },
    ])
  })
})

// ── The engine ───────────────────────────────────────────────────────────────

const put = (root: string, name: string, bytes: Uint8Array) => {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('the engine (cards on)', () => {
  it('3D Studio → Edit image (hosted): the edit is handed the kept RGB PNG, not the RGBA bake; nothing charged for the card', async () => {
    const rgba = FX.scene3d[0]!
    const k = makeKit({ hosted: true, deps: { families: () => EDIT_CARDS } })
    put(k.root, 'beauty.png', b64(rgba.files[rgba.beauty_image]!))
    const p: ApiPrompt = { s: scene3d(), 2: edit(['s', 0]), 3: outCard('2') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const rec = run.takes[0]!.nodes.s!
    expect(rec.credits).toBe(0)
    const beauty = rec.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(beauty.files[0]!.type).toBe('kept')
    const sent = k.fal.submitted()[0]!
    expect((sent.payload as { image_urls: string[] }).image_urls[0]).toBe(`https://fal.storage/${beauty.files[0]!.filename}`)
    const uploaded = (k.upload.mock.calls as unknown as [Uint8Array, string][]).find(([, name]) => name === beauty.files[0]!.filename)!
    const meta = await sharp(uploaded[0]).metadata()
    expect([meta.width, meta.height, meta.channels, meta.hasAlpha]).toEqual([30, 20, 3, false])
    await expectImage(uploaded[0], rgba.outputs[0]!, 'handed off')
  })

  it('a Text on path\'s mask feeding nothing yet is recorded as a mask value', async () => {
    const top = FX.text_on_path[0]!
    const k = makeKit({ hosted: false, deps: { families: () => EDIT_CARDS } })
    put(k.root, 'top_rgba.png', b64(top.file!))
    const p: ApiPrompt = { t: { class_type: 'TextOnPath', inputs: { params: top.params } }, 2: edit(['t', 0]), 3: outCard('2') }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes.t!.values!
    expect(v[0]!.kind).toBe('files')
    expect(v[1]!.kind).toBe('mask')
    expect((v[1] as { files: OutputFile[] }).files[0]!.type).toBe('kept')
  })

  it('a bake file that is someone else\'s is refused 403 before any hold', async () => {
    const k = makeKit({
      hosted: true,
      deps: { families: () => EDIT_CARDS, ownership: { ownsInput: async (_u, f) => f.filename !== 'theirs.png', ownsOutput: async () => true } },
    })
    put(k.root, 'theirs.png', b64(FX.scene3d[0]!.files[FX.scene3d[0]!.beauty_image]!))
    for (const n of [
      scene3d({ depth_image: 'theirs.png' }),
      { class_type: 'TextOnPath', inputs: { params: JSON.stringify({ rendered: 'theirs.png' }) } },
      { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'theirs.png' }) } },
    ]) {
      const p: ApiPrompt = { c: n, 2: edit(['c', 0]), 3: outCard('2') }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), n.class_type).rejects.toMatchObject({ statusCode: 403 })
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a Frame gives identical pixels whether its LoadImage ran the old way or as a card', async () => {
    const base = FX.load_image.find(c => c.name === 'an RGB PNG (no alpha)')!
    const baked = FX.load_image.find(c => c.name === 'an RGBA PNG with a gradient alpha')!
    const render = async (families: ReadonlySet<RunnerFamily>, prompt: ApiPrompt) => {
      const k = makeKit({ hosted: false, deps: { families: () => families } })
      put(k.root, 'base.png', b64(base.file))
      put(k.root, 'baked.png', b64(baked.file))
      const { runId } = await k.engine.startRun({ userId: null, takes: [prompt], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      const f = run.takes[0]!.nodes['3']!.outputs[0]!
      return { px: await sharp(join(k.root, f.type, f.subfolder, f.filename)).raw().toBuffer(), load: run.takes[0]!.nodes['2']! }
    }
    const p = maskedFrame()
    p[3]!.inputs.layer2_x = 0.1
    p[3]!.inputs.layer2_rotation = 12
    const old = await render(FRAME, p)
    expect(old.load.values).toBeUndefined()
    // With cards on, a LoadImage that also feeds an edit runs as a card; the Frame reads its kept picture and mask.
    const withEdit: ApiPrompt = { ...p, 5: edit(['2', 0]), 6: outCard('5') }
    const asCard = await render(new Set<RunnerFamily>(['frame', 'cards', 'fal-edit']), withEdit)
    expect(asCard.load.values![1]!.kind).toBe('mask')
    expect(asCard.px.equals(old.px)).toBe(true)
  })
})

// ── R1.3 follow-up ───────────────────────────────────────────────────────────

describe('the start of a run refuses a card\'s picture it can\'t read, before any hold', () => {
  const cases: { label: string; node: ApiPrompt[string]; file: string; bytes: () => Uint8Array; words: string }[] = [
    {
      label: '3D Studio, a 16-bit bake', node: scene3d({ beauty_image: '', normal_image: 'bad.png' }), file: 'bad.png',
      bytes: () => refusedFile('a 16-bit greyscale PNG'), words: '3D Studio’s saved picture is 16-bit, which Sailor can’t read. Open 3D Studio and bake it again.',
    },
    {
      label: '3D Studio, a BMP (sharp can’t read it)', node: scene3d({ beauty_image: 'bad.png' }), file: 'bad.png',
      bytes: () => refusedFile('a BMP'), words: '3D Studio’s saved picture is a kind of file Sailor can’t read. Open 3D Studio and bake it again.',
    },
    {
      label: 'Text on path, a CMYK render', node: { class_type: 'TextOnPath', inputs: { params: JSON.stringify({ rendered: 'bad.jpg' }) } }, file: 'bad.jpg',
      bytes: () => refusedFile('a CMYK JPEG'), words: 'Text on path’s saved picture is CMYK, which Sailor can’t read. Change a setting to bake it again.',
    },
    {
      label: 'Text mask, a see-through GIF', node: { class_type: 'TextMask', inputs: { params: JSON.stringify({ rendered: 'bad.gif' }) } }, file: 'bad.gif',
      bytes: () => refusedFile('a GIF with a transparent colour'), words: 'Text mask’s saved picture is a GIF with see-through parts, which Sailor can’t read. Change a setting to bake it again.',
    },
    {
      label: 'LoadImage, a 32-bit TIFF', node: loadImage('bad.tif'), file: 'bad.tif',
      bytes: () => refusedFile('a 32-bit float TIFF'), words: PICTURE_32_BIT,
    },
  ]
  for (const c of cases) {
    it(c.label, async () => {
      const k = makeKit({ hosted: true, deps: { families: () => EDIT_CARDS } })
      put(k.root, c.file, c.bytes())
      const p: ApiPrompt = { c: c.node, 2: edit(['c', 0]), 3: outCard('2') }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, message: c.words })
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.fal.client.submit).not.toHaveBeenCalled()
    })
  }

  it('a 3D Studio bake that isn\'t there is not refused: the card hands on its placeholder', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => EDIT_CARDS } })
    const p: ApiPrompt = { c: scene3d({ beauty_image: 'gone.png' }), 2: edit(['c', 0]), 3: outCard('2') }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('a missing LoadImage file is refused in words that fit any reader', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => EDIT_CARDS } })
    const p: ApiPrompt = { 1: loadImage('gone.png'), 2: edit(['1', 0]), 3: outCard('2') }
    await expect(k.engine.startRun({ userId: null, takes: [p], ...START }))
      .rejects.toMatchObject({ statusCode: 400, message: 'A picture this workflow needs is missing. Run it again.' })
  })
})

describe('with cards off, the needs-the-engine list is exactly as before R1.3', () => {
  // Each list was checked against the pre-R1.3 eligibility (8ea718fd7~1).
  const e = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'x' } })
  // An Image card showing the edit (R3.8 fix round 2: a prompt with no output node is the runner's to refuse).
  const shown = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
  const cases: [string, ApiPrompt, string[]][] = [
    ['3D Studio → Edit image', { c: scene3d(), e: e(['c', 0]) }, ['c']],
    ['3D Studio depth → Frame', { c: scene3d(), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['c', 1] }) } }, ['c', 'f']],
    ['Text on path mask → Edit image', { c: { class_type: 'TextOnPath', inputs: { params: '{}' } }, e: e(['c', 1]) }, ['c']],
    ['Text mask → Edit image', { c: { class_type: 'TextMask', inputs: { params: '{}' } }, e: e(['c', 0]) }, ['c']],
    ['LoadImage mask → Edit image', { l: loadImage('a.png'), e: e(['l', 1]) , o: shown('e') }, ['l']],
    ['LoadImage → Edit image', { l: loadImage('a.png'), e: e(['l', 0]) , o: shown('e') }, ['l']],
    ['Text on path mask → a Frame mask', {
      c: { class_type: 'TextOnPath', inputs: { params: '{}' } }, i: card('x.png'),
      f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['i', 0], layer1_mask: ['c', 1] }) },
    }, ['c', 'f']],
  ]
  for (const [label, p, want] of cases) {
    it(label, () => {
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set<RunnerFamily>(['fal-edit', 'frame']), titleOf: id => id })).toEqual(want)
    })
  }
  it('with cards on, the cards are taken', () => {
    expect(nodesNeedingEngine({ c: scene3d(), e: e(['c', 0]) }, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual([])
  })
})
