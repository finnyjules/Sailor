// @vitest-environment happy-dom
//
// Four Takes — the CLOSE path, pinned at the shell.
//
// Why this file exists: `StudioModalShell.vue` is where every studio's ✕ and
// Escape live, and it is the only place that can put a previewed take back
// BEFORE the surface saves (a surface saves inside its own close handler, so
// anything later persists the preview as if the user had pressed Keep). That
// ordering was provably untested — deleting the `abandonTakes()` call from the
// shell left the whole suite green. These specs assert the ORDER, not just that
// both things happened, and pin that a studio without a take session closes
// exactly as it always did.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { shallowRef } from 'vue'

// The shell's prompt builds an effect-takes session (stage 5). A controllable fake:
// `fx.open()` puts a set on screen; its close records where it falls in the order.
const fx = vi.hoisted(() => ({ calls: null as string[] | null, api: null as any }))
vi.mock('~/composables/useEffectTakes', async () => {
  const { ref, shallowRef: sr, computed } = await import('vue')
  return {
    useEffectTakes: () => {
      const session = sr<any>(null)
      fx.api = {
        session, target: sr(null), request: ref(''), working: computed(() => false), error: ref(''), notice: ref(''), saving: ref(false),
        start: vi.fn(), preview: vi.fn(), choose: vi.fn(), keep: vi.fn(), more: vi.fn(), stop: vi.fn(), clearMessages: vi.fn(),
        close: vi.fn(() => { fx.calls?.push('effects-close'); session.value = null }),
        open: () => { session.value = { nodeId: 'shader-studio', nodeLabel: 'Water ripple', request: 'rain', tiles: [], known: [], hovered: null, chosen: null, currentThumb: null } },
      }
      return fx.api
    },
  }
})

import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'

/** The shape the shell actually reads off a `useStudioAgent` return. */
function takeAgent(calls: string[], over: Record<string, unknown> = {}) {
  return {
    busy: ref(false),
    error: ref(''),
    notice: ref(''),
    reviewing: ref(false),
    hasProposal: ref(false),
    review: ref(null),
    changes: ref([]),
    hovered: ref(null),
    ask: vi.fn(),
    // Take session — a strip is OPEN, with a take selected and previewing.
    hasTakes: ref(true),
    takes: ref([{ label: 'warmer', changes: [{ key: 'hue', value: 40 }], rationale: '' }]),
    takeThumbs: ref(new Map()),
    takeCurrentThumb: ref(null),
    selectedTake: ref(null),
    previewTake: vi.fn(),
    selectTake: vi.fn(),
    keepTake: vi.fn(),
    dismissTakes: vi.fn(),
    abandonTakes: vi.fn(() => { calls.push('abandon') }),
    moreDirections: vi.fn(),
    ...over,
  }
}

/** Texture's agent: the same chrome, no take session at all. */
function structuralAgent(calls: string[]) {
  const a = takeAgent(calls)
  delete (a as Record<string, unknown>).hasTakes
  delete (a as Record<string, unknown>).abandonTakes
  return a
}

function mountShell(agent: unknown, calls: string[], slots: Record<string, string> = {}) {
  return mount(StudioModalShell, {
    props: { title: 'Test studio', agent },
    attrs: { onClose: () => calls.push('surface-close') },
    slots: { preview: '<div>preview</div>', ...slots },
    global: { stubs: { StudioPromptHost: true, AgentSweep: true } },
  })
}

const closeBtn = (w: any) => w.get('button[aria-label="Close"]')
const pressEscape = async (w: any) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  await w.vm.$nextTick()
}

