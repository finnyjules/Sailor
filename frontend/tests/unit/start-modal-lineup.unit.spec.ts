import { describe, it, expect } from 'vitest'
import { START_AI, startHandTiles } from '../../app/data/start-modal'
import { STUDIO_OPTIONS } from '../../app/data/studio-options'

describe('start modal lineup', () => {
  it('has five AI ways, in order, all using credits', () => {
    expect(START_AI.map(t => t.name)).toEqual([
      'Generate an image', 'An image in a style', 'Edit an image', 'Upscale an image', 'Generate a video',
    ])
    expect(START_AI.every(t => t.kind === 'ai' && t.credits)).toBe(true)
  })

  it('has eight studios with Expressive on, seven with it off', () => {
    expect(startHandTiles(true).map(t => t.name)).toEqual([
      'Expressive', 'Gradient', 'Shader', 'Pattern', 'Shape', 'Vector type', '3D', 'Moodboard',
    ])
    expect(startHandTiles(false).map(t => t.name)).not.toContain('Expressive')
    expect(startHandTiles(false)).toHaveLength(7)
    expect(startHandTiles(true).every(t => t.kind === 'hand' && !t.credits)).toBe(true)
  })

  it('leaves the toolbar Studios door alone', () => {
    const door = STUDIO_OPTIONS.map(o => o.label)
    expect(door).toContain('Shot Director')
    expect(door).toContain('Lip-Sync')
    const modal = [...START_AI, ...startHandTiles(true)].map(t => t.name)
    expect(modal).not.toContain('Shot Director')
    expect(modal).not.toContain('Lip-Sync')
  })

  it('every caption line fits one line (≤ 30 chars)', () => {
    for (const t of [...START_AI, ...startHandTiles(true)]) expect(t.line.length, t.name).toBeLessThanOrEqual(30)
  })
})
