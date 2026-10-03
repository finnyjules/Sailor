import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setDataRootForTests } from '../../server/utils/dataRoot'
import { linkDecision, linkTrainedCharacter, type LinkDecisionInput } from '~~/server/utils/characterLink'
import { __setResourceOwnersDbForTests } from '~~/server/utils/resourceOwners'

/**
 * Pure decision logic for character-link collisions.
 * Tests the four cases: claim-draft, update-same, create new, and collision.
 */

describe('linkDecision', () => {
  it('claim-draft: matched record with loraName === null flips to ready', () => {
    const existing: LinkDecisionInput = { loraName: null }
    expect(linkDecision(existing, 'weights-v1.safetensors')).toBe('claim-draft')
  })

  it('update-same: matched record already ready with the same loraName is idempotent', () => {
    const existing: LinkDecisionInput = { loraName: 'weights-v1.safetensors' }
    expect(linkDecision(existing, 'weights-v1.safetensors')).toBe('update-same')
  })

  it('collide-new: matched record already ready with a DIFFERENT loraName creates a new record', () => {
    const existing: LinkDecisionInput = { loraName: 'weights-v1.safetensors' }
    expect(linkDecision(existing, 'weights-v2.safetensors')).toBe('collide-new')
  })

  it('create: no existing record creates a fresh one', () => {
    expect(linkDecision(null, 'weights-v1.safetensors')).toBe('create')
  })
})

// C1 — linkTrainedCharacter must claim the character record it creates for the
// training's owner, else the auto-created record lands unowned = curated =
// visible to all, editable by none (including its creator). Ownership is keyed
// by slug (the filename stem), matching characters-local.get's listOwned.
describe('linkTrainedCharacter — records character ownership (hosted)', () => {
  const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
  const savedClerk = process.env[CLERK_KEY]
  let tmp: string
  let cwd: string
  let owners: Map<string, string>
  let queryMock: ReturnType<typeof vi.fn>

  beforeAll(() => { cwd = process.cwd() })
  afterAll(() => { process.chdir(cwd) })

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'charlink-'))
    await fs.mkdir(path.join(tmp, 'library', 'characters'), { recursive: true })
    await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
    process.chdir(path.join(tmp, 'frontend'))
    __setDataRootForTests(tmp) // C1: the data root, not the folder above cwd
    owners = new Map<string, string>()
    queryMock = vi.fn(async (sql: string, params: any[] = []) => {
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
      return { rows: [] }
    })
    __setResourceOwnersDbForTests({ query: queryMock })
  })
  afterEach(async () => {
    process.chdir(cwd)
    await fs.rm(tmp, { recursive: true, force: true })
    __setResourceOwnersDbForTests(null)
    if (savedClerk === undefined) delete process.env[CLERK_KEY]
    else process.env[CLERK_KEY] = savedClerk
  })

  it('hosted: creating a fresh record claims it for ownerUserId', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    await linkTrainedCharacter({ displayName: 'Millie', weightsFilename: 'millie.safetensors', trigger: 'MIL', ownerUserId: 'u_owner' })
    const charsDir = path.join(tmp, 'library', 'characters')
    await fs.access(path.join(charsDir, 'millie.json'))
    expect(owners.get('character:millie')).toBe('u_owner')
  })

  it('local mode: no ownership row written', async () => {
    delete process.env[CLERK_KEY]
    await linkTrainedCharacter({ displayName: 'Local Char', weightsFilename: 'lc.safetensors', trigger: null, ownerUserId: 'u_owner' })
    expect(owners.size).toBe(0)
  })

  it('hosted with unknown owner: creates the record but records nothing', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    await linkTrainedCharacter({ displayName: 'Orphan', weightsFilename: 'orphan.safetensors', trigger: null, ownerUserId: null })
    const charsDir = path.join(tmp, 'library', 'characters')
    await fs.access(path.join(charsDir, 'orphan.json'))
    expect(owners.size).toBe(0)
  })
})

