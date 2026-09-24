/**
 * fal queue client with no money handling — submit, check, fetch, cancel.
 * The runner charges per stage itself; runFal (server/utils/falRun.ts) wraps
 * this with its own per-call hold. Queue API:
 *   POST queue.fal.run/{endpoint}[?fal_webhook=URL] -> {request_id, status_url, response_url, cancel_url, queue_position}
 *   GET  status_url[?logs=1]  -> 202 while IN_QUEUE/IN_PROGRESS, 200 when COMPLETED
 *   GET  response_url         -> the result body
 *   PUT  cancel_url           -> 202 requested / 400 already completed / 404 unknown
 */
import { getFalToken } from '../utils/falStorage'

export const FAL_QUEUE_BASE = 'https://queue.fal.run'

export class FalError extends Error {
  status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'FalError'
    this.status = status
  }
}

export interface FalSubmitted {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
  queuePosition: number | null
}

export interface FalStatus {
  status: string
  queuePosition: number | null
  logs: { message: string }[]
  error: string | null
  /** A 5xx from fal, or no answer at all (network error): try again later, nothing is known. */
  transient: boolean
  /**
   * Replicate only: the request failed with a platform hiccup that is worth
   * sending again (a failed prediction is not billed). Absent for fal.
   */
  retryable?: boolean
  raw: unknown
}

function headers(): Record<string, string> {
  const token = getFalToken()
  if (!token) throw new Error('FAL_KEY is not set (add it to frontend/.env)')
  return { Authorization: `Key ${token}`, 'Content-Type': 'application/json' }
}

const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'])

/**
 * True only for a real network failure: a TypeError thrown by fetch itself
 * (undici's "fetch failed"), or an error whose cause carries a known socket/DNS
 * code. Everything else — a FalError (any HTTP status), a SyntaxError from a
 * garbled body, "FAL_KEY is not set", or any other Error — is NOT a blip: it
 * must surface, not be swallowed as "try again later" forever.
 */
export function isFalNetworkError(e: unknown): boolean {
  if (e instanceof FalError || e instanceof SyntaxError) return false
  if (e instanceof TypeError) return true
  const code = (e as { cause?: { code?: unknown } } | null | undefined)?.cause?.code
  return typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_'))
}

const transientStatus = (): FalStatus => ({ status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null })

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export async function falSubmit(
  endpoint: string,
  input: Record<string, unknown>,
  opts: { webhookUrl?: string | null } = {},
): Promise<FalSubmitted> {
  const h = headers()
  const base = `${FAL_QUEUE_BASE}/${endpoint}`
  const url = opts.webhookUrl ? `${base}?fal_webhook=${encodeURIComponent(opts.webhookUrl)}` : base
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(input) })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal submit ${r.status}: ${t || r.statusText}`, r.status)
  }
  const body = await r.json() as Record<string, unknown>
  const requestId = String(body.request_id ?? '')
  if (!requestId) throw new FalError('fal submit returned no request id', null)
  return {
    requestId,
    statusUrl: str(body.status_url) ?? `${base}/requests/${requestId}/status`,
    responseUrl: str(body.response_url) ?? `${base}/requests/${requestId}`,
    cancelUrl: str(body.cancel_url) ?? `${base}/requests/${requestId}/cancel`,
    queuePosition: num(body.queue_position),
  }
}

export async function falStatus(statusUrl: string, opts: { logs?: boolean } = {}): Promise<FalStatus> {
  const url = opts.logs ? `${statusUrl}${statusUrl.includes('?') ? '&' : '?'}logs=1` : statusUrl
  const h = headers()
  let r: Response
  // No answer at all is a blip, like a 5xx: fal may still be working (and billing).
  try { r = await fetch(url, { headers: h }) }
  catch { return transientStatus() }
  if (r.status !== 200 && r.status !== 202) {
    if (r.status >= 400 && r.status < 500) {
      const t = await r.text().catch(() => '')
      throw new FalError(`fal status ${r.status} (not retryable): ${t}`, r.status)
    }
    return transientStatus()
  }
  const body = await r.json() as Record<string, unknown>
  const logs = Array.isArray(body.logs)
    ? (body.logs as unknown[]).filter((l): l is { message: string } => !!l && typeof (l as any).message === 'string')
    : []
  return {
    status: String(body.status ?? 'UNKNOWN'),
    queuePosition: num(body.queue_position),
    logs,
    error: str(body.error),
    transient: false,
    raw: body,
  }
}

export async function falResult<T = unknown>(responseUrl: string): Promise<T> {
  const r = await fetch(responseUrl, { headers: headers() })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal result ${r.status}: ${t}`, r.status)
  }
  return await r.json() as T
}

/**
 * Fetch a finished result file (a fal.media URL). A network error or a 5xx is
 * tried again, three tries in all, waiting 1s then 2s; a 4xx fails at once.
 */
export async function downloadResult(
  url: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const waits = [1000, 2000]
  for (let attempt = 0; ; attempt++) {
    let failure: Error
    let final = false
    try {
      const r = await fetch(url)
      if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get('content-type') }
      failure = new Error(`Could not download the result (${r.status})`)
      final = r.status < 500
    }
    catch (e) {
      failure = e instanceof Error ? e : new Error(String(e)) // no answer, or the body broke off
    }
    if (final || attempt >= waits.length) throw failure
    await sleep(waits[attempt]!)
  }
}

export async function falCancel(cancelUrl: string): Promise<'cancelled' | 'already-done' | 'not-found'> {
  const r = await fetch(cancelUrl, { method: 'PUT', headers: headers() })
  if (r.status === 400) return 'already-done'
  if (r.status === 404) return 'not-found'
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new FalError(`fal cancel ${r.status}: ${t}`, r.status)
  }
  return 'cancelled'
}

export function percentFromLogs(logs: { message: string }[]): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /(\d{1,3})\s*%/.exec(logs[i]!.message)
    if (m) {
      const n = Number(m[1])
      if (n >= 0 && n <= 100) return n
    }
  }
  return null
}

export function falImageUrls(result: unknown): string[] {
  const images = (result as { images?: Array<{ url?: unknown }> })?.images
  if (!Array.isArray(images)) return []
  return images.map(i => i?.url).filter((u): u is string => typeof u === 'string' && u.length > 0)
}

export function falVideoUrl(result: unknown): string | null {
  const url = (result as { video?: { url?: unknown } })?.video?.url
  return typeof url === 'string' && url ? url : null
}

/** The files a finished fal result points at: every image, or the one video. */
export function falOutputUrls(result: unknown, media: 'image' | 'video'): string[] {
  return media === 'image' ? falImageUrls(result) : [falVideoUrl(result)].filter((u): u is string => !!u)
}

export type FalClient = {
  submit: typeof falSubmit
  status: typeof falStatus
  result: typeof falResult
  cancel: typeof falCancel
}

/**
 * One provider's queue, as the engine drives it: fal, or Replicate
 * (replicateQueue.ts). The shape is fal's, plus where the result's files are.
 */
export type ProviderClient = FalClient & {
  outputUrls(result: unknown, media: 'image' | 'video'): string[]
}

export const realFalClient: ProviderClient = {
  submit: falSubmit, status: falStatus, result: falResult, cancel: falCancel, outputUrls: falOutputUrls,
}
