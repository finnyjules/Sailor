import { describe, it, expect } from 'vitest'
import { diffPrompts } from '~/lib/graph/promptDiff'
import type { ApiPrompt } from '~/lib/graph/graphToPrompt'

describe('diffPrompts', () => {
  it('returns [] for identical prompts', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
  })

  it('ignores object key order', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { steps: 20, seed: 1 } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
  })

  it('treats null vs missing key as benign-equal', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, extra: null } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1 } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
    // symmetric: missing in ours, null in theirs
    expect(diffPrompts(theirs, ours)).toEqual([])
  })

  it('reports a value mismatch with nodeId and field', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1, steps: 30 } },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '1', field: 'inputs.steps', ours: 20, theirs: 30 },
    ])
  })

  it('treats numeric 1 vs string "1" as a real divergence', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: 1 } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { seed: '1' } },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '1', field: 'inputs.seed', ours: 1, theirs: '1' },
    ])
  })

  it('reports an extra node present only in ours', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: {} },
      '2': { class_type: 'SaveImage', inputs: {} },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: {} },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '2', field: '<node>', ours: { class_type: 'SaveImage', inputs: {} }, theirs: undefined },
    ])
  })

  it('reports a missing node absent from ours', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: {} },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: {} },
      '2': { class_type: 'SaveImage', inputs: {} },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '2', field: '<node>', ours: undefined, theirs: { class_type: 'SaveImage', inputs: {} } },
    ])
  })

  it('compares link-value arrays element-wise and reports mismatches', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { model: ['4', 0] } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { model: ['5', 0] } },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '1', field: 'inputs.model', ours: ['4', 0], theirs: ['5', 0] },
    ])
  })

  it('does not report equal link-value arrays', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { model: ['4', 0] } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { model: ['4', 0] } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
  })

  it('reports class_type mismatch', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: {} },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSamplerAdvanced', inputs: {} },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '1', field: 'class_type', ours: 'KSampler', theirs: 'KSamplerAdvanced' },
    ])
  })

  it('treats identical nested plain objects as equal', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'Custom', inputs: { config: { a: 1, b: 2 } } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'Custom', inputs: { config: { b: 2, a: 1 } } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
  })

  it('reports divergence for differing nested object values', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'Custom', inputs: { config: { a: 1, b: 2 } } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'Custom', inputs: { config: { a: 1, b: 3 } } },
    }
    const divergences = diffPrompts(ours, theirs)
    expect(divergences).toEqual([
      { nodeId: '1', field: 'inputs.config', ours: { a: 1, b: 2 }, theirs: { a: 1, b: 3 } },
    ])
  })

  it('treats both-NaN as equal', () => {
    const ours: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { value: NaN } },
    }
    const theirs: ApiPrompt = {
      '1': { class_type: 'KSampler', inputs: { value: NaN } },
    }
    expect(diffPrompts(ours, theirs)).toEqual([])
  })
})

// The `useShadowParity` block that followed is gone with the composable itself: it recorded the
// bridge's prompt beside ours for comparison, and the bridge run-flow was deleted in the Tier 1
// retirement (cb02c8842, re-deleted 66d450b23). `diffPrompts` above is still the library's own.
