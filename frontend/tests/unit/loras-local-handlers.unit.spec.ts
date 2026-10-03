import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setDataRootForTests } from '../../server/utils/dataRoot'

/**
 * Executes the /api/loras-local handlers for real against a temp library/loras
 * tree. The fs branching here — "weights present so refuse to delete", "target
 * name taken", "no hosted model ref" — is the whole substance of these routes,
 * and none of it is reachable from the pure helpers.
 *
 * The handlers rely on Nitro's auto-imports (defineEventHandler/readBody/
 * createError), which don't exist under plain vitest, so they're stubbed as
 * globals before the modules are imported. `event` is just the body object.
 */
const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event
g.createError = (opts: { statusCode: number, statusMessage: string }) => {
  const err = new Error(opts.statusMessage) as Error & { statusCode: number, statusMessage: string }
  err.statusCode = opts.statusCode
  err.statusMessage = opts.statusMessage
  return err
}

let post: any, del: any, patch: any

beforeAll(async () => {
  post = (await import('../../server/api/loras-local.post')).default
  del = (await import('../../server/api/loras-local.delete')).default
  patch = (await import('../../server/api/loras-local.patch')).default
})

const SOURCE = {
  name: 'Azure_Bloom',
  base_model: 'flux-dev',
  provider: 'replicate',
  trigger: 'azure_bloom',
  replicate_prediction_id: 'vbrs2g8e95rmw0cyj4e8qt06d0',
  replicate_model: 'finnyjules/jules-azure_bloom:161403ca8d26',
  replicate_url: 'https://replicate.delivery/xezq/abc/trained_model.tar',
  aesthetic: 'Warm botanicals against flat azure, fauvist brushwork, high contrast.',
  trained_on: '2026-06-04T05:42:25.677Z',
  kind: 'style',
}

let tmp: string
let cwd: string
let lorasDir: string

/** Status code of the error a handler threw — fails loudly if it resolved instead. */
async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run
  } catch (e: any) {
    return e.statusCode
  }
  throw new Error('expected the handler to throw, but it resolved')
}

const sidecar = async (base: string) => JSON.parse(await fs.readFile(path.join(lorasDir, `${base}.json`), 'utf8'))

beforeEach(async () => {
  cwd = process.cwd()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'loras-test-'))
  // Handlers resolve <data root>/library/loras (C6b).
  lorasDir = path.join(tmp, 'library', 'loras')
  await fs.mkdir(lorasDir, { recursive: true })
  await fs.mkdir(path.join(tmp, 'frontend'), { recursive: true })
  process.chdir(path.join(tmp, 'frontend'))
  __setDataRootForTests(tmp) // C1: the data root, not the folder above cwd

  await fs.writeFile(path.join(lorasDir, 'Azure_Bloom.json'), JSON.stringify(SOURCE), 'utf8')
  await fs.writeFile(path.join(lorasDir, 'Azure_Bloom.safetensors'), 'weights')
  await fs.writeFile(path.join(lorasDir, 'Azure_Bloom.cover.webp'), 'cover')
})

