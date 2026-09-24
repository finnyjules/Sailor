/**
 * Port of the two boot-time data migrations in
 * comfy_extras/nodes_sailor_projects.py (`_migrate_legacy_user_dir`,
 * `_migrate_legacy_project_keys`), run lazily by server/native/projects.ts's
 * `ensureBootMigrationsRan` before the first native projects/spend read or
 * write. Every test works in its own temp folder, never the real
 * user/sailor tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __resetBootMigrationsForTests, ensureBootMigrationsRan, projectsRoot } from '../../server/native/projects'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-boot-migration-'))
  __resetBootMigrationsForTests()
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
  __resetBootMigrationsForTests()
})

function write(rel: string, text: string) {
  const full = path.join(base, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}
function read(rel: string): string {
  return fs.readFileSync(path.join(base, rel), 'utf8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(base, rel))
}

// ------------------------------------------------------- legacy user dir rename

describe('migrateLegacyUserDir', () => {
  it('renames comfynext -> sailor when sailor is absent', () => {
    write('comfynext/spend.jsonl', '{"usd": 1}\n')
    ensureBootMigrationsRan(base)
    expect(exists('comfynext')).toBe(false)
    expect(read('sailor/spend.jsonl')).toBe('{"usd": 1}\n')
  })

  it('does not touch anything when sailor already exists (never overwrites)', () => {
    write('comfynext/spend.jsonl', '{"usd": 1}\n')
    write('sailor/spend.jsonl', '{"usd": 2}\n')
    ensureBootMigrationsRan(base)
    expect(exists('comfynext')).toBe(true)
    expect(read('sailor/spend.jsonl')).toBe('{"usd": 2}\n')
    expect(read('comfynext/spend.jsonl')).toBe('{"usd": 1}\n')
  })

  it('is a no-op when neither dir exists', () => {
    expect(() => ensureBootMigrationsRan(base)).not.toThrow()
    expect(exists('comfynext')).toBe(false)
    expect(exists('sailor')).toBe(false)
  })

  it('does nothing when sailor already exists and comfynext does not', () => {
    write('sailor/spend.jsonl', '{"usd": 2}\n')
    ensureBootMigrationsRan(base)
    expect(read('sailor/spend.jsonl')).toBe('{"usd": 2}\n')
  })
})

// ------------------------------------------------------- legacy project keys

describe('migrateLegacyProjectKeys', () => {
  it('renames comfynext_* keys to sailor_* (and the bare comfynext key), values kept verbatim', () => {
    const root = projectsRoot(base)
    write(
      path.join(path.relative(base, root), 'p1', 'project.json'),
      '{"uuid":"p1","comfynext_style":"noir","nested":{"comfynext":{"a":1},"comfynext_x":"input/comfynext_frame_1.png"}}',
    )
    ensureBootMigrationsRan(base)
    const migrated = JSON.parse(read(path.join(path.relative(base, root), 'p1', 'project.json')))
    expect(migrated).toEqual({
      uuid: 'p1',
      sailor_style: 'noir',
      nested: { sailor: { a: 1 }, sailor_x: 'input/comfynext_frame_1.png' },
    })
  })

  it('writes the migrated file compact, ensure_ascii=False, separators=(",", ":")', () => {
    const root = projectsRoot(base)
    const rel = path.join(path.relative(base, root), 'p1', 'project.json')
    write(rel, '{"uuid":"p1","comfynext_name":"café"}')
    ensureBootMigrationsRan(base)
    expect(read(rel)).toBe('{"uuid":"p1","sailor_name":"café"}')
  })

  it('keeps an existing sailor_* value on a half-migrated file rather than clobbering it', () => {
    const root = projectsRoot(base)
    const rel = path.join(path.relative(base, root), 'p1', 'project.json')
    write(rel, '{"uuid":"p1","sailor_style":"kept","comfynext_style":"discarded"}')
    ensureBootMigrationsRan(base)
    expect(JSON.parse(read(rel))).toEqual({ uuid: 'p1', sailor_style: 'kept' })
  })

  it('skips files with no comfynext-prefixed key untouched', () => {
    const root = projectsRoot(base)
    const rel = path.join(path.relative(base, root), 'p1', 'project.json')
    write(rel, '{"uuid":"p1","name":"plain"}')
    const before = read(rel)
    ensureBootMigrationsRan(base)
    expect(read(rel)).toBe(before)
  })

  it('skips an unparsable json file without throwing, and still migrates the rest', () => {
    const root = projectsRoot(base)
    const relDir = path.relative(base, root)
    write(path.join(relDir, 'broken', 'project.json'), '{"comfynext_x": not json')
    write(path.join(relDir, 'ok', 'project.json'), '{"uuid":"ok","comfynext_x":1}')
    expect(() => ensureBootMigrationsRan(base)).not.toThrow()
    expect(JSON.parse(read(path.join(relDir, 'ok', 'project.json')))).toEqual({ uuid: 'ok', sailor_x: 1 })
  })

  it('writes a marker file so a second run (fresh process) is a no-op', () => {
    const root = projectsRoot(base)
    const rel = path.join(path.relative(base, root), 'p1', 'project.json')
    write(rel, '{"uuid":"p1","comfynext_style":"noir"}')
    ensureBootMigrationsRan(base)
    expect(exists(path.join(path.relative(base, path.dirname(root)), '.migrated-project-keys-v1'))).toBe(true)

    // Simulate a fresh process (clear the in-memory guard) with a file that
    // has since re-acquired a legacy key (should never happen, but proves the
    // marker — not just the in-memory Set — is what makes this idempotent).
    __resetBootMigrationsForTests()
    write(rel, '{"uuid":"p1","comfynext_style":"noir"}')
    ensureBootMigrationsRan(base)
    expect(JSON.parse(read(rel))).toEqual({ uuid: 'p1', comfynext_style: 'noir' })
  })

  it('is a no-op when the projects root does not exist yet', () => {
    expect(() => ensureBootMigrationsRan(base)).not.toThrow()
  })
})

// ------------------------------------------------------- once-per-process guard

describe('ensureBootMigrationsRan once-per-process guard', () => {
  it('only runs once per base per process, even if called again', () => {
    write('comfynext/spend.jsonl', '{"usd": 1}\n')
    ensureBootMigrationsRan(base)
    expect(exists('sailor/spend.jsonl')).toBe(true)

    // A legacy dir reappearing after the first call (shouldn't happen, but
    // proves the guard actually skips real work on the second call).
    write('comfynext/spend.jsonl', '{"usd": 99}\n')
    ensureBootMigrationsRan(base)
    expect(read('sailor/spend.jsonl')).toBe('{"usd": 1}\n')
    expect(exists('comfynext/spend.jsonl')).toBe(true)
  })

  it('runs independently for two different base dirs', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'native-boot-migration-'))
    try {
      write('comfynext/spend.jsonl', '{"usd": 1}\n')
      fs.mkdirSync(path.join(other, 'comfynext'), { recursive: true })
      fs.writeFileSync(path.join(other, 'comfynext', 'spend.jsonl'), '{"usd": 2}\n', 'utf8')

      ensureBootMigrationsRan(base)
      ensureBootMigrationsRan(other)

      expect(fs.readFileSync(path.join(base, 'sailor', 'spend.jsonl'), 'utf8')).toBe('{"usd": 1}\n')
      expect(fs.readFileSync(path.join(other, 'sailor', 'spend.jsonl'), 'utf8')).toBe('{"usd": 2}\n')
    }
    finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
