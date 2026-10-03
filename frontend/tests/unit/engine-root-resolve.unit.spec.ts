/**
 * S2 (pre-deploy fix wave) — the data folder resolution used to fail OPEN:
 * `engineDirForType` resolved via `path.resolve(process.cwd(), '..', name)`
 * with no verification, so a Nitro process launched from anywhere but
 * `frontend/` silently pointed at a directory that doesn't exist. `existsSync`
 * then misses every disk check, and an unclaimed overwrite that should be
 * refused gets waved through instead.
 *
 * C1 (ComfyUI code removal): `computeDataRoot(cwd, env)` is the pure resolver
 * (server/utils/dataRoot.ts). `SAILOR_DATA_ROOT` first, the old
 * `SAILOR_ENGINE_ROOT` as an alias (validated by `input/` — a setting that
 * doesn't check out fails closed, never falls back), else walk up from `cwd`
 * for the repo root: `frontend/` beside `user/` or `input/`. No `main.py` is
 * involved anywhere. Real temp directories, no fs mocking.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkEngineRootOnBootWith, engineDirForType, resolveEngineRoot } from '../../server/utils/inputUploads'
import { __setDataRootForTests, computeDataRoot, dataFolder, dataPath, resolveDataRoot } from '../../server/utils/dataRoot'
import { engineFolder } from '../../server/native/paths'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sailor-data-root-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A Sailor checkout with no ComfyUI: frontend/ beside the data folders, no main.py. */
function makeRepo(dir: string, folders: string[] = ['input', 'output', 'temp', 'user', 'models']): void {
  mkdirSync(join(dir, 'frontend'), { recursive: true })
  for (const f of folders) mkdirSync(join(dir, f), { recursive: true })
}

describe('computeDataRoot — named by SAILOR_DATA_ROOT', () => {
  it('uses the named folder when it holds input/ (no main.py anywhere)', () => {
    mkdirSync(join(root, 'input'))
    expect(computeDataRoot('/nowhere/relevant', { SAILOR_DATA_ROOT: root })).toBe(root)
  })

  it('refuses a named folder without input/ — no silent fallback to the cwd walk', () => {
    makeRepo(root) // a REAL repo root sits one level up from cwd...
    const bogus = join(root, 'not-the-data')
    mkdirSync(bogus)
    expect(computeDataRoot(join(root, 'frontend'), { SAILOR_DATA_ROOT: bogus })).toBeNull()
  })

  it('the hosted image: /app-shaped folder with input/ and no Python checks out', () => {
    const app = join(root, 'app')
    makeRepo(app)
    expect(computeDataRoot(join(app, 'frontend'), { SAILOR_DATA_ROOT: app })).toBe(app)
  })
})

describe('computeDataRoot — SAILOR_ENGINE_ROOT, the old name', () => {
  it('is still read when SAILOR_DATA_ROOT is unset', () => {
    mkdirSync(join(root, 'input'))
    expect(computeDataRoot('/irrelevant', { SAILOR_ENGINE_ROOT: root })).toBe(root)
  })

  it('SAILOR_DATA_ROOT wins when both are set', () => {
    const data = join(root, 'data')
    const engine = join(root, 'engine')
    mkdirSync(join(data, 'input'), { recursive: true })
    mkdirSync(join(engine, 'input'), { recursive: true })
    expect(computeDataRoot('/irrelevant', { SAILOR_DATA_ROOT: data, SAILOR_ENGINE_ROOT: engine })).toBe(data)
  })

  it('a broken SAILOR_DATA_ROOT fails closed even when the old name points somewhere good', () => {
    const engine = join(root, 'engine')
    mkdirSync(join(engine, 'input'), { recursive: true })
    expect(computeDataRoot('/irrelevant', { SAILOR_DATA_ROOT: join(root, 'missing'), SAILOR_ENGINE_ROOT: engine })).toBeNull()
  })

  it('empty strings are treated as unset', () => {
    makeRepo(root)
    expect(computeDataRoot(join(root, 'frontend'), { SAILOR_DATA_ROOT: '', SAILOR_ENGINE_ROOT: '' })).toBe(root)
  })
})

