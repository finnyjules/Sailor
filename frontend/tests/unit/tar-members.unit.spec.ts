/**
 * Step 3, LC7: the fal LoRA weights step lifts `lora.safetensors` out of a
 * Replicate `trained_model.tar` in Node (server/utils/tarMembers.ts), not
 * the repo venv's Python, so it works in the hosted image. Tars are made
 * with the system `tar` in each format it writes (pax, ustar, GNU long
 * names, gzip); then ensureFalLoraWeights runs end to end in hosted with
 * the download and the fal upload faked — no network, no Python.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { extractTarMember, listTarFiles } from '../../server/utils/tarMembers'
import { pickSafetensorsMember } from '../../server/utils/loraFalWeights'

const uploads = vi.hoisted(() => ({ got: [] as { bytes: Uint8Array, name: string }[] }))
vi.mock('../../server/utils/falStorage', () => ({
  uploadToFalStorage: async (bytes: Uint8Array, name: string) => {
    uploads.got.push({ bytes, name })
    return 'https://v3.fal.media/files/lc7/lora.safetensors'
  },
}))

let dir: string
const DEEP = 'output/flux_train_replicate/' + 'a_rather_long_folder_name_that_pushes_past_one_hundred_bytes/'.repeat(2)
const weights = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) & 255))

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lc7-tar-'))
  const src = join(dir, 'src')
  await mkdir(join(src, DEEP), { recursive: true })
  await mkdir(join(src, 'output/flux_train_replicate/captions'), { recursive: true })
  await writeFile(join(src, 'output/flux_train_replicate/config.yaml'), 'rank: 16\n')
  await writeFile(join(src, 'output/flux_train_replicate/captions/0001.txt'), '')
  await writeFile(join(src, 'output/flux_train_replicate/optimizer.safetensors'), 'not these')
  await writeFile(join(src, DEEP, 'lora.safetensors'), weights)
  const tar = (out: string, ...flags: string[]) => execFileSync('tar', [...flags, '-cf', join(dir, out), '-C', src, 'output'])
  tar('pax.tar', '--format=pax')
  tar('gnu.tar', '--format=gnutar')
  tar('plain.tar')
  tar('gz.tar.gz', '-z')
  await writeFile(join(dir, 'junk.tar'), Buffer.alloc(2048, 7))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('tarMembers', () => {
  for (const t of ['pax.tar', 'gnu.tar', 'plain.tar', 'gz.tar.gz']) {
    it(`lifts lora.safetensors out of ${t}, long path and all`, async () => {
      const out = join(dir, `${t}.out`)
      const got = await extractTarMember(join(dir, t), pickSafetensorsMember, out)
      expect(got).toEqual({ name: `${DEEP}lora.safetensors`, size: weights.length })
      expect(Buffer.compare(await readFile(out), weights)).toBe(0)
    })
  }

  it('lists regular files only', async () => {
    const names = (await listTarFiles(join(dir, 'pax.tar'))).map(f => f.name).sort()
    expect(names).toContain('output/flux_train_replicate/captions/0001.txt')
    expect(names.every(n => !n.endsWith('/'))).toBe(true)
  })

  it('answers null when nothing is picked, and throws on a file that is not a tar', async () => {
    expect(await extractTarMember(join(dir, 'plain.tar'), () => null, join(dir, 'none.out'))).toBeNull()
    await expect(listTarFiles(join(dir, 'junk.tar'))).rejects.toThrow('not a tar file')
  })
})

describe('ensureFalLoraWeights in hosted', () => {
  it('migrates the weights with no Python and records the fal URL on the sidecar', async () => {
    const saved = process.env.NUXT_CLERK_SECRET_KEY
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_hosted'
    const tarBytes = await readFile(join(dir, 'pax.tar'))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(tarBytes)) as typeof fetch
    try {
      const { ensureFalLoraWeights } = await import('../../server/utils/loraFalWeights')
      const sidecar = join(dir, 'Azure_Bloom.json')
      const meta = { name: 'Azure Bloom', trigger: 'azure_bloom', replicate_url: 'https://replicate.delivery/x/trained_model.tar' }
      await writeFile(sidecar, JSON.stringify(meta))
      const url = await ensureFalLoraWeights(sidecar, meta)
      expect(url).toBe('https://v3.fal.media/files/lc7/lora.safetensors')
      expect(uploads.got).toHaveLength(1)
      expect(uploads.got[0]!.name).toBe('Azure_Bloom.safetensors')
      expect(Buffer.compare(Buffer.from(uploads.got[0]!.bytes), weights)).toBe(0)
      expect(JSON.parse(await readFile(sidecar, 'utf8'))).toEqual({ ...meta, fal_weights_url: url })
    } finally {
      globalThis.fetch = realFetch
      if (saved === undefined) delete process.env.NUXT_CLERK_SECRET_KEY
      else process.env.NUXT_CLERK_SECRET_KEY = saved
    }
  })
})
