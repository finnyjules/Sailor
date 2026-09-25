// Stage 4 wiring guard: every simple studio docks the one prompt with its own
// chip and lists actions before its dials. Source-level on purpose — the surfaces
// are thousands of lines of WebGL; the Playwright spec proves the behaviour.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../../app/components/vue-canvas/${name}`, import.meta.url)), 'utf8')
const SIMPLE: Record<string, string> = {
  'GradientStudioSurface.vue': 'gradient-studio',
  'ShaderStudioSurface.vue': 'shader-studio',
  'ShapeStudioSurface.vue': 'shape-studio',
  'VectorTypeSurface.vue': 'vector-type-studio',
}

describe('simple studios dock the one prompt', () => {
  for (const [file, place] of Object.entries(SIMPLE)) {
    it(`${file}: chip, place, no bespoke placeholder`, () => {
      const s = src(file)
      expect(s).toContain(':prompt-label=')
      expect(s).toContain(`prompt-place="${place}"`)
      expect(s).not.toContain('agent-placeholder')
      expect(s).not.toContain('#agentBar')
    })
    it(`${file}: the inspector opens with the head, then actions`, () => {
      const s = src(file)
      const controls = s.slice(s.indexOf('<template #controls>'))
      const head = controls.indexOf('<StudioInspectorHead')
      const actions = controls.indexOf('<StudioActionRows')
      expect(head).toBeGreaterThan(-1)
      expect(actions).toBeGreaterThan(head)
      // nothing but the head sits before the actions
      expect(controls.slice(0, head)).not.toMatch(/<StudioSection|<StudioControlPanel/)
    })
  }
  it('Gradient’s zoom lives in the tool bar, not on the preview', () => {
    const s = src('GradientStudioSurface.vue')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toContain('zoomBy(')
    expect(tools).toContain('resetZoom')
    const preview = s.slice(s.indexOf('<template #preview>'), s.indexOf('<template #tools>'))
    expect(preview).not.toContain('zoomBy(')
  })
  it('Vector type’s play and scrub live in the tool bar; the footer has no second Play', () => {
    const s = src('VectorTypeSurface.vue')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toMatch(/playing/)
    expect(tools).toMatch(/onSeek|previewTime/)
    const footer = s.slice(s.indexOf('<template #actions>'))
    expect(footer.slice(0, footer.indexOf('</template>'))).not.toMatch(/Pause|togglePlay/)
  })
})
