/** The runner engine wired to the real world. One per server process. */
import { randomUUID } from 'node:crypto'
import { createEngine, type Engine } from './engine'
import { getRunStore } from './store'
import { realFalClient } from './falQueue'
import { createEngineResultStore } from './results'
import { createHandoff } from './handoff'
import { createMetering } from './metering'
import { createRunEvents } from './events'
import { createGenerationRecords } from './records'
import { webhookBaseUrl, RUNNER_PER_USER_LIMIT } from './config'
import { engineDirForType, uploadOwner, canonicalUploadKey } from '../utils/inputUploads'
import { uploadToFalStorage } from '../utils/falStorage'
import { getLiveLedger } from '../utils/ledgerLive'
import { createGraphRun, appendGraphRunOutput, setGraphRunState, ownedOutputKeys, outputKey } from '../utils/graphRuns'
import { assertSpendAllowed } from '../utils/systemControls'
import { moderatePrompt } from '../utils/moderation'
import { ownerOf, recordOwner } from '../utils/resourceOwners'
import { isHosted } from '../utils/deployMode'
import { captureError } from '../utils/observe'

const ENGINE_ORIGIN = 'http://127.0.0.1:8188'

/** comfy_api_nodes/fal_refs.py's ramp: min(2s, 0.35s × 1.5^attempt). */
export function pollDelayMs(attempt: number): number {
  return Math.min(2000, Math.round(350 * 1.5 ** attempt))
}

const g = globalThis as unknown as { __sailorRunnerEngine?: Engine }
let override: Engine | null = null

export function __setEngineForTests(e: Engine | null): void { override = e }

export function getEngine(): Engine {
  if (override) return override
  if (g.__sailorRunnerEngine) return g.__sailorRunnerEngine
  const results = createEngineResultStore({ dirForType: t => engineDirForType(t), hosted: isHosted })
  const engine = createEngine({
    store: getRunStore(),
    fal: realFalClient,
    results,
    handoff: createHandoff({ read: f => results.read(f), upload: uploadToFalStorage }),
    metering: createMetering({
      hosted: isHosted,
      ledger: () => getLiveLedger(),
      graphRuns: {
        create: r => createGraphRun(r),
        appendOutput: (id, key) => appendGraphRunOutput(id, key),
        resolve: (id, state) => setGraphRunState(id, state),
      },
      spendGuard: assertSpendAllowed,
      moderate: moderatePrompt,
    }),
    events: createRunEvents(),
    ownership: {
      ownsInput: async (userId, f) => (await uploadOwner(canonicalUploadKey('input', f.subfolder, f.filename))) === userId,
      ownsOutput: async (userId, f) => (await ownedOutputKeys(userId)).has(outputKey(f)),
    },
    records: createGenerationRecords({
      hosted: isHosted,
      ownerOf,
      recordOwner,
      post: async (uuid, body) => {
        const r = await fetch(`${ENGINE_ORIGIN}/sailor/projects/${encodeURIComponent(uuid)}/generations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!r.ok) throw new Error(`generation record ${r.status}`)
      },
    }),
    download: async (url) => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`Could not download the result (${r.status})`)
      return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get('content-type') }
    },
    hosted: isHosted,
    webhookUrl: () => {
      const base = webhookBaseUrl()
      return base ? `${base}/api/webhooks/fal` : null
    },
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    }),
    newId: () => randomUUID(),
    perUserLimit: RUNNER_PER_USER_LIMIT,
    maxTakes: 8,
    timeouts: { imageMs: 5 * 60_000, videoMs: 30 * 60_000 },
    pollDelayMs,
    reportError: (e, ctx) => {
      console.error('[runner]', ctx, e)
      captureError(e, ctx)
    },
  })
  g.__sailorRunnerEngine = engine
  return engine
}
