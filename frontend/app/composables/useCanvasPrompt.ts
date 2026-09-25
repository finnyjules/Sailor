/**
 * useCanvasPrompt — everything the canvas's one prompt does (AI in Sailor spec
 * §3, §4). A request is routed (one Haiku call; a mode chip or a menu item
 * decides the kind without it), handed to the canvas worker for that kind
 * (canvasDispatch), and what comes back is held here: three takes above the
 * prompt, a proposed change, or an answer. CanvasPromptHost.vue only renders
 * it. `canvas` returns VueNodeCanvas's exposed API (null until it mounts).
 * Formerly CanvasPromptBar.vue's script (stage 2), plus the router and results.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useCanvasAgent } from '~/composables/useCanvasAgent'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { paidProducerFor } from '~/lib/artifact/nextSteps'
import { looksLikeImageIdea } from '~/lib/sketch/sketchIntent'
import { canvasSuggestions, promptNodeLabel, promptWorkingLabel, selectionLabel, type PromptNode } from '~/lib/prompt/canvasPromptContext'
import { canvasDispatch, isPlainVaryRequest, type DispatchTarget } from '~/lib/prompt/canvasDispatch'
import { routeRequest } from '~/lib/prompt/routeRequest'
import {
  chooseTile, failPending, hoverTile, ingestTakes, isTakesWorking, openTakes, readyCount, settleExpected,
  shownTakeId, TAKES_PER_SET, type TakesSession,
} from '~/lib/prompt/takesSession'
import type { RouterKind } from '~~/shared/promptRouter/router'

export interface PromptMode { label: string; kind: RouterKind; nodeId: string | null }
export type PromptCard = 'takes' | 'changes' | 'answer' | null
export interface AnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }

export function useCanvasPrompt(canvas: () => any, deps: { route?: typeof routeRequest } = {}) {
  const route = deps.route ?? routeRequest
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
  // (`waitingSid`) and dispatches on that run's `variationsDone`; a
  // `variationsDone` only ever settles the set whose own run produced it.
  let sessionSid = 0
  let dispatchingSid: number | null = null
  let waitingSid: number | null = null
  let loop: { nodeId: string; sid: number | null } | null = null
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
  function startTakes(t: DispatchTarget) {
    const c = canvas()
    const snap = c?.agentNodeTakes?.(t.nodeId)
    if (!snap) { notice.value = 'That node isn’t on the canvas any more.'; return }
    const sid = ++sessionSid
    takes.value = { ...openTakes({ nodeId: t.nodeId, nodeLabel: t.label, request: '', takes: snap.takes, images: snap.images }), loopDone: false }
    c.agentTakesBegin(t.nodeId)
    if (loop) waitingSid = sid
    else dispatchRun(sid, t.nodeId)
  }
  function endTakes(keepId: string | null) {
    const s = takes.value
    if (!s) return
    waitingSid = null
    // Our run still going (tiles pending, or failed early while more are queued): stop it.
    if (loop?.sid === sessionSid) window.dispatchEvent(new CustomEvent('sailor:stopVariations', { detail: { nodeId: s.nodeId } }))
    canvas()?.agentTakesEnd?.(s.nodeId, keepId)
    takes.value = null
  }
  const show = (s: TakesSession) => canvas()?.agentShowTake?.(s.nodeId, shownTakeId(s))
  // A landing take is appended AND made active (appendTake); re-show whatever the
  // strip says (the version at open, or the hovered/chosen tile) so the node
  // doesn't jump. The first arrival pans the node into view if it's off screen.
  watch(
    () => { const s = takes.value; return s ? canvas()?.agentNodeTakes?.(s.nodeId) ?? null : null },
    (snap) => {
      const s = takes.value
      if (!s || !snap) return
      let next = ingestTakes(s, snap.takes)
      if (snap.error && isTakesWorking(next)) next = failPending(next)
      if (next === s) return
      if (!readyCount(s) && readyCount(next)) canvas()?.agentRevealNode?.(s.nodeId)
      takes.value = next
      show(next)
    },
  )
  function onVariationsDone(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    const ran = loop
    loop = null
    const s = takes.value
    if (!s) return
    if (ran?.sid === sessionSid && String(d.nodeId) === s.nodeId) {
      // Our own run ended. Cancelled from elsewhere (the top bar's Stop): nothing more is coming.
      const settled = d.cancelled ? failPending(s) : settleExpected(s, Number(d.queued) || 0)
      takes.value = { ...settled, loopDone: true }
      return
    }
    // Someone else's run (or a set we stopped) finished: ours can start now.
    if (waitingSid === sessionSid) { waitingSid = null; dispatchRun(sessionSid, s.nodeId) }
  }
  function previewTake(id: string | null) { const s = takes.value; if (!s) return; takes.value = hoverTile(s, id); show(takes.value) }
  function chooseTake(id: string) { const s = takes.value; if (!s) return; takes.value = chooseTile(s, id); show(takes.value) }
  function keepTake(id: string) { endTakes(id) }
  function closeTakes() { endTakes(null) }
  function moreTakes() {
    const s = takes.value
    // Only once this set's run has reported done: until then the layout would drop a new one.
    if (!s || isTakesWorking(s) || !s.loopDone) return
    const t = targetFor(s.nodeId)
    endTakes(null)
    if (t) startTakes(t)
  }

  // --- dispatch (spec §4) -----------------------------------------------------
  function run(kind: RouterKind, text: string, o: { nodeId?: string | null; fromMenu?: boolean; followUps?: string[] } = {}) {
    const target = targetFor(o.nodeId)
    const d = canvasDispatch(kind, text, target, { fromMenu: o.fromMenu })
    if (d.worker === 'message') { notice.value = d.message; return }
    if (d.worker === 'variations') { startTakes(target!); return }
    if (d.worker === 'fix') {
      reviewTargetLabel.value = target?.label ?? ''
      agent.reviewNode(d.nodeId, canvas()?.agentNodeIntent?.(d.nodeId) ?? '')
      return
    }
    followUps.value = kind === 'answer' ? (o.followUps ?? []) : []
    agent.ask(text)
  }
  function clearResults() {
    if (takes.value) endTakes(null)
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
  const jobBusy = () => busy.value || takesWorking.value

  async function submit(text: string) {
    const p = text.trim()
    if (!p || jobBusy() || agent.reviewingManual.value) return
    clearResults()
    lastSubmitted.value = p
    fastPathFired.value = false // clear the fast-path dedupe latch for this new submit
    const m = mode.value
    mode.value = null
    const c = canvas()
    // Sketch fast path (unchanged from stage 2): a high-confidence image idea
    // fires the pad at once and skips the router (plan ruling 5). The planner
    // still runs; its sketchIdea handler consumes fastPathFired so a `sketch`
    // for the same submit doesn't double-dispatch. A plain "vary it" / "more"
    // passes looksLikeImageIdea but asks for takes, so it always goes to the router.
    if (ready() && !m && !isPlainVaryRequest(p) && looksLikeImageIdea(p, (c?.getNodes?.() ?? []).length === 0)) {
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
        { request: p, host: 'canvas', selection: selection.value.map(s => ({ kind: s.type, name: promptNodeLabel(s) })), mode: m?.label ?? null },
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
    if (takes.value && isTakesWorking(takes.value)) { endTakes(null); return }
    agent.stop()
  }

  // --- menu items (spec §1.2, §4) ----------------------------------------------
  function onPromptKind(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    if (!d.kind || jobBusy() || !ready()) return
    clearResults()
    mode.value = null
    lastSubmitted.value = String(d.text ?? '')
    run(d.kind as RouterKind, String(d.text ?? ''), { nodeId: d.nodeId != null ? String(d.nodeId) : null, fromMenu: true })
  }
  function onPromptMode(e: Event) {
    const d = (e as CustomEvent).detail ?? {}
    if (!d.label || !d.kind || jobBusy()) return
    clearResults()
    mode.value = { label: String(d.label), kind: d.kind as RouterKind, nodeId: d.nodeId != null ? String(d.nodeId) : null }
    focusTick.value++
  }
  function clearMode() { mode.value = null }
  // Plan ruling 18: a mode belongs to the node it was set on.
  watch(() => selection.value.map(s => s.id).join(','), () => {
    const m = mode.value
    if (m?.nodeId && !selection.value.some(s => s.id === m.nodeId)) mode.value = null
  })

  // --- what the prompt shows ------------------------------------------------------
  // Only work the user started takes over the prompt row. A background
  // auto-review (after a paid render) runs quietly and leaves the prompt usable.
  const working = computed(() => busy.value || agent.reviewingManual.value || takesWorking.value)
  const workingLabel = computed(() => {
    if (takesWorking.value) return promptWorkingLabel({ request: takes.value!.request, takesOf: takes.value!.nodeLabel })
    if (busy.value) return promptWorkingLabel({ request: lastSubmitted.value })
    return promptWorkingLabel({ reviewing: reviewTargetLabel.value })
  })
  const answerCard = computed<AnswerCard | null>(() => {
    if (agent.error.value) return { kind: 'error', text: agent.error.value, reasoning: '', followUps: [] }
    if (notice.value) return { kind: 'notice', text: notice.value, reasoning: '', followUps: [] }
    if (agent.answer.value) return { kind: 'answer', text: agent.answer.value, reasoning: agent.reasoning.value, followUps: followUps.value }
    return null
  })
  // The result card rides above the prompt once there is something to show.
  // While planning or reviewing, the prompt's own row shows the progress label
  // and Stop — the card never repeats it.
  const card = computed<PromptCard>(() => {
    if (takes.value) return 'takes'
    if (busy.value) return null
    if (agent.hasProposal.value) return 'changes'
    return answerCard.value ? 'answer' : null
  })
  const showSketchInstead = computed(() => agent.hasProposal.value && !!lastSubmitted.value)
  function dismissAnswer() { notice.value = ''; followUps.value = []; agent.dismiss() }
  function runFollowUp(text: string) { void submit(text) }

  onMounted(() => {
    window.addEventListener('sailor:promptKind', onPromptKind)
    window.addEventListener('sailor:promptMode', onPromptMode)
    window.addEventListener('sailor:variationsDone', onVariationsDone)
    window.addEventListener('sailor:runVariations', onRunVariations)
    window.addEventListener('sailor:agentRunComplete', onRunComplete)
    window.addEventListener('sailor:critiqueNode', onCritiqueNode)
    window.addEventListener('sailor:autoReview', onAutoReview)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('sailor:promptKind', onPromptKind)
    window.removeEventListener('sailor:promptMode', onPromptMode)
    window.removeEventListener('sailor:variationsDone', onVariationsDone)
    window.removeEventListener('sailor:runVariations', onRunVariations)
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
  })

  return {
    agent, selection, chipLabel, suggestions, mode, focusTick, working, workingLabel, lastSubmitted,
    card, answerCard, takes, showSketchInstead, searchOpen, searchQuery, onSearchDone,
    submit, stop, clearMode, clearSelection, onPromptFocus, previewTake, chooseTake, keepTake, closeTakes,
    moreTakes, dismissAnswer, runFollowUp, sketchInstead,
  }
}
