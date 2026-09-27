import { describe, it, expect } from 'vitest'
import { isApplePlatform } from '~/composables/pen/penKeys'

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
