/** The runner engine wired to the real world. One per server process. */
import { randomUUID } from 'node:crypto'
import { createEngine, type Engine } from './engine'
import { getRunStore } from './store'
import { downloadResult, realFalClient } from './falQueue'
import { realReplicateClient } from './replicateQueue'
import { createEngineResultStore } from './results'
import { createHandoff } from './handoff'
import { createMetering } from './metering'
import { createRunEvents } from './events'
import { createGenerationRecords } from './records'
import { runnerFamilies, webhookBaseUrl, RUNNER_PER_USER_LIMIT } from './config'
import { engineDirForType, uploadOwner, canonicalUploadKey } from '../utils/inputUploads'
import { uploadToFalStorage } from '../utils/falStorage'
import { getLiveLedger } from '../utils/ledgerLive'
import { createGraphRun, appendGraphRunOutput, setGraphRunState, ownedOutputKeys, outputKey } from '../utils/graphRuns'
import { assertSpendAllowed } from '../utils/systemControls'
import { moderatePrompt } from '../utils/moderation'
import { ownerOf, recordOwner } from '../utils/resourceOwners'
import { isHosted } from '../utils/deployMode'
import { captureError } from '../utils/observe'
import { nativeGenerationPost } from '../native/router'

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
    providers: { fal: realFalClient, replicate: realReplicateClient },
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
      // Written straight into the project's store (same file the engine route
      // wrote), no HTTP hop to ComfyUI.
      post: async (uuid, body) => {
        const r = await nativeGenerationPost(uuid, body)
        if (r.status < 200 || r.status >= 300) throw new Error(`generation record ${r.status}`)
      },
    }),
    // Network errors and 5xx are tried again (1s, 2s): fal has already billed the result.
    download: url => downloadResult(url),
    hosted: isHosted,
    families: runnerFamilies,
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
