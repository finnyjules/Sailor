// frontend/tests/unit/use-studio-prompt.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'

const toastInfo = vi.hoisted(() => vi.fn())
vi.mock('vue-sonner', () => ({ toast: { info: toastInfo } }))

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })

import { useStudioPrompt, type StudioPromptWorker } from '~/composables/useStudioPrompt'
import { STUDIO_MESSAGES, VARY_REQUEST } from '~/lib/prompt/studioDispatch'
import { BUSY_NOTICE } from '~/lib/prompt/notices'

function makeWorker(withTakes = true) {
  const takes = shallowRef<any[]>([])
  const w: StudioPromptWorker = {
    busy: ref(false), error: ref(''), notice: ref(''), changes: ref([]), hovered: ref(null),
    hasProposal: computed(() => w.changes.value.length > 0) as any,
    review: ref(null), reviewing: ref(false),
    ask: vi.fn(async () => {}), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(), revert: vi.fn(),
  }
  if (withTakes) Object.assign(w, {
    takes, takeThumbs: shallowRef(new Map()), takeCurrentThumb: shallowRef(null), selectedTake: shallowRef(null),
    hasTakes: computed(() => takes.value.length > 0),
    previewTake: vi.fn(), selectTake: vi.fn(), keepTake: vi.fn(), dismissTakes: vi.fn(), abandonTakes: vi.fn(), moreDirections: vi.fn(),
  })
  return w
}

function setup(o: { worker?: StudioPromptWorker | null; place?: any; route?: any; label?: string } = {}) {
  const worker = o.worker === undefined ? makeWorker() : o.worker
  const route = o.route ?? vi.fn(async () => ({ kind: 'tweak', followUps: [], routed: true }))
  let api!: ReturnType<typeof useStudioPrompt>
  const wrapper = mount(defineComponent({ setup() {
    api = useStudioPrompt({ worker: () => worker, place: o.place ?? 'studio', selectionKind: 'shader-studio', label: () => o.label ?? 'Water ripple', suggestions: () => ['Warmer'] }, { route, apiKey: () => 'k' })
    return () => h('div')
  } }))
  return { api, worker, route, wrapper }
}

