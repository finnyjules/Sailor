/**
 * Sailor's durable projects and spend ledger, served natively — a port of
 * comfy_extras/nodes_sailor_projects.py (the pure storage layer and its nine
 * aiohttp routes), reading and writing the SAME files in the SAME format:
 *
 *   user/sailor/projects/<uuid>/project.json
 *   user/sailor/projects/<uuid>/versions/<vid>.json
 *   user/sailor/projects/<uuid>/generations.jsonl
 *   user/sailor/spend.jsonl
 *
 * JSON is written with `pyDumps`, so a file this module writes is byte-for-byte
 * what the Python wrote, and either side can read the other's files. Python's
 * truthiness (`x or y`, `if not data`) is kept deliberately via `truthy`/`or`:
 * an empty list or object is falsy there and not in JS, and the Python's
 * behaviour is the contract.
 *
 * Storage functions take an explicit `root` (or ledger path) like the Python,
 * so tests point them at temp folders. The route handlers at the bottom take a
 * context with the user folder and the clock, and return `{ status, body }`.
 *
 * Known divergences from the Python (all edge cases, none fixed here):
 *
 * - A request body with integer-like string keys (e.g. `"2"`, `"10"`) comes
 *   out of `JSON.parse` with those keys reordered first, ascending
 *   numerically, ahead of every non-numeric key, regardless of the order
 *   they appeared in the request — a JS object property-ordering rule with
 *   no Python dict equivalent (dicts always keep insertion order). A record
 *   built from such a body and written back out with `pyDumps` carries that
 *   reordering into the file.
 * - `readJson` treats ANY unparsable file as absent (`null`), including one
 *   holding Python's `NaN` / `Infinity` / `-Infinity` tokens — valid input to
 *   Python's `json.loads` (its non-standard default), invalid to
 *   `JSON.parse`. A file that legitimately holds one of these (e.g. a spend
 *   line whose `usd` was NaN) reads back as gone, not as that value.
 * - Every JSON file is read as `'utf8'`, which replaces invalid byte
 *   sequences with U+FFFD rather than raising — Python's default `open(...,
 *   encoding='utf-8')` is strict and raises `UnicodeDecodeError`, which the
 *   aiohttp route left uncaught (500). A file with invalid UTF-8 is read
 *   here instead of failing the request.
 * - `appendSpend`'s `usd <= 0` check coerces a string `usd` (e.g. `"5"`) to a
 *   number for the comparison, so a spend entry with a string amount is
 *   logged. Python's `usd <= 0` on a string raises `TypeError` (str vs int),
 *   which aiohttp turned into a 500 — refusing the write rather than
 *   accepting a stringly-typed amount.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isSafeId, resolveInside } from './paths'
import { pyDumps } from './pyJson'

type Json = any

// ---------------------------------------------------------------- Python-isms

/** Python truthiness: None, False, 0, "", [] and {} are all falsy. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (typeof v === 'number' && Number.isNaN(v)) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** Python's `a or b`. */
function or<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b
}

/** Python's `d.get(key)` — null when the key is absent. */
function get(d: Json, key: string): Json {
  return d != null && typeof d === 'object' && key in d ? d[key] : null
}

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A number for arithmetic, as Python sees it (bool is an int); anything else is a TypeError. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  throw new TypeError(`unsupported operand type: ${typeof v}`)
}

/** Python's `float(x)` for the values a ledger line can hold. */
function pyFloat(v: unknown): number {
  if (typeof v === 'number' || typeof v === 'boolean') return num(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s)
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity
    if (/^[+-]?nan$/i.test(s)) return Number.NaN
    throw new TypeError(`could not convert string to float: '${v}'`)
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${typeof v}'`)
}

/** Ordering for sort keys the way Python compares them (numbers, or strings). */
function compareKeys(a: unknown, b: unknown): number {
  const numeric = (x: unknown) => typeof x === 'number' || typeof x === 'boolean'
  if (numeric(a) && numeric(b)) return num(a) - num(b)
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  throw new TypeError('\'<\' not supported between these types')
}

