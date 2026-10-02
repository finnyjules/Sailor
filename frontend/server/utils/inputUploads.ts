/**
 * Who uploaded which engine input file (Stage 5 round 3, R1/R2).
 *
 * The engine's input directory is shared across tenants until per-tenant dirs
 * land in Stage 6, and ComfyUI's /upload honours an `overwrite` field that
 * makes the write unconditional. Round 2 refused the field outright; that broke
 * eight app flows which legitimately overwrite their OWN freshly-minted files.
 * This table is what makes "your own file" answerable: one row per stored
 * upload, first writer wins, checked before an overwrite is forwarded.
 *
 * Uses its OWN pg session (connectLedgerDb) like graphRuns.ts — never the
 * ledger's shared session, so no withLock coupling.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { connectLedgerDb, type LedgerDbHandle } from './ledgerDb'
import { isHosted } from './deployMode'

type DbLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

let dbOverride: DbLike | null = null
let shared: LedgerDbHandle | null = null

export function __setInputUploadsDbForTests(db: DbLike | null): void { dbOverride = db }

function db(): DbLike {
  if (dbOverride) return dbOverride
  if (!shared) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('inputUploads: DATABASE_URL not set — hosted mode requires it')
    shared = connectLedgerDb(url)
  }
  return shared
}

/**
 * First writer keeps the name. A second recordUpload for the same key is the
 * owner re-saving their own file (allowed, and already theirs) or a legitimate
 * engine-side collision — neither should transfer ownership.
 */
export async function recordUpload(userId: string, fileKey: string): Promise<void> {
  await db().query(
    `INSERT INTO input_uploads (file_key, user_id) VALUES ($1, $2)
     ON CONFLICT (file_key) DO NOTHING`,
    [fileKey, userId])
}

export async function uploadOwner(fileKey: string): Promise<string | null> {
  const { rows } = await db().query(
    `SELECT user_id FROM input_uploads WHERE file_key = $1`, [fileKey])
  return rows.length ? String(rows[0].user_id) : null
}

/**
 * Stage 6 Task 2b/6 — the caller's OWN top-level input filenames, for
 * filtering `/sailor/input_listing`, gating `/sailor/input_thumbnail`, and
 * (Task 6) refilling the engine's /object_info file pickers.
 *
 * `input_listing` (and LoadImage's combo) walk only the TOP level of
 * `input/` (a flat `os.listdir`), so the keys that matter are the
 * empty-subfolder `input` uploads — canonicalUploadKey('input', '', name)
 * === `input::<name>`. A row with a non-empty subfolder (`input:sub:name`)
 * names a nested file the flat listing never shows, so it is excluded.
 * `LIKE 'input::%'` pushes that filter into the query; the JS re-check below
 * stays as the enforced behavior (a fake/legacy db that ignores the WHERE
 * clause must not leak a subfoldered key), so the two are redundant on
 * purpose rather than either alone being trusted.
 */
export async function ownedInputFilenames(userId: string): Promise<Set<string>> {
  const { rows } = await db().query(
    `SELECT file_key FROM input_uploads WHERE user_id = $1 AND file_key LIKE 'input::%'`, [userId])
  const names = new Set<string>()
  const prefix = 'input::'
  for (const r of rows) {
    const k = String(r.file_key)
    if (k.startsWith(prefix)) names.add(k.slice(prefix.length))
  }
  return names
}

/**
 * Drop an input file's ownership row after the engine deletes the file, so the
 * name frees up for the next writer. Without this the deleted name stays
 * claimed by its old owner: a different tenant who later uploads the same name
 * (the engine keeps it, the file is gone) can never own — nor see — their own
 * upload, because the stale row wins the ON CONFLICT.
 */
export async function releaseUpload(fileKey: string): Promise<void> {
  await db().query(`DELETE FROM input_uploads WHERE file_key = $1`, [fileKey])
}

/**
 * The `type` folder name a request resolves to, mirroring server.py's
 * get_dir_by_type(): unknown and absent both mean `input`.
 */
function engineTypeName(type: string | null | undefined): 'output' | 'temp' | 'input' {
  return type === 'output' || type === 'temp' ? type : 'input'
}

/**
 * The one ownership key both the pre-write CHECK and the post-write RECORD
 * must build identically (S1). Before this, the check built its key from the
 * RAW form `type`/`subfolder` while the record used the engine's response
 * values and `engineDirForType` normalized independently of both — so
 * `type=bogus` (folds to `input` on disk) produced a check-key like
 * `bogus::v.png` that no ownership row could ever match, even for a file a
 * canonical-key upload had already claimed. `subfolder=.` is the same
 * problem one level down: `path.resolve` treats it as a no-op, so `.` and
 * `''` name the identical directory on disk but were two different DB keys.
 * Both normalizations mirror `engineDirForType`/`path.resolve` exactly so
 * the key always names the same file the disk check and the engine agree on.
 */
export function canonicalUploadKey(type: string | null | undefined, subfolder: string | null | undefined, filename: string): string {
  const t = engineTypeName(type)
  const s = subfolder === '.' || !subfolder ? '' : subfolder
  return `${t}:${s}:${filename}`
}

