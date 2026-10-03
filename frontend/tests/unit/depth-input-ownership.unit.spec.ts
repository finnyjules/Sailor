/**
 * Relight stage 2 final-review fix 3: the depth routes (free /api/depth/estimate and paid
 * /api/depth/surfaces) share assertInputOwned. In hosted mode it used to refuse every
 * `output`/`temp` source, which broke depth for WIRED layers (their image is an execution
 * output). It now gates `output` exactly as /view does — the caller's owned output keys — and
 * leaves `temp` to /view's rule (LC11: the caller's own folder). Step 3, R10.9: no harvest of the engine's history any more
 * (the runner records each output as it is saved; hosted never asks the engine).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const g = globalThis as any
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

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

const fetchSpy = vi.fn(async () => new Response('{}'))

import { assertInputOwned } from '../../server/utils/inputOwnership'
import { __setInputUploadsDbForTests } from '../../server/utils/inputUploads'
import { userSubfolder } from '../../server/runner/results'

const ev = (userId: string | null) => ({ context: { userId } }) as any

beforeEach(() => {
  mode = 'hosted'
  owned = new Set()
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  __setInputUploadsDbForTests({ query: async () => ({ rows: [] }) })
})
afterEach(() => { __setInputUploadsDbForTests(null); vi.unstubAllGlobals() })

describe('assertInputOwned — hosted output sources', () => {
  it('an output the caller owns passes', async () => {
    owned = new Set(['output::render_0001.png'])
    await expect(assertInputOwned(ev('u1'), 'output', '', 'render_0001.png')).resolves.toBeUndefined()
  })

  it('an output in a subfolder is keyed with that subfolder', async () => {
    owned = new Set(['output:runs/a:render_0001.png'])
    await expect(assertInputOwned(ev('u1'), 'output', 'runs/a', 'render_0001.png')).resolves.toBeUndefined()
  })

  it('a foreign output 404s, and the engine is never asked (R10.9: no history harvest)', async () => {
    owned = new Set(['output::mine.png'])
    await expect(assertInputOwned(ev('u1'), 'output', '', 'theirs.png')).rejects.toMatchObject({ statusCode: 404 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the key names the file actually read: a slash in filename cannot borrow an owned basename', async () => {
    owned = new Set(['output::mine.png'])
    await expect(assertInputOwned(ev('u1'), 'output', '', 'other/mine.png')).rejects.toMatchObject({ statusCode: 404 })
    owned = new Set(['output:other:mine.png'])
    await expect(assertInputOwned(ev('u1'), 'output', '', 'other/mine.png')).resolves.toBeUndefined()
  })

  it('an output with no signed-in caller 404s', async () => {
    owned = new Set(['output::render_0001.png'])
    await expect(assertInputOwned(ev(null), 'output', '', 'render_0001.png')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('temp is gated as /view gates it (LC11): the caller’s own u_<hash> folder only', async () => {
    const own = userSubfolder('u1', true)
    await expect(assertInputOwned(ev('u1'), 'temp', own, 'live_preview_n_00001.png')).resolves.toBeUndefined()
    await expect(assertInputOwned(ev('u2'), 'temp', own, 'live_preview_n_00001.png')).rejects.toMatchObject({ statusCode: 404 })
    await expect(assertInputOwned(ev('u1'), 'temp', '', 'preview_0001.png')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('local mode never checks', async () => {
    mode = 'local'
    await expect(assertInputOwned(ev(null), 'output', '', 'anything.png')).resolves.toBeUndefined()
  })
})

describe('assertInputOwned — hosted input sources', () => {
  it('an input nobody recorded 404s (LC11: it used to pass)', async () => {
    await expect(assertInputOwned(ev('u1'), 'input', 'masks', 'photo.png')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('an input owned by someone else 404s', async () => {
    __setInputUploadsDbForTests({ query: async () => ({ rows: [{ user_id: 'u2' }] }) })
    await expect(assertInputOwned(ev('u1'), 'input', '', 'photo.png')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('an input the caller owns passes', async () => {
    __setInputUploadsDbForTests({ query: async () => ({ rows: [{ user_id: 'u1' }] }) })
    await expect(assertInputOwned(ev('u1'), 'input', '', 'photo.png')).resolves.toBeUndefined()
  })
})
