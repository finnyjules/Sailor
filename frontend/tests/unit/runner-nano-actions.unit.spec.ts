/**
 * The Nano Banana actions (Phase B, Task B5, family `nano-actions`):
 * RemoveObjectNode, TextEditNode, RecolorObjectNode, SwapBackgroundNode,
 * SwapProductNode and PersonSwap send google/nano-banana-2 on Replicate;
 * BlendSceneNode's Nano Banana mode sends google/nano-banana.
 *
 * The payloads are checked against the first provider call the Python node
 * makes, and every pass-through against the picture Python hands on
 * (fixtures/runner-families.json `nanoActions`, written by
 * scripts/runner_builder_fixtures.py --no-network). Engine tests use the fake
 * Replicate only: nothing here reaches a provider.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { nodeCredits, stageEstimate, unpricedProviderNode } from '~~/server/runner/metering'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS } from '~~/server/utils/priceBook'
import {
  KEEP_OUTFIT_PROMPT, NEW_LOOK_PROMPT, SWAP_PRODUCT_PROMPT, actionPassThrough, personSwapInstruction,
  recolorInstruction, removeObjectInstruction, swapBackgroundInstruction, swapProductInstruction, textEditInstruction,
} from '~~/server/runner/generators/actions'
import { pyStrip } from '~~/server/runner/generators/opts'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode, type RunnerNodeRule } from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '~~/server/runner/types'
import { createFakeReplicate, makeKit, ofType } from './__runner__/kit'

interface NanoCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call: { provider: string; endpoint: string; payload: Record<string, unknown> } | { passthrough: true }
  passes?: string | null
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { nanoActions: NanoCase[] }).nanoActions

const NANO: ReadonlySet<RunnerFamily> = new Set(['nano-actions'])
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'nano-actions'))
const ACTIONS = ['PersonSwap', 'RecolorObjectNode', 'RemoveObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'TextEditNode']
const isPass = (c: NanoCase): c is NanoCase & { call: { passthrough: true } } => 'passthrough' in c.call

// ── Parity with the Python nodes ─────────────────────────────────────────

const fileOf = (name: string): OutputFile => ({ filename: `${name}.png`, subfolder: '', type: 'output' })

/** A case as the node the canvas sends: each linked picture comes from a node `src_<input>`. */
function planCase(c: NanoCase, handedOff: string[] = []) {
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  return planNode({
    prompt: { n: { class_type: c.class_type, inputs } },
    nodeId: 'n',
    filesFrom: ([from]) => [fileOf(from.slice(4))],
    // Python passes each picture through _image_tensor_to_data_url → `IMG:<input>`.
    toUrl: async (f: OutputFile) => {
      const name = f.filename.replace(/\.png$/, '')
      handedOff.push(name)
      return `IMG:${name}`
    },
    gateOpen: false,
  })
}

