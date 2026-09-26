// frontend/tests/unit/canvas-prompt-effects.unit.spec.ts
// @vitest-environment happy-dom
// useCanvasPrompt hands new-effect to the effect session with a target built from
// the shader node; the takes card, working label, Stop and Keep all go through it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h, shallowRef, ref, computed } from 'vue'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { toast } from 'vue-sonner'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })
;(globalThis as any).useRuntimeConfig = () => ({ public: { hostedMode: false } })
// The same agent-side mocks as use-canvas-prompt.unit.spec.ts (preflight C8).
vi.mock('~/composables/useAiStatus', () => ({ useAiStatus: () => ({ aiAvailable: ref(true) }) }))
vi.mock('vue-sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('~/composables/useAgentActivity', () => ({ useAgentActivity: () => ({ thinking: ref(false), analyzingNodeIds: ref(new Set()) }) }))
const agent = {
  busy: ref(false), error: ref(''), reasoning: ref(''), answer: ref(''), changes: ref<any[]>([]), issues: ref([]),
  review: ref(null), reviewing: ref(false), reviewingManual: ref(false), hasProposal: ref(false), hovered: ref<number | null>(null),
  ask: vi.fn(), stop: vi.fn(), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(),
  keepAndRun: vi.fn(), reviewLastRun: vi.fn(), reviewNode: vi.fn(), autoReviewNode: vi.fn(), dismiss: vi.fn(),
}
vi.mock('~/composables/useCanvasAgent', () => ({ useCanvasAgent: () => agent }))
vi.mock('~/lib/shaderfx/catalogStore', async orig => ({
  ...(await orig<any>()),
  getEffectSync: (id: string) => ({ id, name: id === 'glow_soft' ? 'Soft glow' : 'Water ripple', params: [], source: '' }),
}))

import { useCanvasPrompt } from '~/composables/useCanvasPrompt'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'
import { BUSY_NOTICE } from '~/lib/prompt/notices'
import { REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'

function fakeEffects() {
  const session = shallowRef<any>(null)
  const running = ref(false)
  return {
    session, target: shallowRef(null), request: ref(''), reference: ref<string | null>(null), working: computed(() => running.value), running, error: ref(''), notice: ref(''), saving: ref(false),
    start: vi.fn(async (_r: string, t: any) => { session.value = { nodeId: t.key, nodeLabel: t.label, request: _r, tiles: [], known: [], hovered: null, chosen: null, currentThumb: null } }),
    preview: vi.fn(), keep: vi.fn(async () => true), close: vi.fn(() => { session.value = null }), more: vi.fn(), stop: vi.fn(), clearMessages: vi.fn(),
  }
}
function fakeCanvas() {
  const node = { id: 's1', type: 'shader-effect', data: { title: 'Water ripple' } }
  // Reactive, as VueNodeCanvas's getNodes() (its Vue Flow nodes ref) is.
  const nodes = ref<any[]>([node, { id: 'other', type: 'artifact-image', data: {} }])
  const sel = ref<any[]>([{ id: 's1', title: 'Water ripple', type: 'shader-effect', hasImages: false }])
  return {
    agentSnapshot: vi.fn(), agentPreview: vi.fn(),
    get agentSelection() { return sel.value },
    getNodes: () => nodes.value, getEdges: () => [], nodes, sel,
  }
}

const offs: (() => void)[] = []
function listen(name: string, f: (e: any) => void) { window.addEventListener(name, f); offs.push(() => window.removeEventListener(name, f)) }
const mounted: any[] = []
function setup(o: { route?: any; reply?: boolean } = {}) {
  const effects = fakeEffects()
  const route = o.route ?? vi.fn()
  const replies: any[] = []
  if (o.reply !== false) listen('sailor:shaderEffectTarget', e => e.detail.reply({ image: null, effectId: 'water_ripple', title: 'Water ripple' }))
  listen('sailor:shaderEffectPreview', e => replies.push(['preview', e.detail]))
  listen('sailor:shaderEffectApply', e => replies.push(['apply', e.detail]))
  let api!: ReturnType<typeof useCanvasPrompt>
  const c = fakeCanvas()
  mounted.push(mount(defineComponent({ setup() { api = useCanvasPrompt(() => c, { route, effects: effects as any }); return () => h('div') } })))
  return { api, effects, route, replies, canvas: c }
}
const setMode = (detail: object) => window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail }))

