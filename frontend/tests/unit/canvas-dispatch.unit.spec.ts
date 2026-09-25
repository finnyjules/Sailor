import { describe, it, expect } from 'vitest'
import { canvasDispatch, DISPATCH_MESSAGES, isPlainVaryRequest, type DispatchTarget } from '~/lib/prompt/canvasDispatch'

const img = (o: Partial<DispatchTarget> = {}): DispatchTarget => ({ nodeId: 'n1', type: 'artifact-image', hasImages: true, hasUpstream: true, label: 'Rainy shop', ...o })

describe('isPlainVaryRequest', () => {
  it('knows "just give me versions" wordings, and nothing more specific', () => {
    for (const t of ['', 'vary it', 'Variations', 'more like this', 'another take', 'three more', 'reroll', 're-roll it', 'try again!', 'some options'])
      expect(isPlainVaryRequest(t)).toBe(true)
    for (const t of ['make it warmer', 'vary the colours', 'more rain'])
      expect(isPlainVaryRequest(t)).toBe(false)
  })
})

describe('canvasDispatch', () => {
  it('answer, plan, edit-recipe and restyle go to the planner', () => {
    for (const k of ['answer', 'plan', 'edit-recipe', 'restyle'] as const)
      expect(canvasDispatch(k, 'x', img())).toEqual({ worker: 'ask' })
  })
  it('tweak: a plain vary on an image with something upstream is Variations', () => {
    expect(canvasDispatch('tweak', 'vary it', img())).toEqual({ worker: 'variations', nodeId: 'n1' })
  })
  it('tweak: the menu is trusted even without the upstream check', () => {
    expect(canvasDispatch('tweak', '', img({ hasUpstream: false }), { fromMenu: true })).toEqual({ worker: 'variations', nodeId: 'n1' })
  })
  it('tweak: a specific change goes to the planner; nothing to vary gives a message', () => {
    expect(canvasDispatch('tweak', 'make it warmer', img())).toEqual({ worker: 'ask' })
    expect(canvasDispatch('tweak', 'vary it', img({ hasUpstream: false }))).toEqual({ worker: 'ask' })
    expect(canvasDispatch('tweak', '', null)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.noImageToVary })
  })
  it('fix: reviews a node with a result; otherwise planner or message', () => {
    expect(canvasDispatch('fix', 'fix it', img())).toEqual({ worker: 'fix', nodeId: 'n1' })
    expect(canvasDispatch('fix', 'fix it', img({ hasImages: false }))).toEqual({ worker: 'ask' })
    expect(canvasDispatch('fix', '', null)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.nothingToFix })
  })
  it('copy and layout: the planner when a Frame is selected, a message otherwise', () => {
    expect(canvasDispatch('copy', 'a headline', img({ type: 'artifact-frame' }))).toEqual({ worker: 'ask' })
    expect(canvasDispatch('layout', 'other layouts', img({ type: 'artifact-frame' }))).toEqual({ worker: 'ask' })
    expect(canvasDispatch('copy', 'a headline', img())).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.copy })
    expect(canvasDispatch('layout', 'x', null)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.layout })
  })
  it('new-effect runs on a selected shader effect node, and points elsewhere otherwise', () => {
    expect(canvasDispatch('new-effect', 'rain', { nodeId: 's1', type: 'shader-effect', hasImages: false, hasUpstream: true, label: 'Water ripple' }))
      .toEqual({ worker: 'effect', nodeId: 's1' })
    expect(canvasDispatch('new-effect', 'rain', img())).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(canvasDispatch('new-effect', 'rain', null)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(DISPATCH_MESSAGES.newEffect).toBe('New effects are made on a shader effect. Select a shader effect node, or open the Shader studio.')
  })
  it('messages are plain sentence-case copy with no kind names', () => {
    for (const m of Object.values(DISPATCH_MESSAGES)) {
      expect(m).toMatch(/^[A-Z]/)
      expect(m).not.toMatch(/tweak|new-effect|edit-recipe|router/)
    }
  })
})
