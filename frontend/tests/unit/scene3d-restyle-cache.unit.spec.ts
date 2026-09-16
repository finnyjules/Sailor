import { describe, expect, it, vi } from 'vitest'
import { RESTYLE_MODELS } from '~/data/scene3d-restyle-models'
import { restyleInputHash, shouldRunRestyle } from '~/lib/scene3d/restyleCache'

const DEPTH_MODEL = RESTYLE_MODELS.find((m) => m.control === 'depth')!
const IMAGE_MODEL = RESTYLE_MODELS.find((m) => m.control === 'image')!

const BEAUTY = 'data:image/png;base64,BEAUTY'
const DEPTH = 'data:image/png;base64,DEPTH'

describe('restyleInputHash (deterministic cache key)', () => {
  it('the same inputs hash to the same key', () => {
    const a = restyleInputHash(DEPTH_MODEL, 'a bronze statue', 0.6, BEAUTY, DEPTH)
    const b = restyleInputHash(DEPTH_MODEL, 'a bronze statue', 0.6, BEAUTY, DEPTH)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it('a changed prompt, strength, model, or crop changes the key', () => {
    const base = restyleInputHash(DEPTH_MODEL, 'a bronze statue', 0.6, BEAUTY, DEPTH)
    expect(restyleInputHash(DEPTH_MODEL, 'a marble statue', 0.6, BEAUTY, DEPTH)).not.toBe(base)
    expect(restyleInputHash(DEPTH_MODEL, 'a bronze statue', 0.7, BEAUTY, DEPTH)).not.toBe(base)
    expect(restyleInputHash(IMAGE_MODEL, 'a bronze statue', 0.6, BEAUTY, DEPTH)).not.toBe(base)
    // Depth model keys on the DEPTH crop: a changed depth crop is a new key…
    expect(restyleInputHash(DEPTH_MODEL, 'a bronze statue', 0.6, BEAUTY, DEPTH + 'X')).not.toBe(base)
  })

  it('a depth-control key ignores the beauty crop; an img2img key ignores the depth crop', () => {
    // Depth model consumes the depth crop only — beauty is irrelevant to its key.
    expect(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY + 'X', DEPTH))
      .toBe(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH))
    // Img2img model consumes the beauty crop only — depth is irrelevant to its key.
    expect(restyleInputHash(IMAGE_MODEL, 'p', 0.6, BEAUTY, DEPTH + 'X'))
      .toBe(restyleInputHash(IMAGE_MODEL, 'p', 0.6, BEAUTY, DEPTH))
    // …and the beauty crop DOES change the img2img key.
    expect(restyleInputHash(IMAGE_MODEL, 'p', 0.6, BEAUTY + 'X', DEPTH))
      .not.toBe(restyleInputHash(IMAGE_MODEL, 'p', 0.6, BEAUTY, DEPTH))
  })

  it('float noise below the dial precision does not force a new key', () => {
    expect(restyleInputHash(DEPTH_MODEL, 'p', 0.6, BEAUTY, DEPTH))
      .toBe(restyleInputHash(DEPTH_MODEL, 'p', 0.6000001, BEAUTY, DEPTH))
  })
})

describe('shouldRunRestyle (double-bill guardrail)', () => {
  it('short-circuits (no fetch) when the hash matches AND the cached result is in hand', () => {
    expect(shouldRunRestyle('abc', 'abc', 'result.png', true)).toBe(false)
  })

  it('runs when the hash changed', () => {
    expect(shouldRunRestyle('def', 'abc', 'result.png', true)).toBe(true)
  })

  it('runs when there is no stored result yet (first run)', () => {
    expect(shouldRunRestyle('abc', '', '', false)).toBe(true)
  })

  it('runs when the hash matches but the texture is not cached (reload / eviction)', () => {
    expect(shouldRunRestyle('abc', 'abc', 'result.png', false)).toBe(true)
  })
})

