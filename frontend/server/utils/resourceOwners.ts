/**
 * Central ownership registry for user-created resources (Stage 6). One
 * central table covers every store uniformly, including ones written
 * engine-side where Nitro can't add JSON fields. A resource with NO row
 * here is curated/global content: readable by all, mutable by none —
 * first-touch auto-claiming is forbidden (hostedCanMutate(null, u) is
 * always false). Uses its OWN pg session (connectLedgerDb) — never the
 * ledger's shared session, so no withLock coupling.
 */
import { connectLedgerDb, type LedgerDbHandle } from './ledgerDb'

type DbLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export const RESOURCE_KINDS = [
  'project', 'brand-kit', 'moodboard', 'template', 'template-font',
  'frame-template',
  'character', 'lora', 'voice', 'timeline-asset', 'cloud-training',
] as const

export type ResourceKind = typeof RESOURCE_KINDS[number]

let dbOverride: DbLike | null = null
let shared: LedgerDbHandle | null = null

export function __setResourceOwnersDbForTests(db: DbLike | null): void { dbOverride = db }

function db(): DbLike {
  if (dbOverride) return dbOverride
  if (!shared) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('resourceOwners: DATABASE_URL not set — hosted mode requires it')
    shared = connectLedgerDb(url)
  }
  return shared
}

/** First-owner-wins: a second write for the same (kind, resourceId) is silently ignored. */
export async function recordOwner(kind: string, resourceId: string, userId: string): Promise<void> {
  await db().query(
    `INSERT INTO resource_owners (kind, resource_id, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, resource_id) DO NOTHING`,
    [kind, resourceId, userId])
}

export async function ownerOf(kind: string, resourceId: string): Promise<string | null> {
  const { rows } = await db().query(
    `SELECT user_id FROM resource_owners WHERE kind = $1 AND resource_id = $2`,
    [kind, resourceId])
  return rows.length > 0 ? String(rows[0].user_id) : null
}

export async function ownedIds(kind: string, userId: string): Promise<Set<string>> {
  const { rows } = await db().query(
    `SELECT resource_id FROM resource_owners WHERE kind = $1 AND user_id = $2`,
    [kind, userId])
  return new Set(rows.map(r => String(r.resource_id)))
}

/** Used on delete — drops the ownership row so the id can never resurface as an orphaned claim. */
export async function releaseOwner(kind: string, resourceId: string): Promise<void> {
  await db().query(
    `DELETE FROM resource_owners WHERE kind = $1 AND resource_id = $2`,
    [kind, resourceId])
}

/** true when the resource is curated/global (no owner row) or owned by the caller. */
export function hostedCanRead(owner: string | null, userId: string): boolean {
  return owner === null || owner === userId
}

/**
 * true ONLY when the caller owns the resource. Unowned (owner === null) is
 * read-only — that's how operator-seeded curated content stays immutable by
 * everyone; first-touch auto-claiming is forbidden by the plan.
 */
export function hostedCanMutate(owner: string | null, userId: string): boolean {
  return owner === userId
}
