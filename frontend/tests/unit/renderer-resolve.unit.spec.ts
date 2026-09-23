import { describe, it, expect } from 'vitest'
import { resolutionPlanFor } from '../../app/lib/engine/webglPreviewRenderer'
import { createSpaceTypeClip } from '../../app/composables/timelineSpaceTypeClip'
import { defaultSpaceTypeState } from '../../app/lib/spacetype/state'

// The pure decision table: clip + resolved preview → which source kind loads.
describe('resolutionPlanFor', () => {
  const base = { id: 'c', start_frame: 0, in_frame: 0, length: 10 }
  it('image clip + image preview → image source', () => {
    expect(resolutionPlanFor({ ...base, kind: 'image' } as any, { url: 'u', kind: 'image' })).toEqual({ kind: 'image', url: 'u' })
  })
  it('video clip + video preview → webcodecs ladder', () => {
    expect(resolutionPlanFor({ ...base, kind: 'video' } as any, { url: 'u', kind: 'video' })).toEqual({ kind: 'video', url: 'u' })
  })
  it('workflow clip resolved to a sequence → sequence source', () => {
    expect(resolutionPlanFor({ ...base, kind: 'workflow', port_index: 1 } as any, { url: 'u0', kind: 'sequence', urls: ['u0', 'u1'] }))
      .toEqual({ kind: 'sequence', urls: ['u0', 'u1'] })
  })
  it('title clip needs no preview → text source', () => {
    expect(resolutionPlanFor({ ...base, kind: 'title', title: {} } as any, null)).toEqual({ kind: 'text' })
  })
  // Task 2 (browser video export): plain 'text' clips are now drawn by
  // TextCanvasSource too (like title), so this replaces the old "'text' is
  // unsupported → null" assertion.
  it('plain text clip needs no preview → text source', () => {
    expect(resolutionPlanFor({ ...base, kind: 'text', text: {} } as any, null)).toEqual({ kind: 'text' })
  })
  it('unsupported / unresolved → null', () => {
    expect(resolutionPlanFor({ ...base, kind: 'caption' } as any, null)).toBeNull()
    expect(resolutionPlanFor({ ...base, kind: 'video' } as any, null)).toBeNull()
  })
})

describe('resolutionPlanFor — spacetype', () => {
  it('short-circuits to the spacetype plan with no preview', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    expect(resolutionPlanFor(clip, null)).toEqual({ kind: 'spacetype' })
  })

  it('ignores any resolved preview for a spacetype clip', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    const preview = { kind: 'image' as const, url: 'stale.png' }
    expect(resolutionPlanFor(clip, preview)).toEqual({ kind: 'spacetype' })
  })
})