/** Python `==` on JSON values. */
function pyEquals(a: unknown, b: unknown): boolean {
  const numeric = (x: unknown) => typeof x === 'number' || typeof x === 'boolean'
  if (numeric(a) && numeric(b)) return num(a) === num(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => pyEquals(v, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => k in b && pyEquals(a[k], b[k]))
  }
  return a === b
}

/** Python's `sorted(items, key=key, reverse=True)` — stable, equal keys keep their order. */
function sortDesc<T>(items: T[], key: (t: T) => unknown): T[] {
  return [...items].sort((x, y) => compareKeys(key(y), key(x)))
}

function isFsError(e: unknown): boolean {
  return typeof (e as { code?: unknown })?.code === 'string'
}

// ---------------------------------------------------------------- errors

/** Python's ValueError from the storage layer. */
export class InvalidIdError extends Error {}

/** Python's KeyError from `write_version`; `str()` of a KeyError is its repr. */
export class ProjectNotFoundError extends Error {
  get pyStr(): string {
    const m = this.message
    return m.includes('\'') && !m.includes('"') ? `"${m}"` : `'${m.replace(/'/g, '\\\'')}'`
  }
}

/**
 * Invariant: a rolling-current write must carry a doc savedAt >= the stored
 * one — a stale window may not clobber a fresher save. Missing stamps on
 * either side pass (legacy docs must keep saving).
 */
export class StaleRollingWriteError extends Error {
  constructor(readonly storedSavedAt: number) {
    super(`stale rolling write: stored savedAt ${storedSavedAt} is newer`)
  }
}

// ---------------------------------------------------------------- layout

export function projectsRoot(userDirectory: string): string {
  return path.join(userDirectory, 'sailor', 'projects')
}

function projectDir(root: string, uuid: string): string {
  const dir = resolveInside(root, uuid)
  if (!dir) throw new InvalidIdError('invalid project uuid')
  return dir
}

function projectFile(root: string, uuid: string): string {
  return path.join(projectDir(root, uuid), 'project.json')
}

function versionFile(root: string, uuid: string, vid: string): string {
  const file = resolveInside(projectDir(root, uuid), 'versions', `${vid}.json`)
  if (!file) throw new InvalidIdError('invalid version id')
  return file
}

function generationsFile(root: string, uuid: string): string {
  return path.join(projectDir(root, uuid), 'generations.jsonl')
}

function readJson(file: string): Json {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

/**
 * Write JSON atomically (temp file + rename) so a crash mid-write can't leave
 * a half-written project.json. The temp file is created 0600 like Python's
 * `tempfile.mkstemp`, and the rename keeps that mode.
 */
function atomicWriteJson(file: string, data: Json): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `tmp${randomUUID().replace(/-/g, '').slice(0, 8)}.tmp`)
  try {
    fs.writeFileSync(tmp, pyDumps(data, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  }
  finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp) }
      catch {}
    }
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() }
  catch { return false }
}

function newHexId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------- boot migrations

// Ports of the two boot-time data migrations in nodes_sailor_projects.py's
// `try: import folder_paths ...` block, both called unconditionally at
// Python module import time. There is no module-import hook here (this is a
// library, not a running server), so each is instead run lazily, the first
// time a native projects/spend route needs `base` (the equivalent of
// Python's `folder_paths.get_user_directory()`), guarded so a given `base`
// only runs once per process. Both are pure file work, both are idempotent
// on disk regardless of this in-memory guard (each checks the filesystem
// before doing anything), and both swallow every error — a broken migration
// must never fail a request, exactly like the Python's own `except Exception:
// pass`.
const migratedBases = new Set<string>()

/** Test-only: forget which `base` dirs already ran, so a fresh temp root re-triggers them. */
export function __resetBootMigrationsForTests(): void {
  migratedBases.clear()
}

