/**
 * A6: which nodes of a run need the local engine. The rule is the runner's
 * own (shared/runner/eligibility.ts) — these tests pin that the helper agrees
 * with isRunnerEligible and names nodes by their title, never their class.
 */
import { describe, expect, it } from 'vitest'
import { nodesNeedingEngine, workflowNodeTitles } from '~/lib/runner/needsEngine'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import type { ApiPrompt } from '#shared/runner/graph'

const img = (model = 'flux-schnell') => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: '{}' } })
const vid = (model = 'veo-3.1', extra: Record<string, unknown> = {}) => ({ class_type: 'GenerateVideoNode', inputs: { model, prompt: 'y', image: ['2', 0], ...extra } })

const titles: Record<string, string> = { 1: 'Hero shot', 2: 'Pick one', 3: 'Clip', 4: 'Blur it', 5: 'Final video' }
const titleOf = (id: string) => titles[id] ?? `Node ${id}`

const runnerWorkflow = (): ApiPrompt => ({
  1: img(),
  2: { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
  3: vid(),
  5: { class_type: 'Video', inputs: { source: ['3', 0] } },
})

describe('nodesNeedingEngine', () => {
  it('needs nothing for a runner workflow while the runner is on', () => {
    const p = runnerWorkflow()
    expect(isRunnerEligible(p)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf })).toEqual([])
  })

  it('names every node when the runner is off', () => {
    expect(nodesNeedingEngine(runnerWorkflow(), { runnerOn: false, titleOf }))
      .toEqual(['Hero shot', 'Pick one', 'Clip', 'Final video'])
  })

  it('names a node whose type the runner does not take', () => {
    const p: ApiPrompt = { ...runnerWorkflow(), 4: { class_type: 'ImageBlur', inputs: { image: ['1', 0] } } }
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf })).toEqual(['Blur it'])
  })

  it('names a generator on a model the runner does not take, and one asking for several pictures', () => {
    const p: ApiPrompt = { ...runnerWorkflow(), 1: img('imagen-4') }
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf })).toEqual(['Hero shot'])
    const q: ApiPrompt = { ...runnerWorkflow(), 1: { ...img(), inputs: { ...img().inputs, model_options: JSON.stringify({ num_outputs: 2 }) } } }
    expect(nodesNeedingEngine(q, { runnerOn: true, titleOf })).toEqual(['Hero shot'])
  })

  it('names a video node with sound wired in', () => {
    const p: ApiPrompt = { ...runnerWorkflow(), 3: vid('veo-3.1', { audio: ['1', 0] }) }
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf })).toEqual(['Clip'])
  })

  it('names every node when no single node is at fault but the runner still refuses (no generator)', () => {
    const p: ApiPrompt = { 5: { class_type: 'Image', inputs: { image: 'a.png' } } }
    expect(isRunnerEligible(p)).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf })).toEqual(['Final video'])
  })

  it('lists a shared title once', () => {
    const p: ApiPrompt = {
      1: { class_type: 'ImageBlur', inputs: {} },
      2: { class_type: 'ImageBlur', inputs: {} },
    }
    expect(nodesNeedingEngine(p, { runnerOn: true, titleOf: () => 'Blur' })).toEqual(['Blur'])
  })

  it('agrees with isRunnerEligible node by node', () => {
    const p: ApiPrompt = { ...runnerWorkflow(), 4: { class_type: 'ImageBlur', inputs: { image: ['1', 0] } }, 6: img('imagen-4') }
    const refused = Object.keys(p).filter(id => !runnerTakesNode(p, id))
    expect(refused.sort()).toEqual(['4', '6'])
    expect(isRunnerEligible(p)).toBe(false)
  })
})

describe('workflowNodeTitles', () => {
  const wf = {
    nodes: [
      { id: 1, type: 'GenerateImageNode', title: 'Hero shot' },
      { id: 2, type: 'ImageBlur' },
      { id: 3, type: 'MysteryNode', title: '  ' },
    ],
  }
  const info = { ImageBlur: { display_name: 'Blur image' } }

  it('uses the node title, then the display name, then a plain fallback', () => {
    const titleOf = workflowNodeTitles(wf, info)
    expect(titleOf('1')).toBe('Hero shot')
    expect(titleOf('2')).toBe('Blur image')
    expect(titleOf('3')).toBe('Unnamed node')
    expect(titleOf('99')).toBe('Unnamed node')
  })
})

describe('notRunWords (step 4, C5: the words for nodes Sailor doesn’t run)', () => {
  it('quotes the titles in plain words and shortens a long list', async () => {
    const { notRunWords } = await import('~/lib/runner/needsEngine')
    const m = (...t: string[]) => new Map(t.map(x => [x, 'VAEDecode']))
    expect(notRunWords(m('Decode'))).toBe('“Decode”: Sailor doesn’t run this node.')
    expect(notRunWords(m('Decode', 'Blur image'))).toBe('“Decode” and “Blur image”: Sailor doesn’t run these nodes.')
    expect(notRunWords(m('A', 'B', 'C'))).toBe('“A”, “B” and “C”: Sailor doesn’t run these nodes.')
    expect(notRunWords(m('A', 'B', 'C', 'D', 'E', 'F'))).toBe('“A”, “B”, “C”, “D” and 2 more: Sailor doesn’t run these nodes.')
  })
})
