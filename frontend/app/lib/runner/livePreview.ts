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
import { PREVIEW_SUPERSEDED_REASON, previewPlan, type PreviewFile, type PreviewRequest } from '#shared/runner/livePreview'
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
    const files = lastFiles(id)
    if (!files?.length || !files.every(plainFile)) return null
    out[id] = prompt[id]!
    pinned[id] = files.map(f => ({ filename: f.filename, subfolder: f.subfolder, type: f.type }))
  }
  for (const id of plan.order) out[id] = prompt[id]!
  return { nodeId, prompt: out, pinned }
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
  /** The route doesn't take it (off, or it needs a full run): run it as before. */
  | { kind: 'fallback' }

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
    if (status === 409 && data?.reason === PREVIEW_SUPERSEDED_REASON) return { kind: 'dropped' }
    // Too many previews at once: the next slider change asks again.
    if (status === 429) return { kind: 'dropped' }
    if (status === 400 || status === 403 || status === 413) {
      const message = typeof x?.data?.message === 'string' && x.data.message ? x.data.message : 'This preview couldn’t be made'
      return {
        kind: 'failed',
        nodeId: typeof data?.nodeId === 'string' ? data.nodeId : body.nodeId,
        classType: typeof data?.classType === 'string' ? data.classType : null,
        message,
      }
    }
    return { kind: 'fallback' }
  }
  finally {
    if (inFlight.get(key) === ctrl) inFlight.delete(key)
  }
}

/** A prompt id of the runner's kind for one preview's answer (never a run the server knows). */
export function previewPromptId(): string {
  return `run_preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** The answer as the runner's own event, in the in-page pipe's envelope (useRunnerEvents.ts). */
export function previewEnvelope(promptId: string, canvasId: string | null, outcome: Extract<LivePreviewOutcome, { kind: 'shown' | 'failed' }>, nodeId: string): Record<string, unknown> | null {
  const message = outcome.kind === 'shown'
    ? { type: 'executed', data: { prompt_id: promptId, node: nodeId, display_node: nodeId, output: outcome.ui, canvas_id: canvasId } }
    : {
        type: 'execution_error',
        data: {
          prompt_id: promptId, node_id: outcome.nodeId, node_type: outcome.classType, exception_message: outcome.message,
          exception_type: 'RunnerError', traceback: [], canvas_id: canvasId,
        },
      }
  return runnerMessageToPipe(JSON.stringify(message))
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
