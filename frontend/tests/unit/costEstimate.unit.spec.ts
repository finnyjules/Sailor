import { describe, it, expect } from 'vitest'
import {
  estimateUsdForNodes,
  isReplicateBilled,
  widgetValueMap,
  vueNodesToEstimateInput,
  type EstimateInputNode,
} from '~/lib/costEstimate'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { creditsForUsd, formatCostLong, formatEstimateLong } from '~/lib/pricing'
import { VIDEO_MODEL_USD } from '~/data/video-prices'

const USD_05 = '{"type":"usd","usd":0.05,"format":{"approximate":true}}'
const USD_04 = '{"type":"usd","usd":0.04}'

describe('isReplicateBilled', () => {
  it('counts *RemoteNode classes', () => {
    expect(isReplicateBilled({ id: '1', type: 'FluxProRemoteNode' })).toBe(true)
  })
  it('counts comfy_extras Replicate wrappers by their …/Replicate category', () => {
    expect(isReplicateBilled({ id: '1', type: 'PersonSwap', category: 'api node/image/Replicate' })).toBe(true)
    expect(isReplicateBilled({ id: '2', type: 'PoseMannequin', category: 'api node/image/Replicate' })).toBe(true)
  })
  it('excludes credit-billed stock API nodes (OpenAI, Kling, …)', () => {
    expect(isReplicateBilled({ id: '1', type: 'OpenAIImage', category: 'api node/image/OpenAI' })).toBe(false)
    expect(isReplicateBilled({ id: '2', type: 'KlingVideo', category: 'api node/video/Kling' })).toBe(false)
  })
})

describe('estimateUsdForNodes', () => {
  it('tallies a Person Swap node that is not name-suffixed RemoteNode', () => {
    const nodes: EstimateInputNode[] = [
      { id: '1', type: 'PersonSwap', title: 'Person Swap', category: 'api node/image/Replicate', badgeExpr: USD_05 },
    ]
    const est = estimateUsdForNodes(nodes)
    expect(est).not.toBeNull()
    expect(est!.usd).toBeCloseTo(0.05)
    expect(est!.breakdown).toHaveLength(1)
  })

  it('sums Person Swap alongside a RemoteNode', () => {
    const nodes: EstimateInputNode[] = [
      { id: '1', type: 'FluxProRemoteNode', badgeExpr: USD_04 },
      { id: '2', type: 'PersonSwap', category: 'api node/image/Replicate', badgeExpr: USD_05 },
    ]
    expect(estimateUsdForNodes(nodes)!.usd).toBeCloseTo(0.09)
  })

  it('includes credit-billed stock API nodes in the estimate', () => {
    const nodes: EstimateInputNode[] = [
      { id: '1', type: 'OpenAIImage', category: 'api node/image/OpenAI', badgeExpr: USD_04 },
    ]
    const est = estimateUsdForNodes(nodes)
    expect(est).not.toBeNull()
    expect(est!.usd).toBeCloseTo(0.04)
    expect(est!.breakdown[0]!.credits).toBe(true)
  })
})

