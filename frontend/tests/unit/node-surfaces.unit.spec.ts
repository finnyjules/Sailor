// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
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
import { CANVAS_GLASS_KEY, createCanvasGlass } from '~/composables/useCanvasGlass'
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
  it('the edge is one ring that fades slightly from top to bottom, one screen pixel at any zoom', () => {
    expect(rule('.node-shell')).toMatch(/border: calc\(1px \/ var\(--canvas-zoom, 1\)\) solid transparent/)
    const ring = rule('.node-shell::after')
    expect(ring).toMatch(/linear-gradient\(to bottom, var\(--node-edge-top\), var\(--node-edge-bottom\)\)/)
    expect(ring).toMatch(/padding: calc\(1px \/ var\(--canvas-zoom, 1\)\)/)
    // Inside the border, so the card's overflow:hidden during expand never clips it.
    expect(ring).toMatch(/inset: 0;/)
    expect(ring).toMatch(/pointer-events: none/)
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
  it('header actions take no room and no clicks at rest, and show on hover, focus or selection', () => {
    expect(rule('.node-shell__actions')).toMatch(/display: none/)
    for (const sel of ['.node-shell:hover', '.node-shell:focus-within', '.node-shell[data-selected]']) {
      expect(CSS).toContain(`${sel} .node-shell__actions`)
    }
    expect(CSS).toMatch(/\.node-shell\[data-selected\] \.node-shell__actions \{ display: flex; opacity: 1; \}/)
  })
  it('node text is 500, titles 600', () => {
    expect(rule('.node-shell')).toMatch(/font-weight: 500/)
    expect(rule('.node-shell__title')).toMatch(/font-weight: 600/)
  })
  it('the Open bar blurs only while it is up (a hidden blur still costs every frame)', () => {
    expect(CSS).not.toMatch(/\.canvas-glass--blur \.node-openbar \{/)
    expect(CSS).toMatch(/\.canvas-glass--blur \.node-openbar-host:hover \.node-openbar,[\s\S]{0,300}backdrop-filter: blur\(14px\) saturate\(1\.3\)/)
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
  // Fix round 1: a freshly mounted node must blur immediately in 'always' mode — no
  // waiting for the 150ms settle to enumerate ids. Uses the real composable end to end
  // (createCanvasGlass → provideCanvasGlass → NodeShell → useNodeGlass), with no
  // recompute() call and no timer advanced, i.e. exactly the real startup path.
  it("blurs a freshly mounted node immediately in 'always' mode, before any settle timer runs", () => {
    const glass = createCanvasGlass({
      viewport: ref({ x: 0, y: 0, zoom: 1 }),
      boxes: () => [{ id: 'n1', x: 0, y: 0, w: 100, h: 100 }],
      wires: () => [],
      size: () => ({ width: 800, height: 600 }),
    }) // default mode: 'always' — no explicit recompute(), no vi.advanceTimersByTime
    const w = mount(NodeShell, { props: { title: 't', nodeId: 'n1' }, global: { provide: { [CANVAS_GLASS_KEY as symbol]: glass } } })
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
  it('shows the name and size, and the artwork once (the glass tint is a canvas, not a second picture)', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame', size: '4:5 · 1080 × 1350', artwork: '/a.jpg' } })
    expect(w.find('.print-surface__name').text()).toBe('Frame')
    expect(w.find('.print-surface__size').text()).toBe('4:5 · 1080 × 1350')
    expect(w.findAll('img').map(i => i.attributes('src'))).toEqual(['/a.jpg'])
    expect(w.find('.print-surface__glow canvas').exists()).toBe(true)
    expect(w.find('.print-surface__glow').attributes('aria-hidden')).toBe('true')
  })

  it('puts the overlay outside the clipping glass and the below slot after it', () => {
    const w = mount(PrintSurface, {
      props: { name: 'Frame' },
      slots: { overlay: '<i class="ov" />', below: '<i class="bl" />', size: '<b class="sz">Set size</b>' },
    })
    expect(w.find('.print-surface__glass .ov').exists()).toBe(false)
    expect(w.find('.print-surface__frame > .ov').exists()).toBe(true)
    expect(w.find('.print-surface > .bl').exists()).toBe(true)
    expect(w.find('.print-surface__label .sz').text()).toBe('Set size')
  })

  it('passes state attributes to the root', () => {
    const w = mount(PrintSurface, { props: { name: 'Frame' }, attrs: { 'data-running': '' } })
    expect(w.find('.print-surface').attributes('data-running')).toBe('')
  })

  it('draws the tint small, with the blur baked in, once per frame however often it is asked', () => {
    const q: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { q.push(cb); return q.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const draws: unknown[][] = []
    const ctx: any = { filter: 'none', clearRect() {}, drawImage: (...a: unknown[]) => { draws.push([ctx.filter, ...a]) } }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const w = mount(PrintSurface, { props: { name: 'Frame' } })
    const src = document.createElement('canvas'); src.width = 1080; src.height = 1350
    ;(w.vm as any).capture(src); (w.vm as any).capture(src)
    expect(q.length).toBe(1)
    q.shift()!(0)
    expect(draws.length).toBe(1)
    expect(draws[0]![0]).toMatch(/blur\(/)
    const tint = w.find('.print-surface__glow canvas').element as HTMLCanvasElement
    expect(Math.max(tint.width, tint.height)).toBe(64)
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  })
})

describe('print surface CSS guards', () => {
  it('draws the ring above the tint, not under it', () => {
    expect(rule('.print-surface__glass::after')).toMatch(/inset 0 0 0 calc\(1px/)
    expect(rule('.print-surface__glass')).not.toMatch(/inset/)
  })
  it('never blurs the on-screen tint with CSS, except in the fallback', () => {
    expect(rule('.print-surface__glow > canvas')).not.toMatch(/filter/)
    expect(rule('.print-surface__glow--css > canvas')).toMatch(/blur\(28px\)/)
  })
})
