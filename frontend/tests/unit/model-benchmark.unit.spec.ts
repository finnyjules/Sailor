import { describe, expect, it } from 'vitest'
import { IMAGE_MODELS } from '~~/app/data/image-models'
import {
  BENCHMARK_PROMPTS, benchmarkFile, benchmarkModels, benchmarkPicture, planBenchmark, type BenchmarkManifest,
} from '~~/app/data/model-benchmark'
import { NO_FAMILIES, RUNNER_FAMILIES } from '#shared/runner/families'

const ALL = new Set(RUNNER_FAMILIES)

describe('the benchmark prompts', () => {
  it('have unique, path-safe ids and sentence-case labels', () => {
    const ids = BENCHMARK_PROMPTS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of BENCHMARK_PROMPTS) {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(p.prompt.trim().length, p.id).toBeGreaterThan(20)
      expect(p.label[0], p.id).toBe(p.label[0]!.toUpperCase())
      expect(p.label.slice(1), p.id).toBe(p.label.slice(1).toLowerCase())
    }
  })
})

describe('the benchmark models', () => {
  it('are the gallery\'s models less the SVG ones, and follow the family switches', () => {
    const on = benchmarkModels(IMAGE_MODELS, ALL).map(m => m.id)
    expect(on).toContain('nano-banana-2')
    expect(on).toContain('muse-image')
    expect(on).not.toContain('recraft-v4-svg')
    expect(on).not.toContain('recraft-v4-pro-svg')
    expect(on).not.toContain('imagen-4') // hidden
    expect(benchmarkModels(IMAGE_MODELS, NO_FAMILIES).map(m => m.id)).not.toContain('muse-image') // runner-only, switch off
  })
})

describe('planning a run', () => {
  const models = benchmarkModels(IMAGE_MODELS, ALL).slice(0, 3)
  const prompts = BENCHMARK_PROMPTS.slice(0, 2)
  const manifest: BenchmarkManifest = {
    version: 1,
    results: {
      [prompts[0]!.id]: {
        [models[0]!.id]: { file: benchmarkFile(prompts[0]!.id, models[0]!.id), made: '2026-10-02' },
        [models[1]!.id]: { failed: 'refused', at: '2026-10-02' },
      },
    },
  }

  it('skips pictures already made and retries failures', () => {
    const jobs = planBenchmark(prompts, models, manifest).map(j => `${j.prompt.id}/${j.model.id}`)
    expect(jobs).toHaveLength(5)
    expect(jobs).not.toContain(`${prompts[0]!.id}/${models[0]!.id}`)
    expect(jobs).toContain(`${prompts[0]!.id}/${models[1]!.id}`)
  })

  it('remakes everything with redo', () => {
    expect(planBenchmark(prompts, models, manifest, true)).toHaveLength(6)
  })

  it('gives a picture URL only for made pictures', () => {
    expect(benchmarkPicture(manifest, prompts[0]!.id, models[0]!.id)).toBe(`/model-benchmark/${prompts[0]!.id}/${models[0]!.id}.webp`)
    expect(benchmarkPicture(manifest, prompts[0]!.id, models[1]!.id)).toBeNull()
    expect(benchmarkPicture(null, prompts[0]!.id, models[0]!.id)).toBeNull()
  })
})
