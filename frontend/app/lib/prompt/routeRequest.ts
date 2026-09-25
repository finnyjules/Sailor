// Client side of the router (spec §4). A mode chip decides the kind locally;
// otherwise one POST to /api/prompt-route. Any failure falls back to `plan`
// (exactly what the prompt did before the router existed); only an abort
// (Stop) rethrows, so the caller can drop it silently.
import { kindForMode, ROUTER_KINDS, type RouterInput, type RouterKind } from '~~/shared/promptRouter/router'

export const ROUTE_TIMEOUT_MS = 8_000
export interface RouteOutcome { kind: RouterKind; followUps: string[]; routed: boolean }
export type RouteFetcher = (url: string, opts: Record<string, unknown>) => Promise<{ kind?: unknown; followUps?: unknown }>

const isKind = (v: unknown): v is RouterKind => typeof v === 'string' && (ROUTER_KINDS as readonly string[]).includes(v)

export async function routeRequest(input: RouterInput, o: { apiKey: string; signal?: AbortSignal; fetcher?: RouteFetcher }): Promise<RouteOutcome> {
  const forced = kindForMode(input.mode)
  if (forced) return { kind: forced, followUps: [], routed: false }
  const fetcher: RouteFetcher = o.fetcher ?? ((url, opts) => (globalThis as any).$fetch(url, opts))
  try {
    const r = await fetcher('/api/prompt-route', {
      method: 'POST',
      body: { apiKey: o.apiKey, ...input },
      timeout: ROUTE_TIMEOUT_MS,
      signal: o.signal,
    })
    const kind = isKind(r?.kind) ? r.kind : 'plan'
    const followUps = kind === 'answer' && Array.isArray(r?.followUps)
      ? (r.followUps as unknown[]).filter((f): f is string => typeof f === 'string' && !!f.trim()).slice(0, 2)
      : []
    return { kind, followUps, routed: true }
  } catch (e) {
    if (o.signal?.aborted) throw e
    return { kind: 'plan', followUps: [], routed: false }
  }
}
