/**
 * Pure helpers for the LoRA .json sidecars in the LoRA library (library/loras) — the provenance
 * files GET /api/loras-local lists and PATCH/POST/DELETE mutate. Kept free of fs
 * so the filename guard and the duplication rules are unit-testable.
 */
import { sidecarAesthetic } from './loraPrompt'

/**
 * A LoRA filename is only ever a bare `<base>.safetensors` in the loras dir.
 * This is the sole guard between the /api/loras-local handlers and path
 * traversal, so every handler routes through it rather than re-deriving it.
 */
export function isSafeLoraFilename(filename: string): boolean {
  const f = filename || ''
  return f.endsWith('.safetensors')
    && f.length > '.safetensors'.length
    && !f.includes('/')
    && !f.includes('\\')
    && !f.includes('..')
}

/**
 * Turn a display name into a filesystem base, matching the cloud trainer's own
 * convention (`[^a-zA-Z0-9_-]+` → `_`) so duplicates sit alongside trained LoRAs
 * looking like siblings rather than a second naming scheme. Returns '' when
 * nothing usable survives — callers reject that rather than writing `_.json`.
 */
export function loraBaseName(name: string): string {
  return (name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Build the sidecar for a duplicate: same trained weights, new identity.
 *
 * A duplicate exists so one training run can carry several taste profiles, so it
 * carries `replicate_model`/`replicate_url` (what actually runs — no weights file
 * is copied), `trigger` (baked into the weights at training time; a different one
 * wouldn't activate) and `trained_on` (GET /api/dataset-match resolves the
 * training folder from this field alone, so the copy matches the SAME dataset and
 * the Fable "rewrite from training images" flow works on it).
 *
 * `replicate_prediction_id` is dropped — it names the original training run.
 * The cover isn't copied either; a duplicate starts with a blank card so it never
 * shows an image its new profile didn't produce.
 */
export function buildDuplicateSidecar(
  source: Record<string, any>,
  newName: string,
): Record<string, any> {
  const { replicate_prediction_id: _dropped, ...rest } = source ?? {}
  const dup: Record<string, any> = { ...rest, name: newName }

  // Normalize onto `aesthetic` (the canonical editable key PATCH writes) so a
  // legacy `taste_profile` sidecar doesn't produce a copy that reads one key and
  // is edited through another.
  const aesthetic = sidecarAesthetic(source)
  delete dup.taste_profile
  if (aesthetic) dup.aesthetic = aesthetic
  else delete dup.aesthetic

  if (source?.name) dup.duplicate_of = source.name
  return dup
}
