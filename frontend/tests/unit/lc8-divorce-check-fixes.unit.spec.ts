// LC8: what the R11.10 divorce check found (B2, B3, F1, F2, F4), with the engine off.
// B1 is in run-socket-waits-for-engine.unit.spec.ts; B5 in run-refusal-keeps-project.unit.spec.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, type RunnerFamily } from '#shared/runner/families'
import {
  NOTHING_TO_RUN_WORDS, CUSTOM_NODE_WORDS, blockedRunRefusal, cantTakeItWords, engineRoute, engineRunPrompt,
  unknownClassRefusal, wireTypeMismatch,
} from '#shared/runner/needsEngine'
import { outputClassesOf, runnerTakesWorkflow, showsMadeResult } from '#shared/runner/validate'
import { autoSinkSlotType } from '~/lib/canvas/autoSinkSlot'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
const ALL = EVERY_KNOWN_FAMILY
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const titles: Record<string, string> = {}
const titleOf = (id: string) => titles[id] ?? id
const route = (p: ApiPrompt, o: { hosted?: boolean; engineUp?: boolean; declined?: string | null } = {}) =>
  engineRoute([{ prompt: p, titleOf }], { runnerOn: true, families: ALL, hosted: !!o.hosted, engineUp: !!o.engineUp, catalog: CATALOG, declined: o.declined ?? null })

// ── B2 ───────────────────────────────────────────────────────────────────────

describe('B2: a stock checkpoint graph with the engine off is judged as local-only, not as failed settings', () => {
  // Load Checkpoint's model list is empty with the engine off: its setting fails the runner's checks.
  const sd = (): ApiPrompt => ({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: null } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a fox', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    3: { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true, images: ['8', 0] } },
  })
  Object.assign(titles, { 3: 'KSampler', 4: 'Load Checkpoint', 9: 'Save Image' })

  it('engine off, locally: "This workflow needs the local engine", naming KSampler and Load Checkpoint', () => {
    const r = route(sd())
    expect(r.to).toBe('refused')
    expect(r).toMatchObject({ title: 'This workflow needs the local engine' })
    const d = (r as { description: string }).description
    expect(d).toContain('“KSampler”')
    expect(d).toContain('“Load Checkpoint”')
    expect(d).not.toContain('missing or invalid setting')
    // Save image reads VAE decode (local-only): it rides along, not named.
    expect(d).not.toContain('Save Image')
  })

  it('hosted: it runs only on the local engine', () => {
    const r = route(sd(), { hosted: true })
    expect(r).toMatchObject({ to: 'refused', title: 'This workflow can’t run here' })
    expect((r as { description: string }).description).toMatch(/“KSampler”.* run only on the local engine/)
  })

  it('engine up, locally: the engine judges its own nodes (it goes there)', () => {
    expect(route(sd(), { engineUp: true }).to).toBe('engine')
  })

  it('unwired local-only nodes nothing reads, engine off: still named as needing the engine, never "invalid setting"', () => {
    const p: ApiPrompt = {
      3: { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI' } },
    }
    const r = route(p)
    expect(r).toMatchObject({ to: 'refused', title: 'This workflow needs the local engine' })
    expect((r as { description: string }).description).toContain('“KSampler”')
    // Round 2 (R10.2): their presence routes the run: with the engine up it goes there, named by the engine's own errors.
    expect(route(p, { engineUp: true }).to).toBe('engine')
  })
})

// ── Round 2: project 34249b7f's shape ────────────────────────────────────────

