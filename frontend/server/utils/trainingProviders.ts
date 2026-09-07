/**
 * Replicate provider for the training queue: start + poll(+finalize) for both
 * LoRA (style/character) and voice clones. Mirrors the logic that used to live
 * in /api/cloud-train/{start,status} and /api/voice-clone/{start,status}, moved
 * server-side so it runs headlessly from the queue runner.
 *
 * Token is passed in (fetched fresh by the plugin each tick) rather than read
 * from the request, since there's no request when the runner ticks.
 */
import { promises as fs } from 'node:fs'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import type { TrainingJob } from './trainingQueue'
import { DEFAULT_LORA_RANK } from '~~/shared/lora-defaults'
import type { ProviderResult, RunnerProvider } from './trainingRunner'
import { linkTrainedCharacter } from './characterLink'
import { MeterRefusalError, preflightMeterFor } from './requestMeter'
import { deployMode } from './deployMode'
import { recordOwner } from './resourceOwners'
import { VOICE_CLONE_MODEL } from './priceBook'

const exec = promisify(execCb)

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'my_lora'
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

const REPLICATE = 'https://api.replicate.com/v1'
function authHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Token ${token}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

// --- shared download (direct .safetensors or .tar containing one) ------------

async function downloadWeights(outputUrl: string, destPath: string): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const dlRes = await fetch(outputUrl)
    if (!dlRes.ok) return { ok: false, error: `download HTTP ${dlRes.status}` }
    const buf = Buffer.from(await dlRes.arrayBuffer())

    const looksLikeTar = /\.tar(\.gz)?($|\?)/i.test(outputUrl)
    if (!looksLikeTar) {
      await fs.writeFile(destPath, buf)
      return { ok: true }
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailor-lora-'))
    const tarPath = path.join(tmpDir, 'out.tar')
    try {
      await fs.writeFile(tarPath, buf)
      await exec(`tar -xf ${JSON.stringify(tarPath)} -C ${JSON.stringify(tmpDir)}`)
      const entries = await fs.readdir(tmpDir, { recursive: true }) as string[]
      const safetensor = entries.find(e => e.endsWith('.safetensors'))
      if (!safetensor) return { ok: false, error: 'tar archive contained no .safetensors file' }
      await fs.copyFile(path.join(tmpDir, safetensor), destPath)
      return { ok: true }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

// --- LoRA --------------------------------------------------------------------

function loraTrainerModel(family: unknown): string {
  return family === 'flux' ? 'ostris/flux-dev-lora-trainer' : 'ostris/sdxl-lora-trainer'
}

async function startLora(job: TrainingJob, token: string): Promise<ProviderResult> {
  const p = job.params as Record<string, any>
  const trainerModel = loraTrainerModel(p.family)

  const modelRes = await fetch(`${REPLICATE}/models/${trainerModel}`, { headers: authHeaders(token) })
  if (!modelRes.ok) throw new Error(`Could not look up trainer model ${trainerModel}: ${await modelRes.text().catch(() => modelRes.statusText)}`)
  const version = (await modelRes.json() as { latest_version?: { id?: string } }).latest_version?.id
  if (!version) throw new Error(`Trainer model ${trainerModel} has no latest version`)

  const input: Record<string, any> = {
    input_images: job.datasetUrl,
    steps: p.steps ?? 500,
    learning_rate: p.learningRate ?? 0.0004,
    lora_rank: p.loraRank ?? DEFAULT_LORA_RANK,
    batch_size: p.batchSize ?? 1,
    seed: p.seed ?? Math.floor(Math.random() * 1_000_000_000),
    autocaption: false,
  }
  if (job.trigger) input.trigger_word = job.trigger

  const acctRes = await fetch(`${REPLICATE}/account`, { headers: authHeaders(token) })
  if (!acctRes.ok) throw new Error(`Could not resolve Replicate account: ${await acctRes.text().catch(() => acctRes.statusText)}`)
  const username = (await acctRes.json() as { username?: string }).username
  if (!username) throw new Error('Replicate account returned no username')

  const destName = `jules-${sanitize(job.outputName).toLowerCase().replace(/_/g, '-')}`
  const destination = `${username}/${destName}`

  const createRes = await fetch(`${REPLICATE}/models`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ owner: username, name: destName, visibility: 'private', hardware: 'gpu-t4', description: 'LoRA trained from Sailor.' }),
  })
  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text().catch(() => '')
    if (!/already exists/i.test(text)) throw new Error(`Could not create destination model ${destination}: ${text || createRes.statusText}`)
  }

  const trainRes = await fetch(`${REPLICATE}/models/${trainerModel}/versions/${version}/trainings`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ destination, input }),
  })
  if (!trainRes.ok) throw new Error(await trainRes.text().catch(() => trainRes.statusText))
  const training = await trainRes.json() as { id: string, status: string }

  return { replicateId: training.id, destination, status: 'starting' }
}