describe('useStudioPrompt', () => {
  it('routes with host studio and the thing’s own name, then hands the text to the worker', async () => {
    const { api, worker, route } = setup()
    await api.submit('warmer please')
    expect(route).toHaveBeenCalledWith(
      { request: 'warmer please', host: 'studio', selection: [{ kind: 'shader-studio', name: 'Water ripple' }], mode: null },
      expect.objectContaining({ apiKey: 'k' }),
    )
    expect(worker!.ask).toHaveBeenCalledWith('warmer please')
    expect(api.chipLabel.value).toBe('Water ripple')
  })

  it('frame routes with host frame', async () => {
    const { api, route } = setup({ place: 'frame' })
    await api.submit('shorter')
    expect(route.mock.calls[0][0].host).toBe('frame')
  })

  it('a kind with no worker shows a plain notice and never calls the worker', async () => {
    const { api, worker } = setup({ route: vi.fn(async () => ({ kind: 'new-effect', followUps: [], routed: true })) })
    await api.submit('rain on a window')
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(api.card.value).toBe('answer')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.newEffect })
  })

  it('3D with no worker answers with its message', async () => {
    const { api } = setup({ worker: null, place: 'scene3d' })
    await api.submit('make it glass')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.noWorker3d })
  })

  it('working quotes the request while the worker is busy', async () => {
    const { api, worker } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true })
    await api.submit('warmer')
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Working on “warmer”')
  })

  it('a worker notice with no result becomes an answer (with follow-ups) for kind answer', async () => {
    const { api, worker } = setup({ route: vi.fn(async () => ({ kind: 'answer', followUps: ['Lower warp'], routed: true })) })
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true; await Promise.resolve(); worker!.notice.value = 'Warp bends the ripples.'; worker!.busy.value = false })
    await api.submit('what does warp do?')
    await nextTick()
    expect(api.answerCard.value).toEqual({ kind: 'answer', text: 'Warp bends the ripples.', reasoning: '', followUps: ['Lower warp'] })
  })

  it('an error ends as an error card', async () => {
    const { api, worker } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true; await Promise.resolve(); worker!.error.value = 'Rate limited'; worker!.busy.value = false })
    await api.submit('x')
    await nextTick()
    expect(api.answerCard.value).toMatchObject({ kind: 'error', text: 'Rate limited' })
  })

  it('takes win over the other cards and map to PromptTakes', async () => {
    const { api, worker } = setup()
    worker!.takes!.value = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    await nextTick()
    expect(api.card.value).toBe('takes')
    expect(api.takes.value!.nodeLabel).toBe('Water ripple')
  })

  it('tile events drive the worker: hover previews, keep selects then keeps, × dismisses', async () => {
    const { api, worker } = setup()
    const t = [{ label: 'a' }, { label: 'b' }]
    worker!.takes!.value = t
    api.previewTake('take-1'); expect(worker!.previewTake).toHaveBeenLastCalledWith(t[1])
    api.previewTake(null); expect(worker!.previewTake).toHaveBeenLastCalledWith(null)
    api.chooseTake('take-0'); expect(worker!.selectTake).toHaveBeenLastCalledWith(t[0])
    api.keepTake('take-1'); expect(worker!.selectTake).toHaveBeenLastCalledWith(t[1]); expect(worker!.keepTake).toHaveBeenCalled()
    api.closeTakes(); expect(worker!.dismissTakes).toHaveBeenCalled()
    api.moreTakes(); expect(worker!.moreDirections).toHaveBeenCalled()
  })

  it('a proposal is the changes card; Approve keeps, Reject reverts', async () => {
    const { api, worker } = setup()
    worker!.changes.value = [{ command: { op: 'setParam' }, label: 'Warp', before: '1', after: '2', rationale: '', rerollable: true, accepted: true } as any]
    await nextTick()
    expect(api.card.value).toBe('changes')
    api.approve(); expect(worker!.keep).toHaveBeenCalled()
    api.rejectAll(); expect(worker!.revert).toHaveBeenCalled()
  })

  it('a mode chip decides the kind without routing; Tune goes to the worker', async () => {
    const { api, worker, route } = setup()
    api.setMode('Tune')
    expect(api.mode.value).toEqual({ label: 'Tune', kind: 'tweak' })
    await api.submit('slower')
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ mode: 'Tune' }), expect.anything())
    expect(worker!.ask).toHaveBeenCalledWith('slower')
    expect(api.mode.value).toBeNull()
  })

  it('Vary from the inspector skips the router and sends the fixed request', async () => {
    const { api, worker, route } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true })
    await api.runKind('tweak', { fromMenu: true })
    expect(route).not.toHaveBeenCalled()
    expect(worker!.ask).toHaveBeenCalledWith(VARY_REQUEST)
    expect(api.workingLabel.value).toBe('Making three takes of Water ripple')
  })

  it('Stop ends working at once, then throws away the stopped reply', async () => {
    const { api, worker } = setup()
    let finish!: () => void
    ;(worker!.ask as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.takes!.value = [{ label: 'late' }]; worker!.busy.value = false; r() } }) })
    const sent = api.submit('warmer')
    await nextTick()
    ;(worker!.abandonTakes as any).mockClear() // dispatch clears any open strip before asking
    api.stop()
    expect(api.working.value).toBe(false)
    expect(api.disabled.value).toBe(true) // until the stopped reply lands
    finish(); await sent; await nextTick()
    expect(worker!.abandonTakes).toHaveBeenCalled()
    expect(api.disabled.value).toBe(false)
  })

  it('Stop while routing aborts the route and never calls the worker', async () => {
    let seen: AbortSignal | undefined
    const route = vi.fn((_: any, o: any) => { seen = o.signal; return new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })
    const { api, worker } = setup({ route })
    const sent = api.submit('x')
    api.stop()
    await sent
    expect(seen?.aborted).toBe(true)
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(api.working.value).toBe(false)
  })

  it('a follow-up runs as a normal request', async () => {
    const { api, worker } = setup()
    await api.runFollowUp('Lower warp')
    expect(worker!.ask).toHaveBeenCalledWith('Lower warp')
  })
  // --- stage 3 review lessons, built in -----------------------------------------
  it('caps the router selection name at 120 characters', async () => {
    const { api, route } = setup({ label: 'x'.repeat(300) })
    await api.submit('warmer')
    expect(route.mock.calls[0][0].selection).toEqual([{ kind: 'shader-studio', name: 'x'.repeat(120) }])
  })

  it('takes still arriving count as busy: a submit waits, a menu item or mode chip says so', async () => {
    const { api, worker, route } = setup()
    worker!.takes!.value = [{ label: 'a' }, { label: 'b' }, { label: 'c' }] // no thumbs yet: pending
    await nextTick()
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Making three takes of Water ripple')
    expect(api.card.value).toBe('takes')
    toastInfo.mockClear()
    await api.submit('warmer')
    expect(route).not.toHaveBeenCalled()
    await api.runKind('tweak', { fromMenu: true })
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledTimes(1)
    api.setMode('Tune')
    expect(api.mode.value).toBeNull()
    expect(toastInfo).toHaveBeenCalledTimes(2)
  })

  it('a menu item while the worker is busy shows the busy notice and never calls it', async () => {
    const { api, worker } = setup()
    worker!.busy.value = true
    toastInfo.mockClear()
    await api.runKind('tweak', { fromMenu: true })
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledTimes(1)
  })

  it('Stop while takes are still arriving puts the original back', async () => {
    const { api, worker } = setup()
    worker!.takes!.value = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    await nextTick()
    api.stop()
    expect(worker!.abandonTakes).toHaveBeenCalled()
  })

  it('a stopped reply that proposes changes is reverted, and its error never shows', async () => {
    const { api, worker } = setup({ worker: makeWorker(false) })
    let finish!: () => void
    ;(worker!.ask as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.error.value = 'late'; worker!.changes.value = [{} as any]; worker!.busy.value = false; r() } }) })
    const sent = api.submit('warmer')
    await nextTick()
    api.stop()
    finish(); await sent; await nextTick()
    expect(worker!.revert).toHaveBeenCalled()
    expect(api.answerCard.value).toBeNull()
  })

  it('× on the strip while a re-roll is out drops the late strip', async () => {
    const { api, worker } = setup()
    worker!.busy.value = true
    await nextTick()
    api.closeTakes()
    worker!.takes!.value = [{ label: 'late' }]
    worker!.busy.value = false
    await nextTick()
    expect(worker!.abandonTakes).toHaveBeenCalled()
  })

  it('unmounting aborts an in-flight route', async () => {
    let seen: AbortSignal | undefined
    const route = vi.fn((_: any, o: any) => { seen = o.signal; return new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })
    const { api, worker, wrapper } = setup({ route })
    const sent = api.submit('x')
    wrapper.unmount()
    await sent
    expect(seen?.aborted).toBe(true)
    expect(worker!.ask).not.toHaveBeenCalled()
  })
  it('Stop waits out a visual review still running: revert only after it ends, and no card comes back', async () => {
    const { api, worker } = setup({ worker: makeWorker(false) })
    let finish!: () => void
    ;(worker!.ask as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.changes.value = [{} as any]; worker!.reviewing.value = true; worker!.busy.value = false; r() } }) })
    const sent = api.submit('warmer')
    await nextTick()
    api.stop()
    finish(); await sent; await nextTick()
    expect(worker!.revert).not.toHaveBeenCalled() // the review is still out
    expect(api.disabled.value).toBe(true)
    expect(api.card.value).toBeNull()
    worker!.changes.value = [{} as any, {} as any] // the late review appends its fixes
    worker!.reviewing.value = false
    await nextTick()
    expect(worker!.revert).toHaveBeenCalledTimes(1)
    worker!.changes.value = [] // what revert() does in the workers
    await nextTick()
    expect(api.card.value).toBeNull()
    expect(api.disabled.value).toBe(false)
  })

  it('Stop during a re-roll holds until its call settles, even if busy flips off and on in one tick', async () => {
    const { api, worker } = setup()
    worker!.takes!.value = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    worker!.takeThumbs!.value = new Map(worker!.takes!.value.map(t => [t, 'data:x']))
    let finish!: () => void
    ;(worker!.moreDirections as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.busy.value = false; r() } }) })
    api.moreTakes()
    await nextTick()
    api.stop()
    ;(worker!.abandonTakes as any).mockClear()
    worker!.busy.value = false; worker!.busy.value = true // compose fell back to the direct path
    await nextTick()
    expect(worker!.abandonTakes).not.toHaveBeenCalled()
    expect(api.disabled.value).toBe(true)
    worker!.takes!.value = [{ label: 'late' }]
    finish(); await Promise.resolve(); await nextTick()
    expect(worker!.abandonTakes).toHaveBeenCalledTimes(1)
    expect(api.disabled.value).toBe(false)
  })

  it('the busy notice is the shared one', async () => {
    const { api, worker } = setup()
    worker!.busy.value = true
    toastInfo.mockClear()
    api.setMode('Tune')
    expect(toastInfo).toHaveBeenCalledWith(BUSY_NOTICE)
  })
})