describe('nano-actions payloads match the Python nodes', () => {
  it('the fixture covers every class, calls and pass-throughs', () => {
    const calls = new Set(CASES.filter(c => !isPass(c)).map(c => c.class_type))
    const passes = new Set(CASES.filter(isPass).map(c => `${c.class_type}:${c.passes}`))
    expect([...calls].sort()).toEqual(['BlendSceneNode', ...ACTIONS].sort())
    expect([...passes].sort()).toEqual([
      'PersonSwap:scene', 'RecolorObjectNode:image', 'RemoveObjectNode:image',
      'SwapBackgroundNode:product', 'SwapProductNode:scene_reference', 'TextEditNode:image',
    ])
    expect(CASES.length).toBeGreaterThan(250)
    for (const c of CASES.filter(c => !isPass(c))) {
      const call = c.call as { provider: string; endpoint: string }
      expect(call.provider).toBe('replicate')
      expect(call.endpoint).toBe(c.class_type === 'BlendSceneNode' ? 'google/nano-banana' : 'google/nano-banana-2')
    }
    expect(CASES.filter(c => c.class_type === 'BlendSceneNode').every(c => c.widgets.model === 'Nano Banana')).toBe(true)
  })

  it.each(CASES.map((c, i) => [`${i} ${c.class_type} ${JSON.stringify(c.widgets)} links=${c.links.join(',')}`, c] as const))(
    '%s', async (_label, c) => {
      const handedOff: string[] = []
      const plan = await planCase(c, handedOff)
      if (isPass(c)) {
        // The picture Python hands on, as it is: no call, no hand-off.
        expect(plan.kind).toBe('pass')
        if (plan.kind !== 'pass') return
        expect(plan.files).toEqual([fileOf(c.passes!)])
        expect(plan.ui).toEqual({ images: [fileOf(c.passes!)] })
        expect(handedOff).toEqual([])
        expect(actionPassThrough(c.class_type, { ...c.widgets, ...Object.fromEntries(c.links.map(l => [l, ['s', 0]])) })).toBe(c.passes)
        return
      }
      expect(plan.kind).toBe('provider')
      if (plan.kind !== 'provider') return
      expect(plan.provider).toBe(c.call.provider)
      expect(plan.endpoint).toBe(c.call.endpoint)
      expect(plan.payload).toEqual(c.call.payload)
      expect(plan.media).toBe('image')
    })

  it('names each output with the Python asset tag and shows it as a still', async () => {
    const want: Record<string, string> = {
      RemoveObjectNode: 'remove_object', TextEditNode: 'text_edit', RecolorObjectNode: 'recolor_object',
      SwapBackgroundNode: 'swap_background', SwapProductNode: 'swap_product', PersonSwap: 'person_swap', BlendSceneNode: 'blend_scene',
    }
    for (const [ct, prefix] of Object.entries(want)) {
      const plan = await planCase(CASES.find(c => c.class_type === ct && !isPass(c))!)
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(plan.prefix).toBe(prefix)
      const files = [fileOf(`${prefix}_00001_`)]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
  })

  it('the pictures go in the order Python sends them', () => {
    const order = (ct: string, links: string[]) => {
      const c = CASES.find(x => x.class_type === ct && !isPass(x) && x.links.join() === links.join())!
      return (c.call as { payload: { image_input: string[] } }).payload.image_input
    }
    expect(order('SwapBackgroundNode', ['product', 'background_reference'])).toEqual(['IMG:background_reference', 'IMG:product'])
    expect(order('SwapBackgroundNode', ['product'])).toEqual(['IMG:product'])
    expect(order('SwapProductNode', ['scene_reference', 'product'])).toEqual(['IMG:scene_reference', 'IMG:product'])
    expect(order('PersonSwap', ['scene', 'person'])).toEqual(['IMG:scene', 'IMG:person'])
  })

  it('a linked picture that brought no file fails the node with a plain message', async () => {
    const plan = (ct: string, inputs: Record<string, unknown>, empty: string) => planNode({
      prompt: { n: { class_type: ct, inputs } }, nodeId: 'n', gateOpen: false, toUrl: async () => 'x',
      filesFrom: ([from]) => from === empty ? [] : [fileOf(from)],
    })
    await expect(plan('RemoveObjectNode', { image: ['a', 0], target: 'x' }, 'a')).rejects.toThrow('There is no picture to edit')
    await expect(plan('RemoveObjectNode', { image: ['a', 0], target: '' }, 'a')).rejects.toThrow('There is no picture to pass on')
    await expect(plan('SwapProductNode', { scene_reference: ['s', 0], product: ['p', 0] }, 'p')).rejects.toThrow('There is no product picture')
    await expect(plan('PersonSwap', { scene: ['s', 0], person: ['p', 0] }, 'p')).rejects.toThrow('There is no picture of the person')
    await expect(plan('SwapBackgroundNode', { product: ['p', 0], background_reference: ['b', 0] }, 'b')).rejects.toThrow('There is no background picture')
  })
})

// ── Prompts (ports of tests-unit/comfy_extras_test/*_prompts_test.py) ─────

describe('edit action prompts (edit_action_prompts_test.py)', () => {
  it('remove names the target', () => expect(removeObjectInstruction('the red car')).toContain('the red car'))
  it('remove fills with the background', () => {
    const low = removeObjectInstruction('a lamppost').toLowerCase()
    expect(low.includes('background') || low.includes('surrounding')).toBe(true)
    expect(low).toContain('remove')
  })
  it('remove keeps everything else', () => {
    const low = removeObjectInstruction('a lamppost').toLowerCase()
    expect(low.includes('everything else') || low.includes('keep')).toBe(true)
  })
  it('remove appends extra instructions', () => {
    expect(removeObjectInstruction('the sign', 'match the wall texture').endsWith('Additional direction: match the wall texture.')).toBe(true)
  })
  it('remove strips blank instructions', () => expect(removeObjectInstruction('x', '   ')).toBe(removeObjectInstruction('x')))
  it('text edit quotes find and replace', () => {
    const out = textEditInstruction('SALE', '50% OFF')
    expect(out).toContain('\'SALE\'')
    expect(out).toContain('\'50% OFF\'')
  })
  it('text edit preserves typography', () => {
    const low = textEditInstruction('a', 'b').toLowerCase()
    expect(low).toContain('font')
    expect(low).toContain('perspective')
    expect(low.includes('change nothing else') || low.includes('everything else')).toBe(true)
  })
  it('text edit appends extra instructions', () => {
    expect(textEditInstruction('a', 'b', 'keep the neon glow').endsWith('Additional direction: keep the neon glow.')).toBe(true)
  })
  it('recolor names target and color', () => {
    const out = recolorInstruction('the shirt', 'forest green (#2d6a4f)')
    expect(out).toContain('the shirt')
    expect(out).toContain('forest green (#2d6a4f)')
  })
  it('recolor keeps material and lighting', () => {
    const low = recolorInstruction('the shirt', 'red').toLowerCase()
    expect(low).toContain('texture')
    expect(low).toContain('lighting')
    expect(low.includes('material') || low.includes('shading')).toBe(true)
  })
  it('recolor appends extra instructions', () => {
    expect(recolorInstruction('the mug', '#ff0000', 'matte finish').endsWith('Additional direction: matte finish.')).toBe(true)
  })
})

describe('person swap prompts (person_swap_prompts_test.py)', () => {
  it('keep outfit true uses the keep-outfit prompt', () => expect(personSwapInstruction(true, '')).toBe(KEEP_OUTFIT_PROMPT))
  it('keep outfit false uses the new-look prompt', () => expect(personSwapInstruction(false, '')).toBe(NEW_LOOK_PROMPT))
  it('instructions appended when present', () => {
    const out = personSwapInstruction(true, 'replace the woman on the left')
    expect(out.startsWith(KEEP_OUTFIT_PROMPT)).toBe(true)
    expect(out).toContain('Additional direction: replace the woman on the left.')
  })
  it('no instructions appended when blank', () => {
    expect(personSwapInstruction(true, '   ')).toBe(KEEP_OUTFIT_PROMPT)
    expect(personSwapInstruction(false, '')).toBe(NEW_LOOK_PROMPT)
  })
  it('the keep-outfit prompt keeps the wardrobe', () => {
    const low = KEEP_OUTFIT_PROMPT.toLowerCase()
    expect(low.includes('outfit') || low.includes('clothing')).toBe(true)
  })
  it('the new-look prompt brings a new wardrobe', () => {
    const low = NEW_LOOK_PROMPT.toLowerCase()
    expect(low.includes('clothing') || low.includes('wardrobe')).toBe(true)
  })
})

describe('swap background prompts (swap_background_prompts_test.py)', () => {
  const base = (o: Partial<Parameters<typeof swapBackgroundInstruction>[0]> = {}) => swapBackgroundInstruction({
    hasReference: false, scenePrompt: '', relightToScene: true, groundWithShadow: true, keepScaleAndPlacement: true, instructions: '', ...o,
  })
  it('reference mode wording when there is a reference', () => {
    const low = base({ hasReference: true }).toLowerCase()
    expect(low).toContain('first image')
    expect(low).toContain('second image')
  })
  it('prompt mode includes the scene prompt text', () => expect(base({ scenePrompt: 'marble bathroom counter' })).toContain('marble bathroom counter'))
  it('branding always preserved', () => {
    const low = base().toLowerCase()
    expect(low.includes('label') || low.includes('logo') || low.includes('branding')).toBe(true)
  })
  it('relight on adds the relight clause, off keeps the original', () => {
    const on = base({ relightToScene: true }).toLowerCase()
    const off = base({ relightToScene: false }).toLowerCase()
    expect(on.includes('relight') || on.includes('re-light')).toBe(true)
    expect(off.includes('original lighting') || off.includes('keep the product\'s lighting')).toBe(true)
  })
  it('no faithful-colours trap when relighting', () => {
    const low = base({ relightToScene: true }).toLowerCase()
    expect(low).not.toContain('colours faithfully')
    expect(low).not.toContain('colors faithfully')
  })
  it('ground with shadow toggles its clause', () => {
    expect(base({ groundWithShadow: true }).toLowerCase()).toContain('shadow')
    const off = base({ groundWithShadow: false }).toLowerCase()
    expect(off.includes('no cast shadow') || off.includes('no shadow')).toBe(true)
  })
  it('keep scale toggles its clause', () => {
    const on = base({ keepScaleAndPlacement: true }).toLowerCase()
    expect(on.includes('same size and position') || on.includes('same scale and position')).toBe(true)
    expect(base({ keepScaleAndPlacement: false }).toLowerCase()).toContain('compose')
  })
  it('instructions appended when present', () => expect(base({ instructions: 'warmer tone' })).toContain('Additional direction: warmer tone.'))
  it('blank instructions not appended', () => expect(base({ instructions: '   ' })).not.toContain('Additional direction'))
})

describe('swap product prompts (swap_product_prompts_test.py)', () => {
  it('blank instructions return the base prompt', () => expect(swapProductInstruction('')).toBe(SWAP_PRODUCT_PROMPT))
  it('whitespace instructions return the base prompt', () => expect(swapProductInstruction('   ')).toBe(SWAP_PRODUCT_PROMPT))
  it('instructions appended when present', () => {
    const out = swapProductInstruction('shift the bottle slightly left')
    expect(out.startsWith(SWAP_PRODUCT_PROMPT)).toBe(true)
    expect(out).toContain('Additional direction: shift the bottle slightly left.')
  })
  it('the base prompt preserves branding', () => {
    const low = SWAP_PRODUCT_PROMPT.toLowerCase()
    expect(low.includes('label') || low.includes('logo') || low.includes('branding')).toBe(true)
  })
  it('the base prompt keeps the scene fixed', () => {
    const low = SWAP_PRODUCT_PROMPT.toLowerCase()
    expect(low).toContain('background')
    expect(low).toContain('camera')
  })
  it('the base prompt relights the product to the scene', () => {
    const low = SWAP_PRODUCT_PROMPT.toLowerCase()
    expect(low.includes('re-light') || low.includes('relight')).toBe(true)
    expect(low).toContain('discard')
    expect(low).toContain('lighting')
  })
})

describe('pyStrip is Python str.strip()', () => {
  it.each([
    ['  a  ', 'a'], ['\t\n\v\f\r a \r\n', 'a'], ['\x1fa\x1c', 'a'], ['\x85a　', 'a'],
    ['﻿a﻿', '﻿a﻿'], ['', ''], ['a b', 'a b'],
  ])('%j → %j', (s, want) => expect(pyStrip(s)).toBe(want))
})

// ── Eligibility rows ─────────────────────────────────────────────────────

const nodeRuleFamilies = (r: RunnerNodeRule): string[] =>
  [r.family, ...Object.values(r.models ?? {}).map(m => typeof m === 'string' ? m : m.family)].filter((f): f is RunnerFamily => !!f)

const withNode = (n: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt =>
  ({ 1: { class_type: 'Image', inputs: { image: 'a.png' } }, 2: n })
const node = (class_type: string, inputs: Record<string, unknown>) => withNode({ class_type, inputs })

describe('nano-actions eligibility', () => {
  it('the rows', () => {
    const rows = Object.keys(RUNNER_NODE_RULES).filter(ct => nodeRuleFamilies(RUNNER_NODE_RULES[ct]!).includes('nano-actions'))
    expect(rows.sort()).toEqual(['BlendSceneNode', ...ACTIONS].sort())
    for (const ct of rows) expect(PROVIDER_TYPES.has(ct)).toBe(true)
  })

  const takes: [string, ApiPrompt][] = [
    ['Remove Object', node('RemoveObjectNode', { image: ['1', 0], target: 'the cup' })],
    ['Remove Object with a blank target (passes through)', node('RemoveObjectNode', { image: ['1', 0], target: '' })],
    ['Edit Text', node('TextEditNode', { image: ['1', 0], find: 'SALE', replace: 'NEW' })],
    ['Recolor Object', node('RecolorObjectNode', { image: ['1', 0], target: 'the mug', color: 'red' })],
    ['Swap Background · prompt', node('SwapBackgroundNode', { product: ['1', 0], scene_prompt: 'a beach' })],
    ['Swap Background · reference', node('SwapBackgroundNode', { product: ['1', 0], background_reference: ['1', 0] })],
    ['Swap Product', node('SwapProductNode', { scene_reference: ['1', 0], product: ['1', 0] })],
    ['Swap Product with no product (passes through)', node('SwapProductNode', { scene_reference: ['1', 0] })],
    ['Person Swap', node('PersonSwap', { scene: ['1', 0], person: ['1', 0], keep_original_outfit: false })],
    ['Blend · Nano Banana', node('BlendSceneNode', { model: 'Nano Banana', image: ['1', 0] })],
  ]
  it.each(takes)('%s: taken only with nano-actions on', (_l, p) => {
    expect(isRunnerEligible(p, NANO)).toBe(true)
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, OTHERS)).toBe(false)
  })

  const refused: [string, ApiPrompt][] = [
    ['Remove Object with no picture (Python makes a blank)', node('RemoveObjectNode', { target: 'x' })],
    ['Swap Background with no product', node('SwapBackgroundNode', { background_reference: ['1', 0] })],
    ['Swap Product with no scene', node('SwapProductNode', { product: ['1', 0] })],
    ['Person Swap with no scene', node('PersonSwap', { person: ['1', 0] })],
    ['Blend · Nano Banana with keep_subject linked', node('BlendSceneNode', { model: 'Nano Banana', image: ['1', 0], keep_subject: ['1', 0] })],
    ['a wired target', node('RemoveObjectNode', { image: ['1', 0], target: ['1', 0] })],
    ['a wired find', node('TextEditNode', { image: ['1', 0], find: ['1', 0], replace: 'x' })],
    ['a wired replace', node('TextEditNode', { image: ['1', 0], find: 'x', replace: ['1', 0] })],
    ['a wired colour', node('RecolorObjectNode', { image: ['1', 0], target: 'x', color: ['1', 0] })],
    ['a wired scene prompt', node('SwapBackgroundNode', { product: ['1', 0], scene_prompt: ['1', 0] })],
    ['a wired relight toggle', node('SwapBackgroundNode', { product: ['1', 0], scene_prompt: 'x', relight_to_scene: ['1', 0] })],
    ['a wired outfit toggle', node('PersonSwap', { scene: ['1', 0], person: ['1', 0], keep_original_outfit: ['1', 0] })],
    ['wired instructions', node('SwapProductNode', { scene_reference: ['1', 0], product: ['1', 0], instructions: ['1', 0] })],
    ['a picture from outside the prompt', { 2: { class_type: 'PersonSwap', inputs: { scene: ['9', 0], person: ['9', 0] } } }],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, NANO)).toBe(false)
    expect(runnerTakesNode(p, '2', NANO)).toBe(false)
  })
})

