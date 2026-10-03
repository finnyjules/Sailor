/**
 * GET /api/cloud-train/status?id=...&outputName=...&family=...
 *
 * Polls Replicate for the prediction status. When it transitions to
 * `succeeded`, downloads the output (either a direct .safetensors or a .tar
 * containing one), saves to the LoRA library (library/loras/<outputName>.safetensors), and
 * writes a sidecar .json with provenance.
 *
 * Safe to call repeatedly — the download step is a no-op once the file is
 * already on disk.
 *
 * METER-EXEMPT: poll/finalize only — this never creates a new provider job.
 * The training this polls was already billed at successful START by
 * /api/cloud-train/start (this legacy direct path) or by the training-queue
 * runner (trainingProviders.ts), per the debit-at-start charging policy.
 */
import { promises as fs } from 'node:fs'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { findInLibrary, libraryDir } from '../../utils/library'
import os from 'node:os'
import { linkTrainedCharacter } from '~~/server/utils/characterLink'
import { deployMode } from '../../utils/deployMode'
import { ownerOf, recordOwner } from '../../utils/resourceOwners'

const exec = promisify(execCb)

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'my_lora'
}

/**
 * Replicate's Flux LoRA trainer returns a URL to a .tar containing
 * `lora.safetensors` and a config. SDXL trainers usually return a direct
 * .safetensors URL. We auto-detect by extension.
 */
