/**
 * The runner's live events (GET /api/runs/events, server-sent) fed onto the
 * same in-page pipe ComfyUI's WebSocket events use, so the canvas and the
 * layout handle both the same way. EventSource reconnects on its own; on
 * reconnect the server replays what is running and what is paused. The stream
 * opens lazily (ensureRunnerEvents), the first time this page uses the runner.
 */
import { mapWsEvent } from '~/lib/graph/wsEventMap'

export function runnerMessageToPipe(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  // Runner messages carry no client id, so no id of ours can mark them foreign.
  const mapped = mapWsEvent(parsed as { type: string; data: any }, '')
  return mapped ? { type: 'sailor-bridge', v: 2, direct: true, ...mapped } : null
}

let source: EventSource | null = null
let opened: Promise<void> | null = null

/** How long a caller waits for the stream to open before going ahead anyway. */
const OPEN_WAIT_MS = 3000

/**
 * Connects the runner event stream if it is not connected yet, and stays
 * connected. Called when a runner run starts, a runner Gate button is sent, or
 * paused Gates are found — never at page load. Resolves once the stream is open
 * (so the first leg's events are not missed), or after 3 seconds at most.
 */
export function ensureRunnerEvents(): Promise<void> {
  if (source) return opened ?? Promise.resolve()
  if (typeof EventSource === 'undefined') return Promise.resolve()
  const s = new EventSource('/api/runs/events')
  source = s
  s.onmessage = (m) => {
    const env = runnerMessageToPipe(String(m.data))
    if (env) window.postMessage(env, window.location.origin)
  }
  opened = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, OPEN_WAIT_MS)
    s.onopen = () => { clearTimeout(timer); resolve() }
  })
  return opened
}

export function useRunnerEvents() {
  /** Same as ensureRunnerEvents(); idempotent. */
  function connect(): Promise<void> {
    return ensureRunnerEvents()
  }
  function disconnect(): void {
    source?.close()
    source = null
    opened = null
  }
  return { connect, disconnect }
}
