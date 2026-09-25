/**
 * useStudioPrompt — the one prompt in a studio (AI in Sailor spec §2.1a, §2.4,
 * §3; stage 4 plan). The studio twin of useCanvasPrompt: a request is routed
 * (host studio or frame; a mode chip or an inspector action skips the call),
 * studioDispatch decides whether the studio's OWN agent runs it or a plain
 * message answers, and what comes back is shown above the prompt: three takes,
 * a proposed change, or an answer. The workers are unchanged.
 *
 * Stop lives here (plan ruling 6): no worker can abort, so Stop ends the working
 * state at once and throws the stopped run's reply away when it lands.
 *
 * One job at a time: a routing call, a busy worker, and takes still arriving
 * all count as busy. A menu item or mode chip arriving then says so.
 *
 * The owner (StudioModalShell, CompositorModal, GridEditorShell) calls this and
 * provides it under STUDIO_PROMPT_KEY, so inspector action rows can reach it.
 */
import { computed, inject, onBeforeUnmount, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import { BUSY_NOTICE } from '~/lib/prompt/notices'
import { routeRequest } from '~/lib/prompt/routeRequest'
import { promptWorkingLabel } from '~/lib/prompt/canvasPromptContext'
import { studioDispatch, type StudioPromptPlace } from '~/lib/prompt/studioDispatch'
import { studioTakeIndex, studioTakesSession } from '~/lib/prompt/studioTakes'
import { CURRENT, isTakesWorking, type TakesSession } from '~/lib/prompt/takesSession'
import { kindForMode, type RouterHost, type RouterKind } from '~~/shared/promptRouter/router'

/** What every studio agent already returns (useStudioAgent, useTextureAgent,
 *  useCompositorAgent, useLayoutAgent). The take fields exist only on useStudioAgent. */
export interface StudioPromptWorker {
  busy: Ref<boolean>; error: Ref<string>; notice: Ref<string>
  changes: Ref<ProposedChange[]>; hasProposal: Ref<boolean> | ComputedRef<boolean>; hovered: Ref<number | null>
  review: Ref<VisualReview | null>; reviewing: Ref<boolean>; issues?: Ref<any[]>
  ask: (phrase: string) => unknown
  acceptChange: (i: number) => void; rejectChange: (i: number) => void; reroll: (i: number) => unknown
  keep: () => void; revert: () => void
  // take session (useStudioAgent only)
  hasTakes?: Ref<boolean> | ComputedRef<boolean>
  takes?: Ref<any[]>; takeThumbs?: Ref<Map<any, any>>; takeCurrentThumb?: Ref<any>; selectedTake?: Ref<any>
  previewTake?: (t: any | null) => void; selectTake?: (t: any | null) => void; keepTake?: () => void
  dismissTakes?: () => void; abandonTakes?: () => void; moreDirections?: () => unknown
}
export interface StudioPromptMode { label: string; kind: RouterKind }
export interface StudioAnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }

/** Same cap as the canvas prompt (useCanvasPrompt). */
const ROUTER_NAME_MAX = 120


