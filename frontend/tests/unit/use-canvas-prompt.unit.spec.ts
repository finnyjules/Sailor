// frontend/tests/unit/use-canvas-prompt.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => null })
vi.mock('~/composables/useAiStatus', () => ({ useAiStatus: () => ({ aiAvailable: ref(true) }) }))
vi.mock('~/composables/useAgentActivity', () => ({ useAgentActivity: () => ({ thinking: ref(false), analyzingNodeIds: ref(new Set()) }) }))
const agent = {
  busy: ref(false), error: ref(''), reasoning: ref(''), answer: ref(''), changes: ref<any[]>([]), issues: ref([]),
  review: ref(null), reviewing: ref(false), reviewingManual: ref(false), hasProposal: ref(false), hovered: ref<number | null>(null),
  ask: vi.fn(), stop: vi.fn(), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(),
  keepAndRun: vi.fn(), reviewLastRun: vi.fn(), reviewNode: vi.fn(), autoReviewNode: vi.fn(), dismiss: vi.fn(),
}
let agentOpts: any = null
vi.mock('~/composables/useCanvasAgent', () => ({ useCanvasAgent: (o: any) => { agentOpts = o; return agent } }))

import { useCanvasPrompt } from '~/composables/useCanvasPrompt'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

function makeCanvas() {
  const nodes = reactive<any[]>([{
    id: 'img', type: 'artifact-image', selected: true,
    data: { title: 'Rainy shop', nodeType: 'Image', images: ['u0'], takes: [{ id: 't0', createdAt: 0, promptId: 'p0', images: ['u0'] }], activeTakeId: 't0' },
  }])
  const edges = reactive<any[]>([{ id: 'e1', source: 'gen', target: 'img' }])
  const c: any = {
    agentSnapshot: () => ({}), agentPreview: vi.fn(), agentCommit: vi.fn(() => []), agentDiscard: vi.fn(), agentHighlight: vi.fn(),
    agentClearSelection: vi.fn(), getNodes: () => nodes, getEdges: () => edges, startSketch: vi.fn(), agentNodeIntent: () => '',
    get agentSelection() { return nodes.filter(n => n.selected).map(n => ({ id: n.id, title: n.data.title, type: n.type, hasImages: true })) },
    agentNodeTakes: (id: string) => { const n = nodes.find(x => x.id === id); return n ? { takes: n.data.takes, activeTakeId: n.data.activeTakeId, images: n.data.images, error: !!n.data.error } : null },
    agentTakesBegin: vi.fn(), agentShowTake: vi.fn(), agentTakesEnd: vi.fn(), agentRevealNode: vi.fn(),
  }
  return { c, nodes }
}
const routeTo = (kind: string, followUps: string[] = []) => vi.fn(async () => ({ kind, followUps, routed: true })) as any

function setup(route = routeTo('plan')) {
  const { c, nodes } = makeCanvas()
  let api!: ReturnType<typeof useCanvasPrompt>
  const w = mount(defineComponent({ setup() { api = useCanvasPrompt(() => c, { route }); return () => h('div') } }))
  mounted.push(w)
  return { api, c, nodes, route, w }
}
const mounted: any[] = []
function capture(name: string) {
  const seen: any[] = []
  const f = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener(name, f)
  return { seen, off: () => window.removeEventListener(name, f) }
}
const land = (nodes: any[], id: string) => {
  const t = { id, createdAt: 1, promptId: `p-${id}`, images: [`u-${id}`] }
  nodes[0].data = { ...nodes[0].data, takes: [...nodes[0].data.takes, t], activeTakeId: id, images: t.images } // as appendTake writes it
}

