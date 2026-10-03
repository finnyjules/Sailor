/**
 * LC11: hosted reads of a person's files, with two accounts.
 *
 * Before LC11 hosted /view checked an owner only for outputs and for Frame
 * Animate clips (LC10 fix round 1). Every other input file (top-level uploads,
 * upload subfolders, shader bakes, files a run saved) and every temp file
 * (live previews, temp uploads) was served to anyone who could name it. The
 * depth routes passed any input nobody had recorded and every temp file.
 *
 * This drives the real GET /view handler (server/routes/view.get.ts) over a
 * temp engine root: A reads each of A's files, B gets 404 for every one of
 * them, by every spelling (subfolder forms, annotation, URL-encoded, the
 * `/api/view` and `/comfyui/view` aliases, the gen-3d spelling). The same
 * rule runs in the depth routes (assertInputOwned).
 *
 * The runner's start check (B naming A's file in a workflow) is already
 * pinned elsewhere: tests/unit/runner-files.unit.spec.ts ("assertFilesOwned
 * refuses someone else's picture in hosted, not locally"),
 * runner-cards-bake.unit.spec.ts ("a bake file that is someone else's is
 * refused 403 before any hold"), runner-hosted-by-hand.unit.spec.ts and
 * runner-live-preview.unit.spec.ts (a pinned file of another user, 403).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { savedInputKey } from '../../server/utils/graphRuns'
import { userSubfolder } from '../../server/runner/results'
import { hostedViewGate } from '../../server/native/viewGate'
import { viewQueryOf } from '../../server/native/viewRead'
import { assertInputOwned } from '../../server/utils/inputOwnership'
import { hostedEngineDecision, normalizeEnginePath } from '../../server/utils/enginePath'

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

const A = 'user_A'
const B = 'user_B'
const uA = userSubfolder(A, true)
const uB = userSubfolder(B, true)

/** graph_runs keys per person: A's run saved an output and (Layerize) an input file. */
const runKeys = new Map<string, Set<string>>()
vi.mock('../../server/utils/graphRuns', async (orig) => {
  const actual = await orig() as any
  return { ...actual, ownedOutputKeys: async (userId: string) => runKeys.get(userId) ?? new Set() }
})

// Keep GET /view's disk cache out of the run.
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig() as any
  return { ...actual, mkdir: vi.fn(async () => {}), copyFile: vi.fn(async () => {}) }
})

let handler: (event: any) => Promise<any>
beforeAll(async () => { handler = (await import('../../server/routes/view.get')).default as any })

const BAKE = `shader_bake/${'b'.repeat(32)}`
const FRAME = `shader_bake_${'a'.repeat(32)}.png`

/** Every file on disk: [type, subfolder, filename]. */
const FILES: [string, string, string][] = [
  ['input', '', 'a_photo.png'], // A's top-level upload
  ['input', 'pasted', 'a_paste.png'], // A's upload in a subfolder
  ['input', 'moodboard_1786093872477', 'a_mb.png'], // A's moodboard picture
  ['input', 'sailor_node_covers', 'node_x_y_1.webp'], // A's project cover
  ['input', BAKE, FRAME], // A's shader bake frame
  ['input', 'sailor_clips/clip_1_abc', '000000.png'], // A's Animate clip
  ['input', uA, 'seedream_layer_00001_.png'], // saved by A's run (Layerize)
  ['temp', uA, 'live_preview_n_00001.png'], // A's live preview
  ['temp', `${uA}/sub`, 'ComfyUI_temp_00001_.png'], // A's Preview image under a subfolder
  ['temp', '', 'a_temp_upload.png'], // A's upload with type=temp
  ['output', uA, 'ComfyUI_00001_.png'], // A's run output
  ['input', '', 'orphan.png'], // nobody's (no row)
  ['temp', '', 'orphan_preview.png'], // nobody's
  ['input', 'sailor_textures/Wood095', 'Color.jpg'], // public catalog
  ['input', 'sailor_hdri', 'studio_2k.hdr'], // public catalog
  ['input', 'sailor_depth', 'depth_0123456789abcdef.png'], // content-addressed
  ['input', 'sailor_depth', 'secret.png'], // not a depth name: not public
]

