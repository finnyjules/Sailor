/**
 * LC9: Smart Layout read by an Image card (28 saved graphs, off
 * NEEDS_LOCAL_ENGINE; the list is empty since step 4, C4). Python's Image card doesn't declare INPUT_IS_LIST, so
 * fed Smart Layout's list it runs once per item (each a batch of one, so
 * `batch_index` slices nothing), shows every item, and hands a list on: its
 * own readers are held to the same list readers (eligibility.ts
 * LIST_PASSERS). Smart Layout is free (no provider, $0): the price and the
 * hold are exactly its Preview image twin's, the render credit alone (held
 * and charged in hosted, free locally). The card keeps nothing new: it hands
 * Smart Layout's kept files on and shows a temp copy of each.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { EVERY_KNOWN_FAMILY } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MISSING_OUTPUT_WORDS, engineRunPrompt, leftOutNotice, runRefusal } from '~/lib/runner/needsEngine'
import type { OutputFile } from '~~/server/runner/types'
import { SAVE_OUTSIDE } from '~~/server/runner/results'
import { IMAGE_EXPORT_TOO_MUCH, imageExportKeptBytes } from '~~/server/runner/cards/imageExport'
import { PICTURE_ANIMATED } from '~~/server/runner/pictures/pythonView'

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EDIT_CARDS: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
type Link = [string, number]

const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const smartLayout = (over: Record<string, unknown> = {}) => ({ class_type: 'SmartLayout', inputs: { layout: '', aspects: '300x250,320x50', brand_kit: '', ...over } })
/** The Image card as the canvas saves it (the 28 saved graphs: export on, batch_index −1). */
const card = (from: Link, batchIndex = -1) => ({ class_type: 'Image', inputs: { image: '', export: true, ...SAVE_DEFAULTS, batch_index: batchIndex, images: from } })
const saveImage = (from: Link) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const edit = (from: Link) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
const blur = (from: Link) => ({ class_type: 'Blur', inputs: { image: from, type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } })

const shownBy = (seen: ReturnType<typeof makeKit>['seen'], node: string): OutputFile[] =>
  (ofType(seen, 'executed').filter(m => (m.data as { node: string }).node === node).at(-1)!.data as { output: { images: OutputFile[] } }).output.images

async function rgb(path: string): Promise<Buffer> {
  return (await sharp(readFileSync(path)).raw().toBuffer())
}

describe('eligibility', () => {
  it('Smart Layout → Image card runs on the runner (cards on), with every family on too', () => {
    const p: ApiPrompt = { l: smartLayout(), i: card(['l', 0]) }
    expect(isRunnerEligible(p, CARDS)).toBe(true)
    expect(runnerTakesWorkflow(p, EVERY_KNOWN_FAMILY)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EVERY_KNOWN_FAMILY, titleOf: id => id })).toEqual([])
    // A batch_index set on the card changes nothing: Python runs it once per item.
    expect(isRunnerEligible({ l: smartLayout(), i: card(['l', 0], 1) }, CARDS)).toBe(true)
  })

  it('the card hands the list on: Save image, Preview image or another card may read it, nothing else', () => {
    expect(isRunnerEligible({ l: smartLayout(), i: card(['l', 0]), s: saveImage(['i', 0]) }, CARDS)).toBe(true)
    expect(isRunnerEligible({ l: smartLayout(), i: card(['l', 0]), j: card(['i', 0]), s: saveImage(['j', 0]) }, CARDS)).toBe(true)
    // A paid edit reading the card would run once per item in Python: refused, Smart Layout named.
    const paid: ApiPrompt = { l: smartLayout(), i: card(['l', 0]), e: edit(['i', 0]), o: card(['e', 0]) }
    expect(isRunnerEligible(paid, EDIT_CARDS)).toBe(false)
    expect(nodesNeedingEngine(paid, { runnerOn: true, families: EDIT_CARDS, titleOf: id => id })).toEqual(['l'])
    const fx: ApiPrompt = { l: smartLayout(), i: card(['l', 0]), j: card(['i', 0]), b: blur(['j', 0]), s: saveImage(['b', 0]) }
    expect(runnerTakesWorkflow(fx, EVERY_KNOWN_FAMILY)).toBe(false)
    expect(nodesNeedingEngine(fx, { runnerOn: true, families: EVERY_KNOWN_FAMILY, titleOf: id => id })).toEqual(['l'])
  })
})

