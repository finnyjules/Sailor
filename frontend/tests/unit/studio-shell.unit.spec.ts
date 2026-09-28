import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
/** The class attribute of the element that carries `node-shell`. */
const shellClass = (t: string) => (t.match(/class="([^"]*\bnode-shell\b[^"]*)"/) ?? [])[1] ?? ''
/** The opening tag of the element that carries `node-shell`. */
const shellTag = (t: string) => {
  const i = t.search(/class="[^"]*\bnode-shell\b/)
  const start = t.lastIndexOf('<', i)
  return t.slice(start, t.indexOf('>', i) + 1)
}

const FAMILY_A = [
  'GradientStudioNode.vue', 'ShaderStudioNode.vue', 'TextureStudioNode.vue',
  'ShapeStudioNode.vue', 'VectorTypeNode.vue', 'SpaceTypeNode.vue',
  'Scene3DStudioNode.vue',
]

describe.each(FAMILY_A)('%s wears the studio shell', (file) => {
  const s = src(file)
  const t = tpl(s)
  it('the card is a 240px glass shell over its ports', () => {
    const c = shellClass(t)
    expect(c).toMatch(/\brelative\b/)
    expect(c).toMatch(/\bz-10\b/)
    expect(c).toMatch(/\bw-\[240px\]/)
    expect(c).not.toMatch(/rounded-xl|\bborder\b|bg-neutral-900|shadow-lg|overflow-hidden|text-white/)
  })
  it('carries glass and selection, and opens on double-click', () => {
    const tag = shellTag(t)
    expect(tag).toMatch(/:data-glass-blur="glass \|\| undefined"/)
    expect(tag).toMatch(/:data-selected="selected \|\| undefined"/)
    expect(tag).toMatch(/@dblclick\.stop="openEditor"/)
    expect(s).toMatch(/selected\?: boolean/)
    expect(s).toMatch(/const glass = useNodeGlass\(\(\) => props\.id\)/)
  })
  it('header is icon + title only', () => {
    expect(t).toMatch(/class="node-shell__head"/)
    expect(t).toMatch(/class="node-shell__title"/)
  })
  it('the preview sits in a well with an Open bar', () => {
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(s).toMatch(/import NodeOpenBar from '~\/components\/vue-canvas\/surfaces\/NodeOpenBar\.vue'/)
  })
  it('the footer is only the Render control', () => {
    expect(t).toMatch(/class="node-shell__foot justify-end"[\s\S]{0,200}<StudioRenderButton :node-id="id" :busy="!!data\?\.studioBusy" \/>/)
    expect(t).not.toMatch(/Pencil/)
    expect(t).not.toMatch(/>\s*Edit\s*</)
  })
})

describe('Kinetic keeps its hover-to-play and render-error badge', () => {
  const t = tpl(src('SpaceTypeNode.vue'))
  it('the wrapper still owns the hover handlers', () => {
    expect(t).toMatch(/class="studio-node relative w-fit" @pointerenter="onNodeHoverEnter" @pointerleave="onNodeHoverLeave"/)
  })
})

describe('3D Studio keeps its own states', () => {
  const t = tpl(src('Scene3DStudioNode.vue'))
  const tag = shellTag(t)
  it('mute and bypass still dim the card', () => {
    expect(tag).toMatch(/:class="\{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed \}"/)
  })
  it('the ports still set the card height', () => {
    expect(tag).toMatch(/minHeight: `\$\{portsMinHeight\}px`/)
  })
  it('an empty scene still offers its Edit scene button inside the well', () => {
    expect(t).toMatch(/class="node-well node-openbar-host aspect-square"[\s\S]*Edit scene/)
  })
})