/** Run both boot migrations for `base` if they have not already run this process. */
export function ensureBootMigrationsRan(base: string): void {
  if (migratedBases.has(base)) return
  migratedBases.add(base)
  migrateLegacyUserDir(base)
  migrateLegacyProjectKeys(base)
}

/**
 * Port of `_migrate_legacy_user_dir`: one-time rename of the pre-rebrand user
 * data dir (Sailor was formerly "ComfyNext"), `<base>/comfynext` ->
 * `<base>/sailor`, so existing projects, assets, spend and timeline data on
 * an environment that still holds the legacy dir (e.g. the Fly volume)
 * survive the rename. No-ops once `sailor` exists; never overwrites it.
 */
function migrateLegacyUserDir(base: string): void {
  try {
    const legacy = path.join(base, 'comfynext')
    const current = path.join(base, 'sailor')
    if (isDir(legacy) && !fs.existsSync(current)) fs.renameSync(legacy, current)
  }
  catch {
    // never let a data migration block a request
  }
}

/**
 * Port of `_migrate_legacy_project_keys`: one-time rebrand migration for
 * saved project JSON. Pre-rename projects store node properties under
 * `comfynext_*` keys and annotations under `workflow.extra.comfynext`; the
 * renamed frontend reads `sailor_*` / `extra.sailor`, so that config is
 * invisible until the KEYS are renamed. KEYS ONLY — values are preserved
 * verbatim, since they legitimately reference on-disk files that keep legacy
 * names (e.g. `input/comfynext_frame_*.png`). Guarded by a marker file so the
 * walk runs once per volume (on top of the in-memory once-per-process guard,
 * which only saves repeat filesystem walks within a process — the marker is
 * what makes this idempotent across restarts).
 */
function migrateLegacyProjectKeys(base: string): void {
  try {
    const root = projectsRoot(base)
    const marker = path.join(path.dirname(root), '.migrated-project-keys-v1')
    if (fs.existsSync(marker) || !isDir(root)) return

    const renameKey = (k: string): string => {
      if (k === 'comfynext') return 'sailor'
      if (k.startsWith('comfynext_')) return `sailor_${k.slice('comfynext_'.length)}`
      return k
    }
    const walk = (obj: Json): Json => {
      if (Array.isArray(obj)) return obj.map(walk)
      if (isObject(obj)) {
        const out: Record<string, Json> = {}
        for (const [k, v] of Object.entries(obj)) {
          const nk = renameKey(k)
          if (nk in out) continue // half-migrated: keep existing sailor_* value
          out[nk] = walk(v)
        }
        return out
      }
      return obj
    }

    for (const file of allJsonFiles(root)) {
      try {
        const raw = fs.readFileSync(file, 'utf8')
        if (!raw.includes('"comfynext')) continue // keys always appear quote-prefixed in JSON
        const migrated = walk(JSON.parse(raw))
        const tmp = `${file}.migtmp`
        fs.writeFileSync(tmp, pyDumps(migrated, undefined, { ensureAscii: false, separators: [',', ':'] }), 'utf8')
        fs.renameSync(tmp, file)
      }
      catch {
        // skip unreadable/unparsable file, migrate the rest
      }
    }
    fs.writeFileSync(marker, '1\n', 'utf8')
  }
  catch {
    // never let a data migration block a request
  }
}

function allJsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...allJsonFiles(full))
    else if (e.name.endsWith('.json')) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------- projects

export function readProject(root: string, uuid: unknown): Json {
  if (!isSafeId(uuid)) return null
  return readJson(projectFile(root, uuid))
}

export function writeProject(root: string, project: Json): Json {
  const uuid = project.uuid
  if (!isSafeId(uuid)) throw new InvalidIdError('invalid project uuid')
  atomicWriteJson(projectFile(root, uuid), project)
  return project
}