// Cross-tenant character-record hijack guard (independent security review,
// Stage 6). linkTrainedCharacter matches by slugified displayName against the
// SHARED library/characters dir. A claim-draft/update-same decision on a record
// OWNED BY A DIFFERENT USER must NOT overwrite the victim's on-disk record
// (which is what characters-local.get renders and the LoRA dispatch reads) —
// otherwise attacker A repoints victim V's character at A's LoRA and drains V's
// wallet. Hosted mode: downgrade to collide-new (safe new record for the
// caller). Local mode: byte-identical to today (no ownership, single user).
describe('linkTrainedCharacter — cross-tenant hijack guard', () => {
  const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
  const savedClerk = process.env[CLERK_KEY]
  let tmp: string
  let cwd: string
  let charsDir: string
  let owners: Map<string, string>
  let queryMock: ReturnType<typeof vi.fn>

  beforeAll(() => { cwd = process.cwd() })
  afterAll(() => { process.chdir(cwd) })

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'charlink-hijack-'))
    charsDir = path.join(tmp, 'library', 'characters')
    await fs.mkdir(charsDir, { recursive: true })
    await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
    process.chdir(path.join(tmp, 'frontend'))
    __setDataRootForTests(tmp) // C1: the data root, not the folder above cwd
    owners = new Map<string, string>()
    queryMock = vi.fn(async (sql: string, params: any[] = []) => {
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
      return { rows: [] }
    })
    __setResourceOwnersDbForTests({ query: queryMock })
  })
  afterEach(async () => {
    process.chdir(cwd)
    await fs.rm(tmp, { recursive: true, force: true })
    __setResourceOwnersDbForTests(null)
    if (savedClerk === undefined) delete process.env[CLERK_KEY]
    else process.env[CLERK_KEY] = savedClerk
  })

  // Write a victim character record straight to disk, owned by u_victim.
  async function seedVictim(slug: string, loraName: string | null): Promise<string> {
    const rec = {
      name: 'Victim Hero',
      slug,
      states: [{ id: 'default', label: 'Default', prompt: '', refs: [] }],
      loraName,
      trigger: 'VICTIM',
      bodyShape: null,
      notes: '',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }
    const raw = JSON.stringify(rec, null, 2)
    await fs.writeFile(path.join(charsDir, `${slug}.json`), raw)
    owners.set(`character:${slug}`, 'u_victim')
    return raw
  }

  it('hosted claim-draft on another user’s record: victim record UNCHANGED, new de-collided record owned by caller', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    // Victim owns a DRAFT (loraName null) named "Victim Hero" → slug victim-hero.
    const before = await seedVictim('victim-hero', null)

    await linkTrainedCharacter({ displayName: 'Victim Hero', weightsFilename: 'attacker.safetensors', trigger: 'ATTACKER', ownerUserId: 'u_attacker' })

    // Victim's on-disk record is byte-for-byte unchanged (still their draft).
    const after = await fs.readFile(path.join(charsDir, 'victim-hero.json'), 'utf8')
    expect(after).toBe(before)
    // Victim keeps their ownership row.
    expect(owners.get('character:victim-hero')).toBe('u_victim')
    // A NEW de-collided record was created and claimed by the attacker.
    await fs.access(path.join(charsDir, 'victim-hero-2.json'))
    const created = JSON.parse(await fs.readFile(path.join(charsDir, 'victim-hero-2.json'), 'utf8'))
    expect(created.loraName).toBe('attacker.safetensors')
    expect(owners.get('character:victim-hero-2')).toBe('u_attacker')
  })

  it('hosted update-same on another user’s READY record (loraName matches): victim record UNCHANGED, new record for caller', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    // Victim owns a READY record whose loraName happens to equal the attacker's.
    const before = await seedVictim('victim-hero', 'shared.safetensors')

    await linkTrainedCharacter({ displayName: 'Victim Hero', weightsFilename: 'shared.safetensors', trigger: 'ATTACKER', ownerUserId: 'u_attacker' })

    const after = await fs.readFile(path.join(charsDir, 'victim-hero.json'), 'utf8')
    expect(after).toBe(before)
    expect(owners.get('character:victim-hero')).toBe('u_victim')
    await fs.access(path.join(charsDir, 'victim-hero-2.json'))
    expect(owners.get('character:victim-hero-2')).toBe('u_attacker')
  })

  it('hosted claim-draft on the CALLER’s OWN record: claim proceeds as today', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    await seedVictim('victim-hero', null)
    owners.set('character:victim-hero', 'u_attacker') // caller owns it

    await linkTrainedCharacter({ displayName: 'Victim Hero', weightsFilename: 'attacker.safetensors', trigger: 'ATTACKER', ownerUserId: 'u_attacker' })

    // Own record is updated in place — no de-collided duplicate.
    const rec = JSON.parse(await fs.readFile(path.join(charsDir, 'victim-hero.json'), 'utf8'))
    expect(rec.loraName).toBe('attacker.safetensors')
    await expect(fs.access(path.join(charsDir, 'victim-hero-2.json'))).rejects.toThrow()
  })

  it('hosted claim-draft on an UNOWNED (curated/legacy) record: claim proceeds as today', async () => {
    process.env[CLERK_KEY] = 'sk_test_hosted'
    await seedVictim('victim-hero', null)
    owners.delete('character:victim-hero') // no owner row → curated/legacy

    await linkTrainedCharacter({ displayName: 'Victim Hero', weightsFilename: 'caller.safetensors', trigger: 'CALLER', ownerUserId: 'u_caller' })

    const rec = JSON.parse(await fs.readFile(path.join(charsDir, 'victim-hero.json'), 'utf8'))
    expect(rec.loraName).toBe('caller.safetensors')
    expect(owners.get('character:victim-hero')).toBe('u_caller')
    await expect(fs.access(path.join(charsDir, 'victim-hero-2.json'))).rejects.toThrow()
  })

  it('local mode: byte-identical claim-draft (no ownerOf lookup at all)', async () => {
    delete process.env[CLERK_KEY]
    await seedVictim('victim-hero', null)
    // Even though a stale owner row exists in the map, local mode must ignore it.
    owners.set('character:victim-hero', 'u_victim')
    queryMock.mockClear()

    await linkTrainedCharacter({ displayName: 'Victim Hero', weightsFilename: 'local.safetensors', trigger: 'LOCAL', ownerUserId: 'u_caller' })

    // Current (pre-fix) local behavior: claim-draft overwrites in place.
    const rec = JSON.parse(await fs.readFile(path.join(charsDir, 'victim-hero.json'), 'utf8'))
    expect(rec.loraName).toBe('local.safetensors')
    await expect(fs.access(path.join(charsDir, 'victim-hero-2.json'))).rejects.toThrow()
    // No DB touched in local mode — neither the ownerOf SELECT nor a claim INSERT.
    expect(queryMock).not.toHaveBeenCalled()
  })
})