async function pollLora(job: TrainingJob, token: string): Promise<ProviderResult> {
  if (!job.replicateId) return {}
  const res = await fetch(`${REPLICATE}/trainings/${job.replicateId}`, { headers: authHeaders(token) })
  if (!res.ok) {
    // 404/410 = the training is gone (expired/deleted). Terminalize so the job
    // stops occupying a concurrency slot; a transient 5xx throws and retries.
    if (res.status === 404 || res.status === 410) {
      return { status: 'failed', error: `Replicate training ${job.replicateId} is no longer available (HTTP ${res.status}).` }
    }
    throw new Error(await res.text().catch(() => res.statusText))
  }
  const pred = await res.json() as {
    id: string
    status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
    output?: string | string[] | { weights?: string, url?: string, version?: string } | null
    error?: string | null
    logs?: string
  }

  const logsTail = pred.logs ? pred.logs.slice(-1500) : null
  const out: any = pred.output
  const outputUrl: string | null = out == null ? null
    : typeof out === 'string' ? out
    : Array.isArray(out) ? out[0]
    : (out.weights || out.url || null)

  if (pred.status === 'processing' || pred.status === 'starting') {
    // Inch the bar so the UI shows life; real % isn't exposed by the trainer.
    const next = Math.min(90, (job.progressPct || 0) + (pred.status === 'processing' ? 3 : 0))
    return { status: pred.status, progressPct: next, logsTail }
  }

  if (pred.status === 'succeeded' && outputUrl) {
    const lorasDir = path.resolve(process.cwd(), '..', 'models', 'loras')
    await fs.mkdir(lorasDir, { recursive: true })
    const filename = `${sanitize(job.outputName)}.safetensors`
    const localPath = path.join(lorasDir, filename)

    if (!(await fileExists(localPath))) {
      const dl = await downloadWeights(outputUrl, localPath)
      if (!dl.ok) return { status: 'failed', error: dl.error, logsTail }
      const modelRef = out && typeof out === 'object' && !Array.isArray(out) && typeof out.version === 'string' ? out.version : null
      const sidecar = {
        name: sanitize(job.outputName),
        base_model: (job.params as any).family === 'flux' ? 'flux-dev' : 'sdxl',
        provider: 'replicate',
        trigger: job.trigger || null,
        replicate_prediction_id: pred.id,
        replicate_model: modelRef,
        replicate_url: outputUrl,
        aesthetic: job.aesthetic || null,
        kind: job.loraKind === 'character' ? 'character' : 'style',
        trained_on: new Date().toISOString(),
      }
      await fs.writeFile(localPath.replace(/\.safetensors$/, '.json'), JSON.stringify(sidecar, null, 2))
      // C1 — CLAIM the trained LoRA for the job's owner (hosted only). Without
      // this the weights + sidecar land with no resource_owners row, so
      // loras-local.get lists them to EVERY tenant as curated content and the
      // creator can't mutate their own artifact. Keyed by the .safetensors base
      // (sanitize(job.outputName)) — the exact id loras-local.get lists by. An
      // unbound job (no userId) records nothing rather than guessing. Best-effort:
      // the weights are already on disk, so a registry hiccup mustn't fail finalize.
      if (deployMode() === 'hosted' && job.userId) {
        try { await recordOwner('lora', sanitize(job.outputName), job.userId) }
        catch (err) { console.warn('[training] lora ownership record failed', { outputName: job.outputName, userId: job.userId, error: err }) }
      }
      // Link the character registry so this identity shows up in the
      // Characters panel (ready, with a LoRA chip) without a manual step.
      // Best-effort: the weights + sidecar are already safely on disk, so a
      // registry hiccup here shouldn't fail the poll/finalize.
      if (job.loraKind === 'character') {
        await linkTrainedCharacter({ displayName: job.displayName, weightsFilename: filename, trigger: job.trigger ?? null, ownerUserId: job.userId ?? null }).catch((err) => {
          console.warn('[training] registry link failed', err)
        })
      }
    }
    return { status: 'succeeded', progressPct: 100, localFilename: filename, logsTail }
  }

  if (pred.status === 'succeeded' && !outputUrl) {
    return { status: 'failed', error: 'Training succeeded but returned no weights URL.', logsTail }
  }
  return { status: pred.status, error: pred.error ?? null, logsTail }
}

