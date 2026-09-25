// frontend/tests/unit/change-lines.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { changeLine, changesTitle } from '~/lib/prompt/changeLines'

const ch = (op: string, label: string, before: string, after: string, o: any = {}) =>
  ({ command: { op }, label, before, after, rationale: '', rerollable: false, accepted: true, ...o }) as any

describe('changeLine', () => {
  it('marks and words each kind of change like the mockup', () => {
    expect(changeLine(ch('addNode', 'Add node', '', 'Upscale ×2'), 0)).toMatchObject({ mark: '+', text: 'Add Upscale ×2' })
    expect(changeLine(ch('connect', 'Connect', '', 'Rainy shop → Upscale ×2'), 1)).toMatchObject({ mark: '↳', text: 'Rainy shop → Upscale ×2' })
    expect(changeLine(ch('deleteNode', 'Delete', 'Rainy shop', 'removed'), 2)).toMatchObject({ mark: '−', text: 'Rainy shop (removed)' })
    expect(changeLine(ch('setWidget', 'Generate · steps', '20', '30'), 3)).toMatchObject({ mark: '~', text: 'Generate · steps: 20 → 30' })
    expect(changeLine(ch('tuneNode', 'Frame · background', '', 'blue'), 4)).toMatchObject({ mark: '~', text: 'Frame · background: blue' })
  })
  it('carries index, accepted, rerollable and review origin', () => {
    expect(changeLine(ch('setWidget', 'x', '', 'y', { accepted: false, rerollable: true, fromReview: true }), 5))
      .toEqual({ index: 5, mark: '~', text: 'x: y', accepted: false, rerollable: true, fromReview: true })
  })
})

describe('changesTitle', () => {
  it('counts the changes and says where they are', () => {
    expect(changesTitle([ch('addNode', '', '', 'A')])).toBe('A change to the graph · shown on the canvas')
    expect(changesTitle([ch('addNode', '', '', 'A'), ch('connect', '', '', 'x')])).toBe('2 changes to the graph · shown on the canvas')
  })
})
