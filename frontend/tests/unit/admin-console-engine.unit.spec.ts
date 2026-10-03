/**
 * Step 3, R10.8: the operator console shows the local engine's link only
 * while the engine is up, and answers either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'

const health = vi.hoisted(() => ({ state: 'down' as 'up' | 'down' }))
vi.mock('~~/server/native/engineHealth', () => ({ engineHealth: async () => health.state, ENGINE_MAIN_PORT: 8188 }))

async function handler() {
  vi.stubGlobal('defineEventHandler', (h: unknown) => h)
  vi.stubGlobal('createError', createError)
  return (await import('~~/server/api/admin/console.get')).default as unknown as () => Promise<{ sections: { title: string; cards: { name: string; primary?: { href: string } }[] }[] }>
}

const engineLinks = (body: Awaited<ReturnType<Awaited<ReturnType<typeof handler>>>>) =>
  body.sections.flatMap(s => s.cards).filter(c => c.primary?.href.includes(':8188'))

beforeEach(() => { vi.resetModules() })
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NUXT_CLERK_SECRET_KEY
})

describe('GET /api/admin/console — the engine link', () => {
  it('engine down (nothing on its port): no engine card; the rest stands', async () => {
    health.state = 'down'
    const body = await (await handler())()
    expect(engineLinks(body)).toEqual([])
    expect(body.sections.find(s => s.title === 'Code & deploy')!.cards.map(c => c.name)).toEqual(['GitHub', 'Fly.io', 'Build dashboard'])
  })

  it('engine up: one card, under Code & deploy', async () => {
    health.state = 'up'
    const body = await (await handler())()
    expect(engineLinks(body).map(c => c.name)).toEqual(['Local engine'])
    expect(body.sections.find(s => s.title === 'Code & deploy')!.cards.at(-1)!.name).toBe('Local engine')
  })

  it('hosted: still a 404', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    await expect((await handler())()).rejects.toMatchObject({ statusCode: 404 })
  })
})
