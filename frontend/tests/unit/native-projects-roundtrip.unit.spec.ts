/**
 * Same folders, same formats: a project folder written by the PYTHON storage
 * layer is read back and extended natively, and every file comes out byte-for-
 * byte what the Python layer writes for the same operations. The fixture was
 * produced by running comfy_extras/nodes_sailor_projects.py itself (see the
 * fixture's `_note`), so both sides are real outputs, not hand-written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as P from '../../server/native/projects'
import { pyDumps } from '../../server/native/pyJson'
import fixture from './fixtures/native-projects-python-layout.json'

let user: string
let root: string

function writeTree(base: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(base, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
}
function readTree(base: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(base)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

beforeEach(() => {
  user = fs.mkdtempSync(path.join(os.tmpdir(), 'native-roundtrip-'))
  root = P.projectsRoot(user)
  writeTree(user, fixture.before)
})
afterEach(() => { fs.rmSync(user, { recursive: true, force: true }) })

describe('a Python-written project, read and extended natively', () => {
  it('reads every field of the Python files unchanged', () => {
    const project = P.readProject(root, 'p-py')!
    expect(project).toEqual(JSON.parse(fixture.before['sailor/projects/p-py/project.json']))
    expect(project.name).toBe('Café ☕ project')
    const current = P.readVersion(root, 'p-py', 'current')!
    expect(current).toEqual(JSON.parse(fixture.before['sailor/projects/p-py/versions/current.json']))
    expect(P.listGenerations(root, 'p-py')).toEqual([JSON.parse(fixture.before['sailor/projects/p-py/generations.jsonl'])])
    expect(P.listProjects(root)).toEqual([{ uuid: 'p-py', name: 'Café ☕ project', cover: null, updatedAt: 1500 }])
    expect(P.spendSummary(P.spendFile(user), { nowMs: 1200 }).total.usd).toBeCloseTo(0.04)
  })

  it('re-serializes each Python file to the identical bytes', () => {
    for (const [rel, text] of Object.entries(fixture.before)) {
      if (rel.endsWith('.jsonl')) {
        const lines = text.split('\n').filter(Boolean)
        expect(lines.map(l => pyDumps(JSON.parse(l))), rel).toEqual(lines)
      }
      else {
        expect(pyDumps(JSON.parse(text), 2), rel).toBe(text)
      }
    }
  })

  it('appends natively and leaves every file exactly as the Python layer would', () => {
    P.writeVersion(root, 'p-py', { id: 'v_two', name: 'Zweite — Fassung', createdAt: 2000, parentId: 'v_named', workflow: { nodes: [1] } }, { now: 2000 })
    P.appendGeneration(root, 'p-py', { id: 'g_n1', promptId: 'pr-2', ts: 2100, usd: 1.5, prompt: 'ünï 😀' }, { now: 2100 })
    P.appendSpend(P.spendFile(user), { ts: 2100, projectUuid: 'p-py', promptId: 'pr-2', usd: 1.5, credits: null })
    const t = 1000 + P.BACKUP_MIN_INTERVAL_MS + 5
    P.writeVersion(root, 'p-py', { id: 'current', name: 'Café ☕ project', createdAt: t, parentId: null, workflow: { nodes: [], savedAt: t } }, { now: t })

    expect(readTree(user)).toEqual(fixture.after)
  })
})
