/**
 * Step 3, R10.8: the operator console showed the local engine's link only
 * while the engine was up. Step 4, C5: there is no engine, so the console
 * never shows one, and answers without asking anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'

async function handler() {
  vi.stubGlobal('defineEventHandler', (h: unknown) => h)
  vi.stubGlobal('createError', createError)
  return (await import('~~/server/api/admin/console.get')).default as unknown as () => Promise<{ sections: { title: string; cards: { name: string; primary?: { href: string } }[] }[] }>
}

const fetchSpy = vi.fn()
beforeEach(() => {
  vi.resetModules()
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NUXT_CLERK_SECRET_KEY
})

describe('GET /api/admin/console — no engine card (C5)', () => {
  it('no engine card; the rest stands, and nothing is asked', async () => {
    const body = await (await handler())()
    expect(body.sections.flatMap(s => s.cards).map(c => c.name)).not.toContain('Local engine')
    expect(body.sections.flatMap(s => s.cards).filter(c => /127\.0\.0\.1|localhost/.test(c.primary?.href ?? ''))).toEqual([])
    expect(body.sections.find(s => s.title === 'Code & deploy')!.cards.map(c => c.name)).toEqual(['GitHub', 'Fly.io', 'Build dashboard'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hosted: still a 404', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    await expect((await handler())()).rejects.toMatchObject({ statusCode: 404 })
  })
})