export interface ProjectMeta { uuid: Json, name: Json, cover: Json, updatedAt: Json }

/** Index view (metadata only) for the Home list — newest first. */
export function listProjects(root: string): ProjectMeta[] {
  const out: ProjectMeta[] = []
  if (!isDir(root)) return out
  for (const name of fs.readdirSync(root)) {
    const data = readJson(path.join(root, name, 'project.json'))
    if (!truthy(data)) continue
    if (!isObject(data)) throw new TypeError('project.json is not an object')
    out.push({
      uuid: 'uuid' in data ? data.uuid : name,
      name: get(data, 'name'),
      cover: get(data, 'cover'),
      updatedAt: get(data, 'updatedAt'),
    })
  }
  return sortDesc(out, d => or(d.updatedAt, 0))
}

export function deleteProject(root: string, uuid: unknown): boolean {
  if (!isSafeId(uuid)) return false
  const dir = projectDir(root, uuid)
  if (!isDir(dir)) return false
  try { fs.rmSync(dir, { recursive: true, force: true }) }
  catch {} // shutil.rmtree(ignore_errors=True)
  return true
}

/** Return the project, creating an empty one on first use. */
export function ensureProject(root: string, uuid: unknown, opts: { name?: string, now?: number } = {}): Json {
  const existing = readProject(root, uuid)
  if (truthy(existing)) return existing
  if (!isSafeId(uuid)) throw new InvalidIdError('invalid project uuid')
  const now = opts.now ?? 0
  return writeProject(root, {
    uuid,
    name: opts.name ?? 'Untitled project',
    cover: null,
    createdAt: now,
    updatedAt: now,
    currentVersionId: null,
    versionIndex: [],
  })
}

// ---------------------------------------------------------------- versions

// The rolling autosave overwrites versions/current.json in place. Before each
// overwrite the outgoing body is archived as an immutable `b_<createdAt>`
// backup, at least BACKUP_MIN_INTERVAL_MS apart (state time, not wall time),
// pruned to the newest BACKUP_KEEP. Backups live in the normal versionIndex
// (parentId "current"), so the version menu restores them unchanged.
export const ROLLING_VERSION_ID = 'current'
export const BACKUP_PREFIX = 'b_'
export const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000
export const BACKUP_KEEP = 20

/** The client recency stamp at version.workflow.savedAt, or null. bool is not a stamp. */
function docSavedAt(version: Json): number | null {
  const workflow = isObject(version) ? version.workflow : null
  if (!isObject(workflow)) return null
  const savedAt = workflow.savedAt
  if (typeof savedAt !== 'number') return null
  return Math.trunc(savedAt)
}

/** f"{BACKUP_PREFIX}{old_ts}" — numbers print as Python prints them. */
function backupId(ts: unknown): string {
  return `${BACKUP_PREFIX}${typeof ts === 'number' ? pyDumps(ts) : String(ts)}`
}

/**
 * Archive the current rolling body into the project's index (mutated in
 * place; the caller persists). Best effort: a filesystem failure skips the
 * backup, never the save itself.
 */