// ── Price ────────────────────────────────────────────────────────────────

describe('nano-actions price', () => {
  it('every class prices above 0 at its flat price; PersonSwap is 10 (B1 key fix)', () => {
    for (const ct of [...ACTIONS, 'BlendSceneNode']) {
      const credits = nodeCredits({ class_type: ct, inputs: ct === 'BlendSceneNode' ? { model: 'Nano Banana' } : {} })
      expect(credits, ct).toBeGreaterThan(0)
      expect(credits, ct).toBe(GRAPH_NODE_CREDITS[ct])
    }
    expect(nodeCredits({ class_type: 'PersonSwap', inputs: {} })).toBe(10)
    for (const [, p] of takesForGuard()) expect(unpricedProviderNode(p)).toBeNull()
  })

  it('a node that will pass through is not held; the render credit rides only on something that can be made', () => {
    const passing = node('RemoveObjectNode', { image: ['1', 0], target: '  ' })
    expect(stageEstimate(passing, ['1', '2'], true)).toBe(0)
    const calling = node('RemoveObjectNode', { image: ['1', 0], target: 'the cup' })
    expect(stageEstimate(calling, ['1', '2'], true)).toBe(10 + BASE_RENDER_CREDITS)
    expect(stageEstimate(calling, ['1', '2'], false)).toBe(10)
  })
})

