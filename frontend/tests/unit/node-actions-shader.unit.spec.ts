// @vitest-environment happy-dom
// frontend/tests/unit/node-actions-shader.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { actionHint, actionPrice, actionsFor, SHADER_GEN_ACTION_HINT } from '~/lib/canvas/nodeActions'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'

describe('shader effect node actions (spec §7.3)', () => {
  const ctx = { nodeId: 's1', type: 'shader-effect', hasImages: false, hasUpstream: true } as any
  it('Develop has Remix… and New effect…, both three takes with the estimate', () => {
    const { edit, develop } = actionsFor(ctx)
    expect(edit).toEqual([])
    expect(develop.map(a => a.label)).toEqual(['Remix…', 'New effect…'])
    expect(develop.map(a => a.id)).toEqual(['remix-effect', 'new-effect'])
    expect(SHADER_GEN_ACTION_HINT).toBe('30–63 credits')
    for (const a of develop) expect(actionHint(a, actionPrice(a, null, false))).toBe('3 takes · 30–63 credits')
  })
  it('a node with no effect picked offers New effect… only (Remix… needs an effect to start from)', () => {
    expect(actionsFor({ ...ctx, hasEffect: false }).develop.map(a => a.label)).toEqual(['New effect…'])
    expect(actionsFor({ ...ctx, hasEffect: true }).develop.map(a => a.label)).toEqual(['Remix…', 'New effect…'])
  })
  it('hosted, the menu shows the same credits text as the prompt note', () => {
    for (const a of actionsFor(ctx).develop) expect(actionPrice(a, null, true)).toBe(shaderGenEstimateText(true))
    expect(shaderGenEstimateText(true)).toMatch(/^\d+–\d+ credits$/)
  })
  it('each sets a mode chip on the node, with no request sent', () => {
    const seen: any[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    const kinds: any[] = []
    const onKind = (e: Event) => kinds.push((e as CustomEvent).detail)
    window.addEventListener('sailor:promptMode', on)
    window.addEventListener('sailor:promptKind', onKind)
    for (const a of actionsFor(ctx).develop) a.run(ctx)
    window.removeEventListener('sailor:promptMode', on)
    window.removeEventListener('sailor:promptKind', onKind)
    expect(seen).toEqual([{ label: 'Remix', kind: 'new-effect', nodeId: 's1' }, { label: 'New effect', kind: 'new-effect', nodeId: 's1' }])
    expect(kinds).toEqual([])
  })
})