describe('round 2: local-only nodes beside runnable chains are never left out (project 34249b7f)', () => {
  // Two copies of: stock nodes (unwired, as saved) and Load image + Image scale, with the auto Image cards
  // Run adds on VAE decode, Load image and Image scale. The Load image → Image chains alone would run.
  const shape = (): ApiPrompt => {
    const p: ApiPrompt = {}
    for (const k of ['a', 'b']) {
      p[`${k}ks`] = { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }
      p[`${k}clip`] = { class_type: 'CLIPTextEncode', inputs: { text: null } }
      p[`${k}vae`] = { class_type: 'VAEDecode', inputs: {} }
      p[`${k}ckpt`] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: null } }
      p[`${k}lat`] = { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } }
      p[`${k}save`] = { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true } }
      p[`${k}load`] = { class_type: 'LoadImage', inputs: { image: 'pasted.png' } }
      p[`${k}scale`] = { class_type: 'ImageScale', inputs: { upscale_method: 'nearest-exact', width: 512, height: 512, crop: 'disabled' } }
      p[`${k}s1`] = { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: [`${k}vae`, 0] } }
      p[`${k}s2`] = { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: [`${k}load`, 0] } }
      p[`${k}s3`] = { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: [`${k}scale`, 0] } }
    }
    return p
  }
  Object.assign(titles, { aks: 'KSampler', ackpt: 'Load Checkpoint', avae: 'VAE Decode', ascale: 'Upscale Image' })

  it('no runner hand-off: the pruning never leaves a local-only node out', () => {
    expect(runnerTakesWorkflow(shape(), ALL)).toBe(false)
    expect(engineRunPrompt(shape(), CATALOG)).toBeNull()
  })

  it('engine off, locally: refused, "needs the local engine", naming the stock nodes', () => {
    const r = route(shape())
    expect(r).toMatchObject({ to: 'refused', title: 'This workflow needs the local engine' })
    expect((r as { description: string }).description).toContain('“KSampler”')
  })

  it('hosted: refused, they run only on the local engine', () => {
    const r = route(shape(), { hosted: true })
    expect(r).toMatchObject({ to: 'refused', title: 'This workflow can’t run here' })
    expect((r as { description: string }).description).toMatch(/run only on the local engine/)
  })

  it('engine up, locally: the whole graph goes to the engine', () => {
    expect(route(shape(), { engineUp: true }).to).toBe('engine')
  })

  it('a custom node beside a runnable chain is never left out either; C4: a retired node nothing reads is, as ComfyUI leaves it out', () => {
    const chain = (): ApiPrompt => ({ l: { class_type: 'LoadImage', inputs: { image: 'pasted.png' } }, c: { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: ['l', 0] } } })
    const custom: ApiPrompt = { ...chain(), x: { class_type: 'LayerUtility: If ', inputs: {} } }
    titles.x = 'If'
    // A custom class counts as an output (the safe side): it is kept, so the run is no runner hand-off.
    const kept = engineRunPrompt(custom, CATALOG)
    expect(kept === null || 'x' in kept).toBe(true)
    expect(runnerTakesWorkflow(kept ?? custom, ALL)).toBe(false)
    expect(route(custom)).toMatchObject({ to: 'refused', title: 'This workflow needs the local engine' })
    expect(route(custom, { engineUp: true }).to).toBe('engine')
    // Step 4, C4: Kinetic Typography is retired (it was on NEEDS_LOCAL_ENGINE): one nothing reads is left out
    // (retired.ts retiredNodeIds), the chain handed to the runner; one an output reads is refused as retired.
    const kinetic: ApiPrompt = { ...chain(), k: { class_type: 'KineticType', inputs: {} } }
    const pruned = engineRunPrompt(kinetic, CATALOG)!
    expect(Object.keys(pruned).sort()).toEqual(['c', 'l'])
    expect(runnerTakesWorkflow(pruned, ALL)).toBe(true)
    expect(blockedRunRefusal([{ prompt: kinetic, titleOf: id => titles[id] ?? id }], { runnerOn: true, families: ALL, isOutputClass: outputClassesOf(CATALOG) })).toBeNull()
    const read: ApiPrompt = { ...kinetic, s: { class_type: 'SaveImage', inputs: { images: ['k', 0], filename_prefix: 'x' } } }
    expect(blockedRunRefusal([{ prompt: read, titleOf: () => 'Kinetic' }], { runnerOn: true, families: ALL, isOutputClass: outputClassesOf(CATALOG) }))
      .toEqual({ title: '“Kinetic” was retired', description: 'Use Vector Type instead.' })
  })

  it('a wrong-type wire is still dropped (r119c): no local-engine node there', () => {
    const p: ApiPrompt = {
      3: { class_type: 'LoadVideoFrames', inputs: { file: 'clip.mp4', max_seconds: 10, max_frames: 1, max_size: 720, start_frame: 0, stride: 1 } },
      2: { class_type: 'SaveImage', inputs: { filename_prefix: 'x', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true, images: ['3', 0] } },
      10: { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: ['3', 1] } },
    }
    expect(Object.keys(engineRunPrompt(p, CATALOG)!).sort()).toEqual(['2', '3'])
  })
})

// ── B3 ───────────────────────────────────────────────────────────────────────