describe('StudioModalShell — closing with a take strip open', () => {
  it('✕ restores the original BEFORE the surface is told to close', async () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls), calls)
    await closeBtn(w).trigger('click')
    // The order is the whole point: a surface saves in its close handler.
    expect(calls).toEqual(['abandon', 'surface-close'])
  })

  it('Escape does the same, in the same order', async () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls), calls)
    await pressEscape(w)
    expect(calls).toEqual(['abandon', 'surface-close'])
  })

  it('an open effect set is ended before the surface is told to close, so a previewed draft is never saved', async () => {
    const calls: string[] = []
    fx.calls = calls
    const w = mountShell(takeAgent(calls), calls)
    fx.api.open()
    await closeBtn(w).trigger('click')
    expect(calls).toEqual(['abandon', 'effects-close', 'surface-close'])
    fx.calls = null
  })

  it('no effect set open: closing never touches the effect session', async () => {
    const calls: string[] = []
    fx.calls = calls
    const w = mountShell(takeAgent(calls), calls)
    await pressEscape(w)
    expect(calls).toEqual(['abandon', 'surface-close'])
    fx.calls = null
  })

  it('exposes its prompt, with the effect target passed through', async () => {
    const calls: string[] = []
    const target = { key: 'shader-studio', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() }
    const effectTarget = vi.fn(() => target)
    const w = mount(StudioModalShell, {
      // No take strip open (so nothing is busy).
      props: { title: 'Shader studio', agent: takeAgent(calls, { takes: undefined, hasTakes: undefined }), effectTarget },
      slots: { preview: '<div>preview</div>' },
      global: { stubs: { StudioPromptHost: true, AgentSweep: true } },
    })
    const prompt = (w.vm as any).prompt
    expect(typeof prompt.setMode).toBe('function')
    prompt.setMode('Remix')
    await prompt.submit('rain')
    expect(effectTarget).toHaveBeenCalledWith({ effectId: null, add: false, fresh: false, remix: true })
    expect(fx.api.start).toHaveBeenCalledWith('rain', target)
  })

  it('closes exactly once per press', async () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls), calls)
    await closeBtn(w).trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('mounts the prompt for an agent, and for a promptPlace with no agent', () => {
    const calls: string[] = []
    expect(mountShell(takeAgent(calls), calls).findComponent({ name: 'StudioPromptHost' }).exists()).toBe(true)
    const bare = mount(StudioModalShell, {
      props: { title: 'Studio' }, slots: { preview: '<div>preview</div>' },
      global: { stubs: { StudioPromptHost: true, AgentSweep: true } },
    })
    expect(bare.findComponent({ name: 'StudioPromptHost' }).exists()).toBe(false)
    bare.unmount()
    const scene = mount(StudioModalShell, {
      props: { title: '3D Studio', promptPlace: 'scene3d-studio', promptHost: 'scene3d' }, slots: { preview: '<div>preview</div>' },
      global: { stubs: { StudioPromptHost: true, AgentSweep: true } },
    })
    expect(scene.findComponent({ name: 'StudioPromptHost' }).exists()).toBe(true)
    scene.unmount()
  })

  it('renders #tools under the prompt, in the shared bar', () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls), calls, { tools: '<button data-testid="zoom-in">+</button>' })
    const dock = w.get('[data-testid="studio-shell-dock"]')
    expect(dock.find('[data-testid="studio-tool-bar"] [data-testid="zoom-in"]').exists()).toBe(true)
    const host = dock.findComponent({ name: 'StudioPromptHost' }).element
    const bar = dock.get('[data-testid="studio-tool-bar"]').element
    expect(host.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    w.unmount()
  })

  it('draws no tool bar when #tools renders nothing (Vector type, not animated)', () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls), calls, { tools: '<button v-if="false">Play</button>' })
    expect(w.find('[data-testid="studio-tool-bar"]').exists()).toBe(false)
    w.unmount()
  })

  it('never replaces the controls column', () => {
    const calls: string[] = []
    const w = mountShell(takeAgent(calls, { busy: ref(true), hasProposal: ref(true) }), calls, { controls: '<div data-testid="ctl">controls</div>' })
    expect(w.find('[data-testid="ctl"]').exists()).toBe(true)
    w.unmount()
  })
})

