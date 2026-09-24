/**
 * Nested players in a Frame export (live wired layers). `nested.ts` is the bundle-safe half: how
 * the Frame player finds a nested studio player (the exported file's own map first, then the
 * app's registry), the JS that files a nested bundle under its name when bundles are
 * concatenated, and the device size a nested player renders at. `bundleNamesFor` is the app half:
 * every bundle an export needs, nested players first, the main bundle last.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  resolveNestedSurface, setNestedSurfaceLoader, nestedRegistrationJs, nestedDeviceSize,
} from '~/lib/embed/nested'
import { bundleNamesFor } from '~/lib/embed/surfaces'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects/index'
import type { EmbedSurface } from '~/lib/embed/contract'

const g = globalThis as Record<string, unknown>
const fake = (kind: string): EmbedSurface => ({ kind, caps: { alpha: true }, mount: async () => ({ setTime() {}, setSize() {}, destroy() {} }) })

afterEach(() => {
  setNestedSurfaceLoader(null)
  delete g.__SAILOR_NESTED__
  delete g.__SAILOR_SURFACE__
})

describe('resolveNestedSurface', () => {
  it('prefers the exported file\'s own map over the app loader', async () => {
    const own = fake('own')
    const loader = vi.fn(async () => fake('app'))
    setNestedSurfaceLoader(loader)
    g.__SAILOR_NESTED__ = { 'spacetype-boost': own }
    expect(await resolveNestedSurface('spacetype-boost')).toBe(own)
    expect(loader).not.toHaveBeenCalled()
  })

  it('falls back to the app loader when the map does not have it', async () => {
    const app = fake('app')
    const loader = vi.fn(async () => app)
    setNestedSurfaceLoader(loader)
    g.__SAILOR_NESTED__ = { gradient: fake('gradient') }
    expect(await resolveNestedSurface('spacetype-boost')).toBe(app)
    expect(loader).toHaveBeenCalledWith('spacetype-boost')
  })

  it('is null when neither has it', async () => {
    expect(await resolveNestedSurface('gradient')).toBeNull()
    setNestedSurfaceLoader(async () => null)
    expect(await resolveNestedSurface('gradient')).toBeNull()
  })

  it('never reads an inherited property as a player', async () => {
    g.__SAILOR_NESTED__ = {}
    expect(await resolveNestedSurface('toString')).toBeNull()
  })
})

describe('nestedRegistrationJs', () => {
  it('files the surface a bundle just assigned under its name, and clears __SAILOR_SURFACE__', () => {
    const surface = fake('spacetype')
    g.__stub = surface
    // The stub stands in for a nested IIFE bundle; the registration JS runs right after it.
    ;(0, eval)(`globalThis.__SAILOR_SURFACE__ = globalThis.__stub;${nestedRegistrationJs('spacetype-boost')}`)
    delete g.__stub
    expect((g.__SAILOR_NESTED__ as Record<string, unknown>)['spacetype-boost']).toBe(surface)
    expect(g.__SAILOR_SURFACE__).toBeUndefined()
  })

  it('keeps earlier registrations when a second bundle registers', () => {
    const a = fake('a'), b = fake('b')
    g.__a = a; g.__b = b
    ;(0, eval)(`globalThis.__SAILOR_SURFACE__ = globalThis.__a;${nestedRegistrationJs('gradient')}`
      + `globalThis.__SAILOR_SURFACE__ = globalThis.__b;${nestedRegistrationJs('spacetype-ball')}`)
    delete g.__a; delete g.__b
    expect(g.__SAILOR_NESTED__).toEqual({ gradient: a, 'spacetype-ball': b })
  })

  it('JSON-encodes the name: a quote cannot break out of the string', () => {
    const evil = 'x"];globalThis.__pwned=1;//'
    g.__SAILOR_SURFACE__ = fake('evil')
    ;(0, eval)(nestedRegistrationJs(evil))
    expect(g.__pwned).toBeUndefined()
    expect(Object.keys(g.__SAILOR_NESTED__ as object)).toEqual([evil])
  })

  it('never writes a "</script" sequence, whatever the name', () => {
    expect(nestedRegistrationJs('</script><script>x')).not.toMatch(/<\/script/i)
  })
})

describe('nestedDeviceSize', () => {
  it('keeps the source aspect at the drawn long side', () => {
    expect(nestedDeviceSize(800, 1080, 1920)).toEqual({ w: 450, h: 800 })
    expect(nestedDeviceSize(800, 1920, 1080)).toEqual({ w: 800, h: 450 })
  })

  it('clamps the long side to [64, 4096]', () => {
    expect(nestedDeviceSize(10, 1000, 500)).toEqual({ w: 64, h: 32 })
    expect(nestedDeviceSize(9000, 500, 1000)).toEqual({ w: 2048, h: 4096 })
  })

  it('never returns a zero or non-finite side', () => {
    expect(nestedDeviceSize(NaN, 100, 100)).toEqual({ w: 64, h: 64 })
    expect(nestedDeviceSize(200, 0, 0)).toEqual({ w: 200, h: 200 })
    expect(nestedDeviceSize(100, 10000, 1).h).toBe(1)
  })
})

describe('bundleNamesFor', () => {
  const effect = SPACE_TYPE_EFFECTS[0]!.id
  const live = (surface: string, config: unknown, bundle: string) =>
    ({ kind: 'live', surface, bundle, config, width: 1080, height: 1920, duration: 4 })

  it('a Frame with no live entries needs only its own bundle', () => {
    expect(bundleNamesFor('frame', { needsOutlines: false, wired: {} })).toEqual(['frame-lean'])
    expect(bundleNamesFor('frame', { needsOutlines: true, wired: { 0: { kind: 'still', dataUrl: 'data:,' } } })).toEqual(['frame'])
    expect(bundleNamesFor('frame', { needsOutlines: false })).toEqual(['frame-lean'])
  })

  it('lists each distinct live bundle once, in slot order, before the Frame\'s own', () => {
    const cfg = {
      needsOutlines: false,
      wired: {
        4: live('gradient', {}, 'gradient'),
        1: live('spacetype', { effectId: effect }, `spacetype-${effect}`),
        2: { kind: 'clip', frames: ['data:,'], fps: 1, duration: 1 },
        3: live('spacetype', { effectId: effect }, `spacetype-${effect}`),
      },
    }
    expect(bundleNamesFor('frame', cfg)).toEqual([`spacetype-${effect}`, 'gradient', 'frame-lean'])
  })

  it('throws when an entry\'s bundle is not what its config derives', () => {
    const cfg = { needsOutlines: false, wired: { 0: live('spacetype', { effectId: effect }, 'spacetype-not-it') } }
    expect(() => bundleNamesFor('frame', cfg)).toThrow()
    const gradient = { needsOutlines: false, wired: { 0: live('gradient', {}, 'shader') } }
    expect(() => bundleNamesFor('frame', gradient)).toThrow()
  })

  it('refuses a live entry that is not an embeddable studio, or is a Frame', () => {
    expect(() => bundleNamesFor('frame', { needsOutlines: false, wired: { 0: live('../x', {}, '../x') } })).toThrow()
    expect(() => bundleNamesFor('frame', { needsOutlines: false, wired: { 0: live('frame', { needsOutlines: true }, 'frame') } })).toThrow()
  })

  it('any other kind is its one bundle', () => {
    expect(bundleNamesFor('gradient', {})).toEqual(['gradient'])
    expect(bundleNamesFor('spacetype', { effectId: effect })).toEqual([`spacetype-${effect}`])
  })
})
