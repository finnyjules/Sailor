import { describe, expect, it } from 'vitest'
import { shouldOfferStartPicker } from '../../app/lib/startPicker'

const fresh = { seen: false, hasSavedContent: false }

describe('shouldOfferStartPicker', () => {
  it('offers the picker on a fresh blank project', () => {
    expect(shouldOfferStartPicker({ type: 'project' }, fresh)).toBe(true)
  })

  it('never offers it on a runner "Open Workflow" tab, even before its graph has loaded', () => {
    // AssetDetailOverlay opens the exact graph a run was made from with only a
    // promptId (no workflowId); the layout fetches the record asynchronously.
    const tab = { type: 'project', promptId: 'run_29e11fe7-138a-4361-abb9-f2d53079cc8f.1.t3' }
    expect(shouldOfferStartPicker(tab, fresh)).toBe(false)
  })

  it('still skips it for a /history reopen and a recent project (workflowId)', () => {
    expect(shouldOfferStartPicker({ type: 'project', workflowId: 'uuid', promptId: 'abc' }, fresh)).toBe(false)
    expect(shouldOfferStartPicker({ type: 'project', workflowId: 'uuid' }, fresh)).toBe(false)
  })

  it('skips it once seen, when content is already there, and for non-project tabs', () => {
    expect(shouldOfferStartPicker({ type: 'project' }, { seen: true, hasSavedContent: false })).toBe(false)
    expect(shouldOfferStartPicker({ type: 'project' }, { seen: false, hasSavedContent: true })).toBe(false)
    expect(shouldOfferStartPicker({ type: 'assets' }, fresh)).toBe(false)
    expect(shouldOfferStartPicker(undefined, fresh)).toBe(false)
  })
})