describe('StudioModalShell — studios without a take session are untouched', () => {
  it('Texture (structural agent, no take session) closes byte-identically on ✕', async () => {
    const calls: string[] = []
    const w = mountShell(structuralAgent(calls), calls)
    await closeBtn(w).trigger('click')
    expect(calls).toEqual(['surface-close'])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('Texture closes byte-identically on Escape', async () => {
    const calls: string[] = []
    const w = mountShell(structuralAgent(calls), calls)
    await pressEscape(w)
    expect(calls).toEqual(['surface-close'])
  })

  it('no agent and no promptPlace: no dock, closes byte-identically', async () => {
    const calls: string[] = []
    const w = mount(StudioModalShell, {
      props: { title: 'Expressive Studio' },
      attrs: { onClose: () => calls.push('surface-close') },
      slots: { preview: '<div>preview</div>' },
    })
    expect(w.find('[data-testid="studio-shell-dock"]').exists()).toBe(false)
    await closeBtn(w).trigger('click')
    await pressEscape(w)
    expect(calls).toEqual(['surface-close', 'surface-close'])
  })
})

// ── Full-bleed variant ───────────────────────────────────────────────────────
//
// `fullBleed` is opt-in and 3D Studio is (so far) the only taker. The whole risk
// of the change is the OTHER six studios: their layout is three columns in a
// row, and it must stay that, class string for class string. So the off-variant
// specs below pin the exact class of every structural div — a stray Tailwind
// token added "just for the full-bleed case" fails here rather than in someone's
// screenshot. The on-variant specs pin the shape the live tests then measure:
// one absolute ground layer, two floating panels, a bottom cluster carrying the
// offset. (3D Studio passes no `agent`, so its cluster is empty in the real app
// — the cluster is exercised here, with an agent, instead of on that surface.)
const BOXED_BODY = 'flex min-h-0 flex-1 gap-4 p-4'
const BOXED_ASIDE = 'flex w-72 shrink-0 min-h-0'
// min-w-0 added for the shared-pen Plan C final review (I2): without it this column's
// intrinsic content width (the dock/toolbar) can push the controls column past the
// dialog's right edge at common laptop widths — see ShapeStudioSurface's pen toolbar.
const BOXED_PREVIEW_COL = 'flex min-h-0 min-w-0 flex-1 flex-col'
const BOXED_PREVIEW = 'relative flex min-h-0 flex-1 items-center justify-center'
const BOXED_CONTROLS = 'flex w-72 shrink-0 flex-col gap-2 overflow-y-auto pr-1 min-h-0'

/** `dialog > *` in order: header band, body, (actions footer). */
const bodyOf = (w: any) => w.get('[role="dialog"]').element.children[1] as HTMLElement
const classOf = (el: Element) => el.getAttribute('class') || ''

/** Every shell registers a window keydown listener for its lifetime, and a
 *  full-bleed one calls preventDefault() on ⌘\. A wrapper left mounted from an
 *  earlier test would therefore eat the key before the shell under test sees it
 *  (the shell bails on `defaultPrevented`) — so these wrappers are unmounted. */
const live: any[] = []
function mountVariant(props: Record<string, unknown>, agent?: unknown) {
  const w = mount(StudioModalShell, {
    props: { title: 'Studio', agent, ...props },
    slots: {
      preview: '<div data-testid="pv">preview</div>',
      aside: '<div data-testid="objects">objects</div>',
      controls: '<div data-testid="ctl">controls</div>',
    },
    global: { stubs: { StudioPromptHost: true, AgentSweep: true } },
  })
  live.push(w)
  return w
}
afterEach(() => { while (live.length) live.pop()?.unmount() })

const pressToggle = async (w: any) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, cancelable: true }))
  await w.vm.$nextTick()
}

beforeEach(() => { try { sessionStorage.clear() } catch { /* noop */ } })

describe('StudioModalShell — boxed (default) layout is untouched', () => {
  it('renders the three columns in a row, with their original classes', () => {
    const w = mountVariant({})
    const body = bodyOf(w)
    expect(classOf(body)).toBe(BOXED_BODY)
    const [aside, previewCol, controls] = Array.from(body.children)
    expect(classOf(aside!)).toBe(BOXED_ASIDE)
    expect(classOf(previewCol!)).toBe(BOXED_PREVIEW_COL)
    expect(classOf(previewCol!.children[0]!)).toBe(BOXED_PREVIEW)
    expect(classOf(controls!)).toBe(BOXED_CONTROLS)
    // All three carry the slot content they always did.
    expect(w.find('[data-testid="objects"]').exists()).toBe(true)
    expect(w.find('[data-testid="ctl"]').exists()).toBe(true)
  })

  it('has no full-bleed ground layer, floating panels or bottom cluster', () => {
    const w = mountVariant({})
    expect(w.find('[data-testid="studio-shell-preview-ground"]').exists()).toBe(false)
    expect(w.find('[data-testid="studio-shell-aside-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="studio-shell-controls-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="studio-shell-bottom-cluster"]').exists()).toBe(false)
    expect(w.find('[data-hidden]').exists()).toBe(false)
    expect(bodyOf(w).querySelector('.absolute')).toBe(null)
  })

  it('ignores ⌘\\ entirely — no panels to hide, nothing written to the session', async () => {
    const w = mountVariant({})
    await pressToggle(w)
    expect(classOf(bodyOf(w))).toBe(BOXED_BODY)
    expect(sessionStorage.getItem('sailor:studio:panels')).toBe(null)
  })
})