describe('the engine (cards on)', () => {
  for (const hosted of [false, true]) {
    it(`${hosted ? 'hosted' : 'locally'}: Smart Layout → Image card is priced and held as its Preview image twin; the card exports each output and shows it`, async () => {
      // The twin: Smart Layout → Preview image, which the runner took before LC9.
      const twin = makeKit({ hosted, deps: { families: () => EVERY_KNOWN_FAMILY } })
      const tp: ApiPrompt = { l: smartLayout(), s: { class_type: 'PreviewImage', inputs: { images: ['l', 0] } } }
      const tq = await twin.engine.quoteRun({ userId: twin.userId, takes: [tp], ...START })
      await twin.engine.settled((await twin.engine.startRun({ userId: twin.userId, takes: [tp], ...START })).runId)

      const k = makeKit({ hosted, deps: { families: () => EVERY_KNOWN_FAMILY } })
      const p: ApiPrompt = { l: smartLayout(), i: card(['l', 0], 0) }
      const q = await k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })
      expect(q).toEqual(tq)
      // The render credit alone: no provider dollars.
      expect(q).toEqual({ credits: 1, usd: 0, upTo: false })
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      const holds = (l: typeof k.ledger) => [...l.holds.values()].map(h => ({ credits: h.credits, state: h.state, actual: h.actual }))
      expect(holds(k.ledger)).toEqual(holds(twin.ledger))
      expect(holds(k.ledger)).toEqual(hosted ? [{ credits: 1, state: 'settled', actual: 1 }] : [])
      expect(k.fal.client.submit).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      const nodes = run.takes[0]!.nodes
      expect(nodes.l!.credits ?? 0).toBe(0)
      expect(nodes.i!.credits ?? 0).toBe(0)
      const made = nodes.l!.values![0] as { kind: 'files'; files: OutputFile[]; list?: true }
      // The card hands Smart Layout's own kept files on, still a list (batch_index 0 slices nothing).
      expect(nodes.i!.values?.[0]).toEqual({ kind: 'files', files: made.files, list: true })
      expect(made.files).toHaveLength(2)
      // export on (as all the saved graphs have it): each output saved to the output folder, one save per item,
      // and the card shows the saved files (the user's own folder in hosted), the renders' pixels.
      const shown = shownBy(k.seen, 'i')
      expect(shown.map(f => [f.type, f.filename])).toEqual([['output', 'ComfyUI_00001_.png'], ['output', 'ComfyUI_00002_.png']])
      for (const f of shown) if (hosted) expect(f.subfolder).toMatch(/^u_/)
      const previews = shownBy(k.seen, 'l')
      for (let n = 0; n < 2; n++) {
        const a = await rgb(join(k.root, 'output', shown[n]!.subfolder, shown[n]!.filename))
        const b = await rgb(join(k.root, 'temp', previews[n]!.subfolder, previews[n]!.filename))
        expect(Buffer.compare(a, b)).toBe(0)
      }
      const sizes = await Promise.all(shown.map(f => sharp(readFileSync(join(k.root, 'output', f.subfolder, f.filename))).metadata()))
      expect(sizes.map(m => [m.width, m.height, m.channels])).toEqual([[300, 250, 3], [320, 50, 3]])
      // Saved as the run's assets, as Save image's files are.
      expect(k.graphRuns.appendOutput).toHaveBeenCalledTimes(hosted ? 2 : 0)
    }, 60_000)
  }

  it('export off: the card shows a temp copy of each output and writes nothing to the output folder', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const off = { ...card(['l', 0]), inputs: { ...card(['l', 0]).inputs, export: false } }
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: smartLayout(), i: off }], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const shown = shownBy(k.seen, 'i')
    expect(shown.map(f => f.type)).toEqual(['temp', 'temp'])
    expect(readdirSync(join(k.root, 'output'))).toEqual([])
  }, 60_000)

  it('Smart Layout → Image card → Save image saves each output, one run per item as Python does', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const off = { ...card(['l', 0]), inputs: { ...card(['l', 0]).inputs, export: false } }
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: smartLayout(), i: off, s: saveImage(['i', 0]) }], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const s = run.takes[0]!.nodes.s!
    expect(s.outputs.map(f => f.filename)).toEqual(['ComfyUI_00001_.png', 'ComfyUI_00002_.png'])
    const sizes = await Promise.all(s.outputs.map(f => sharp(readFileSync(join(k.root, 'output', f.subfolder, f.filename))).metadata()))
    expect(sizes.map(m => [m.width, m.height, m.channels])).toEqual([[300, 250, 3], [320, 50, 3]])
  }, 60_000)
})

