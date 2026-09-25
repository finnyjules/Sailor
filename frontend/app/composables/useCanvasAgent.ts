/**
 * useCanvasAgent — the node-canvas agent (Phase 3, Slice 1). Handles BOTH:
 *  • questions about the graph → a plain answer (the "message" channel), and
 *  • edits to existing nodes (setWidget / setMode / deleteNode) → a proposal.
 *
 * Ghost-preview lifecycle: as the proposal is built/toggled, the accepted
 * commands are rendered on the canvas as semi-transparent pastel GHOSTS
 * (opts.preview); a dry-run over a CanvasSnapshot drives the health readout. On
 * Keep, opts.commit promotes the ghosts to real nodes/edges (+ a glimm sweep);
 * on Dismiss, opts.discard removes them.
 */
import { computed, ref } from 'vue'
import type { Command } from '~/lib/agent/commandSurface'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import { applyCanvasCommand, describeCanvas, scopeSnapshotToUpstream, searchImageRequests, sketchRequests, summarizeCanvasChange, verifyCanvas, type CanvasSnapshot } from '~/lib/agent/surfaces/canvas'
import { buildAgentPrompt, buildCommandSchema, buildResultReviewPrompt, buildReviewSchema, parseAgentResponse, parseReviewResponse, RESULT_REVIEW_SYSTEM } from '~/lib/agent/protocol'
import { useNextStepsStrip, type FixChip } from '~/composables/useNextStepsStrip'
import { ACTION_HINTS } from '~/lib/artifact/nextSteps'
import type { LayoutIssue } from '~/lib/agent/verify'
import { useAgentActivity } from '~/composables/useAgentActivity'
import { isFastLanePlacement } from '~/lib/agent/fastlane'
import { capabilityByType } from '~/lib/agent/capabilities'

const REROLLABLE = new Set(['setWidget', 'setMode', 'addNode'])
const clone = (s: CanvasSnapshot): CanvasSnapshot => JSON.parse(JSON.stringify(s)) as CanvasSnapshot

