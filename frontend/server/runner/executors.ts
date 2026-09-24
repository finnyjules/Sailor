/**
 * What each runner node does, as a plan the engine carries out:
 *   provider — send a request to a provider (fal or Replicate), save what comes back
 *   pass     — hand files on (result cards, an open Gate)
 *   pause    — a closed Gate: stop this branch and show what reached it
 * Mirrors the Python nodes (GenerateImageNode, GenerateVideoNode, Gate,
 * Image, Video) closely enough that the same workflow gives the same result.
 */
import { GATE_CLASS, isLink, type ApiPrompt } from '#shared/runner/graph'
import { resolveVideoModelId } from '#shared/runner/eligibility'
import { RUNNER_IMAGE_MODELS, composeImagePrompt, imageAppFor } from './generators/image'
import { RUNNER_VIDEO_MODELS, falVideoFn } from './generators/video'
import { asInt, asText, parseJsonObject } from './generators/opts'
import { moodboardFiles, parseInputFileRef } from './inputs'
import type { OutputFile, RunnerProvider } from './types'

export type NodePlan =
  | { kind: 'provider'; provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>; media: 'image' | 'video'; prefix: string; uiFor(files: OutputFile[]): Record<string, unknown> | null }
  | { kind: 'pass'; files: OutputFile[]; ui: Record<string, unknown> | null }
  | { kind: 'pause'; files: OutputFile[] }

export interface PlanContext {
  prompt: ApiPrompt
  nodeId: string
  /** Files produced by the node a link points at. */
  filesFrom(link: [string, number]): OutputFile[]
  /** Our saved file → a link fal can fetch. */
  toUrl(file: OutputFile): Promise<string>
  /** For a Gate: this take was let through it. */
  gateOpen: boolean
}

export async function planNode(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]
  if (!node) throw new Error(`Node ${ctx.nodeId} is missing from the workflow`)
  const inputs = node.inputs ?? {}
  const linked = (name: string): OutputFile[] => {
    const v = inputs[name]
    return isLink(v) ? ctx.filesFrom(v) : []
  }
  // The first file of the linked node, or null. Python sends only the first
  // frame of an IMAGE batch (_image_tensor_to_data_url); so does the runner.
  const linkedFirstFile = (name: string): OutputFile | null => linked(name)[0] ?? null

  switch (node.class_type) {
    case 'GenerateImageNode': {
      const desc = RUNNER_IMAGE_MODELS[String(inputs.model)]
      if (!desc) throw new Error(`Unknown image model: ${String(inputs.model)}`)
      let refs: string[] | null = null
      if (desc.refsApp) {
        const urls: string[] = []
        for (const f of moodboardFiles(inputs.style_refs)) {
          try { urls.push(await ctx.toUrl(f)) }
          catch (e) { console.warn(`[runner] moodboard picture unreadable, skipping: ${f.subfolder}/${f.filename}`, e) }
        }
        refs = urls.length ? urls : null
      }
      const prompt = composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: !!refs,
      })
      const payload = desc.build({
        prompt,
        aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        seed: asInt(inputs.seed, 0),
        adv: parseJsonObject(inputs.model_options),
        refs,
      })
      return {
        kind: 'provider', provider: 'fal', endpoint: imageAppFor(desc, refs), payload, media: 'image', prefix: 'generate_image',
        uiFor: files => ({ images: files, animated: [false] }),
      }
    }

    case 'GenerateVideoNode': {
      const id = resolveVideoModelId(inputs.model)
      const desc = RUNNER_VIDEO_MODELS[id]
      if (!desc) throw new Error(`Unknown video model: ${String(inputs.model)}`)
      const first = linkedFirstFile('image')
      const image = first ? await ctx.toUrl(first) : null
      const payload = desc.build({
        prompt: asText(inputs.prompt),
        aspectRatio: asText(inputs.aspect_ratio) || '16:9',
        duration: asInt(inputs.duration, desc.defaultDuration),
        seed: asInt(inputs.seed, 0),
        image,
        adv: parseJsonObject(inputs.model_options),
      })
      const fn = falVideoFn(payload, desc.fnByMode)
      return {
        kind: 'provider', provider: 'fal', endpoint: fn ? `${desc.app}/${fn}` : desc.app, payload, media: 'video', prefix: 'generate_video',
        // GenerateVideoNode shows nothing itself; the Video card after it does.
        uiFor: () => null,
      }
    }

    case GATE_CLASS: {
      const files = linked('data_in')
      if (inputs.bypass === true || ctx.gateOpen) return { kind: 'pass', files, ui: null }
      return { kind: 'pause', files }
    }

    case 'Image': {
      let files: OutputFile[]
      if (isLink(inputs.images)) {
        files = linked('images')
        const bi = typeof inputs.batch_index === 'number' ? inputs.batch_index : -1
        if (bi >= 0 && files.length > 1) files = [files[Math.min(bi, files.length - 1)]!]
      }
      else {
        const f = parseInputFileRef(inputs.image)
        files = f ? [f] : []
      }
      return { kind: 'pass', files, ui: { images: files } }
    }

    case 'Video': {
      let files: OutputFile[]
      if (isLink(inputs.source)) files = linked('source')
      else {
        const f = parseInputFileRef(inputs.file)
        files = f ? [f] : []
      }
      return { kind: 'pass', files, ui: files.length ? { images: files, animated: [true] } : { images: [] } }
    }

    default:
      throw new Error(`The runner cannot run a ${node.class_type} node`)
  }
}
