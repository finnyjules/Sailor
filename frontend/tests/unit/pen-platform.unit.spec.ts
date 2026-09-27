import { describe, it, expect } from 'vitest'
import { isApplePlatform, isApple } from '~/composables/pen/penKeys'

// the Mac ctrl-click right press depends on this: Chrome's userAgentData
// reads "macOS" (lower-case m), which a case-sensitive /Mac/ missed
describe('isApplePlatform', () => {
  it('reads every Apple spelling', () => {
    for (const p of ['macOS', 'MacIntel', 'Macintosh', 'iPhone', 'iPad', 'iPod']) expect(isApplePlatform(p)).toBe(true)
  })
  it('reads other platforms and nothing as not Apple', () => {
    for (const p of ['Windows', 'Win32', 'Linux x86_64', 'Android', '', undefined, null]) expect(isApplePlatform(p)).toBe(false)
  })
})

// one check for every pen part (the overlay's ctrl-click, the menu's and the
// cards' key glyphs): userAgentData first, then navigator.platform, read when called
describe('isApple', () => {
  const nav = globalThis.navigator as any
  const had = Object.getOwnPropertyDescriptor(nav, 'userAgentData')
  const hadP = Object.getOwnPropertyDescriptor(nav, 'platform')
  function set(uad: string | undefined, platform: string) {
    Object.defineProperty(nav, 'userAgentData', { value: uad == null ? undefined : { platform: uad }, configurable: true })
    Object.defineProperty(nav, 'platform', { value: platform, configurable: true })
  }
  function restore() {
    if (had) Object.defineProperty(nav, 'userAgentData', had); else delete nav.userAgentData
    if (hadP) Object.defineProperty(nav, 'platform', hadP); else delete nav.platform
  }
  it('prefers userAgentData, falls back to navigator.platform', () => {
    try {
      set('macOS', 'Win32'); expect(isApple()).toBe(true)
      set('Windows', 'MacIntel'); expect(isApple()).toBe(false)
      set(undefined, 'MacIntel'); expect(isApple()).toBe(true)
      set(undefined, 'Linux x86_64'); expect(isApple()).toBe(false)
    } finally { restore() }
  })
})
