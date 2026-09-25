/**
 * Replicate queue client with no money handling — submit, check, fetch,
 * cancel — in the same shape as the fal one (falQueue.ts), so the engine can
 * drive either. The runner charges per stage itself: server/utils/replicate.ts
 * `runReplicate` holds credits of its own, so the runner must never call it.
 *
 * A port of comfy_api_nodes/nodes_replicate.py `_run_prediction` (:216–325),
 * `_is_transient_replicate_error` and its markers (:136–151), and
 * replicate_refs.py `_first_output_url` / `_all_output_urls` (:252–268):
 *   POST /v1/models/{slug}/predictions {input}           official models
 *     404 → GET /v1/models/{slug}, then POST /v1/predictions {version, input}
 *     429 → wait retry_after (default 5 s) + 0.5 s, 3 tries in all
 *   GET  urls.get     starting | processing | succeeded | failed | canceled
 *   POST urls.cancel
 * The transient re-run of a failed prediction (Python's outer loop) is the
 * engine's job: it sees `retryable` on the status and sends the request again.
 */
import { getReplicateToken } from '../utils/secrets'
import type { FalStatus, FalSubmitted, ProviderClient } from './falQueue'

export const REPLICATE_API_BASE = 'https://api.replicate.com/v1'

export class ReplicateError extends Error {
  status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'ReplicateError'
    this.status = status
  }
}

/**
 * Substrings (matched case-insensitively against Replicate's `error`) that
 * mark a failure as Replicate's own infrastructure choking after the
 * prediction was accepted, not a failure that would just happen again.
 */
export const TRANSIENT_REPLICATE_ERROR_MARKERS = [
  'unexpected error handling prediction', // the E9828 message
  'e9828',
  'prediction interrupted',
  'internal error',
  'please try again',
] as const

export function isTransientReplicateError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return TRANSIENT_REPLICATE_ERROR_MARKERS.some(marker => m.includes(marker))
}

/** `_first_output_url`, without the raise: an empty list means "no output". */
export function firstOutputUrl(pred: unknown): string | null {
  const output = (pred as { output?: unknown } | null)?.output
  if (Array.isArray(output) && output.length) return typeof output[0] === 'string' ? output[0] : null
  if (typeof output === 'string') return output
  return null
}

/** `_all_output_urls`: every string in a list output, or the one string. */
export function allOutputUrls(pred: unknown): string[] {
  const output = (pred as { output?: unknown } | null)?.output
  if (Array.isArray(output)) return output.filter((o): o is string => typeof o === 'string')
  if (typeof output === 'string') return [output]
  return []
}

export function replicateOutputUrls(result: unknown, media: 'image' | 'video'): string[] {
  if (media === 'image') return allOutputUrls(result)
  const url = firstOutputUrl(result)
  return url ? [url] : []
}

/** Split Replicate's log text into lines (tqdm redraws with \r), so percentFromLogs reads the last percentage. */
export function logLines(logs: unknown): { message: string }[] {
  if (typeof logs !== 'string' || !logs) return []
  return logs.split(/\r\n|\r|\n/).filter(l => l.trim()).map(message => ({ message }))
}

/**
 * Python's `int((json.loads(text).get("retry_after") or 5))`, with its
 * fallback to 5 whenever any step raises.
 */
