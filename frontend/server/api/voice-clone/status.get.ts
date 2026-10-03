/**
 * GET /api/voice-clone/status?id=...&name=...
 *
 * Polls Replicate for the voice-cloning prediction. When it transitions to
 * `succeeded`, downloads the preview clip and writes the voice into the local
 * voices store (../models/voices/<voice_id>.{json,mp3}) so it appears in the
 * Generate-speech voice gallery and validates as a voice_id combo value.
 *
 * Safe to call repeatedly — persistence is a no-op once the files are on disk.
 *
 * Must be allowlisted in server/middleware/comfyui-proxy.ts (NITRO_API_PREFIXES
 * covers /api/voice-clone).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../utils/dataRoot'
import { CLONE_MODEL } from './start.post'
import { currentMeterContext, releaseRecordedHold, settleModel, settleRecordedHold } from '../../utils/requestMeter'
import { deployMode } from '../../utils/deployMode'
import { decideVoiceCloneSettle, voiceCloneOwner } from '../../utils/voiceCloneOwners'
import { recordOwner } from '../../utils/resourceOwners'

/** MiniMax voice ids are word-ish; keep only path-safe chars for the filename. */
function safeId(id: string): string | null {
  const s = (id || '').trim()
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : null
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

export default defineEventHandler(async (event) => {
  const token = requireReplicateToken()

  const query = getQuery(event)
  const id = String(query.id ?? '')
  const name = String(query.name ?? '').trim()
  if (!id) throw createError({ statusCode: 400, message: 'Missing id' })

  // SETTLES: this route polls a prediction started by /api/voice-clone/
  // start, which reserved the credits (a ledger hold) and left that
  // reservation open. The charge happens here, in the succeeded branch
  // below, once Replicate confirms the clone completed — by settling that
  // same hold. See settleRecordedHold / voiceCloneOwners.ts.
  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (!res.ok) {
    throw createError({ statusCode: res.status, message: await res.text().catch(() => res.statusText) })
  }
  const pred = await res.json() as {
    id: string
    status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
    output?: { voice_id?: string; preview?: string; model?: string } | null
    error?: string | null
    logs?: string
  }

  let voiceId: string | null = null
  let persistError: string | null = null

  if (pred.status === 'succeeded' && pred.output?.voice_id) {
    // Settle-on-success: charge the flat CLONE_MODEL price now that
    // Replicate has confirmed the clone actually completed.
    //
    // Ownership gate (final-review fix): this route settles for whoever
    // polls it with a prediction id, so without a check user B polling
    // user A's id would charge user A's ledger to user B's benefit — and
    // because ledger idempotency is per-user, BOTH could end up charged.
    // Only settle when the polling context user matches the user who paid
    // start.post.ts's preflight for this exact prediction id (see
    // voiceCloneOwners.ts). Note: this only gates the CHARGE — reading this
    // route's status/output for a prediction id you don't own is still
    // possible; that's a Stage-5 tenant-isolation rider, not solved here.
    const decision = deployMode() === 'hosted'
      ? decideVoiceCloneSettle(pred.id, currentMeterContext()?.userId)
      : { settle: true as const, hold: undefined }
    if (decision.settle && decision.hold) {
      // The normal hosted path (Stage 5 Task 2 review fix): start.post.ts
      // left a hold reserving these credits for the whole clone, so the
      // charge is that hold's settlement — NOT an independent debit, which
      // would charge on top of a reservation that only the 2h sweep would
      // ever give back. settleRecordedHold logs loudly (SETTLE ON RELEASED
      // HOLD) if the hold was already released — i.e. the sweep beat this
      // poll and the voice shipped uncharged.
      await settleRecordedHold(decision.hold, CLONE_MODEL, 'rep:' + pred.id)
    } else if (decision.settle) {
      // No hold on the binding: local mode (no ledger at all), or a
      // binding recorded before holds existed. Fall back to the standalone
      // debit so the charge still lands. jobId doubles as the ledger's
      // idempotency key here, so repeated polls stay a no-op.
      await settleModel(CLONE_MODEL, 'rep:' + pred.id)
    } else if (decision.reason === 'unknown-owner') {
      console.warn('[meter] voice-clone settle skipped — ownership unknown (restart?)', { predictionId: pred.id })
    } else {
      console.warn('[meter] voice-clone settle skipped — poller is not the owner', { predictionId: pred.id })
    }

    const safe = safeId(pred.output.voice_id)
    if (!safe) {
      persistError = `Replicate returned an unsafe voice_id: ${pred.output.voice_id}`
    } else {
      try {
        const voicesDir = dataPath('models', 'voices')
        await fs.mkdir(voicesDir, { recursive: true })
        const jsonPath = path.join(voicesDir, `${safe}.json`)
        const mp3Path = path.join(voicesDir, `${safe}.mp3`)

        // Download the preview clip (idempotent — skip if already present).
        if (pred.output.preview && !(await fileExists(mp3Path))) {
          const dl = await fetch(pred.output.preview)
          if (dl.ok) {
            await fs.writeFile(mp3Path, Buffer.from(await dl.arrayBuffer()))
          }
        }

        const sidecar = {
          voice_id: safe,
          name: name || safe,
          model: pred.output.model || 'speech-02-hd',
          provider: 'replicate',
          prediction_id: pred.id,
          created: new Date().toISOString(),
        }
        await fs.writeFile(jsonPath, JSON.stringify(sidecar, null, 2))
        voiceId = safe

        // DURABLE VOICE OWNERSHIP (Stage 6 Task 5 — this is where it lands, the
        // seam voiceCloneOwners.ts's doc comment pointed at). The voice's owner
        // is the user start.post.ts bound to this prediction id, NOT whoever is
        // polling now — so we read it from the in-memory binding, never the
        // poller's context. If the binding is gone (process restarted between
        // start and this poll) the owner is genuinely unknown: record NOTHING
        // rather than guess, leaving the voice curated/global. recordOwner is a
        // hosted-only no-op guard away — local mode writes zero registry rows.
        //
        // Kept inside the outer try (self-heals: recordOwner is an ON CONFLICT
        // DO NOTHING upsert, so a transient DB error here just leaves the voice
        // unowned/globally-visible until the next poll re-records it), but in
        // its OWN try/catch so a recordOwner failure logs distinctly from a
        // sidecar-persist failure below — by the time we're here the sidecar is
        // already written and voiceId is already set, so this is not the same
        // failure as persistError and shouldn't read like one.
        if (deployMode() === 'hosted') {
          const owner = voiceCloneOwner(pred.id)
          if (owner) {
            try {
              await recordOwner('voice', safe, owner)
            } catch (ownerErr: any) {
              console.warn('[stage6] voice ownership record FAILED — voice is temporarily unowned/globally visible until the next poll re-records it', {
                predictionId: pred.id, voiceId: safe, error: ownerErr?.message ?? String(ownerErr),
              })
            }
          } else {
            console.warn('[stage6] voice ownership not recorded — binding unknown (restart?)', { predictionId: pred.id, voiceId: safe })
          }
        }
      } catch (err: any) {
        persistError = err?.message ?? String(err)
      }
    }
  } else if (pred.status === 'failed' || pred.status === 'canceled') {
    // RELEASE ON TERMINAL FAILURE (review fix, Stage 5 Task 2): without
    // this, a failed/canceled clone left its 450cr hold reserved for the
    // full 2h sweep TTL even though this very poll already observed the
    // terminal state — the job will never settle, so the hold should come
    // back now, not two hours from now. Same ownership gate as the
    // settle-on-success branch above: only the user who paid
    // start.post.ts's preflight for this exact prediction id can release
    // its hold (decideVoiceCloneSettle's name is generic — it just answers
    // "does this poller own this prediction's hold").
    const decision = deployMode() === 'hosted'
      ? decideVoiceCloneSettle(pred.id, currentMeterContext()?.userId)
      : { settle: true as const, hold: undefined }
    if (decision.settle && decision.hold) {
      await releaseRecordedHold(decision.hold, CLONE_MODEL, 'rep:' + pred.id)
    } else if (decision.settle) {
      // No hold on the binding: local mode (no ledger at all), or a
      // binding recorded before holds existed — nothing was reserved, so
      // there's nothing to give back.
    } else if (decision.reason === 'unknown-owner') {
      console.warn('[meter] voice-clone release skipped — ownership unknown (restart?)', { predictionId: pred.id })
    } else {
      console.warn('[meter] voice-clone release skipped — poller is not the owner', { predictionId: pred.id })
    }
  }

  return {
    id: pred.id,
    status: pred.status,
    voiceId,
    error: pred.error ?? persistError ?? null,
    logs: pred.logs ? pred.logs.slice(-1500) : undefined,
  }
})