function takesForGuard(): [string, ApiPrompt][] {
  return [...ACTIONS, 'BlendSceneNode'].map(ct => [ct, node(ct, ct === 'BlendSceneNode' ? { model: 'Nano Banana', image: ['1', 0] } : {})])
}

// ── Engine, with the fake Replicate ──────────────────────────────────────

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/** Image cards a.png (1) and b.png (4) → the node (2) → Image card (3). */
function flow(n: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt {
  return {
    1: { class_type: 'Image', inputs: { image: 'a.png' } },
    4: { class_type: 'Image', inputs: { image: 'b.png' } },
    2: n,
    3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
  }
}

function kit() {
  const replicate = createFakeReplicate()
  const k = makeKit({ hosted: true, replicate, deps: { families: () => NANO } })
  writeFileSync(join(k.root, 'input', 'a.png'), new Uint8Array([1]))
  writeFileSync(join(k.root, 'input', 'b.png'), new Uint8Array([2]))
  return k
}

const ENGINE_CASES: [string, ApiPrompt, string, string, string[]][] = [
  ['RemoveObjectNode', flow({ class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: 'the cup', instructions: '' } }), 'google/nano-banana-2', 'remove_object', ['a.png']],
  ['TextEditNode', flow({ class_type: 'TextEditNode', inputs: { image: ['1', 0], find: 'SALE', replace: 'NEW', instructions: '' } }), 'google/nano-banana-2', 'text_edit', ['a.png']],
  ['RecolorObjectNode', flow({ class_type: 'RecolorObjectNode', inputs: { image: ['1', 0], target: 'the mug', color: 'red', instructions: '' } }), 'google/nano-banana-2', 'recolor_object', ['a.png']],
  ['SwapBackgroundNode', flow({ class_type: 'SwapBackgroundNode', inputs: { product: ['1', 0], background_reference: ['4', 0], scene_prompt: '', relight_to_scene: true, ground_with_shadow: true, keep_scale_and_placement: true, instructions: '' } }), 'google/nano-banana-2', 'swap_background', ['b.png', 'a.png']],
  ['SwapProductNode', flow({ class_type: 'SwapProductNode', inputs: { scene_reference: ['1', 0], product: ['4', 0], instructions: '' } }), 'google/nano-banana-2', 'swap_product', ['a.png', 'b.png']],
  ['PersonSwap', flow({ class_type: 'PersonSwap', inputs: { scene: ['4', 0], person: ['1', 0], keep_original_outfit: true, instructions: '' } }), 'google/nano-banana-2', 'person_swap', ['b.png', 'a.png']],
  ['BlendSceneNode', flow({ class_type: 'BlendSceneNode', inputs: { model: 'Nano Banana', image: ['1', 0], unify_lighting: true, contact_shadows: true, match_camera_look: true, preserve_identity: true, keep_feather: 2, prompt: '', seed: 0, output_format: 'png' } }), 'google/nano-banana', 'blend_scene', ['a.png']],
]