// --- Voice -------------------------------------------------------------------

function safeVoiceId(id: string): string | null {
  const s = (id || '').trim()
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : null
}

async function startVoice(job: TrainingJob, token: string): Promise<ProviderResult> {
  const p = job.params as Record<string, any>
  const input: Record<string, any> = {
    voice_file: job.datasetUrl,
    model: 'speech-02-hd',
    accuracy: typeof p.accuracy === 'number' ? p.accuracy : 0.7,
    need_noise_reduction: !!p.needNoiseReduction,
    need_volume_normalization: !!p.needVolumeNormalization,
  }
  const res = await fetch(`${REPLICATE}/models/${VOICE_CLONE_MODEL}/predictions`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ input }),
  })
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
  const pred = await res.json() as { id: string, status: string }
  return { replicateId: pred.id, status: 'starting' }
}

async function pollVoice(job: TrainingJob, token: string): Promise<ProviderResult> {
  if (!job.replicateId) return {}
  const res = await fetch(`${REPLICATE}/predictions/${job.replicateId}`, { headers: authHeaders(token) })
  if (!res.ok) {
    // 404/410 = the prediction is gone. Terminalize so the job frees its slot;
    // a transient 5xx throws and is retried on the next tick.
    if (res.status === 404 || res.status === 410) {
      return { status: 'failed', error: `Replicate prediction ${job.replicateId} is no longer available (HTTP ${res.status}).` }
    }
    throw new Error(await res.text().catch(() => res.statusText))
  }
  const pred = await res.json() as {
    id: string
    status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
    output?: { voice_id?: string, preview?: string, model?: string } | null
    error?: string | null
    logs?: string
  }
  const logsTail = pred.logs ? pred.logs.slice(-1500) : null

  if (pred.status === 'starting' || pred.status === 'processing') {
    const next = Math.min(90, (job.progressPct || 0) + (pred.status === 'processing' ? 5 : 0))
    return { status: pred.status, progressPct: next, logsTail }
  }

  if (pred.status === 'succeeded' && pred.output?.voice_id) {
    const safe = safeVoiceId(pred.output.voice_id)
    if (!safe) return { status: 'failed', error: `Replicate returned an unsafe voice_id: ${pred.output.voice_id}`, logsTail }
    const voicesDir = path.resolve(process.cwd(), '..', 'models', 'voices')
    await fs.mkdir(voicesDir, { recursive: true })
    const jsonPath = path.join(voicesDir, `${safe}.json`)
    const mp3Path = path.join(voicesDir, `${safe}.mp3`)
    if (pred.output.preview && !(await fileExists(mp3Path))) {
      const dl = await fetch(pred.output.preview)
      if (dl.ok) await fs.writeFile(mp3Path, Buffer.from(await dl.arrayBuffer()))
    }
    const sidecar = {
      voice_id: safe,
      name: job.displayName || safe,
      model: pred.output.model || 'speech-02-hd',
      provider: 'replicate',
      prediction_id: pred.id,
      created: new Date().toISOString(),
    }
    await fs.writeFile(jsonPath, JSON.stringify(sidecar, null, 2))
    return { status: 'succeeded', progressPct: 100, localFilename: `${safe}.json`, logsTail }
  }

  if (pred.status === 'succeeded') {
    return { status: 'failed', error: 'Voice clone succeeded but returned no voice_id.', logsTail }
  }
  return { status: pred.status, error: pred.error ?? null, logsTail }
}

// --- dispatch ----------------------------------------------------------------

