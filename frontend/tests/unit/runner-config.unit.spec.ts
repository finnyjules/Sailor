import { afterEach, describe, expect, it } from 'vitest'
import { runnerEnabled, webhookBaseUrl, RUNNER_PER_USER_LIMIT } from '~~/server/runner/config'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('runner switch', () => {
  it('is off unless NUXT_RUNNER_ENABLED is truthy', () => {
    delete process.env.NUXT_RUNNER_ENABLED
    expect(runnerEnabled()).toBe(false)
    process.env.NUXT_RUNNER_ENABLED = 'false'
    expect(runnerEnabled()).toBe(false)
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.NUXT_RUNNER_ENABLED = v
      expect(runnerEnabled()).toBe(true)
    }
  })

  it('reads the webhook base URL without a trailing slash', () => {
    delete process.env.NUXT_RUNNER_WEBHOOK_BASE_URL
    expect(webhookBaseUrl()).toBeNull()
    process.env.NUXT_RUNNER_WEBHOOK_BASE_URL = '  https://app.example.com//  '
    expect(webhookBaseUrl()).toBe('https://app.example.com')
  })

  it('limits four provider calls in flight per user', () => {
    expect(RUNNER_PER_USER_LIMIT).toBe(4)
  })
})
