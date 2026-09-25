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
 *
 * Stage 5: a new effect (Remix, New effect, or a routed new-effect) runs in an
 * effect-takes session (useEffectTakes) on the target the owner gives
 * (`effectTarget`: the Shader studio's layer, Frame's background). While a set is
 * open, the strip, the working row, Stop and the cards are its; the owner calls
 * `endEffects()` before it closes, so a previewed draft is never saved.
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
import { useEffectTakes, type EffectTarget } from '~/composables/useEffectTakes'
import { shaderGenPriceText } from '~/lib/shadergen/estimate'
import { REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'
import { hostedModeEnabled } from '~/lib/hostedMode'
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
/** `effectId`: the effect a gallery Remix starts from; `add`: the takes land on a new layer. */
export interface StudioPromptMode { label: string; kind: RouterKind; effectId?: string | null; add?: boolean }
/** What a new-effect request asks the owner for: null for a routed request with no chip.
 *  `fresh` is true for "New effect" (start from nothing, not from the current effect); `remix`
 *  for the Remix chip, the only ask that adds a version to a My effect (Ruling #2). */
export type StudioEffectTargetRequest = { effectId: string | null; add: boolean; fresh: boolean; remix: boolean } | null
export interface StudioAnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }

/** Same cap as the canvas prompt (useCanvasPrompt). */
const ROUTER_NAME_MAX = 120


