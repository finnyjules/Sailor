/**
 * Make a trained LoRA's weights reachable by fal.
 *
 * Training still runs on Replicate, so a trained style arrives as a private
 * Replicate model plus `replicate_url` — a public `trained_model.tar` (~330 MB)
 * on replicate.delivery whose payload is `output/flux_train_replicate/
 * lora.safetensors`. `fal-ai/flux-lora` wants a URL to the safetensors itself,
 * so the first generation per LoRA lifts the file out of the tar, uploads it to
 * fal storage, and records the resulting CDN URL on the sidecar as
 * `fal_weights_url`. Every later generation reads that field and costs nothing.
 *
 * The tar is never held in memory: it streams to a temp file, the venv's Python
 * (`scripts/lora_extract_safetensors.py`, stdlib `tarfile`) streams the member
 * out of it, and only the extracted safetensors is read into a Buffer — once,
 * to hand to `uploadToFalStorage`. Both temp files are removed in `finally`.
 */
import { execFile } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { uploadToFalStorage } from './falStorage'

export interface LoraSidecar {
  name?: string
  trigger?: string | null
  replicate_model?: string
  replicate_url?: string
  fal_weights_url?: string
  [key: string]: unknown
}

/** 10 minutes: a 330 MB tar on a slow link plus the extraction. */
const EXTRACT_TIMEOUT_MS = 600_000

/**
 * First `.safetensors` name, `lora.safetensors` winning over anything else.
 * The TypeScript twin of `pick_member` in scripts/lora_extract_safetensors.py —
 * the Python is what actually runs; this exists so the preference rule is
 * testable without a tar, and so both sides can be read side by side.
 */
export function pickSafetensorsMember(names: string[]): string | null {
  const candidates = (names ?? []).filter(n => typeof n === 'string' && n.toLowerCase().endsWith('.safetensors'))
  if (!candidates.length) return null
  const exact = candidates.find(n => (n.split('/').pop() ?? '').toLowerCase() === 'lora.safetensors')
  return exact ?? candidates[0]!
}

/**
 * Sidecar + the fal weights URL, every other field untouched. Sidecars carry
 * provenance we must not lose (trigger, dataset, duplicate_of…), so this is a
 * merge, never a rewrite.
 */
export function withFalWeightsUrl<T extends LoraSidecar>(meta: T, url: string): T {
  return { ...meta, fal_weights_url: url }
}

/**
 * In-flight migrations, keyed by sidecar path. Two generations fired at the
 * same LoRA before it has been migrated must share one 330 MB download rather
 * than racing each other (and racing on the sidecar write).
 */
const inFlight = new Map<string, Promise<string>>()

export async function ensureFalLoraWeights(sidecarPath: string, meta: LoraSidecar): Promise<string> {
  const cached = typeof meta?.fal_weights_url === 'string' ? meta.fal_weights_url.trim() : ''
  if (cached) return cached

  const running = inFlight.get(sidecarPath)
  if (running) return running

  const job = migrate(sidecarPath, meta).finally(() => { inFlight.delete(sidecarPath) })
  inFlight.set(sidecarPath, job)
  return job
}

async function migrate(sidecarPath: string, meta: LoraSidecar): Promise<string> {
  const tarUrl = String(meta?.replicate_url ?? '').trim()
  if (!/^https?:\/\//.test(tarUrl)) {
    throw new Error('This LoRA has no trained weights to run (no replicate_url on its sidecar).')
  }

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tarPath = path.join(os.tmpdir(), `lora-weights_${stamp}.tar`)
  const outPath = path.join(os.tmpdir(), `lora-weights_${stamp}.safetensors`)

  try {
    // 1. Stream the tar to disk — buffering 330 MB would be pointless here.
    const res = await fetch(tarUrl)
    if (!res.ok || !res.body) throw new Error(`Could not download the trained weights (${res.status})`)
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tarPath))

    // 2. Lift the safetensors out with the venv's Python (repo root is one
    //    level up from the Nitro cwd, as in voice-clone/from-youtube).
    const root = path.resolve(process.cwd(), '..')
    const python = path.join(root, '.venv', 'bin', 'python')
    const script = path.join(root, 'scripts', 'lora_extract_safetensors.py')
    await new Promise<string>((resolve, reject) => {
      execFile(python, [script, tarPath, outPath], { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, out, stderr) => {
        if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
        resolve(out || '')
      })
    })

    // 3. Upload the weights to fal storage (a public CDN URL flux-lora can read).
    const bytes = await fs.readFile(outPath)
    const fileName = `${String(meta?.name ?? 'lora').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'lora'}.safetensors`
    const url = await uploadToFalStorage(bytes, fileName, 'application/octet-stream')

    // 4. Record it, read-modify-write so a sidecar edited meanwhile keeps its
    //    other fields (we re-read rather than trusting the caller's snapshot).
    let onDisk: LoraSidecar = meta
    try { onDisk = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) as LoraSidecar } catch { /* keep the snapshot */ }
    await fs.writeFile(sidecarPath, JSON.stringify(withFalWeightsUrl(onDisk, url), null, 2), 'utf8')

    return url
  } finally {
    await Promise.all([tarPath, outPath].map(p => fs.rm(p, { force: true }).catch(() => {})))
  }
}
