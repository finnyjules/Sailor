/**
 * POST /api/cloud-train/start
 *
 * Body: {
 *   family: 'flux' | 'sdxl_sd15',
 *   datasetUrl: string,         // from /upload
 *   outputName: string,
 *   triggerWord?: string,
 *   steps?: number,
 *   learningRate?: number,
 *   loraRank?: number,
 *   batchSize?: number,
 *   seed?: number,
 * }
 *
 * Fetches the latest version of the chosen Replicate trainer model, then
 * kicks off a prediction. Returns the prediction id; the frontend polls
 * /status with that id.
 *
 * Paid (the most expensive action in the app, 600cr): creates a real
 * Replicate TRAINING. CHARGING POLICY (binding): debits at successful job
 * START, not completion — the provider bills hardware time the moment the
 * training starts regardless of how the resulting weights turn out, so we
 * settle right after Replicate confirms the training was created, not after
 * it finishes. Priced via MODEL_COSTS' 'ostris/*-lora-trainer' rows (same
 * 600cr as the queue path in trainingProviders.ts and LoraTrainingNode's
 * graph-table price) — an unrecognized trainer slug fails closed.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { preflightMeter } from '../../utils/requestMeter'
import { deployMode } from '../../utils/deployMode'
import { recordOwner } from '../../utils/resourceOwners'
import { DEFAULT_LORA_RANK } from '~~/shared/lora-defaults'

function sanitize(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-lora'
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'cloud-train', 3, 600_000)
  const token = requireReplicateToken()

  const body = await readBody(event) as {
    family?: 'flux' | 'sdxl_sd15'
    datasetUrl?: string
    outputName?: string
    triggerWord?: string
    steps?: number
    learningRate?: number
    loraRank?: number
    batchSize?: number
    seed?: number
  }

  if (!body.datasetUrl) throw createError({ statusCode: 400, message: 'datasetUrl is required' })
  if (!body.outputName) throw createError({ statusCode: 400, message: 'outputName is required' })

  const trainerModel = body.family === 'flux'
    ? 'ostris/flux-dev-lora-trainer'
    : 'ostris/sdxl-lora-trainer'

  // Paid: gate on balance/price before spending any hardware time. See the
  // module doc's charging policy — settled below once the training is
  // actually created, not once it finishes.
  const ticket = await preflightMeter(trainerModel)
  try {

    // Fetch the latest version hash for this trainer.
    const modelRes = await fetch(`https://api.replicate.com/v1/models/${trainerModel}`, {
      headers: { Authorization: `Token ${token}` },
    })
    if (!modelRes.ok) {
      const text = await modelRes.text().catch(() => '')
      throw createError({
        statusCode: 502,
        message: `Could not look up trainer model ${trainerModel}: ${text || modelRes.statusText}`,
      })
    }
    const modelInfo = await modelRes.json() as { latest_version?: { id?: string } }
    const version = modelInfo.latest_version?.id
    if (!version) {
      throw createError({ statusCode: 502, message: `Trainer model ${trainerModel} has no latest version` })
    }

    // Build the input dict. Hyperparameters are common to both trainers; only
    // a couple of names differ across the family. We send the union; Replicate
    // ignores unknown keys, and required ones are present in both schemas.
    const input: Record<string, any> = {
      input_images: body.datasetUrl,
      steps: body.steps ?? 500,
      learning_rate: body.learningRate ?? 0.0004,
      lora_rank: body.loraRank ?? DEFAULT_LORA_RANK,
      batch_size: body.batchSize ?? 1,
      seed: body.seed ?? Math.floor(Math.random() * 1_000_000_000),
      autocaption: false, // we ship our own captions via the zip
    }
    if (body.triggerWord) input.trigger_word = body.triggerWord

    // These are TRAINING models — they must be started via the trainings API, not
    // /v1/predictions (which would invoke the model's inference interface and
    // reject with "prompt is required"). A training pushes the resulting weights
    // to a `destination` model the token owner controls, so we resolve the
    // account username and ensure that destination exists first.
    const acctRes = await fetch('https://api.replicate.com/v1/account', {
      headers: { Authorization: `Token ${token}` },
    })
    if (!acctRes.ok) {
      const text = await acctRes.text().catch(() => '')
      throw createError({ statusCode: 502, message: `Could not resolve Replicate account: ${text || acctRes.statusText}` })
    }
    const account = await acctRes.json() as { username?: string }
    const username = account.username
    if (!username) {
      throw createError({ statusCode: 502, message: 'Replicate account returned no username' })
    }

    const destName = `jules-${sanitize(body.outputName)}`
    const destination = `${username}/${destName}`

    // Ensure the destination model exists (create on first use). A 409 / "already
    // exists" just means we've trained to this name before — that's fine.
    const createRes = await fetch('https://api.replicate.com/v1/models', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: username,
        name: destName,
        visibility: 'private',
        hardware: 'gpu-t4',
        description: 'LoRA trained from Sailor.',
      }),
    })
    if (!createRes.ok && createRes.status !== 409) {
      const text = await createRes.text().catch(() => '')
      if (!/already exists/i.test(text)) {
        throw createError({ statusCode: 502, message: `Could not create destination model ${destination}: ${text || createRes.statusText}` })
      }
    }

    // Start the training.
    const trainRes = await fetch(
      `https://api.replicate.com/v1/models/${trainerModel}/versions/${version}/trainings`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination, input }),
      },
    )
    if (!trainRes.ok) {
      const text = await trainRes.text().catch(() => '')
      throw createError({ statusCode: trainRes.status, message: text || trainRes.statusText })
    }

    const training = await trainRes.json() as { id: string; status: string }
    // Debit-on-successful-start: the training was just created on Replicate,
    // so hardware time is now being consumed — settle now, not on completion.
    await ticket?.settle('train:' + training.id)
    // Stage 6 Task 3b: record durable ownership the moment the training id
    // is known, so status.get.ts can gate polls/downloads to the caller who
    // paid for this training. Guarded on a non-empty userId even though the
    // preflight above already requires a bound meter context in hosted mode
    // — never record a bogus/ownerless row.
    if (deployMode() === 'hosted' && event.context.userId) {
      try {
        await recordOwner('cloud-training', training.id, event.context.userId)
      }
      catch (e) {
        // The Replicate training is already created and the wallet already
        // debited (settle above) — a transient Neon/ledger blip here must
        // NOT turn into a 500 that loses the training id (money spent,
        // resource orphaned with no way to ever find it again). Log loudly
        // with everything needed for a manual backfill (INSERT INTO
        // resource_owners(kind, id, user_id) VALUES ('cloud-training',
        // trainingId, userId)) and let the handler return the id below —
        // same "write already happened, fail closed but don't lose the
        // external side effect" precedent as engineGate.ts's recordOwner
        // guards. The caller temporarily can't poll (status.get.ts 404s an
        // unowned id) until the row is backfilled, but they at least have
        // the id instead of a bare 500.
        console.error('[cloud-train] OWNER RECORD FAILED after training create+debit — training orphaned', {
          trainingId: training.id,
          userId: event.context.userId,
          error: e,
        })
      }
    }
    return {
      id: training.id,
      status: training.status,
      family: body.family ?? 'flux',
      outputName: body.outputName,
      trainerModel,
      versionId: version,
      destination,
    }
  } catch (e) {
    // Any throw past the preflight means no output shipped — hand the
    // reservation back instead of letting it sit until holdSweep's TTL.
    // (Releasing an already-settled hold is an idempotent no-op.)
    await ticket?.release()
    throw e
  }
})
