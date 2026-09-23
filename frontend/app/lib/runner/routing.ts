/**
 * Which window, tab and canvas a runner event belongs to. Runner events reach
 * every window of the user (one event stream per user), carry the run's
 * `canvas_id`, and must never land on another project's canvas by node id.
 * Pure helpers, used by layouts/default.vue and VueNodeCanvas.vue.
 */
import { isProjectDoc } from '~/lib/projectDoc'
import { isRunnerPromptId, RUNNER_WORKER } from '#shared/runner/messages'
import { runIdOfPrompt } from '~/lib/runner/client'

/** The open project tab whose document owns this canvas (its active canvas or any of its canvases), or null. */
export function ownerTabForCanvas(
  tabs: ReadonlyArray<{ id: string; type?: string }>,
  docs: Record<string, unknown>,
  canvasId: string | null | undefined,
): string | null {
  if (!canvasId) return null
  for (const tab of tabs) {
    if (tab.type !== 'project') continue
    const doc = docs[tab.id]
    if (!isProjectDoc(doc)) continue
    if (doc.activeCanvasId === canvasId || doc.canvases.some(c => c.id === canvasId)) return tab.id
  }
  return null
}

/**
 * How the canvas treats an event:
 *   'comfy'  — not a runner event: ComfyUI's own routing, unchanged;
 *   'route'  — a registered runner stage with a known canvas: the per-run routing
 *              (it buffers results for a canvas that is not on screen);
 *   'apply'  — an unregistered runner event naming the canvas on screen;
 *   'ignore' — any other runner event. The displayed-canvas fallback never applies.
 */
export type RunnerEventScope = 'comfy' | 'route' | 'apply' | 'ignore'

export function runnerEventScope(i: {
  promptId: string | null | undefined
  registered: boolean
  /** The run's canvas as this window knows it (registry / local cache / the event). */
  knownCanvasId: string | null | undefined
  eventCanvasId: string | null | undefined
  displayedCanvasId: string | null | undefined
}): RunnerEventScope {
  if (!isRunnerPromptId(i.promptId)) return 'comfy'
  if (i.registered) return i.knownCanvasId != null ? 'route' : 'ignore'
  return i.eventCanvasId != null && i.eventCanvasId === i.displayedCanvasId ? 'apply' : 'ignore'
}

/**
 * Holds runner events that arrive before this window has registered their run
 * (the server starts a leg before the POST that asked for it returns). While
 * any runner POST is in flight, every unregistered runner event is held, per
 * run id (the part before the first dot, so stage keys and leg ids share one).
 */
export function createRunnerEventBuffer<T = unknown>() {
  let inFlight = 0
  const byRun = new Map<string, T[]>()
  return {
    get busy(): boolean { return inFlight > 0 },
    begin(): void { inFlight++ },
    end(): void { inFlight = Math.max(0, inFlight - 1) },
    /** Keeps the event if a runner POST is in flight; false means handle it now. */
    hold(promptId: unknown, event: T): boolean {
      const runId = runIdOfPrompt(promptId)
      if (!runId || inFlight === 0) return false
      const list = byRun.get(runId) ?? []
      list.push(event)
      byRun.set(runId, list)
      return true
    },
    /** One run's held events, in order; they are forgotten here. */
    take(runId: string): T[] {
      const list = byRun.get(runId) ?? []
      byRun.delete(runId)
      return list
    },
    /** Every held event (each run's in order, runs in first-seen order); all forgotten here. */
    takeAll(): T[] {
      const all = [...byRun.values()].flat()
      byRun.clear()
      return all
    },
  }
}

/** The runner runs registered to one tab (Stop stops only those). */
export function runnerRunIdsForTab(
  entries: ReadonlyArray<{ promptId: string; tabId: string; worker: number }>,
  tabId: string,
): string[] {
  const ids = new Set<string>()
  for (const e of entries) {
    if (e.worker !== RUNNER_WORKER || e.tabId !== tabId) continue
    const runId = runIdOfPrompt(e.promptId)
    if (runId) ids.add(runId)
  }
  return [...ids]
}
