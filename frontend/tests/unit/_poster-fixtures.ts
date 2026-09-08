import { expect } from 'vitest'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import type { PatternContext, PosterLayerView, FrameElements } from '~/lib/frame/patterns/types'

/** 0.6em per character at font size 100 — a deterministic monospace-ish oracle. */
export const stubMeasure = (t: string) => t.length * 60

export const NOISE_LAYERS: PosterLayerView[] = [
  { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'Talks on sound and the city', fontSize: 0.03 },
  { id: 'dt', kind: 'text', text: '12–14 October 2026', fontSize: 0.03 },
  { id: 'c', kind: 'text', text: 'free entry', fontSize: 0.018 },
  { id: 'img', kind: 'image' },
  { id: 'sh', kind: 'shape', shapeId: 'circle' },
]

export function ctxFor(overrides: Partial<PatternContext> = {}): PatternContext {
  const elements: FrameElements = overrides.elements ?? inferElements(NOISE_LAYERS)
  return {
    frame: { w: 800, h: 1000 },
    grid: null,
    margin: 0.05,
    elements,
    seed: 7,
    measure: stubMeasure,
    ...overrides,
  }
}

/** Assert every op is finite and roughly on the page (off-edge crop allowed). */
export function assertSaneOps(ops: { x: number; y: number; fontSize?: number; w?: number }[]) {
  for (const op of ops) {
    expect(Number.isFinite(op.x)).toBe(true)
    expect(Number.isFinite(op.y)).toBe(true)
    expect(op.x).toBeGreaterThan(-1); expect(op.x).toBeLessThan(2)
    expect(op.y).toBeGreaterThan(-1); expect(op.y).toBeLessThan(2)
    if (op.fontSize != null) { expect(op.fontSize).toBeGreaterThan(0); expect(Number.isFinite(op.fontSize)).toBe(true) }
    if (op.w != null) { expect(op.w).toBeGreaterThan(0); expect(Number.isFinite(op.w)).toBe(true) }
  }
}