function archiveRollingVersion(root: string, uuid: string, project: Json, now: number): void {
  try {
    const old = readJson(versionFile(root, uuid, ROLLING_VERSION_ID))
    if (!isObject(old)) return
    const oldTs = or(old.createdAt, now)
    let index: Json[] = [...('versionIndex' in project ? project.versionIndex : [])]
    const backupTs = index
      .filter(m => String(get(m, 'id') ?? 'None').startsWith(BACKUP_PREFIX))
      .map(m => or(get(m, 'createdAt'), 0))
    if (backupTs.length) {
      const newest = backupTs.reduce((a, b) => (compareKeys(b, a) > 0 ? b : a))
      if (num(oldTs) - num(newest) <= BACKUP_MIN_INTERVAL_MS) return
    }
    const bid = backupId(oldTs)
    if (!isSafeId(bid)) return
    const body = { ...old, id: bid, name: 'Auto backup' }
    atomicWriteJson(versionFile(root, uuid, bid), body)
    index = index.filter(m => get(m, 'id') !== bid)
    index.push({ id: bid, name: 'Auto backup', createdAt: oldTs, parentId: ROLLING_VERSION_ID })
    const backups = sortDesc(
      index.filter(m => String(get(m, 'id') ?? 'None').startsWith(BACKUP_PREFIX)),
      m => or(get(m, 'createdAt'), 0),
    )
    for (const meta of backups.slice(BACKUP_KEEP)) {
      index = index.filter(m => get(m, 'id') !== meta.id)
      try { fs.unlinkSync(versionFile(root, uuid, meta.id)) }
      catch (e) { if (!isFsError(e)) throw e }
    }
    project.versionIndex = index
  }
  catch (e) {
    if (!isFsError(e)) throw e
  }
}

/**
 * Persist a version body, append it to the project's index, and make it
 * current. Returns the updated project. Throws ProjectNotFoundError when the
 * project doesn't exist (callers ensureProject first).
 */
export function writeVersion(root: string, uuid: string, version: Json, opts: { now?: number } = {}): Json {
  const now = opts.now ?? 0
  const project = readProject(root, uuid)
  if (project === null) throw new ProjectNotFoundError(`project not found: ${uuid}`)
  const vid = get(version, 'id')
  if (!isSafeId(vid)) throw new InvalidIdError('invalid version id')
  if (vid === ROLLING_VERSION_ID) {
    const old = readJson(versionFile(root, uuid, ROLLING_VERSION_ID))
    const oldSavedAt = isObject(old) ? docSavedAt(old) : null
    const newSavedAt = docSavedAt(version)
    if (oldSavedAt !== null && newSavedAt !== null && newSavedAt < oldSavedAt) {
      throw new StaleRollingWriteError(oldSavedAt)
    }
    archiveRollingVersion(root, uuid, project, now)
  }
  atomicWriteJson(versionFile(root, uuid, vid), version)
  const meta = {
    id: vid,
    name: get(version, 'name'),
    createdAt: get(version, 'createdAt'),
    parentId: get(version, 'parentId'),
  }
  const index = ('versionIndex' in project ? project.versionIndex : []).filter((m: Json) => get(m, 'id') !== vid)
  index.push(meta)
  project.versionIndex = index
  project.currentVersionId = vid
  project.updatedAt = or(or(now, get(version, 'createdAt')), get(project, 'updatedAt'))
  writeProject(root, project)
  return project
}

export function readVersion(root: string, uuid: unknown, vid: unknown): Json {
  if (!(isSafeId(uuid) && isSafeId(vid))) return null
  return readJson(versionFile(root, uuid, vid))
}

// ---------------------------------------------------------------- generations

/**
 * All recorded runs for a project, newest first. Corrupt or truncated lines
 * (a crash mid-append) are skipped, never fatal.
 */
export function listGenerations(root: string, uuid: unknown): Json[] {
  if (!isSafeId(uuid)) return []
  let text: string
  try { text = fs.readFileSync(generationsFile(root, uuid), 'utf8') }
  catch { return [] }
  const out: Json[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let rec: Json
    try { rec = JSON.parse(line) }
    catch { continue }
    if (isObject(rec)) out.push(rec)
  }
  return sortDesc(out, g => or(g.ts, 0))
}

/**
 * Append one run record (JSONL). Dedup by promptId so history backfill is
 * idempotent — null when that promptId is already recorded.
 */
