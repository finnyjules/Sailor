/**
 * Engine-free step 3, R11.4: Generate an image's three Recraft SVG models in
 * the runner (family `recraft-svg`, shared/runner/svgImage.ts), and the two
 * unpriced image models (`seedream-5-pro` on Generate an image, `reve-create`)
 * hidden and refused until each has a verified price (ruling (p)).
 *
 *   - the SVG is saved as the user's file and handed on as an `svg` value;
 *     Save image writes it into its own folder, Preview image shows it;
 *   - any other node wired to it needs pixels: refused before the hold, on
 *     the runner (start and quote), in the browser and on the ComfyUI proxy's
 *     check, with "This node needs a picture, not an SVG.";
 *   - with `recraft-svg` off, everything is as before (ComfyUI's path);
 *   - an unpriced model is offered by no menu, and refused before any hold
 *     wherever the run goes.
 *
 * No paid calls: the providers are fakes (tests/unit/__runner__/kit.ts).
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { planNode } from '~~/server/runner/executors'
import { RECRAFT_V3_SVG_STYLES, RUNNER_REPLICATE_IMAGE_MODELS, RUNNER_SVG_IMAGE_MODELS } from '~~/server/runner/generators/image'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { ANSWER_NOT_SVG, answerExt, isSvg } from '~~/server/runner/answerDownload'
import { svgSize } from '~~/server/runner/cards/saveImage'
import { userSubfolder } from '~~/server/runner/results'
import { priceGraph } from '~~/server/utils/priceBook'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID } from '~/data/image-models'
import { moodboardDefaultModel } from '~/lib/graph/moodboardApply'
import { IMAGE_RATES } from '#shared/pricing/imageRates'
import { creditsForUsd } from '#shared/pricing/markup'
import {
  ALL_RUNNER_FAMILIES, LATE_FAMILIES, LOCAL_MODEL_FAMILIES, NO_FAMILIES, RUNNER_FAMILIES, familyOn, parseFamilies, type RunnerFamily,
} from '#shared/runner/families'
import { RUNNER_REPLICATE_IMAGE_MODEL_IDS, isRunnerEligible, outputKindsFor, runnerTakesNode, svgReaderProblems } from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { SVG_IMAGE_FAMILY, SVG_IMAGE_MODEL_IDS, SVG_NEEDS_PICTURE } from '#shared/runner/svgImage'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { SVG_READERS_ADVICE, blockedPromptBody, blockedRunRefusal } from '#shared/runner/needsEngine'
import { galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import type { ApiPrompt } from '#shared/runner/graph'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'recraft-svg'])
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const SVG_BYTES = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768"><rect width="10" height="10"/></svg>\n')

const gen = (model: string, o: Record<string, unknown> = {}) => ({
  class_type: 'GenerateImageNode',
  inputs: { model, prompt: 'a fox logo', aspect_ratio: '1:1', seed: 0, model_options: '{}', ...o },
})
const save = (from: [string, number], o: Record<string, unknown> = {}) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS, ...o } })
const preview = (from: [string, number]) => ({ class_type: 'PreviewImage', inputs: { images: from } })
const imageCard = (from: [string, number]) => ({ class_type: 'Image', inputs: { image: '', export: false, images: from, batch_index: -1 } })
const edit = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { input_image: from, prompt: 'make it blue', model: 'Nano Banana 2' } })
const gate = (from: [string, number]) => ({ class_type: 'ComfyGateNode', inputs: { data_in: from, bypass: true } })

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

// ── 1. The family ────────────────────────────────────────────────────────

describe('the recraft-svg family', () => {
  it('is known, off by default, needs cards, and stays out of every pinned list', () => {
    expect(SVG_IMAGE_FAMILY).toBe('recraft-svg')
    expect(LATE_FAMILIES).toEqual(['recraft-svg'])
    expect(parseFamilies('recraft-svg,cards')).toEqual(new Set(['recraft-svg', 'cards']))
    // Without cards it is dropped: Save image and Preview image are cards.
    expect(parseFamilies('recraft-svg')).toEqual(NO_FAMILIES)
    expect(familyOn('recraft-svg', ON)).toBe(true)
    expect(familyOn('recraft-svg', new Set(['recraft-svg']))).toBe(false)
    for (const list of [RUNNER_FAMILIES, ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES]) expect(list).not.toContain('recraft-svg')
  })

  it('the three SVG models are Generate an image\'s "svg" models, priced, on Replicate with no backup, outside replicate-image', () => {
    expect(IMAGE_MODELS.filter(m => m.tags.includes('svg')).map(m => m.id).sort()).toEqual([...SVG_IMAGE_MODEL_IDS].sort())
    expect(Object.keys(RUNNER_SVG_IMAGE_MODELS).sort()).toEqual([...SVG_IMAGE_MODEL_IDS].sort())
    for (const id of SVG_IMAGE_MODEL_IDS) {
      expect(RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[], id).not.toContain(id)
      expect(RUNNER_REPLICATE_IMAGE_MODELS[id], id).toBeUndefined()
      expect(RUNNER_SVG_IMAGE_MODELS[id]!.slug).toBe(IMAGE_MODELS_BY_ID[id]!.replicateSlug)
      expect(RUNNER_ROUTES[`image:${id}`]).toMatchObject({ first: 'replicate', backup: null })
      expect(IMAGE_RATES[id]?.service, id).toBe('replicate')
    }
    expect(IMAGE_RATES['recraft-v4-pro-svg']!.usd).toBe(0.30)
    expect(IMAGE_RATES['recraft-v4-svg']!.usd).toBe(0.08)
    expect(IMAGE_RATES['recraft-v3-svg']!.usd).toBe(0.08)
  })
})

// ── 2. The request ───────────────────────────────────────────────────────

describe('the request, against each saved schema', () => {
  const RECRAFT_AR = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '4:5', '5:4', '1:2', '2:1']

  it('every ratio and style the node offers fits the schema; no seed (none of the three has one)', () => {
    let n = 0
    for (const d of Object.values(RUNNER_SVG_IMAGE_MODELS)) {
      const schema = loadProviderSchema('replicate', d.slug)
      const styles = d.id === 'recraft-v3-svg' ? [...RECRAFT_V3_SVG_STYLES, 'realistic_image', ''] : [undefined]
      for (const ar of [...IMAGE_MODELS_BY_ID[d.id]!.aspectRatios, '21:9', 'nonsense']) {
        for (const style of styles) {
          for (const seed of [0, 7, 4294967295]) {
            const adv = style === undefined ? {} : { style }
            const p = d.build({ prompt: 'a fox logo', aspectRatio: ar, seed, adv, refs: null })
            expect(checkPayload(schema, p), `${d.id} ${ar} ${style} ${seed}`).toEqual([])
            expect(p).not.toHaveProperty('seed')
            n++
          }
        }
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  it('Python\'s _b_recraft_v4 and _b_recraft_v3_svg, less the seed: the ratio from _RECRAFT_AR (else 1:1), V3\'s style from its five (else any)', () => {
    for (const id of ['recraft-v4-pro-svg', 'recraft-v4-svg']) {
      const d = RUNNER_SVG_IMAGE_MODELS[id]!
      for (const ar of RECRAFT_AR) expect(d.build({ prompt: 'p', aspectRatio: ar, seed: 3, adv: {}, refs: null })).toEqual({ prompt: 'p', aspect_ratio: ar })
      expect(d.build({ prompt: 'p', aspectRatio: '21:9', seed: 3, adv: {}, refs: null })).toEqual({ prompt: 'p', aspect_ratio: '1:1' })
    }
    const v3 = RUNNER_SVG_IMAGE_MODELS['recraft-v3-svg']!
    expect(v3.build({ prompt: 'p', aspectRatio: '16:9', seed: 0, adv: { style: 'linocut' }, refs: null })).toEqual({ prompt: 'p', aspect_ratio: '16:9', style: 'linocut' })
    expect(v3.build({ prompt: 'p', aspectRatio: '16:9', seed: 0, adv: {}, refs: null })).toEqual({ prompt: 'p', aspect_ratio: '16:9', style: 'any' })
    // The schema's five only (Python sends any text; Replicate would refuse it).
    expect(v3.build({ prompt: 'p', aspectRatio: '16:9', seed: 0, adv: { style: 'realistic_image' }, refs: null }).style).toBe('any')
    expect(RECRAFT_V3_SVG_STYLES).toEqual(IMAGE_MODELS_BY_ID['recraft-v3-svg']!.advanced[0]!.options)
  })

  it('planNode: Replicate, the model\'s slug, one SVG answer, no backup', async () => {
    for (const id of SVG_IMAGE_MODEL_IDS) {
      const p = await planNode({
        prompt: { n: gen(id, { prompt: 'a fox logo', aspect_ratio: '3:2' }) }, nodeId: 'n', gateOpen: false,
        filesFrom: () => [], valueFrom: () => undefined, toUrl: async () => 'unused',
      })
      expect(p.kind).toBe('provider')
      if (p.kind !== 'provider') continue
      expect(p).toMatchObject({ provider: 'replicate', endpoint: RUNNER_SVG_IMAGE_MODELS[id]!.slug, media: 'svg', take: 'first', prefix: 'generate_image' })
      expect(p.backup).toBeUndefined()
      expect(p.payload).toMatchObject({ prompt: 'a fox logo', aspect_ratio: '3:2' })
    }
  })
})

// ── 3. What the runner takes, and the svg value ──────────────────────────

describe('what the runner takes', () => {
  it('on: an SVG model alone, or into Save image or Preview image (through a Gate too)', () => {
    for (const id of SVG_IMAGE_MODEL_IDS) {
      expect(isRunnerEligible({ 1: gen(id) }, ON), id).toBe(true)
      expect(isRunnerEligible({ 1: gen(id), 2: save(['1', 0]) }, ON), id).toBe(true)
      expect(isRunnerEligible({ 1: gen(id), 2: preview(['1', 0]) }, ON), id).toBe(true)
      expect(isRunnerEligible({ 1: gen(id), 2: gate(['1', 0]), 3: save(['2', 0]) }, ON), id).toBe(true)
    }
  })

  it('off (cards only, or nothing): not taken, exactly as before', () => {
    for (const fams of [NO_FAMILIES, CARDS, new Set<RunnerFamily>(['replicate-image', 'cards'])]) {
      for (const id of SVG_IMAGE_MODEL_IDS) {
        expect(runnerTakesNode({ 1: gen(id) }, '1', fams), id).toBe(false)
        expect(isRunnerEligible({ 1: gen(id), 2: save(['1', 0]) }, fams), id).toBe(false)
      }
    }
  })

  it('slot 0 carries an svg value only for an SVG model with the family on', () => {
    const p: ApiPrompt = { 1: gen('recraft-v4-svg'), 2: gen('recraft-v4'), 3: gate(['1', 0]) }
    expect(outputKind(p, ['1', 0], outputKindsFor(ON))).toBe('svg')
    expect(outputKind(p, ['3', 0], outputKindsFor(ON))).toBe('svg')
    expect(outputKind(p, ['2', 0], outputKindsFor(ON))).toBe('files')
    expect(outputKind(p, ['1', 0], outputKindsFor(CARDS))).toBe('files')
    expect(outputKind(p, ['1', 0], outputKindsFor(NO_FAMILIES))).toBe('files')
  })

  it('a picture reader wired to an SVG is named, with the plain words; Save image, Preview image and the Gate are not', () => {
    const p: ApiPrompt = {
      1: gen('recraft-v4-svg'), 2: save(['1', 0]), 3: imageCard(['1', 0]), 4: gate(['1', 0]), 5: edit(['4', 0]), 6: preview(['4', 0]),
    }
    expect(svgReaderProblems(p, ON)).toEqual([
      { nodeId: '3', classType: 'Image', input: 'images', message: SVG_NEEDS_PICTURE },
      { nodeId: '5', classType: 'EditImageNode', input: 'input_image', message: SVG_NEEDS_PICTURE },
    ])
    expect(SVG_NEEDS_PICTURE).toBe('This node needs a picture, not an SVG.')
    // Off: none (ComfyUI's path, as before).
    expect(svgReaderProblems(p, CARDS)).toEqual([])
    // A picture model's output is no SVG.
    expect(svgReaderProblems({ 1: gen('recraft-v4'), 2: imageCard(['1', 0]) }, ON)).toEqual([])
  })
})

// ── 4. The price ─────────────────────────────────────────────────────────

describe('the price', () => {
  it('one call at the model\'s rate; Save image adds the render credit as for a picture', () => {
    for (const [id, usd] of [['recraft-v4-pro-svg', 0.30], ['recraft-v4-svg', 0.08], ['recraft-v3-svg', 0.08]] as const) {
      const priced = priceGraph({ 1: gen(id), 2: save(['1', 0]) }, { families: ON })
      expect(priced.nodes!['1'], id).toBe(creditsForUsd(usd))
    }
  })
})

// ── 5. On the engine (fake Replicate) ────────────────────────────────────

const svgReplicate = () => createFakeReplicate({ answer: req => `https://replicate.delivery/${String(req.model).split('/')[1]}.svg` })
const svgDownload = async (url: string) => (url.endsWith('.svg')
  ? { bytes: SVG_BYTES, contentType: 'image/svg+xml' }
  : { bytes: new TextEncoder().encode(url), contentType: 'image/png' })

function kitOn(hosted: boolean, o: { families?: ReadonlySet<RunnerFamily>, download?: typeof svgDownload } = {}) {
  return makeKit({ hosted, available: 50_000, replicate: svgReplicate(), deps: { families: () => o.families ?? ON, download: o.download ?? svgDownload } })
}

describe('on the engine', () => {
  for (const hosted of [false, true]) {
    it(`${hosted ? 'hosted' : 'locally'}: the SVG lands in Save image's folder, as it came, held and charged at the model's price`, async () => {
      const k = kitOn(hosted)
      const p: ApiPrompt = { 1: gen('recraft-v4-svg'), 2: save(['1', 0], { filename_prefix: 'logos/fox_%width%x%height%' }) }
      const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(started.runId)
      const run = (await k.store.get(started.runId))!
      expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
      expect(k.replicate.submitted().map(s => s.endpoint)).toEqual(['recraft-ai/recraft-v4-svg'])
      expect(k.replicate.submitted()[0]!.payload).toEqual({ prompt: 'a fox logo', aspect_ratio: '1:1' })
      // The node's own copy and Save image's, both SVGs; Save image's under its prefix's folder, named by the SVG's size.
      const user = hosted ? `${userSubfolder(k.userId, true)}/` : ''
      const outputs = filesUnder(join(k.root, 'output'))
      const saved = outputs.filter(f => f.startsWith(`${user}logos/`))
      expect(saved, JSON.stringify(outputs)).toEqual([`${user}logos/fox_1024x768_00001_.svg`])
      expect(outputs.filter(f => f.endsWith('.svg'))).toHaveLength(2)
      const { readFileSync } = await import('node:fs')
      expect(new Uint8Array(readFileSync(join(k.root, 'output', saved[0]!)))).toEqual(SVG_BYTES)
      // The svg value names the node's copy by its /view address.
      const v = run.takes[0]!.nodes['1']!.values?.[0]
      expect(v?.kind).toBe('svg')
      if (v?.kind === 'svg') expect(v.url).toBe(`/view?filename=${encodeURIComponent(v.file.filename)}&subfolder=${encodeURIComponent(v.file.subfolder)}&type=output`)
      // Held and charged one call at $0.08.
      const held = priceGraph(p, { families: ON })
      if (hosted) expect(k.ledger.hold).toHaveBeenCalledWith(k.userId, held.credits, `runner:${started.promptIds[0]}`)
      expect(run.takes[0]!.nodes['1']!.credits).toBe(creditsForUsd(0.08))
    }, 30_000)
  }

  it('Preview image shows the SVG from temp', async () => {
    const k = kitOn(false)
    const started = await k.engine.startRun({ userId: k.userId, takes: [{ 1: gen('recraft-v3-svg'), 2: preview(['1', 0]) }], ...START })
    await k.engine.settled(started.runId)
    const run = (await k.store.get(started.runId))!
    expect(run.status, JSON.stringify(run.takes[0]?.nodes)).toBe('done')
    expect(filesUnder(join(k.root, 'temp')).filter(f => /^ComfyUI_temp_[a-z]{5}_00001_\.svg$/.test(f))).toHaveLength(1)
  }, 30_000)

  it('a picture reader wired to the SVG is refused before the hold, on start and on the quote; nothing is sent', async () => {
    // Each reader is read by an output (one nothing reads is pruned, as ComfyUI prunes it).
    for (const reader of [imageCard(['1', 0]), edit(['1', 0])]) {
      const k = kitOn(true)
      const p: ApiPrompt = { 1: gen('recraft-v4-pro-svg'), 2: reader, 3: save(['1', 0]), 4: save(['2', 0]) }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(SVG_NEEDS_PICTURE)
      await expect(k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(SVG_NEEDS_PICTURE)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.submitted()).toEqual([])
    }
  }, 30_000)

  it('an answer that isn\'t an SVG is not kept: the node fails, the hold is released and nothing charged', async () => {
    const k = kitOn(true, { download: async () => ({ bytes: new TextEncoder().encode('<html>no</html>'), contentType: 'image/svg+xml' }) })
    const started = await k.engine.startRun({ userId: k.userId, takes: [{ 1: gen('recraft-v4-svg'), 2: save(['1', 0]) }], ...START })
    await k.engine.settled(started.runId)
    const run = (await k.store.get(started.runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toContain(ANSWER_NOT_SVG)
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual ?? 0])).toEqual([['released', 0]])
  }, 30_000)

  it('off: the runner declines an SVG model, as before (it goes to ComfyUI)', async () => {
    const k = kitOn(false, { families: CARDS })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ 1: gen('recraft-v4-svg'), 2: save(['1', 0]) }], ...START }))
      .rejects.toThrow('This workflow can’t run on the Sailor runner')
    expect(k.replicate.submitted()).toEqual([])
  })
})

describe('the SVG checks by bytes and by size', () => {
  it('isSvg: the root element after a declaration, comments or a doctype; nothing else', () => {
    expect(isSvg(SVG_BYTES)).toBe(true)
    expect(isSvg(new TextEncoder().encode('﻿<!-- made by Recraft --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg viewBox="0 0 1 1"/>'))).toBe(true)
    expect(isSvg(new TextEncoder().encode('<html><svg></svg></html>'))).toBe(false)
    expect(isSvg(new Uint8Array([0x89, 0x50, 0x4E, 0x47]))).toBe(false)
    expect(answerExt('svg', SVG_BYTES, 'image/svg+xml', 'https://x/y.svg')).toBe('svg')
    expect(() => answerExt('svg', new TextEncoder().encode('{}'), 'image/svg+xml', 'https://x/y.svg')).toThrow(ANSWER_NOT_SVG)
  })

  it('svgSize: width and height in pixels, else the viewBox, else 0 × 0', () => {
    expect(svgSize(SVG_BYTES)).toEqual({ w: 1024, h: 768 })
    expect(svgSize(new TextEncoder().encode('<svg viewBox="0 0 2048 1536.4" width="100%">'))).toEqual({ w: 2048, h: 1536 })
    expect(svgSize(new TextEncoder().encode('<svg width=\'512px\' height=\'256\'>'))).toEqual({ w: 512, h: 256 })
    expect(svgSize(new TextEncoder().encode('<svg>'))).toEqual({ w: 0, h: 0 })
  })
})

// ── 6. The browser and the ComfyUI path ──────────────────────────────────

describe('before /prompt (the browser) and on the proxy\'s check', () => {
  const titleOf = (id: string) => ({ 1: 'Logo', 2: 'Picture', 3: 'Save' } as Record<string, string>)[id] ?? id

  it('the browser refuses an SVG into a picture reader, naming that node', () => {
    const p: ApiPrompt = { 1: gen('recraft-v4-svg'), 2: imageCard(['1', 0]), 3: save(['1', 0]) }
    expect(blockedRunRefusal([{ prompt: p, titleOf }], { runnerOn: true, families: ON })).toEqual({
      title: '“Picture” needs a picture, not an SVG', description: SVG_READERS_ADVICE,
    })
    expect(SVG_READERS_ADVICE).toBe('Only Save image and Preview image take an SVG.')
    // Off, or the runner off: as before.
    expect(blockedRunRefusal([{ prompt: p, titleOf }], { runnerOn: true, families: CARDS })).toBeNull()
    expect(blockedRunRefusal([{ prompt: p, titleOf }], { runnerOn: false, families: ON })).toBeNull()
  })

  it('with the family on, an SVG model sent to ComfyUI (another node needs the engine) is refused: only the runner keeps its SVG', () => {
    const p: ApiPrompt = { 1: gen('recraft-v4-svg'), 2: save(['1', 0]), 3: { class_type: 'RestyleWithLoRANode', inputs: { image: ['4', 0], prompt: 'p' } }, 4: { class_type: 'LoadImage', inputs: { image: 'a.png' } } }
    const titles = (id: string) => ({ 1: 'Logo', 3: 'Restyle' } as Record<string, string>)[id] ?? id
    expect(blockedModelUses(p, { families: ON }).map(u => [u.nodeId, u.reason])).toEqual([['1', 'runner-only']])
    // The runner itself takes it: nothing blocked there.
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    const refusal = blockedRunRefusal([{ prompt: p, titleOf: titles }], { runnerOn: true, families: ON })!
    expect(refusal.title).toBe('“Logo” uses Recraft V4 SVG, which only runs in Sailor')
    expect(refusal.description).toContain('“Restyle”')
    // Off: ComfyUI's path, as before.
    expect(blockedModelUses(p, { families: CARDS })).toEqual([])
    expect(blockedRunRefusal([{ prompt: p, titleOf: titles }], { runnerOn: true, families: CARDS })).toBeNull()
  })

  afterEach(() => { vi.unstubAllEnvs() })

  it('the ComfyUI proxy\'s check (local /prompt and the hosted meter) refuses it in ComfyUI\'s 400 shape; off, as before', () => {
    const p: ApiPrompt = { 1: gen('recraft-v4-svg'), 2: imageCard(['1', 0]), 3: save(['1', 0]) }
    vi.stubEnv('NUXT_RUNNER_ENABLED', '1')
    vi.stubEnv('NUXT_RUNNER_FAMILIES', 'cards,recraft-svg')
    const body = blockedPromptRefusal(p, { isOutputClass: () => true })!
    expect(body.error.message).toBe(SVG_NEEDS_PICTURE)
    expect(body.node_errors).toEqual({
      2: { errors: [{ type: 'value_not_valid', message: SVG_NEEDS_PICTURE, details: '', extra_info: { input_name: 'images' } }], dependent_outputs: [], class_type: 'Image' },
    })
    vi.stubEnv('NUXT_RUNNER_FAMILIES', 'cards')
    expect(blockedPromptRefusal(p, { isOutputClass: () => true })).toBeNull()
  })
})

// ── 7. Unpriced models: hidden and refused (ruling (p)) ──────────────────

describe('unpriced image models', () => {
  const UNPRICED = ['seedream-5-pro', 'reve-create']

  it('exactly the Generate an image models with no rate card carry `unpriced`', () => {
    expect(IMAGE_MODELS.filter(m => !IMAGE_RATES[m.id]).map(m => m.id).sort()).toEqual([...UNPRICED].sort())
    expect(IMAGE_MODELS.filter(m => m.unpriced).map(m => m.id).sort()).toEqual([...UNPRICED].sort())
  })

  it('no menu offers them, none starts with them, and the moodboard never picks one', () => {
    const everyFamily = new Set<RunnerFamily>([...ALL_RUNNER_FAMILIES, ...LOCAL_MODEL_FAMILIES, ...LATE_FAMILIES])
    for (const families of [NO_FAMILIES, everyFamily]) {
      const shown = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families, current: 'nano-banana-2' }).map(e => e.model.id)
      for (const id of UNPRICED) expect(shown, id).not.toContain(id)
      expect(UNPRICED).not.toContain(menuDefault(modelMenu('GenerateImageNode')!, families))
    }
    // A saved node holding one shows it, tagged, so the node shows what it holds.
    const held = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: NO_FAMILIES, current: 'reve-create' })
    expect(held.find(e => e.model.id === 'reve-create')).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
    expect(UNPRICED).not.toContain(moodboardDefaultModel())
    expect(moodboardDefaultModel(IMAGE_MODELS.filter(m => m.id === 'seedream-5-pro' || m.id === 'nano-banana-2'), ['seedream-5-pro'])).toBe('nano-banana-2')
  })

  it('a saved project naming one is refused plainly in the browser and on the ComfyUI path, whatever the families', () => {
    for (const id of UNPRICED) {
      const p: ApiPrompt = { 1: { ...gen(id), _meta: { title: 'Hero shot' } } as ApiPrompt[string], 2: save(['1', 0]) }
      for (const families of [NO_FAMILIES, ON]) {
        expect(blockedModelUses(p, { families }).map(u => u.reason)).toEqual(['unpriced'])
        expect(blockedModelUses(p, { families, runnerTakes: true }).map(u => u.reason)).toEqual(['unpriced'])
        const label = IMAGE_MODELS_BY_ID[id]!.label
        expect(blockedRunRefusal([{ prompt: p, titleOf: () => 'Hero shot' }], { runnerOn: true, families })).toEqual({
          title: `“Hero shot” uses ${label}, which has no price yet`,
          description: 'Pick another model in “Hero shot”, such as Nano Banana 2.',
        })
        const body = blockedPromptBody(p, { families })!
        expect(body.error.message).toBe(`“Hero shot” uses ${label}, which has no price yet. Pick another model in “Hero shot”, such as Nano Banana 2.`)
        expect(Object.keys(body.node_errors)).toEqual(['1'])
      }
    }
  })

  it('the runner refuses one before the hold, on start and on the quote, with the families on', async () => {
    for (const id of UNPRICED) {
      const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => new Set<RunnerFamily>([...ALL_RUNNER_FAMILIES, ...LOCAL_MODEL_FAMILIES, ...LATE_FAMILIES]) } })
      const p: ApiPrompt = { 1: gen(id), 2: save(['1', 0]) }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow('which has no price yet')
      await expect(k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow('which has no price yet')
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.submitted()).toEqual([])
      expect(k.fal.client.submit).not.toHaveBeenCalled()
    }
  })
})