describe('computeDataRoot — walking up from cwd (nothing named)', () => {
  it('finds the repo root from frontend/ with no main.py present', () => {
    makeRepo(root)
    expect(computeDataRoot(join(root, 'frontend'), {})).toBe(root)
  })

  it('finds it at cwd itself and several levels down', () => {
    makeRepo(root)
    expect(computeDataRoot(root, {})).toBe(root)
    const deep = join(root, 'frontend', 'server', 'native')
    mkdirSync(deep, { recursive: true })
    expect(computeDataRoot(deep, {})).toBe(root)
  })

  it('user/ alone beside frontend/ is enough (a checkout before any upload)', () => {
    makeRepo(root, ['user'])
    expect(computeDataRoot(join(root, 'frontend'), {})).toBe(root)
  })

  it('a stray input/ with no frontend/ beside it is not the root', () => {
    mkdirSync(join(root, 'input'))
    const cwd = join(root, 'elsewhere')
    mkdirSync(cwd)
    expect(computeDataRoot(cwd, {})).toBeNull()
  })

  it('frontend/ alone (no user/ or input/) is not the root', () => {
    mkdirSync(join(root, 'frontend'))
    expect(computeDataRoot(join(root, 'frontend'), {})).toBeNull()
  })

  it('main.py is not a marker: main.py + input/ without frontend/ is not the root', () => {
    mkdirSync(join(root, 'input'))
    writeFileSync(join(root, 'main.py'), '# old entrypoint\n')
    const cwd = join(root, 'x')
    mkdirSync(cwd)
    expect(computeDataRoot(cwd, {})).toBeNull()
  })

  it('returns null when launched from an unrelated directory tree — FAILS CLOSED, not open', () => {
    const stray = mkdtempSync(join(tmpdir(), 'sailor-stray-cwd-'))
    try {
      expect(computeDataRoot(stray, {})).toBeNull()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })
})

describe('the folders every consumer reads (one helper)', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
    __setDataRootForTests(undefined)
  })

  it('resolve under a repo with no main.py, from the real env + cwd', () => {
    makeRepo(root)
    __setDataRootForTests(undefined) // past the unit-test safety net: the real resolution
    delete process.env.SAILOR_ENGINE_ROOT
    process.env.SAILOR_DATA_ROOT = root
    expect(resolveDataRoot()).toBe(root)
    expect(resolveEngineRoot()).toBe(root)
    for (const f of ['input', 'output', 'temp', 'user', 'models'] as const) {
      expect(dataFolder(f)).toBe(join(root, f))
      expect(engineFolder(f)).toBe(join(root, f))
    }
    expect(engineDirForType('input')).toBe(join(root, 'input'))
    expect(engineDirForType('output')).toBe(join(root, 'output'))
    expect(dataPath('models', 'loras')).toBe(join(root, 'models', 'loras'))
  })

  it('the old SAILOR_ENGINE_ROOT alone still resolves them', () => {
    makeRepo(root)
    __setDataRootForTests(undefined)
    delete process.env.SAILOR_DATA_ROOT
    process.env.SAILOR_ENGINE_ROOT = root
    expect(resolveEngineRoot()).toBe(root)
    expect(dataFolder('user')).toBe(join(root, 'user'))
  })

  it('an unknown root: guards get null, local-studio paths keep the folder above cwd', () => {
    __setDataRootForTests(null)
    expect(dataFolder('input')).toBeNull()
    expect(engineDirForType('input')).toBeNull()
    expect(dataPath('models', 'voices')).toBe(join(process.cwd(), '..', 'models', 'voices'))
  })
})

describe('checkEngineRootOnBootWith — the boot-time loud-failure assert', () => {
  it('local mode: never checks the root, never logs', () => {
    const logError = vi.fn()
    const resolveRoot = vi.fn(() => null)
    const ok = checkEngineRootOnBootWith({ isHosted: () => false, resolveRoot, logError })
    expect(ok).toBe(true)
    expect(resolveRoot).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('hosted + resolvable root: no error logged', () => {
    const logError = vi.fn()
    const ok = checkEngineRootOnBootWith({ isHosted: () => true, resolveRoot: () => '/srv/comfy', logError })
    expect(ok).toBe(true)
    expect(logError).not.toHaveBeenCalled()
  })

  it('hosted + unresolvable root: logs an ERROR naming the misconfiguration', () => {
    const logError = vi.fn()
    const ok = checkEngineRootOnBootWith({ isHosted: () => true, resolveRoot: () => null, logError })
    expect(ok).toBe(false)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toMatch(/SAILOR_DATA_ROOT/)
  })
})
