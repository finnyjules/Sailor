/**
 * LC9: Smart Layout read by an Image card (28 saved graphs, off
 * NEEDS_LOCAL_ENGINE). Python's Image card doesn't declare INPUT_IS_LIST, so
 * fed Smart Layout's list it runs once per item (each a batch of one, so
 * `batch_index` slices nothing), shows every item, and hands a list on: its
 * own readers are held to the same list readers (eligibility.ts
 * LIST_PASSERS). Smart Layout is free (no provider, $0): the price and the
 * hold are exactly its Preview image twin's, the render credit alone (held
 * and charged in hosted, free locally). The card keeps nothing new: it hands
 * Smart Layout's kept files on and shows a temp copy of each.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { EVERY_KNOWN_FAMILY } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { NEEDS_LOCAL_ENGINE } from '#shared/runner/localOnly'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import type { OutputFile } from '~~/server/runner/types'

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
  it('Smart Layout is off the needs-the-local-engine list', () => {
    expect(NEEDS_LOCAL_ENGINE.SmartLayout).toBeUndefined()
  })

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
    it(`${hosted ? 'hosted' : 'locally'}: Smart Layout → Image card is priced and held as its Preview image twin, and the card shows every output`, async () => {
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
      // The card hands Smart Layout's own kept files on, still a list (batch_index 0 slices nothing): nothing new kept.
      expect(nodes.i!.values?.[0]).toEqual({ kind: 'files', files: made.files, list: true })
      expect(made.files).toHaveLength(2)
      // It shows each output, a temp copy of the render (the user's own folder in hosted).
      const shown = shownBy(k.seen, 'i')
      expect(shown).toHaveLength(2)
      for (const f of shown) {
        expect(f.type).toBe('temp')
        if (hosted) expect(f.subfolder).toMatch(/^u_/)
      }
      const previews = shownBy(k.seen, 'l')
      for (let n = 0; n < 2; n++) {
        const a = await rgb(join(k.root, 'temp', shown[n]!.subfolder, shown[n]!.filename))
        const b = await rgb(join(k.root, 'temp', previews[n]!.subfolder, previews[n]!.filename))
        expect(Buffer.compare(a, b)).toBe(0)
      }
      const sizes = await Promise.all(shown.map(f => sharp(readFileSync(join(k.root, 'temp', f.subfolder, f.filename))).metadata()))
      expect(sizes.map(m => [m.width, m.height])).toEqual([[300, 250], [320, 50]])
      expect(k.graphRuns.appendOutput).not.toHaveBeenCalled()
    }, 60_000)
  }

  it('Smart Layout → Image card → Save image saves each output, one run per item as Python does', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: smartLayout(), i: card(['l', 0]), s: saveImage(['i', 0]) }], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const s = run.takes[0]!.nodes.s!
    expect(s.outputs.map(f => f.filename)).toEqual(['ComfyUI_00001_.png', 'ComfyUI_00002_.png'])
    const sizes = await Promise.all(s.outputs.map(f => sharp(readFileSync(join(k.root, 'output', f.subfolder, f.filename))).metadata()))
    expect(sizes.map(m => [m.width, m.height, m.channels])).toEqual([[300, 250, 3], [320, 50, 3]])
  }, 60_000)
})