// ── Fix round 1: the Image card's export, for every Image card the runner runs ──

const emptyImage = (w: number, h: number, batch = 1) => ({ class_type: 'EmptyImage', inputs: { width: w, height: h, batch_size: batch, color: 0x336699 } })
const exporting = (from: Link | null, over: Record<string, unknown> = {}, file = '') =>
  ({ class_type: 'Image', inputs: { image: file, export: true, ...SAVE_DEFAULTS, batch_index: -1, ...(from ? { images: from } : {}), ...over } })

describe('fix round 1: the Image card’s export (nodes_image.py Image.process)', () => {
  it('a single picture: saved once to the output folder under the card’s own name and settings, exactly as Save image saves it', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(40, 24), i: exporting(['e', 0], { filename_prefix: 'cards/shot_%width%', format: 'png' }), s: saveImage(['e', 0]) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const shown = shownBy(k.seen, 'i')
    expect(shown).toEqual([{ filename: 'shot_40_00001_.png', subfolder: 'cards', type: 'output' }])
    // The same pixels Save image writes of the same picture.
    const saved = run.takes[0]!.nodes.s!.outputs[0]!
    expect(Buffer.compare(await rgb(join(k.root, 'output', 'cards', 'shot_40_00001_.png')), await rgb(join(k.root, 'output', saved.subfolder, saved.filename)))).toBe(0)
    // It hands on the picture as without export.
    expect(run.takes[0]!.nodes.i!.values?.[0]).toEqual({ kind: 'files', files: (run.takes[0]!.nodes.e!.values?.[0] as { files: OutputFile[] }).files })
  }, 60_000)

  it('a batch is one save, a file per picture; JPEG at the card’s quality', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { e: emptyImage(16, 8, 3), i: exporting(['e', 0], { format: 'jpeg', filename_prefix: 'b' }) }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(shownBy(k.seen, 'i').map(f => f.filename)).toEqual(['b_00001_.jpg', 'b_00002_.jpg', 'b_00003_.jpg'])
    // batch_index picks one: one file.
    const k2 = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const { runId: r2 } = await k2.engine.startRun({ userId: null, takes: [{ e: emptyImage(16, 8, 3), i: exporting(['e', 0], { batch_index: 1 }) }], ...START })
    await k2.engine.settled(r2)
    expect(shownBy(k2.seen, 'i').map(f => f.filename)).toEqual(['ComfyUI_00001_.png'])
  }, 60_000)

  it('its own file: exported too; a see-through one keeps showing the card’s picture (Python’s is_rgba), still exported', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const px = Buffer.alloc(8 * 8 * 4, 0)
    for (let i = 0; i < 64; i++) { px[i * 4] = 200; px[i * 4 + 3] = i < 32 ? 255 : 0 }
    writeFileSync(join(k.root, 'input', 'cut.png'), await sharp(px, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer())
    writeFileSync(join(k.root, 'input', 'solid.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer())
    const p: ApiPrompt = { e: emptyImage(8, 8), s: saveImage(['e', 0]), c: exporting(null, { filename_prefix: 'cut' }, 'cut.png'), d: exporting(null, { filename_prefix: 'solid' }, 'solid.png') }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(shownBy(k.seen, 'c')).toEqual([{ filename: 'cut.png', subfolder: '', type: 'input' }])
    expect(shownBy(k.seen, 'd')).toEqual([{ filename: 'solid_00001_.png', subfolder: '', type: 'output' }])
    const cut = await sharp(readFileSync(join(k.root, 'output', 'cut_00001_.png'))).metadata()
    expect([cut.width, cut.height, cut.channels]).toEqual([8, 8, 4])
  }, 60_000)

  it('names are judged before anything is held or written: one outside the output folder is refused plainly', async () => {
    for (const hosted of [false, true]) {
      const k = makeKit({ hosted, deps: { families: () => EVERY_KNOWN_FAMILY } })
      const p: ApiPrompt = { l: smartLayout(), i: card(['l', 0]) }
      p.i!.inputs.filename_prefix = '../../elsewhere/x'
      await expect(k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(SAVE_OUTSIDE)
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(SAVE_OUTSIDE)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(readdirSync(join(k.root, 'output'))).toEqual([])
    }
  })

  it('an animation the card would export frame by frame is refused before the hold', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const frame = (c: string) => sharp({ create: { width: 4, height: 4, channels: 3, background: c } }).png().toBuffer()
    const gif = await sharp([await frame('#ff0000'), await frame('#00ff00')], { join: { animated: true } }).webp({ lossless: true }).toBuffer()
    writeFileSync(join(k.root, 'input', 'anim.webp'), gif)
    const p: ApiPrompt = { e: emptyImage(8, 8), s: saveImage(['e', 0]), c: exporting(null, {}, 'anim.webp') }
    await expect(k.engine.startRun({ userId: null, takes: [p], ...START })).rejects.toThrow(PICTURE_ANIMATED)
    // Export off: the card hands its file on as before.
    const off = makeKit({ hosted: false, deps: { families: () => CARDS } })
    writeFileSync(join(off.root, 'input', 'anim.webp'), gif)
    const { runId } = await off.engine.startRun({ userId: null, takes: [{ ...p, c: exporting(null, { export: false }, 'anim.webp') }], ...START })
    await off.engine.settled(runId)
    expect((await off.store.get(runId))!.status).toBe('done')
  })

  it('hosted: the exports are counted in the run’s kept room before the hold', async () => {
    // Five cards each exporting a batch at the save's cap (8192² × 4, about 1.08 GB each): past the 4 GiB room.
    const p: ApiPrompt = { e: emptyImage(8192, 8192, 4) }
    for (let n = 0; n < 5; n++) p[`i${n}`] = exporting(['e', 0])
    const k = makeKit({ hosted: true, deps: { families: () => EVERY_KNOWN_FAMILY } })
    await expect(k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(IMAGE_EXPORT_TOO_MUCH)
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(IMAGE_EXPORT_TOO_MUCH)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // Locally there is no kept room: nothing is refused for it (quoted only, nothing run).
    const local = makeKit({ hosted: false, deps: { families: () => EVERY_KNOWN_FAMILY } })
    await expect(local.engine.quoteRun({ userId: null, takes: [p], ...START })).resolves.toMatchObject({ usd: 0 })
  })

  it('the bound: Smart Layout’s outputs’ pixels, and a picture’s size × its count × the scale, each file’s chunks and text', async () => {
    const sl = await imageExportKeptBytes({ l: smartLayout(), i: card(['l', 0]) }, EVERY_KNOWN_FAMILY, {})
    const px = 300 * 250 + 320 * 50
    expect(sl.first).toEqual({ nodeId: 'i', classType: 'Image' })
    expect(sl.bytes).toBeGreaterThanOrEqual(Math.ceil(px * 4 * 1.01))
    expect(sl.bytes).toBeLessThan(Math.ceil(px * 4 * 1.01) + 2 * 400_000)
    const one = await imageExportKeptBytes({ e: emptyImage(100, 100, 2), i: exporting(['e', 0], { scale: 2 }) }, EVERY_KNOWN_FAMILY, {})
    expect(one.bytes).toBeGreaterThanOrEqual(Math.ceil(2 * 100 * 100 * 4 * 4 * 1.01))
    expect((await imageExportKeptBytes({ e: emptyImage(100, 100), i: exporting(['e', 0], { export: false }) }, EVERY_KNOWN_FAMILY, {}))).toEqual({ bytes: 0, first: null })
  })
})

// ── Fix round 1: the Text card showing a LoRA node's log (on NEEDS_LOCAL_ENGINE until step 4, C4) ──

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, never>
/** Flux Dev + LoRAs as saved before slots C and D (de3b2ec3's): its four required settings missing, as Python validates it. */
const oldMultiLora = () => ({ class_type: 'FluxMultiLoRARemoteNode', inputs: { prompt: 'char_jene_1', lora_a: 'Jene.safetensors', lora_a_url: '', scale_a: 1, lora_b: '[None]', lora_b_url: '', scale_b: 0.95, aspect_ratio: '1:1', num_inference_steps: 28, guidance: 3.5, seed: 6, prompt_strength: 0.8 } })
const multiLora = () => ({ ...oldMultiLora(), inputs: { ...oldMultiLora().inputs, lora_c: '[None]', lora_c_url: '', scale_c: 0.7, lora_d: '[None]', lora_d_url: '', scale_d: 0.6 } })
/** The Text card wired to the LoRA node's old second output (its log, which the node no longer has: Python's has one output). */
const logCard = (): ApiNode => ({ class_type: 'Text', inputs: { text: 'mode: text-to-image\nmodel: lucataco/flux-dev-multi-lora', source: ['m', 1] } })
type ApiNode = ApiPrompt[string]
const TITLES: Record<string, string> = { m: 'Flux Dev + LoRAs', mi: 'Picture', t: 'LoRA log', l: 'Layout', i: 'Layouts' }
const titleOf = (id: string) => TITLES[id] ?? id

describe('fix round 1: the Text card showing a LoRA node’s log', () => {
  it('de3b2ec3’s shape: the LoRA node fails validation, so its picture card and the log card are dropped as ComfyUI drops them; the card keeps its text', async () => {
    const p: ApiPrompt = { m: oldMultiLora(), mi: card(['m', 0]), t: logCard(), l: smartLayout(), i: card(['l', 0]) }
    // ComfyUI's validate_prompt (execution.py): the LoRA node's missing required inputs fail both outputs reading
    // it; the rest runs. The runner prunes the same way and reports the same node errors.
    const pruned = pruneInvalidOutputs(p, EVERY_KNOWN_FAMILY)
    expect(pruned.dropped.sort()).toEqual(['mi', 't'])
    expect(pruned.nodeErrors.m!.dependent_outputs.sort()).toEqual(['mi', 't'])
    expect(Object.keys(pruned.prompt).sort()).toEqual(['i', 'l'])
    expect(runnerTakesWorkflow(p, EVERY_KNOWN_FAMILY)).toBe(true)
    const k = makeKit({ hosted: false, deps: { families: () => EVERY_KNOWN_FAMILY } })
    const started = await k.engine.startRun({ userId: null, takes: [p], ...START })
    expect(Object.keys(started.nodeErrors ?? {})).toEqual(['m'])
    await k.engine.settled(started.runId)
    expect((await k.store.get(started.runId))!.status).toBe('done')
    // Nothing runs the LoRA (no call) or the log card (no `executed` for it: it keeps showing its saved text).
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(ofType(k.seen, 'executed').map(m => (m.data as { node: string }).node).sort()).toEqual(['i', 'l'])
  }, 60_000)

  it('C4: a LoRA node that runs: the log card reads an output the node no longer has, so it is dropped as ComfyUI drops it and the rest goes to the runner', () => {
    const p: ApiPrompt = { m: multiLora(), mi: card(['m', 0]), t: logCard(), l: smartLayout(), i: card(['l', 0]) }
    expect(pruneInvalidOutputs(p, EVERY_KNOWN_FAMILY).dropped).toEqual([])
    expect(runnerTakesWorkflow(p, EVERY_KNOWN_FAMILY)).toBe(false)
    // ComfyUI's validate_inputs reads RETURN_TYPES[1] of a one-output class, which raises: the card's output
    // fails validation and the rest runs. The canvas hands the runner the same (engineRunPrompt).
    const pruned = engineRunPrompt(p, CATALOG as never)!
    expect(Object.keys(pruned).sort()).toEqual(['i', 'l', 'm', 'mi'])
    expect(runnerTakesWorkflow(pruned, EVERY_KNOWN_FAMILY)).toBe(true)
    expect(leftOutNotice([{ prompt: p, pruned, titleOf }])).toMatchObject({ title: 'Some nodes were left out' })
    // Judged whole (were the runner to decline the rest), the card is named in plain words.
    expect(runRefusal([{ prompt: p, titleOf }], { runnerOn: true, families: EVERY_KNOWN_FAMILY, catalog: CATALOG }))
      .toEqual({ title: '“LoRA log” can’t run', description: `“LoRA log”: ${MISSING_OUTPUT_WORDS}` })
  })
})
