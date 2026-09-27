/**
 * Live previews through the runner, the browser's side (step 3, R2.11). A
 * slider change on a ported effect asks /api/runs/preview for the node's
 * preview instead of running a scoped workflow: the chain of local nodes
 * behind it is worked out on the files the canvas already shows for the
 * first node that isn't local on each path (a paid node, an Image card with
 * its file…). Nothing is held, recorded or charged, and nothing reaches
 * /prompt or /api/runs. The answer lands on the node as the runner's
 * `executed` event, through the same in-page pipe the runner's events use.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import { familyOn, type RunnerFamily } from '#shared/runner/families'
import { PREVIEW_NEEDS_FULL_RUN_REASON, PREVIEW_SUPERSEDED_REASON, previewPlan, type PreviewFile, type PreviewRequest } from '#shared/runner/livePreview'
import { runnerMessageToPipe } from '~/composables/useRunnerEvents'

export type { PreviewFile, PreviewRequest }

const FILE_TYPES: ReadonlySet<string> = new Set(['input', 'output', 'temp'])

function plainFile(f: unknown): f is PreviewFile {
  const x = f as PreviewFile | null
  return !!x && typeof x.filename === 'string' && !!x.filename && typeof x.subfolder === 'string' && FILE_TYPES.has(x.type)
}

/**
 * The preview request for `nodeId`, or null to run it as before: the node
 * isn't a ported effect, something behind it isn't one the preview works out
 * (an effect whose family is off, the Shader effect, a closed Gate…), or a
 * node it would pin has shown no files yet. Pure.
 */
export function livePreviewRequest(
  prompt: ApiPrompt,
  nodeId: string,
  families: ReadonlySet<RunnerFamily>,
  lastFiles: (nodeId: string) => PreviewFile[] | null,
): PreviewRequest | null {
  if (!familyOn('live-previews', families)) return null
  const plan = previewPlan(prompt, nodeId, families)
  if (!plan) return null
  const out: ApiPrompt = {}
  const pinned: Record<string, PreviewFile[]> = {}
  for (const id of plan.pins) {
    // A loader that shows nothing (LoadImage never does; an Image card may not yet) is pinned by its own file.
    const files = lastFiles(id) ?? ownFileOf(prompt[id]!)
    if (!files?.length || !files.every(plainFile)) return null
    out[id] = prompt[id]!
    pinned[id] = files.map(f => ({ filename: f.filename, subfolder: f.subfolder, type: f.type }))
  }
  for (const id of plan.order) out[id] = prompt[id]!
  return { nodeId, prompt: out, pinned }
}

/**
 * A loader's own picture, as its widget names it: LoadImage's `image`, or an
 * Image card's `image` when nothing is wired into it. The widget's text is
 * read as the runner reads it (server/runner/inputs.ts parseInputFileRef):
 * `a.png`, `sub/a.png`, or either with ` [input|output|temp]`; input by default.
 * Null for any other node, an empty widget, or a name with an unsafe part.
 */
export function ownFileOf(node: { class_type: string; inputs?: Record<string, unknown> }): PreviewFile[] | null {
  const inputs = node.inputs ?? {}
  const loader = node.class_type === 'LoadImage' || (node.class_type === 'Image' && !Array.isArray(inputs.images))
  const raw = inputs.image
  if (!loader || typeof raw !== 'string' || !raw.trim()) return null
  let name = raw.trim()
  let type: PreviewFile['type'] = 'input'
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) { name = m[1]!; type = m[2] as PreviewFile['type'] }
  const parts = name.replace(/\\/g, '/').split('/')
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\0'))) return null
  const filename = parts.pop()!
  return [{ filename, subfolder: parts.join('/'), type }]
}