async function downloadAndPlace(
  outputUrl: string,
  destPath: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const dlRes = await fetch(outputUrl)
    if (!dlRes.ok) return { ok: false, error: `download HTTP ${dlRes.status}` }
    const buf = Buffer.from(await dlRes.arrayBuffer())

    const looksLikeTar = /\.tar(\.gz)?($|\?)/i.test(outputUrl)
    if (!looksLikeTar) {
      await fs.writeFile(destPath, buf)
      return { ok: true }
    }

    // Extract .tar into a temp dir, find the .safetensors, copy it to destPath.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sailor-lora-'))
    const tarPath = path.join(tmpDir, 'out.tar')
    try {
      await fs.writeFile(tarPath, buf)
      await exec(`tar -xf ${JSON.stringify(tarPath)} -C ${JSON.stringify(tmpDir)}`)
      const entries = await fs.readdir(tmpDir, { recursive: true }) as string[]
      const safetensor = entries.find((e) => e.endsWith('.safetensors'))
      if (!safetensor) {
        return { ok: false, error: 'tar archive contained no .safetensors file' }
      }
      await fs.copyFile(path.join(tmpDir, safetensor), destPath)
      return { ok: true }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

export default defineEventHandler(async (event) => {
  const token = requireReplicateToken()

  const query = getQuery(event)
  const id = String(query.id ?? '')
  const outputName = sanitize(String(query.outputName ?? 'my_lora'))
  const family = String(query.family ?? 'flux')
  const triggerWord = String(query.triggerWord ?? '').trim()
  // Aesthetic generated at train time (see /aesthetic). Stored
  // in the sidecar and prepended to prompts so generations match the trained look.
  const aesthetic = String(query.aesthetic ?? '').trim()
  // 'character' tags the LoRA as an identity so it lands in the Characters
  // panel; anything else is a style. Written into the sidecar at train time.
  const kind = String(query.kind ?? '').trim() === 'character' ? 'character' : 'style'
  // Human-facing name for the registry record — falls back to outputName
  // (mirrors training-queue's own displayName-or-outputName convention).
  const displayName = String(query.displayName ?? '').trim() || outputName
  if (!id) throw createError({ statusCode: 400, message: 'Missing id' })

  // Stage 6 Task 3b: ownership gate, BEFORE any Replicate poll or weights
  // download. An id with no owner row (legacy training from before this
  // task, or a local-mode record replayed on a hosted server) is refused
  // exactly like a mismatched owner — fail closed, never guess an owner.
  // Same "404, not 403" discipline as training-queue/voice-clone: no
  // existence disclosure to a caller who doesn't own this id.
  if (deployMode() === 'hosted') {
    const owner = await ownerOf('cloud-training', id)
    const userId = event.context.userId
    if (!userId || owner !== userId) {
      throw createError({ statusCode: 404, message: 'Training not found' })
    }
  }

  // Cloud LoRA jobs are Replicate *trainings*, not predictions.
  const res = await fetch(`https://api.replicate.com/v1/trainings/${id}`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (!res.ok) {
    throw createError({ statusCode: res.status, message: await res.text().catch(() => res.statusText) })
  }
  const pred = await res.json() as {
    id: string
    status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
    // Trainings return the weights URL — a bare string, or an object like
    // { weights: <tar url>, version: <owner>/<model>:<hash> }. `version` is the
    // trained model pushed to our destination; it's the form flux-dev-lora's
    // `lora_weights` accepts (the `weights` .tar is NOT — it can't parse it).
    output?: string | string[] | { weights?: string, url?: string, version?: string } | null
    error?: string | null
    logs?: string
    metrics?: { predict_time?: number }
  }

  let localFilename: string | null = null
  let downloadError: string | null = null

  const out: any = pred.output
  const outputUrl: string | null = out == null ? null
    : typeof out === 'string' ? out
    : Array.isArray(out) ? out[0]
    : (out.weights || out.url || null)

  // The trained Replicate model reference (`<owner>/<model>:<hash>`). This is
  // what inference (flux-dev-lora `lora_weights`) needs — the `.tar` weights URL
  // above is download-only. Present only on object-shaped training output.
  const modelRef: string | null =
    out && typeof out === 'object' && !Array.isArray(out) && typeof out.version === 'string'
      ? out.version
      : null

  if (pred.status === 'succeeded' && outputUrl) {
    const lorasDir = libraryDir('loras')
    await fs.mkdir(lorasDir, { recursive: true })
    const filename = `${outputName}.safetensors`
    const localPath = path.join(lorasDir, filename)

    if (await findInLibrary('loras', filename)) {
      localFilename = filename // already downloaded; idempotent poll
    } else {
      const dl = await downloadAndPlace(outputUrl, localPath)
      if (dl.ok) {
        localFilename = filename
        // Sidecar JSON — referenced by the FluxLoRA inference node to map a
        // local filename back to its Replicate source. `replicate_model` is the
        // trained model ref used for inference; `replicate_url` is the weights
        // .tar kept for provenance/re-download only.
        const sidecar = {
          name: outputName,
          base_model: family === 'flux' ? 'flux-dev' : 'sdxl',
          provider: 'replicate',
          trigger: triggerWord || null,
          replicate_prediction_id: pred.id,
          replicate_model: modelRef,
          replicate_url: outputUrl,
          aesthetic: aesthetic || null,
          kind,
          trained_on: new Date().toISOString(),
        }
        await fs.writeFile(
          localPath.replace(/\.safetensors$/, '.json'),
          JSON.stringify(sidecar, null, 2),
        )
        // C1 — CLAIM the trained LoRA for the cloud-training owner (hosted
        // only). The ownership gate at the top already proved
        // event.context.userId === ownerOf('cloud-training', id), so the caller
        // here IS the verified owner; recording anything else (or nothing) would
        // leave the artifact curated/global. Keyed by the .safetensors base
        // (outputName, already sanitized) — the id loras-local.get lists by.
        // Best-effort: the weights are on disk, so a registry hiccup mustn't
        // fail the poll. An unbound/legacy id never reaches here (gate 404s it).
        if (deployMode() === 'hosted' && event.context.userId) {
          try { await recordOwner('lora', outputName, event.context.userId) }
          catch (err) { console.warn('[cloud-train/status] lora ownership record failed', { outputName, userId: event.context.userId, error: err }) }
        }
        // Link the character registry so this identity shows up in the
        // Characters panel (ready, with a LoRA chip) without a manual step.
        // Best-effort: the weights + sidecar are already safely on disk, so a
        // registry hiccup here shouldn't surface as a failed training poll.
        if (kind === 'character') {
          await linkTrainedCharacter({ displayName, weightsFilename: filename, trigger: triggerWord || null, ownerUserId: event.context.userId ?? null }).catch((err) => {
            console.warn('[cloud-train/status] character registry link failed', err)
          })
        }
      } else {
        downloadError = dl.error
      }
    }
  }

  // Tail last ~1500 chars of logs so the surface can show progress hints.
  const logsTail = pred.logs ? pred.logs.slice(-1500) : undefined

  return {
    id: pred.id,
    status: pred.status,
    output: outputUrl,
    // Bare `<owner>/<model>` (no version) — the inference node runs this DIRECTLY.
    // Drive the node via this, NOT the `.tar` output URL (which can't be parsed).
    replicateModel: modelRef ? modelRef.split(':')[0] : null,
    error: pred.error ?? downloadError ?? null,
    logs: logsTail,
    predictTime: pred.metrics?.predict_time ?? null,
    localFilename,
  }
})