afterEach(async () => {
  process.chdir(cwd)
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('POST /api/loras-local (duplicate)', () => {
  it('writes a sidecar that runs the same weights, with no weights copied', async () => {
    const res = await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    expect(res.filename).toBe('Azure_Bloom_Noir.safetensors')

    const dup = await sidecar('Azure_Bloom_Noir')
    expect(dup.replicate_model).toBe(SOURCE.replicate_model)
    expect(dup.trigger).toBe(SOURCE.trigger)
    expect(dup.trained_on).toBe(SOURCE.trained_on)
    expect(dup.replicate_prediction_id).toBeUndefined()

    // The point of the whole approach: no second 350 MB file.
    await expect(fs.access(path.join(lorasDir, 'Azure_Bloom_Noir.safetensors'))).rejects.toThrow()
  })

  it('leaves the original untouched', async () => {
    await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    expect(await sidecar('Azure_Bloom')).toEqual(SOURCE)
  })

  it('does not inherit the cover', async () => {
    await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    await expect(fs.access(path.join(lorasDir, 'Azure_Bloom_Noir.cover.webp'))).rejects.toThrow()
  })

  it('409s when the name is taken by a sidecar or by weights', async () => {
    await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    expect(await statusOf(post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' }))).toBe(409)
    // 'Azure Bloom' kebabs onto the ORIGINAL's weights — must not overwrite them.
    expect(await statusOf(post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom' }))).toBe(409)
    expect(await fs.readFile(path.join(lorasDir, 'Azure_Bloom.safetensors'), 'utf8')).toBe('weights')
  })

  it('422s a LoRA with no hosted model ref — the copy would have nothing to run', async () => {
    const { replicate_model: _none, ...local } = SOURCE
    await fs.writeFile(path.join(lorasDir, 'Local_Only.json'), JSON.stringify(local), 'utf8')
    expect(await statusOf(post({ filename: 'Local_Only.safetensors', name: 'Local Copy' }))).toBe(422)
  })

  it('404s an unknown source, 400s a bad filename or an unusable name', async () => {
    expect(await statusOf(post({ filename: 'Nope.safetensors', name: 'X' }))).toBe(404)
    expect(await statusOf(post({ filename: '../escape.safetensors', name: 'X' }))).toBe(400)
    expect(await statusOf(post({ filename: 'Azure_Bloom.safetensors', name: '///' }))).toBe(400)
  })
})

describe('DELETE /api/loras-local', () => {
  it('refuses while trained weights are on disk', async () => {
    expect(await statusOf(del({ filename: 'Azure_Bloom.safetensors' }))).toBe(409)
    await fs.access(path.join(lorasDir, 'Azure_Bloom.json')) // sidecar survived
  })

  it('removes a duplicate and its cover', async () => {
    await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    await fs.writeFile(path.join(lorasDir, 'Azure_Bloom_Noir.cover.webp'), 'cover')

    const res = await del({ filename: 'Azure_Bloom_Noir.safetensors' })
    expect(res.ok).toBe(true)
    await expect(fs.access(path.join(lorasDir, 'Azure_Bloom_Noir.json'))).rejects.toThrow()
    await expect(fs.access(path.join(lorasDir, 'Azure_Bloom_Noir.cover.webp'))).rejects.toThrow()
    // The original is untouched.
    await fs.access(path.join(lorasDir, 'Azure_Bloom.safetensors'))
  })

  it('404s an entry that does not exist at all', async () => {
    expect(await statusOf(del({ filename: 'Ghost.safetensors' }))).toBe(404)
  })

  // The deployed server holds sidecars with no weights (inference runs on
  // Replicate), so "no weights" alone would green-light deleting a REAL style.
  it('refuses a weightless sidecar that was not created by duplication', async () => {
    await fs.writeFile(path.join(lorasDir, 'Deployed_Style.json'), JSON.stringify(SOURCE), 'utf8')
    expect(await statusOf(del({ filename: 'Deployed_Style.safetensors' }))).toBe(409)
    await fs.access(path.join(lorasDir, 'Deployed_Style.json')) // survived
  })
})

describe('PATCH /api/loras-local', () => {
  it('edits a sidecar-only duplicate (weights are not required)', async () => {
    await post({ filename: 'Azure_Bloom.safetensors', name: 'Azure Bloom Noir' })
    const res = await patch({ filename: 'Azure_Bloom_Noir.safetensors', aesthetic: 'Nocturnal, desaturated, hard shadows.' })
    expect(res.aesthetic).toBe('Nocturnal, desaturated, hard shadows.')
    expect((await sidecar('Azure_Bloom_Noir')).aesthetic).toBe('Nocturnal, desaturated, hard shadows.')
  })

  it('still 404s a base with neither weights nor sidecar', async () => {
    expect(await statusOf(patch({ filename: 'Ghost.safetensors', aesthetic: 'x' }))).toBe(404)
  })
})
