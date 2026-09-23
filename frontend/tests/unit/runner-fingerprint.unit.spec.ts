import { describe, expect, it } from 'vitest'
import { canonicalJson, requestFingerprint, isReusable } from '~~/server/runner/fingerprint'

const none = () => undefined

describe('fingerprint', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}')
    expect(requestFingerprint('m', { a: 1, b: 2 }, none)).toBe(requestFingerprint('m', { b: 2, a: 1 }, none))
  })
  it('changes with the endpoint or any setting', () => {
    const base = requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 5 }, none)
    expect(requestFingerprint('fal-ai/flux-pro/v1.1', { prompt: 'x', seed: 5 }, none)).not.toBe(base)
    expect(requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 6 }, none)).not.toBe(base)
    expect(requestFingerprint('fal-ai/flux/schnell', { prompt: 'x', seed: 5, num_images: 1 }, none)).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
  it('depends on what an input picture contains, not on its upload link', () => {
    const hashes: Record<string, string> = { 'https://fal/one': 'h1', 'https://fal/two': 'h1', 'https://fal/three': 'h2' }
    const hashOf = (u: string) => hashes[u]
    const a = requestFingerprint('v', { image_url: 'https://fal/one', image_urls: ['https://fal/one'] }, hashOf)
    const b = requestFingerprint('v', { image_url: 'https://fal/two', image_urls: ['https://fal/two'] }, hashOf)
    const c = requestFingerprint('v', { image_url: 'https://fal/three', image_urls: ['https://fal/one'] }, hashOf)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
  it('reuses only requests with an explicit seed', () => {
    expect(isReusable({ prompt: 'x', seed: 12 })).toBe(true)
    expect(isReusable({ prompt: 'x' })).toBe(false)          // seed 0 → the builder left it out
    expect(isReusable({ prompt: 'x', seed: 0 })).toBe(false)
    expect(isReusable({ prompt: 'x', seed: '12' })).toBe(false)
    expect(isReusable({ prompt: 'x', seed: 1.5 })).toBe(false)
  })
})
