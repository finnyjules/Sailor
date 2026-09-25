/**
 * Runner families (Phase B, Task B1): the switches, the rule table and the
 * wider provider set. With every family off the runner takes exactly what it
 * took before; switching every family on changes nothing for the nodes no
 * family row covers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, nodeRuleAllows, runnerTakesNode,
} from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { runnerFamilies } from '~~/server/runner/config'
import { shouldUseRunner } from '~/lib/runner/client'
import { nodesNeedingEngine } from '~/lib/runner/needsEngine'

const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)

describe('parseFamilies', () => {
  it('reads a comma list, trimming spaces and case', () => {
    expect([...parseFamilies('fal-edit')]).toEqual(['fal-edit'])
    expect([...parseFamilies(' fal-edit , Replicate-Image ,restyle')].sort()).toEqual(['fal-edit', 'replicate-image', 'restyle'])
    expect([...parseFamilies('fal-edit,fal-edit')]).toEqual(['fal-edit'])
  })
  it('drops unknown names', () => {
    expect([...parseFamilies('fal-edit,krea,,  ,nano_actions')]).toEqual(['fal-edit'])
    expect(parseFamilies('everything').size).toBe(0)
  })
  it('is empty for anything unreadable', () => {
    for (const raw of [undefined, null, '', ' ', 0, 1, true, false, {}, { 'fal-edit': true }]) {
      expect(parseFamilies(raw).size, String(raw)).toBe(0)
    }
  })
  it('takes a list of names too (a runtime config value may arrive parsed)', () => {
    expect([...parseFamilies(['fal-edit', 7, 'nope', 'ref-edits'])].sort()).toEqual(['fal-edit', 'ref-edits'])
  })
  it('knows the nine families', () => {
    expect([...RUNNER_FAMILIES].sort()).toEqual(['bria-product-shot', 'fal-edit', 'frame', 'gemini-omni-flash', 'gpt-image-2.5', 'grok-imagine-2', 'h3-max-turbo', 'ideogram-4', 'nano-actions', 'nano-banana-2-blend', 'qwen-2511-angles', 'qwen-image-3', 'ref-edits', 'replicate-image', 'replicate-video', 'restyle', 'seedream-5-pro-edit', 'veo-3.1-lite', 'wan-3'])
  })
})

describe('server switch', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('reads NUXT_RUNNER_FAMILIES, only while the runner itself is on', () => {
    process.env.NUXT_RUNNER_FAMILIES = 'fal-edit,replicate-video'
    delete process.env.NUXT_RUNNER_ENABLED
    expect(runnerFamilies().size).toBe(0)
    process.env.NUXT_RUNNER_ENABLED = 'true'
    expect([...runnerFamilies()].sort()).toEqual(['fal-edit', 'replicate-video'])
    delete process.env.NUXT_RUNNER_FAMILIES
    expect(runnerFamilies().size).toBe(0)
  })
})

// ── Eligibility: the cases of runner-eligibility.unit.spec.ts, with no
// families and with every family, must give today's answer. ──────────────
const img = (model = 'flux-schnell', opts: unknown = '{}') => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: opts } })
const one = (node: ApiPrompt[string]): ApiPrompt => ({ '1': node })

const CASES: Array<[string, ApiPrompt, boolean]> = [
  ['image → Gate → video on runner models', {
    '1': img(),
    '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
    '3': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'y', image: ['2', 0], aspect_ratio: '16:9', duration: '8', seed: 0, model_options: '{}' } },
    '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['3', 0] } },
  }, true],
  ['another node type', { '1': img(), '2': { class_type: 'ImageBlur', inputs: { image: ['1', 0] } } }, false],
  ['an image model no family takes (recraft-v4-svg)', one(img('recraft-v4-svg')), false],
  ['an unpriced image model (reve-create)', one(img('reve-create')), false],
  ['a priced image model whose family is not built yet (krea-2-large)', one(img('krea-2-large')), false],
  ['no generator', one({ class_type: 'Image', inputs: { image: 'a.png' } }), false],
  ['empty', {}, false],
  ['a dangling link', { '1': { class_type: 'Image', inputs: { images: ['9', 0] } }, '2': img() }, false],
  ['sound wired into a video', one({ class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', audio: ['1', 0] } }), false],
  ['num_outputs 2', one(img('flux-schnell', JSON.stringify({ num_outputs: 2 }))), false],
  ['num_outputs "3"', one(img('flux-schnell', JSON.stringify({ num_outputs: '3' }))), false],
  ['num_outputs 4 as an object', one(img('flux-schnell', { num_outputs: 4 })), false],
  ['a Seedream series', one(img('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'auto', max_images: 4 }))), false],
  ['num_outputs 1', one(img('flux-schnell', JSON.stringify({ num_outputs: 1 }))), true],
  ['a Seedream series of one', one(img('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'auto', max_images: 1 }))), true],
  ['a Seedream series switched off', one(img('seedream-5-lite', JSON.stringify({ sequential_image_generation: 'disabled', max_images: 6 }))), true],
  ['unreadable options', one(img('flux-schnell', '{not json')), true],
  ['options that are a list', one(img('flux-schnell', '[2]')), true],
  ['empty options', one(img('flux-schnell', '')), true],
  ['no options', one(img('flux-schnell', undefined)), true],
  ['a legacy video label', one({ class_type: 'GenerateVideoNode', inputs: { model: 'Veo 3', prompt: 'p' } }), true],
  ['a video model no family takes (fabric-1.0)', one({ class_type: 'GenerateVideoNode', inputs: { model: 'fabric-1.0', prompt: 'p' } }), false],
  ['a node no family takes', { '1': { class_type: 'Image', inputs: { image: 'a.png' } }, '2': { class_type: 'RestyleWithLoRANode', inputs: { image: ['1', 0], prompt: 'p' } } }, false],
  ['a Nano Banana sibling no family takes (LensReframe)', { '1': { class_type: 'Image', inputs: { image: 'a.png' } }, '2': { class_type: 'LensReframe', inputs: { image: ['1', 0] } } }, false],
]

describe('eligibility with families', () => {
  it('every rule row names known families', () => {
    for (const rule of Object.values(RUNNER_NODE_RULES)) {
      const named = [rule.family, ...Object.values(rule.models ?? {}).map(m => typeof m === 'string' ? m : m.family)]
      for (const f of named.filter(Boolean)) expect(RUNNER_FAMILIES).toContain(f)
    }
  })
  it('the provider set is the two generators plus every rule row the runner does not compute itself', () => {
    const provider = Object.entries(RUNNER_NODE_RULES).filter(([, r]) => !r.local).map(([k]) => k)
    expect([...PROVIDER_TYPES].sort()).toEqual([...new Set(['GenerateImageNode', 'GenerateVideoNode', ...provider])].sort())
    expect(PROVIDER_TYPES.has('Compositor')).toBe(false)
    expect(PROVIDER_TYPES.has('LoadImage')).toBe(false)
  })
  it.each(CASES)('%s: the same answer with no families, the default and every family', (_label, prompt, want) => {
    expect(isRunnerEligible(prompt)).toBe(want)
    expect(isRunnerEligible(prompt, NO_FAMILIES)).toBe(want)
    expect(isRunnerEligible(prompt, ALL)).toBe(want)
    for (const id of Object.keys(prompt)) {
      expect(runnerTakesNode(prompt, id, ALL)).toBe(runnerTakesNode(prompt, id))
    }
  })
  it('the browser passes the families through (shouldUseRunner, nodesNeedingEngine)', () => {
    const ok = CASES[0]![1]
    expect(shouldUseRunner(true, [ok], ALL)).toBe(true)
    expect(shouldUseRunner(false, [ok], ALL)).toBe(false)
    expect(shouldUseRunner(true, [ok])).toBe(true)
    const blocked = CASES[1]![1]
    expect(nodesNeedingEngine(blocked, { runnerOn: true, families: ALL, titleOf: id => `n${id}` })).toEqual(['n2'])
    expect(nodesNeedingEngine(ok, { runnerOn: true, families: ALL, titleOf: id => `n${id}` })).toEqual([])
  })
})

describe('a rule row (checked on test-only rows; the table is empty)', () => {
  const on = (...f: RunnerFamily[]) => new Set<RunnerFamily>(f)
  it('a class-wide family switches the row on', () => {
    const rule = { family: 'fal-edit' as const, mustLink: ['input_image'] }
    expect(nodeRuleAllows('EditImageNode', rule, { input_image: ['1', 0] }, on())).toBe(false)
    expect(nodeRuleAllows('EditImageNode', rule, { input_image: ['1', 0] }, on('restyle'))).toBe(false)
    expect(nodeRuleAllows('EditImageNode', rule, { input_image: ['1', 0] }, on('fal-edit'))).toBe(true)
  })
  it('an input that must be linked, and one that must not be', () => {
    const rule = { family: 'fal-edit' as const, mustLink: ['image'], mustNotLink: ['keep_subject'] }
    const f = on('fal-edit')
    expect(nodeRuleAllows('BlendSceneNode', rule, { image: 'a.png' }, f)).toBe(false)
    expect(nodeRuleAllows('BlendSceneNode', rule, { image: ['1', 0] }, f)).toBe(true)
    expect(nodeRuleAllows('BlendSceneNode', rule, { image: ['1', 0], keep_subject: ['2', 0] }, f)).toBe(false)
  })
  it('a per-model map picks the family by the model widget; an unlisted model is not taken', () => {
    const rule = { models: { 'Flux Kontext Pro': 'fal-edit' as const, 'Nano Banana': 'nano-actions' as const } }
    expect(nodeRuleAllows('BlendSceneNode', rule, { model: 'Flux Kontext Pro' }, on('fal-edit'))).toBe(true)
    expect(nodeRuleAllows('BlendSceneNode', rule, { model: 'Nano Banana' }, on('fal-edit'))).toBe(false)
    expect(nodeRuleAllows('BlendSceneNode', rule, { model: 'Nano Banana' }, on('nano-actions'))).toBe(true)
    expect(nodeRuleAllows('BlendSceneNode', rule, { model: 'Something else' }, on('fal-edit', 'nano-actions'))).toBe(false)
    expect(nodeRuleAllows('BlendSceneNode', rule, {}, on('fal-edit'))).toBe(false)
  })
  it('a model row can ask for its own links; a video model is looked up by its current id', () => {
    const rule = { models: { 'wan-2.5-i2v-fast': { family: 'replicate-video' as const, mustLink: ['image'] }, 'kling-v2.5-turbo-pro': 'replicate-video' as const } }
    const f = on('replicate-video')
    expect(nodeRuleAllows('GenerateVideoNode', rule, { model: 'wan-2.5-i2v-fast' }, f)).toBe(false)
    expect(nodeRuleAllows('GenerateVideoNode', rule, { model: 'wan-2.5-i2v-fast', image: ['1', 0] }, f)).toBe(true)
    expect(nodeRuleAllows('GenerateVideoNode', rule, { model: 'Kling 2.1' }, f)).toBe(true)
  })
})