/** The files a node shows (its `data.images`, `/view?…` addresses), or null when it shows none the runner can read. */
export function filesShownBy(images: unknown): PreviewFile[] | null {
  if (!Array.isArray(images) || !images.length) return null
  const out: PreviewFile[] = []
  for (const src of images) {
    if (typeof src !== 'string') return null
    let url: URL
    try { url = new URL(src, 'http://sailor.local') }
    catch { return null }
    if (url.origin !== 'http://sailor.local' || !/(^|\/)view$/.test(url.pathname)) return null
    const f = { filename: url.searchParams.get('filename') ?? '', subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') || 'output' }
    if (!plainFile(f)) return null
    out.push(f)
  }
  return out
}

/** What became of a preview request. */
export type LivePreviewOutcome =
  | { kind: 'shown'; ui: Record<string, unknown> }
  /** The node (or one behind it) failed, in the runner's words. */
  | { kind: 'failed'; nodeId: string; classType: string | null; message: string }
  /** A newer preview of the node took its place, or it was cancelled: nothing to show. */
  | { kind: 'dropped' }
  /** The route doesn't take it (the runner off: 404; or its 409 "needs a full run"): run it as before. */
  | { kind: 'fallback' }

/** Words for a preview the server couldn't make (a 5xx, the network): never a reason to start a take. */
export const PREVIEW_COULD_NOT_MAKE = 'This preview couldn’t be made. Try again in a moment.'

/** The node's own in-flight preview, by canvas and node: a newer one cancels it. */
const inFlight = new Map<string, AbortController>()

type Post = (body: PreviewRequest & { canvasId: string | null }, signal: AbortSignal) => Promise<{ ui: Record<string, unknown> }>
const postPreview: Post = (body, signal) => $fetch<{ ui: Record<string, unknown> }>('/api/runs/preview', { method: 'POST', body, signal })

/** Sends a preview request (a newer one for the same node cancels this one) and reads the answer. */
export async function sendLivePreview(body: PreviewRequest & { canvasId: string | null }, post: Post = postPreview): Promise<LivePreviewOutcome> {
  const key = `${body.canvasId ?? ''}\n${body.nodeId}`
  inFlight.get(key)?.abort()
  const ctrl = new AbortController()
  inFlight.set(key, ctrl)
  try {
    const res = await post(body, ctrl.signal)
    if (ctrl.signal.aborted) return { kind: 'dropped' }
    return res && typeof res.ui === 'object' && res.ui ? { kind: 'shown', ui: res.ui } : { kind: 'fallback' }
  }
  catch (e) {
    if (ctrl.signal.aborted) return { kind: 'dropped' }
    const x = e as { statusCode?: number; status?: number; data?: { message?: unknown; data?: { reason?: unknown; nodeId?: unknown; classType?: unknown } } } | null
    const status = x?.statusCode ?? x?.status
    const data = x?.data?.data
    // Only the route saying it doesn't take this preview runs it as before (a full take may follow).
    if (status === 404 || (status === 409 && data?.reason === PREVIEW_NEEDS_FULL_RUN_REASON)) return { kind: 'fallback' }
    // Replaced by a newer one, stopped, or too many at once: the next slider change asks again.
    if (status === 409 || status === 429) return { kind: 'dropped' }
    const said = status === 400 || status === 403 || status === 413
    const message = said && typeof x?.data?.message === 'string' && x.data.message ? x.data.message : PREVIEW_COULD_NOT_MAKE
    // Anything else (a 5xx, a network error): a failed preview, never a take.
    return {
      kind: 'failed',
      nodeId: said && typeof data?.nodeId === 'string' ? data.nodeId : body.nodeId,
      classType: said && typeof data?.classType === 'string' ? data.classType : null,
      message,
    }
  }
  finally {
    if (inFlight.get(key) === ctrl) inFlight.delete(key)
  }
}

/** A prompt id of the runner's kind for one preview's answer (never a run the server knows). */
export function previewPromptId(): string {
  return `run_preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** A shown preview as the runner's own `executed` event, in the in-page pipe's envelope (useRunnerEvents.ts). */
export function previewEnvelope(promptId: string, canvasId: string | null, ui: Record<string, unknown>, nodeId: string): Record<string, unknown> | null {
  return runnerMessageToPipe(JSON.stringify({ type: 'executed', data: { prompt_id: promptId, node: nodeId, display_node: nodeId, output: ui, canvas_id: canvasId } }))
}

/**
 * A failed preview's own small path: the node shows it failed, as a failed
 * run marks it (red ring and message), and nothing goes on the run pipe, so no
 * run's handlers (wallet, status bar, run visuals, a wait for completion) see it.
 */
export function markPreviewFailed(nodes: any[], nodeId: string, message: string): void {
  const n = nodes.find(x => String(x?.id) === nodeId)
  if (n) n.data = { ...n.data, running: false, error: true, errorMessage: message, previewError: true }
}

/** A shown preview clears the failure a preview marked (never a run's). */
export function clearPreviewFailure(nodes: any[], nodeId: string): void {
  const n = nodes.find(x => String(x?.id) === nodeId)
  if (n?.data?.previewError) n.data = { ...n.data, error: false, errorMessage: null, previewError: false }
}

/** Whether a node's live preview goes to the runner's route: the runner, direct execution and `live-previews` on. */
export function livePreviewsOn(runnerOn: boolean, directOn: boolean, families: ReadonlySet<RunnerFamily>): boolean {
  return runnerOn && directOn && familyOn('live-previews', families)
}

/** What the layout lends a preview. */
export interface LivePreviewEnv {
  runnerOn: boolean
  directOn: boolean
  families: ReadonlySet<RunnerFamily>
  /** The canvas asked from (null: not a project canvas, run as before). */
  canvasId: string | null
  /** The prompt as a live run builds it, or null. */
  buildPrompt(nodeId: string): ApiPrompt | null
  /** The canvas's nodes (data.images), or null once that canvas isn't on screen. */
  nodes(): any[] | null
  /** The old path (a scoped live run). */
  runAsBefore(nodeId: string): void
  /** Lands a shown preview on the node: the runner's `executed` envelope for a silent stage. */
  show(promptId: string, env: Record<string, unknown>): void
  post?: Post
}

/**
 * One live preview: through the route when it takes it, else as before.
 * Only the route's own "not here" (404, or its 409 needs-a-full-run) runs the
 * old path; a failure shows on the node and a replaced preview shows nothing.
 */
export async function runLivePreview(nodeId: string, env: LivePreviewEnv): Promise<void> {
  if (!livePreviewsOn(env.runnerOn, env.directOn, env.families) || !env.canvasId) return env.runAsBefore(nodeId)
  const prompt = env.buildPrompt(nodeId)
  const nodes = prompt ? env.nodes() : null
  const req = prompt && nodes ? livePreviewRequest(prompt, nodeId, env.families, id => filesShownBy(nodes.find(n => String(n?.id) === id)?.data?.images)) : null
  if (!req) return env.runAsBefore(nodeId)
  const out = await sendLivePreview({ ...req, canvasId: env.canvasId }, env.post)
  if (out.kind === 'fallback') return env.runAsBefore(nodeId)
  if (out.kind === 'dropped') return
  const now = env.nodes()
  if (out.kind === 'failed') {
    if (now) markPreviewFailed(now, out.nodeId, out.message)
    return
  }
  const promptId = previewPromptId()
  const envelope = previewEnvelope(promptId, env.canvasId, out.ui, nodeId)
  if (!envelope) return
  if (now) clearPreviewFailure(now, nodeId)
  env.show(promptId, envelope)
}

/**
 * Posts an envelope onto the in-page pipe and calls `done` once every
 * listener registered before it (the layout's and the canvas's) has handled
 * it, or after 10 s at most.
 */
export function deliverEnvelope(env: Record<string, unknown>, done: () => void): void {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    window.removeEventListener('message', onMessage)
    clearTimeout(timer)
    done()
  }
  const onMessage = (m: MessageEvent) => {
    const d = m.data as Record<string, unknown> | null
    if (m.source === window && d?.type === env.type && d?.prompt_id === env.prompt_id && d?.event === env.event) finish()
  }
  const timer = setTimeout(finish, 10_000)
  window.addEventListener('message', onMessage)
  window.postMessage(env, window.location.origin)
}