/**
 * The ComfyUI checkout marker: `main.py` alongside `input/` — the directory
 * this module's disk check actually depends on.
 */
function isEngineRoot(dir: string): boolean {
  return existsSync(path.join(dir, 'main.py')) && existsSync(path.join(dir, 'input'))
}

/**
 * Pure resolver (S2): `envOverride` wins when it checks out (validated, not
 * trusted blind — a broken override should fail closed, not silently defer
 * to the walk), else walk up from `cwd` for the marker. Returns null rather
 * than a best-effort guess when nothing is found — the old
 * `path.resolve(process.cwd(), '..', name)` guessed unconditionally, so a
 * Nitro process launched from anywhere but `frontend/` silently pointed at a
 * directory that doesn't exist and `existsSync` missed EVERY disk check,
 * treating every unclaimed name as free.
 */
export function computeEngineRoot(cwd: string, envOverride: string | null | undefined): string | null {
  if (envOverride) return isEngineRoot(envOverride) ? envOverride : null
  let dir = cwd
  for (let i = 0; i < 12; i++) {
    if (isEngineRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

let engineRootOverride: string | null | undefined // undefined = no override, use real resolution

/** Test-only override — bypasses the real cwd/env walk entirely. */
export function __setInputUploadsEngineRootForTests(root: string | null | undefined): void {
  engineRootOverride = root
}

/** Production wiring: `SAILOR_ENGINE_ROOT` env override, else the cwd walk. */
export function resolveEngineRoot(): string | null {
  if (engineRootOverride !== undefined) return engineRootOverride
  return computeEngineRoot(process.cwd(), process.env.SAILOR_ENGINE_ROOT)
}

/**
 * The engine directory a `type` resolves to. Null when the engine root can't
 * be resolved — callers must treat that as "unknown", not "doesn't exist"
 * (see `uploadExistsOnDisk`).
 */
export function engineDirForType(type: string): string | null {
  const root = resolveEngineRoot()
  if (!root) return null
  return path.join(root, engineTypeName(type))
}

export interface EngineRootBootDeps {
  isHosted(): boolean
  resolveRoot(): string | null
  logError(msg: string): void
}

/**
 * Boot-time loud-failure assert (S2): a misconfigured hosted deploy should
 * announce itself at startup, not surface only as opaque 403s on the first
 * upload someone tries to overwrite. Pure + DI'd (the holdSweep.ts style) so
 * it's unit-testable without a real filesystem walk.
 */
export function checkEngineRootOnBootWith(deps: EngineRootBootDeps): boolean {
  if (!deps.isHosted()) return true
  if (deps.resolveRoot()) return true
  deps.logError(
    '[inputUploads] hosted mode is active but the shared ComfyUI engine root could not be '
    + 'resolved (checked SAILOR_ENGINE_ROOT, then walked up from cwd for main.py + input/). '
    + 'Upload overwrite checks will fail CLOSED (refuse every ambiguous overwrite) until this '
    + 'is fixed — set SAILOR_ENGINE_ROOT or fix the launch cwd.',
  )
  return false
}

/** Production wiring for the Nitro boot plugin. */
export function checkEngineRootOnBoot(): boolean {
  return checkEngineRootOnBootWith({ isHosted, resolveRoot: resolveEngineRoot, logError: (m) => console.error(m) })
}

/**
 * Refuse anything that could make the path we CHECK differ from the path the
 * engine WRITES.
 *
 * `..` and absolute paths are the traversal cases. Backslash is here because
 * aiohttp un-escapes `\` inside a quoted Content-Disposition parameter and
 * undici does not: `filename="fil\e.png"` is `fil\e.png` to us and `file.png`
 * to the engine, so an ownership check on the first name would wave through a
 * write to the second. No Sailor flow produces either character.
 */
export function unsafeUploadTarget(subfolder: string, filename: string): boolean {
  for (const s of [subfolder, filename]) {
    if (s.includes('\\')) return true
    if (s.split('/').some(seg => seg === '..')) return true
    if (s.startsWith('/')) return true
    if (/^[a-zA-Z]:/.test(s)) return true
  }
  if (!filename) return true
  return false
}

/**
 * Does the engine already hold this file? An unclaimed name that exists on disk
 * belongs to somebody — every upload that predates this table has no row.
 * Containment is re-checked after resolution so a path that slips past
 * unsafeUploadTarget still cannot address anything outside the type's dir.
 *
 * Returns null (S2) rather than false when the engine root can't be
 * resolved — "the answer is unknown" and "the file doesn't exist" are
 * different facts, and the caller (`decideOverwrite`) must fail CLOSED on
 * the former instead of treating an unresolvable root as "nothing's there".
 */
export function uploadExistsOnDisk(type: string, subfolder: string, filename: string): boolean | null {
  const dir = engineDirForType(type)
  if (!dir) return null
  const full = path.resolve(dir, subfolder, filename)
  if (full !== dir && !full.startsWith(dir + path.sep)) return true
  return existsSync(full)
}
