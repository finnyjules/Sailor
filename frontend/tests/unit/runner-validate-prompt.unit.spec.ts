/**
 * ComfyUI's whole-prompt rule on the runner (shared/runner/validate.ts): an
 * output that fails validation is dropped with what only it needs, the rest
 * runs; every output failing is ComfyUI's refusal, in plain words.
 *
 * Parity: fixtures/runner-validate-prompt.json holds what the REAL
 * `execution.validate_prompt` kept for each prompt (scripts/compositor_fixtures.py,
 * network blocked): its good outputs, its node_errors, or its refusal.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_VALID_OUTPUTS_MESSAGE, RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { shouldUseRunner } from '~~/app/lib/runner/client'
import { nodesNeedingEngine } from '~~/app/lib/runner/needsEngine'
import { makeKit, ofType } from './__runner__/kit'

interface Case {
  name: string
  prompt: ApiPrompt
  ok: boolean
  error: string | null
  goodOutputs: string[]
  nodeErrors: Record<string, { types: string[]; dependent_outputs: string[]; class_type: string }>
}
const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-validate-prompt.json', import.meta.url)), 'utf8')) as { cases: Case[] }
const byName = (s: string) => FIX.cases.find(c => c.name.startsWith(s))!.prompt
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const NONE: ReadonlySet<RunnerFamily> = new Set()
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

describe('pruning matches the real validate_prompt', () => {
  it('has the cases the brief asks for', () => {
    expect(FIX.cases.length).toBeGreaterThanOrEqual(8)
    expect(FIX.cases.some(c => !c.ok && c.error === 'prompt_outputs_failed_validation')).toBe(true)
  })
  it.each(FIX.cases.map(c => [c.name, c] as const))('%s', (_n, c) => {
    const r = pruneInvalidOutputs(c.prompt)
    expect(r.failed).toBe(!c.ok)
    if (c.ok) {
      const kept = Object.keys(r.prompt).filter(id => RUNNER_OUTPUT_CLASSES.has(r.prompt[id]!.class_type)).sort()
      expect(kept).toEqual(c.goodOutputs)
    }
    const ours = Object.fromEntries(Object.entries(r.nodeErrors).map(([id, e]) => [id, {
      types: e.errors.map(x => x.type), dependent_outputs: [...e.dependent_outputs].sort(), class_type: e.class_type,
    }]))
    expect(ours).toEqual(c.nodeErrors)
  })
  it('keeps only what the kept outputs need, and leaves a prompt whose outputs all validate untouched', () => {
    const r = pruneInvalidOutputs(byName('image → Gate → video'))
    expect(Object.keys(r.prompt).sort()).toEqual(['1', '2', '3', '4'])
    const whole = byName('everything valid')
    expect(pruneInvalidOutputs(whole).prompt).toBe(whole)
  })
  it('does not prune a prompt holding a class the runner does not know (which outputs ComfyUI has is not knowable)', () => {
    const p: ApiPrompt = { ...byName('the blank project'), 7: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
    expect(pruneInvalidOutputs(p)).toMatchObject({ prompt: p, dropped: [], failed: false })
  })
})

describe('the browser agrees (shouldUseRunner, nodesNeedingEngine)', () => {
  const titleOf = (id: string) => `#${id}`
  it.each([['frame on', ALL], ['no families', NONE]] as const)('the blank project goes to the runner, %s', (_l, fam) => {
    const p = byName('the blank project')
    expect(isRunnerEligible(p, fam)).toBe(false) // whole, it would not
    expect(runnerTakesWorkflow(p, fam)).toBe(true)
    expect(shouldUseRunner(true, [p], fam)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf })).toEqual([])
  })
  it('image → Gate → video with a stray empty Frame: taken on the runner’s own models', () => {
    const p = byName('image → Gate → video')
    expect(runnerTakesWorkflow(p, NONE)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: NONE, titleOf })).toEqual([])
  })
  it('every output failing: the runner takes it to refuse it plainly; nothing needs the engine', () => {
    const p = byName('only an empty Frame')
    expect(runnerTakesWorkflow(p, ALL)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ALL, titleOf })).toEqual([])
  })
})

describe('the engine runs only what ComfyUI would', () => {
  it('the blank project: both Frames dropped, only the Image card runs, nothing is charged, node_errors reported', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    writeFileSync(join(k.root, 'input', 'land.png'), new Uint8Array([1, 2, 3]))
    const started = await k.engine.startRun({ userId: k.userId, takes: [byName('the blank project')], ...START })
    await k.engine.settled(started.runId)
    const run = (await k.store.get(started.runId))!
    expect(run.status).toBe('done')
    expect(Object.keys(run.takes[0]!.prompt)).toEqual(['1'])
    expect(Object.keys(run.takes[0]!.nodes)).toEqual(['1'])
    expect(ofType(k.seen, 'executed').map(m => m.data.node)).toEqual(['1'])
    expect(ofType(k.seen, 'executing').map(m => m.data.node)).not.toContain('3')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(started.nodeErrors).toMatchObject({ 3: { class_type: 'Compositor', dependent_outputs: ['3', '5'], errors: [{ type: 'required_input_missing', details: 'layer1' }] } })
  })

  it('image → Gate → video plus a stray empty Frame: taken, the Frame dropped, the rest runs and is charged as before', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => NONE } })
    const started = await k.engine.startRun({ userId: k.userId, takes: [byName('image → Gate → video')], ...START })
    await k.engine.settled(started.runId)
    const run = (await k.store.get(started.runId))!
    expect(Object.keys(run.takes[0]!.prompt).sort()).toEqual(['1', '2', '3', '4'])
    expect(run.status).toBe('paused') // the Gate, as always
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual([expect.stringContaining('flux')])
    expect(started.nodeErrors).toMatchObject({ 9: { dependent_outputs: ['9'] } })
  })

  it('every output failing: refused plainly (ComfyUI’s “Prompt outputs failed validation”), nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    const err = await k.engine.startRun({ userId: k.userId, takes: [byName('an empty Frame and a Frame on it')], ...START }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: NO_VALID_OUTPUTS_MESSAGE })
    // No "run it on ComfyUI" marker: ComfyUI refuses it too.
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined()
    expect((err as { data: { node_errors: Record<string, unknown> } }).data.node_errors).toHaveProperty('3')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  // R7.11 fix: the executed part comes from VALID outputs only (ComfyUI's good_outputs).
  const GEN = (prompt: string) => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
  /** Save image with its required widgets missing (format, quality, … embed_metadata): it fails validation. */
  const BAD_SAVE = (from: string) => ({ class_type: 'SaveImage', inputs: { images: [from, 0], filename_prefix: 'ComfyUI' } })

  it('R7.11: a paid node read only by an invalid Save image: refused plainly before the hold, no provider call', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    const p: ApiPrompt = { 1: GEN('a fox'), 2: BAD_SAVE('1') }
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: NO_VALID_OUTPUTS_MESSAGE })
    expect((err as { data: { node_errors: Record<string, unknown> } }).data.node_errors).toMatchObject({ 2: { class_type: 'SaveImage', dependent_outputs: ['2'] } })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('R7.11: one valid and one invalid output: only the valid branch runs, is held and charged; the invalid one is reported as ComfyUI does', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    const p: ApiPrompt = {
      1: GEN('a fox'),
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
      3: GEN('a cat'),
      4: BAD_SAVE('3'),
    }
    const pruned = pruneInvalidOutputs(p, ALL)
    expect(pruned).toMatchObject({ dropped: ['4'], unread: [], failed: false })
    const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    expect(started.nodeErrors).toMatchObject({ 4: { class_type: 'SaveImage', dependent_outputs: ['4'], errors: expect.arrayContaining([expect.objectContaining({ type: 'required_input_missing' })]) } })
    await k.engine.settled(started.runId)
    const run = (await k.store.get(started.runId))!
    expect(run.status).toBe('done')
    expect(Object.keys(run.takes[0]!.prompt).sort()).toEqual(['1', '2'])
    expect(Object.keys(run.takes[0]!.nodes).sort()).toEqual(['1', '2'])
    expect(k.fal.submitted().map(r => r.payload.prompt)).toEqual(['a fox'])
    // Held and charged for the one picture made (and the render credit): exactly the valid branch alone.
    const k2 = makeKit({ hosted: true, deps: { families: () => ALL } })
    const alone = await k2.engine.startRun({ userId: k2.userId, takes: [{ 1: p[1]!, 2: p[2]! }], ...START })
    await k2.engine.settled(alone.runId)
    const holds = (kit: typeof k) => [...kit.ledger.holds.values()].map(h => [h.credits, h.actual])
    expect(holds(k)).toEqual(holds(k2))
    expect(holds(k)[0]![1]).toBeGreaterThan(0)
  })

  it('R7.11: the R7 nodes are output nodes themselves (is_output_node=True): with an invalid Save image after one, it runs and shows its result, as in ComfyUI', () => {
    const load = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
    const nodes: Record<string, Record<string, unknown>> = {
      BackgroundRemove: { frames: ['l', 0], output: 'transparent', edge_softness: 0 },
      UpscaleImage: { frames: ['l', 0], tile_size: 512 },
    }
    for (const cls of ['BackgroundRemove', 'UpscaleImage', 'ObjectRemove', 'LensBlur']) expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(true)
    for (const [cls, inputs] of Object.entries(nodes)) {
      const r = pruneInvalidOutputs({ l: load, n: { class_type: cls, inputs }, s: BAD_SAVE('n') }, new Set([...ALL_RUNNER_FAMILIES, ...LOCAL_MODEL_FAMILIES]))
      expect(r.failed, cls).toBe(false)
      expect(r.dropped, cls).toEqual(['s'])
      expect(Object.keys(r.prompt).sort(), cls).toEqual(['l', 'n'])
    }
  })

  it('a prompt whose outputs all validate starts exactly as before (no node_errors)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    writeFileSync(join(k.root, 'input', 'land.png'), new Uint8Array([1]))
    const p: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      // Shown by a card: only what an output reads runs (R3.8 fix round 1).
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    expect(started.nodeErrors).toBeUndefined()
    await k.engine.settled(started.runId)
  })
})
