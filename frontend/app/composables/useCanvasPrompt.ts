/**
 * useCanvasPrompt — everything the canvas's one prompt does (AI in Sailor spec
 * §3, §4). A request is routed (one Haiku call; a mode chip or a menu item
 * decides the kind without it), handed to the canvas worker for that kind
 * (canvasDispatch), and what comes back is held here: three takes above the
 * prompt, a proposed change, or an answer. CanvasPromptHost.vue only renders
 * it. `canvas` returns VueNodeCanvas's exposed API (null until it mounts).
 * Formerly CanvasPromptBar.vue's script (stage 2), plus the router and results.
 * Stage 5: new effects on a shader effect node run in an effect-takes session
 * (useEffectTakes); while one is open, the takes, working row, Stop and cards are its.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { toast } from 'vue-sonner'
import { useCanvasAgent } from '~/composables/useCanvasAgent'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { paidProducerFor } from '~/lib/artifact/nextSteps'
import { looksLikeImageIdea } from '~/lib/sketch/sketchIntent'
import { canvasSuggestions, promptNodeLabel, promptWorkingLabel, selectionLabel, type PromptNode } from '~/lib/prompt/canvasPromptContext'
import { canvasDispatch, DISPATCH_MESSAGES, isPlainVaryRequest, SHADER_NODE_TYPES, type DispatchTarget } from '~/lib/prompt/canvasDispatch'
import { REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'
import { routeRequest } from '~/lib/prompt/routeRequest'
import { BUSY_NOTICE } from '~/lib/prompt/notices'
import {
  assignRun, failRun, hoverTile, ingestTakes, isTakesWorking, openTakes, pendingRunIds, readyCount,
  setRunIds, settleUnqueued, shownTakeId, TAKES_PER_SET, wantedActiveTakeId, type TakesSession,
} from '~/lib/prompt/takesSession'
import { useEffectTakes, type EffectTarget } from '~/composables/useEffectTakes'
import { shaderGenPriceText } from '~/lib/shadergen/estimate'
import { getEffectSync } from '~/lib/shaderfx/catalogStore'
import { hostedModeEnabled } from '~/lib/hostedMode'
import type { RouterKind } from '~~/shared/promptRouter/router'

/** `effectId`: the effect a gallery Remix starts from (null: the node's own). */
export interface PromptMode { label: string; kind: RouterKind; nodeId: string | null; effectId: string | null }
export type PromptCard = 'takes' | 'changes' | 'answer' | null
export interface AnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }

/** A take whose run never reports back is marked "didn’t come back" after this. */
export const TAKE_BACKSTOP_MS = 5 * 60_000
/** A run that ended without its take landing is failed after this grace. */
export const TAKE_SETTLE_GRACE_MS = 1_500
/** The router sees at most this many selected nodes, names cut to this length
 *  (the route itself refuses more than 20). */
export const ROUTER_SELECTION_MAX = 8
export const ROUTER_NAME_MAX = 120
export { BUSY_NOTICE }

