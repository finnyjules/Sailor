/**
 * R0.3: which wires may carry a value into which inputs, read by the browser
 * and the server alike. The output-kind and evaluator tables are passed in
 * here, so this is proven before any class produces a value.
 */
import { describe, expect, it } from 'vitest'
import { outputKind, type ValueKind } from '#shared/runner/values'
import { valueWiresAllowed, runnerTakesNode, isRunnerEligible } from '#shared/runner/eligibility'
import { staticValueOf, staticWiredTexts, type StaticEvaluator } from '#shared/runner/staticValues'
import { RUNNER_FAMILIES, parseFamilies } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'

const KINDS: Record<string, Record<number, ValueKind>> = { FakeText: { 0: 'text' }, FakeTwo: { 0: 'files', 1: 'mask' } }

describe('outputKind', () => {
  const p: ApiPrompt = {
    t: { class_type: 'FakeText', inputs: {} },
    g: { class_type: 'ComfyGateNode', inputs: { data_in: ['t', 0], bypass: true } },
    two: { class_type: 'FakeTwo', inputs: {} },
    img: { class_type: 'GenerateImageNode', inputs: {} },
  }
  it('reads the kind a class declares for the slot, files by default', () => {
    expect(outputKind(p, ['t', 0], KINDS)).toBe('text')
    expect(outputKind(p, ['two', 1], KINDS)).toBe('mask')
    expect(outputKind(p, ['two', 0], KINDS)).toBe('files')
    expect(outputKind(p, ['img', 0], KINDS)).toBe('files')
  })
  it('follows a Gate back to what reaches it', () => {
    expect(outputKind(p, ['g', 0], KINDS)).toBe('text')
  })
  it('is files for a node outside the prompt', () => {
    expect(outputKind(p, ['nope', 0], KINDS)).toBe('files')
  })
})

describe('valueWiresAllowed', () => {
  it('lets a value through a Gate', () => {
    const p: ApiPrompt = {
      t: { class_type: 'FakeText', inputs: {} },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['t', 0] } },
    }
    expect(valueWiresAllowed(p, 'g', KINDS)).toBe(true)
  })
  it('still lets files through a Gate', () => {
    const p: ApiPrompt = {
      i: { class_type: 'GenerateImageNode', inputs: {} },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['i', 0] } },
    }
    expect(valueWiresAllowed(p, 'g', KINDS)).toBe(true)
  })
  it('refuses a value wired into an input that takes none', () => {
    const p: ApiPrompt = {
      t: { class_type: 'FakeText', inputs: {} },
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: ['t', 0] } },
    }
    expect(valueWiresAllowed(p, 'v', KINDS)).toBe(false)
  })
  it('leaves file wires as they were', () => {
    const p: ApiPrompt = {
      i: { class_type: 'GenerateImageNode', inputs: {} },
      c: { class_type: 'Image', inputs: { images: ['i', 0] } },
    }
    expect(valueWiresAllowed(p, 'c', KINDS)).toBe(true)
  })
})

describe('staticValueOf', () => {
  const table: Record<string, StaticEvaluator> = {
    FakeText: (inputs, at) => {
      const own = typeof inputs.text === 'string' ? inputs.text : ''
      if (own) return { kind: 'text', text: own }
      const src = inputs.source
      if (Array.isArray(src)) return at(src as [string, number])
      return { kind: 'text', text: typeof src === 'string' ? src : '' }
    },
  }
  const p: ApiPrompt = {
    a: { class_type: 'FakeText', inputs: { text: 'hello' } },
    b: { class_type: 'FakeText', inputs: { text: '', source: ['a', 0] } },
    c: { class_type: 'FakeText', inputs: { text: '', source: ['x', 0] } },
    x: { class_type: 'GenerateImageNode', inputs: {} },
    loop: { class_type: 'FakeText', inputs: { text: '', source: ['loop', 0] } },
  }
  it('computes a card value from its own settings, following static cards', () => {
    expect(staticValueOf(p, ['a', 0], table)).toEqual({ kind: 'text', text: 'hello' })
    expect(staticValueOf(p, ['b', 0], table)).toEqual({ kind: 'text', text: 'hello' })
  })
  it('knows nothing of a value a non-card makes, or of a loop', () => {
    expect(staticValueOf(p, ['c', 0], table)).toBeUndefined()
    expect(staticValueOf(p, ['loop', 0], table)).toBeUndefined()
  })
  it('lists the static texts wired into any input, for moderation', () => {
    const q: ApiPrompt = {
      a: { class_type: 'FakeText', inputs: { text: 'a fox' } },
      g: { class_type: 'GenerateImageNode', inputs: { prompt_in: ['a', 0] } },
      h: { class_type: 'GenerateImageNode', inputs: { prompt_in: ['a', 0] } },
    }
    expect(staticWiredTexts(q, table)).toEqual(['a fox'])
  })
})

describe('the cards family', () => {
  it('exists and is off unless named', () => {
    expect(RUNNER_FAMILIES).toContain('cards')
    expect(parseFamilies('cards').has('cards')).toBe(true)
    expect(parseFamilies('').size).toBe(0)
  })
})

describe('nothing produces a value yet', () => {
  it('leaves today’s workflows exactly as they were taken', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    expect(isRunnerEligible(p)).toBe(true)
    expect(runnerTakesNode(p, '2')).toBe(true)
  })
})