describe('credit-billed API nodes', () => {
  const kling = {
    id: '9',
    type: 'KlingTextToVideoNode',
    category: 'api node/video/Kling',
    // Real shape: a JSONata expr whose branches are {"type":"usd","usd":N} literals.
    badgeExpr: '($m := widgets.mode; $contains($m,"10") ? {"type":"usd","usd":0.7} : {"type":"usd","usd":0.35})',
  }
  it('includes api-node categories in the estimate as an approximate floor', () => {
    const est = estimateUsdForNodes([kling])
    expect(est).not.toBeNull()
    expect(est!.usd).toBeCloseTo(0.7)
    expect(est!.approximate).toBe(true)
    expect(est!.breakdown[0]!.credits).toBe(true)
    expect(est!.breakdown[0]!.label).toContain('(credits)')
  })
  it('still excludes unpriced local nodes', () => {
    expect(estimateUsdForNodes([{ id: '1', type: 'LoadImage', category: 'image', badgeExpr: null }])).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Model-aware run estimate (hosted).
//
// The node cost badge prices a model-picker node off the model the user picked
// (nodeCreditEstimate); the run-money surfaces — cost-confirm dialog, Run
// button — used to quote the STATIC price_badge instead. For a Veo 3.1 run
// that is 60 credits on the dialog against 481 on the node and 481 actually
// debited. These pin both halves: local must not move at all, hosted must
// agree with the badge.
// ───────────────────────────────────────────────────────────────────────────

/** The real GenerateVideoNode shape: one static badge for a picker whose model
 *  range spans $0.04 (LTX) to $3.20 (Veo 3.1). */
const VIDEO_BADGE = '{"type":"usd","usd":0.40,"format":{"approximate":true}}'
function videoNode(model: string): EstimateInputNode {
  return {
    id: '7',
    type: 'GenerateVideoNode',
    title: 'Generate a video',
    category: 'api node/video/Replicate',
    badgeExpr: VIDEO_BADGE,
    widgetDefs: [{ name: 'model' }, { name: 'prompt' }],
    widgetsValues: [model, 'a shot'],
  }
}

describe('widgetValueMap', () => {
  it('maps every widget name to its value, positionally by widgetDefs index', () => {
    const n = videoNode('veo-3.1')
    expect(widgetValueMap(n.widgetDefs, n.widgetsValues)).toEqual({ model: 'veo-3.1', prompt: 'a shot' })
  })

  it('carries model_options through as the node holds it (JSON text)', () => {
    expect(widgetValueMap(
      [{ name: 'model' }, { name: 'model_options' }],
      ['veo-3.1', '{"resolution":"1080p"}'],
    )).toEqual({ model: 'veo-3.1', model_options: '{"resolution":"1080p"}' })
  })

  it('is empty for a node with no widgets, and has no model when there is no model widget', () => {
    expect(widgetValueMap(undefined, undefined)).toEqual({})
    expect(widgetValueMap([{ name: 'prompt' }], ['x'])).toEqual({ prompt: 'x' })
  })

  it('skips unnamed defs and keeps the first of a repeated name', () => {
    expect(widgetValueMap([{}, { name: 'model' }, { name: 'model' }], [1, 'a', 'b'])).toEqual({ model: 'a' })
  })
})

// REGRESSION PIN — written against the pre-change estimator. Local mode is the
// operator's own provider spend read off the static badge; nothing about the
// model-aware hosted path may move these numbers.
describe('estimateUsdForNodes — local mode is byte-identical', () => {
  it('quotes the static badge dollars for a model-picker node', () => {
    const est = estimateUsdForNodes([videoNode('veo-3.1')])!
    expect(est.usd).toBeCloseTo(0.40)
    expect(est.approximate).toBe(true)
    expect(est.breakdown).toHaveLength(1)
    expect(est.breakdown[0]!.usd).toBeCloseTo(0.40)
    expect(formatCostLong(est.usd, false)).toBe('$0.40')
  })

  it('quotes the same dollars whichever model is selected', () => {
    expect(estimateUsdForNodes([videoNode('ltx-video')])!.usd)
      .toBeCloseTo(estimateUsdForNodes([videoNode('veo-3.1')])!.usd)
  })

  it('carries no hosted credits figure', () => {
    expect(estimateUsdForNodes([videoNode('veo-3.1')])!.hostedCredits ?? null).toBeNull()
    // Passing hosted:false explicitly is the same call as omitting it.
    expect(estimateUsdForNodes([videoNode('veo-3.1')], { hosted: false })!.hostedCredits ?? null).toBeNull()
  })
})

describe('estimateUsdForNodes — hosted prices the selected model', () => {
  it('quotes EXACTLY the credits the node badge shows for a veo-3.1 run', () => {
    const est = estimateUsdForNodes([videoNode('veo-3.1')], { hosted: true })!
    expect(est.hostedCredits).toBe(nodeCreditEstimate('GenerateVideoNode', { model: 'veo-3.1' }))
    // …and that is the model USD through the markup policy plus one base render.
    expect(est.hostedCredits).toBe(creditsForUsd(VIDEO_MODEL_USD['veo-3.1']!.usd) + 1)
    expect(est.hostedCredits).toBe(481)
  })

  it('separates a cheap model from an expensive one on the same node', () => {
    const cheap = estimateUsdForNodes([videoNode('ltx-video')], { hosted: true })!
    const dear = estimateUsdForNodes([videoNode('veo-3.1')], { hosted: true })!
    expect(cheap.hostedCredits).toBe(nodeCreditEstimate('GenerateVideoNode', { model: 'ltx-video' }))
    expect(dear.hostedCredits!).toBeGreaterThan(cheap.hostedCredits! * 10)
  })

  it('honours the legacy model-label remap the node applies at execute time', () => {
    expect(estimateUsdForNodes([videoNode('Veo 3')], { hosted: true })!.hostedCredits)
      .toBe(nodeCreditEstimate('GenerateVideoNode', { model: 'veo-3.1' }))
  })

  it('adds base_render ONCE per run, not once per node (priceGraph semantics)', () => {
    const two = estimateUsdForNodes(
      [videoNode('veo-3.1'), { ...videoNode('ltx-video'), id: '8' }],
      { hosted: true },
    )!
    const a = creditsForUsd(VIDEO_MODEL_USD['veo-3.1']!.usd)
    const b = creditsForUsd(VIDEO_MODEL_USD['ltx-video']!.usd)
    expect(two.hostedCredits).toBe(a + b + 1)
  })

  it('sums per node BEFORE the markup, never ceils the total twice', () => {
    // Two $0.05 nodes: per-node 2× markup gives 10cr each. Converting the $0.10
    // sum in one shot would also give 20 here — the distinction that matters is
    // the tier boundary, so use nodes that straddle it.
    const est = estimateUsdForNodes([
      { id: '1', type: 'FluxProRemoteNode', badgeExpr: USD_05 },   // $0.05 → 2× → 10cr
      { id: '2', type: 'FluxProRemoteNode', badgeExpr: USD_04 },   // $0.04 → 2× → 8cr
    ], { hosted: true })!
    expect(est.hostedCredits).toBe(10 + 8 + 1)
    // The one-shot conversion of the $0.09 total would land on 18 + 1 here too,
    // but a $0.20 total would tip into the 1.5× tier and under-quote — pin that.
    const tipped = estimateUsdForNodes([
      { id: '1', type: 'FluxProRemoteNode', badgeExpr: '{"type":"usd","usd":0.10}' },
      { id: '2', type: 'FluxProRemoteNode', badgeExpr: '{"type":"usd","usd":0.10}' },
    ], { hosted: true })!
    expect(tipped.hostedCredits).toBe(20 + 20 + 1)
    expect(creditsForUsd(0.20)).toBe(30) // the wrong answer the naive sum gives
  })

  it('falls back to the static badge for a model it cannot price', () => {
    const est = estimateUsdForNodes([videoNode('not-a-real-model')], { hosted: true })!
    expect(est.usd).toBeCloseTo(0.40)
    expect(est.hostedCredits).toBe(creditsForUsd(0.40) + 1)
  })

  it('leaves non-picker nodes on the static badge', () => {
    const est = estimateUsdForNodes([{ id: '1', type: 'FluxProRemoteNode', badgeExpr: USD_04 }], { hosted: true })!
    expect(est.usd).toBeCloseTo(0.04)
    expect(est.hostedCredits).toBe(creditsForUsd(0.04) + 1)
  })
})

describe('formatEstimateLong', () => {
  it('local shows dollars and ignores the credits figure entirely', () => {
    expect(formatEstimateLong(0.40, 481, false)).toBe('$0.40')
  })

  it('hosted shows the precomputed credits verbatim — no second conversion', () => {
    expect(formatEstimateLong(3.20, 481, true)).toBe('~481 credits')
  })

  it('hosted falls back to converting USD when no credits figure is carried', () => {
    expect(formatEstimateLong(0.40, null, true)).toBe(formatCostLong(0.40, true))
  })
})

describe('vueNodesToEstimateInput', () => {
  const vnode = (over: Record<string, unknown> = {}) => ({
    id: 7,
    data: {
      nodeType: 'GenerateVideoNode',
      title: 'Generate a video',
      category: 'api node/video/Replicate',
      priceBadge: { expr: VIDEO_BADGE },
      widgetDefs: [{ name: 'model' }, { name: 'prompt' }],
      widgetsValues: ['veo-3.1', 'a shot'],
      ...over,
    },
  })

  it('carries the model widget through so hosted can price it', () => {
    const [n] = vueNodesToEstimateInput([vnode()])
    expect(widgetValueMap(n!.widgetDefs, n!.widgetsValues).model).toBe('veo-3.1')
    expect(estimateUsdForNodes([n!], { hosted: true })!.hostedCredits)
      .toBe(nodeCreditEstimate('GenerateVideoNode', { model: 'veo-3.1' }))
  })

  it('still drops muted nodes and still reads the badge/category', () => {
    expect(vueNodesToEstimateInput([vnode({ mode: 2 })])).toHaveLength(0)
    const [n] = vueNodesToEstimateInput([vnode()])
    expect(n!.badgeExpr).toBe(VIDEO_BADGE)
    expect(n!.category).toBe('api node/video/Replicate')
    expect(n!.id).toBe('7')
  })
})
