import { describe, it, expect } from 'vitest'
import { directExecutionDefault, directExecutionResolved } from '~/composables/useDirectExecutionEnabled'

// Direct execution is a beta feature and defaults OFF: only the literal
// stored string 'true' (written by the Settings toggle) enables it. Every
// other stored value — 'false', null (never set), or garbage — stays off.
describe('directExecutionDefault', () => {
  it('defaults OFF when nothing is stored', () => {
    expect(directExecutionDefault(null)).toBe(false)
  })

  it("enables only on the literal 'true'", () => {
    expect(directExecutionDefault('true')).toBe(true)
  })

  it("stays off on 'false'", () => {
    expect(directExecutionDefault('false')).toBe(false)
  })

  it('stays off on garbage / unexpected values', () => {
    expect(directExecutionDefault('1')).toBe(false)
    expect(directExecutionDefault('TRUE')).toBe(false)
    expect(directExecutionDefault('yes')).toBe(false)
    expect(directExecutionDefault('')).toBe(false)
  })
})

// Hosted mode has no reachable engine origin for the browser: the bridge/worker
// iframes are never mounted, so direct execution through the authed proxy is
// the ONLY path a run can take. The stored beta toggle must not be able to
// switch it back off.
describe('directExecutionResolved', () => {
  it('hosted forces ON regardless of the stored setting', () => {
    expect(directExecutionResolved(null, true)).toBe(true)
    expect(directExecutionResolved('false', true)).toBe(true)
    expect(directExecutionResolved('garbage', true)).toBe(true)
    expect(directExecutionResolved('true', true)).toBe(true)
  })

  it('local resolves ON too — direct execution is the only dispatch path (bridge retirement, Tier 1)', () => {
    // Was default-OFF beta in local dev, with the bridge iframe's queuePrompt as the fallback.
    // 411e392f9 removed that fallback, so the stored value no longer selects anything.
    expect(directExecutionResolved(null, false)).toBe(true)
    expect(directExecutionResolved('false', false)).toBe(true)
    expect(directExecutionResolved('garbage', false)).toBe(true)
    expect(directExecutionResolved('true', false)).toBe(true)
  })
})
