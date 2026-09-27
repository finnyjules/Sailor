/** Test helpers for the runner engine: a fake fal, a fake Replicate, a fake ledger, and an engine wired to real file storage in a temp folder. */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { falOutputUrls, type ProviderClient } from '~~/server/runner/falQueue'
import { isTransientReplicateError, replicateOutputUrls } from '~~/server/runner/replicateQueue'
import { createEngine, type EngineDeps } from '~~/server/runner/engine'
import { createFileRunStore } from '~~/server/runner/store'
import { createEngineResultStore } from '~~/server/runner/results'
import { createHandoff } from '~~/server/runner/handoff'
import { createMetering, type LedgerPort } from '~~/server/runner/metering'
import { createRunEvents } from '~~/server/runner/events'
import { rememberRaw } from '~~/server/runner/rawJson'
import type { RunnerMessage } from '#shared/runner/messages'
import type { ApiPrompt } from '#shared/runner/graph'

export interface FakeRequest {
  id: string
  endpoint: string
  payload: Record<string, unknown>
  polls: number
  held: boolean
  failWith: string | null
  cancelled: boolean
}

/**
 * A programmed answer (R3.1). fal: `answer` gives the result body; Replicate:
 * the prediction's `output`. `bodyText`, when given, is the body text itself
 * (parsed, and remembered as the answer's raw text, as the real clients do).
 * Without either, today's picture answers.
 */
export interface FakeFalAnswers {
  answer?(req: { endpoint: string; input: Record<string, unknown> }): unknown
  bodyText?(req: { endpoint: string; input: Record<string, unknown> }): string
}
export interface FakeReplicateAnswers {
  answer?(req: { model: string; input: Record<string, unknown> }): unknown
  bodyText?(req: { model: string; input: Record<string, unknown> }): string
}

/** The body parsed from `text`, remembered as its raw text (rawJson.ts), as the queue clients do. */
function remembered(text: string): unknown {
  const v = JSON.parse(text) as unknown
  if (v !== null && typeof v === 'object') rememberRaw(v, text)
  return v
}

export function createFakeFal(o: FakeFalAnswers = {}) {
  const reqs = new Map<string, FakeRequest>()
  let seq = 0
  const next = { hold: 0, fail: 0 }
  const idOf = (url: string) => /^fal:\/\/(req\d+)/.exec(url)![1]!
  const client: ProviderClient = {
    submit: vi.fn(async (endpoint: string, payload: Record<string, unknown>) => {
      const id = `req${++seq}`
      const r: FakeRequest = { id, endpoint, payload, polls: 0, held: next.hold > 0, failWith: next.fail > 0 ? 'The provider refused this prompt' : null, cancelled: false }
      if (next.hold > 0) next.hold--
      if (next.fail > 0) next.fail--
      reqs.set(id, r)
      return { requestId: id, statusUrl: `fal://${id}/status`, responseUrl: `fal://${id}`, cancelUrl: `fal://${id}/cancel`, queuePosition: 2 }
    }) as any,
    status: vi.fn(async (url: string) => {
      const r = reqs.get(idOf(url))!
      r.polls++
      const base = { queuePosition: null, logs: [], error: null, transient: false, raw: {} }
      if (r.cancelled) return { ...base, status: 'COMPLETED', error: 'Request was cancelled' }
      if (r.polls === 1) return { ...base, status: 'IN_QUEUE', queuePosition: 1 }
      if (r.held) return { ...base, status: 'IN_PROGRESS', logs: [{ message: 'Generating 50%' }] }
      if (r.failWith) return { ...base, status: 'COMPLETED', error: r.failWith }
      return { ...base, status: 'COMPLETED' }
    }) as any,
    result: vi.fn(async (url: string) => {
      const id = idOf(url)
      const r = reqs.get(id)
      const req = r ? { endpoint: r.endpoint, input: r.payload } : null
      if (req && o.bodyText) return remembered(o.bodyText(req))
      if (req && o.answer) return remembered(JSON.stringify(o.answer(req)))
      return { images: [{ url: `https://fal.media/${id}.png` }], video: { url: `https://fal.media/${id}.mp4` } }
    }) as any,
    cancel: vi.fn(async (url: string) => {
      reqs.get(idOf(url))!.cancelled = true
      return 'cancelled' as const
    }) as any,
    outputUrls: vi.fn(falOutputUrls),
  }
  return {
    client,
    reqs,
    /** The next n submitted requests stay "in progress" until released. */
    holdNext(n: number) { next.hold = n },
    failNext(n: number) { next.fail = n },
    release(id?: string) { for (const r of reqs.values()) if (!id || r.id === id) r.held = false },
    submitted: () => [...reqs.values()],
  }
}

