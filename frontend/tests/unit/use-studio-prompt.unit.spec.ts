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
import { REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'

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

/** The effect-takes session (Task 7's useEffectTakes), idle until started — the same shape as
 *  canvas-prompt-effects' fake. Every setup gets one (preflight C8: never build the real one here). */
function fakeEffects() {
  const session = shallowRef<any>(null)
  const running = ref(false)
  const request = ref('')
  const reference = ref<string | null>(null)
  return {
    session, target: shallowRef<any>(null), request, reference, working: computed(() => running.value), running, error: ref(''), notice: ref(''), saving: ref(false),
    start: vi.fn(async (r: string, t: any, o?: { reference?: string | null }) => { request.value = r; reference.value = o?.reference ?? null; session.value = { nodeId: t.key, nodeLabel: t.label, request: r, tiles: [], known: [], hovered: null, chosen: null, currentThumb: null } }),
    preview: vi.fn(), choose: vi.fn(), keep: vi.fn(async () => true), close: vi.fn(() => { session.value = null; running.value = false }),
    more: vi.fn(), stop: vi.fn(() => { session.value = null; running.value = false }), clearMessages: vi.fn(),
  }
}

function setup(o: {
  worker?: StudioPromptWorker | null; place?: any; route?: any; label?: string
  effectTarget?: any; effects?: ReturnType<typeof fakeEffects>; afterKeep?: (r: string) => void; takesReference?: () => boolean
} = {}) {
  const worker = o.worker === undefined ? makeWorker() : o.worker
  const route = o.route ?? vi.fn(async () => ({ kind: 'tweak', followUps: [], routed: true }))
  const effects = o.effects ?? fakeEffects()
  let api!: ReturnType<typeof useStudioPrompt>
  const wrapper = mount(defineComponent({ setup() {
    api = useStudioPrompt({
      worker: () => worker, place: o.place ?? 'studio', selectionKind: 'shader-studio', label: () => o.label ?? 'Water ripple', suggestions: () => ['Warmer'],
      effectTarget: o.effectTarget, afterKeep: o.afterKeep, takesReference: o.takesReference,
    }, { route, apiKey: () => 'k', effects: effects as any })
    return () => h('div')
  } }))
  return { api, worker, route, wrapper, effects }
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

  it('3D with no worker answers with its message, without paying for a route call', async () => {
    const { api, route } = setup({ worker: null, place: 'scene3d' })
    await api.submit('make it glass')
    expect(route).not.toHaveBeenCalled()
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.noWorker3d })
    expect(api.working.value).toBe(false)
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
    expect(api.mode.value).toEqual({ label: 'Tune', kind: 'tweak', effectId: null, add: false })
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

  it('editing is locked while a run is out and while a stopped reply is awaited, with a note quoting the request', async () => {
    const { api, worker } = setup()
    expect(api.editLocked.value).toBe(false)
    let finish!: () => void
    ;(worker!.ask as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.busy.value = false; r() } }) })
    const sent = api.submit('tighten   the layout')
    expect(api.editLocked.value).toBe(true) // routing
    await nextTick()
    expect(api.working.value).toBe(true)
    expect(api.editLocked.value).toBe(true) // worker busy
    expect(api.lockedNote.value).toBe('Sailor is working on “tighten the layout”…')
    api.stop()
    expect(api.working.value).toBe(false)
    expect(api.disabled.value).toBe(true)
    expect(api.editLocked.value).toBe(true) // the late reply would push the old snapshot back
    finish(); await sent; await nextTick()
    expect(api.editLocked.value).toBe(false)
  })

  it('the lock holds while the review is out and while the proposal is open, and ends on Approve or Reject', async () => {
    const { api, worker } = setup({ worker: makeWorker(false) })
    ;(worker!.ask as any).mockImplementation(async () => {
      worker!.changes.value = [{ label: 'Tighter' } as any]
      worker!.reviewing.value = true // the visual review fires without waiting
    })
    ;(worker!.keep as any).mockImplementation(() => { worker!.changes.value = [] })
    ;(worker!.revert as any).mockImplementation(() => { worker!.changes.value = [] })
    await api.submit('tighten')
    expect(api.working.value).toBe(false)
    expect(api.card.value).toBe('changes') // the card (its toggles, Approve, Reject) is shown
    expect(api.editLocked.value).toBe(true) // the review rebuilds from the snapshot when it lands
    expect(api.lockedNote.value).toBe('Sailor is looking at the result…')
    worker!.reviewing.value = false
    expect(api.editLocked.value).toBe(true) // a row toggle, re-roll or Reject rebuilds from it too
    expect(api.lockedNote.value).toBe('Approve or reject the changes to keep editing')
    api.approve()
    expect(api.editLocked.value).toBe(false)
    await api.submit('again')
    expect(api.editLocked.value).toBe(true)
    worker!.reviewing.value = false
    api.rejectAll()
    expect(api.editLocked.value).toBe(false)
  })

  // --- effect takes (stage 5 Task 9) -------------------------------------------
  const shaderTarget = () => ({ key: 'shader-studio', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() })

  it('Remix sets a chip with its price; sending runs the effect session with the studio’s target, no router', async () => {
    const effects = fakeEffects()
    const targetFn = vi.fn(() => ({ key: 'shader-studio', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() }))
    const { api, route } = setup({ effectTarget: targetFn, effects })
    api.setMode('Remix')
    expect(api.modeNote.value).toBe('~$0.24–0.42')
    await api.submit('rain on a window')
    expect(route).not.toHaveBeenCalled()
    expect(targetFn).toHaveBeenCalledWith({ effectId: null, add: false, fresh: false, remix: true })
    expect(effects.start).toHaveBeenCalledWith('rain on a window', expect.objectContaining({ key: 'shader-studio' }))
    expect(api.card.value).toBe('takes')
  })
  it('New layer from a description: add, fresh', async () => {
    const effects = fakeEffects(); const targetFn = vi.fn(() => null as any)
    const { api } = setup({ effectTarget: targetFn, effects })
    api.setMode('New effect', { add: true })
    await api.submit('rain')
    expect(targetFn).toHaveBeenCalledWith({ effectId: null, add: true, fresh: true, remix: false })
  })
  it('a gallery Remix passes the effect it starts from', async () => {
    const effects = fakeEffects(); const targetFn = vi.fn(shaderTarget)
    const { api } = setup({ effectTarget: targetFn, effects })
    api.setMode('Remix', { effectId: 'glow_soft' })
    await api.submit('rain')
    expect(targetFn).toHaveBeenCalledWith({ effectId: 'glow_soft', add: false, fresh: false, remix: true })
  })
  it('a routed new-effect (no chip) asks for the default target', async () => {
    const effects = fakeEffects(); const targetFn = vi.fn(() => ({ key: 'k', label: 'x', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() }))
    const { api } = setup({ effectTarget: targetFn, effects, route: vi.fn(async () => ({ kind: 'new-effect', followUps: [], routed: true })) })
    await api.submit('make it rain')
    expect(targetFn).toHaveBeenCalledWith(null)
    expect(effects.start).toHaveBeenCalled()
  })
  it('a studio with no target still answers new-effect with the plain message', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(() => null), effects })
    api.setMode('Remix')
    await api.submit('rain')
    expect(effects.start).not.toHaveBeenCalled()
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.newEffect })
  })
  it('keeping a worker take calls afterKeep with the request', async () => {
    const afterKeep = vi.fn()
    const { api, worker } = setup({ afterKeep })
    await api.submit('warmer')
    ;(worker!.takes as any).value = [{ label: 'a' }]
    api.keepTake('take-0')
    expect(afterKeep).toHaveBeenCalledWith('warmer')
  })
  it('effect takes own the strip, Stop and the working label while they run', async () => {
    const effects = fakeEffects()
    const { api, worker } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    effects.running.value = true
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toContain('“rain”')
    expect(api.workingLabel.value).toContain('~$0.24–0.42')
    // one job at a time: a new request waits
    await api.submit('warmer')
    expect(worker!.ask).not.toHaveBeenCalled()
    api.stop()
    expect(effects.stop).toHaveBeenCalled()
    expect(api.working.value).toBe(false)
  })
  it('tile events go to the open effect set, not the worker', async () => {
    const effects = fakeEffects()
    const { api, worker } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    api.previewTake('draft_1_0'); expect(effects.preview).toHaveBeenCalledWith('draft_1_0')
    api.chooseTake('draft_1_0'); expect(effects.choose).toHaveBeenCalledWith('draft_1_0')
    api.moreTakes(); expect(effects.more).toHaveBeenCalled()
    await api.keepTake('draft_1_0'); expect(effects.keep).toHaveBeenCalledWith('draft_1_0')
    api.closeTakes(); expect(effects.close).toHaveBeenCalled()
    expect(worker!.previewTake).not.toHaveBeenCalled()
    expect(worker!.keepTake).not.toHaveBeenCalled()
  })
  it('an effect Keep that is saving turns the strip’s Keep off', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    expect(api.takesSaving.value).toBe(false)
    effects.saving.value = true
    expect(api.takesSaving.value).toBe(true)
    // A new request waits for the save (closing the strip first would skip applying it).
    const worker = api.worker()!
    await api.submit('warmer')
    expect(worker.ask).not.toHaveBeenCalled()
  })
  it('effect errors and notices are cards; dismissing clears them', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effects })
    effects.notice.value = 'Saved to My effects as “Rain”.'
    expect(api.card.value).toBe('answer')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: 'Saved to My effects as “Rain”.' })
    effects.error.value = 'Sailor couldn’t write new effects just now. Try again in a moment.'
    expect(api.answerCard.value).toMatchObject({ kind: 'error' })
    api.dismissAnswer()
    expect(effects.clearMessages).toHaveBeenCalled()
  })
  it('a new request closes an open effect set first (its preview never reaches the worker)', async () => {
    const effects = fakeEffects()
    const { api, worker } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    expect(api.card.value).toBe('takes')
    await api.submit('warmer')
    expect(effects.close).toHaveBeenCalled()
    expect(worker!.ask).toHaveBeenCalledWith('warmer')
  })
  it('closing the studio ends the effect set (endEffects), so a previewed draft is never saved', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    api.endEffects()
    expect(effects.close).toHaveBeenCalled()
    expect(api.card.value).toBe(null)
  })
  it('an open effect set locks Frame’s editing until it is kept or closed', async () => {
    const effects = fakeEffects()
    const { api } = setup({ place: 'frame', effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    expect(api.working.value).toBe(false)
    expect(api.editLocked.value).toBe(true)
    expect(api.lockedNote.value).toBe('Keep a take or close the takes to keep editing')
    api.closeTakes()
    expect(api.editLocked.value).toBe(false)
  })
  it('new effects wait while a proposal is open (Reject would rebuild over the kept effect)', async () => {
    const effects = fakeEffects()
    const { api, worker } = setup({ worker: makeWorker(false), place: 'frame', effectTarget: vi.fn(shaderTarget), effects })
    ;(worker!.ask as any).mockImplementation(async () => { worker!.changes.value = [{ label: 'Tighter' } as any] })
    await api.submit('tighten')
    expect(api.card.value).toBe('changes')
    toastInfo.mockClear()
    api.setMode('Remix')
    await api.submit('rain')
    expect(effects.start).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith(BUSY_NOTICE)
    expect(api.card.value).toBe('changes')
  })
  it('effectsOpen follows the session: on while a set is open, off however it ends', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    expect(api.effectsOpen.value).toBe(false)
    api.setMode('Remix'); await api.submit('rain')
    expect(api.effectsOpen.value).toBe(true)
    api.closeTakes()
    expect(api.effectsOpen.value).toBe(false)
    api.setMode('Remix'); await api.submit('rain')
    api.stop()
    expect(api.effectsOpen.value).toBe(false)
    api.setMode('Remix'); await api.submit('rain')
    await api.submit('warmer') // a new request closes the set
    expect(api.effectsOpen.value).toBe(false)
  })
  it('a failed Keep shows on the strip while the set stays open; notify shows the owner’s sentence', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix'); await api.submit('rain')
    effects.error.value = 'Couldn’t save to My effects. Try again in a moment.'
    expect(api.card.value).toBe('takes')
    expect(api.takesError.value).toBe('Couldn’t save to My effects. Try again in a moment.')
    api.closeTakes(); effects.error.value = ''
    expect(api.takesError.value).toBeNull()
    api.notify('notice', 'Saved as v2 of “Rain”. Earlier versions are kept.')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: 'Saved as v2 of “Rain”. Earlier versions are kept.' })
  })
  it('a target that refuses with a sentence shows it, and starts nothing', async () => {
    const effects = fakeEffects()
    const { api } = setup({ effectTarget: vi.fn(() => 'The studio holds six layers. Remove one to add another.'), effects })
    api.setMode('New effect', { add: true }); await api.submit('rain')
    expect(effects.start).not.toHaveBeenCalled()
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: 'The studio holds six layers. Remove one to add another.' })
  })
  it('Vary (no words) never calls afterKeep; a typed request does', async () => {
    const afterKeep = vi.fn()
    const { api, worker } = setup({ afterKeep })
    await api.runKind('tweak', { fromMenu: true })
    ;(worker!.takes as any).value = [{ label: 'a' }]
    api.keepTake('take-0')
    expect(afterKeep).not.toHaveBeenCalled()
  })
  it('unmounting closes an open effect set', async () => {
    const effects = fakeEffects()
    const { api, wrapper } = setup({ effectTarget: vi.fn(shaderTarget), effects })
    api.setMode('Remix')
    await api.submit('rain')
    wrapper.unmount()
    expect(effects.close).toHaveBeenCalled()
  })
  // --- a reference picture (stage 5 follow-up) ----------------------------------
  describe('a reference picture', () => {
    const REF = 'data:image/jpeg;base64,REF'
    const shaderTarget2 = () => ({ key: 'shader-studio', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() })
    it('attaching one with no mode sets New effect, and the note shows the higher price', () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2) })
      expect(api.acceptsReference.value).toBe(true)
      api.attachReference(REF)
      expect(api.reference.value).toBe(REF)
      expect(api.mode.value).toMatchObject({ label: 'New effect', kind: 'new-effect' })
      expect(api.modeNote.value).toBe('~$0.24–0.43')
    })
    it('Remix already set stays Remix', () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2) })
      api.setMode('Remix')
      api.attachReference(REF)
      expect(api.mode.value?.label).toBe('Remix')
    })
    it('clearing the mode keeps the picture; clearing the picture keeps the mode', () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2) })
      api.attachReference(REF)
      api.clearMode()
      expect(api.reference.value).toBe(REF)
      api.setMode('Remix')
      api.clearReference()
      expect(api.reference.value).toBeNull()
      expect(api.mode.value?.label).toBe('Remix')
    })
    it('a second picture replaces the first', () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2) })
      api.attachReference(REF); api.attachReference('data:image/jpeg;base64,TWO')
      expect(api.reference.value).toBe('data:image/jpeg;base64,TWO')
    })
    it('sending runs the effect set with the picture, and no words ask to match its look', async () => {
      const effects = fakeEffects()
      const { api, route } = setup({ effectTarget: vi.fn(shaderTarget2), effects })
      api.attachReference(REF)
      await api.submit('')
      expect(route).not.toHaveBeenCalled()
      expect(effects.start).toHaveBeenCalledWith(REFERENCE_ONLY_REQUEST, expect.objectContaining({ key: 'shader-studio' }), { reference: REF })
      // The set owns it now: the working label and Three more carry the higher price.
      effects.running.value = true
      expect(api.workingLabel.value).toContain('~$0.24–0.43')
      effects.running.value = false
      expect(api.takesMoreNote.value).toBe('~$0.24–0.43')
      expect(api.reference.value).toBe(REF) // still in the prompt while the set is open
    })
    it('× on the set clears it from the prompt; so does a Keep', async () => {
      const effects = fakeEffects()
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2), effects })
      api.attachReference(REF); await api.submit('slower')
      api.closeTakes()
      expect(api.reference.value).toBeNull()
      api.attachReference(REF); await api.submit('slower')
      await api.keepTake('draft_1_0')
      expect(api.reference.value).toBeNull()
    })
    it('the owner closing ends the set and clears it', async () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2) })
      api.attachReference(REF); await api.submit('slower')
      api.endEffects()
      expect(api.reference.value).toBeNull()
    })
    it('a studio that can’t make effects ignores a picture', () => {
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2), takesReference: () => false })
      expect(api.acceptsReference.value).toBe(false)
      api.attachReference(REF)
      expect(api.reference.value).toBeNull()
      expect(api.mode.value).toBeNull()
    })
    it('without a picture the send is unchanged (two arguments)', async () => {
      const effects = fakeEffects()
      const { api } = setup({ effectTarget: vi.fn(shaderTarget2), effects })
      api.setMode('New effect'); await api.submit('rain')
      expect(effects.start.mock.calls[0]).toHaveLength(2)
    })
  })
})
