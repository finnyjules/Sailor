import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrateEditState } from '../../shared/timeline/types'

// The golden fixtures are real EditState JSON — if the type vocabulary drifts
// (a renamed field, a new required key), this catches it from the TS side.
const fixturesDir = fileURLToPath(new URL('../fixtures/timeline', import.meta.url))

describe('golden fixtures are valid EditStates', () => {
  const files = readdirSync(fixturesDir).filter(f => f.endsWith('.json'))

  it('found the fixture files', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  for (const f of files) {
    it(`${f} migrates cleanly and declares golden frames`, () => {
      const raw = JSON.parse(readFileSync(`${fixturesDir}/${f}`, 'utf-8'))
      expect(Array.isArray(raw._golden?.frames)).toBe(true)
      expect(raw._golden.frames.length).toBeGreaterThan(0)
      const state = migrateEditState(raw)
      expect(state).not.toBeNull()
      expect(state!.total_frames).toBeGreaterThan(0)
      for (const frame of raw._golden.frames) {
        expect(frame).toBeLessThan(state!.total_frames)
      }
    })
  }
})