export function useCanvasPrompt(canvas: () => any, deps: { route?: typeof routeRequest; effects?: ReturnType<typeof useEffectTakes> } = {}) {
  const route = deps.route ?? routeRequest
  const fx = deps.effects ?? useEffectTakes()
  // Read lazily and guarded (preflight C8): unit hosts have no Nuxt runtime config.
  const hosted = (): boolean => { try { return hostedModeEnabled(useRuntimeConfig().public) } catch { return false } }
  const { getLocalSetting } = useLocalSettings()
  const apiKey = () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? ''
  const ready = () => {
    const c = canvas()
    return typeof c?.agentSnapshot === 'function' && typeof c?.agentPreview === 'function'
  }

  // Misfire correction: auto-detect occasionally routes a phrase to the wrong
  // intent. `lastSubmitted` is the raw text of the last user submission
  // (offers "…or sketch it?" once a proposal shows up for it). Reset at
  // the top of every new submission — see `submit()`.
  const lastSubmitted = ref('')
  // Fast-path dedupe (Task 7, spec §6 lever 1): true when `submit()` fast-pathed
  // straight to `startSketch` THIS submit tick. If the classifier later resolves
  // to `sketchIdea` too, that's the fast-path's own render finishing its round
  // trip — consume the latch and skip a second pad dispatch. A plain prompt
  // equality check doesn't work here: the `sketch` command hint tells the model
  // to DISTILL a clean prompt, so for verbose input the classifier's prompt
  // legitimately differs from the raw text while still being the same request.
  // Cleared at the top of every `submit()` so a later, genuine sketch still fires.
  const fastPathFired = ref(false)
  // Web-image-search picker (opened by the agent's searchImages command).
  const searchOpen = ref(false)
  const searchQuery = ref('')
  // The working row quotes what the user asked (or names the node a Fix is
  // looking at) so it always corresponds to the request, never a generic phase.
  const reviewTargetLabel = ref('')

  const agent = useCanvasAgent({
    getSnapshot: (phrase?: string) => canvas().agentSnapshot(phrase),
    preview: (cmds, animate) => canvas().agentPreview(cmds, animate),
    commit: () => canvas().agentCommit(),
    frameNodes: (ids: string[]) => canvas().agentFrameNodes(ids),
    discard: () => canvas().agentDiscard(),
    tune: (cmds) => canvas().agentTune(cmds, getLocalSetting('Sailor.AI.AnthropicApiKey') ?? ''),
    tuneRevert: () => canvas().agentTuneRevert(),
    // (anatomy repairs now go through an EditImageNode the review proposes, not a route)
    // Keep & Run: run the agent's result AND anything it feeds into (direction:
    // 'downstream') — so an inserted node re-renders the output it connects to —
    // but only that affected branch, never unrelated nodes (the top Run does the
    // whole canvas). New nodes execute (uncached) and edited nodes cache-miss;
    // truly-unchanged upstream stays cached.
    run: (targetIds: string[]) => window.dispatchEvent(new CustomEvent('sailor:runFiltered', { detail: { targetIds, direction: 'downstream' } })),
    runOutputImage: (targetIds: string[]) => canvas().agentRunOutputImage(targetIds),
    resolveResultNode: (targetIds: string[]) => canvas().agentResolveResultNode?.(targetIds) ?? null,
    apiKey: () => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '',
    // "find me a picture of X" → the model emits searchImages and the picker
    // takes over (search → select → import as Image nodes).
    searchImages: (query: string) => { searchQuery.value = query; searchOpen.value = true },
    // A typed image idea → the model emits `sketch` and the pad renders 4 options.
    // Dedupe against the fast-path via the `fastPathFired` latch (not a prompt
    // equality check — the classifier's distilled prompt can legitimately differ
    // from the raw text it fast-pathed): if the fast-path already fired this
    // submit tick, consume the latch and skip the redundant dispatch.
    sketchIdea: (prompt: string) => {
      if (fastPathFired.value) {
        fastPathFired.value = false
        return
      }
      if (ready()) canvas().startSketch?.(prompt)
    },
  })

  function onSearchDone(imported: number, failed: number) {
    searchOpen.value = false
    if (imported) agent.answer.value = `Imported ${imported} image${imported === 1 ? '' : 's'} onto the canvas.${failed ? ` ${failed} couldn’t be downloaded.` : ''}`
    else if (failed) agent.answer.value = 'None of those images could be downloaded — try other picks.'
  }

  // Run→look→fix: when a Keep & Run finishes, review its output (reviewLastRun is a
  // no-op unless a review is armed). VueNodeCanvas fires this on execution_complete.
  function onRunComplete() { agent.reviewLastRun() }
  // On-demand "Critique" on any result node — judges its output against the prompt
  // that made it (resolved by VueNodeCanvas). Fired from the node's run menu.
  function onCritiqueNode(e: Event) {
    const id = (e as CustomEvent).detail?.nodeId
    if (!id || !ready()) return
    if (menuBusy()) { toast.info(BUSY_NOTICE); return }
    const target = selection.value.find(n => n.id === String(id))
    reviewTargetLabel.value = target ? promptNodeLabel(target) : ''
    agent.reviewNode(String(id), canvas().agentNodeIntent?.(String(id)) ?? '')
  }
  // Auto-critique: a fresh take landed on an image artifact. Gate hard —
  // paid producer only, once per take, 3s settle so a Variations burst
  // reviews the final state once instead of once per take.
  const reviewedTakes = new Map<string, string>()
  const autoReviewTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function onAutoReview(e: Event) {
    const { nodeId, takeId } = (e as CustomEvent).detail || {}
    if (!nodeId || !takeId || !ready()) return
    // Opt-in only: skip the post-generation critique unless the user turned it on
    // in Settings → AI. Off by default (unset === off).
    if (getLocalSetting('Sailor.AI.AutoReview') !== 'true') return
    const id = String(nodeId)
    if (reviewedTakes.get(id) === String(takeId)) return
    clearTimeout(autoReviewTimers.get(id))
    autoReviewTimers.set(id, setTimeout(() => {
      autoReviewTimers.delete(id)
      const nodes = canvas()?.getNodes?.() ?? []
      const edges = canvas()?.getEdges?.() ?? []
      if (!paidProducerFor(id, nodes, edges)) return
      reviewedTakes.set(id, String(takeId))
      agent.autoReviewNode(id, canvas()?.agentNodeIntent?.(id) ?? '')
    }, 3000))
  }

  // Drive the dot-grid "thinking" animation off the agent's busy state. (The white
  // "analyzing" scan is rendered per-node, driven by useAgentActivity.analyzingNodeIds
  // which useCanvasAgent sets during a review.)
  const { thinking } = useAgentActivity()
  watch(agent.busy, (v) => { thinking.value = v })

  // Hovering a proposal row highlights the node/wire it refers to on the canvas.
  watch(agent.hovered, (i) => {
    const c = canvas()
    if (typeof c?.agentHighlight !== 'function') return
    c.agentHighlight(i != null ? agent.changes.value[i]?.command ?? null : null)
  })

  // Misfire correction handler.
  // "…or sketch it?": hand the last submitted text straight to the sketch pad
  // and drop the (mis-proposed) edit.
  function sketchInstead() {
    if (ready() && lastSubmitted.value) canvas().startSketch?.(lastSubmitted.value)
    agent.dismiss()
  }

  // Speculative warm (Task 7, spec §6 lever 2): on prompt-bar focus, ask the
  // canvas to warm the Replicate flux-schnell endpoint with a throwaway
  // single-output dispatch, so a real sketch submit right after doesn't eat a
  // cold boot. Debounced (focus can fire repeatedly on tab/click churn) —
  // VueNodeCanvas.warmSketch also self-gates on a 3-min cooldown.
  // OFF BY DEFAULT: this spends a small real amount per warm
  // (~$0.003), so it only fires when the user has opted in via this local
  // setting (Settings has no toggle for it yet — set it from devtools:
  // `localStorage.setItem('sailor:Sailor.Sketch.WarmEnabled', 'true')`).
  const WARM_SETTING_KEY = 'Sailor.Sketch.WarmEnabled'
  let warmFocusTimer: ReturnType<typeof setTimeout> | null = null
  function onPromptFocus() {
    if (getLocalSetting(WARM_SETTING_KEY) !== 'true') return
    if (warmFocusTimer) clearTimeout(warmFocusTimer)
    warmFocusTimer = setTimeout(() => { canvas()?.warmSketch?.() }, 400)
  }

  // --- context (spec §2.1) ---------------------------------------------------
  // The canvas selection names the chip and placeholder; suggestions follow
  // what's selected (or an empty graph).
  const selection = computed<PromptNode[]>(() => (canvas()?.agentSelection ?? []) as PromptNode[])
  const chipLabel = computed(() => selectionLabel(selection.value))
  const suggestions = computed(() => canvasSuggestions(selection.value, (canvas()?.getNodes?.() ?? []).length === 0))
  function clearSelection() { canvas()?.agentClearSelection?.() }

  // --- state ------------------------------------------------------------------
  const mode = ref<PromptMode | null>(null)
  /** A pasted or dropped picture: the look to aim for (a JPEG data URL, long edge ≤ 512 px), taken
   *  only while one shader effect node is selected. It belongs to the take set it is sent with:
   *  Keep and × clear it, and so does selecting something else (as with the mode). */
  const reference = ref<string | null>(null)
  const acceptsReference = computed(() => selection.value.length === 1 && SHADER_NODE_TYPES.has(selection.value[0]!.type))
  const focusTick = ref(0)
  const routing = ref(false)
  let routeCtrl: AbortController | null = null
  let routeSeq = 0
  const notice = ref('')
  const followUps = ref<string[]>([])
  const takes = ref<TakesSession | null>(null)

  function targetFor(nodeId?: string | null): DispatchTarget | null {
    const sel = selection.value
    const id = nodeId ?? (sel.length === 1 ? sel[0]!.id : null)
    if (!id) return null
    const c = canvas()
    const n = (c?.getNodes?.() ?? []).find((x: any) => String(x.id) === id)
    if (!n) return null
    const pn: PromptNode = sel.find(s => s.id === id)
      ?? { id, title: String(n.data?.title ?? ''), type: String(n.type ?? ''), hasImages: false, nodeType: n.data?.nodeType }
    return {
      nodeId: id,
      type: String(n.type ?? ''),
      hasImages: Array.isArray(n.data?.images) && n.data.images.length > 0,
      hasUpstream: (c?.getEdges?.() ?? []).some((e: any) => String(e.target) === id),
      label: promptNodeLabel(pn),
    }
  }

  // --- takes (spec §3.1) ------------------------------------------------------
  // The layout runs one Variations loop at a time and silently drops a
  // `sailor:runVariations` that arrives while one is going (from the node's
  // menu, or a set we just stopped that hasn't wound down yet). So mirror its
  // guard: `loop` is the run the layout is on, and `sid` says which of our sets
  // started it (null: not ours). A new set whose loop can't start yet waits
  // (`waitingSid`) and dispatches on that run's `variationsDone`.
  //
  // The loop reports each run as it is QUEUED (`variationsQueued`, with its
  // prompt id) and `variationsDone` right after the last one is queued — long
  // before any take renders. So the set stays in flight until every tile has
  // settled: its run's take landed, its run failed or ended with nothing
  // (the run's own terminal event), or the backstop gave up on it.
  let sessionSid = 0
  let dispatchingSid: number | null = null
  let waitingSid: number | null = null
  let loop: { nodeId: string; sid: number | null } | null = null
  const tileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const settleTimers = new Set<ReturnType<typeof setTimeout>>()
  function clearTakeTimers() {
    for (const t of tileTimers.values()) clearTimeout(t)
    tileTimers.clear()
    for (const t of settleTimers) clearTimeout(t)
    settleTimers.clear()
  }
  function failTile(promptId: string) {
    const s = takes.value
    if (!s) return
    const t = tileTimers.get(promptId)
    if (t) { clearTimeout(t); tileTimers.delete(promptId) }
    takes.value = failRun(s, promptId)
  }
  function onRunVariations(e: Event) {
    const nodeId = (e as CustomEvent).detail?.nodeId
    if (loop || !nodeId) return // the layout ignores it too
    loop = { nodeId: String(nodeId), sid: dispatchingSid }
  }
  function dispatchRun(sid: number, nodeId: string) {
    dispatchingSid = sid
    window.dispatchEvent(new CustomEvent('sailor:runVariations', { detail: { nodeId, count: TAKES_PER_SET } }))
    dispatchingSid = null
  }
  /** One run of the loop was queued: it belongs to the open set's next tile, or,
   *  for a set already closed, it is held so its take can't take over the node. */
  function recordRun(promptId: string) {
    const s = takes.value
    if (!loop || loop.sid == null) return
    if (s && loop.sid === sessionSid && loop.nodeId === s.nodeId) {
      const next = assignRun(s, promptId)
      if (next === s) return
      takes.value = next
      if (!tileTimers.has(promptId)) tileTimers.set(promptId, setTimeout(() => { tileTimers.delete(promptId); failTile(promptId) }, TAKE_BACKSTOP_MS))
      return
    }
    canvas()?.agentTakesHold?.(loop.nodeId, [promptId])
  }
  function onVariationsQueued(e: Event) {
    const id = (e as CustomEvent).detail?.promptId
    if (id) recordRun(String(id))
  }
  // A run's terminal event (the layout re-posts every run event on the
  // `sailor-bridge` envelope). An error fails its tile at once; a run that ends
  // without its take landing (interrupted, nothing produced) fails it after a
  // short grace, since the take lands on its own path.
  function onRunEvent(e: MessageEvent) {
    const d = e.data
    if (!d || d.type !== 'sailor-bridge' || !d.prompt_id) return
    const s = takes.value
    const id = String(d.prompt_id)
    if (!s || !pendingRunIds(s).includes(id)) return
    if (d.event === 'execution_error') failTile(id)
    else if (d.event === 'execution_complete') {
      const t = setTimeout(() => {
        settleTimers.delete(t)
        const cur = takes.value
        if (cur && pendingRunIds(cur).includes(id)) failTile(id)
      }, TAKE_SETTLE_GRACE_MS)
      settleTimers.add(t)
    }
  }
  function startTakes(t: DispatchTarget, request: string) {
    const c = canvas()
    const snap = c?.agentNodeTakes?.(t.nodeId)
    if (!snap) { notice.value = 'That node isn’t on the canvas any more.'; return }
    const sid = ++sessionSid
    takes.value = { ...openTakes({ nodeId: t.nodeId, nodeLabel: t.label, request, takes: snap.takes, images: snap.images, activeTakeId: snap.activeTakeId }), loopDone: false }
    c.agentTakesBegin(t.nodeId)
    if (loop) waitingSid = sid
    else dispatchRun(sid, t.nodeId)
  }
  /** Close the set. `detached`: the canvas already swapped graphs, so its node
   *  ids now name another project's nodes — touch nothing there. */
  function endTakes(keepId: string | null, o: { detached?: boolean } = {}) {
    const s = takes.value
    if (!s) return
    waitingSid = null
    // Stop what this set still has going: the loop, if it is still queueing,
    // and every run that hasn't come back — by prompt id, so nothing else stops.
    const ours = loop?.sid === sessionSid
    const inFlight = pendingRunIds(s)
    if (ours || inFlight.length) {
      window.dispatchEvent(new CustomEvent('sailor:stopVariations', { detail: { nodeId: s.nodeId, promptIds: inFlight, cancelLoop: ours } }))
    }
    clearTakeTimers()
    // A late take of this set still lands in history but never becomes active;
    // the kept run's own re-emission may.
    const keptRun = keepId ? s.tiles.find(x => x.takeId === keepId)?.promptId ?? null : null
    if (!o.detached) canvas()?.agentTakesEnd?.(s.nodeId, keepId, setRunIds(s).filter(p => p !== keptRun))
    takes.value = null
  }
  const show = (s: TakesSession) => canvas()?.agentShowTake?.(s.nodeId, shownTakeId(s))
  // A landing take is appended AND made active (appendTake); re-show whatever the
  // strip says (the version at open, or the hovered/chosen tile) so the node
  // doesn't jump — for this set's takes and for any other run's (an earlier
  // set's late arrival). The first arrival pans the node into view.
  watch(
    () => { const s = takes.value; return s ? canvas()?.agentNodeTakes?.(s.nodeId) ?? null : null },
    (snap) => {
      const s = takes.value
      if (!s || !snap) return
      const next = ingestTakes(s, snap.takes)
      if (next !== s) {
        for (const tile of next.tiles) {
          const t = tile.state === 'ready' && tile.promptId ? tileTimers.get(tile.promptId) : undefined
          if (t) { clearTimeout(t); tileTimers.delete(tile.promptId!) }
        }
        if (!readyCount(s) && readyCount(next)) canvas()?.agentRevealNode?.(s.nodeId)
        takes.value = next
      }
      if (next !== s || (snap.activeTakeId ?? null) !== wantedActiveTakeId(next, snap.takes)) show(next)
    },
  )
  function onVariationsDone(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    const ran = loop
    loop = null
    const s = takes.value
    if (!s) return
    if (ran?.sid === sessionSid && String(d.nodeId) === s.nodeId) {
      // Our loop finished QUEUEING (its renders may still be going). Tiles no run
      // was queued for won't come back; the rest settle on their own runs.
      let next: TakesSession = s
      for (const id of Array.isArray(d.promptIds) ? d.promptIds : []) next = assignRun(next, String(id))
      takes.value = { ...settleUnqueued(next), loopDone: true }
      return
    }
    // Someone else's run (or a set we stopped) finished: ours can start now.
    if (waitingSid === sessionSid) { waitingSid = null; dispatchRun(sessionSid, s.nodeId) }
  }
  // An open effect set (stage 5) owns the strip: each call goes to it instead.
  function previewTake(id: string | null) {
    if (fx.session.value) return fx.preview(id)
    const s = takes.value; if (!s) return; takes.value = hoverTile(s, id); show(takes.value)
  }
  async function keepTake(id: string) {
    if (fx.session.value) { if (await fx.keep(id)) reference.value = null; return }
    endTakes(id)
  }
  function closeTakes() {
    if (fx.session.value) { reference.value = null; return fx.close() }
    endTakes(null)
  }
  function moreTakes() {
    if (fx.session.value) return void fx.more()
    const s = takes.value
    // Only once this set's run has reported done: until then the layout would drop a new one.
    if (!s || isTakesWorking(s) || !s.loopDone) return
    const t = targetFor(s.nodeId)
    const request = s.request
    endTakes(null)
    if (t) startTakes(t, request)
  }

  // --- new effects on a shader node (stage 5, spec §7.3) -----------------------
  // The node answers synchronously with its picture, its effect and its shown
  // name; previews and the kept effect go back to it by window event.
  function effectTargetFor(nodeId: string, baseEffectId: string | null): EffectTarget | null {
    type Info = { image: CanvasImageSource | null; effectId: string; title: string; current?: CanvasImageSource | null }
    let info: Info | null = null
    window.dispatchEvent(new CustomEvent('sailor:shaderEffectTarget', { detail: { nodeId, reply: (o: Info) => { info = o } } }))
    if (!info) return null
    const i: Info = info
    const fire = (name: string, detail: object) => window.dispatchEvent(new CustomEvent(name, { detail: { nodeId, ...detail } }))
    return {
      key: nodeId,
      // The node's own shown name (its effect's name) — the card header's, not the class's.
      label: i.title || targetFor(nodeId)?.label || '',
      base: getEffectSync(baseEffectId ?? i.effectId),
      image: () => i.image,
      current: () => i.current ?? null,
      preview: effectId => fire('sailor:shaderEffectPreview', { effectId }),
      // No undo of its own: the node's widgets change, and the canvas history records that as one step.
      apply: (effectId, values) => { fire('sailor:shaderEffectApply', { effectId, values }) },
    }
  }

  // --- dispatch (spec §4) -----------------------------------------------------
  type RunOpts = { nodeId?: string | null; fromMenu?: boolean; followUps?: string[]; effectId?: string | null; newEffect?: boolean; remix?: boolean }
  function run(kind: RouterKind, text: string, o: RunOpts = {}) {
    const target = targetFor(o.nodeId)
    const d = canvasDispatch(kind, text, target, { fromMenu: o.fromMenu })
    if (d.worker === 'message') { notice.value = d.message; return }
    if (d.worker === 'effect') {
      // "New effect" starts from nothing; Remix (chip or routed) from the gallery's pick or the node's own effect.
      const t = effectTargetFor(d.nodeId, o.effectId ?? null)
      if (!t) { notice.value = DISPATCH_MESSAGES.newEffect; return }
      if (o.newEffect) t.base = null
      // Only the Remix chip adds a version to a My effect; a routed request makes a new one (Ruling #2).
      t.remix = !!o.remix
      const pic = reference.value
      void (pic ? fx.start(text, t, { reference: pic }) : fx.start(text, t))
      return
    }
    if (d.worker === 'variations') { startTakes(target!, o.fromMenu ? '' : text); return }
    if (d.worker === 'fix') {
      reviewTargetLabel.value = target?.label ?? ''
      agent.reviewNode(d.nodeId, canvas()?.agentNodeIntent?.(d.nodeId) ?? '')
      return
    }
    followUps.value = kind === 'answer' ? (o.followUps ?? []) : []
    agent.ask(text)
  }
  function clearResults(o: { detached?: boolean } = {}) {
    if (takes.value) endTakes(null, o)
    if (fx.session.value) fx.close()
    fx.clearMessages()
    notice.value = ''
    followUps.value = []
    fastPathFired.value = false
    // Only when there is something on screen to dismiss: dismiss() also drops an
    // armed Keep & Run review, and run→look→fix must survive a new request
    // (Ruling 13). ask() clears the ghost and the tune preview on its own.
    if (agent.hasProposal.value || agent.answer.value || agent.error.value || agent.review.value) agent.dismiss()
  }
  const busy = computed(() => routing.value || agent.busy.value)
  const takesWorking = computed(() => !!takes.value && isTakesWorking(takes.value))
  // One job at a time (Ruling 9): nothing new starts while takes are arriving.
  // A Keep still saving counts too: closing the strip mid-save would skip applying the kept effect.
  const jobBusy = () => busy.value || takesWorking.value || fx.working.value || !!fx.saving?.value
  // A menu item (Variations, Critique…) arriving mid-job says why nothing happens.
  const menuBusy = () => jobBusy() || agent.reviewingManual.value

  async function submit(text: string) {
    // A picture with no words asks to match its look.
    const p = text.trim() || (reference.value ? REFERENCE_ONLY_REQUEST : '')
    if (!p || jobBusy() || agent.reviewingManual.value) return
    clearResults()
    lastSubmitted.value = p
    fastPathFired.value = false // clear the fast-path dedupe latch for this new submit
    const m = mode.value
    mode.value = null
    const c = canvas()
    // A new-effect chip (Remix / New effect) decides the kind itself (spec §4):
    // no router call, so no credit and no wait.
    if (m?.kind === 'new-effect') {
      run('new-effect', p, { nodeId: m.nodeId, effectId: m.effectId, newEffect: m.label === 'New effect', remix: m.label === 'Remix' })
      return
    }
    // Sketch fast path (unchanged from stage 2): a high-confidence image idea
    // fires the pad at once and skips the router (plan ruling 5). The planner
    // still runs; its sketchIdea handler consumes fastPathFired so a `sketch`
    // for the same submit doesn't double-dispatch. A plain "vary it" / "more"
    // passes looksLikeImageIdea but asks for takes, so it always goes to the router.
    if (ready() && !m && !reference.value && !isPlainVaryRequest(p) && looksLikeImageIdea(p, (c?.getNodes?.() ?? []).length === 0)) {
      fastPathFired.value = true
      c.startSketch?.(p)
      agent.ask(p)
      return
    }
    const seq = ++routeSeq
    const ctrl = routeCtrl = new AbortController()
    routing.value = true
    try {
      const r = await route(
        {
          request: p,
          host: 'canvas',
          selection: selection.value.slice(0, ROUTER_SELECTION_MAX).map(s => ({ kind: s.type, name: promptNodeLabel(s).slice(0, ROUTER_NAME_MAX) })),
          mode: m?.label ?? null,
        },
        { apiKey: apiKey(), signal: ctrl.signal },
      )
      if (seq !== routeSeq) return
      routing.value = false
      routeCtrl = null
      run(r.kind, p, { nodeId: m?.nodeId ?? null, followUps: r.followUps })
    } catch {
      // Aborted by stop(): nothing to show.
    } finally {
      if (seq === routeSeq) { routing.value = false; routeCtrl = null }
    }
  }

  function stop() {
    if (routing.value) { routeSeq++; routeCtrl?.abort(); routeCtrl = null; routing.value = false; return }
    if (fx.working.value || fx.session.value) { fx.stop(); return }
    if (takes.value && isTakesWorking(takes.value)) { endTakes(null); return }
    agent.stop()
  }

  // --- menu items (spec §1.2, §4) ----------------------------------------------
  function onPromptKind(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    if (!d.kind || !ready()) return
    if (menuBusy()) { toast.info(BUSY_NOTICE); return }
    clearResults()
    mode.value = null
    lastSubmitted.value = String(d.text ?? '')
    run(d.kind as RouterKind, String(d.text ?? ''), {
      nodeId: d.nodeId != null ? String(d.nodeId) : null, fromMenu: true,
      effectId: d.effectId != null ? String(d.effectId) : null, newEffect: !!d.newEffect,
    })
  }
  function onPromptMode(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    if (!d.label || !d.kind) return
    // Make one / Remix / New effect… / Tune… mid-job: say why nothing happens, as the studios do.
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    clearResults()
    mode.value = {
      label: String(d.label), kind: d.kind as RouterKind, nodeId: d.nodeId != null ? String(d.nodeId) : null,
      effectId: d.effectId != null ? String(d.effectId) : null,
    }
    focusTick.value++
  }
  function clearMode() { mode.value = null }
  // Plan ruling 18: a mode belongs to the node it was set on. So does a reference picture.
  watch(() => selection.value.map(s => s.id).join(','), () => {
    const m = mode.value
    if (m?.nodeId && !selection.value.some(s => s.id === m.nodeId)) mode.value = null
    if (!acceptsReference.value) reference.value = null
  })

  /** A picture pasted or dropped on the prompt while a shader node is selected. A second one
   *  replaces the first. With no new-effect chip it sets New effect on that node (the price shows
   *  before anything runs, no router call); a Remix chip stays. Anywhere else it is ignored. */
  function attachReference(dataUrl: string) {
    if (!acceptsReference.value || !dataUrl) return
    if (jobBusy()) { toast.info(BUSY_NOTICE); return }
    reference.value = dataUrl
    if (mode.value?.kind !== 'new-effect') mode.value = { label: 'New effect', kind: 'new-effect', nodeId: selection.value[0]!.id, effectId: null }
    focusTick.value++
  }
  function clearReference() { reference.value = null }

  // --- what the prompt shows ------------------------------------------------------
  // Only work the user started takes over the prompt row. A background
  // auto-review (after a paid render) runs quietly and leaves the prompt usable.
  const working = computed(() => busy.value || agent.reviewingManual.value || takesWorking.value || fx.working.value)
  const workingLabel = computed(() => {
    // Effect takes quote the request and carry the estimate (plan ruling 14).
    if (fx.working.value) return `${promptWorkingLabel({ request: fx.request.value })} · ${shaderGenPriceText(hosted(), !!fx.reference?.value)}`
    if (takesWorking.value) return promptWorkingLabel({ request: takes.value!.request, takesOf: takes.value!.nodeLabel })
    if (busy.value) return promptWorkingLabel({ request: lastSubmitted.value })
    return promptWorkingLabel({ reviewing: reviewTargetLabel.value })
  })
  const answerCard = computed<AnswerCard | null>(() => {
    if (fx.error.value) return { kind: 'error', text: fx.error.value, reasoning: '', followUps: [] }
    if (fx.notice.value) return { kind: 'notice', text: fx.notice.value, reasoning: '', followUps: [] }
    if (agent.error.value) return { kind: 'error', text: agent.error.value, reasoning: '', followUps: [] }
    if (notice.value) return { kind: 'notice', text: notice.value, reasoning: '', followUps: [] }
    if (agent.answer.value) return { kind: 'answer', text: agent.answer.value, reasoning: agent.reasoning.value, followUps: followUps.value }
    // A review that found issues but proposed no fix: say what it found.
    const r = agent.review.value as { assessment?: string; issues?: string[] } | null
    if (r?.issues?.length && !agent.hasProposal.value) {
      const text = [r.assessment?.trim(), r.issues.map(i => `• ${i}`).join('\n')].filter(Boolean).join('\n\n')
      return { kind: 'answer', text, reasoning: '', followUps: [] }
    }
    return null
  })
  // The result card rides above the prompt once there is something to show.
  // While planning or reviewing, the prompt's own row shows the progress label
  // and Stop — the card never repeats it.
  const card = computed<PromptCard>(() => {
    if (fx.session.value || takes.value) return 'takes'
    if (busy.value) return null
    if (agent.hasProposal.value) return 'changes'
    return answerCard.value ? 'answer' : null
  })
  const showSketchInstead = computed(() => agent.hasProposal.value && !!lastSubmitted.value)
  function dismissAnswer() { notice.value = ''; followUps.value = []; fx.clearMessages(); agent.dismiss() }
  // The price of what a new-effect chip will do (spec §7.2), shown before anything runs.
  const modeNote: ComputedRef<string | null> = computed(() => (mode.value?.kind === 'new-effect' ? shaderGenPriceText(hosted(), !!reference.value) : null))
  // The strip shows the effect set while one is open, else the Variations set.
  const shownTakes = computed<TakesSession | null>(() => fx.session.value ?? takes.value)
  // An effect Keep is saving: the strip's Keep buttons are off until it settles.
  const takesSaving = computed(() => !!fx.session.value && !!fx.saving?.value)
  // A failed Keep leaves the set open, and the card is the strip: the strip shows why.
  const takesError = computed(() => (fx.session.value ? fx.error.value || null : null))
  // "Three more" on an effect set starts another paid set: its price shows on the button first.
  const takesMoreNote = computed<string | null>(() => (fx.session.value ? shaderGenPriceText(hosted(), !!fx.reference?.value) : null))
  // While a node's effect-take strip is open, the node's own controls are read-only, so
  // closing the strip can put back exactly what was there: tell it when the strip opens and closes.
  let lockedNode: string | null = null
  function lockNode(id: string | null) {
    if (id === lockedNode) return
    const tell = (nodeId: string, locked: boolean) => window.dispatchEvent(new CustomEvent('sailor:shaderEffectLock', { detail: { nodeId, locked } }))
    if (lockedNode) tell(lockedNode, false)
    lockedNode = id
    if (id) tell(id, true)
  }
  watch(() => fx.session.value?.nodeId ?? null, lockNode, { flush: 'sync' })
  // The node an effect set previews on was deleted (or cut) while the set is open or running:
  // end it, so no more calls are made (or billed) for it and no Keep lands on a node that isn't
  // there. An undo that brings the node back finds it unlocked and showing its own effect.
  const effectNodePresent = (): boolean => {
    const id = fx.session.value?.nodeId
    if (!id) return true
    const nodes = canvas()?.getNodes?.()
    return !Array.isArray(nodes) || nodes.some((n: any) => String(n.id) === id)
  }
  watch(effectNodePresent, (present) => { if (!present && (fx.session.value || fx.working.value)) fx.close() })

  // The card above the prompt must not cover what it is about: once it has
  // rendered (its height is known), pan just enough that the takes' node, or the
  // proposed and marked nodes, sit clear of the whole prompt stack.
  watch(card, async (c) => {
    if (c !== 'takes' && c !== 'changes') return
    await nextTick()
    const cv = canvas()
    if (c === 'takes' && shownTakes.value) cv?.agentRevealNode?.(shownTakes.value.nodeId)
    else if (c === 'changes') cv?.agentRevealProposal?.()
  })

  // The canvas swapped graphs (project tab, canvas, subgraph). It already put
  // back every previewed take and proposal; drop ours without touching the new
  // graph, whose node ids can collide with the old one's.
  function onCanvasSwapped() {
    // Work still in flight would land its preview on the new graph: stop it.
    if (routing.value) { routeSeq++; routeCtrl?.abort(); routeCtrl = null; routing.value = false }
    if (agent.busy.value || agent.reviewing.value) agent.stop()
    clearResults({ detached: true })
  }
  function runFollowUp(text: string) { void submit(text) }

  onMounted(() => {
    window.addEventListener('sailor:promptKind', onPromptKind)
    window.addEventListener('sailor:promptMode', onPromptMode)
    window.addEventListener('sailor:variationsDone', onVariationsDone)
    window.addEventListener('sailor:variationsQueued', onVariationsQueued)
    window.addEventListener('sailor:runVariations', onRunVariations)
    window.addEventListener('sailor:canvasSwapped', onCanvasSwapped)
    window.addEventListener('message', onRunEvent)
    window.addEventListener('sailor:agentRunComplete', onRunComplete)
    window.addEventListener('sailor:critiqueNode', onCritiqueNode)
    window.addEventListener('sailor:autoReview', onAutoReview)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('sailor:promptKind', onPromptKind)
    window.removeEventListener('sailor:promptMode', onPromptMode)
    window.removeEventListener('sailor:variationsDone', onVariationsDone)
    window.removeEventListener('sailor:variationsQueued', onVariationsQueued)
    window.removeEventListener('sailor:runVariations', onRunVariations)
    window.removeEventListener('sailor:canvasSwapped', onCanvasSwapped)
    window.removeEventListener('message', onRunEvent)
    window.removeEventListener('sailor:agentRunComplete', onRunComplete)
    window.removeEventListener('sailor:critiqueNode', onCritiqueNode)
    window.removeEventListener('sailor:autoReview', onAutoReview)
    for (const t of autoReviewTimers.values()) clearTimeout(t)
    if (warmFocusTimer) clearTimeout(warmFocusTimer)
    thinking.value = false
    // A route still in flight must not start work after unmount.
    routeSeq++
    routeCtrl?.abort()
    routeCtrl = null
    if (takes.value) endTakes(null)
    lockNode(null)
  })

  return {
    agent, selection, chipLabel, suggestions, mode, focusTick, reference, acceptsReference, attachReference, clearReference, working, workingLabel, lastSubmitted,
    card, answerCard, takes: shownTakes, takesSaving, takesError, takesMoreNote, modeNote, showSketchInstead, searchOpen, searchQuery, onSearchDone,
    submit, stop, clearMode, clearSelection, onPromptFocus, previewTake, keepTake, closeTakes,
    moreTakes, dismissAnswer, runFollowUp, sketchInstead,
  }
}