export function appendGeneration(root: string, uuid: unknown, record: Json, opts: { now?: number } = {}): Json {
  if (!isSafeId(uuid)) throw new InvalidIdError('invalid project uuid')
  const pid = get(record, 'promptId')
  if (truthy(pid) && listGenerations(root, uuid).some(g => pyEquals(get(g, 'promptId'), pid))) return null
  const rec = { ...record }
  if (!('id' in rec)) rec.id = newHexId('g_')
  if (!('ts' in rec)) rec.ts = opts.now ?? 0
  const file = generationsFile(root, uuid)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${pyDumps(rec)}\n`, 'utf8')
  return rec
}

// ---------------------------------------------------------------- spend ledger

/**
 * The global spend ledger — NOT under projects/, so deleting a project keeps
 * its historical spend.
 */
export function spendFile(userDirectory: string): string {
  return path.join(userDirectory, 'sailor', 'spend.jsonl')
}

/** Append one ledger line. Free runs (no usd, no credits) are not logged. */
export function appendSpend(file: string, entry: Json): void {
  const usd = or(get(entry, 'usd'), 0)
  const credits = or(get(entry, 'credits'), 0)
  if (usd <= 0 && credits <= 0) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${pyDumps(entry)}\n`, 'utf8')
}

function monthKey(tsMs: unknown): string {
  return new Date(num(or(tsMs, 0))).toISOString().slice(0, 7)
}

export interface SpendTotals { usd: number, credits: number }
export interface SpendSummary {
  month: SpendTotals
  total: SpendTotals
  byProject: { uuid: Json, usd: number, credits: number }[]
}

/** Totals for the current UTC calendar month, all time, and per project. */
export function spendSummary(file: string, opts: { nowMs: number }): SpendSummary {
  const month = { usd: 0, credits: 0 }
  const total = { usd: 0, credits: 0 }
  const byProject = new Map<unknown, { uuid: Json, usd: number, credits: number }>()
  const cur = monthKey(opts.nowMs)
  let lines: string[]
  try { lines = fs.readFileSync(file, 'utf8').split('\n') }
  catch { lines = [] }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Json
    try { e = JSON.parse(line) }
    catch { continue }
    if (!isObject(e)) continue
    const usd = pyFloat(or(e.usd, 0))
    const credits = num(or(e.credits, 0))
    total.usd += usd
    total.credits += credits
    if (monthKey(get(e, 'ts')) === cur) {
      month.usd += usd
      month.credits += credits
    }
    const pu = or(get(e, 'projectUuid'), 'unknown')
    let bp = byProject.get(pu)
    if (!bp) {
      bp = { uuid: pu, usd: 0, credits: 0 }
      byProject.set(pu, bp)
    }
    bp.usd += usd
    bp.credits += credits
  }
  const ranked = [...byProject.values()].sort((a, b) => b.usd - a.usd)
  return { month, total, byProject: ranked }
}

// ---------------------------------------------------------------- routes

/**
 * The aiohttp route shell (nodes_sailor_projects.py :456–:561), one function
 * per route. Bodies arrive already parsed; a body that is not a JSON object
 * throws, which the router answers 500 exactly as aiohttp did when the Python
 * called `.get` on it.
 */
export interface ProjectsContext {
  userDir: string
  now(): number
}

export interface RouteResult { status: number, body: unknown }

const ok = (body: unknown): RouteResult => ({ status: 200, body })

function requireObject(body: unknown): Record<string, Json> {
  if (!isObject(body)) throw new TypeError('request body is not a JSON object')
  return body
}

export function projectsListRoute(ctx: ProjectsContext): RouteResult {
  return ok({ projects: listProjects(projectsRoot(ctx.userDir)) })
}

export function projectGetRoute(ctx: ProjectsContext, uuid: string): RouteResult {
  const root = projectsRoot(ctx.userDir)
  const project = readProject(root, uuid)
  if (project === null) return { status: 404, body: { error: 'not found' } }
  const cur = get(project, 'currentVersionId')
  const version = truthy(cur) ? readVersion(root, uuid, cur) : null
  return ok({ project, currentVersion: version })
}

