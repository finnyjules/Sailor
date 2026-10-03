/**
 * A1 follow-up fix, item 3: before EVERY unit test, point the native engine
 * root (server/native/paths.ts's `engineFolder`, via
 * server/utils/inputUploads.ts's `resolveEngineRoot`) at a fresh, empty temp
 * folder — never the real checkout. The data root's cwd walk
 * (server/utils/dataRoot.ts `computeDataRoot`) finds the real repo root
 * (`frontend/` beside `user/` or `input/`) from ANY unit test's cwd, so a spec that forgets to scope its
 * own engine-root override would otherwise silently read and write the real
 * `user/`, `input/`, `output/` folders next to the actual ComfyUI checkout.
 *
 * This registers at the root suite level (setupFiles load — and so run —
 * before a test file's own top-level code, hence before that file's own
 * `describe`/`beforeEach` calls are even registered), so it runs first on
 * every test: a spec's own `beforeEach` still wins by setting its own
 * override afterward, exactly as the native-*, engine-path-alias and
 * sailor-*-gate specs already do. The one exception is a spec that
 * DELIBERATELY leaves the override unset to test `resolveEngineRoot`'s real
 * cwd/env fallback (`engine-root-resolve.unit.spec.ts`) — that file only
 * calls the pure `computeDataRoot`/`checkEngineRootOnBootWith` functions
 * directly, never `resolveEngineRoot()` itself, so it is unaffected by this
 * override either way.
 *
 * Scoped to this one override rather than a broader global reset: nothing
 * else here needs, or should get, a per-test default.
 *
 * The import of server/utils/inputUploads.ts is DYNAMIC and done inside the
 * hooks, not a static top-level import: several specs (e.g.
 * engine-upload-ownership.unit.spec.ts) `vi.mock('node:fs', ...)` and rely on
 * that mock being in place the FIRST time inputUploads.ts (which imports
 * `existsSync` from 'node:fs') is loaded. A static import here would run at
 * setupFiles time — before that spec's own hoisted `vi.mock` call — caching
 * an inputUploads.ts module bound to the REAL fs, and the spec's later
 * `vi.mock` would then be too late to change it (same cached module
 * instance). Deferring to a dynamic `import()` inside `beforeEach` resolves
 * AFTER the test file's own top-level code (including its `vi.mock` calls
 * and its own imports of inputUploads.ts) has already run, so it always
 * lands on whatever instance — mocked or real — that file already set up.
 */
import { afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir: string | undefined

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailor-unit-test-engine-root-'))
  const { __setInputUploadsEngineRootForTests } = await import('../../../server/utils/inputUploads')
  __setInputUploadsEngineRootForTests(dir)
  // A5: the saved /object_info copy lives in storeDir('data') — the real
  // frontend/.data/ from a test's cwd. Redirect it into the same temp folder.
  const { __setObjectInfoCacheFileForTests, __resetObjectInfoEngineStateForTests } = await import('../../../server/native/objectInfo')
  __setObjectInfoCacheFileForTests(path.join(dir, 'data', 'object_info.json'))
  // …and forget an engine another test saw down (it is remembered for 3 s).
  __resetObjectInfoEngineStateForTests()
})

afterEach(async () => {
  const { __setInputUploadsEngineRootForTests } = await import('../../../server/utils/inputUploads')
  __setInputUploadsEngineRootForTests(undefined)
  const { __setObjectInfoCacheFileForTests } = await import('../../../server/native/objectInfo')
  __setObjectInfoCacheFileForTests(undefined)
  if (dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }) }
    catch { /* best effort */ }
    dir = undefined
  }
})
