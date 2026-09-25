import { describe, it, expect } from 'vitest'
import { PACKS, PACK_IMAGE_RENDER, packById, packImageCredits } from '../../server/utils/packs'
import { nodeCredits } from '../../shared/pricing/nodePrice'
import { IMAGE_MODEL_PREFERENCE } from '../../app/data/image-models'

describe('credit packs (pricing decision 2026-08-13)', () => {
  it('is exactly the decided ladder', () => {
    expect(PACKS.map(p => [p.id, p.usd, p.credits])).toEqual([
      ['starter', 10, 1000],
      ['creator', 25, 2750],
      ['studio', 60, 7200],
    ])
  })
  it('bonus arithmetic is self-consistent (1cr = $0.01 fixed, bonus on top)', () => {
    for (const p of PACKS) {
      expect(p.baseCredits).toBe(p.usd * 100)
      expect(p.bonusCredits).toBe(p.credits - p.baseCredits)
      expect(p.bonusCredits).toBeGreaterThanOrEqual(0)
    }
  })
  it('covers lines are derived from the live price book, not hand-kept', () => {
    // Starter: 1,000 cr at the image class default (16 cr) → ~60 images; the Seedance clip → ~4 clips.
    // If the book reprices either unit, these figures must move with it — the
    // assertion checks shape (both units present, counts descend the ladder).
    for (const p of PACKS) expect(p.covers).toMatch(/^Covers ~[\d,]+ image renders, or ~\d+ video clips$/)
    const images = PACKS.map(p => Number(p.covers.match(/~([\d,]+) image/)![1]!.replace(/,/g, '')))
    expect(images).toEqual([...images].sort((a, b) => a - b))
    expect(images[0]).toBeGreaterThan(0)
  })
  it('the image unit is the "Generate an image" class default at its default settings (model line-up H2)', () => {
    expect(PACK_IMAGE_RENDER).toEqual({ model: IMAGE_MODEL_PREFERENCE[0], model_options: '{}' })
    expect(packImageCredits()).toBe(nodeCredits('GenerateImageNode', { model: IMAGE_MODEL_PREFERENCE[0], model_options: '{}' }))
    // Today: Nano Banana 2 at 1K, 16 credits (was flux-dev at 5: ~200 / ~550 / ~1,440).
    expect(IMAGE_MODEL_PREFERENCE[0]).toBe('nano-banana-2')
    expect(packImageCredits()).toBe(16)
    expect(PACKS.map(p => p.covers.match(/~([\d,]+) image/)![1])).toEqual(['60', '170', '450'])
  })
  it('looks up by id and rejects unknown ids', () => {
    expect(packById('creator')?.credits).toBe(2750)
    expect(packById('mega')).toBeNull()
  })
})

// Smoke the Stripe client module: the import itself must resolve (a wrong-cwd
// install once left `stripe` uninstalled and this file unimportable), and the
// no-key path must fail loudly rather than construct a broken client.
import { getStripe, __setStripeForTests } from '../../server/utils/stripeClient'

describe('getStripe', () => {
  it('throws a clear error without STRIPE_SECRET_KEY', () => {
    __setStripeForTests(null)
    const prev = process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_SECRET_KEY
    try {
      expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY/)
    } finally {
      if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev
      __setStripeForTests(null)
    }
  })
})