/** Replicate's words for a platform hiccup (a transient failure) and for a real one. */
export const REPLICATE_HICCUP = 'Prediction interrupted; please retry (code: PA)'
export const REPLICATE_REFUSAL = 'The input or output was flagged as sensitive'

/**
 * A fake Replicate in the shape the engine drives (replicateQueue.ts), with
 * Replicate's own states mapped the way the real client maps them:
 * starting → IN_QUEUE, processing → IN_PROGRESS, succeeded/failed/canceled → COMPLETED.
 */
export function createFakeReplicate(o: FakeReplicateAnswers = {}) {
  const reqs = new Map<string, FakeRequest & { transient: boolean }>()
  let seq = 0
  const next = { hold: 0, fail: 0, transient: 0 }
  const idOf = (url: string) => /^replicate:\/\/(pred\d+)/.exec(url)![1]!
  /** The finished prediction's body: programmed, or today's picture. */
  const prediction = (id: string): unknown => {
    const r = reqs.get(id)
    const req = r ? { model: r.endpoint, input: r.payload } : null
    if (req && o.bodyText) return remembered(o.bodyText(req))
    if (req && o.answer) return remembered(JSON.stringify({ id, status: 'succeeded', output: o.answer(req) }))
    return { id, status: 'succeeded', output: [`https://replicate.delivery/${id}.png`] }
  }
  const client: ProviderClient = {
    submit: vi.fn(async (slug: string, payload: Record<string, unknown>) => {
      const id = `pred${++seq}`
      const transient = next.transient > 0
      const r = { id, endpoint: slug, payload, polls: 0, held: next.hold > 0, failWith: transient ? REPLICATE_HICCUP : next.fail > 0 ? REPLICATE_REFUSAL : null, cancelled: false, transient }
      if (next.hold > 0) next.hold--
      if (transient) next.transient--
      else if (next.fail > 0) next.fail--
      reqs.set(id, r)
      return { requestId: id, statusUrl: `replicate://${id}`, responseUrl: `replicate://${id}`, cancelUrl: `replicate://${id}/cancel`, queuePosition: null }
    }) as any,
    status: vi.fn(async (url: string) => {
      const r = reqs.get(idOf(url))!
      r.polls++
      const base = { queuePosition: null, logs: [], error: null, transient: false, retryable: false, raw: {} }
      if (r.cancelled) return { ...base, status: 'COMPLETED', error: 'Replicate: prediction canceled' }
      if (r.polls === 1) return { ...base, status: 'IN_QUEUE' }
      if (r.held) return { ...base, status: 'IN_PROGRESS', logs: [{ message: ' 50%|█████     | 14/28' }] }
      if (r.failWith) return { ...base, status: 'COMPLETED', error: `Replicate: ${r.failWith}`, retryable: isTransientReplicateError(r.failWith) }
      // Matches the real client: the terminal status body already carries the
      // output, so the engine reads it from `raw` and never calls `result`.
      return { ...base, status: 'COMPLETED', raw: prediction(r.id) }
    }) as any,
    result: vi.fn(async (url: string) => prediction(idOf(url))) as any,
    cancel: vi.fn(async (url: string) => {
      reqs.get(idOf(url))!.cancelled = true
      return 'cancelled' as const
    }) as any,
    outputUrls: vi.fn(replicateOutputUrls),
  }
  return {
    client,
    reqs,
    /** The next n submitted predictions stay "processing" until released. */
    holdNext(n: number) { next.hold = n },
    /** The next n submitted predictions fail for good (a model refusal). */
    failNext(n: number) { next.fail = n },
    /** The next n submitted predictions fail with a platform hiccup (worth sending again). */
    hiccupNext(n: number) { next.transient = n },
    release(id?: string) { for (const r of reqs.values()) if (!id || r.id === id) r.held = false },
    submitted: () => [...reqs.values()],
  }
}