/**
 * CHARGING POLICY (binding): a training/voice-clone job debits at successful
 * JOB START, not completion — the provider bills hardware time the moment
 * the job starts, regardless of whether the resulting weights/voice turn out
 * useful. So we meter around the real startLora/startVoice call, not around
 * pollLora/pollVoice's eventual 'succeeded' branch.
 *
 * This runner ticks on a timer (server/plugins/trainingQueueRunner.ts) with
 * no HTTP request in flight, so there is no AsyncLocalStorage context for
 * preflightMeter to read a userId from (see requestMeter.ts's module doc on
 * ALS propagation) — job.userId, captured at enqueue time from the request
 * that queued it (server/api/training-queue/index.post.ts), is threaded
 * through explicitly via preflightMeterFor instead.
 *
 * OWNERSHIP POLICY (mode-based, not key-presence-based — review escalation
 * 2026-08-15): job.userId is `string | null | undefined` on the TrainingJob
 * type, but JSON.stringify DROPS keys whose value is `undefined` — so BOTH a
 * legacy job persisted before userId existed on the record AND a job
 * enqueued in local mode (which explicitly writes `userId: null`) end up
 * indistinguishable on disk from "the key is simply absent". A truthy check
 * on job.userId alone can't tell "no owner because local mode" from "no
 * owner because hosted mode lost the attribution" — and a hosted server
 * restarting with queued/legacy jobs like that would run them for free
 * (600cr of hardware time, unattributed). So the gate is deployMode(), not
 * job.userId's presence:
 *   - hosted + job.userId is NOT a string (undefined, null, or missing) →
 *     fail closed. Do not call the provider at all — refuse before any
 *     hardware spend, for ANY job without an owner, legacy record or
 *     local-enqueued leftover alike.
 *   - hosted + job.userId IS a string → meter normally via preflightMeterFor.
 *   - local mode → always unmetered (preflightMeterFor's own deployMode()
 *     check also returns null here, so this is belt-and-suspenders).
 * Pricing comes from MODEL_COSTS via resolveCredits inside preflightMeterFor:
 * the LoRA family maps to one of the 'ostris/*-lora-trainer' rows (600cr,
 * matching LoraTrainingNode's graph-table price) and voice maps to
 * VOICE_CLONE_MODEL ('minimax/voice-cloning'). A slug the book doesn't
 * recognize REFUSES (preflightMeterFor throws) rather than inventing a
 * fallback price.
 *
 * Settle only fires once the provider has confirmed the job actually
 * started (a replicateId came back) — a start() that throws before that
 * (network error, bad request, Replicate rejection, etc.) leaves the ticket
 * unsettled, so nothing is charged for a job that never started. A refusal
 * (e.g. insufficient credits, or the ownership guard above) propagates out
 * of start(), which the runner's existing tickQueue catch already turns
 * into a 'failed' job carrying the refusal's message — see
 * trainingRunner.ts's `try { ... } catch` around provider.start(job) in its
 * queued-job loop.
 */
async function startWithMetering(job: TrainingJob, token: string): Promise<ProviderResult> {
  const model = job.kind === 'voice' ? VOICE_CLONE_MODEL : loraTrainerModel((job.params as Record<string, any>)?.family)
  const hasOwner = typeof job.userId === 'string'

  if (deployMode() === 'hosted' && !hasOwner) {
    throw new Error('training requires a signed-in account — re-queue this training')
  }

  let ticket: Awaited<ReturnType<typeof preflightMeterFor>> = null
  if (hasOwner) {
    try {
      ticket = await preflightMeterFor(job.userId as string, model)
    } catch (err) {
      // Surface the {required, available} numbers in the message itself —
      // the runner's failed-job record only carries err.message (see the
      // doc above), so a bare 'insufficient credits' string loses the
      // actionable detail that was right there on the refusal.
      if (err instanceof MeterRefusalError) {
        const data = err.data as { required?: number; available?: number } | undefined
        if (data && typeof data.required === 'number' && typeof data.available === 'number') {
          throw new Error(`insufficient credits — need ${data.required}, have ${data.available}`)
        }
      }
      throw err
    }
  }

  // Stage 5 Task 2: the preflight above now RESERVES the credits. A start()
  // that throws, or one that comes back without a replicateId (nothing
  // actually started), must hand the reservation back — otherwise 600cr of
  // training budget stays locked until holdSweep's TTL.
  let result: ProviderResult
  try {
    result = job.kind === 'voice' ? await startVoice(job, token) : await startLora(job, token)
  } catch (e) {
    await ticket?.release()
    throw e
  }
  if (ticket && !result.replicateId) await ticket.release()

  if (ticket && result.replicateId) {
    // Debit key: train:<training id> — never the reserved settle:/expire:
    // prefixes. Reason (`provider:<slug>`) is set inside preflightMeterFor's
    // ticket.
    await ticket.settle(`train:${result.replicateId}`)
  }
  return result
}

/** Build a RunnerProvider that reads a fresh token per call via getToken(). */
export function createReplicateProvider(getToken: () => string): RunnerProvider {
  return {
    start: (job) => startWithMetering(job, getToken()),
    poll: (job) => job.kind === 'voice' ? pollVoice(job, getToken()) : pollLora(job, getToken()),
  }
}

/** Cancel a running Replicate training/prediction (best-effort). */
export async function cancelReplicate(job: TrainingJob, token: string): Promise<void> {
  if (!job.replicateId) return
  const endpoint = job.kind === 'voice'
    ? `${REPLICATE}/predictions/${job.replicateId}/cancel`
    : `${REPLICATE}/trainings/${job.replicateId}/cancel`
  await fetch(endpoint, { method: 'POST', headers: authHeaders(token) }).catch(() => {})
}
