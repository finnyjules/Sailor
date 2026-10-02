// Direct execution channel: talks to ComfyUI's native WS + /prompt directly,
// bypassing the hidden bridge iframe. Task 8 wires this into the same event
// handling `default.vue` already has for the bridge's postMessage events —
// `mapWsEvent` (wsEventMap.ts) produces those exact shapes so that handler
// doesn't need to change.
//
// WS TRANSPORT — same-origin /ws through the Nuxt proxy: the browser cannot
// connect straight to ComfyUI's own origin (ws://127.0.0.1:8188/ws) because
// ComfyUI's origin-check middleware (server.py, active without
// --enable-cors-header) rejects any WS handshake whose (unforgeable) Origin
// header names the Nuxt dev port instead of the loopback host → 403 → infinite
// reconnect. Instead we connect to same-origin `/ws`; the "comfy-ws-proxy"
// upgrade hook in nuxt.config.ts pipes it to 127.0.0.1:8188 while rewriting the
// Origin to the ComfyUI origin (mirroring server/middleware/comfyui-proxy.ts's
// HTTP trick), so the origin check passes. In production the same-origin /ws is
// proxied by the hosting layer to the ComfyUI backend.
//
// R10.3: one socket to the local engine. The worker pool (extra headless
// ComfyUI instances, spill and parallel dispatch) is gone;
// this channel serves only runs that go to the local engine explicitly
// (R10.2's local-only route).
//
// Module-singleton: one socket per app, regardless of how many components
// call useDirectExecution().

import type { ApiPrompt, LiteGraphWorkflow } from '~/lib/graph/graphToPrompt'
import { mapWsEvent, type BridgeShapedEvent } from '~/lib/graph/wsEventMap'
import { isH3RefusalBody } from '~/lib/queueRefusal'

export interface QueueResult {
  prompt_id?: string
  node_errors?: any
  /** Non-node error message (400 `{ error: { message } }`, network, 5xx). Set
   *  on any failure so callers can surface it instead of a silent success. */
  error?: string
  /** Run-registry worker this run is registered against: 0 = the local
   *  engine; runner runs carry RUNNER_WORKER (#shared/runner/messages). */
  worker?: number
  /** Set when `error` is a Nuxt-proxy metering refusal (moderation/credits/
   *  ownership/paused) rather than a ComfyUI /prompt validation failure —
   *  mirrors bridge.js's `isRefusal` tag on the bridge's `queue_error`
   *  postMessage, so callers can route both through `describeQueueRefusal`
   *  for the same toast quality (Stage 8 fix: direct-exec refusals were
   *  falling through to a generic "Couldn't start run" toast). */
  refusal?: boolean
  /** The refusal's HTTP status code (400 moderation, 402 credits, 403
   *  ownership, 503 paused), when `refusal` is set. */
  statusCode?: number
}

export interface DirectExecution {
  connect: () => void
  disconnect: () => void
  /** Tell the socket layer whether the local engine answers (useBackendHealth's
   *  engineUp). While it doesn't, the socket stops retrying — no failed
   *  connect every few seconds — and reconnects as soon as it does. */
  setEngineAvailable: (up: boolean) => void
  /** The socket is open right now: the engine is plainly reachable, whatever
   *  the last health poll said (a busy engine can miss a poll). */
  isMainSocketOpen: () => boolean
  queue: (prompt: ApiPrompt, workflow: LiteGraphWorkflow) => Promise<QueueResult>
  onEvent: (cb: (e: BridgeShapedEvent) => void) => void
  clientId: string
}

/** 1s → 2s → 4s → 5s (capped) reconnect backoff, indexed by consecutive-attempt count (0-based). */
export function reconnectDelayMs(attempt: number): number {
  const base = 1000 * Math.pow(2, Math.max(0, attempt))
  return Math.min(base, 5000)
}

/** Pure decision: may the socket schedule a reconnect? It waits while the
 *  local engine is reported down (setEngineAvailable reopens it). Exported for
 *  unit testing. */
export function mayReconnect(engineAvailable: boolean): boolean {
  return engineAvailable
}

function getClientId(): string {
  if (!import.meta.client) return ''
  let id = sessionStorage.getItem('sailor:clientId')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('sailor:clientId', id)
  }
  return id
}

