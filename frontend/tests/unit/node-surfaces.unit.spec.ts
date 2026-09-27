// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, h } from 'vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import NodeShell from '~/components/vue-canvas/surfaces/NodeShell.vue'
import NodeWell from '~/components/vue-canvas/surfaces/NodeWell.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import PrintSurface from '~/components/vue-canvas/surfaces/PrintSurface.vue'
import { CANVAS_GLASS_KEY } from '~/composables/useCanvasGlass'
import { NodeIdInjection } from '@vue-flow/core'

let CSS = ''
try {
  CSS = readFileSync(fileURLToPath(new URL('../../app/assets/css/node-surfaces.css', import.meta.url)), 'utf8')
} catch {
  // In happy-dom, import.meta.url may not work properly, use process.cwd() fallback
  CSS = readFileSync(resolve(process.cwd(), 'app/assets/css/node-surfaces.css'), 'utf8')
}
const rule = (sel: string) => {
  const i = CSS.indexOf(`${sel} {`)
  if (i < 0) throw new Error(`rule ${sel} not found`)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('node-surfaces.css guards', () => {
  it('shell fill is flat: no gradient inside a shell (a lighter top reads as a dark seam)', () => {
    expect(rule('.node-shell')).not.toMatch(/gradient/)
  })
  it('shell has no inner highlight line (it doubles the top edge)', () => {
    expect(rule('.node-shell')).not.toMatch(/inset\s+0\s+1px/)
  })
  it('borders stay one screen pixel at every zoom', () => {
    expect(rule('.node-shell')).toMatch(/calc\(1px \/ var\(--canvas-zoom, 1\)\)/)
  })
  it('real blur only under the canvas switch AND the node flag', () => {
    expect(CSS).toMatch(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*backdrop-filter: blur\(18px\) saturate\(1\.4\)/)
    expect(CSS.replace(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*\}/, '')).not.toMatch(/backdrop-filter: blur\(18px\)/)
  })
  it('never promotes layers', () => {
    expect(CSS).not.toMatch(/will-change|translateZ/)
  })
  it('node text is 500, titles 600', () => {
    expect(rule('.node-shell')).toMatch(/font-weight: 500/)
    expect(rule('.node-shell__title')).toMatch(/font-weight: 600/)
  })
})

describe('NodeShell', () => {
  it('renders title, body and foot', () => {
    const w = mount(NodeShell, { props: { title: 'Generate an image' }, slots: { default: 'BODY', foot: 'FOOT' } })
    expect(w.find('.node-shell__title').text()).toBe('Generate an image')
    expect(w.find('.node-shell__body').text()).toBe('BODY')
    expect(w.find('.node-shell__foot').text()).toBe('FOOT')
  })
  it('omits the foot when no foot slot is given', () => {
    const w = mount(NodeShell, { props: { title: 'Gradient' } })
    expect(w.find('.node-shell__foot').exists()).toBe(false)
  })
  it('asks for real blur only when the canvas marks this node', () => {
    const blurIds = ref(new Set(['n1']))
    const on = mount(NodeShell, { props: { title: 't', nodeId: 'n1' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: { blurIds } } } })
    const off = mount(NodeShell, { props: { title: 't', nodeId: 'n2' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: { blurIds } } } })
    expect(on.find('.node-shell').attributes('data-glass-blur')).toBeDefined()
    expect(off.find('.node-shell').attributes('data-glass-blur')).toBeUndefined()
  })
  it('falls back to the Vue Flow node id when no nodeId is passed', () => {
    const blurIds = ref(new Set(['n1']))
    const w = mount(NodeShell, { props: { title: 't' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: { blurIds }, [NodeIdInjection as symbol]: 'n1' } } })
    expect(w.find('.node-shell').attributes('data-glass-blur')).toBeDefined()
  })
  it('keeps the Open bar up while the shell is selected', () => {
    expect(CSS).toMatch(/\.node-shell\[data-selected\] \.node-openbar[^{]*\{[^}]*opacity: 1/)
  })
})

describe('NodeWell + NodeOpenBar', () => {
  it('becomes an Open bar host only with an openbar slot', () => {
    const plain = mount(NodeWell, { slots: { default: 'x' } })
    const host = mount(NodeWell, { slots: { default: 'x', openbar: () => h(NodeOpenBar, { meta: '3 colours · mesh' }, () => 'Open') } })
    expect(plain.classes()).not.toContain('node-openbar-host')
    expect(host.classes()).toContain('node-openbar-host')
    expect(host.find('.node-openbar__meta').text()).toBe('3 colours · mesh')
  })
})

describe('ContentCard', () => {
  it('names the card above its media', () => {
    const w = mount(ContentCard, { props: { name: 'beach-dog.jpg' }, slots: { default: '<img>' } })
    expect(w.find('.content-card__name').text()).toContain('beach-dog.jpg')
    expect(w.find('.content-card__media img').exists()).toBe(true)
  })
})

describe('PrintSurface', () => {
  it('uses the artwork for both the art and the glass tint', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame', size: '4:5 · 1080 × 1350', artwork: '/a.jpg' } })
    expect(w.find('.print-surface__name').text()).toBe('Frame')
    expect(w.find('.print-surface__size').text()).toBe('4:5 · 1080 × 1350')
    expect(w.findAll('img').map(i => i.attributes('src'))).toEqual(['/a.jpg', '/a.jpg'])
    expect(w.find('.print-surface__glow img').attributes('alt')).toBe('')
  })
})
