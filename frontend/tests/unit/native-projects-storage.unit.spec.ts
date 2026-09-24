/**
 * Port of tests-unit/comfy_api_test/projects_storage_test.py — the durable
 * project storage layer, now served natively by Sailor. Each Python test keeps
 * its name (snake_case → words) and its assertions; every test writes into its
 * own temp folder, never the real user/sailor/projects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as P from '../../server/native/projects'
import { isSafeId } from '../../server/native/paths'

let tmp: string
let root: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-projects-'))
  root = P.projectsRoot(tmp)
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function allFiles(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...allFiles(full))
    else out.push(full)
  }
  return out.sort()
}

// ------------------------------------------------------------ layout & CRUD

describe('layout and basic CRUD', () => {
  it('projects root layout', () => {
    expect(P.projectsRoot(tmp).endsWith(path.join('sailor', 'projects'))).toBe(true)
  })

  it('ensure creates then returns existing', () => {
    const created = P.ensureProject(root, 'abc', { name: 'My Project', now: 100 })
    expect(created.uuid).toBe('abc')
    expect(created.name).toBe('My Project')
    expect(created.versionIndex).toEqual([])
    expect(created.currentVersionId).toBeNull()
    const again = P.ensureProject(root, 'abc', { name: 'DIFFERENT', now: 200 })
    expect(again.name).toBe('My Project')
  })

  it('read missing returns none', () => {
    expect(P.readProject(root, 'nope')).toBeNull()
  })

  it('write and read roundtrip', () => {
    P.writeProject(root, { uuid: 'p1', name: 'X', versionIndex: [], updatedAt: 5 })
    expect(P.readProject(root, 'p1')!.name).toBe('X')
  })

  it('list projects sorted newest first', () => {
    P.writeProject(root, { uuid: 'old', name: 'Old', updatedAt: 100, versionIndex: [] })
    P.writeProject(root, { uuid: 'new', name: 'New', updatedAt: 300, versionIndex: [] })
    P.writeProject(root, { uuid: 'mid', name: 'Mid', updatedAt: 200, versionIndex: [] })
    const listed = P.listProjects(root)
    expect(listed.map(p => p.uuid)).toEqual(['new', 'mid', 'old'])
    expect(Object.keys(listed[0]!).sort()).toEqual(['cover', 'name', 'updatedAt', 'uuid'])
  })

  it('list projects empty when no root', () => {
    expect(P.listProjects(P.projectsRoot(tmp))).toEqual([])
  })

  it('delete project', () => {
    P.ensureProject(root, 'gone', { now: 1 })
    expect(P.readProject(root, 'gone')).not.toBeNull()
    expect(P.deleteProject(root, 'gone')).toBe(true)
    expect(P.readProject(root, 'gone')).toBeNull()
    expect(P.deleteProject(root, 'gone')).toBe(false)
  })
})

// ------------------------------------------------------------------ versions

describe('versions', () => {
  it('write version updates index and current', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_1', name: 'v1', createdAt: 10, workflow: { nodes: [] } }, { now: 10 })
    const proj = P.readProject(root, 'p')!
    expect(proj.currentVersionId).toBe('v_1')
    expect(proj.versionIndex.map((m: any) => m.id)).toEqual(['v_1'])
    expect(proj.updatedAt).toBe(10)
    expect('workflow' in proj.versionIndex[0]).toBe(false)
    expect(P.readVersion(root, 'p', 'v_1')!.workflow).toEqual({ nodes: [] })
  })

  it('multiple versions append and advance current', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_1', createdAt: 10 }, { now: 10 })
    P.writeVersion(root, 'p', { id: 'v_2', createdAt: 20, parentId: 'v_1' }, { now: 20 })
    const proj = P.readProject(root, 'p')!
    expect(proj.currentVersionId).toBe('v_2')
    expect(proj.versionIndex.map((m: any) => m.id)).toEqual(['v_1', 'v_2'])
  })

  it('rewriting same version id does not duplicate index', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_1', name: 'first', createdAt: 10 }, { now: 10 })
    P.writeVersion(root, 'p', { id: 'v_1', name: 'second', createdAt: 11 }, { now: 11 })
    const proj = P.readProject(root, 'p')!
    expect(proj.versionIndex.map((m: any) => m.id)).toEqual(['v_1'])
    expect(proj.versionIndex[0].name).toBe('second')
  })

  it('write version missing project raises', () => {
    expect(() => P.writeVersion(root, 'ghost', { id: 'v_1', createdAt: 1 })).toThrow(P.ProjectNotFoundError)
  })

  it('read version missing returns none', () => {
    P.ensureProject(root, 'p', { now: 1 })
    expect(P.readVersion(root, 'p', 'nope')).toBeNull()
  })

  it('index metadata keeps absent fields as null, like Python .get()', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_1' }, { now: 5 })
    expect(P.readProject(root, 'p')!.versionIndex).toEqual([{ id: 'v_1', name: null, createdAt: null, parentId: null }])
  })
})

// ---------------------------------------------------- rolling auto backups

function writeCurrent(uuid: string, createdAt: number, marker: unknown) {
  P.writeVersion(root, uuid, { id: 'current', name: 'Proj', createdAt, workflow: { nodes: [marker] } }, { now: createdAt })
}
function backupMetas(uuid: string): any[] {
  return P.readProject(root, uuid)!.versionIndex.filter((m: any) => String(m.id).startsWith('b_'))
}

describe('rolling-version auto backups', () => {
  it('first current write creates no backup', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrent('p', 10, 'a')
    expect(P.readProject(root, 'p')!.versionIndex.map((m: any) => m.id)).toEqual(['current'])
  })

  it('rewrite of current archives old body', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrent('p', 1000, 'old')
    writeCurrent('p', 1000 + P.BACKUP_MIN_INTERVAL_MS + 1, 'new')
    const metas = backupMetas('p')
    expect(metas).toHaveLength(1)
    const meta = metas[0]
    expect(meta.id).toBe('b_1000')
    expect(isSafeId(meta.id)).toBe(true)
    expect(meta.name).toBe('Auto backup')
    expect(meta.createdAt).toBe(1000)
    expect(meta.parentId).toBe('current')
    const body = P.readVersion(root, 'p', 'b_1000')!
    expect(body.workflow).toEqual({ nodes: ['old'] })
    expect(body.id).toBe('b_1000')
    expect(body.name).toBe('Auto backup')
    expect(P.readProject(root, 'p')!.currentVersionId).toBe('current')
    expect(P.readVersion(root, 'p', 'current')!.workflow).toEqual({ nodes: ['new'] })
  })

  it('rapid rewrites are throttled to one backup', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrent('p', 1000, 'a')
    writeCurrent('p', 2000, 'b')
    writeCurrent('p', 3000, 'c')
    expect(backupMetas('p').map(m => m.id)).toEqual(['b_1000'])
  })

  it('backup resumes after interval gap', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrent('p', 1000, 'a')
    writeCurrent('p', 2000, 'b')
    const late = 1000 + P.BACKUP_MIN_INTERVAL_MS + 1
    writeCurrent('p', late, 'c')
    writeCurrent('p', late + 1000, 'd')
    expect(backupMetas('p').map(m => m.id)).toEqual(['b_1000', `b_${late}`])
  })

  it('backups pruned to cap newest kept', () => {
    P.ensureProject(root, 'p', { now: 1 })
    const step = P.BACKUP_MIN_INTERVAL_MS + 1000
    const times = Array.from({ length: P.BACKUP_KEEP + 6 }, (_, i) => (i + 1) * step)
    times.forEach((t, i) => writeCurrent('p', t, i))
    const metas = backupMetas('p')
    expect(metas).toHaveLength(P.BACKUP_KEEP)
    const archived = times.slice(0, -1)
    const expected = archived.slice(-P.BACKUP_KEEP).map(t => `b_${t}`)
    expect(metas.map(m => m.id).sort()).toEqual([...expected].sort())
    for (const t of archived.slice(0, archived.length - P.BACKUP_KEEP)) {
      expect(P.readVersion(root, 'p', `b_${t}`)).toBeNull()
    }
    expect(P.readVersion(root, 'p', expected[expected.length - 1]!)).not.toBeNull()
  })

  it('named versions never backed up or pruned', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_keep', name: 'Milestone', createdAt: 5, workflow: { nodes: ['m'] } }, { now: 5 })
    const step = P.BACKUP_MIN_INTERVAL_MS + 1000
    for (let i = 0; i < P.BACKUP_KEEP + 6; i++) writeCurrent('p', (i + 1) * step, i)
    const ids = P.readProject(root, 'p')!.versionIndex.map((m: any) => m.id)
    expect(ids).toContain('v_keep')
    expect(P.readVersion(root, 'p', 'v_keep')!.workflow).toEqual({ nodes: ['m'] })
    P.writeVersion(root, 'p', { id: 'v_keep', name: 'Renamed', createdAt: 6, workflow: { nodes: ['m'] } }, { now: 6 })
    expect(backupMetas('p')).toHaveLength(P.BACKUP_KEEP)
  })
})

// ------------------------------------------------------ stale-write guard

function writeCurrentStamped(uuid: string, createdAt: number, savedAt: unknown, marker = 'x') {
  P.writeVersion(root, uuid, { id: 'current', name: 'Proj', createdAt, workflow: { nodes: [marker], savedAt } }, { now: createdAt })
}

describe('rolling-version stale-write guard', () => {
  it('stale rolling write rejected and nothing mutated', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'fresh')
    const bodyBefore = P.readVersion(root, 'p', 'current')
    const indexBefore = P.readProject(root, 'p')!.versionIndex
    const filesBefore = allFiles(root)
    let err: unknown
    try { writeCurrentStamped('p', 20, 1000, 'stale') }
    catch (e) { err = e }
    expect(err).toBeInstanceOf(P.StaleRollingWriteError)
    expect((err as P.StaleRollingWriteError).storedSavedAt).toBe(2000)
    expect(P.readVersion(root, 'p', 'current')).toEqual(bodyBefore)
    expect(P.readProject(root, 'p')!.versionIndex).toEqual(indexBefore)
    expect(allFiles(root)).toEqual(filesBefore)
  })

  it('newer rolling write allowed', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'old')
    writeCurrentStamped('p', 20, 3000, 'new')
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['new'])
  })

  it('equal stamp rolling write allowed', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'a')
    writeCurrentStamped('p', 20, 2000, 'b')
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['b'])
  })

  it('unstamped incoming over stamped stored allowed', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'stamped')
    P.writeVersion(root, 'p', { id: 'current', createdAt: 20, workflow: { nodes: ['nostamp'] } }, { now: 20 })
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['nostamp'])
    P.writeVersion(root, 'p', { id: 'current', createdAt: 30, workflow: null }, { now: 30 })
    expect(P.readVersion(root, 'p', 'current')!.workflow).toBeNull()
  })

  it('stamped incoming over unstamped stored allowed', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'current', createdAt: 10, workflow: { nodes: ['legacy'] } }, { now: 10 })
    writeCurrentStamped('p', 20, 1, 'stamped')
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['stamped'])
  })

  it('named versions bypass stale guard', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'fresh')
    P.writeVersion(root, 'p', { id: 'v_x', name: 'Snapshot', createdAt: 20, workflow: { nodes: ['snap'], savedAt: 1000 } }, { now: 20 })
    expect(P.readVersion(root, 'p', 'v_x')!.workflow.nodes).toEqual(['snap'])
  })

  it('a boolean savedAt is not a stamp (Python excludes bool from int)', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000, 'fresh')
    writeCurrentStamped('p', 20, true, 'bool')
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['bool'])
  })

  it('a fractional savedAt is truncated like Python int()', () => {
    P.ensureProject(root, 'p', { now: 1 })
    writeCurrentStamped('p', 10, 2000.9, 'fresh')
    let err: unknown
    try { writeCurrentStamped('p', 20, 1999, 'stale') }
    catch (e) { err = e }
    expect((err as P.StaleRollingWriteError).storedSavedAt).toBe(2000)
    writeCurrentStamped('p', 30, 2000.1, 'equal-after-trunc')
    expect(P.readVersion(root, 'p', 'current')!.workflow.nodes).toEqual(['equal-after-trunc'])
  })
})

// ------------------------------------------------------ safety & robustness

describe('safety and robustness', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', '.hidden', null, 5]) {
    it(`path traversal and bad ids rejected: ${JSON.stringify(bad)}`, () => {
      expect(P.readProject(root, bad as any)).toBeNull()
      expect(P.deleteProject(root, bad as any)).toBe(false)
      expect(() => P.writeProject(root, { uuid: bad, name: 'x' })).toThrow(P.InvalidIdError)
    })
  }

  it('write version rejects bad version id', () => {
    P.ensureProject(root, 'p', { now: 1 })
    expect(() => P.writeVersion(root, 'p', { id: '../evil', createdAt: 1 }, { now: 1 })).toThrow(P.InvalidIdError)
  })

  it('atomic write no leftover tmp files', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.writeVersion(root, 'p', { id: 'v_1', createdAt: 1 }, { now: 1 })
    expect(allFiles(root).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('corrupt project json reads as none', () => {
    P.ensureProject(root, 'p', { now: 1 })
    fs.writeFileSync(path.join(root, 'p', 'project.json'), '{ not valid json')
    expect(P.readProject(root, 'p')).toBeNull()
    expect(P.listProjects(root)).toEqual([])
  })

  it('written files are valid json on disk', () => {
    P.ensureProject(root, 'p', { name: 'Disk', now: 1 })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'p', 'project.json'), 'utf8')).name).toBe('Disk')
  })

  it('project files are private to the owner, like Python mkstemp (0600)', () => {
    P.ensureProject(root, 'p', { now: 1 })
    expect(fs.statSync(path.join(root, 'p', 'project.json')).mode & 0o777).toBe(0o600)
  })
})

// --------------------------------------------------------- generations

describe('generation records', () => {
  it('append and list generations newest first', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.appendGeneration(root, 'p', { id: 'g_1', promptId: 'pr1', ts: 100, outputs: [] })
    P.appendGeneration(root, 'p', { id: 'g_2', promptId: 'pr2', ts: 300, outputs: [] })
    P.appendGeneration(root, 'p', { id: 'g_3', promptId: 'pr3', ts: 200, outputs: [] })
    expect(P.listGenerations(root, 'p').map(g => g.id)).toEqual(['g_2', 'g_3', 'g_1'])
  })

  it('append generation dedups by prompt id', () => {
    P.ensureProject(root, 'p', { now: 1 })
    expect(P.appendGeneration(root, 'p', { id: 'g_1', promptId: 'pr1', ts: 100 })).not.toBeNull()
    expect(P.appendGeneration(root, 'p', { id: 'g_2', promptId: 'pr1', ts: 200 })).toBeNull()
    expect(P.listGenerations(root, 'p')).toHaveLength(1)
  })

  it('append generation fills id and ts', () => {
    P.ensureProject(root, 'p', { now: 1 })
    const stored = P.appendGeneration(root, 'p', { promptId: 'pr1' }, { now: 555 })!
    expect(String(stored.id)).toMatch(/^g_[0-9a-f]{12}$/)
    expect(stored.ts).toBe(555)
  })

  it('list generations missing file or project', () => {
    expect(P.listGenerations(root, 'nope')).toEqual([])
    P.ensureProject(root, 'p', { now: 1 })
    expect(P.listGenerations(root, 'p')).toEqual([])
  })

  it('list generations skips corrupt lines', () => {
    P.ensureProject(root, 'p', { now: 1 })
    P.appendGeneration(root, 'p', { id: 'g_1', promptId: 'pr1', ts: 100 })
    fs.appendFileSync(path.join(root, 'p', 'generations.jsonl'), '{ not valid json\n')
    P.appendGeneration(root, 'p', { id: 'g_2', promptId: 'pr2', ts: 200 })
    expect(P.listGenerations(root, 'p').map(g => g.id)).toEqual(['g_2', 'g_1'])
  })

  it('append generation bad uuid raises', () => {
    expect(() => P.appendGeneration(root, '../evil', { promptId: 'x' })).toThrow(P.InvalidIdError)
  })
})

// ------------------------------------------------------------ spend ledger

// 2026-06-15T00:00:00Z and 2026-05-15T00:00:00Z in ms.
const JUNE_TS = 1781481600000
const MAY_TS = 1778803200000

describe('spend ledger', () => {
  let ledger: string
  beforeEach(() => { ledger = P.spendFile(tmp) })

  it('spend file layout', () => {
    expect(P.spendFile(tmp).endsWith(path.join('sailor', 'spend.jsonl'))).toBe(true)
  })

  it('append spend skips free runs', () => {
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'p', usd: 0, credits: null })
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'p', usd: null, credits: 0 })
    expect(fs.existsSync(ledger)).toBe(false)
  })

  it('spend summary months and projects', () => {
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'a', promptId: '1', usd: 0.04, credits: null })
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'a', promptId: '2', usd: 6.0, credits: null })
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'b', promptId: '3', usd: null, credits: 120 })
    P.appendSpend(ledger, { ts: MAY_TS, projectUuid: 'a', promptId: '4', usd: 1.0, credits: null })
    const s = P.spendSummary(ledger, { nowMs: JUNE_TS })
    expect(s.month.usd).toBeCloseTo(6.04)
    expect(s.month.credits).toBe(120)
    expect(s.total.usd).toBeCloseTo(7.04)
    const by = Object.fromEntries(s.byProject.map(p => [p.uuid, p]))
    expect(by.a!.usd).toBeCloseTo(7.04)
    expect(by.b!.credits).toBe(120)
    // Ranked by usd, highest first.
    expect(s.byProject.map(p => p.uuid)).toEqual(['a', 'b'])
  })

  it('spend summary empty and corrupt', () => {
    expect(P.spendSummary(ledger, { nowMs: JUNE_TS })).toEqual({ month: { usd: 0, credits: 0 }, total: { usd: 0, credits: 0 }, byProject: [] })
    fs.mkdirSync(path.dirname(ledger), { recursive: true })
    fs.writeFileSync(ledger, 'garbage\n')
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'a', usd: 1.0 })
    expect(P.spendSummary(ledger, { nowMs: JUNE_TS }).total.usd).toBeCloseTo(1.0)
  })

  it('writes ledger lines exactly as Python json.dumps does', () => {
    P.appendSpend(ledger, { ts: JUNE_TS, projectUuid: 'a', promptId: 'x', usd: 0.04, credits: null })
    expect(fs.readFileSync(ledger, 'utf8')).toBe('{"ts": 1781481600000, "projectUuid": "a", "promptId": "x", "usd": 0.04, "credits": null}\n')
  })
})