interface SocketState {
  ws: WebSocket | null
  wantConnected: boolean
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const main: SocketState = { ws: null, wantConnected: false, reconnectAttempt: 0, reconnectTimer: null }
// Whether the local engine answers, per the app's health poll. Optimistic:
// until the first poll says otherwise, the socket connects as it always has.
let engineAvailable = true
let cachedClientId: string | null = null
const listeners = new Set<(e: BridgeShapedEvent) => void>()

/** Pure URL builder — ws(s):// + origin's host/port + /ws?clientId=. Exported
 *  for unit testing. */
export function buildWsUrl(httpOrigin: string, clientId: string): string {
  return `${httpOrigin.replace(/^http/, 'ws')}/ws?clientId=${clientId}`
}

function wsUrl(clientId: string): string {
  // Same-origin /ws — routed to ComfyUI by the nuxt.config.ts upgrade proxy
  // (which strips/rewrites the browser Origin so ComfyUI's origin check passes).
  // See the header comment above for why we never connect to :8188 directly.
  return buildWsUrl(window.location.origin, clientId)
}

function clearReconnect(): void {
  if (main.reconnectTimer) { clearTimeout(main.reconnectTimer); main.reconnectTimer = null }
}

function scheduleReconnect(clientId: string): void {
  if (!main.wantConnected) return
  if (main.reconnectTimer) return
  if (!mayReconnect(engineAvailable)) return
  const delay = reconnectDelayMs(main.reconnectAttempt)
  main.reconnectAttempt++
  main.reconnectTimer = setTimeout(() => {
    main.reconnectTimer = null
    if (main.wantConnected) openSocket(clientId)
  }, delay)
}

function openSocket(clientId: string): void {
  if (!import.meta.client) return
  if (main.ws && (main.ws.readyState === WebSocket.OPEN || main.ws.readyState === WebSocket.CONNECTING)) return

  const socket = new WebSocket(wsUrl(clientId))
  main.ws = socket

  socket.addEventListener('open', () => {
    main.reconnectAttempt = 0
  })

  socket.addEventListener('message', (evt) => {
    // Binary frames (live-preview images) are not JSON — ignore safely.
    if (typeof evt.data !== 'string') return
    let parsed: { type: string; data: any } | null = null
    try {
      parsed = JSON.parse(evt.data)
    } catch {
      return
    }
    const mapped = mapWsEvent(parsed, clientId)
    if (!mapped) return
    for (const cb of listeners) cb(mapped)
  })

  socket.addEventListener('close', () => {
    if (main.ws === socket) main.ws = null
    scheduleReconnect(clientId)
  })

  socket.addEventListener('error', () => {
    // 'close' always follows 'error' for a WebSocket — reconnect scheduling
    // happens there to avoid double-scheduling.
  })
}

export function useDirectExecution(): DirectExecution {
  if (cachedClientId === null) cachedClientId = getClientId()
  const clientId = cachedClientId

  function connect(): void {
    if (!import.meta.client) return
    main.wantConnected = true
    main.reconnectAttempt = 0
    clearReconnect()
    // Engine reported down: stay wanted; setEngineAvailable(true) opens it.
    if (!engineAvailable) return
    openSocket(clientId)
  }

  function setEngineAvailable(up: boolean): void {
    if (engineAvailable === up) return
    engineAvailable = up
    if (!import.meta.client) return
    if (!up) {
      // Engine reported down: drop any armed reconnect so we don't fire one more
      // doomed /ws attempt at boot. setEngineAvailable(true) reconnects fresh.
      clearReconnect()
      return
    }
    // The engine is back: reconnect now, from a fresh backoff.
    if (!main.wantConnected || main.ws) return
    main.reconnectAttempt = 0
    clearReconnect()
    openSocket(clientId)
  }

  function isMainSocketOpen(): boolean {
    const ws = main.ws
    return !!ws && typeof WebSocket !== 'undefined' && ws.readyState === WebSocket.OPEN
  }

  function disconnect(): void {
    main.wantConnected = false
    clearReconnect()
    if (main.ws) {
      const socket = main.ws
      main.ws = null
      socket.close()
    }
  }

  async function queue(prompt: ApiPrompt, workflow: LiteGraphWorkflow): Promise<QueueResult> {
    try {
      const res = await $fetch<{ prompt_id?: string }>('/prompt', {
        method: 'POST',
        body: {
          prompt,
          client_id: clientId,
          extra_data: { extra_pnginfo: { workflow } },
        },
      })
      return { prompt_id: res?.prompt_id, worker: 0 }
    } catch (err: any) {
      // ofetch's FetchError parses the JSON body onto `.data` on non-2xx
      // responses (see useInpaint.ts / useExplain.ts for the same convention).
      // ComfyUI's /prompt 400 body is `{ error: {...}, node_errors: {...} }`.
      // Always surface *something*: a 400 with only `{ error: { message } }`, a
      // 5xx, or a network failure must NOT resolve as a silent success (which
      // let live runs fail with zero feedback). node_errors when present drives
      // the per-node red rings; `error` is the fallback human message.
      const node_errors = err?.data?.node_errors ?? null
      // An h3-shaped body (top-level `message` + `statusCode`, `error` as a
      // BOOLEAN not an object) is a Nuxt-proxy METERING REFUSAL (moderation,
      // insufficient credits, file ownership, paused) rather than ComfyUI's
      // /prompt validation body (`{ error: {...}, node_errors: {...} }`,
      // `error` an OBJECT). Nitro serializes thrown h3 errors with `error:
      // true`, so a plain truthiness check on `body.error` can't tell the two
      // apart — isH3RefusalBody checks the TYPE of `error`. Mirrors bridge.js's
      // `isRefusal` check so the direct path tags the same shape the bridge
      // path already does (Stage 8 fix — the direct path was extracting
      // `err.message`, the generic ofetch summary like
      // `[POST] "/prompt": 400 Bad Request`, instead of the clean server
      // sentence at `err.data.message`).
      const body = err?.data
      const refusal = isH3RefusalBody(body)
      const error = refusal ? body.message : (err?.data?.error?.message ?? err?.message ?? String(err))
      const statusCode = refusal && typeof body.statusCode === 'number' ? body.statusCode : undefined
      return { node_errors, error, worker: 0, refusal, statusCode }
    }
  }

  function onEvent(cb: (e: BridgeShapedEvent) => void): void {
    listeners.add(cb)
  }

  return { connect, disconnect, setEngineAvailable, isMainSocketOpen, queue, onEvent, clientId }
}