describe('B3: an Image card wired to Load video frames\' rate', () => {
  // Project r119c-1790959907026, as the browser builds it (its shader baked later).
  const r119c = (): ApiPrompt => ({
    1: { class_type: 'ShaderEffect', inputs: { effect: 'wave', params: '{}', time: 0, duration: 0.125, fps: 24, seed: 1, resolution: 512, aspect: '1:1', image: ['3', 0] } },
    2: { class_type: 'SaveImage', inputs: { filename_prefix: 'r119c', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true, images: ['1', 0] } },
    3: { class_type: 'LoadVideoFrames', inputs: { file: 'clip.mp4', max_seconds: 10, max_frames: 1, max_size: 720, start_frame: 0, stride: 1 } },
    10: { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: ['3', 1] } },
  })

  it('the wire is a return-type mismatch, as ComfyUI validates it (FLOAT into IMAGE)', () => {
    expect(CATALOG.LoadVideoFrames.output).toEqual(['IMAGE', 'FLOAT'])
    expect(wireTypeMismatch(r119c(), '10', CATALOG)).toBe(true)
    expect(wireTypeMismatch(r119c(), '1', CATALOG)).toBe(false)
    expect(wireTypeMismatch(r119c(), '2', CATALOG)).toBe(false)
  })

  it('the broken branch is dropped and the rest runs, as ComfyUI ran it (outputs 1 and 2)', () => {
    const p = r119c()
    const pruned = engineRunPrompt(p, CATALOG)!
    expect(Object.keys(pruned).sort()).toEqual(['1', '2', '3'])
    // Nothing of the rest changed.
    expect(pruned[1]).toBe(p[1])
  })

  it('every output broken: refused, as ComfyUI refuses it', () => {
    const p: ApiPrompt = { 3: r119c()[3]!, 10: r119c()[10]! }
    expect(engineRunPrompt(p, CATALOG)).toBeNull()
  })

  it('the type check is left alone where the catalogue can\'t say: unknown classes, *, V3 meta-types, combos', () => {
    expect(wireTypeMismatch({ a: { class_type: 'NotInCatalog', inputs: {} }, b: { class_type: 'Image', inputs: { images: ['a', 0] } } }, 'b', CATALOG)).toBe(false)
    expect(wireTypeMismatch(r119c(), '10', null)).toBe(false)
    const cat = {
      Src: { output: ['FLOAT', '*', 'COMFY_MATCHTYPE_V3', 'INT,FLOAT'] },
      Dst: { input: { required: { a: ['IMAGE'], b: ['IMAGE'], c: ['IMAGE'], d: ['FLOAT'], e: ['COMBO'], f: [['x', 'y']] } } },
    }
    const dst = (input: string, slot: number): ApiPrompt => ({ s: { class_type: 'Src', inputs: {} }, d: { class_type: 'Dst', inputs: { [input]: ['s', slot] } } })
    expect(wireTypeMismatch(dst('a', 0), 'd', cat)).toBe(true)
    expect(wireTypeMismatch(dst('b', 1), 'd', cat)).toBe(false)
    expect(wireTypeMismatch(dst('c', 2), 'd', cat)).toBe(false)
    expect(wireTypeMismatch(dst('d', 3), 'd', cat)).toBe(false)
    expect(wireTypeMismatch(dst('e', 0), 'd', cat)).toBe(false)
    expect(wireTypeMismatch(dst('f', 0), 'd', cat)).toBe(false)
  })

  it('the auto-sink judges a slot by the catalogue\'s type at that index, not a drifted label', () => {
    // The saved card listed IMAGE, frames (IMAGE), fps (FLOAT); the catalogue has frames, fps.
    const out = CATALOG.LoadVideoFrames.output
    expect(autoSinkSlotType('IMAGE', out, 0)).toBe('IMAGE')
    expect(autoSinkSlotType('IMAGE', out, 1)).toBeNull()
    expect(autoSinkSlotType('FLOAT', out, 2)).toBeNull()
    // A card the catalogue doesn't hold keeps its own type.
    expect(autoSinkSlotType('image', undefined, 3)).toBe('IMAGE')
  })
})

// ── F1 ───────────────────────────────────────────────────────────────────────

describe('F1: a canvas of cards alone', () => {
  const emptyToCard = (): ApiPrompt => ({
    e: { class_type: 'EmptyImage', inputs: { width: 64, height: 32, batch_size: 1, color: 0 } },
    c: { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1, images: ['e', 0] } },
  })
  const cardAlone = (): ApiPrompt => ({ c: { class_type: 'Image', inputs: { image: '', export: true, filename_prefix: 'ComfyUI', batch_index: -1 } } })

  it('Empty image → Image card is taken by the runner (an output reads something made in the run)', () => {
    expect(showsMadeResult(emptyToCard())).toBe(true)
    expect(runnerTakesWorkflow(emptyToCard(), new Set<RunnerFamily>(['cards']))).toBe(true)
    expect(runnerTakesWorkflow(emptyToCard(), ALL)).toBe(true)
  })

  it('…and runs to the end on the runner, free, with nothing called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => new Set<RunnerFamily>(['cards']) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [emptyToCard()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes.e!.credits ?? 0).toBe(0)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('an Image card alone makes nothing: not taken, and the words say there is nothing to run', () => {
    expect(showsMadeResult(cardAlone())).toBe(false)
    expect(runnerTakesWorkflow(cardAlone(), ALL)).toBe(false)
    const r = route(cardAlone())
    expect(r).toEqual({ to: 'refused', title: 'Nothing to run', description: NOTHING_TO_RUN_WORDS })
    // The runner's generic decline gets the same words; its own particular words stand.
    expect(route(cardAlone(), { declined: 'Sailor can’t run this workflow yet.' })).toMatchObject({ title: 'Nothing to run' })
    expect(route(cardAlone(), { declined: 'Running workflows in Sailor is switched off on this server right now.' }))
      .toMatchObject({ description: 'Running workflows in Sailor is switched off on this server right now.' })
  })

  it('the start refuses a card alone (not taken) and holds nothing', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [cardAlone()], ...START })).rejects.toMatchObject({ statusCode: 400 })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── F2 ───────────────────────────────────────────────────────────────────────