describe('useCanvasPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agent.answer.value = ''; agent.error.value = ''; agent.busy.value = false; agent.hasProposal.value = false; agent.review.value = null
  })
  afterEach(() => { while (mounted.length) mounted.pop().unmount() })

  it('routes a request with the selection by name, then the planner answers; router follow-ups ride on the answer', async () => {
    const { api, route } = setup(routeTo('answer', ['Make it warmer']))
    await api.submit('what does this do?')
    expect(route).toHaveBeenCalledWith(
      { request: 'what does this do?', host: 'canvas', selection: [{ kind: 'artifact-image', name: 'Rainy shop' }], mode: null },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(agent.ask).toHaveBeenCalledWith('what does this do?')
    agent.answer.value = 'It doubles the size.'
    await nextTick()
    expect(api.card.value).toBe('answer')
    expect(api.answerCard.value).toEqual({ kind: 'answer', text: 'It doubles the size.', reasoning: '', followUps: ['Make it warmer'] })
  })

  it('a kind with no canvas worker shows a plain notice and never calls the planner', async () => {
    const { api } = setup(routeTo('new-effect'))
    await api.submit('make it rain on a window')
    expect(agent.ask).not.toHaveBeenCalled()
    expect(api.answerCard.value).toEqual({ kind: 'notice', text: DISPATCH_MESSAGES.newEffect, reasoning: '', followUps: [] })
  })

  it('a plain vary opens three takes on the image, runs Variations, and holds the node on its version as takes land', async () => {
    const { api, c, nodes } = setup(routeTo('tweak'))
    const runs = capture('sailor:runVariations')
    await api.submit('vary it')
    runs.off()
    expect(runs.seen).toEqual([{ nodeId: 'img', count: 3 }])
    expect(c.agentTakesBegin).toHaveBeenCalledWith('img')
    expect(api.card.value).toBe('takes')
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Making three takes of Rainy shop')
    land(nodes, 't1')
    await nextTick()
    expect(api.takes.value?.tiles[0]).toMatchObject({ state: 'ready', takeId: 't1' })
    expect(c.agentShowTake).toHaveBeenLastCalledWith('img', null)
    expect(c.agentRevealNode).toHaveBeenCalledWith('img')
  })

  it('hover previews on the node, Keep applies and closes', async () => {
    const { api, c, nodes } = setup(routeTo('tweak'))
    await api.submit('vary it')
    land(nodes, 't1'); await nextTick()
    api.previewTake('t1')
    expect(c.agentShowTake).toHaveBeenLastCalledWith('img', 't1')
    api.previewTake(null)
    expect(c.agentShowTake).toHaveBeenLastCalledWith('img', null)
    api.keepTake('t1')
    expect(c.agentTakesEnd).toHaveBeenCalledWith('img', 't1')
    expect(api.takes.value).toBeNull()
  })

  it('Stop while takes are pending cancels Variations and returns the node to its version', async () => {
    const { api, c } = setup(routeTo('tweak'))
    await api.submit('vary it')
    const stops = capture('sailor:stopVariations')
    api.stop()
    stops.off()
    expect(stops.seen).toEqual([{ nodeId: 'img' }])
    expect(c.agentTakesEnd).toHaveBeenCalledWith('img', null)
    expect(api.takes.value).toBeNull()
    expect(api.working.value).toBe(false)
  })

  it('fewer runs than asked marks the rest as not coming back and ends the working state', async () => {
    const { api, nodes } = setup(routeTo('tweak'))
    await api.submit('vary it')
    land(nodes, 't1'); await nextTick()
    window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId: 'img', queued: 1, cancelled: false } }))
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['ready', 'failed', 'failed'])
    expect(api.working.value).toBe(false)
  })

  it('a menu kind runs directly, without the router', async () => {
    const { api, route } = setup()
    window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: 'img', fromMenu: true } }))
    expect(route).not.toHaveBeenCalled()
    expect(api.takes.value?.nodeId).toBe('img')
  })

  it('a mode chip is set by the menu, focuses the prompt, is sent with the request, then cleared', async () => {
    const { api, route } = setup()
    window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label: 'Tune', kind: 'tweak', nodeId: 'img' } }))
    expect(api.mode.value).toEqual({ label: 'Tune', kind: 'tweak', nodeId: 'img' })
    expect(api.focusTick.value).toBe(1)
    await api.submit('more orange')
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ mode: 'Tune' }), expect.anything())
    expect(api.mode.value).toBeNull()
  })

  it('a mode clears when the selection moves to another node, and on clearMode', async () => {
    const { api, nodes } = setup()
    window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label: 'Tune', kind: 'tweak', nodeId: 'img' } }))
    nodes[0].selected = false
    nodes.push({ id: 'b', type: 'gradient-studio', selected: true, data: { title: 'Sky' } })
    await nextTick()
    expect(api.mode.value).toBeNull()
    window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label: 'Tune', kind: 'tweak', nodeId: 'b' } }))
    api.clearMode()
    expect(api.mode.value).toBeNull()
  })

  it('Stop while routing aborts it; the planner never runs', async () => {
    const route = vi.fn((_: any, o: any) => new Promise((_res, rej) => { o.signal.addEventListener('abort', () => rej(new Error('aborted'))) })) as any
    const { api } = setup(route)
    const p = api.submit('add an upscale step')
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Working on “add an upscale step”')
    api.stop()
    await p
    expect(agent.ask).not.toHaveBeenCalled()
    expect(api.working.value).toBe(false)
  })

  it('a clear image idea fires the sketch pad at once and skips the router; a plain vary never does', async () => {
    const { api, c, route } = setup()
    await api.submit('a red fox in the snow')
    expect(c.startSketch).toHaveBeenCalledWith('a red fox in the snow')
    expect(agent.ask).toHaveBeenCalledWith('a red fox in the snow')
    expect(route).not.toHaveBeenCalled()
    c.startSketch.mockClear()
    await api.submit('vary it')
    expect(c.startSketch).not.toHaveBeenCalled()
    expect(route).toHaveBeenCalledTimes(1)
  })

  it('while takes are arriving nothing new starts: not a submit, a menu item or a mode', async () => {
    const { api, route } = setup(routeTo('tweak'))
    await api.submit('vary it')
    const runs = capture('sailor:runVariations')
    const stops = capture('sailor:stopVariations')
    await api.submit('what does this do?')
    window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: 'img', fromMenu: true } }))
    window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label: 'Tune', kind: 'tweak', nodeId: 'img' } }))
    runs.off(); stops.off()
    expect(route).toHaveBeenCalledTimes(1)
    expect(runs.seen).toEqual([])
    expect(stops.seen).toEqual([])
    expect(api.mode.value).toBeNull()
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
  })

  it('Three more waits until the run behind the set has reported done', async () => {
    const { api, nodes } = setup(routeTo('tweak'))
    await api.submit('vary it')
    land(nodes, 't1'); await nextTick()
    land(nodes, 't2'); await nextTick()
    land(nodes, 't3'); await nextTick()
    expect(api.working.value).toBe(false)
    const runs = capture('sailor:runVariations')
    api.moreTakes()
    expect(runs.seen).toEqual([])
    expect(api.takes.value?.loopDone).toBe(false)
    window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId: 'img', queued: 3, cancelled: false } }))
    expect(api.takes.value?.loopDone).toBe(true)
    api.moreTakes()
    runs.off()
    expect(runs.seen).toEqual([{ nodeId: 'img', count: 3 }])
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
  })

  it('a render error fails the set early, but Three more still waits for the run to finish', async () => {
    const { api, nodes } = setup(routeTo('tweak'))
    await api.submit('vary it')
    nodes[0].data = { ...nodes[0].data, error: 'boom' }
    await nextTick()
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['failed', 'failed', 'failed'])
    const runs = capture('sailor:runVariations')
    api.moreTakes()
    expect(runs.seen).toEqual([])
    window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId: 'img', queued: 1, cancelled: false } }))
    api.moreTakes()
    runs.off()
    expect(runs.seen).toEqual([{ nodeId: 'img', count: 3 }])
  })

  it('a set opened while another Variations run is going waits for it, and that run’s done never settles the set', async () => {
    const { api } = setup(routeTo('tweak'))
    window.dispatchEvent(new CustomEvent('sailor:runVariations', { detail: { nodeId: 'img', count: 4 } })) // from the node's menu
    const runs = capture('sailor:runVariations')
    await api.submit('vary it')
    expect(runs.seen).toEqual([])
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId: 'img', queued: 0, cancelled: false } }))
    runs.off()
    expect(runs.seen).toEqual([{ nodeId: 'img', count: 3 }])
    expect(api.takes.value?.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(api.working.value).toBe(true)
  })

  it('a new request keeps an armed Keep & Run review: nothing on screen means no dismiss', async () => {
    const { api } = setup(routeTo('plan'))
    agent.keepAndRun() // approve and run: the proposal is gone, a review is armed
    await api.submit('add an upscale step')
    expect(agent.dismiss).not.toHaveBeenCalled()
    window.dispatchEvent(new CustomEvent('sailor:agentRunComplete'))
    expect(agent.reviewLastRun).toHaveBeenCalled()
    agent.answer.value = 'Done.'
    await api.submit('and another')
    expect(agent.dismiss).toHaveBeenCalledTimes(1)
  })

  it('a route that resolves after unmount starts nothing', async () => {
    let resolve!: (v: any) => void
    const route = vi.fn(() => new Promise(r => { resolve = r })) as any
    const { api, w } = setup(route)
    const p = api.submit('vary it')
    w.unmount(); mounted.length = 0
    const runs = capture('sailor:runVariations')
    resolve({ kind: 'tweak', followUps: [], routed: true })
    await p
    runs.off()
    expect(runs.seen).toEqual([])
    expect(agent.ask).not.toHaveBeenCalled()
  })

  it('takes on a node that has gone say so instead of doing nothing', async () => {
    const { api, c } = setup(routeTo('tweak'))
    c.agentNodeTakes = () => null
    await api.submit('vary it')
    expect(api.takes.value).toBeNull()
    expect(api.answerCard.value).toEqual({ kind: 'notice', text: 'That node isn’t on the canvas any more.', reasoning: '', followUps: [] })
  })

  it('a menu item clears the fast-path latch, so a later sketch from the planner still fires', async () => {
    const { api, c } = setup()
    await api.submit('a red fox in the snow') // fast path: latch set, the planner (mocked) never answers
    c.startSketch.mockClear()
    window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'plan', text: 'a cabin in the woods', fromMenu: true } }))
    agentOpts.sketchIdea('a cabin in the woods')
    expect(c.startSketch).toHaveBeenCalledWith('a cabin in the woods')
  })

  it('a proposal shows the changes card', async () => {
    const { api } = setup()
    agent.hasProposal.value = true
    await nextTick()
    expect(api.card.value).toBe('changes')
  })
})