describe('useCanvasPrompt: new effects on a shader node', () => {
  afterEach(() => {
    while (offs.length) offs.pop()!()
    while (mounted.length) mounted.pop().unmount()
    agent.error.value = ''; agent.answer.value = ''
  })

  it('a Remix chip runs the effect session against the node, without the router', async () => {
    const { api, effects, route, replies } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    expect(api.modeNote.value).toBe('48–88 credits')
    await api.submit('rain on a window')
    expect(route).not.toHaveBeenCalled() // the chip decides the kind (spec §4)
    expect(effects.start).toHaveBeenCalledWith('rain on a window', expect.objectContaining({ key: 's1', label: 'Water ripple' }))
    const t = effects.start.mock.calls[0]![1]
    expect(t.base?.id).toBe('water_ripple') // the node's own effect is the base
    expect(t.remix).toBe(true) // the Remix chip: Keep may add a version to a My effect
    expect(t.image()).toBeNull()
    t.preview('draft_1_0')
    expect(replies.at(-1)).toEqual(['preview', { nodeId: 's1', effectId: 'draft_1_0' }])
    t.apply('mine_x@2', { u_amount: 0.5 })
    expect(replies.at(-1)).toEqual(['apply', { nodeId: 's1', effectId: 'mine_x@2', values: { u_amount: 0.5 } }])
    expect(api.modeNote.value).toBeNull() // the chip is spent
    expect(api.card.value).toBe('takes')
    expect(api.takes.value!.nodeId).toBe('s1')
    api.previewTake('draft_1_0'); expect(effects.preview).toHaveBeenCalledWith('draft_1_0')
    await api.keepTake('draft_1_0'); expect(effects.keep).toHaveBeenCalledWith('draft_1_0')
    expect(api.takesSaving.value).toBe(false)
    effects.saving.value = true
    expect(api.takesSaving.value).toBe(true) // the strip's Keep is off while it saves
    expect(api.takesError.value).toBeNull()
    effects.error.value = 'Couldn’t save to My effects. Try again in a moment.'
    expect(api.card.value).toBe('takes') // the set stays open…
    expect(api.takesError.value).toBe('Couldn’t save to My effects. Try again in a moment.') // …and the strip says why
    api.stop(); expect(effects.stop).toHaveBeenCalled()
    expect(agent.stop).not.toHaveBeenCalled()
  })

  it('a gallery Remix of ANOTHER effect uses that effect as the base', async () => {
    const { api, effects, route } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1', effectId: 'glow_soft' })
    expect(api.mode.value?.effectId).toBe('glow_soft')
    await api.submit('softer, with rain')
    expect(route).not.toHaveBeenCalled()
    const t = effects.start.mock.calls[0]![1]
    expect(t.base).toEqual(expect.objectContaining({ id: 'glow_soft', name: 'Soft glow' }))
    expect(t.key).toBe('s1')
  })

  it('a New effect chip starts from nothing', async () => {
    const { api, effects } = setup()
    setMode({ label: 'New effect', kind: 'new-effect', nodeId: 's1' })
    expect(api.modeNote.value).toBe('48–88 credits')
    await api.submit('rain on a window')
    expect(effects.start.mock.calls[0]![1].base).toBeNull()
    expect(effects.start.mock.calls[0]![1].remix).toBe(false)
  })

  it('a routed new-effect on a selected shader node starts from its own effect, but makes a NEW one (Ruling #2)', async () => {
    const route = vi.fn(async () => ({ kind: 'new-effect', followUps: [], routed: true }))
    const { api, effects } = setup({ route })
    await api.submit('make it rain')
    expect(route).toHaveBeenCalled()
    expect(effects.start).toHaveBeenCalledWith('make it rain', expect.objectContaining({ key: 's1' }))
    expect(effects.start.mock.calls[0]![1].base?.id).toBe('water_ripple')
    // No Remix chip: Keep saves a new My effect "from" it, never a version of it (useEffectTakes).
    expect(effects.start.mock.calls[0]![1].remix).toBe(false)
  })

  it('a node that does not answer gets the plain message instead', async () => {
    const { api, effects } = setup({ reply: false })
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    expect(effects.start).not.toHaveBeenCalled()
    expect(api.answerCard.value).toEqual({ kind: 'notice', text: DISPATCH_MESSAGES.newEffect, reasoning: '', followUps: [] })
  })

  it('while the takes are written the prompt quotes the request with the price, and nothing else can start', async () => {
    const { api, effects, route } = setup()
    effects.request.value = 'rain on a window'
    effects.running.value = true
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Working on “rain on a window” · 48–88 credits')
    await api.submit('something else')
    expect(route).not.toHaveBeenCalled()
    api.stop()
    expect(effects.stop).toHaveBeenCalled()
  })

  it('the session’s error and notice show as cards; dismissing clears them', async () => {
    const { api, effects } = setup()
    effects.error.value = 'Sailor couldn’t write new effects just now. Try again in a moment.'
    expect(api.card.value).toBe('answer')
    expect(api.answerCard.value).toEqual({ kind: 'error', text: effects.error.value, reasoning: '', followUps: [] })
    effects.error.value = ''
    effects.notice.value = 'Saved to My effects as “Rain”.'
    expect(api.answerCard.value).toEqual({ kind: 'notice', text: 'Saved to My effects as “Rain”.', reasoning: '', followUps: [] })
    api.dismissAnswer()
    expect(effects.clearMessages).toHaveBeenCalled()
  })

  it('the node is told its strip is open (controls read-only) and when it closes', async () => {
    const locks: any[] = []
    listen('sailor:shaderEffectLock', e => locks.push(e.detail))
    const { api, effects } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    expect(locks).toEqual([{ nodeId: 's1', locked: true }])
    api.closeTakes()
    expect(effects.close).toHaveBeenCalled()
    expect(locks).toEqual([{ nodeId: 's1', locked: true }, { nodeId: 's1', locked: false }])
  })

  it('an open strip is let go when the prompt unmounts', async () => {
    const locks: any[] = []
    listen('sailor:shaderEffectLock', e => locks.push(e.detail))
    const { api } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    mounted.pop().unmount()
    expect(locks.at(-1)).toEqual({ nodeId: 's1', locked: false })
  })

  it('while a Keep is saving, a new request or chip waits: the strip is not closed, so the kept effect is still applied', async () => {
    const route = vi.fn(async () => ({ kind: 'answer', followUps: [], routed: true }))
    const { api, effects } = setup({ route })
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    effects.saving.value = true
    const cleared = effects.clearMessages.mock.calls.length
    await api.submit('what does this do?')
    setMode({ label: 'New effect', kind: 'new-effect', nodeId: 's1' })
    expect(route).not.toHaveBeenCalled()
    expect(effects.close).not.toHaveBeenCalled()
    expect(effects.clearMessages).toHaveBeenCalledTimes(cleared) // nothing was cleared either
    expect(api.mode.value).toBeNull()
    effects.saving.value = false
    await api.submit('what does this do?')
    expect(route).toHaveBeenCalled()
  })

  it('a new request closes an open effect set', async () => {
    const route = vi.fn(async () => ({ kind: 'answer', followUps: [], routed: true }))
    const { api, effects } = setup({ route })
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    expect(api.card.value).toBe('takes')
    await api.submit('what does this do?')
    expect(effects.close).toHaveBeenCalled()
    expect(api.takes.value).toBeNull()
  })

  it('deleting the node an effect set previews on ends the set (nothing more is billed, no Keep lands nowhere)', async () => {
    const { api, effects, canvas } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    effects.running.value = true
    // Another node going leaves the set alone.
    canvas.nodes.value = canvas.nodes.value.filter((n: any) => n.id !== 'other'); await nextTick()
    expect(effects.close).not.toHaveBeenCalled()
    canvas.nodes.value = []; await nextTick()
    expect(effects.close).toHaveBeenCalledTimes(1)
    expect(api.takes.value).toBeNull()
  })

  it('"Three more" on an effect set carries the price; nothing when no effect set is open', async () => {
    const { api } = setup()
    expect(api.takesMoreNote.value).toBeNull()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    expect(api.takesMoreNote.value).toBe('48–88 credits')
  })

  it('Make one / Remix mid-job says why nothing happens (the studios’ busy toast)', async () => {
    const { api, effects } = setup()
    setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
    await api.submit('rain')
    effects.running.value = true
    vi.mocked(toast.info).mockClear()
    setMode({ label: 'New effect', kind: 'new-effect', nodeId: 's1' })
    expect(toast.info).toHaveBeenCalledWith(BUSY_NOTICE)
    expect(api.mode.value).toBeNull()
  })
  describe('a reference picture', () => {
    const REF = 'data:image/jpeg;base64,REF'
    it('a selected shader node takes one: New effect on that node, the higher price, and the picture goes with the request', async () => {
      const { api, effects, route } = setup()
      expect(api.acceptsReference.value).toBe(true)
      api.attachReference(REF)
      expect(api.mode.value).toMatchObject({ label: 'New effect', kind: 'new-effect', nodeId: 's1' })
      expect(api.modeNote.value).toBe('51–88 credits')
      await api.submit('')
      expect(route).not.toHaveBeenCalled()
      expect(effects.start).toHaveBeenCalledWith(REFERENCE_ONLY_REQUEST, expect.objectContaining({ key: 's1', base: null }), { reference: REF })
    })
    it('Remix already set stays Remix', () => {
      const { api } = setup()
      setMode({ label: 'Remix', kind: 'new-effect', nodeId: 's1' })
      api.attachReference(REF)
      expect(api.mode.value?.label).toBe('Remix')
    })
    it('anything but one shader node ignores a picture (a plain image node stays as today)', async () => {
      const { api, canvas } = setup()
      canvas.sel.value = [{ id: 'other', title: 'Image', type: 'artifact-image', hasImages: true }]
      await nextTick()
      expect(api.acceptsReference.value).toBe(false)
      api.attachReference(REF)
      expect(api.reference.value).toBeNull()
      expect(api.mode.value).toBeNull()
    })
    it('selecting something else drops the picture, as it drops the mode', async () => {
      const { api, canvas } = setup()
      api.attachReference(REF)
      canvas.sel.value = [{ id: 'other', title: 'Image', type: 'artifact-image', hasImages: true }]
      await nextTick()
      expect(api.reference.value).toBeNull()
    })
    it('× on the set clears it from the prompt', async () => {
      const { api } = setup()
      api.attachReference(REF); await api.submit('slower')
      api.closeTakes()
      expect(api.reference.value).toBeNull()
    })
  })
})
