import { describe, it, expect } from 'vitest'
import { selectionLabel, canvasSuggestions, type PromptNode } from '~/lib/prompt/canvasPromptContext'

const n = (title: string, type = 'ComfyNode', hasImages = false): PromptNode => ({ id: title || type, title, type, hasImages })

describe('selectionLabel', () => {
  it('is null with nothing selected', () => expect(selectionLabel([])).toBeNull())
  it('uses the node’s own title', () => expect(selectionLabel([n('Rainy shop')])).toBe('Rainy shop'))
  it('falls back to the type when the title is blank', () => expect(selectionLabel([n('  ', 'GradientStudio')])).toBe('GradientStudio'))
  it('counts several nodes', () => expect(selectionLabel([n('A'), n('B'), n('C')])).toBe('3 nodes'))
})

describe('canvasSuggestions', () => {
  it('offers ideas on an empty canvas', () => {
    expect(canvasSuggestions([], true)).toEqual(['A red fox in the snow', 'What can Sailor make?'])
  })
  it('asks about the graph when nothing is selected', () => {
    expect(canvasSuggestions([], false)).toEqual(['What does this graph do?', 'What should I try next?'])
  })
  it('offers image moves for a node with images', () => {
    expect(canvasSuggestions([n('Rainy shop', 'artifact-image', true)], false)).toEqual(['What does this do?', 'Make it warmer', 'Upscale it'])
  })
  it('asks about a single node without images', () => {
    expect(canvasSuggestions([n('Poster')], false)).toEqual(['What does this do?', 'What can I connect to this?'])
  })
  it('asks about several nodes', () => {
    expect(canvasSuggestions([n('A'), n('B')], false)).toEqual(['What do these do?', 'Connect these'])
  })
  it('never offers more than three', () => {
    for (const sel of [[], [n('A', 'artifact-image', true)], [n('A'), n('B')]]) expect(canvasSuggestions(sel, false).length).toBeLessThanOrEqual(3)
  })
})