export function useStudioPrompt(
  o: {
    worker: () => StudioPromptWorker | null; place: StudioPromptPlace; host?: RouterHost; selectionKind: string; label: () => string | null; suggestions?: () => string[]
    /** Where new effects show (stage 5); null or absent: this studio can't take them. A string
     *  is a plain refusal to show instead (the Shader studio's full stack). */
    effectTarget?: (m: StudioEffectTargetRequest) => EffectTarget | string | null
    /** Called after a worker take is kept, with the request that made it — only for a request
     *  with words (Tune, or a typed tweak), never for Vary's fixed directions. */
    afterKeep?: (request: string) => void
    /** This studio makes new effects, so a pasted or dropped picture is taken as the look to aim
     *  for (stage 5 follow-up). Default: whenever `effectTarget` is given. */
    takesReference?: () => boolean
  },
  deps: { route?: typeof routeRequest; apiKey?: () => string; effects?: ReturnType<typeof useEffectTakes> } = {},
) {
  const route = deps.route ?? routeRequest
  const fx = deps.effects ?? useEffectTakes()
  // Read lazily and guarded (preflight C8): unit hosts have no Nuxt runtime config.
  const hosted = (): boolean => { try { return hostedModeEnabled(useRuntimeConfig().public) } catch { return false } }
  const apiKey = deps.apiKey ?? (() => useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '')
  const host: RouterHost = o.host ?? (o.place === 'frame' ? 'frame' : 'studio')
  const worker = o.worker

  const mode = ref<StudioPromptMode | null>(null)
  /** A pasted or dropped picture: the look to aim for (a JPEG data URL, long edge ≤ 512 px). It
   *  belongs to the take set it is sent with: Keep, × and the owner closing clear it. */
  const reference = ref<string | null>(null)
  const acceptsReference = computed(() => (o.takesReference ? o.takesReference() : !!o.effectTarget))
  const focusTick = ref(0)
  const routing = ref(false)
  const request = ref('')
  const answerRef = ref<StudioAnswerCard | null>(null)
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

  const workerTakes = computed<TakesSession | null>(() => {
    const w = worker()
    if (!w?.takes || !w.takeThumbs) return null
    return studioTakesSession({
      label: chipLabel.value ?? '', request: request.value, takes: w.takes.value,
      thumbs: w.takeThumbs.value, current: w.takeCurrentThumb?.value ?? null, selected: w.selectedTake?.value ?? null,
    })
  })
  // The strip shows an open effect set (stage 5), else the worker's takes.
  const takes = computed<TakesSession | null>(() => fx.session.value ?? workerTakes.value)
  const takesWorking = computed(() => !!workerTakes.value && isTakesWorking(workerTakes.value))
  const busy = computed(() => routing.value || (workerBusy.value && !stopped.value))
  const working = computed(() => busy.value || takesWorking.value || fx.working.value)
  const disabled = computed(() => stopped.value && runLive.value)
  /** One job at a time: nothing new starts while anything is in flight. An effect Keep
   *  still saving counts too (a new request would close the strip before it applies). */
  const jobBusy = () => working.value || disabled.value || !!fx.saving?.value
  const workingLabel = computed(() => {
    // Effect takes quote the request and carry the estimate (plan ruling 14), as on the canvas.
    if (fx.working.value) return `${promptWorkingLabel({ request: fx.request.value })} · ${shaderGenPriceText(hosted(), !!fx.reference?.value)}`
    if (!busy.value && takesWorking.value) {
      return promptWorkingLabel({ request: workerTakes.value!.request, takesOf: workerTakes.value!.nodeLabel })
    }
    return promptWorkingLabel({ request: request.value, takesOf: takesOf.value })
  })

  /** Frame and the template editor snapshot the whole document when a request
   *  starts, and everything that follows rebuilds from that snapshot: the reply,
   *  the visual review landing (up to a minute later), a row toggle or re-roll on
   *  the proposal, Reject, and a stopped run's reply being thrown away. Edits made
   *  meanwhile would be lost, so those hosts make their editing surfaces inert
   *  while this is true — the old right-panel takeover's guarantee (busy,
   *  reviewing, proposal open). The proposal card and the prompt (Stop, Esc) live
   *  outside the locked region; Approve or Reject ends the lock.
   *  An open effect set (stage 5) locks too: its previews write the target, and ×
   *  puts back what was there before — an edit made meanwhile would be undone. */
  const editLocked = computed(() => working.value || disabled.value
    || !!worker()?.reviewing.value || !!worker()?.hasProposal.value || !!fx.session.value)
  /** The neutral note shown over an inert editing surface. */
  const lockedNote = computed(() => {
    if (working.value || disabled.value) {
      const r = (takes.value && !busy.value ? takes.value.request : request.value).replace(/\s+/g, ' ').trim()
      return r ? `Sailor is working on “${r}”…` : 'Sailor is working…'
    }
    if (worker()?.reviewing.value) return 'Sailor is looking at the result…'
    if (fx.session.value) return 'Keep a take or close the takes to keep editing'
    return 'Approve or reject the changes to keep editing'
  })

  // Effect errors and notices (a failed set, "Saved to My effects…") come first.
  const answerCard = computed<StudioAnswerCard | null>(() => {
    if (fx.error.value) return { kind: 'error', text: fx.error.value, reasoning: '', followUps: [] }
    if (fx.notice.value) return { kind: 'notice', text: fx.notice.value, reasoning: '', followUps: [] }
    return answerRef.value
  })

  const card = computed<'takes' | 'changes' | 'answer' | null>(() => {
    if (fx.session.value) return 'takes'
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
    if (w.error.value) answerRef.value = { kind: 'error', text: w.error.value, reasoning: '', followUps: [] }
    else if (w.notice.value) answerRef.value = {
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

  async function dispatch(kind: RouterKind, text: string, fromMenu: boolean, m?: StudioPromptMode | null) {
    // A new effect asks the owner where it shows: the chip's own ask, or (routed) the default.
    const target = kind === 'new-effect'
      ? o.effectTarget?.(m ? { effectId: m.effectId ?? null, add: !!m.add, fresh: m.label === 'New effect', remix: m.label === 'Remix' } : null) ?? null
      : null
    if (typeof target === 'string') { answerRef.value = { kind: 'notice', text: target, reasoning: '', followUps: [] }; return }
    const d = studioDispatch(kind, text, { place: o.place, hasWorker: !!worker(), canTakes: canTakes(), fromMenu, hasEffectTarget: !!target })
    if (d.worker === 'message') { answerRef.value = { kind: 'notice', text: d.message, reasoning: '', followUps: [] }; return }
    if (d.worker === 'effect') {
      // A proposal still open (or its review still out) would rebuild over the kept
      // effect on Reject: it is settled first, like any other job.
      const w = worker()
      if (w?.hasProposal.value || w?.reviewing.value) { toast.info(BUSY_NOTICE); return }
      w?.abandonTakes?.()
      const pic = reference.value
      void (pic ? fx.start(d.text, target!, { reference: pic }) : fx.start(d.text, target!))
      return
    }
    const w = worker()!
    w.abandonTakes?.()
    await track(w.ask(d.text))
  }

  function beginRun(text: string) {
    // An open effect set goes first: its preview must not be what the next run starts from.
    // (The prompt's reference picture stays: it goes with this run.)
    closeEffects()
    fx.clearMessages()
    answerRef.value = null
    request.value = text
    takesOf.value = null
    stopped.value = false
    return ++runSeq
  }

  async function submit(text: string) {
    // A picture with no words asks to match its look.
    const t = text.trim() || (reference.value ? REFERENCE_ONLY_REQUEST : '')
    if (!t || jobBusy()) return
    const seq = beginRun(t)
    const m = mode.value
    mode.value = null
    // A new-effect chip (Remix, New effect) decides the kind itself: no router call.
    if (m?.kind === 'new-effect') { lastKind = 'new-effect'; await dispatch('new-effect', t, false, m); return }
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

  function setMode(label: string, m: { effectId?: string | null; add?: boolean } = {}) {
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    const kind = kindForMode(label)
    mode.value = kind ? { label, kind, effectId: m.effectId ?? null, add: !!m.add } : null
    focusTick.value++
  }
  function clearMode() { mode.value = null }
  function requestFocus() { focusTick.value++ }

  /** A picture pasted or dropped on the prompt. A second one replaces the first. With no mode
   *  chip it sets New effect (the price shows before anything runs, no router call); a Remix
   *  chip stays. A studio that makes no effects ignores it. */
  function attachReference(dataUrl: string) {
    if (!acceptsReference.value || !dataUrl) return
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    reference.value = dataUrl
    if (mode.value?.kind !== 'new-effect') mode.value = { label: 'New effect', kind: 'new-effect', effectId: null, add: false }
    focusTick.value++
  }
  function clearReference() { reference.value = null }

  /** Stop everything this prompt started: the route call, the worker's run (its
   *  reply is thrown away when it lands) and takes still arriving. */
  function stop() {
    routeCtrl?.abort()
    routeCtrl = null
    routing.value = false
    runSeq++
    if (fx.working.value || fx.session.value) { fx.stop(); return }
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
  // An open effect set owns the strip (stage 5): each call goes to it instead.
  function previewTake(id: string | null) {
    if (fx.session.value) { fx.preview(id); return }
    worker()?.previewTake?.(id === CURRENT ? null : takeAt(id))
  }
  function chooseTake(id: string) {
    if (fx.session.value) { fx.choose(id); return }
    worker()?.selectTake?.(takeAt(id))
  }
  function keepTake(id: string) {
    if (fx.session.value) { return fx.keep(id).then((kept) => { if (kept) reference.value = null }) }
    const w = worker()
    const t = takeAt(id)
    if (!w || !t) return
    dropLateReply()
    w.selectTake?.(t)
    w.keepTake?.()
    if (request.value.trim()) o.afterKeep?.(request.value)
  }
  // The strip's own "more" button: the worker restarts the set, so only a run
  // in flight (not thumbnails still drawing) blocks it.
  function moreTakes() {
    if (fx.session.value) { void fx.more(); return }
    if (busy.value || disabled.value) { toast.info(BUSY_NOTICE); return }
    const w = worker()
    if (w?.moreDirections) void track(w.moreDirections()).catch(() => {})
  }
  function closeTakes() {
    if (fx.session.value) { fx.close(); reference.value = null; return }
    dropLateReply(); worker()?.dismissTakes?.()
  }
  /** End an open effect set, putting the target back (the owner calls this before it
   *  closes or saves, so a previewed draft never persists — preflight C9). */
  function closeEffects() { if (fx.session.value || fx.working.value) fx.close() }
  function endEffects() { closeEffects(); reference.value = null }
  /** An effect-take set is open: the owner makes what it previews on read-only (derived, never stuck). */
  const effectsOpen = computed(() => !!fx.session.value)
  /** A failed Keep while the set is still open: the strip shows it (the card is the strip). */
  const takesError = computed(() => (fx.session.value ? fx.error.value || null : null))
  /** The owner's own outcome sentence (a Tune version saved, or why not), as a card. */
  function notify(kind: 'notice' | 'error', text: string) {
    answerRef.value = { kind, text, reasoning: '', followUps: [] }
  }
  /** An effect Keep is saving: the strip's Keep buttons are off until it settles. */
  const takesSaving = computed(() => !!fx.session.value && !!fx.saving?.value)
  /** The price of what a new-effect chip will do (spec §7.2), shown before anything runs. */
  const modeNote = computed<string | null>(() => (mode.value?.kind === 'new-effect' ? shaderGenPriceText(hosted(), !!reference.value) : null))
  /** "Three more" on an effect set starts another paid set: its price shows on the button first. */
  const takesMoreNote = computed<string | null>(() => (fx.session.value ? shaderGenPriceText(hosted(), !!fx.reference?.value) : null))

  // --- changes and answers ----------------------------------------------------
  function approve() { worker()?.keep() }
  function rejectAll() { worker()?.revert() }
  function dismissAnswer() { answerRef.value = null; fx.clearMessages() }
  function runFollowUp(text: string) { return submit(text) }

  onBeforeUnmount(() => {
    runSeq++
    routeCtrl?.abort()
    routeCtrl = null
    endEffects()
  })

  return {
    chipLabel, suggestions, mode, modeNote, working, workingLabel, disabled, editLocked, lockedNote, focusTick,
    card, takes, takesSaving, takesError, takesMoreNote, effectsOpen, answerCard, worker, notify,
    reference, acceptsReference, attachReference, clearReference,
    submit, runKind, setMode, clearMode, stop, requestFocus,
    previewTake, chooseTake, keepTake, moreTakes, closeTakes, endEffects,
    approve, rejectAll, dismissAnswer, runFollowUp,
  }
}

export type StudioPromptApi = ReturnType<typeof useStudioPrompt>
export const STUDIO_PROMPT_KEY: InjectionKey<StudioPromptApi> = Symbol('studio-prompt')
export function useStudioPromptApi(): StudioPromptApi | null { return inject(STUDIO_PROMPT_KEY, null) }
