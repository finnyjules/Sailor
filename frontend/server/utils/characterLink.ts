/**
 * Shared server-side helper: link a just-succeeded character-kind LoRA
 * training to the character registry (models/characters/<slug>.json).
 *
 * Extracted so both finalize paths — the legacy /api/cloud-train/status
 * poll endpoint and the training-queue's pollLora() in trainingProviders.ts
 * — apply the same collision policy: auto-link may claim drafts, never
 * repoint a ready character.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseCharacterRecord, slugifyCharacterName, type CharacterRecord } from '~~/server/utils/characterRegistry'
import { emptyState } from '#shared/characters/types'
import { deployMode } from '~~/server/utils/deployMode'
import { ownerOf, recordOwner } from '~~/server/utils/resourceOwners'

/**
 * C1 — claim the character registry record for the training's owner (hosted
 * only, keyed by slug the same way characters-local.get's listOwned is). An
 * unknown owner (null userId, e.g. an unbound legacy job) records NOTHING
 * rather than guessing — leaving the record curated is the fail-closed default,
 * the same discipline the voice/LoRA finalize paths use. Best-effort: a
 * recordOwner hiccup must not fail the finalize (the record is already on disk).
 */
async function claimCharacter(slug: string, ownerUserId: string | null | undefined): Promise<void> {
  if (deployMode() !== 'hosted' || !ownerUserId) return
  try { await recordOwner('character', slug, ownerUserId) }
  catch (err) { console.warn('[characterLink] ownership record failed', { slug, error: err }) }
}

export interface LinkDecisionInput {
  loraName: string | null
}

/**
 * Pure decision logic: given an existing registry record's loraName and a
 * new weights filename, determine the linking action.
 *
 * Policy (auto-link may claim drafts, never repoint a ready character):
 * - 'claim-draft': matched record with loraName === null → flip to ready
 * - 'update-same': matched record already ready with same loraName → idempotent update
 * - 'collide-new': matched record already ready with different loraName → create new with de-collided slug
 * - 'create': no existing record → create fresh record
 */
export function linkDecision(existing: LinkDecisionInput | null, weightsFilename: string): 'create' | 'claim-draft' | 'update-same' | 'collide-new' {
  if (!existing) return 'create'
  if (existing.loraName === null) return 'claim-draft'
  if (existing.loraName === weightsFilename) return 'update-same'
  return 'collide-new'
}

/**
 * Pure match: does an existing registry record correspond to a just-trained
 * character LoRA? Matched by slugified display name — the same key the
 * absorb bridge uses — so a hand-created draft (e.g. from "Train identity")
 * flips to ready on the record the user was already looking at, instead of
 * spawning a duplicate.
 */
function matchesTrainedCharacter(record: CharacterRecord, displayNameSlug: string): boolean {
  return record.slug === displayNameSlug
}

/**
 * Find the first available de-collided slug by appending -2, -3, etc.
 * (assumes caller has already tried the base slug).
 */
async function findAvailableSlug(baseSlug: string, dir: string, maxAttempts: number = 100): Promise<string> {
  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = `${baseSlug}-${i}`
    try {
      await fs.access(path.join(dir, `${candidate}.json`))
    } catch {
      // File does not exist — this slug is available
      return candidate
    }
  }
  // Fallback to timestamp-based if we somehow hit maxAttempts (very unlikely)
  return `${baseSlug}-${Date.now()}`
}

/**
 * Link a just-succeeded character-kind LoRA training to the registry:
 * - Claim a matching draft (loraName === null) → flip to ready
 * - Idempotently update a ready record with the same loraName
 * - On a collision (ready record with different loraName), create a new
 *   record with a de-collided slug (-2, -3, etc.) and console.warn the user
 * - Create a fresh record if no slug match exists
 *
 * Best-effort — callers should catch and log rather than let a failure here
 * fail the finalize path, since the weights are already safely on disk by
 * the time this runs.
 */