export function useStudioPrompt(
  o: { worker: () => StudioPromptWorker | null; place: StudioPromptPlace; host?: RouterHost; selectionKind: string; label: () => string | null; suggestions?: () => string[] },
  deps: { route?: typeof routeRequest; apiKey?: () => string } = {},
) {
  const route = deps.route ?? routeRequest
  const apiKey = deps.apiKey ?? (() => useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '')
  const host: RouterHost = o.host ?? (o.place === 'frame' ? 'frame' : 'studio')
  const worker = o.worker

  const mode = ref<StudioPromptMode | null>(null)
  const focusTick = ref(0)
  const routing = ref(false)
  const request = ref('')
  const answerCard = ref<StudioAnswerCard | null>(null)
  const stopped = ref(false) // a stopped run whose reply hasn't landed yet
  const calls = ref(0) // worker calls (ask, moreDirections) whose promise hasn't settled
  let routeCtrl: AbortController | null = null
  let lastKind: RouterKind | null = null
  let lastFollowUps: string[] = []
  let runSeq = 0

  const chipLabel = computed(() => o.label())
  const suggestions = computed(() => o.suggestions?.() ?? [])
  const workerBusy = computed(() => !!worker()?.busy.value)
  // A run is everything the worker does for one request: its call, its busy spell,
  // and the visual review it fires without waiting (every worker does this, and
  // the review writes fixes into the studio when it lands).
  const runLive = computed(() => calls.value > 0 || workerBusy.value || !!worker()?.reviewing.value)
  // Vary from the inspector has no words: name the thing instead (stage 3's takesOf).
  const takesOf = ref<string | null>(null)

  const takes = computed<TakesSession | null>(() => {
    const w = worker()
    if (!w?.takes || !w.takeThumbs) return null
    return studioTakesSession({
      label: chipLabel.value ?? '', request: request.value, takes: w.takes.value,
      thumbs: w.takeThumbs.value, current: w.takeCurrentThumb?.value ?? null, selected: w.selectedTake?.value ?? null,
    })
  })
  const takesWorking = computed(() => !!takes.value && isTakesWorking(takes.value))
  const busy = computed(() => routing.value || (workerBusy.value && !stopped.value))
  const working = computed(() => busy.value || takesWorking.value)
  const disabled = computed(() => stopped.value && runLive.value)
  /** One job at a time: nothing new starts while anything is in flight. */
  const jobBusy = () => working.value || disabled.value
  const workingLabel = computed(() => {
    if (!busy.value && takesWorking.value) {
      return promptWorkingLabel({ request: takes.value!.request, takesOf: takes.value!.nodeLabel })
    }
    return promptWorkingLabel({ request: request.value, takesOf: takesOf.value })
  })

  /** Frame and the template editor snapshot the whole document when a request
   *  starts and push that snapshot back when the reply lands (or is thrown away
   *  after Stop). Edits made meanwhile would be lost, so those hosts make their
   *  editing surfaces inert while this is true: a run in flight, or a stopped
   *  run whose reply hasn't landed yet. */
  const editLocked = computed(() => working.value || disabled.value)
  /** The neutral note shown over an inert editing surface; quotes the request. */
  const lockedNote = computed(() => {
    const r = (takes.value && !busy.value ? takes.value.request : request.value).replace(/\s+/g, ' ').trim()
    return r ? `Sailor is working on “${r}”…` : 'Sailor is working…'
  })

  const card = computed<'takes' | 'changes' | 'answer' | null>(() => {
    if (busy.value || disabled.value) return null
    if (takes.value) return 'takes'
    if (worker()?.hasProposal.value) return 'changes'
    return answerCard.value ? 'answer' : null
  })

  // A run ends when its call has settled and the worker is neither busy nor
  // reviewing. A stopped run is thrown away only then (so a late review can't
  // write after the revert); a live one that made nothing shows its words (plan
  // ruling 5). Sync, so a run that starts and ends inside one tick is still seen.
  watch(runLive, (live, was) => {
    if (live || !was) return
    const w = worker()
    if (!w) return
    if (stopped.value) {
      if (w.hasTakes?.value) w.abandonTakes?.()
      if (w.hasProposal.value) w.revert()
      stopped.value = false
      return
    }
    if (w.hasTakes?.value || w.hasProposal.value) return
    if (w.error.value) answerCard.value = { kind: 'error', text: w.error.value, reasoning: '', followUps: [] }
    else if (w.notice.value) answerCard.value = {
      kind: lastKind === 'answer' ? 'answer' : 'notice', text: w.notice.value, reasoning: '',
      followUps: lastKind === 'answer' ? lastFollowUps : [],
    }
  }, { flush: 'sync' })

  const canTakes = () => !!worker()?.takes
  /** Hold the run open until the worker's own promise settles: a worker can drop
   *  `busy` and raise it again in one tick (moreDirections' compose fallback). */
  function track(p: unknown): Promise<unknown> {
    calls.value++
    return Promise.resolve(p).finally(() => { calls.value-- })
  }

  async function dispatch(kind: RouterKind, text: string, fromMenu: boolean) {
    const d = studioDispatch(kind, text, { place: o.place, hasWorker: !!worker(), canTakes: canTakes(), fromMenu })
    if (d.worker === 'message') { answerCard.value = { kind: 'notice', text: d.message, reasoning: '', followUps: [] }; return }
    const w = worker()!
    w.abandonTakes?.()
    await track(w.ask(d.text))
  }

  function beginRun(text: string) {
    answerCard.value = null
    request.value = text
    takesOf.value = null
    stopped.value = false
    return ++runSeq
  }

  async function submit(text: string) {
    const t = text.trim()
    if (!t || jobBusy()) return
    const seq = beginRun(t)
    const m = mode.value
    mode.value = null
    // No worker here (3D): the answer is fixed whatever the request is, so don't
    // pay for a routing call to reach it.
    if (!worker()) { await dispatch(m?.kind ?? 'tweak', t, false); return }
    const ctrl = routeCtrl = new AbortController()
    routing.value = true
    let kind: RouterKind
    try {
      const name = chipLabel.value?.slice(0, ROUTER_NAME_MAX)
      const out = await route(
        { request: t, host, selection: name ? [{ kind: o.selectionKind, name }] : [], mode: m?.label ?? null },
        { apiKey: apiKey(), signal: ctrl.signal },
      )
      kind = out.kind
      lastFollowUps = out.followUps
    } catch {
      return // aborted by Stop or unmount: drop it silently (routeRequest only rethrows on abort)
    } finally {
      if (seq === runSeq) { routing.value = false; routeCtrl = null }
    }
    if (seq !== runSeq || stopped.value) return
    lastKind = kind
    await dispatch(kind, t, false)
  }

  /** An inspector action that decides its own kind (Vary): no router call. */
  async function runKind(kind: RouterKind, a: { text?: string; fromMenu?: boolean } = {}) {
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    mode.value = null
    beginRun(a.text?.trim() ?? '')
    if (kind === 'tweak' && a.fromMenu && !a.text?.trim()) takesOf.value = chipLabel.value ?? ''
    lastKind = kind
    lastFollowUps = []
    await dispatch(kind, a.text ?? '', !!a.fromMenu)
  }

  function setMode(label: string) {
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    const kind = kindForMode(label)
    mode.value = kind ? { label, kind } : null
    focusTick.value++
  }
  function clearMode() { mode.value = null }
  function requestFocus() { focusTick.value++ }

  /** Stop everything this prompt started: the route call, the worker's run (its
   *  reply is thrown away when it lands) and takes still arriving. */
  function stop() {
    routeCtrl?.abort()
    routeCtrl = null
    routing.value = false
    runSeq++
    if (runLive.value) stopped.value = true
    else if (takesWorking.value) worker()?.abandonTakes?.()
  }

  // --- takes -------------------------------------------------------------------
  const takeAt = (id: string | null) => {
    const i = studioTakeIndex(id)
    return i == null ? null : worker()?.takes?.value[i] ?? null
  }
  // Defensive: the strip is hidden while the worker is busy, so this only matters
  // if × or Keep reaches us another way mid-run; any late reply is then dropped.
  const dropLateReply = () => { if (runLive.value) stopped.value = true }
  function previewTake(id: string | null) { worker()?.previewTake?.(id === CURRENT ? null : takeAt(id)) }
  function chooseTake(id: string) { worker()?.selectTake?.(takeAt(id)) }
  function keepTake(id: string) {
    const w = worker()
    const t = takeAt(id)
    if (!w || !t) return
    dropLateReply()
    w.selectTake?.(t)
    w.keepTake?.()
  }
  // The strip's own "more" button: the worker restarts the set, so only a run
  // in flight (not thumbnails still drawing) blocks it.
  function moreTakes() {
    if (busy.value || disabled.value) { toast.info(BUSY_NOTICE); return }
    const w = worker()
    if (w?.moreDirections) void track(w.moreDirections()).catch(() => {})
  }
  function closeTakes() { dropLateReply(); worker()?.dismissTakes?.() }

  // --- changes and answers ----------------------------------------------------
  function approve() { worker()?.keep() }
  function rejectAll() { worker()?.revert() }
  function dismissAnswer() { answerCard.value = null }
  function runFollowUp(text: string) { return submit(text) }

  onBeforeUnmount(() => {
    runSeq++
    routeCtrl?.abort()
    routeCtrl = null
  })

  return {
    chipLabel, suggestions, mode, working, workingLabel, disabled, editLocked, lockedNote, focusTick,
    card, takes, answerCard, worker,
    submit, runKind, setMode, clearMode, stop, requestFocus,
    previewTake, chooseTake, keepTake, moreTakes, closeTakes,
    approve, rejectAll, dismissAnswer, runFollowUp,
  }
}

export type StudioPromptApi = ReturnType<typeof useStudioPrompt>
export const STUDIO_PROMPT_KEY: InjectionKey<StudioPromptApi> = Symbol('studio-prompt')
export function useStudioPromptApi(): StudioPromptApi | null { return inject(STUDIO_PROMPT_KEY, null) }
