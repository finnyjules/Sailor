/**
 * S2 (pre-deploy fix wave) — the engine input directory resolution used to
 * fail OPEN: `engineDirForType` resolved via `path.resolve(process.cwd(),
 * '..', name)` with no verification, so a Nitro process launched from
 * anywhere but `frontend/` silently pointed at a directory that doesn't
 * exist. `existsSync` then misses every disk check, and an unclaimed
 * overwrite that should be refused (nothing on disk = "nobody's file" only
 * because we were looking in the wrong place) gets waved through instead.
 *
 * `computeEngineRoot(cwd, envOverride)` is the pure resolver: env override
 * first (validated — an override that doesn't check out is a misconfigured
 * override, not a silent fallback), else walk up from `cwd` for the
 * ComfyUI checkout marker (`main.py` alongside `input/` — `input/` since
 * that's the directory whose presence the overwrite gate actually depends on). Real temp directories, no fs
 * mocking — this file verifies the walk itself, not a caller's use of it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeEngineRoot, checkEngineRootOnBootWith } from '../../server/utils/inputUploads'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sailor-engine-root-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Lay down the ComfyUI checkout marker (main.py + input/) under `dir`. */
function makeEngineRoot(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.py'), '# comfyui entrypoint\n')
  mkdirSync(join(dir, 'input'), { recursive: true })
}

describe('computeEngineRoot — env override', () => {
  it('uses the env override when it checks out (main.py + input/ present)', () => {
    makeEngineRoot(root)
    expect(computeEngineRoot('/nowhere/relevant', root)).toBe(root)
  })

  it('refuses an override that does not check out — no silent fallback to the cwd walk', () => {
    // `root` exists but has neither main.py nor input/.
    const cwdWithRealRoot = join(root, 'frontend')
    makeEngineRoot(root) // a REAL root sits one level up from cwd...
    // ...but the override points somewhere that isn't one.
    const bogusOverride = join(root, 'not-the-engine')
    mkdirSync(bogusOverride, { recursive: true })
    expect(computeEngineRoot(cwdWithRealRoot, bogusOverride)).toBeNull()
  })

  it('an override missing only input/ is still refused (main.py alone is not the marker)', () => {
    const half = join(root, 'half')
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, 'main.py'), '# entrypoint\n')
    expect(computeEngineRoot('/irrelevant', half)).toBeNull()
  })
})

describe('computeEngineRoot — an override without ComfyUI (R10.10, the hosted image)', () => {
  it('an override with input/ and no main.py checks out', () => {
    const noEngine = join(root, 'app')
    mkdirSync(join(noEngine, 'input'), { recursive: true })
    expect(computeEngineRoot('/irrelevant', noEngine)).toBe(noEngine)
  })

  it('the walk still needs main.py: a bare input/ above cwd is not a root', () => {
    const tree = join(root, 'tree')
    mkdirSync(join(tree, 'input'), { recursive: true })
    mkdirSync(join(tree, 'frontend'), { recursive: true })
    expect(computeEngineRoot(join(tree, 'frontend'), undefined)).toBeNull()
  })
})

describe('computeEngineRoot — walking up from cwd (no override)', () => {
  it('finds the marker at cwd itself', () => {
    makeEngineRoot(root)
    expect(computeEngineRoot(root, undefined)).toBe(root)
  })

  it('finds the marker one level up — the frontend/ launch case', () => {
    makeEngineRoot(root)
    const frontendDir = join(root, 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    expect(computeEngineRoot(frontendDir, undefined)).toBe(root)
  })

  it('finds the marker several levels up', () => {
    makeEngineRoot(root)
    const deep = join(root, 'frontend', '.claude', 'worktrees', 'xyz')
    mkdirSync(deep, { recursive: true })
    expect(computeEngineRoot(deep, undefined)).toBe(root)
  })

  it('returns null when launched from an unrelated directory tree — FAILS CLOSED, not open', () => {
    // A cwd with no main.py/input/ anywhere in its ancestry (an isolated
    // temp dir has no such ancestor within the walk's bound).
    const stray = mkdtempSync(join(tmpdir(), 'sailor-stray-cwd-'))
    try {
      expect(computeEngineRoot(stray, undefined)).toBeNull()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  it('an empty-string env override is treated as unset, not as an override to "" ', () => {
    makeEngineRoot(root)
    const frontendDir = join(root, 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    expect(computeEngineRoot(frontendDir, '')).toBe(root)
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
    expect(logError.mock.calls[0][0]).toMatch(/engine root|SAILOR_ENGINE_ROOT/i)
  })
})