export function useCanvasAgent(opts: {
  /** phrase lets the snapshot tailor its node palette (catalog) to the request. */
  getSnapshot: (phrase?: string) => CanvasSnapshot
  /** Render the accepted commands on the canvas as semi-transparent ghosts.
   *  animate plays the ~1s blueprint draw-in (used on the first proposal). */
  preview: (commands: Command[], animate?: boolean) => void | Promise<unknown>
  /** Promote the ghosts to real nodes/edges (+ glimm). Called on Keep. Returns the
   *  ids of the nodes it committed (so Keep & Run can run them). */
  commit: () => string[] | void
  /** Run the given nodes (Keep & Run). Optional — only the canvas surface runs. */
  run?: (targetIds: string[]) => void
  /** The run's output image as a data URL, for the run→look→fix review loop. */
  runOutputImage?: (targetIds: string[]) => Promise<string | null>
  /** Resolve review targets → the OUTPUT/result node id (past a generator to its
   *  result card), so the "scanning" overlay lands on the output, not the generator. */
  resolveResultNode?: (targetIds: string[]) => string | null
  /** Bring the given nodes into view — used by the fast lane, which places a
   *  node at a fixed graph position without the blueprint animation. */
  frameNodes?: (ids: string[]) => void
  /** Remove the ghosts. Called on Dismiss. */
  discard: () => void
  /** Delegate tuneNode commands to each target node's OWN studio surface (applied
   *  in place). Returns proposal rows + an optional notice. */
  tune?: (cmds: { target: string; request: string }[]) => Promise<{ changes: ProposedChange[]; notice?: string }>
  /** Undo the in-place studio-tune edits. Called on Dismiss. */
  tuneRevert?: () => void
  /** Open the web-image-search picker for a `searchImages` command's query. The
   *  picker owns the rest (search → user picks → import as Image nodes). */
  searchImages?: (query: string) => void
  /** Fire the sketch pad for a `sketch` command's image idea. Intercept-only —
   *  never becomes a proposal card, never touches the graph. */
  sketchIdea?: (prompt: string) => void
  apiKey: () => string
  tier?: string
}) {
  const busy = ref(false)
  const error = ref('')
  const reasoning = ref('')
  /** Plain-language answer for questions / out-of-scope asks (no commands). */
  const answer = ref('')
  const changes = ref<ProposedChange[]>([])
  const issues = ref<LayoutIssue[]>([])
  const hovered = ref<number | null>(null)
  const lastPhrase = ref('')
  /** Run→look→fix: a designer's-eye critique of the RUN's actual output. */
  const review = ref<VisualReview | null>(null)
  const reviewing = ref(false)
  /** True while a USER-started review runs (a manual critique / the Fix action, or
   *  the review a Keep & Run armed). Background auto-reviews leave it false, so
   *  they never take over the prompt row. */
  const reviewingManual = ref(false)
  // Auto-critique publishes its fixes as chips on the artifact's strip.
  const nextStepsStrip = useNextStepsStrip()
  /** Shared set of node ids under review — drives each node's scanning overlay. */
  const { analyzingNodeIds } = useAgentActivity()
  /** Set by Keep & Run; consumed once when the run completes. */
  let pendingReview: { targets: string[]; intent: string } | null = null
  let original: CanvasSnapshot | null = null
  const hasProposal = computed(() => changes.value.length > 0)
  // Stop lifecycle (per-instance, not shared across useCanvasAgent() calls): an
  // in-flight ask() aborts via `controller`; `runSeq` bumps on every ask() and
  // every stop() so a reply for an older run is ignored even if the abort
  // itself doesn't win the race (e.g. the fetch had already resolved).
  let controller: AbortController | null = null
  let runSeq = 0
  // Same pattern for a user-started review, so Stop can cancel it too.
  let reviewController: AbortController | null = null
  let reviewSeq = 0

  async function callModel(prompt: string, commands: { op: string }[], signal?: AbortSignal) {
    const res = await $fetch<{ text: string }>('/api/agent-plan', {
      method: 'POST',
      body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', prompt, schema: buildCommandSchema(commands) },
      timeout: 60_000,
      signal,
    })
    const parsed = parseAgentResponse(res.text)
    if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
    reasoning.value = parsed.reasoning
    return parsed
  }

  const acceptedCommands = () => changes.value.filter(c => c.accepted).map(c => c.command)

  /** Re-derive the dry-run health readout AND refresh the on-canvas ghost preview
   *  from the currently-accepted commands. */
  function recompute() {
    if (!original) return
    let s = clone(original)
    for (const cmd of acceptedCommands()) {
      const r = applyCanvasCommand(s, cmd)
      if (r.ok) s = r.template
    }
    issues.value = verifyCanvas(s)
    opts.preview(acceptedCommands(), false) // ghosts on the canvas (instant — no re-blueprint on toggle)
  }

  function buildChange(probe: CanvasSnapshot, cmd: Command, rationale: string): ProposedChange | null {
    if (!applyCanvasCommand(probe, cmd).ok) return null
    const sum = summarizeCanvasChange(probe, cmd) ?? { label: cmd.op, before: '', after: '', modelLabel: cmd.op }
    return { command: cmd, label: sum.label, modelLabel: sum.modelLabel, before: sum.before, after: sum.after, rationale, rerollable: REROLLABLE.has(cmd.op), accepted: true }
  }

  async function ask(phrase: string) {
    const p = phrase.trim()
    if (!p || busy.value) return
    const seq = ++runSeq
    controller = new AbortController()
    busy.value = true; error.value = ''; reasoning.value = ''; answer.value = ''; issues.value = []; lastPhrase.value = p
    review.value = null // drop any stale run→look→fix critique so it doesn't bleed into a fresh request
    opts.discard(); opts.tuneRevert?.(); changes.value = [] // clear any prior un-kept ghost / tune preview
    try {
      original = clone(opts.getSnapshot(p))
      const desc = describeCanvas(original)
      const { commands, changeRationales, message } = await callModel(buildAgentPrompt(desc, p), desc.commands, controller.signal)
      if (seq !== runSeq) return
      // Graph ops are ghost-previewed; tuneNode is delegated to a node's OWN studio
      // surface (e.g. a Frame's background) and applied in place.
      const graphBuilt: ProposedChange[] = []
      const tuneInputs: { target: string; request: string }[] = []
      let probe = clone(original)
      commands.forEach((cmd, i) => {
        if (cmd.op === 'searchImages') return // intercepted below — opens the picker, never a proposal card
        if (cmd.op === 'sketch') return // intercepted below — fires the sketch pad, never a proposal card
        if (cmd.op === 'tuneNode') {
          const req = typeof cmd.args?.request === 'string' ? cmd.args.request : ''
          if (cmd.target && req) tuneInputs.push({ target: cmd.target, request: req })
          return
        }
        const ch = buildChange(probe, cmd, changeRationales[i] ?? '')
        if (!ch) return
        graphBuilt.push(ch)
        const r = applyCanvasCommand(probe, cmd)
        if (r.ok) probe = r.template
      })
      // FAST LANE: a single generator/studio placement the user already fully
      // described (e.g. "a red fox in snow") needs no proposal ceremony. Commit
      // it through the SAME path as the Keep button (undo/glimm/id-map identical),
      // focus it, confirm in one line — and DO NOT run it (spending stays the
      // user's explicit act on the node). Anything else falls through to the
      // normal ghost → Keep/Reject flow below.
      if (isFastLanePlacement(commands) && graphBuilt.length === 1) {
        // Blueprint the ghost, then promote it exactly like keep() does.
        await opts.preview(graphBuilt.map(c => c.command), true) // commit only once it's all on the canvas
        if (seq !== runSeq) return
        const committed = opts.commit() || []
        changes.value = []; original = null; issues.value = []; review.value = null
        // Bring the placed node into view — it lands at a fixed graph position
        // without the blueprint animation, so it could otherwise be off-screen.
        if (committed.length) opts.frameNodes?.(committed)
        const nodeType = commands[0]!.args?.nodeType as string
        const title = capabilityByType(nodeType)?.title ?? 'the node'
        answer.value = message?.trim()
          ? message.trim()
          : `Added ${title} — press Run when you're ready.`
        // (intentionally no opts.run call here — never auto-run a billable node)
        return
      }
      // Graph-health readout is about graph structure — only when graph changed.
      issues.value = graphBuilt.length ? verifyCanvas(probe) : []
      // Blueprint first (for ADDED graph nodes) — this materialises the ghost nodes
      // AND populates the placeholder→real id map, so a tuneNode targeting a
      // just-added Frame ($new1) can resolve it. Keep `busy` true so the grid sparks
      // animate through the blueprint.
      if (graphBuilt.length) {
        opts.preview(graphBuilt.map(c => c.command), true)
        await new Promise(r => setTimeout(r, 1800)) // matches the blueprint duration
        if (seq !== runSeq) return
      }
      // Studio-tune delegations run AFTER the ghosts exist (applied in place).
      let tuneBuilt: ProposedChange[] = []
      let tuneNotice = ''
      if (tuneInputs.length && opts.tune) {
        const res = await opts.tune(tuneInputs)
        if (seq !== runSeq) return
        tuneBuilt = res.changes
        tuneNotice = res.notice ?? ''
      }
      // Web-image search: hand the query to the picker (one search per ask — the
      // hint tells the model to emit a single searchImages).
      const searchQueries = searchImageRequests(commands)
      if (searchQueries.length && opts.searchImages) opts.searchImages(searchQueries[0]!)
      // Sketch pad: hand the idea to the sketch renderer (one idea per ask, like
      // searchImages — the hint tells the model to emit a single sketch).
      const sketchIdeas = sketchRequests(commands)
      if (sketchIdeas.length && opts.sketchIdea) opts.sketchIdea(sketchIdeas[0]!)
      const built = [...graphBuilt, ...tuneBuilt]
      if (!built.length) {
        if (searchQueries.length && opts.searchImages) { answer.value = tuneNotice || message; return } // the picker is the response
        if (sketchIdeas.length && opts.sketchIdea) { answer.value = ''; return } // the pad is the response
        answer.value = tuneNotice || message || (commands.length ? 'I couldn’t apply those edits to this graph.' : 'No changes for that — try rephrasing.')
        return
      }
      if (tuneNotice) answer.value = tuneNotice
      changes.value = built
    } catch (e: any) {
      if (seq !== runSeq) return // aborted by stop() — not an error to show
      error.value = e?.data?.message || e?.message || String(e)
      opts.discard(); opts.tuneRevert?.()
    } finally {
      if (seq === runSeq) { busy.value = false; controller = null }
    }
  }

  /** Stop: abort the in-flight /api/agent-plan call, discard the ghost preview
   *  (+ any in-place studio-tune edit), and clear proposal state. Bumps runSeq
   *  so a reply that lands after this — the abort didn't win the race, or the
   *  network already had the response in flight — changes nothing. */
  function stop() {
    if (!busy.value && reviewingManual.value) { stopReview(); return }
    if (!busy.value) return
    runSeq++
    controller?.abort()
    controller = null
    opts.discard(); opts.tuneRevert?.()
    changes.value = []; answer.value = ''; error.value = ''; issues.value = []; reasoning.value = ''
    busy.value = false
  }

  /** Stop a user-started review: abort its call and drop whatever it would have
   *  shown. The scanning overlay clears with it. */
  function stopReview() {
    reviewSeq++
    reviewController?.abort()
    reviewController = null
    reviewing.value = false; reviewingManual.value = false
    analyzingNodeIds.value = new Set()
  }

  function acceptChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = true; recompute() } }
  function rejectChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = false; recompute() } }

  async function reroll(i: number) {
    const ch = changes.value[i]
    if (!ch || !ch.rerollable || !original || busy.value) return
    // Same Stop lifecycle as ask(): a reply after stop() (or after a newer run
    // started) changes nothing, and only this run may clear its own busy.
    const seq = ++runSeq
    const ctrl = controller = new AbortController()
    busy.value = true; error.value = ''
    try {
      const nonce = Math.random().toString(36).slice(2, 7)
      const intent = lastPhrase.value ? `The user's original request was: "${lastPhrase.value}". ` : ''
      const phrase = `${intent}Re-roll ONLY the "${ch.modelLabel ?? ch.label}" change (currently "${ch.after}"). Propose a DIFFERENT value that still satisfies the request — not "${ch.after}". Same op "${ch.command.op}"${ch.command.target ? ` on "${ch.command.target}"` : ''}; change nothing else. (variation ${nonce})`
      const rdesc = describeCanvas(opts.getSnapshot(lastPhrase.value))
      const { commands, changeRationales } = await callModel(buildAgentPrompt(rdesc, phrase), rdesc.commands, ctrl.signal)
      if (seq !== runSeq || !original) return
      const idx = commands.findIndex(c => c.op === ch.command.op && (c.target ?? '') === (ch.command.target ?? ''))
      const next = idx >= 0 ? commands[idx] : commands[0]
      if (next) {
        const rebuilt = buildChange(clone(original), next, (idx >= 0 ? changeRationales[idx] : changeRationales[0]) ?? ch.rationale)
        if (rebuilt) { rebuilt.accepted = ch.accepted; changes.value.splice(i, 1, rebuilt) }
      }
      recompute()
    } catch (e: any) {
      if (seq !== runSeq) return // aborted by stop() — not an error to show
      error.value = e?.data?.message || e?.message || String(e)
    } finally {
      if (seq === runSeq) { busy.value = false; controller = null }
    }
  }

  /** The nodes a Keep should be able to run: the just-committed (added/tuned) nodes
   *  plus any existing node a setWidget/setMode/tuneNode targeted. Excludes deletes
   *  and unresolved "$new" placeholders (committed ids already cover added nodes). */
  function runTargets(committed: string[]): string[] {
    const touched = changes.value
      .filter(c => ['setWidget', 'setMode', 'tuneNode'].includes(c.command.op))
      .map(c => c.command.target)
      .filter((t): t is string => typeof t === 'string' && !t.startsWith('$'))
    return Array.from(new Set([...committed, ...touched]))
  }

  /** Commit: promote the on-canvas ghosts to real nodes/edges (+ glimm). */
  async function keep() {
    opts.commit()
    changes.value = []; original = null; issues.value = []; review.value = null
  }
  /** Keep, then run the resulting node(s) — one click for the common build→run flow. */
  async function keepAndRun() {
    const committed = opts.commit() || []
    const targets = runTargets(committed)
    const intent = lastPhrase.value
    changes.value = []; original = null; issues.value = []; review.value = null
    if (targets.length) {
      opts.run?.(targets)
      // Arm the run→look→fix loop: when this run finishes, review its output.
      if (opts.runOutputImage) pendingReview = { targets, intent }
    }
  }

  /** Run→look→fix core (suggest-only): look at a run's actual output for `targets`,
   *  and if it falls short of `intent` propose fixes. Manual / Keep & Run mode
   *  surfaces them as Keep/Dismiss cards; `auto` mode (paid-render auto-critique)
   *  publishes them as pastel chips on the artifact's next-steps strip instead —
   *  quiet on success, silent on failure, and never clobbers a pending proposal.
   *  The user decides — nothing is auto-applied or auto-re-run. */
  async function runReview(targets: string[], intent: string, mode: { manual?: boolean; auto?: boolean } = {}) {
    const { manual = false, auto = false } = mode
    if (busy.value || reviewing.value || !opts.runOutputImage) return
    if (auto && changes.value.length) return // a pending proposal owns the UI — skip this pass
    if (!auto) {
      opts.discard(); opts.tuneRevert?.(); changes.value = []; review.value = null; answer.value = ''; error.value = ''
    }
    reviewing.value = true
    reviewingManual.value = !auto
    const rseq = ++reviewSeq
    const rctrl = reviewController = new AbortController()
    // Mark the OUTPUT node under review so the white "scanning" overlay lands on
    // the result (past a generator to its result card), not the generator itself.
    const resultNode = opts.resolveResultNode?.(targets)
    analyzingNodeIds.value = new Set(resultNode ? [resultNode] : targets.map(String))
    try {
      const image = await opts.runOutputImage(targets)
      if (rseq !== reviewSeq) return
      if (!image) { if (manual) answer.value = 'No result on that node yet — run it first, then critique.'; return }
      // The output is definitely present now — re-resolve so the scan lands on a
      // freshly-produced downstream output (e.g. a re-run's new EditImage result)
      // that may not have existed when we first set analyzingNodeIds above.
      const freshNode = opts.resolveResultNode?.(targets)
      if (freshNode) analyzingNodeIds.value = new Set([freshNode])
      const snap = clone(opts.getSnapshot(intent))
      if (!auto) original = snap
      // Auto mode reviews ONE artifact: describe only it + its upstream chain.
      // Fewer prompt tokens AND less off-target noise for the model. Fix commands
      // still probe against the FULL snapshot (they only ever target the scoped
      // nodes, but the probe must see the whole graph to validate wiring).
      const descTarget = auto ? String(freshNode ?? resultNode ?? targets[0]) : null
      const desc = describeCanvas(descTarget ? scopeSnapshotToUpstream(snap, descTarget) : snap)
      const res = await $fetch<{ text: string }>('/api/agent-review', {
        method: 'POST',
        // system = the static ~3k-token instruction, cached server-side (ephemeral
        // prefix cache) so clustered reviews pay ~0.1× for it.
        body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', system: RESULT_REVIEW_SYSTEM, prompt: buildResultReviewPrompt(desc, intent), schema: buildReviewSchema(desc.commands), image },
        timeout: 60_000,
        signal: rctrl.signal,
      })
      if (rseq !== reviewSeq) return // stopped while the model was looking
      const parsed = parseReviewResponse(res.text)
      if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
      const { assessment, issues: found, fixes, fixRationales, fixLabels } = parsed
      const built: ProposedChange[] = []
      const builtLabels: string[] = []
      let probe = clone(snap)
      fixes.forEach((cmd, i) => {
        const ch = buildChange(probe, cmd, fixRationales[i] || 'From the visual review')
        if (!ch) return
        ch.fromReview = true
        built.push(ch)
        builtLabels.push(fixLabels[i] || (fixRationales[i] || '').slice(0, 30) || 'Fix issues')
        const r = applyCanvasCommand(probe, cmd)
        if (r.ok) probe = r.template
      })
      if (auto) {
        // Chips only — no bar cards, no "looks right", no review banner.
        const chipNode = String(freshNode ?? resultNode ?? targets[0])
        if (built.length) {
          const chips: FixChip[] = built.map((ch, i) => ({
            id: i,
            label: builtLabels[i]!,
            // Only the Nano-Banana edit has a fixed price; widget/seed fixes vary.
            hint: JSON.stringify(ch.command).includes('EditImageNode') ? ACTION_HINTS['nano-banana'] : null,
            apply: () => applyReviewFix(ch, chipNode),
          }))
          nextStepsStrip.announceFixes(chipNode, chips)
        }
        return
      }
      review.value = { assessment, issues: found }
      if (built.length) { changes.value = built; recompute() }
      else if (!found.length) answer.value = '✓ Looks right — the result matches what you asked.'
    } catch (e: any) {
      if (rseq !== reviewSeq) return // aborted by stop()
      if (manual) error.value = e?.data?.message || (e instanceof Error ? e.message : 'Couldn’t review the result.')
      else if (auto) console.warn('[AutoReview] failed silently:', e)
    } finally {
      if (rseq === reviewSeq) { reviewing.value = false; reviewingManual.value = false; reviewController = null; analyzingNodeIds.value = new Set() }
    }
  }

  /** Chip click: apply exactly ONE review fix through the normal preview→commit
   *  seam. The spliced EditImageNode lands configured + selected, UN-RUN — the
   *  user aims (or just hits its Run) before anything bills. */
  async function applyReviewFix(change: ProposedChange, nodeId: string) {
    if (busy.value || reviewing.value) return
    try {
      await opts.preview([change.command], false) // commit only once it's all on the canvas
      opts.commit()
    } catch (e) {
      console.warn('[AutoReview] fix apply failed:', e)
    } finally {
      nextStepsStrip.clearFixes(nodeId)
    }
  }

  /** Auto: paid render finished → quiet chip-producing review (gated upstream). */
  async function autoReviewNode(nodeId: string, intent: string) {
    await runReview([nodeId], intent || 'this image', { auto: true })
  }

  /** Auto: fires when a Keep & Run finishes (a review is armed). */
  async function reviewLastRun() {
    if (!pendingReview) return
    const { targets, intent } = pendingReview
    pendingReview = null // one pass; the user re-arms by Keep & Run-ing a fix
    await runReview(targets, intent)
  }

  /** On-demand: critique ANY result node (its output vs the prompt that made it). */
  async function reviewNode(nodeId: string, intent: string) {
    await runReview([nodeId], intent || 'this image', { manual: true })
  }
  /** Dismiss: remove the ghost preview + undo any in-place studio-tune edits. */
  function dismiss() { opts.discard(); opts.tuneRevert?.(); changes.value = []; original = null; issues.value = []; answer.value = ''; error.value = ''; review.value = null; pendingReview = null }

  return { busy, error, reasoning, answer, changes, issues, review, reviewing, reviewingManual, hasProposal, hovered, lastPhrase, ask, stop, acceptChange, rejectChange, reroll, keep, keepAndRun, reviewLastRun, reviewNode, autoReviewNode, dismiss }
}
