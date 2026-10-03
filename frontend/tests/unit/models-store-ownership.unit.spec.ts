/**
 * Stage 6 Task 5: the library stores (characters, LoRAs, voices) are per-user.
 * Drives the ACTUAL route handlers against a faked resource_owners table and a
 * temp library/ tree (the handlers resolve `<data root>/library/<store>`, so we
 * chdir into a scratch `frontend`-shaped dir — the loras-local-handlers pattern).
 *
 * The point of interest is the curated/global rule: a record with no owner row
 * (an operator-seeded curated LoRA with real weights on disk) stays visible to
 * EVERY caller and mutable by NONE. Local mode is byte-identical — zero registry
 * queries.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setDataRootForTests } from '../../server/utils/dataRoot'
import { __setResourceOwnersDbForTests } from '../../server/utils/resourceOwners'
import {
  __resetVoiceCloneOwnersForTests,
  recordVoiceCloneOwner,
} from '../../server/utils/voiceCloneOwners'
import {
  __resetMeterContextForTests,
  __setLedgerForTests,
  bindMeterContext,
} from '../../server/utils/requestMeter'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.body ?? {}
g.getQuery = (event: any) => event.query ?? {}
g.setHeader = () => {}
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? 'error') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
g.requireReplicateToken = () => 'test-replicate-token'

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK_KEY]
function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

// In-memory resource_owners table (owned-stores-routes pattern).
const owners = new Map<string, string>()
const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (/INSERT INTO resource_owners/i.test(sql)) {
    const [kind, id, uid] = params
    const k = `${kind}:${id}`
    if (!owners.has(k)) owners.set(k, uid)
    return { rows: [] }
  }
  if (/SELECT user_id FROM resource_owners/i.test(sql)) {
    const [kind, id] = params
    const v = owners.get(`${kind}:${id}`)
    return { rows: v ? [{ user_id: v }] : [] }
  }
  if (/SELECT resource_id FROM resource_owners/i.test(sql)) {
    const [kind, uid] = params
    const rows = [...owners.entries()]
      .filter(([k, u]) => k.startsWith(`${kind}:`) && u === uid)
      .map(([k]) => ({ resource_id: k.slice(kind.length + 1) }))
    return { rows }
  }
  if (/DELETE FROM resource_owners/i.test(sql)) {
    const [kind, id] = params
    owners.delete(`${kind}:${id}`)
    return { rows: [] }
  }
  return { rows: [] }
})

let tmp: string
let cwd: string
let charsDir: string, lorasDir: string, voicesDir: string
let charList: any, charPost: any, charPatch: any, charAbsorb: any
let loraList: any, loraPost: any, loraPatch: any, loraDelete: any
let coverGet: any, coverPost: any
let voiceList: any, voicePreview: any, voiceStatus: any
let cloudStatus: any

beforeAll(async () => {
  charList = (await import('../../server/api/characters-local.get')).default
  charPost = (await import('../../server/api/characters-local.post')).default
  charPatch = (await import('../../server/api/characters-local.patch')).default
  charAbsorb = (await import('../../server/api/characters-local/absorb.post')).default
  loraList = (await import('../../server/api/loras-local.get')).default
  loraPost = (await import('../../server/api/loras-local.post')).default
  loraPatch = (await import('../../server/api/loras-local.patch')).default
  loraDelete = (await import('../../server/api/loras-local.delete')).default
  coverGet = (await import('../../server/api/lora-cover.get')).default
  coverPost = (await import('../../server/api/lora-cover.post')).default
  voiceList = (await import('../../server/api/voices-local.get')).default
  voicePreview = (await import('../../server/api/voice-preview-file.get')).default
  voiceStatus = (await import('../../server/api/voice-clone/status.get')).default
  cloudStatus = (await import('../../server/api/cloud-train/status.get')).default
})
afterAll(() => { process.chdir(cwd) })

beforeEach(async () => {
  cwd = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'models-store-'))
  charsDir = path.join(tmp, 'library', 'characters')
  lorasDir = path.join(tmp, 'library', 'loras')
  voicesDir = path.join(tmp, 'library', 'voices')
  await fs.mkdir(charsDir, { recursive: true })
  await fs.mkdir(lorasDir, { recursive: true })
  await fs.mkdir(voicesDir, { recursive: true })
  await fs.mkdir(path.join(tmp, 'models', 'input'), { recursive: true })
  await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
  process.chdir(path.join(tmp, 'frontend'))
  __setDataRootForTests(tmp) // C1: the data root, not the folder above cwd
  owners.clear()
  query.mockClear()
  __setResourceOwnersDbForTests({ query })
})
afterEach(async () => {
  process.chdir(cwd)
  await fs.rm(tmp, { recursive: true, force: true })
  __setResourceOwnersDbForTests(null)
  if (savedClerk === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerk
})

// ---- fixtures ----
const STYLE = {
  name: 'Azure_Bloom', base_model: 'flux-dev', provider: 'replicate', trigger: 'azure_bloom',
  replicate_model: 'finnyjules/jules-azure_bloom:161403ca8d26',
  replicate_url: 'https://replicate.delivery/x/trained_model.tar',
  aesthetic: 'Warm botanicals against flat azure.', trained_on: '2026-06-04T05:42:25.677Z', kind: 'style',
}
async function charFile(slug: string, name: string): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(path.join(charsDir, `${slug}.json`), JSON.stringify({
    name, slug, states: [{ id: 'default', label: 'Default', refImages: [] }],
    loraName: null, trigger: null, bodyShape: null, notes: '', createdAt: now, updatedAt: now,
  }))
}
async function loraSidecar(base: string, extra: Record<string, any> = {}): Promise<void> {
  await fs.writeFile(path.join(lorasDir, `${base}.json`), JSON.stringify({ ...STYLE, name: base, ...extra }))
}
async function voiceFile(id: string, name: string): Promise<void> {
  await fs.writeFile(path.join(voicesDir, `${id}.json`), JSON.stringify({
    voice_id: id, name, model: 'speech-02-hd', provider: 'replicate', created: new Date().toISOString(),
  }))
}
function ev(opts: { body?: any, query?: any, userId?: string | null }) {
  return {
    body: opts.body, query: opts.query,
    node: { req: { socket: { remoteAddress: '10.0.0.7' } } },
    context: { userId: opts.userId ?? null },
  }
}
async function statusOf(run: Promise<unknown>): Promise<number> {
  try { await run } catch (e: any) { return e.statusCode }
  throw new Error('expected the handler to throw, but it resolved')
}

// ==================================================================
describe('local mode — byte-identical, zero registry queries', () => {
  beforeEach(setLocal)

  it('character/lora/voice lists return everything and never touch the owners db', async () => {
    await charFile('reva', 'Reva'); await charFile('vera', 'Vera')
    await loraSidecar('Azure_Bloom'); await loraSidecar('Bold_Pattern')
    await voiceFile('v_one', 'One'); await voiceFile('v_two', 'Two')

    const chars = await charList(ev({ userId: null }))
    expect(chars.characters.map((c: any) => c.slug).sort()).toEqual(['reva', 'vera'])
    const loras = await loraList(ev({ userId: null }))
    expect(loras.loras.map((l: any) => l.filename).sort())
      .toEqual(['Azure_Bloom.safetensors', 'Bold_Pattern.safetensors'])
    const voices = await voiceList(ev({ userId: null }))
    expect(voices.voices.map((v: any) => v.id).sort()).toEqual(['v_one', 'v_two'])

    expect(query).not.toHaveBeenCalled()
  })
})

// ==================================================================
describe('hosted lists — own + unowned (curated stays global)', () => {
  beforeEach(setHosted)

  it('character list is caller-owned + curated, never another user\'s', async () => {
    await charFile('curated', 'Curated')            // no owner row → global
    await charFile('mine', 'Mine'); owners.set('character:mine', 'u1')
    await charFile('theirs', 'Theirs'); owners.set('character:theirs', 'u2')
    const res = await charList(ev({ userId: 'u1' }))
    expect(res.characters.map((c: any) => c.slug).sort()).toEqual(['curated', 'mine'])
  })

  it('CURATED LoRA (unowned, real weights) is visible to ALL callers', async () => {
    await loraSidecar('Curated_Style')
    await fs.writeFile(path.join(lorasDir, 'Curated_Style.safetensors'), 'weights')
    await loraSidecar('Mine'); owners.set('lora:Mine', 'u1')
    await loraSidecar('Theirs'); owners.set('lora:Theirs', 'u2')

    const u1 = await loraList(ev({ userId: 'u1' }))
    expect(u1.loras.map((l: any) => l.filename).sort()).toEqual(['Curated_Style.safetensors', 'Mine.safetensors'])
    const u2 = await loraList(ev({ userId: 'u2' }))
    expect(u2.loras.map((l: any) => l.filename).sort()).toEqual(['Curated_Style.safetensors', 'Theirs.safetensors'])
  })

  it('voice list is caller-owned + curated, never another user\'s', async () => {
    await voiceFile('curated', 'Curated')
    await voiceFile('mine', 'Mine'); owners.set('voice:mine', 'u1')
    await voiceFile('theirs', 'Theirs'); owners.set('voice:theirs', 'u2')
    const res = await voiceList(ev({ userId: 'u1' }))
    expect(res.voices.map((v: any) => v.id).sort()).toEqual(['curated', 'mine'])
  })
})

// ==================================================================
describe('hosted mutations — ownership-guarded, curated immutable', () => {
  beforeEach(setHosted)

  it('character create claims ownership; patch on another\'s 404s (file untouched); own patch works; remove releases', async () => {
    // create
    const created = await charPost(ev({ body: { name: 'Nova' }, userId: 'u1' }))
    expect(created.slug).toBe('nova')
    expect(owners.get('character:nova')).toBe('u1')

    // another user's record — patch refused, file byte-identical
    await charFile('theirs', 'Theirs'); owners.set('character:theirs', 'u2')
    const before = await fs.readFile(path.join(charsDir, 'theirs.json'), 'utf8')
    expect(await statusOf(charPatch(ev({ body: { slug: 'theirs', notes: 'hax' }, userId: 'u1' })))).toBe(404)
    expect(await fs.readFile(path.join(charsDir, 'theirs.json'), 'utf8')).toBe(before)

    // own patch works
    await charPatch(ev({ body: { slug: 'nova', notes: 'mine now' }, userId: 'u1' }))
    expect(JSON.parse(await fs.readFile(path.join(charsDir, 'nova.json'), 'utf8')).notes).toBe('mine now')

    // remove releases the owner row + deletes the file
    await charPatch(ev({ body: { slug: 'nova', remove: true }, userId: 'u1' }))
    expect(owners.has('character:nova')).toBe(false)
    await expect(fs.access(path.join(charsDir, 'nova.json'))).rejects.toThrow()
  })

  it('absorb claims ownership for the characters it creates', async () => {
    await loraSidecar('Reva_Lora', { kind: 'character', name: 'Reva', trigger: 'reva_person' })
    await fs.writeFile(path.join(lorasDir, 'Reva_Lora.safetensors'), 'weights')
    const res = await charAbsorb(ev({ userId: 'u1' }))
    expect(res.created).toContain('reva')
    expect(owners.get('character:reva')).toBe('u1')
  })

  it('LoRA duplicate claims the new base; patch on curated/other 404s (untouched); own patch works', async () => {
    await loraSidecar('Source'); owners.set('lora:Source', 'u1')
    const dup = await loraPost(ev({ body: { filename: 'Source.safetensors', name: 'Source Noir' }, userId: 'u1' }))
    expect(dup.filename).toBe('Source_Noir.safetensors')
    expect(owners.get('lora:Source_Noir')).toBe('u1')

    // curated (unowned) LoRA — patch refused, file untouched
    await loraSidecar('Curated')
    const before = await fs.readFile(path.join(lorasDir, 'Curated.json'), 'utf8')
    expect(await statusOf(loraPatch(ev({ body: { filename: 'Curated.safetensors', name: 'Hijack' }, userId: 'u1' })))).toBe(404)
    expect(await fs.readFile(path.join(lorasDir, 'Curated.json'), 'utf8')).toBe(before)

    // another user's LoRA — patch refused
    await loraSidecar('Theirs'); owners.set('lora:Theirs', 'u2')
    expect(await statusOf(loraPatch(ev({ body: { filename: 'Theirs.safetensors', name: 'Hijack' }, userId: 'u1' })))).toBe(404)

    // own patch works
    const patched = await loraPatch(ev({ body: { filename: 'Source_Noir.safetensors', trigger: 'noir' }, userId: 'u1' }))
    expect(patched.trigger).toBe('noir')
  })

  it('LoRA duplicate refuses another tenant\'s private source (404, no sidecar written, not claimed); curated and own sources are still duplicable', async () => {
    // another user's private LoRA — source is untouched, no new sidecar lands,
    // and the attempted new base is never claimed.
    await loraSidecar('TheirSecret'); owners.set('lora:TheirSecret', 'u2')
    const beforeSource = await fs.readFile(path.join(lorasDir, 'TheirSecret.json'), 'utf8')
    expect(await statusOf(loraPost(ev({ body: { filename: 'TheirSecret.safetensors', name: 'Stolen' }, userId: 'u1' })))).toBe(404)
    expect(await fs.readFile(path.join(lorasDir, 'TheirSecret.json'), 'utf8')).toBe(beforeSource)
    await expect(fs.access(path.join(lorasDir, 'Stolen.json'))).rejects.toThrow()
    expect(owners.has('lora:Stolen')).toBe(false)

    // curated (unowned) source — duplicating is allowed
    await loraSidecar('CuratedSrc')
    const curatedDup = await loraPost(ev({ body: { filename: 'CuratedSrc.safetensors', name: 'From Curated' }, userId: 'u1' }))
    expect(curatedDup.filename).toBe('From_Curated.safetensors')
    expect(owners.get('lora:From_Curated')).toBe('u1')

    // own source — duplicating is allowed
    await loraSidecar('MineSrc'); owners.set('lora:MineSrc', 'u1')
    const ownDup = await loraPost(ev({ body: { filename: 'MineSrc.safetensors', name: 'From Mine' }, userId: 'u1' }))
    expect(ownDup.filename).toBe('From_Mine.safetensors')
    expect(owners.get('lora:From_Mine')).toBe('u1')
  })

  it('LoRA DELETE composes duplicate-only + ownership: own dup deletes, other\'s dup 404s, own real-weights refused', async () => {
    // own duplicate (weightless sidecar with duplicate_of) → deletable
    await loraSidecar('Mine_Dup', { duplicate_of: 'Source' }); owners.set('lora:Mine_Dup', 'u1')
    const del = await loraDelete(ev({ body: { filename: 'Mine_Dup.safetensors' }, userId: 'u1' }))
    expect(del.ok).toBe(true)
    expect(owners.has('lora:Mine_Dup')).toBe(false)

    // another user's duplicate → 404, sidecar survives
    await loraSidecar('Their_Dup', { duplicate_of: 'Source' }); owners.set('lora:Their_Dup', 'u2')
    expect(await statusOf(loraDelete(ev({ body: { filename: 'Their_Dup.safetensors' }, userId: 'u1' })))).toBe(404)
    await fs.access(path.join(lorasDir, 'Their_Dup.json'))

    // own NON-duplicate with real weights → still refused by the existing rule (409)
    await loraSidecar('Mine_Real'); owners.set('lora:Mine_Real', 'u1')
    await fs.writeFile(path.join(lorasDir, 'Mine_Real.safetensors'), 'weights')
    expect(await statusOf(loraDelete(ev({ body: { filename: 'Mine_Real.safetensors' }, userId: 'u1' })))).toBe(409)
    await fs.access(path.join(lorasDir, 'Mine_Real.json'))
  })

  it('lora-cover POST is guarded by LoRA ownership — curated/other refused before any charge', async () => {
    await loraSidecar('Curated')
    expect(await statusOf(coverPost(ev({ body: { name: 'Curated.safetensors' }, userId: 'u1' })))).toBe(404)
    await loraSidecar('Theirs'); owners.set('lora:Theirs', 'u2')
    expect(await statusOf(coverPost(ev({ body: { name: 'Theirs.safetensors' }, userId: 'u1' })))).toBe(404)
  })

  it('lora-cover GET read-guards by ownership; curated cover is readable, another\'s 404s', async () => {
    await loraSidecar('Curated'); await fs.writeFile(path.join(lorasDir, 'Curated.cover.webp'), 'img')
    await loraSidecar('Theirs'); owners.set('lora:Theirs', 'u2'); await fs.writeFile(path.join(lorasDir, 'Theirs.cover.webp'), 'img')
    expect(Buffer.isBuffer(await coverGet(ev({ query: { name: 'Curated.safetensors' }, userId: 'u1' })))).toBe(true)
    expect(await statusOf(coverGet(ev({ query: { name: 'Theirs.safetensors' }, userId: 'u1' })))).toBe(404)
  })

  it('voice-preview read-guards by ownership; curated clip readable, another\'s 404s', async () => {
    await voiceFile('curated', 'Curated'); await fs.writeFile(path.join(voicesDir, 'curated.mp3'), 'clip')
    await voiceFile('theirs', 'Theirs'); owners.set('voice:theirs', 'u2'); await fs.writeFile(path.join(voicesDir, 'theirs.mp3'), 'clip')
    expect(Buffer.isBuffer(await voicePreview(ev({ query: { id: 'curated' }, userId: 'u1' })))).toBe(true)
    expect(await statusOf(voicePreview(ev({ query: { id: 'theirs' }, userId: 'u1' })))).toBe(404)
  })
})

// ==================================================================
describe('voice-clone status — durable ownership from the binding', () => {
  beforeEach(() => {
    setHosted()
    __resetMeterContextForTests()
    __resetVoiceCloneOwnersForTests()
    __setLedgerForTests({
      getAvailable: vi.fn(async () => 10_000),
      hold: vi.fn(async () => ({ ok: true, holdId: 1 })),
      settleHold: vi.fn(async () => ({ ok: true, balance: 0, settled: true })),
      releaseHold: vi.fn(async () => {}),
      debit: vi.fn(async () => ({ ok: true })),
    } as any)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __setLedgerForTests(null)
    __resetMeterContextForTests()
    __resetVoiceCloneOwnersForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function succeededFetch(voiceId: string) {
    return vi.fn(async (url: string) => {
      if (String(url).startsWith('https://api.replicate.com/v1/predictions/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ id: String(url).split('/').pop(), status: 'succeeded', output: { voice_id: voiceId, model: 'speech-02-hd' } }),
          text: async () => '',
        }
      }
      throw new Error('unexpected fetch: ' + url)
    })
  }

  it('records the binding owner when the sidecar is written', async () => {
    recordVoiceCloneOwner('pred_own', 'u_owner', { holdId: 1, credits: 450 })
    vi.stubGlobal('fetch', succeededFetch('R8_TESTVOICE'))
    bindMeterContext({ userId: 'u_owner' })
    const res = await voiceStatus(ev({ query: { id: 'pred_own', name: 'My Voice' }, userId: 'u_owner' }))
    expect(res.voiceId).toBe('R8_TESTVOICE')
    await fs.access(path.join(voicesDir, 'R8_TESTVOICE.json'))
    expect(owners.get('voice:R8_TESTVOICE')).toBe('u_owner')
  })

  it('an unknown-owner clone (restart lost the binding) records NOTHING but still writes the sidecar', async () => {
    // no recordVoiceCloneOwner — the binding is gone
    vi.stubGlobal('fetch', succeededFetch('R8_ORPHAN'))
    bindMeterContext({ userId: 'u_poller' })
    const res = await voiceStatus(ev({ query: { id: 'pred_lost', name: 'Orphan' }, userId: 'u_poller' }))
    expect(res.voiceId).toBe('R8_ORPHAN')
    await fs.access(path.join(voicesDir, 'R8_ORPHAN.json'))
    expect(owners.has('voice:R8_ORPHAN')).toBe(false)
  })
})

// ==================================================================
// C1 — cloud-train direct path: the successful weights write must CLAIM the
// LoRA for the cloud-training owner (the caller the Task-3b gate already
// verified). Ownership is keyed by the .safetensors base = sanitize(outputName),
// the id loras-local.get lists by. Unknown owner (no cloud-training row) is
// already refused at the gate before any write.
describe('cloud-train status — direct-path finalize claims the trained LoRA', () => {
  beforeEach(setHosted)

  function succeededLoraFetch() {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/v1/trainings/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            id: String(url).split('/').pop(),
            status: 'succeeded',
            output: { weights: 'https://replicate.delivery/x/weights.safetensors', version: 'finnyjules/m:abc123' },
          }),
          text: async () => '',
        }
      }
      // the weights download itself
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => new ArrayBuffer(4), text: async () => '' }
    })
  }

  it('records lora ownership for the verified cloud-training owner on a successful download', async () => {
    owners.set('cloud-training:train_mine', 'u_owner')
    vi.stubGlobal('fetch', succeededLoraFetch())
    const res = await cloudStatus(ev({ query: { id: 'train_mine', outputName: 'my_lora', family: 'flux' }, userId: 'u_owner' }))
    expect(res.localFilename).toBe('my_lora.safetensors')
    await fs.access(path.join(lorasDir, 'my_lora.safetensors'))
    expect(owners.get('lora:my_lora')).toBe('u_owner')
    vi.unstubAllGlobals()
  })

  it('a non-owner is refused at the gate — no weights written, no lora claimed', async () => {
    owners.set('cloud-training:train_theirs', 'u_owner')
    const fetchMock = succeededLoraFetch()
    vi.stubGlobal('fetch', fetchMock)
    let code = 0
    try { await cloudStatus(ev({ query: { id: 'train_theirs', outputName: 'stolen', family: 'flux' }, userId: 'u_other' })) }
    catch (e: any) { code = e.statusCode }
    expect(code).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(fs.access(path.join(lorasDir, 'stolen.safetensors'))).rejects.toThrow()
    expect(owners.has('lora:stolen')).toBe(false)
    vi.unstubAllGlobals()
  })
})