// The lifecycle the surface implements around these helpers, exercised with a MOCKED $fetch so no
// network / fal call happens. This is the double-bill invariant in miniature: an unchanged re-run
// must not fetch; a changed one must; an error must leave the last good resultRef intact. runFal is
// never imported or reached here (this is client-side logic only).
describe('runRestyle decision (mocked $fetch — no network, no fal)', () => {
  type Treatment = { prompt: string; strength: number; model: string; resultRef: string; inputHash: string }

  // A faithful miniature of runRestyle's decide/fetch/commit shape (the component keeps the real
  // one; this proves the branch logic and that a short-circuit issues ZERO fetches).
  async function runRestyleMini(
    t: Treatment, crop: { beauty: string; depth: string }, cache: Set<string>,
    fetchImpl: (url: string, body: unknown) => Promise<{ name?: string; imageUrl?: string }>,
  ): Promise<'skipped' | 'ran' | 'error'> {
    const model = RESTYLE_MODELS.find((m) => m.id === t.model)!
    const hash = restyleInputHash(model, t.prompt, t.strength, crop.beauty, crop.depth)
    if (!shouldRunRestyle(hash, t.inputHash, t.resultRef, cache.has(t.resultRef))) return 'skipped'
    try {
      const gen = await fetchImpl('/api/scene3d/restyle', { prompt: t.prompt })
      const stored = await fetchImpl('/api/image-fetch', { url: gen.imageUrl })
      const name = stored.name!
      cache.add(name)
      t.resultRef = name
      t.inputHash = hash
      return 'ran'
    } catch {
      return 'error' // resultRef / inputHash left untouched
    }
  }

  const CROP = { beauty: BEAUTY, depth: DEPTH }

  it('an unchanged re-run issues NO fetch (no double-bill)', async () => {
    const cache = new Set<string>(['r1.png'])
    const model = DEPTH_MODEL
    const t: Treatment = {
      prompt: 'a bronze statue', strength: 0.6, model: model.id, resultRef: 'r1.png',
      inputHash: restyleInputHash(model, 'a bronze statue', 0.6, BEAUTY, DEPTH),
    }
    const fetchImpl = vi.fn(async () => ({}))
    const outcome = await runRestyleMini(t, CROP, cache, fetchImpl)
    expect(outcome).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a changed prompt issues the restyle + image-fetch pair and updates the treatment', async () => {
    const cache = new Set<string>(['r1.png'])
    const model = DEPTH_MODEL
    const t: Treatment = {
      prompt: 'a marble statue', strength: 0.6, model: model.id, resultRef: 'r1.png',
      inputHash: restyleInputHash(model, 'a bronze statue', 0.6, BEAUTY, DEPTH), // stale (old prompt)
    }
    const fetchImpl = vi.fn(async (url: string) =>
      url === '/api/scene3d/restyle' ? { imageUrl: 'https://fal.cdn/x.png' } : { name: 'r2.png' })
    const outcome = await runRestyleMini(t, CROP, cache, fetchImpl)
    expect(outcome).toBe('ran')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(t.resultRef).toBe('r2.png')
    expect(t.inputHash).toBe(restyleInputHash(model, 'a marble statue', 0.6, BEAUTY, DEPTH))
    expect(cache.has('r2.png')).toBe(true)
  })

  it('an error leaves the last good resultRef / inputHash intact', async () => {
    const cache = new Set<string>(['r1.png'])
    const model = DEPTH_MODEL
    const goodHash = restyleInputHash(model, 'a bronze statue', 0.6, BEAUTY, DEPTH)
    const t: Treatment = {
      prompt: 'a marble statue', strength: 0.6, model: model.id, resultRef: 'r1.png', inputHash: goodHash,
    }
    const fetchImpl = vi.fn(async () => { throw new Error('fal down') })
    const outcome = await runRestyleMini(t, CROP, cache, fetchImpl)
    expect(outcome).toBe('error')
    expect(t.resultRef).toBe('r1.png') // untouched
    expect(t.inputHash).toBe(goodHash) // untouched
  })
})