export function retryAfterSeconds(text: string): number {
  let v: unknown
  try { v = (JSON.parse(text) as Record<string, unknown>).retry_after }
  catch { return 5 }
  if (!v) return 5 // `or 5`: missing, 0, "", null, false
  if (v === true) return 1
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 5
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return 5
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const STATUS_MAP: Record<string, string> = {
  starting: 'IN_QUEUE',
  processing: 'IN_PROGRESS',
  succeeded: 'COMPLETED',
  failed: 'COMPLETED',
  canceled: 'COMPLETED',
}

const transientStatus = (): FalStatus => ({ status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null })

export interface ReplicateClientOptions {
  /** The API token; null when Replicate is not set up. */
  token?: () => string | null
  /** Waits between 429 tries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
}

export function createReplicateClient(opts: ReplicateClientOptions = {}): ProviderClient {
  const token = opts.token ?? getReplicateToken
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))

  function headers(): Record<string, string> {
    // Settings-pasted / NUXT_REPLICATE_TOKEN wins; REPLICATE_API_TOKEN (Python's
    // first choice) is the fallback. Never logged.
    const t = token() || process.env.REPLICATE_API_TOKEN || null
    if (!t) throw new Error('Replicate is not set up (add NUXT_REPLICATE_TOKEN)')
    return { Authorization: `Token ${t}`, 'Content-Type': 'application/json' }
  }

  /** `_post_create`: 200/201 is the prediction; a 429 waits and tries again, 3 tries in all. */
  async function postCreate(url: string, body: Record<string, unknown>, h: Record<string, string>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) })
      if (r.status === 200 || r.status === 201) return await r.json() as Record<string, unknown>
      const text = await r.text().catch(() => '')
      if (r.status === 429 && attempt < 2) {
        await sleep(Math.max(0, (Math.min(retryAfterSeconds(text), 30) + 0.5) * 1000))
        continue
      }
      throw new ReplicateError(`Replicate predictions API HTTP ${r.status}: ${text}`, r.status)
    }
    throw new ReplicateError('rate-limited; gave up after retries', 429) // unreachable, as in Python
  }

  async function submit(
    slug: string,
    input: Record<string, unknown>,
    o: { webhookUrl?: string | null } = {},
  ): Promise<FalSubmitted> {
    const h = headers()
    const hook = o.webhookUrl ? { webhook: o.webhookUrl, webhook_events_filter: ['completed'] } : {}
    let pred: Record<string, unknown>
    try {
      pred = await postCreate(`${REPLICATE_API_BASE}/models/${slug}/predictions`, { input, ...hook }, h)
    }
    catch (e) {
      if (!(e instanceof ReplicateError) || e.status !== 404) throw e
      // A community model has no official route: look up its latest version.
      const r = await fetch(`${REPLICATE_API_BASE}/models/${slug}`, { headers: h })
      if (r.status !== 200) {
        const text = await r.text().catch(() => '')
        throw new ReplicateError(`Could not look up ${slug}: HTTP ${r.status} — ${text}`, r.status)
      }
      const info = await r.json() as { latest_version?: { id?: unknown } | null }
      const version = str(info?.latest_version?.id)
      if (!version) throw new ReplicateError(`No latest_version for ${slug}`, null)
      pred = await postCreate(`${REPLICATE_API_BASE}/predictions`, { version, input, ...hook }, h)
    }
    const id = str(pred.id)
    if (!id) throw new ReplicateError('Replicate returned no prediction id', null)
    // Built from the id, as Python does — never trust `urls.get`/`urls.cancel`
    // from the response body: the token must only ever go to api.replicate.com.
    const getUrl = `${REPLICATE_API_BASE}/predictions/${id}`
    return {
      requestId: id,
      statusUrl: getUrl,
      responseUrl: getUrl,
      cancelUrl: `${getUrl}/cancel`,
      queuePosition: null,
    }
  }

  async function status(statusUrl: string, _o: { logs?: boolean } = {}): Promise<FalStatus> {
    const h = headers()
    let r: Response
    // No answer at all is a blip: Replicate may still be working (and billing).
    try { r = await fetch(statusUrl, { headers: h }) }
    catch { return transientStatus() }
    if (r.status !== 200) {
      // A 429 says "ask more slowly", not "this request is gone" (Python polls on through any non-200).
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        const t = await r.text().catch(() => '')
        throw new ReplicateError(`Replicate status ${r.status} (not retryable): ${t}`, r.status)
      }
      return transientStatus()
    }
    const body = await r.json() as Record<string, unknown>
    // A 200 with no usable status is treated the same as a blip: keep polling
    // rather than passing a made-up "UNKNOWN" through as if it were real.
    if (typeof body.status !== 'string' || !body.status) return transientStatus()
    const raw = body.status
    const mapped = STATUS_MAP[raw] ?? raw
    let error: string | null = null
    let retryable = false
    if (raw === 'failed' || raw === 'canceled') {
      const err = str(body.error) ?? `prediction ${raw}`
      // As Python: the markers decide, for `failed` and `canceled` alike.
      retryable = isTransientReplicateError(err)
      error = `Replicate: ${err}`
    }
    return {
      status: mapped,
      queuePosition: null,
      logs: raw === 'processing' ? logLines(body.logs) : [],
      error,
      transient: false,
      retryable,
      raw: body,
    }
  }

  /** Only needed when the terminal status body had no output of its own; a 5xx here is tried up to twice more. */
  async function result<T = unknown>(responseUrl: string): Promise<T> {
    let status = 0
    let text = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(responseUrl, { headers: headers() })
      if (r.status === 200) return await r.json() as T
      status = r.status
      text = await r.text().catch(() => '')
      if (status >= 500 && status < 600 && attempt < 2) { await sleep(500); continue }
      break
    }
    throw new ReplicateError(`Replicate result ${status}: ${text}`, status)
  }

  async function cancel(cancelUrl: string): Promise<'cancelled' | 'already-done' | 'not-found'> {
    const r = await fetch(cancelUrl, { method: 'POST', headers: headers() })
    if (r.status === 404) return 'not-found'
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new ReplicateError(`Replicate cancel ${r.status}: ${t}`, r.status)
    }
    // Replicate answers with the prediction: one that had already finished keeps its end state.
    // One that had just started (`started_at` set) is cancelled all the same:
    // keeping it would only leave the user an error, so it counts as
    // cancelled and the engine moves the job to its backup. Sailor absorbs
    // the partial run; the user is still charged once.
    const body = await r.json().catch(() => null) as { status?: unknown } | null
    return body?.status === 'succeeded' || body?.status === 'failed' ? 'already-done' : 'cancelled'
  }

  return { submit, status, result, cancel, outputUrls: replicateOutputUrls }
}

export const realReplicateClient: ProviderClient = createReplicateClient()
