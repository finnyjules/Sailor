// Stage 4 wiring guard: every simple studio docks the one prompt with its own
// chip and lists actions before its dials. Source-level on purpose — the surfaces
// are thousands of lines of WebGL; the Playwright spec proves the behaviour.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../../app/components/vue-canvas/${name}`, import.meta.url)), 'utf8')
/** One named slot's content, to its own closing tag (nested <template>s are
 *  counted, so a `<template v-if>` inside doesn't cut it short). Throws when the
 *  slot is missing, so a "not on the preview" check can never pass on nothing. */
function slot(s: string, name: string): string {
  const start = s.search(new RegExp(`<template #${name}\\b`))
  if (start < 0) throw new Error(`no <template #${name}>`)
  const re = /<template\b|<\/template>/g
  re.lastIndex = start
  let depth = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    depth += m[0] === '</template>' ? -1 : 1
    if (depth === 0) {
      const body = s.slice(start, m.index)
      expect(body.length, `#${name} is empty`).toBeGreaterThan(`<template #${name}>`.length)
      return body
    }
  }
  throw new Error(`<template #${name}> never closes`)
}
const SIMPLE: Record<string, string> = {
  'GradientStudioSurface.vue': 'gradient-studio',
  'ShaderStudioSurface.vue': 'shader-studio',
  'ShapeStudioSurface.vue': 'shape-studio',
  'VectorTypeSurface.vue': 'vector-type-studio',
  'TextureStudioSurface.vue': 'pattern-studio',
  'SpaceTypeSurface.vue': 'space-type-studio',
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
    const tools = slot(s, 'tools')
    expect(tools).toContain('zoomBy(')
    expect(tools).toContain('resetZoom')
    const preview = slot(s, 'preview')
    expect(preview).not.toContain('zoomBy(')
  })
  it('Vector type’s play and scrub live in the tool bar; the footer has no second Play', () => {
    const s = src('VectorTypeSurface.vue')
    const tools = slot(s, 'tools')
    expect(tools).toMatch(/playing/)
    expect(tools).toMatch(/onSeek|previewTime/)
    expect(slot(s, 'actions')).not.toMatch(/Pause|togglePlay/)
  })
})

describe('Texture and Space type', () => {
  it('Texture docks the prompt; repeat and seams are in the bar; the raster content prompt stays', () => {
    const s = src('TextureStudioSurface.vue')
    expect(s).toContain('prompt-place="pattern-studio"')
    expect(s).not.toContain('agent-placeholder')
    const tools = slot(s, 'tools')
    expect(tools).toContain('setRepeat(')
    expect(tools).toContain('toggleSeams')
    expect(s).toContain('Describe a texture to generate') // content prompt, stage 6
  })
  it('Space type uses useStudioAgent through the shell, and VibeControlBar is gone', () => {
    const s = src('SpaceTypeSurface.vue')
    expect(s).toContain('useStudioAgent(')
    expect(s).toContain(':agent="spaceTypeAgent"')
    expect(s).toContain('prompt-place="space-type-studio"')
    expect(s).not.toMatch(/VibeControlBar|onVibe\b|vibeProposal|#agentBar/)
  })
  it('Space type’s transport is in the bar, not floating on the preview', () => {
    const s = src('SpaceTypeSurface.vue')
    const tools = slot(s, 'tools')
    expect(tools).toContain('togglePlay')
    expect(tools).toContain('onScrub(')
    const preview = slot(s, 'preview')
    expect(preview).not.toContain('onScrub(')
  })
})

describe('3D', () => {
  it('mounts the prompt with no worker, and lifts it above whichever bar shows', () => {
    const s = src('Scene3DStudioSurface.vue')
    expect(s).toContain('prompt-place="scene3d-studio"')
    expect(s).toContain('prompt-host="scene3d"')
    expect(s).toContain(':full-bleed-bottom-offset="promptOffset"')
    expect(s).not.toMatch(/:full-bleed-bottom-offset="72"/)
    expect(s).toMatch(/bottomBarEl/)
  })
})

describe('render-then-close settles an open take strip first', () => {
  // Texture's worker (useTextureAgent) has no takes, so it has no strip to settle.
  for (const file of ['ShaderStudioSurface.vue', 'GradientStudioSurface.vue', 'ShapeStudioSurface.vue']) {
    it(`${file}: every close after a render keeps the picked take or abandons the strip`, () => {
      const lines = src(file).split('\n')
      const calls = lines.map((l, i) => ({ l, i })).filter(({ l }) =>
        /\bcloseEditor\(\)/.test(l) && !/function closeEditor|e\.key === 'Escape'|^\s*(\/\/|\*)/.test(l))
      expect(calls.length, file).toBeGreaterThan(0)
      for (const { i } of calls) {
        const near = lines.slice(Math.max(0, i - 1), i + 1).join('\n')
        expect(near, `${file}:${i + 1}`).toContain('settleTakesOnRender(')
      }
    })
  }
})

describe('Texture names the lattice as its picker does', () => {
  it('the lattice select has a label for every lattice, and the chip reads them', async () => {
    const { TEXTURE_CONTROLS } = await import('~/lib/texturefx/controls')
    const c = TEXTURE_CONTROLS.find(x => x.key === 'lattice') as any
    expect(c.optionLabels).toHaveLength(c.options.length)
    for (const l of c.optionLabels) expect(l).toMatch(/^[A-Z][a-z]+$/)
    const s = src('TextureStudioSurface.vue')
    expect(s).toMatch(/optionLabels\?\.\[c\.options\.indexOf\(/)
    expect(s).not.toMatch(/l\.charAt\(0\)\.toUpperCase\(\)/)
  })
})

describe('Space type head', () => {
  it('doesn’t repeat the effect name when there is no text', () => {
    const s = src('SpaceTypeSurface.vue')
    expect(s).toMatch(/<StudioInspectorHead :title="headTitle" :subtitle="headSubtitle"/)
    expect(s).toMatch(/const headSubtitle = computed\(\(\) => \(headWords\.value \? effect\.value\.label : undefined\)\)/)
  })
  it('play and pause are lucide icons, as in Vector type', () => {
    const s = src('SpaceTypeSurface.vue')
    expect(s).toContain(":icon=\"playing ? Pause : Play\"")
    expect(s).not.toMatch(/PauseGlyph|PlayGlyph/)
  })
})