describe('nano-actions on the engine (hosted, fake Replicate)', () => {
  it.each(ENGINE_CASES)('%s: one Replicate call, charged its flat price', async (ct, prompt, slug, prefix, pictures) => {
    const k = kit()
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    const sent = k.replicate.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([slug])
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    // Each picture handed off once; image_input in the node's order.
    expect(sent[0]!.payload.image_input).toEqual(pictures.map(p => `https://fal.storage/${p}`))
    const flat = GRAPH_NODE_CREDITS[ct]!
    if (ct === 'PersonSwap') expect(flat).toBe(10)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.records.write).toHaveBeenCalledTimes(1)
    const rec = (k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0]
    expect(rec.outputs.map(f => f.filename)).toEqual([`${prefix}_00001_.png`])
    const executed = ofType(k.seen, 'executed')
    const own = executed.find(m => m.data.node === '2')!.data.output as { images: OutputFile[]; animated: boolean[] }
    expect(own.animated).toEqual([false])
    expect(own.images.map(f => f.filename)).toEqual([`${prefix}_00001_.png`])
  })

  it('a pass-through makes no call, takes no hold and hands the picture on', async () => {
    const k = kit()
    const prompt = flow({ class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: '   ', instructions: 'x' } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.ledger.settle).not.toHaveBeenCalled()
    expect(k.records.write).not.toHaveBeenCalled()
    const executed = ofType(k.seen, 'executed')
    const own = executed.find(m => m.data.node === '2')!.data.output as { images: OutputFile[] }
    expect(own).toEqual({ images: [{ filename: 'a.png', subfolder: '', type: 'input' }] })
    const after = executed.find(m => m.data.node === '3')!.data.output as { images: OutputFile[] }
    expect(after.images).toEqual(own.images)
  })

  it.each([
    ['Swap Product with no product', { class_type: 'SwapProductNode', inputs: { scene_reference: ['4', 0], instructions: '' } }, 'b.png'],
    ['Person Swap with no person', { class_type: 'PersonSwap', inputs: { scene: ['1', 0] } }, 'a.png'],
    ['Swap Background with nothing to change to', { class_type: 'SwapBackgroundNode', inputs: { product: ['4', 0], scene_prompt: ' ' } }, 'b.png'],
  ] as const)('%s: passes through with no hold', async (_l, n, file) => {
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow(n as { class_type: string; inputs: Record<string, unknown> })], ...START })
    await k.engine.settled(runId)
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    const own = ofType(k.seen, 'executed').find(m => m.data.node === '2')!.data.output as { images: OutputFile[] }
    expect(own.images.map(f => f.filename)).toEqual([file])
  })

  it('beside a generator, a pass-through adds nothing to the hold and is not recorded again', async () => {
    const k = kit()
    const prompt: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a cup', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: '', instructions: '' } },
      3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
    }
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/flux/schnell'])
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    const gen = nodeCredits(prompt[1]!)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', gen + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, gen + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.records.write).toHaveBeenCalledTimes(1)
    const rec = (k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0]
    expect(rec.outputs.map(f => f.filename)).toEqual(['generate_image_00001_.png'])
    const own = ofType(k.seen, 'executed').find(m => m.data.node === '2')!.data.output as { images: OutputFile[] }
    expect(own.images.map(f => f.filename)).toEqual(['generate_image_00001_.png'])
  })

  it('with nano-actions off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [ENGINE_CASES[0]![1]], ...START }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})