export async function linkTrainedCharacter(opts: { displayName: string, weightsFilename: string, trigger: string | null, ownerUserId?: string | null }): Promise<void> {
  const { displayName, weightsFilename, trigger, ownerUserId } = opts
  const slug = slugifyCharacterName(displayName)
  if (!slug) return
  const dir = path.resolve(process.cwd(), '..', 'models', 'characters')
  await fs.mkdir(dir, { recursive: true })

  let files: string[] = []
  try { files = await fs.readdir(dir) } catch { /* none yet */ }

  let match: CharacterRecord | null = null
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const s = f.slice(0, -5)
    let parsed: CharacterRecord | null = null
    try { parsed = parseCharacterRecord(await fs.readFile(path.join(dir, f), 'utf8'), s) } catch { continue }
    if (parsed && matchesTrainedCharacter(parsed, slug)) { match = parsed; break }
  }

  const now = new Date().toISOString()
  let decision = linkDecision(match, weightsFilename)

  // Cross-tenant hijack guard (hosted only). A claim-draft/update-same would
  // OVERWRITE the matched <slug>.json on disk — the record characters-local.get
  // renders and the LoRA dispatch reads. If that record is owned by a DIFFERENT
  // user, overwriting it silently repoints victim V's character at caller A's
  // LoRA (A's model ref) under V's wallet, even though the resource_owners row
  // (first-owner-wins) still shows V. So: when the matched record is owned by
  // someone other than the caller, DO NOT touch it — downgrade to collide-new,
  // which de-collides the slug and creates a fresh record the caller owns.
  // Un-owned (curated/legacy, owner null) and own-record cases proceed as today.
  // LOCAL mode has no ownership (single-user) → skip the check entirely so
  // behavior stays byte-identical, mirroring claimCharacter's deployMode gate.
  if (match && (decision === 'claim-draft' || decision === 'update-same') && deployMode() === 'hosted') {
    const owner = await ownerOf('character', match.slug)
    if (owner !== null && owner !== ownerUserId) {
      decision = 'collide-new'
    }
  }

  if (decision === 'claim-draft' || decision === 'update-same') {
    // Auto-link may claim drafts, never repoint a ready character
    match!.loraName = weightsFilename
    match!.trigger = trigger
    match!.updatedAt = now
    await fs.writeFile(path.join(dir, `${match!.slug}.json`), JSON.stringify(match, null, 2))
    await claimCharacter(match!.slug, ownerUserId)
    return
  }

  if (decision === 'collide-new') {
    // Ready character with a different loraName: create a new record with de-collided slug
    console.warn(`[characterLink] Slug collision: "${slug}" already ready with loraName="${match!.loraName}", creating new record with de-collided slug`)
    const newSlug = await findAvailableSlug(slug, dir)
    const record: CharacterRecord = {
      name: displayName,
      slug: newSlug,
      face: null, photos: [], voice: null, origin: 'photos', likenessConfirmed: false, style: 'photo', linkedFrom: null,
      states: [emptyState('default', 'Default')],
      loraName: weightsFilename,
      trigger,
      bodyShape: null,
      notes: '',
      createdAt: now,
      updatedAt: now,
    }
    await fs.writeFile(path.join(dir, `${newSlug}.json`), JSON.stringify(record, null, 2))
    await claimCharacter(newSlug, ownerUserId)
    return
  }

  // decision === 'create': no existing record
  const record: CharacterRecord = {
    name: displayName,
    slug,
    face: null, photos: [], voice: null, origin: 'photos', likenessConfirmed: false, style: 'photo', linkedFrom: null,
    states: [emptyState('default', 'Default')],
    loraName: weightsFilename,
    trigger,
    bodyShape: null,
    notes: '',
    createdAt: now,
    updatedAt: now,
  }
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(record, null, 2))
  await claimCharacter(slug, ownerUserId)
}
