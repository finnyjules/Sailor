import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// Mock node:fs so pollLora's "does the weights file already exist / write it
// out" bookkeeping never touches the real library/loras directory (which
// path.resolve(process.cwd(), '..', 'library', 'loras') would otherwise
// resolve to when vitest's cwd is frontend/). fs.access rejecting means
// "file does not exist yet" (fileExists() -> false), which is what we want
// so downloadWeights() runs and the succeeded branch proceeds to the
// registry-link call under test.
vi.mock('node:fs', () => ({
  promises: {
    access: vi.fn(async () => { throw new Error('ENOENT') }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => undefined),
  },
}))

// Mock the registry-link helper so we can spy on how it's called without
// touching the real character registry on disk.
const linkTrainedCharacter = vi.fn(async () => undefined)
vi.mock('~~/server/utils/characterLink', () => ({
  linkTrainedCharacter: (...args: unknown[]) => linkTrainedCharacter(...args),
}))

import { createReplicateProvider } from '~~/server/utils/trainingProviders'
import { __setResourceOwnersDbForTests } from '~~/server/utils/resourceOwners'
import type { TrainingJob } from '~~/server/utils/trainingQueue'

function job(over: Partial<TrainingJob> = {}): TrainingJob {
  const ts = '2026-06-29T00:00:00.000Z'
  return {
    id: 'j1',
    kind: 'lora',
    status: 'processing',
    outputName: 'millie_v1',
    displayName: 'Millie',
    datasetUrl: 'https://replicate/files/abc',
    params: { family: 'flux' },
    trigger: 'MILLIE_TRIGGER',
    loraKind: 'character',
    replicateId: 'rep_x',
    progressPct: 90,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  }
}

/** Minimal Response-like stub for global fetch. */
function res(status: number, body: unknown = '', opts: { arrayBuffer?: boolean } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    ...opts,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  linkTrainedCharacter.mockClear()
})

describe('training finalize -> character registry link', () => {
  it('calls linkTrainedCharacter with the job displayName/trigger when a character-kind LoRA job succeeds', async () => {
    // First fetch: the Replicate training-status poll (succeeded, with an
    // output weights URL). Second fetch: downloadWeights() fetching the
    // weights file itself.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/trainings/')) {
        return res(200, {
          id: 'rep_x',
          status: 'succeeded',
          output: { weights: 'https://replicate.delivery/weights.safetensors', version: 'owner/model:abc123' },
        })
      }
      return res(200, 'binary-weights-content')
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job())

    expect(patch.status).toBe('succeeded')
    expect(linkTrainedCharacter).toHaveBeenCalledTimes(1)
    expect(linkTrainedCharacter).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Millie',
      trigger: 'MILLIE_TRIGGER',
    }))
  })

  it('does NOT call linkTrainedCharacter for a style-kind (non-character) LoRA job', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/trainings/')) {
        return res(200, {
          id: 'rep_x',
          status: 'succeeded',
          output: { weights: 'https://replicate.delivery/weights.safetensors', version: 'owner/model:abc123' },
        })
      }
      return res(200, 'binary-weights-content')
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job({ loraKind: 'style', outputName: 'style_v1', displayName: 'My Style' }))

    expect(patch.status).toBe('succeeded')
    expect(linkTrainedCharacter).not.toHaveBeenCalled()
  })
})

// C1 — the queue-path finalize must CLAIM the trained LoRA for the job's owner.
// Without this every user-trained LoRA lands unowned = curated = visible to
// every tenant (and mutable by none, including its creator). Ownership is keyed
// by the LoRA base name (the .safetensors stem = sanitize(outputName)), exactly
// the id loras-local.get lists by. Character-kind trainings also thread the
// owner into linkTrainedCharacter so the auto-created registry record is claimed.
describe('C1 — training finalize records LoRA ownership (queue path)', () => {
  const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
  const savedClerk = process.env[CLERK_KEY]
  let owners: Map<string, string>
  let query: ReturnType<typeof vi.fn>

  function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
  function setLocal(): void { delete process.env[CLERK_KEY] }

  beforeEach(() => {
    owners = new Map<string, string>()
    query = vi.fn(async (sql: string, params: any[] = []) => {
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
    __setResourceOwnersDbForTests({ query })
  })
  afterEach(() => {
    __setResourceOwnersDbForTests(null)
    if (savedClerk === undefined) delete process.env[CLERK_KEY]
    else process.env[CLERK_KEY] = savedClerk
  })

  function succeededFetch() {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/trainings/')) {
        return res(200, {
          id: 'rep_x', status: 'succeeded',
          output: { weights: 'https://replicate.delivery/weights.safetensors', version: 'owner/model:abc123' },
        })
      }
      return res(200, 'binary-weights-content')
    })
  }

  it('hosted: a successful style-kind finalize records lora ownership for the job owner', async () => {
    setHosted()
    vi.stubGlobal('fetch', succeededFetch())
    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job({ loraKind: 'style', outputName: 'my_style', displayName: 'My Style', userId: 'u_owner' }))
    expect(patch.status).toBe('succeeded')
    expect(owners.get('lora:my_style')).toBe('u_owner')
  })

  it('hosted: a character-kind finalize records lora ownership AND threads the owner into linkTrainedCharacter', async () => {
    setHosted()
    vi.stubGlobal('fetch', succeededFetch())
    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job({ userId: 'u_owner' })) // default job() is character-kind millie_v1
    expect(patch.status).toBe('succeeded')
    expect(owners.get('lora:millie_v1')).toBe('u_owner')
    expect(linkTrainedCharacter).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'u_owner' }))
  })

  it('hosted: a finalize with NO job owner (unbound) records nothing — never guesses', async () => {
    setHosted()
    vi.stubGlobal('fetch', succeededFetch())
    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job({ loraKind: 'style', outputName: 'orphan_style', displayName: 'Orphan', userId: null }))
    expect(patch.status).toBe('succeeded')
    expect(owners.has('lora:orphan_style')).toBe(false)
  })

  it('local mode: no registry write at all (byte-identical)', async () => {
    setLocal()
    vi.stubGlobal('fetch', succeededFetch())
    const provider = createReplicateProvider(() => 'tok')
    const patch = await provider.poll(job({ loraKind: 'style', outputName: 'local_style', displayName: 'Local', userId: 'u_owner' }))
    expect(patch.status).toBe('succeeded')
    expect(query).not.toHaveBeenCalled()
  })
})