export function projectPutRoute(ctx: ProjectsContext, uuid: string, rawBody: unknown): RouteResult {
  const root = projectsRoot(ctx.userDir)
  const body = requireObject(rawBody)
  let project = readProject(root, uuid)
  if (project === null) {
    project = ensureProject(root, uuid, { name: or(get(body, 'name'), 'Untitled project'), now: ctx.now() })
  }
  if ('name' in body) project.name = body.name
  if ('cover' in body) project.cover = body.cover
  // Cover-only PUTs (lazy backfill stamping) must not bump updatedAt — the
  // project lists sort by it, and a passive backfill would teleport dormant
  // projects to the top as fake activity.
  if (Object.keys(body).some(k => k !== 'cover')) project.updatedAt = ctx.now()
  writeProject(root, project)
  return ok({ project })
}

export function projectDeleteRoute(ctx: ProjectsContext, uuid: string): RouteResult {
  deleteProject(projectsRoot(ctx.userDir), uuid)
  return ok({ ok: true })
}

export function versionsPostRoute(ctx: ProjectsContext, uuid: string, rawBody: unknown): RouteResult {
  const root = projectsRoot(ctx.userDir)
  const body = requireObject(rawBody)
  const now = ctx.now()
  ensureProject(root, uuid, { name: or(get(body, 'projectName'), 'Untitled project'), now })
  const version = { ...requireObject(or(get(body, 'version'), body)) }
  version.id = or(get(version, 'id'), newHexId('v_'))
  if (!('createdAt' in version)) version.createdAt = now
  if (!('name' in version)) version.name = ''
  if (!('parentId' in version)) version.parentId = null
  try {
    writeVersion(root, uuid, version, { now })
  }
  catch (e) {
    if (e instanceof StaleRollingWriteError) return { status: 409, body: { error: 'stale', storedSavedAt: e.storedSavedAt } }
    if (e instanceof ProjectNotFoundError) return { status: 400, body: { error: e.pyStr } }
    if (e instanceof InvalidIdError) return { status: 400, body: { error: e.message } }
    throw e
  }
  return ok({ id: version.id })
}

export function versionGetRoute(ctx: ProjectsContext, uuid: string, vid: string): RouteResult {
  const version = readVersion(projectsRoot(ctx.userDir), uuid, vid)
  if (version === null) return { status: 404, body: { error: 'not found' } }
  return ok({ version })
}

export function generationsPostRoute(ctx: ProjectsContext, uuid: string, rawBody: unknown): RouteResult {
  const root = projectsRoot(ctx.userDir)
  const body = requireObject(rawBody)
  const now = ctx.now()
  const record = { ...requireObject(or(get(body, 'generation'), {})) }
  if (!('id' in record)) record.id = newHexId('g_')
  if (!('ts' in record)) record.ts = now
  let stored: Json
  try {
    ensureProject(root, uuid, { name: or(get(body, 'projectName'), 'Untitled project'), now })
    stored = appendGeneration(root, uuid, record, { now })
  }
  catch (e) {
    if (e instanceof InvalidIdError) return { status: 400, body: { error: e.message } }
    throw e
  }
  if (stored === null) return ok({ id: record.id, deduped: true }) // promptId already recorded (backfill re-post)
  appendSpend(spendFile(ctx.userDir), {
    ts: get(stored, 'ts'),
    projectUuid: uuid,
    promptId: get(stored, 'promptId'),
    usd: get(stored, 'usd'),
    credits: get(stored, 'credits'),
  })
  const project = readProject(root, uuid)
  if (truthy(project)) {
    project.updatedAt = now
    writeProject(root, project)
  }
  return ok({ id: stored.id })
}

export function generationsListRoute(ctx: ProjectsContext, uuid: string): RouteResult {
  return ok({ generations: listGenerations(projectsRoot(ctx.userDir), uuid) })
}

export function spendSummaryRoute(ctx: ProjectsContext): RouteResult {
  return ok(spendSummary(spendFile(ctx.userDir), { nowMs: ctx.now() }))
}
