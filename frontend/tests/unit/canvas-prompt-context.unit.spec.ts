import { describe, it, expect } from 'vitest'
import { selectionLabel, promptNodeLabel, canvasSuggestions, promptWorkingLabel, type PromptNode } from '~/lib/prompt/canvasPromptContext'

const n = (title: string, type = 'ComfyNode', hasImages = false): PromptNode => ({ id: title || type, title, type, hasImages })

describe('selectionLabel', () => {
  it('is null with nothing selected', () => expect(selectionLabel([])).toBeNull())
  it('uses the node’s own title', () => expect(selectionLabel([n('Rainy shop')])).toBe('Rainy shop'))
  it('never shows an identifier', () => {
    expect(selectionLabel([n('  ', 'GradientStudio')])).toBe('Gradient Studio')
    expect(selectionLabel([n('', 'artifact-image')])).toBe('Image')
    expect(selectionLabel([n('KSampler', 'KSampler')])).toBe('Selected node')
  })
  it('names result cards by what they hold', () => {
    for (const [t, w] of [['artifact-video', 'Video'], ['artifact-audio', 'Audio'], ['artifact-frame', 'Frame']]) {
      expect(selectionLabel([{ id: '1', title: 'Save Video', type: t!, hasImages: false, nodeType: 'SaveVideo', defaultTitle: 'Save Video' }])).toBe(w)
    }
  })
  it('uses the card header’s name: override, then catalog name, then capability title', () => {
    expect(promptNodeLabel({ id: '1', title: 'Flux Dev + LoRA (Replicate)', type: 'FluxLoRARemoteNode', hasImages: false, defaultTitle: 'Flux Dev + LoRA (Replicate)' })).toBe('Generate an image with a style')
    expect(promptNodeLabel({ id: '1', title: 'EmptyLatentImage', type: 'EmptyLatentImage', hasImages: false, defaultTitle: 'Empty Latent Image' })).toBe('Empty Latent Image')
    expect(promptNodeLabel({ id: '1', title: 'GenerateImageNode', type: 'GenerateImageNode', hasImages: false })).toBe('Generate an image')
  })
  it('keeps a title the user gave the node first', () => {
    expect(promptNodeLabel({ id: '1', title: 'Hero shot', type: 'FluxLoRARemoteNode', hasImages: false, defaultTitle: 'Flux Dev + LoRA (Replicate)' })).toBe('Hero shot')
    expect(promptNodeLabel({ id: '1', title: 'Rainy shop', type: 'artifact-image', hasImages: true, nodeType: 'SaveImage', defaultTitle: 'Save Image' })).toBe('Rainy shop')
  })
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

describe('promptWorkingLabel', () => {
  it('quotes the request being worked on', () => {
    expect(promptWorkingLabel({ request: 'make it rain on a window' })).toBe('Working on “make it rain on a window”')
  })
  it('trims and collapses whitespace in the request', () => {
    expect(promptWorkingLabel({ request: '  make it\n  warmer ' })).toBe('Working on “make it warmer”')
  })
  it('names the node a review is looking at', () => {
    expect(promptWorkingLabel({ reviewing: 'Rainy shop' })).toBe('Looking at Rainy shop…')
  })
  it('falls back to the result when the reviewed node has no name', () => {
    expect(promptWorkingLabel({ reviewing: '' })).toBe('Looking at the result…')
  })
  it('prefers the request when both are set', () => {
    expect(promptWorkingLabel({ request: 'upscale it', reviewing: 'Rainy shop' })).toBe('Working on “upscale it”')
  })
  it('names takes by the node, or quotes the request when there is one', () => {
    expect(promptWorkingLabel({ takesOf: 'Rainy shop' })).toBe('Making three takes of Rainy shop')
    expect(promptWorkingLabel({ takesOf: 'Rainy shop', request: 'warmer  light' })).toBe('Making three takes for “warmer light”')
    expect(promptWorkingLabel({ takesOf: '  ' })).toBe('Making three takes of this node')
    expect(promptWorkingLabel({ request: 'hi' })).toBe('Working on “hi”') // unchanged without takesOf
  })
})