export function createFakeLedger(available = 1000) {
  let seq = 0
  const holds = new Map<number, { key: string; credits: number; state: 'open' | 'settled' | 'released'; actual: number | null }>()
  const byKey = new Map<string, number>()
  const ledger: LedgerPort & { holds: typeof holds } = {
    holds,
    hold: vi.fn(async (_u: string, credits: number, key: string) => {
      if (byKey.has(key)) return { ok: true as const, holdId: byKey.get(key)! }
      if (credits > available) return { ok: false as const, reason: 'insufficient' as const }
      available -= credits
      const id = ++seq
      holds.set(id, { key, credits, state: 'open', actual: null })
      byKey.set(key, id)
      return { ok: true as const, holdId: id }
    }),
    settle: vi.fn(async (holdId: number, actual: number) => {
      const h = holds.get(holdId)!
      if (h.state !== 'open') return { settled: h.state === 'settled' }
      h.state = 'settled'; h.actual = actual; available += h.credits - actual
      return { settled: true }
    }),
    release: vi.fn(async (holdId: number) => {
      const h = holds.get(holdId)!
      if (h.state !== 'open') return
      h.state = 'released'; available += h.credits
    }),
    getAvailable: vi.fn(async () => available),
  }
  return ledger
}

let uuidSeq = 0
export const testUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`

export function makeKit(opts: { hosted?: boolean; available?: number; dir?: string; root?: string; fal?: ReturnType<typeof createFakeFal>; replicate?: ReturnType<typeof createFakeReplicate>; ledger?: ReturnType<typeof createFakeLedger>; moderate?: (text: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>; deps?: Partial<EngineDeps> } = {}) {
  const hosted = !!opts.hosted
  const userId = hosted ? 'user_1' : null
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'runner-engine-root-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'runner-engine-runs-'))
  const store = createFileRunStore(dir)
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
  const fal = opts.fal ?? createFakeFal()
  const replicate = opts.replicate ?? createFakeReplicate()
  const ledger = opts.ledger ?? createFakeLedger(opts.available ?? 1000)
  const graphRuns = { create: vi.fn(async () => {}), appendOutput: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
  const metering = createMetering({ hosted: () => hosted, ledger: () => ledger, graphRuns, spendGuard: async () => {}, moderate: opts.moderate ?? (async () => ({ ok: true as const })) })
  const events = createRunEvents()
  const seen: RunnerMessage[] = []
  events.subscribe(userId ?? 'local', m => seen.push(m))
  const upload = vi.fn(async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`)
  const handoff = createHandoff({ upload })
  const records = { write: vi.fn(async () => {}) }
  const deps: EngineDeps = {
    store, providers: { fal: fal.client, replicate: replicate.client }, results, handoff, metering, events, records,
    ownership: { ownsInput: async () => true, ownsOutput: async () => true },
    download: async (url: string) => ({ bytes: new TextEncoder().encode(url), contentType: url.endsWith('.mp4') ? 'video/mp4' : 'image/png' }),
    hosted: () => hosted,
    webhookUrl: () => null,
    now: () => Date.now(),
    sleep: (_ms, signal) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    }),
    newId: testUuid,
    perUserLimit: 4,
    maxTakes: 8,
    timeouts: { imageMs: 300_000, videoMs: 1_800_000 },
    pollDelayMs: () => 1,
    reportError: vi.fn(),
    ...opts.deps,
  }
  const engine = createEngine(deps)
  return { engine, deps, fal, replicate, ledger, graphRuns, seen, records, upload, root, dir, store, userId }
}

/** image(1) → Gate(2) → video(3) → Video card(4); image(1) → Image card(5) */
export function gatedFlow(o: { imageSeed?: number; videoSeed?: number; imageModel?: string; videoModel?: string; bypass?: boolean } = {}): ApiPrompt {
  return {
    '1': { class_type: 'GenerateImageNode', inputs: { model: o.imageModel ?? 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: o.imageSeed ?? 0, model_options: '{}' } },
    '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: !!o.bypass } },
    '3': { class_type: 'GenerateVideoNode', inputs: { model: o.videoModel ?? 'hailuo-h3', prompt: 'the fox runs', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: o.videoSeed ?? 0, model_options: '{}' } },
    '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
    '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
}

export const types = (seen: RunnerMessage[]) => seen.map(m => m.type)
export const ofType = (seen: RunnerMessage[], type: string) => seen.filter(m => m.type === type)

/** Poll until `check` is true (the engine works in the background). */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the engine')
    await new Promise(r => setTimeout(r, 2))
  }
}
