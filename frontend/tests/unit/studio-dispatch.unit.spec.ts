import { describe, it, expect } from 'vitest'
import { frameSelectionLabel, STUDIO_MESSAGES, studioDispatch, VARY_REQUEST } from '~/lib/prompt/studioDispatch'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

const studio = { place: 'studio' as const, hasWorker: true, canTakes: true }

describe('studioDispatch', () => {
  it('sends the worker every kind it can do, with the text as typed', () => {
    for (const k of ['answer', 'plan', 'edit-recipe', 'tweak', 'restyle', 'fix'] as const)
      expect(studioDispatch(k, 'warmer', studio)).toEqual({ worker: 'ask', text: 'warmer' })
  })
  it('copy and layout belong to Frame and the template editor', () => {
    expect(studioDispatch('copy', 'a headline', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.copyInFrame })
    expect(studioDispatch('layout', 'x', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.layoutInFrame })
    expect(studioDispatch('copy', 'a headline', { ...studio, place: 'frame' })).toEqual({ worker: 'ask', text: 'a headline' })
    expect(studioDispatch('layout', 'tighter', { ...studio, place: 'template' })).toEqual({ worker: 'ask', text: 'tighter' })
  })
  it('new-effect is stage 5: the canvas message, word for word', () => {
    expect(studioDispatch('new-effect', 'rain', studio)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(STUDIO_MESSAGES.newEffect).toBe(DISPATCH_MESSAGES.newEffect)
  })
  it('3D (no worker) answers every kind with its message', () => {
    for (const k of ['answer', 'plan', 'tweak', 'copy'] as const)
      expect(studioDispatch(k, 'x', { place: 'scene3d', hasWorker: false, canTakes: false })).toEqual({ worker: 'message', message: STUDIO_MESSAGES.noWorker3d })
  })
  it('Vary from the menu sends the fixed request, only where there are takes', () => {
    expect(studioDispatch('tweak', '', { ...studio, fromMenu: true })).toEqual({ worker: 'ask', text: VARY_REQUEST })
    expect(studioDispatch('tweak', '', { ...studio, canTakes: false, fromMenu: true })).toEqual({ worker: 'message', message: STUDIO_MESSAGES.nothingToVary })
  })
  it('an empty request that is not from a menu is a no-op message', () => {
    expect(studioDispatch('plan', '   ', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.nothingToVary })
  })
  it('messages are plain sentence-case copy with no kind names', () => {
    for (const m of Object.values(STUDIO_MESSAGES)) {
      expect(m).toMatch(/^[A-Z0-9]/)
      expect(m).not.toMatch(/tweak|new-effect|edit-recipe|router|worker/)
    }
  })
})

describe('frameSelectionLabel', () => {
  it('quotes a text layer’s own words, trimmed', () => {
    expect(frameSelectionLabel([{ kind: 'text', text: 'Open late' }])).toBe('“Open late” · text')
    expect(frameSelectionLabel([{ kind: 'text', text: '  Rainy   season \n' }])).toBe('“Rainy season” · text')
    expect(frameSelectionLabel([{ kind: 'text', text: 'A very long headline that keeps going' }])).toBe('“A very long headline th…” · text')
  })
  it('uses a layer’s name, else its kind in sentence case', () => {
    expect(frameSelectionLabel([{ kind: 'image', name: 'Hero shot' }])).toBe('Hero shot')
    expect(frameSelectionLabel([{ kind: 'image' }])).toBe('Image')
    expect(frameSelectionLabel([{ kind: 'text', text: '' }])).toBe('Text')
  })
  it('counts several, and shows nothing for nothing', () => {
    expect(frameSelectionLabel([{ kind: 'image' }, { kind: 'text', text: 'x' }])).toBe('2 layers')
    expect(frameSelectionLabel([])).toBeNull()
  })
})
