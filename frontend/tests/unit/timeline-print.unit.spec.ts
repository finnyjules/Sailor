import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('Timeline card is a print', () => {
  const node = src('app/components/vue-canvas/ArtifactTimelineNode.vue')
  const preview = src('app/components/vue-canvas/TimelineNodePreview.vue')

  it('wears the print surface, not the old bordered frame', () => {
    expect(node).toMatch(/<PrintSurface[\s\S]*name="Timeline"/)
    expect(node).not.toMatch(/class="artifact-frame /)
  })
  it('keeps Open and Render in the bar, calling the same functions', () => {
    expect(node).toMatch(/<NodeOpenBar/)
    expect(node).toMatch(/@click\.stop="openEditor"[^>]*>Open</)
    expect(node).toMatch(/@click\.stop="runThisNode"/)
  })
  it('tints the glass from the preview only when it paints a still', () => {
    expect(preview).toMatch(/emit\('still'/)
    expect(node).toMatch(/@still="/)
  })
})
