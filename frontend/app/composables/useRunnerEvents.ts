/**
 * The runner's live events (GET /api/runs/events, server-sent) fed onto the
 * same in-page pipe ComfyUI's WebSocket events use, so the canvas and the
 * layout handle both the same way. EventSource reconnects on its own; on
 * reconnect the server replays what is running and what is paused.
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

export function useRunnerEvents() {
  function connect(): void {
    if (source || typeof EventSource === 'undefined') return
    source = new EventSource('/api/runs/events')
    source.onmessage = (m) => {
      const env = runnerMessageToPipe(String(m.data))
      if (env) window.postMessage(env, window.location.origin)
    }
  }
  function disconnect(): void {
    source?.close()
    source = null
  }
  return { connect, disconnect }
}