const ROWS = new Map<string, string>([
  ['input::a_photo.png', A],
  ['input:pasted:a_paste.png', A],
  ['input:moodboard_1786093872477:a_mb.png', A],
  ['input:sailor_node_covers:node_x_y_1.webp', A],
  [`input:${BAKE}:${FRAME}`, A],
  ['input:sailor_clips/clip_1_abc:clip.json', A],
  ['temp::a_temp_upload.png', A],
])

let root = ''
let opened: string[] = []
beforeEach(() => {
  mode = 'hosted'
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc11-'))
  for (const [type, sub, name] of FILES) {
    fs.mkdirSync(path.join(root, type, sub), { recursive: true })
    fs.writeFileSync(path.join(root, type, sub, name), `bytes of ${type}/${sub}/${name}`)
  }
  __setInputUploadsEngineRootForTests(root)
  opened = []
  __setInputUploadsDbForTests({
    query: async (_sql: string, p?: unknown[]) => {
      const owner = ROWS.get(String(p?.[0]))
      return { rows: owner ? [{ user_id: owner }] : [] }
    },
  })
  runKeys.clear()
  runKeys.set(A, new Set([`output:${uA}:ComfyUI_00001_.png`, savedInputKey({ filename: 'seedream_layer_00001_.png', subfolder: uA })]))
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  __setInputUploadsDbForTests(null)
  fs.rmSync(root, { recursive: true, force: true })
})

type Query = Record<string, string>
async function view(userId: string, query: Query): Promise<number | 'served'> {
  try {
    await handler({ query, method: 'GET', context: { userId }, node: { req: { headers: {} }, res: { statusCode: 200, setHeader() {} } } })
    return 'served'
  }
  catch (e: any) { return e?.statusCode ?? 500 }
}

