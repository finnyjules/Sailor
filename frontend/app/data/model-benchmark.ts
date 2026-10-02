/**
 * Image model benchmark — the fixed test prompts every picker model is run
 * on, so the "Generate an image" gallery can show each model's own result
 * for the same prompt (spec: docs/superpowers/specs/2026-10-02-image-model-benchmark-design.md).
 *
 * The pictures are made once by `scripts/model-benchmark.ts` and shipped in
 * `public/model-benchmark/<prompt id>/<model id>.webp`, listed in
 * `public/model-benchmark/manifest.json`.
 *
 * A prompt's id is part of its file paths: never change it once pictures
 * exist. New wording = a new id.
 */

import type { ImageModel } from './image-models'
import type { RunnerFamily } from '../../shared/runner/families'
import { galleryEntries } from '../../shared/runner/modelMenus'

export interface BenchmarkPrompt {
  id: string
  /** What the gallery's Show menu lists. */
  label: string
  prompt: string
}

export const BENCHMARK_PROMPTS: readonly BenchmarkPrompt[] = [
  { id: 'redhead', label: 'Redhead close-up', prompt: 'A close-up portrait of a redhead woman in soft natural window light, freckles, looking just past the camera.' },
  { id: 'neon-sign', label: 'Neon sign', prompt: 'A neon shop sign on a brick wall at night that reads "OPEN LATE", glowing pink and blue.' },
  { id: 'perfume', label: 'Perfume bottle', prompt: 'A glass perfume bottle on wet black stone, studio product photo, soft reflections, dark background.' },
  { id: 'rainy-market', label: 'Rainy market', prompt: 'A busy market street in the rain at dusk, glowing stalls, umbrellas, reflections on the wet ground.' },
  { id: 'laughing-man', label: 'Older man laughing', prompt: 'An older man laughing at a café table, both hands around a coffee cup, warm afternoon light.' },
  { id: 'fox', label: 'Watercolour fox', prompt: 'A fox in a watercolour children\'s-book illustration, sitting in a meadow of wildflowers.' },
  { id: 'anime', label: 'Anime', prompt: 'An anime girl with short silver hair waiting on a train platform at sunset, wind in her hair, cel-shaded in a 90s anime style.' },
  { id: 'fashion', label: 'Fashion editorial', prompt: 'A model in an oversized red wool coat walking through a minimalist concrete courtyard, high-fashion editorial photo, hard midday shadows.' },
  { id: 'mountains', label: 'Mountain landscape', prompt: 'A vast alpine valley at golden hour, a river winding through pine forest, low clouds on the peaks, wide landscape photo.' },
  { id: 'interior', label: 'Interior', prompt: 'A sunlit Scandinavian living room with a linen sofa, oak floor, a large window and plants, architectural interior photo.' },
  { id: 'ramen', label: 'Food', prompt: 'A bowl of ramen on a dark wooden table, steam rising, soft side light, overhead food photo.' },
  { id: 'street-bw', label: 'Black-and-white film', prompt: 'A street photographer\'s black-and-white shot of a cyclist passing a rainy Paris café, 35 mm film grain.' },
]

/** Every benchmark picture is square, seed 1 where the model takes one, default settings otherwise. */
export const BENCHMARK_ASPECT_RATIO = '1:1'
export const BENCHMARK_SEED = 1
export const BENCHMARK_DIR = '/model-benchmark'

export type BenchmarkEntry =
  | { file: string, made: string }
  | { failed: string, at: string }

/** prompt id → model id → result. */
export interface BenchmarkManifest {
  version: 1
  results: Record<string, Record<string, BenchmarkEntry>>
}

export function benchmarkFile(promptId: string, modelId: string): string {
  return `${promptId}/${modelId}.webp`
}

/** The picture's URL for a prompt and model, or null when there isn't one. */
export function benchmarkPicture(manifest: BenchmarkManifest | null, promptId: string, modelId: string): string | null {
  const e = manifest?.results[promptId]?.[modelId]
  return e && 'file' in e ? `${BENCHMARK_DIR}/${e.file}` : null
}

/** Models the benchmark covers: what the image gallery shows, less the vector (SVG) models. */
export function benchmarkModels(models: readonly ImageModel[], families: ReadonlySet<RunnerFamily>): ImageModel[] {
  return galleryEntries(models, { classType: 'GenerateImageNode', families, current: null })
    .map(e => e.model)
    .filter(m => !m.tags.includes('svg'))
}

export interface BenchmarkJob { prompt: BenchmarkPrompt, model: ImageModel }

/** The jobs still to make: every prompt × model with no picture yet (a failure is retried), or all of them with `redo`. */
export function planBenchmark(
  prompts: readonly BenchmarkPrompt[],
  models: readonly ImageModel[],
  manifest: BenchmarkManifest,
  redo = false,
): BenchmarkJob[] {
  const jobs: BenchmarkJob[] = []
  for (const prompt of prompts) {
    for (const model of models) {
      const e = manifest.results[prompt.id]?.[model.id]
      if (!redo && e && 'file' in e) continue
      jobs.push({ prompt, model })
    }
  }
  return jobs
}