describe('StudioModalShell — full-bleed variant', () => {
  it('makes the preview the ground layer and floats both columns over it', () => {
    const w = mountVariant({ fullBleed: true })
    expect(classOf(bodyOf(w))).toContain('relative')
    const ground = w.get('[data-testid="studio-shell-preview-ground"]')
    expect(classOf(ground.element)).toContain('absolute inset-0')
    for (const id of ['studio-shell-aside-panel', 'studio-shell-controls-panel']) {
      const panel = w.get(`[data-testid="${id}"]`)
      expect(classOf(panel.element)).toContain('absolute')
      expect(classOf(panel.element)).toContain('w-72')
      expect(panel.attributes('data-hidden')).toBe('0')
    }
    // Same slot content, just relocated.
    expect(w.find('[data-testid="objects"]').exists()).toBe(true)
    expect(w.find('[data-testid="ctl"]').exists()).toBe(true)
  })

  it('floats the takes + agent cluster bottom-centre at the requested offset', () => {
    const calls: string[] = []
    const w = mountVariant({ fullBleed: true, fullBleedBottomOffset: 72 }, takeAgent(calls))
    const cluster = w.get('[data-testid="studio-shell-bottom-cluster"]')
    expect(cluster.attributes('style')).toContain('bottom: 72px')
    expect(classOf(cluster.element)).toContain('left-1/2')
    // The prompt rides in it, not in the flow under the preview.
    expect(cluster.findComponent({ name: 'StudioPromptHost' }).exists()).toBe(true)
  })

  it('defaults the offset to 16px', () => {
    const calls: string[] = []
    const w = mountVariant({ fullBleed: true }, takeAgent(calls))
    expect(w.get('[data-testid="studio-shell-bottom-cluster"]').attributes('style')).toContain('bottom: 16px')
  })

  it('⌘\\ hides both panels without unmounting their content, and remembers it', async () => {
    const w = mountVariant({ fullBleed: true })
    await pressToggle(w)
    const aside = w.get('[data-testid="studio-shell-aside-panel"]')
    const controls = w.get('[data-testid="studio-shell-controls-panel"]')
    expect(aside.attributes('data-hidden')).toBe('1')
    expect(controls.attributes('data-hidden')).toBe('1')
    // Slid out + click-through, never unmounted: scroll position and in-flight
    // edits survive, and the viewport does not reflow (the panels are absolute).
    expect(classOf(aside.element)).toContain('-translate-x-[130%]')
    expect(classOf(controls.element)).toContain('translate-x-[130%]')
    expect(classOf(aside.element)).toContain('pointer-events-none')
    expect(w.find('[data-testid="objects"]').exists()).toBe(true)
    expect(w.find('[data-testid="ctl"]').exists()).toBe(true)
    expect(sessionStorage.getItem('sailor:studio:panels')).toBe('0')

    await pressToggle(w)
    expect(w.get('[data-testid="studio-shell-aside-panel"]').attributes('data-hidden')).toBe('0')
    expect(sessionStorage.getItem('sailor:studio:panels')).toBe('1')
  })

  it('a studio reopened in the same session comes back with the panels hidden', async () => {
    sessionStorage.setItem('sailor:studio:panels', '0')
    const w = mountVariant({ fullBleed: true })
    await w.vm.$nextTick()   // the session preference is read in onMounted
    expect(w.get('[data-testid="studio-shell-aside-panel"]').attributes('data-hidden')).toBe('1')
  })

  it('still closes on Escape', async () => {
    const calls: string[] = []
    const w = mount(StudioModalShell, {
      props: { title: 'Studio', fullBleed: true },
      attrs: { onClose: () => calls.push('surface-close') },
      slots: { preview: '<div>preview</div>' },
    })
    await pressEscape(w)
    expect(calls).toEqual(['surface-close'])
  })
})