/** Every spelling of one file's /view query the resolver reads as that file. */
function spellings(type: string, sub: string, name: string): Query[] {
  const out: Query[] = [{ type, subfolder: sub, filename: name }]
  // The annotation outranks `type`.
  out.push({ type: type === 'output' ? 'input' : 'output', subfolder: sub, filename: `${name} [${type}]` })
  if (type === 'output') out.push({ subfolder: sub, filename: name })
  if (sub) {
    out.push({ type, subfolder: `./${sub}/`, filename: name })
    out.push({ type, subfolder: sub.replace('/', '//'), filename: name })
    out.push({ type, subfolder: `x/../${sub}`, filename: name })
  }
  else out.push({ type, filename: name })
  // A path in the filename: the resolver serves its basename from the subfolder.
  out.push({ type, subfolder: sub, filename: `ignored/${name}` })
  // URL-encoded, read back as the server reads a query string.
  const enc = (s: string) => [...s].map(c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
  const q = viewQueryOf(new URL(`http://x/view?type=${enc(type)}&subfolder=${enc(sub)}&filename=${enc(name)}`).searchParams) as Query
  out.push(q)
  return out
}

const OWN_BY_A = FILES.slice(0, 11)

describe('hosted GET /view: A reads A\'s files, B gets 404 for every one, by every spelling', () => {
  for (const [type, sub, name] of OWN_BY_A) {
    it(`${type}/${sub || '.'}/${name}`, async () => {
      for (const q of spellings(type, sub, name)) {
        expect(await view(A, q), `A ${JSON.stringify(q)}`).toBe('served')
        expect(await view(B, q), `B ${JSON.stringify(q)}`).toBe(404)
      }
    })
  }

  it('B naming A\'s temp file under B\'s own folder reads nothing of A\'s', async () => {
    expect(await view(B, { type: 'temp', subfolder: uB, filename: 'live_preview_n_00001.png' })).toBe(404)
  })

  it('a file nobody recorded is nobody\'s: 404 to both (input and temp)', async () => {
    for (const q of [{ type: 'input', filename: 'orphan.png' }, { type: 'temp', filename: 'orphan_preview.png' }, { type: 'input', subfolder: 'sailor_depth', filename: 'secret.png' }]) {
      expect(await view(A, q), JSON.stringify(q)).toBe(404)
      expect(await view(B, q), JSON.stringify(q)).toBe(404)
    }
  })

  it('Sailor\'s public input folders stay readable to every signed-in person', async () => {
    for (const q of [
      { type: 'input', subfolder: 'sailor_textures/Wood095', filename: 'Color.jpg' },
      { type: 'input', subfolder: 'sailor_hdri', filename: 'studio_2k.hdr' },
      { type: 'input', subfolder: 'sailor_depth', filename: 'depth_0123456789abcdef.png' },
    ]) {
      expect(await view(A, q), JSON.stringify(q)).toBe('served')
      expect(await view(B, q), JSON.stringify(q)).toBe('served')
    }
  })

  it('an unknown folder type is a 400 before any read, as the resolver answers it', async () => {
    expect(await view(A, { type: 'kept', filename: 'a_photo.png' })).toBe(400)
  })

  it('signed out is 401 for every folder', async () => {
    for (const type of ['input', 'temp', 'output']) {
      let status = 0
      try { await handler({ query: { type, filename: 'a_photo.png' }, context: {} }) } catch (e: any) { status = e.statusCode }
      expect(status, type).toBe(401)
    }
  })

  it('local mode is unchanged: no owner is asked', async () => {
    mode = 'local'
    expect(await view(B, { type: 'input', filename: 'orphan.png' })).toBe('served')
    expect(await view(B, { type: 'temp', subfolder: uA, filename: 'live_preview_n_00001.png' })).toBe('served')
  })
})

describe('the other spellings of /view', () => {
  it('/api/view, /comfyui/view and /comfyui/api/view are a hosted 404 before any read', () => {
    for (const p of ['/api/view', '/comfyui/view', '/comfyui/api/view', '/api/view/', '/comfyui/view?type=input&filename=a_photo.png']) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'GET'), p).toEqual({ kind: 'notFound' })
    }
  })

  it('a server route reading a /view address (gen-3d) applies the same gate: B 404, A passes', async () => {
    for (const [type, sub, name] of OWN_BY_A) {
      const u = new URL(`/comfyui/api/view?${new URLSearchParams({ type, subfolder: sub, filename: name })}`, 'http://sailor.invalid')
      await expect(hostedViewGate(B, viewQueryOf(u.searchParams)), `${sub}/${name}`).rejects.toMatchObject({ statusCode: 404 })
      await expect(hostedViewGate(A, viewQueryOf(u.searchParams)), `${sub}/${name}`).resolves.toBeUndefined()
    }
  })
})

describe('the depth routes (assertInputOwned) follow the same rule', () => {
  const ev = (userId: string) => ({ context: { userId } }) as any
  it('A\'s input, temp and output: A passes, B 404', async () => {
    for (const [type, sub, name] of OWN_BY_A) {
      const t = type as 'input' | 'temp' | 'output'
      await expect(assertInputOwned(ev(A), t, sub, name), `A ${type}/${sub}/${name}`).resolves.toBeUndefined()
      await expect(assertInputOwned(ev(B), t, sub, name), `B ${type}/${sub}/${name}`).rejects.toMatchObject({ statusCode: 404 })
    }
  })
  it('a slash in the filename moves into the folder the check uses', async () => {
    await expect(assertInputOwned(ev(A), 'input', '', 'pasted/a_paste.png')).resolves.toBeUndefined()
    await expect(assertInputOwned(ev(B), 'input', '', 'pasted/a_paste.png')).rejects.toMatchObject({ statusCode: 404 })
    await expect(assertInputOwned(ev(A), 'temp', '', `${uA}/live_preview_n_00001.png`)).resolves.toBeUndefined()
    await expect(assertInputOwned(ev(B), 'temp', '', `${uA}/live_preview_n_00001.png`)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('a file nobody recorded no longer passes', async () => {
    await expect(assertInputOwned(ev(A), 'input', '', 'orphan.png')).rejects.toMatchObject({ statusCode: 404 })
    await expect(assertInputOwned(ev(A), 'temp', '', 'orphan_preview.png')).rejects.toMatchObject({ statusCode: 404 })
  })
})
