/**
 * The token grammar is a LEAF. `config.ts` is imported by the node, the baker,
 * the agent adapter and every headless bake, so whatever `fontToken.ts` drags
 * in, they all pay for. It used to drag in three.js (and the 400 KB library
 * manifest with it) through `~/data/library-fonts`, which imports
 * `~/lib/scene3d/outlines` purely for a resolver side effect — invisible in the
 * source, expensive in every bundle.
 *
 * This is a runtime assertion, not a lint over import lines: `three` is mocked
 * with a factory that throws, so ANY module in the graph that reaches for it —
 * however indirectly — fails these imports.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('three', () => { throw new Error('three must not be imported by fontToken') })

describe('vector type font token module graph', () => {
  it('loads fontToken without pulling in three', async () => {
    const m = await import('~/lib/vectortype/fontToken')
    expect(typeof m.parseVtFontToken).toBe('function')
  })
  it('loads the vector type config without pulling in three', async () => {
    const m = await import('~/lib/vectortype/config')
    expect(typeof m.mergeConfig).toBe('function')
  })
})
