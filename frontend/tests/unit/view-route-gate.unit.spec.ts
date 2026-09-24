/**
 * Stage 5 security review C2: the annotated-filename escape on /view.
 *
 * ComfyUI's folder_paths.annotated_filepath() resolves a trailing
 * `[output]` / `[input]` / `[temp]` annotation BEFORE the `type` query param
 * is ever consulted (server.py view_image: `filename, output_dir =
 * annotated_filepath(filename)` … `if output_dir is None: type = query.get
 * ("type", "output")`). So Task 5's gate — which only fired on
 * `type === 'output'` — was bypassed by:
 *
 *   GET /view?type=temp&filename=victim.png%20[output]
 *
 * The gate saw type=temp and waved it through; the engine served the
 * protected OUTPUT bytes. `blake3:`-prefixed filenames are a second
 * resolution mode that skips annotation handling entirely and resolves
 * through the engine's asset store.
 *
 * These tests drive the REAL route handler (server/routes/view.get.ts), so
 * they fail against the pre-fix tree. Since engine-free Phase A (A4) the route
 * reads the files itself: "served" means the bytes came off a temp engine
 * root, and "the engine was asked" means a file was read at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
g.getQuery = (event: any) => event.query
g.setResponseHeaders = () => {}

let mode: 'local' | 'hosted' = 'hosted'
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
}))

let owned = new Set<string>()
vi.mock('../../server/utils/graphRuns', async (orig) => {
  const actual = await orig() as any
  return { ...actual, ownedOutputKeys: async () => owned }
})

const harvestPendingOutputs = vi.fn(async () => {})
vi.mock('../../server/utils/engineGate', async (orig) => {
  const actual = await orig() as any
  return { ...actual, harvestPendingOutputs: (...a: any[]) => harvestPendingOutputs(...(a as [])) }
})

// Keep the disk cache out of the test run entirely.
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig() as any
  return { ...actual, mkdir: vi.fn(async () => {}), copyFile: vi.fn(async () => {}) }
})

// Every file read the route makes goes through openSync — the "engine was
// asked" signal the pre-A4 version of this spec took from a stubbed fetch.
// The old proxy's disk cache (<cwd>/.cache/images) is never consulted.
const { openSync } = vi.hoisted(() => ({ openSync: vi.fn() }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig() as any
  openSync.mockImplementation(actual.openSync)
  const existsSync = (p: string) => !String(p).includes('/.cache/images/') && actual.existsSync(p)
  return { ...actual, default: { ...actual, openSync, existsSync }, openSync, existsSync }
})
const fetchMock = openSync

let handler: (event: any) => Promise<any>
beforeAll(async () => { handler = (await import('../../server/routes/view.get')).default as any })

let root = ''
beforeEach(() => {
  mode = 'hosted'
  owned = new Set()
  fetchMock.mockClear()
  harvestPendingOutputs.mockClear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'view-route-gate-'))
  for (const f of ['output/mine.png', 'output/victim.png', 'output/whatever.png', 'output/anything.png',
    'output/sub/mine.png', 'output/other/mine.png', 'temp/scratch.png']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    fs.writeFileSync(path.join(root, f), 'PIXELS')
  }
  __setInputUploadsEngineRootForTests(root)
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

type Query = Record<string, string | string[]>
function ev(query: Query) {
  return { query, method: 'GET', context: { userId: 'u1' }, node: { req: { headers: {} }, res: { statusCode: 200, setHeader() {} } } }
}
async function code(query: Query): Promise<number | 'served'> {
  try {
    await handler(ev(query))
    return 'served'
  } catch (e: any) { return e?.statusCode ?? 500 }
}

describe('hosted /view — annotation resolves the EFFECTIVE type', () => {
  it('refuses an unowned output smuggled in behind type=temp', async () => {
    expect(await code({ type: 'temp', filename: 'victim.png [output]' })).toBe(404)
    expect(fetchMock, 'engine must never be asked for an unowned output').not.toHaveBeenCalled()
  })

  it('refuses it behind type=input too, and with no type at all', async () => {
    expect(await code({ type: 'input', filename: 'victim.png [output]' })).toBe(404)
    expect(await code({ filename: 'victim.png [output]' })).toBe(404)
  })

  it('gates on the ANNOTATION-STRIPPED basename, so an owned file still serves', async () => {
    owned = new Set(['output::mine.png'])
    expect(await code({ type: 'temp', filename: 'mine.png [output]' })).toBe('served')
    expect(await code({ filename: 'mine.png [output]' })).toBe('served')
    expect(await code({ filename: 'mine.png' })).toBe('served')
    expect(fetchMock, 'an owned file is really read off disk').toHaveBeenCalledTimes(3)
  })

  it('carries the subfolder into the ownership key', async () => {
    owned = new Set(['output:sub:mine.png'])
    expect(await code({ type: 'temp', subfolder: 'sub', filename: 'mine.png [output]' })).toBe('served')
    expect(await code({ type: 'temp', subfolder: 'other', filename: 'mine.png [output]' })).toBe(404)
  })

  it('strips path segments the way os.path.basename does', async () => {
    owned = new Set(['output::mine.png'])
    expect(await code({ type: 'temp', filename: 'a/b/mine.png [output]' })).toBe('served')
  })

  it('treats a backslash as part of the name, as the served file does (POSIX basename)', async () => {
    // `x\mine.png` is its own file in output/, not `mine.png`: owning
    // mine.png must not unlock it.
    fs.writeFileSync(path.join(root, 'output', 'x\\mine.png'), 'SOMEONE ELSE')
    owned = new Set(['output::mine.png'])
    expect(await code({ filename: 'x\\mine.png' })).toBe(404)
    expect(await code({ type: 'temp', filename: 'x\\mine.png [output]' })).toBe(404)
    expect(fetchMock, 'the unowned file is never opened').not.toHaveBeenCalled()
    owned = new Set(['output::x\\mine.png'])
    expect(await code({ filename: 'x\\mine.png' })).toBe('served')
  })

  it('still gates plain type=output reads (no regression)', async () => {
    expect(await code({ type: 'output', filename: 'victim.png' })).toBe(404)
    expect(harvestPendingOutputs, 'race-window harvest still runs').toHaveBeenCalled()
  })

  it('leaves genuinely-temp reads ungated (documented Stage 5 gap, unchanged)', async () => {
    expect(await code({ type: 'temp', filename: 'scratch.png' })).toBe('served')
  })

  // Round-2 review F5: a repeated query key makes getQuery return an ARRAY,
  // and view.get.ts casts it `as string`. The gate then calls .startsWith on
  // an array and dies with a TypeError — a 500 where a decision belongs, from
  // a URL any unauthenticated-shaped client can construct.
  //
  // Rejecting beats coercing: String(['a','b']) is "a,b", which is neither a
  // filename the gate would resolve nor what the forward loop sends for a
  // repeated key, so a coerced gate key and the engine request would disagree
  // about which file is being served.
  describe('F5: array-valued query params are a 400, never a 500', () => {
    it('rejects a repeated filename', async () => {
      expect(await code({ filename: ['a.png', 'b.png'] })).toBe(400)
      expect(fetchMock, 'engine must not be asked').not.toHaveBeenCalled()
    })

    it('rejects a repeated filename even when one element is owned', async () => {
      // The coercion bug's most dangerous shape: smuggle an owned name
      // alongside an unowned one and hope the gate reads the wrong element.
      owned = new Set(['output::mine.png'])
      expect(await code({ filename: ['mine.png', 'victim.png'] })).toBe(400)
      expect(await code({ filename: ['victim.png', 'mine.png'] })).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a repeated type or subfolder', async () => {
      owned = new Set(['output::mine.png'])
      expect(await code({ filename: 'mine.png', type: ['output', 'temp'] })).toBe(400)
      expect(await code({ filename: 'mine.png', subfolder: ['a', 'b'] })).toBe(400)
    })

    it('still serves the ordinary single-valued form', async () => {
      owned = new Set(['output::mine.png'])
      expect(await code({ filename: 'mine.png', type: 'output', subfolder: '' })).toBe('served')
    })
  })

  it('rejects blake3: filenames outright — a second resolution mode the key check cannot model', async () => {
    expect(await code({ filename: 'blake3:deadbeef' })).toBe(400)
    expect(await code({ type: 'temp', filename: 'blake3:deadbeef' })).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a session', async () => {
    let threw = 0
    try { await handler({ query: { filename: 'x.png [output]' }, context: {} }) } catch (e: any) { threw = e.statusCode }
    expect(threw).toBe(401)
  })
})

describe('local mode is ungated', () => {
  beforeEach(() => { mode = 'local' })
  it('serves annotated filenames with no ownership check', async () => {
    expect(await code({ type: 'temp', filename: 'anything.png [output]' })).toBe('served')
    expect(await code({ type: 'output', filename: 'whatever.png' })).toBe('served')
    expect(harvestPendingOutputs).not.toHaveBeenCalled()
  })

  it('answers blake3 hashes 404, as the engine did without --enable-assets', async () => {
    expect(await code({ filename: 'blake3:deadbeef' })).toBe(404)
  })
})
