import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetRateLimits, assertRateLimit, clientAddress, rateLimitKey, takeToken } from '../../server/lib/rateLimit'

describe('takeToken', () => {
  beforeEach(() => _resetRateLimits())

  it('allows up to max calls in a window', () => {
    for (let i = 0; i < 5; i++) expect(takeToken('a', 5, 60_000, 1_000)).toBe(true)
    expect(takeToken('a', 5, 60_000, 1_000)).toBe(false)
  })
  it('resets after the window elapses', () => {
    for (let i = 0; i < 5; i++) takeToken('a', 5, 60_000, 1_000)
    expect(takeToken('a', 5, 60_000, 1_000)).toBe(false)
    expect(takeToken('a', 5, 60_000, 62_000)).toBe(true)
  })
  it('tracks keys independently', () => {
    for (let i = 0; i < 5; i++) takeToken('a', 5, 60_000, 1_000)
    expect(takeToken('b', 5, 60_000, 1_000)).toBe(true)
  })
  it('honors a custom window: a 10-minute window does not reset after 60s', () => {
    for (let i = 0; i < 3; i++) expect(takeToken('c', 3, 600_000, 1_000)).toBe(true)
    expect(takeToken('c', 3, 600_000, 61_000)).toBe(false)
    expect(takeToken('c', 3, 600_000, 601_000)).toBe(true)
  })
})

describe('assertRateLimit', () => {
  beforeEach(() => {
    _resetRateLimits()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  function fakeEvent(ip = '1.2.3.4') {
    return { node: { req: { socket: { remoteAddress: ip } } } } as any
  }

  it('honors a custom windowMs parameter — a 10-minute window stays exhausted past 60s', () => {
    const event = fakeEvent()
    for (let i = 0; i < 3; i++) assertRateLimit(event, 'training-tier', 3, 600_000)
    // Past the default 60s window, but well within the custom 10-minute window: still blocked.
    vi.setSystemTime(61_000)
    expect(() => assertRateLimit(event, 'training-tier', 3, 600_000)).toThrow(/training-tier/)
    // Past the custom 10-minute window: allowed again.
    vi.setSystemTime(601_000)
    expect(() => assertRateLimit(event, 'training-tier', 3, 600_000)).not.toThrow()
  })

  it('throws a 429 with the route name in the message when exceeded', () => {
    const event = fakeEvent('9.9.9.9')
    for (let i = 0; i < 3; i++) assertRateLimit(event, 'training-tier', 3, 600_000)
    try {
      assertRateLimit(event, 'training-tier', 3, 600_000)
      throw new Error('expected assertRateLimit to throw')
    }
    catch (err: any) {
      expect(err.statusCode).toBe(429)
      expect(err.message).toMatch(/training-tier/)
    }
  })
})

describe('rate-limit keys: per person in hosted, per real client address otherwise', () => {
  const saved = { clerk: process.env.NUXT_CLERK_SECRET_KEY, fly: process.env.FLY_APP_NAME }
  beforeEach(() => {
    _resetRateLimits()
    delete process.env.NUXT_CLERK_SECRET_KEY
    delete process.env.FLY_APP_NAME
  })
  afterEach(() => {
    if (saved.clerk === undefined) delete process.env.NUXT_CLERK_SECRET_KEY
    else process.env.NUXT_CLERK_SECRET_KEY = saved.clerk
    if (saved.fly === undefined) delete process.env.FLY_APP_NAME
    else process.env.FLY_APP_NAME = saved.fly
  })
  function hostedBehindFly() {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    process.env.FLY_APP_NAME = 'sailor'
  }
  /** The socket address is Fly's proxy in hosted; headers as node lower-cases them. */
  function ev(opts: { socket?: string, headers?: Record<string, string>, userId?: string } = {}) {
    return {
      node: { req: { socket: { remoteAddress: opts.socket ?? '172.16.0.1' }, headers: opts.headers ?? {} } },
      context: opts.userId ? { userId: opts.userId } : {},
    } as any
  }

  it('keys a signed-in caller by their user id, whatever address they come from', () => {
    hostedBehindFly()
    expect(rateLimitKey(ev({ userId: 'user_a', headers: { 'fly-client-ip': '5.5.5.5' } }))).toBe('user:user_a')
  })

  it('two signed-in people behind the same proxy address have their own buckets', () => {
    hostedBehindFly()
    for (let i = 0; i < 3; i++) assertRateLimit(ev({ userId: 'user_a' }), 'runs-start', 3)
    expect(() => assertRateLimit(ev({ userId: 'user_a' }), 'runs-start', 3)).toThrow(expect.objectContaining({ statusCode: 429 }))
    expect(() => assertRateLimit(ev({ userId: 'user_b' }), 'runs-start', 3)).not.toThrow()
  })

  it('hosted, signed out: keys by Fly-Client-IP, not the proxy socket', () => {
    hostedBehindFly()
    expect(clientAddress(ev({ headers: { 'fly-client-ip': '5.5.5.5' } }))).toBe('5.5.5.5')
    for (let i = 0; i < 3; i++) assertRateLimit(ev({ headers: { 'fly-client-ip': '5.5.5.5' } }), 'image-search', 3)
    expect(() => assertRateLimit(ev({ headers: { 'fly-client-ip': '5.5.5.5' } }), 'image-search', 3)).toThrow()
    // Another visitor through the same proxy socket is not locked out.
    expect(() => assertRateLimit(ev({ headers: { 'fly-client-ip': '6.6.6.6' } }), 'image-search', 3)).not.toThrow()
  })

  it('hosted without Fly-Client-IP: takes the address Fly appended (the last X-Forwarded-For entry), never the client-written first one', () => {
    hostedBehindFly()
    expect(clientAddress(ev({ headers: { 'x-forwarded-for': '1.1.1.1, 7.7.7.7' } }))).toBe('7.7.7.7')
  })

  it('locally, spoofed forwarding headers are ignored: the socket address is the key', () => {
    const spoofed = (n: number) => ev({ socket: '127.0.0.1', headers: { 'fly-client-ip': `9.9.9.${n}`, 'x-forwarded-for': `8.8.8.${n}` } })
    expect(clientAddress(spoofed(1))).toBe('127.0.0.1')
    for (let i = 0; i < 3; i++) assertRateLimit(spoofed(i), 'runs-start', 3)
    // Rotating the headers does not buy a fresh bucket.
    expect(() => assertRateLimit(spoofed(99), 'runs-start', 3)).toThrow(expect.objectContaining({ statusCode: 429 }))
  })

  it('hosted mode but not behind Fly (Clerk keys in a local .env): headers are still ignored', () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    expect(clientAddress(ev({ socket: '127.0.0.1', headers: { 'fly-client-ip': '9.9.9.9' } }))).toBe('127.0.0.1')
  })

  it('on Fly without hosted mode: headers are ignored', () => {
    process.env.FLY_APP_NAME = 'sailor'
    expect(clientAddress(ev({ socket: '127.0.0.1', headers: { 'fly-client-ip': '9.9.9.9' } }))).toBe('127.0.0.1')
  })

  it('a malformed forwarded address falls back to the socket', () => {
    hostedBehindFly()
    expect(clientAddress(ev({ headers: { 'fly-client-ip': 'not an ip' } }))).toBe('172.16.0.1')
  })
})
