/**
 * Product shot (step 3, R8.1): the app's three small workflows, run on the
 * Sailor runner through useAppRun, each with its price before the run and a
 * Stop button.
 *
 * - Background: Generate an image (flux-schnell) → Save image.
 * - Cut-out (runs when a product is dropped, ruling (f)): Load image →
 *   Background remove (transparent, no soft edge, ruling (a)) → Save image.
 * - Lighting: Load image → Blend scene (Flux 2 Pro or Nano Banana) → Save
 *   image. "Keep the product exact" adds Load image → Image to mask (red) →
 *   keep_subject, on Flux Kontext Pro (the runner lays the answer under the
 *   kept region, server/runner/compositor/keep.ts).
 *
 * Each step's picture is taken from its Save image by node id
 * (PRODUCT_SHOT_SAVE), never by file name.
 *
 * With a step's families off the app says it is switched off, in both
 * places (R10.1: nothing goes to the engine).
 */
import { computed, ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { AppRunCancelled, AppRunDeclined, useAppRun } from '~/composables/useAppRun'
import type { AwaitOutputsOptions, RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The Save image node of each step: its picture is the step's result. */
export const PRODUCT_SHOT_SAVE = { background: '2', cutout: '3', shot: '5' } as const

export type BgAspect = '1:1' | '4:5' | '3:2'
/** The engines offered for a relight; Flux Kontext Pro is used only to keep the product exact. */
export type BlendEngine = 'Flux 2 Pro' | 'Nano Banana'
export const PRESERVE_MODEL = 'Flux Kontext Pro'

/** Save image's full set of widgets (Sailor's Save image takes its export settings too). */
export function saveImageInputs(images: [string, number], prefix: string) {
  return {
    images,
    filename_prefix: prefix,
    format: 'png',
    quality: 90,
    lossless_webp: false,
    png_compression: 4,
    scale: 1.0,
    max_dimension: 0,
    embed_metadata: true,
  }
}

export function buildBackgroundPrompt(o: { prompt: string, aspect: BgAspect, seed: number }): ApiPrompt {
  return {
    1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: o.prompt, aspect_ratio: o.aspect, seed: o.seed, model_options: '{}' } },
    [PRODUCT_SHOT_SAVE.background]: { class_type: 'SaveImage', inputs: saveImageInputs(['1', 0], 'product_bg') },
  }
}

/** Ruling (a): Background remove (R7.1), a see-through cut-out with no soft edge, saved. */
export function buildCutoutPrompt(filename: string): ApiPrompt {
  return {
    1: { class_type: 'LoadImage', inputs: { image: filename, upload: 'image' } },
    2: { class_type: 'BackgroundRemove', inputs: { frames: ['1', 0], output: 'transparent', edge_softness: 0 } },
    [PRODUCT_SHOT_SAVE.cutout]: { class_type: 'SaveImage', inputs: saveImageInputs(['2', 0], 'product_cutout') },
  }
}

/**
 * The relight. With a `mask` (the product kept exact) the engine is Flux
 * Kontext Pro, which edits in place, and the mask's red channel is the kept
 * region (its grey level is how much of the product is kept).
 */
export function buildBlendPrompt(o: { composite: string, mask: string | null, model: BlendEngine, prompt: string, feather: number, seed: number }): ApiPrompt {
  const p: ApiPrompt = { 1: { class_type: 'LoadImage', inputs: { image: o.composite, upload: 'image' } } }
  const blend: Record<string, unknown> = {
    model: o.mask ? PRESERVE_MODEL : o.model,
    image: ['1', 0],
    prompt: o.prompt,
    // keep_feather is required by the node's schema; it only applies with keep_subject wired.
    keep_feather: o.feather,
    seed: o.seed,
    output_format: 'png',
  }
  if (o.mask) {
    p[2] = { class_type: 'LoadImage', inputs: { image: o.mask, upload: 'image' } }
    p[3] = { class_type: 'ImageToMask', inputs: { image: ['2', 0], channel: 'red' } }
    blend.keep_subject = ['3', 0]
  }
  p[4] = { class_type: 'BlendSceneNode', inputs: blend }
  p[PRODUCT_SHOT_SAVE.shot] = { class_type: 'SaveImage', inputs: saveImageInputs(['4', 0], 'product_shot') }
  return p
}

export const PRODUCT_SHOT_WORDS = {
  background: { failed: 'The background didn’t work. Try again.', empty: 'The background finished without a picture. Try again.', slow: 'The background took too long, so it was stopped.' },
  cutout: { failed: 'The cut-out didn’t work. Try another photo.', empty: 'The cut-out finished without a picture. Try again.', slow: 'The cut-out took too long, so it was stopped.' },
  shot: { failed: 'The shot didn’t work. Try again.', empty: 'The shot finished without a picture. Try again.', slow: 'The shot took too long, so it was stopped.' },
} as const

export type ProductShotStep = 'background' | 'cutout' | 'shot'

/** Long enough for the slowest relight at the service. */
const WAIT_MS = 5 * 60_000

export interface StepResult { promptId: string, image: RunnerImage }

export function productShotViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

/**
 * One step's run: its price, Run (the step's prompt, its Save image's picture
 * by node id), Stop. `run` resolves with the picture, or null when the run
 * was stopped or declined at the cost gate; it throws plain words otherwise.
 */
export function useProductShotStep(step: ProductShotStep, o: {
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
} = {}) {
  const hosted = o.hosted ?? false
  const app = o.app ?? useAppRun({ hosted })
  const words = PRODUCT_SHOT_WORDS[step]
  const nodeId = PRODUCT_SHOT_SAVE[step]
  const running = ref(false)

  /** What shows in place of a price: a refusal's words, or "switched off". A failed check isn't a block. */
  const blocked = computed<string | null>(() => {
    if (app.declined.value) return new AppRunDeclined().message
    return app.quoteFailed.value ? null : app.refused.value
  })
  const priceText = app.priceText
  /** Run asks for the exact prompt's price itself, so a missing or failed price never leaves the button dead. */
  const canRun = computed(() => !running.value && !app.quoting.value && !blocked.value)
  const canStop = computed(() => running.value && app.running.value)

  function quote(prompt: ApiPrompt | null): Promise<void> {
    return app.quote(prompt)
  }

  async function run(prompt: ApiPrompt): Promise<StepResult | null> {
    running.value = true
    try {
      // A decline (AppRunDeclined) throws "switched off", in both places.
      const { promptId, outputs } = await app.run(prompt, [nodeId], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: words.failed, empty: words.empty, slow: words.slow },
      })
      const image = outputs[nodeId]?.images[0]
      if (!image) throw new Error(words.empty)
      return { promptId, image }
    }
    catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') return null
      throw new Error(e instanceof Error && e.message ? e.message : words.failed)
    }
    finally {
      running.value = false
    }
  }

  return {
    priceText, blocked, canRun, canStop, running, quoting: app.quoting, quoteFailed: app.quoteFailed,
    refused: app.refused, stopError: app.stopError, quote, run, stop: app.stop,
  }
}