describe('F2: Enhance a video → Save video', () => {
  const p = (): ApiPrompt => ({
    n: { class_type: 'EnhanceVideoNode', inputs: { model: 'Topaz Video Upscale', video_url: 'https://example.com/a.mp4', target_resolution: '1080p', fps: 'original' } },
    r: { class_type: 'SaveVideo', inputs: { video: ['n', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
  })
  Object.assign(titles, { n: 'Enhance a video', r: 'Save video' })

  it('Save video takes Topaz\'s video on the runner, as it takes Generate a video\'s', () => {
    expect(runnerTakesWorkflow(p(), ALL)).toBe(true)
  })

  it('where it still isn\'t taken (Save video\'s family off), the words never mention the engine', () => {
    const fams = new Set<RunnerFamily>([...ALL].filter(f => f !== 'media-video'))
    expect(runnerTakesWorkflow(p(), fams)).toBe(false)
    const b = blockedRunRefusal([{ prompt: p(), titleOf }], { runnerOn: true, families: fams, isOutputClass: outputClassesOf(CATALOG) })!
    expect(b.title).toBe('“Enhance a video” uses Topaz Video Upscale, which only runs in Sailor')
    // Save video's own family is off: said so, never "Only the engine can run".
    expect(b.description).toBe('“Save video” is switched off right now.')
    expect(`${b.title} ${b.description}`).not.toMatch(/engine/i)
  })

  it('a local-only node beside it: that one does need the engine, and is named so', () => {
    const fams = ALL
    const k: ApiPrompt = { ...p(), k: { class_type: 'KSampler', inputs: {} } }
    titles.k = 'Old sampler'
    const bk = blockedRunRefusal([{ prompt: k, titleOf }], { runnerOn: true, families: fams, isOutputClass: outputClassesOf(CATALOG) })!
    expect(bk.description).toBe('Only the engine can run “Old sampler”.')
  })

  it('cantTakeItWords says what to change', () => {
    expect(cantTakeItWords(['Save video'])).toBe('“Save video” can’t take this as it’s set up. Change what it’s wired to, or show the result in a card.')
    expect(cantTakeItWords(['A', 'B'])).toContain('they’re set up')
  })
})

// ── F4 ───────────────────────────────────────────────────────────────────────

describe('F4: a custom node the catalogue doesn\'t hold', () => {
  it('engine off: the local-engine words, naming it; hosted: it runs only there; engine up: not installed', () => {
    const off = unknownClassRefusal('LayerUtility: If ', 'If', { hosted: false, engineUp: false })!
    expect(off.title).toBe('This workflow needs the local engine')
    expect(off.description).toContain('“If”')
    expect(off.description).toContain(CUSTOM_NODE_WORDS)
    expect(unknownClassRefusal('LayerUtility: If ', 'If', { hosted: true, engineUp: false })).toEqual({ title: 'This workflow can’t run here', description: `“If”: ${CUSTOM_NODE_WORDS}` })
    expect(unknownClassRefusal('LayerUtility: If ', 'If', { hosted: false, engineUp: true })!.title).toBe('“If” isn’t installed')
  })

  it('a class Sailor knows keeps the builder\'s own error', () => {
    expect(unknownClassRefusal('KSampler', 'KSampler', { hosted: false, engineUp: false })).toBeNull()
    expect(unknownClassRefusal('Image', 'Image', { hosted: false, engineUp: false })).toBeNull()
  })

  it('the layout judges an unknown node before showing a builder error', () => {
    const src = readFileSync(join(__dirname, '../../app/layouts/default.vue'), 'utf8')
    const at = src.indexOf('unknownClassRefusal(err.classType')
    expect(at).toBeGreaterThan(0)
    expect(src.indexOf('Couldn\'t build workflow', at)).toBeGreaterThan(at)
  })
})
