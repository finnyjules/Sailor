/**
 * What each runner node does, as a plan the engine carries out:
 *   provider — send a request to a provider (fal or Replicate), save what comes back
 *   pass     — hand files on (result cards, an open Gate)
 *   pause    — a closed Gate: stop this branch and show what reached it
 *   local    — compute the picture here (the Frame render): no provider, no charge
 *   derive   — compute values here from the node's inputs (the cards): no provider, no charge
 * Mirrors the Python nodes (GenerateImageNode and GenerateVideoNode on fal or Replicate, Gate,
 * Image, Video, the fal-edit family: EditImageNode, DevelopImageNode,
 * RelightNode, BlendSceneNode, and the nano-actions family on Replicate:
 * RemoveObjectNode, TextEditNode, RecolorObjectNode, SwapBackgroundNode,
 * SwapProductNode, PersonSwap, BlendSceneNode's Nano Banana mode, and the
 * ref-edits family: GenerateFromReferencesNode, RotateCameraNode,
 * ProductShotNode, the restyle family: RestyleFromImageNode, and the frame
 * family: Compositor, fed by the LoadImage nodes the Frame editor injects;
 * and the runner-only models no Python node builds: Wan 3.0, family wan-3;
 * Hailuo H3 Max Turbo, family h3-max-turbo;
 * Gemini Omni Flash, family gemini-omni-flash;
 * Veo 3.1 Lite, family veo-3.1-lite;
 * HappyHorse 1.1, family happyhorse-1.1;
 * Grok Imagine Video 1.5, family grok-imagine-video-1.5;
 * LTX-2.5 Fast, family ltx-2.5-fast;
 * Luma Ray 3.2, family luma-ray-3.2;
 * GPT Image 2.5 in GenerateImageNode and EditImageNode, family gpt-image-2.5;
 * Qwen Image 3 in GenerateImageNode, family qwen-image-3;
 * Grok Imagine 2 in GenerateImageNode, family grok-imagine-2;
 * Ideogram 4 in GenerateImageNode, family ideogram-4;
 * Muse Image in GenerateImageNode, family muse-image;
 * Nano Banana 2 Lite in GenerateImageNode, family nano-banana-2-lite;
 * Reve 2.1 in GenerateImageNode, family reve-2.1;
 * Recraft V4.1 in GenerateImageNode, family recraft-v4.1;
 * Krea 2 Large and Medium in GenerateImageNode, family krea-2 (these two
 * also run on ComfyUI, where they are sent the same request);
 * Seedream 5 Pro in EditImageNode, family seedream-5-pro-edit;
 * RotateCameraNode on Qwen Image Edit 2511 multiple angles, family
 * qwen-2511-angles, which moves the whole node while it is on;
 * Nano Banana 2 in BlendSceneNode, family nano-banana-2-blend;
 * ProductShotNode on Bria Product Shot, family bria-product-shot, which
 * moves the whole node while it is on;
 * LipSyncNode on its sync-3 engine, family sync-3, fed by the studio's files
 * or an Audio card, which hands its own file on;
 * EnhanceVideoNode on fal's Topaz video upscale, family topaz-video, which
 * moves the whole node while it is on;
 * FixFacesNode on fal's Topaz image upscale with face enhancement, family
 * fix-faces, which moves the whole node while it is on;
 * FaceSwap on Easel's advanced face swap, family face-swap, which moves the
 * whole node while it is on)
 * closely enough that the same workflow gives the same result.
 */
import { GATE_CLASS, isLink, type ApiPrompt } from '#shared/runner/graph'
import { classUpgradeOn, resolveVideoModelId } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS, imageAppFor, nodeImagePrompt } from './generators/image'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS, falVideoFn } from './generators/video'
import { asInt, asText, parseJsonObject, pyStrip, pyTruthy } from './generators/opts'
import {
  DEVELOP_PROMPT, FLUX_2_EDIT_APP, FLUX_KONTEXT_APP, NANO_BANANA_2_EDIT_APP,
  blendInstruction, falFlux2Edit, falKontext, falNanoBananaEdit,
} from './generators/edit'
import { parseLight, relightInstruction } from './generators/relight'
import {
  NANO_BANANA_2_SLUG, NANO_BANANA_SLUG, actionPassThrough, checkActionText, personSwapInstruction,
  recolorInstruction, removeObjectInstruction, swapBackgroundInstruction, swapProductInstruction, textEditInstruction,
} from './generators/actions'
import {
  IMAGE_EDIT_MODELS, PRODUCT_SHOT_SLUG, QWEN_IMAGE_EDIT_PLUS_SLUG, REFERENCE_MODEL_IDS, REFERENCE_SLOTS,
  cameraToPhrase, imageEditCall, parseCamera, productShotInput, textSetting,
} from './generators/refEdits'
import {
  checkStyleSource, isNanoBananaRestyle, isRestyleModel, isUnreadableFile, restyleCall, structureStrengthOf,
} from './generators/restyle'
import { moodboardFiles, parseInputFileRef } from './inputs'
import { pictureSourceOf, planCompositor } from './compositor/plan'
import { planKeepSubject, type KeepHeld, type KeepHold, type KeepStep } from './compositor/keep'
import {
  FAL_FIRST_VIDEO, IMAGE_BACKUPS, NANO_BANANA_2_REPLICATE, VIDEO_BACKUPS,
  flux2ProEditOnReplicate, nanoBananaOnFal, nanoBananaOnReplicate, type ServiceCall,
} from './generators/twins'
import { RUNNER_WAN3_MODELS, isWan3Model, wan3Call } from './generators/wan3'
import { RUNNER_ONLY_FAL_VIDEO_MODELS } from './generators/h3MaxTurbo'
import { RUNNER_GEMINI_OMNI_FLASH_MODELS } from './generators/geminiOmniFlash'
import { RUNNER_VEO_31_LITE_MODELS } from './generators/veo31Lite'
import { RUNNER_HAPPYHORSE_11_MODELS } from './generators/happyHorse11'
import { RUNNER_GROK_IMAGINE_VIDEO_15_MODELS } from './generators/grokImagineVideo15'
import { LTX_25_FAST_DEFAULT_SECONDS, LTX_25_FAST_REPLICATE_SLUG, isLtx25FastModel, ltx25Fast } from './generators/ltx25Fast'
import { LUMA_RAY_32_DEFAULT_SECONDS, isLumaRay32Model, lumaRay32Call } from './generators/lumaRay32'
import { GPT_IMAGE_25_EDIT_OPTION, gptImage25Edit, gptImage25Generate, gptImage25OnReplicate, isGptImage25Model } from './generators/gptImage25'
import { isQwenImage3Model, qwenImage3Generate } from './generators/qwenImage3'
import { grokImagine2Generate, isGrokImagine2Model } from './generators/grokImagine2'
import { ideogram4Generate, ideogram4OnReplicate, isIdeogram4Model } from './generators/ideogram4'
import { isMuseImageModel, museImageGenerate } from './generators/museImage'
import { isNanoBanana2LiteModel, nanoBanana2LiteGenerate } from './generators/nanoBanana2Lite'
import { isReve21Model, reve21Generate } from './generators/reve21'
import { isRecraftV41Model, recraftV41Generate, recraftV41OnReplicate } from './generators/recraftV41'
import { isKrea2Model, krea2Generate, krea2OnReplicate } from './generators/krea2'
import { isSeedream5ProEdit, seedream5ProEdit } from './generators/seedream5ProEdit'
import { qwen2511Angles } from './generators/qwen2511Angles'
import { briaProductShot } from './generators/briaProductShot'
import { topazFixFaces } from './generators/topazImage'
import { easelFaceSwap } from './generators/easelFaceSwap'
import { sync3Lipsync, sync3NodeProblem, sync3Sources } from './generators/sync3'
import { topazVideoNodeProblem, topazVideoSource, topazVideoUpscale } from './generators/topazVideo'
import { TOPAZ_VIDEO_UNMEASURED, topazVideoPlan } from '#shared/runner/topazVideo'
import type { InputSeconds } from '#shared/pricing/clipSettings'
import { isSync3LipSync, lipSyncSyncMode } from '#shared/runner/lipSync'
import { backupInputProblem, checkRequest, seedanceReferenceProblem } from './requestRules'
import type { OutputFile, RunnerProvider, RunnerValue } from './types'
import { textCardUi } from './cards/text'
import { planScene3D, planTextMask, planTextOnPath } from './cards/bakeReplay'
import { planLoadImageCard } from './cards/loadImage'
import { planEmptyImage, planGetImageSize, planImageToMask, planTextMaskWithSource } from './cards/utilities'
import { imageCardShowingKept, planPreviewImage, planSaveImage } from './cards/saveImage'
import { planSmartLayout } from './cards/smartLayout'
import { effectSpec } from './effects/table'
import { planEffect } from './effects/plan'
import type { KeptExt } from './keptBytes'
import { filesOf } from './values'
import { OUTPUT_KINDS } from '#shared/runner/values'
import { STATIC_VALUES, staticValueOf } from '#shared/runner/staticValues'

/**
 * The same job on the other service, with its own request built to that
 * service's published schema. The engine sends it only when the first
 * service never started the job (or the send failed); it is charged once, at
 * the node's own price.
 */
export interface ProviderBackup { provider: RunnerProvider; endpoint: string; payload: Record<string, unknown> }

/** A local render's files: the picture, and the Frame's protect_mask when a node reads it (a 16-bit greyscale PNG). */
export interface LocalRender { image: Uint8Array; protectMask?: Uint8Array }

/** What a derive plan may do: read files, keep bytes for the run, save an asset or a live preview. */
export interface DeriveIO {
  read(file: OutputFile): Promise<Uint8Array>
  /** Keeps bytes for the run by their sha256 (./keptBytes.ts): not an asset. */
  keep(bytes: Uint8Array, ext: KeptExt): Promise<OutputFile>
  /**
   * Saves a result into the output folder as an asset of this run (counted as
   * the run's output), under `subfolder` when given; with `folder: 'temp'`
   * (Preview image) into temp instead, not an asset. `counter`: ResultStore.save's.
   */
  saveAsset(bytes: Uint8Array, o: { prefix: string; ext: string; subfolder?: string; folder?: 'output' | 'temp'; counter?: { prefix: string; offset: number } }): Promise<OutputFile>
  /** Saves a live preview into temp (as Python's save_live_preview(unique=True)). */
  savePreview(bytes: Uint8Array, o: { nodeId?: string }): Promise<OutputFile>
  /** Saves a picture to show in temp under its own name, overwriting (ResultStore.savePreviewAs). */
  savePreviewAs(bytes: Uint8Array, o: { filename: string }): Promise<OutputFile>
  hosted: boolean
  signal: AbortSignal
  nodeId: string
  /** The canvas workflow as sent (Save image embeds it), or null. */
  runWorkflow: unknown
  /** This take's workflow as sent (the hidden PROMPT Save image embeds): wires, not the values they carry. */
  runPrompt: ApiPrompt
}

/** What a derive plan made: each output slot's value, and what the node shows. */
export interface Derived { values: Record<number, RunnerValue>; ui: Record<string, unknown> | null }

export type NodePlan =
  | {
    kind: 'provider'; provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
    /** 'value': the answer itself is the result (text, JSON…), read by `valuesOf`; nothing is downloaded. */
    media: 'image' | 'video' | 'value'; prefix: string
    uiFor(files: OutputFile[]): Record<string, unknown> | null
    /** For media 'value': the node's values, read out of the provider's answer. */
    valuesOf?(result: unknown): Record<number, RunnerValue>
    backup?: ProviderBackup
    /**
     * Blend scene with keep_subject wired (Task F11b): the answer is laid
     * under the kept region here, after the call, and that PNG is what the
     * node saves. The request (and its price) is the same as without it.
     */
    keep?: KeepStep
  }
  | { kind: 'pass'; files: OutputFile[]; ui: Record<string, unknown> | null }
  /** A closed Gate: `values` is the value that reached it (R0.4), kept on its record so Continue hands it on. */
  | { kind: 'pause'; files: OutputFile[]; values?: Record<number, RunnerValue> }
  /** Computed on this server: `render` makes the PNG, saved as a temp live preview (as Python's save_live_preview). */
  | { kind: 'local'; render(signal?: AbortSignal): Promise<LocalRender>; uiFor(files: OutputFile[]): Record<string, unknown> | null }
  /** Computed on this server from the node's inputs (the cards, R0/R1): no provider, no charge. */
  | { kind: 'derive'; derive(io: DeriveIO): Promise<Derived> }

export interface PlanContext {
  prompt: ApiPrompt
  nodeId: string
  /** Files produced by the node a link points at. */
  filesFrom(link: [string, number]): OutputFile[]
  /** What a link reads (R0): the source's value on that slot. Absent: only files (older callers). */
  valueFrom?(link: [string, number]): RunnerValue | undefined
  /**
   * Our saved file → a link the provider can fetch: a fal storage link,
   * which Replicate fetches too (so one hand-off serves both providers).
   */
  toUrl(file: OutputFile): Promise<string>
  /** For a Gate: this take was let through it. */
  gateOpen: boolean
  /** The bytes of one of our files (a local render reads its pictures). Absent: local renders fail plainly. */
  readFile?(file: OutputFile): Promise<Uint8Array>
  /** Hosted (a shared server): local renders take the lower limits. */
  hosted?: boolean
  /**
   * The runner families switched on (the server's). Only a class moved onto
   * a newer model as a whole reads them (Rotate camera on Qwen Image Edit
   * 2511; Product shot on Bria Product Shot); absent, none.
   */
  families?: ReadonlySet<RunnerFamily>
  /**
   * The size in bytes of the input file the engine read before planning
   * (requestRules.ts linkedFileCheck: HappyHorse 1.1's first frame); absent
   * when it read none. A backup that can't take it is dropped.
   */
  inputBytes?: number
  /**
   * What the engine measured about the node's media just before planning
   * (./nodeMedia.ts): Topaz video upscale's factor is set from its video's
   * size (F23). Absent: nothing measured.
   */
  measured?: InputSeconds
  /**
   * The node's own place for bytes kept between its send and its result
   * (server/runner/heldBytes.ts): Blend scene's kept subject keeps the picture
   * it sends and the Frame's mask there (Task F11b fix round 1).
   */
  hold?: KeepHold
  /** A resumed Blend scene: the kept bytes recorded at its send (NodeRecord.keepHeld). */
  keepHeld?: KeepHeld
}

/**
 * The node's plan. A provider request no provider takes (a prompt under the
 * schema's minimum length, too many Seedance references) fails the node in
 * plain words before anything is sent (requestRules.ts).
 */
export async function planNode(ctx: PlanContext): Promise<NodePlan> {
  const plan = await planNodeRequest(ctx)
  if (plan.kind === 'provider') {
    checkRequest(plan.provider, plan.endpoint, plan.payload)
    // A backup its own service would refuse is no backup: the node runs on its first service only.
    if (plan.backup) {
      try { checkRequest(plan.backup.provider, plan.backup.endpoint, plan.backup.payload) }
      catch { delete plan.backup }
    }
    // Nor is one that can't take the measured input file (HappyHorse 1.1's picture over Replicate's 10 MB).
    if (plan.backup && backupInputProblem(plan.backup, ctx.inputBytes)) delete plan.backup
  }
  return plan
}

/**
 * A card whose every output slot is its static evaluator
 * (#shared/runner/staticValues.ts) over its inputs as planned (a wired
 * source already substituted by the engine): one implementation for the
 * start-of-run moderation and for the run itself.
 */
export function staticDerive(ctx: PlanContext, ui?: (values: Record<number, RunnerValue>) => Record<string, unknown> | null): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const slots = Object.keys(OUTPUT_KINDS[node.class_type] ?? { 0: 'text' }).map(Number)
  const values: Record<number, RunnerValue> = {}
  for (const slot of slots) {
    const v = staticValueOf(ctx.prompt, [ctx.nodeId, slot], STATIC_VALUES)
    if (!v) throw new Error(`The runner cannot work out this ${node.class_type} card`)
    values[slot] = v
  }
  return { kind: 'derive', derive: async () => ({ values, ui: ui ? ui(values) : null }) }
}

async function planNodeRequest(ctx: PlanContext): Promise<NodePlan> {
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
  // A linked picture as a link the provider (fal or Replicate) can fetch; a link that brought no file fails the node.
  const pictureUrl = async (name: string, missing: string): Promise<string> => {
    const f = linkedFirstFile(name)
    if (!f) throw new Error(missing)
    return ctx.toUrl(f)
  }
  // A widget toggle as Python reads it: missing is the node's default.
  const flag = (name: string, def: boolean): boolean => inputs[name] === undefined ? def : pyTruthy(inputs[name])
  const still = (endpoint: string, payload: Record<string, unknown>, prefix: string, provider: RunnerProvider = 'fal', backup?: ServiceCall): NodePlan => ({
    kind: 'provider', provider, endpoint, payload, media: 'image', prefix,
    uiFor: files => ({ images: files, animated: [false] }),
    ...(backup ? { backup } : {}),
  })
  /** A planned call and its backup (twins.ts), as a still-image plan. */
  const stillCall = (call: ServiceCall, prefix: string, backup?: ServiceCall): NodePlan =>
    still(call.endpoint, call.payload, prefix, call.provider, backup)
  // A nano-actions call: google/nano-banana-2 on Replicate, the pictures in
  // the node's order; fal's Nano Banana 2 edit is the backup (twins.ts).
  // Always png, except Blend scene, which has a format widget (png or jpg).
  const nanoAction = (prompt: string, imageInput: string[], prefix: string, outputFormat: 'png' | 'jpg' = 'png'): NodePlan => {
    const payload = { prompt, image_input: imageInput, resolution: '1K', output_format: outputFormat }
    return still(NANO_BANANA_2_SLUG, payload, prefix, 'replicate', nanoBananaOnFal(NANO_BANANA_2_REPLICATE, payload))
  }
  // FLUX.2 [pro] edit on fal, Replicate's FLUX.2 [pro] the backup (twins.ts).
  const flux2Edit = (payload: Record<string, unknown>, prefix: string): NodePlan =>
    still(FLUX_2_EDIT_APP, payload, prefix, 'fal', flux2ProEditOnReplicate(payload))

  // A nano-actions node Python would return early from: its picture is handed
  // on as it is. No call, no hand-off, no charge (stageEstimate holds nothing for it).
  checkActionText(node.class_type, inputs)
  const passName = actionPassThrough(node.class_type, inputs)
  if (passName) {
    const f = linkedFirstFile(passName)
    if (!f) throw new Error('There is no picture to pass on')
    return { kind: 'pass', files: [f], ui: { images: [f] } }
  }

  // Blend scene's request (its case below adds the keep_subject step).
  const planBlendScene = async (): Promise<NodePlan> => {
    const image = await pictureUrl('image', 'There is no picture to blend')
    const model = String(inputs.model)
    const prompt = pyStrip(asText(inputs.prompt)) || blendInstruction({
      unifyLighting: flag('unify_lighting', true),
      contactShadows: flag('contact_shadows', true),
      matchCameraLook: flag('match_camera_look', true),
      preserveIdentity: flag('preserve_identity', true),
    })
    const outputFormat = asText(inputs.output_format) || 'png'
    const seed = asInt(inputs.seed, 0)
    if (model === 'Flux 2 Pro') {
      return flux2Edit(falFlux2Edit({ imageUrls: [image], prompt, outputFormat, seed }), 'blend_scene')
    }
    if (model === 'Flux Kontext Pro') {
      // Kontext here gets only output_format and seed: no aspect, safety or upsampling.
      return still(FLUX_KONTEXT_APP, falKontext({ imageUrl: image, prompt, outputFormat, seed }), 'blend_scene')
    }
    if (model === 'Nano Banana') {
      // Replicate google/nano-banana with only {prompt, image_input} (nano-actions).
      return still(NANO_BANANA_SLUG, { prompt, image_input: [image] }, 'blend_scene', 'replicate')
    }
    if (model === 'Nano Banana 2') {
      // The nano actions' call (family nano-banana-2-blend): Replicate at 1K, fal the backup.
      // Replicate's Nano Banana 2 takes no seed; the format is png or jpg, as the node's widget.
      return nanoAction(prompt, [image], 'blend_scene', outputFormat === 'jpg' || outputFormat === 'jpeg' ? 'jpg' : 'png')
    }
    throw new Error(`The runner cannot blend with ${model}`)
  }

  switch (node.class_type) {
    case 'GenerateImageNode': {
      // GPT Image 2.5 (family gpt-image-2.5): fal first, the version's
      // endpoint; Replicate the backup (gptImage25.ts). No moodboard pictures.
      if (isGptImage25Model(inputs.model)) {
        const call = gptImage25Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          adv: parseJsonObject(inputs.model_options),
        })
        return stillCall(call, 'generate_image', gptImage25OnReplicate(call))
      }
      // Qwen Image 3 (family qwen-image-3): Replicate, no backup (qwenImage3.ts). No moodboard pictures.
      if (isQwenImage3Model(inputs.model)) {
        return stillCall(qwenImage3Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          seed: asInt(inputs.seed, 0),
          adv: parseJsonObject(inputs.model_options),
        }), 'generate_image')
      }
      // Grok Imagine 2 (family grok-imagine-2): Replicate, no backup (grokImagine2.ts). No moodboard pictures, no seed.
      if (isGrokImagine2Model(inputs.model)) {
        return stillCall(grokImagine2Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          adv: parseJsonObject(inputs.model_options),
        }), 'generate_image')
      }
      // Ideogram 4 (family ideogram-4): fal first; Replicate the backup for a
      // 2K picture only (ideogram4.ts). No moodboard pictures.
      if (isIdeogram4Model(inputs.model)) {
        const call = ideogram4Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          seed: asInt(inputs.seed, 0),
          adv: parseJsonObject(inputs.model_options),
        })
        return stillCall(call, 'generate_image', ideogram4OnReplicate(call) ?? undefined)
      }
      // Muse Image (family muse-image): fal, no backup (museImage.ts). No moodboard pictures, no seed.
      if (isMuseImageModel(inputs.model)) {
        return stillCall(museImageGenerate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        }), 'generate_image')
      }
      // Nano Banana 2 Lite (family nano-banana-2-lite): Replicate, no backup (nanoBanana2Lite.ts). No moodboard pictures, no seed.
      if (isNanoBanana2LiteModel(inputs.model)) {
        return stillCall(nanoBanana2LiteGenerate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        }), 'generate_image')
      }
      // Reve 2.1 (family reve-2.1): fal, no backup (reve21.ts). No moodboard pictures, no seed.
      if (isReve21Model(inputs.model)) {
        return stillCall(reve21Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        }), 'generate_image')
      }
      // Recraft V4.1 (family recraft-v4.1): fal first, Replicate the backup
      // (recraftV41.ts). No moodboard pictures, no seed.
      if (isRecraftV41Model(inputs.model)) {
        const call = recraftV41Generate({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
        })
        return stillCall(call, 'generate_image', recraftV41OnReplicate(call))
      }
      // Krea 2 Large and Medium (family krea-2): fal first, Replicate the
      // backup (krea2.ts), the request Python's _fal_krea2 sends. No
      // moodboard pictures (Python sends Krea none either).
      if (isKrea2Model(inputs.model)) {
        const call = krea2Generate({
          model: inputs.model,
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          seed: asInt(inputs.seed, 0),
          adv: parseJsonObject(inputs.model_options),
        })
        return stillCall(call, 'generate_image', krea2OnReplicate(call))
      }
      // A model that isn't one of the fal ids goes to Replicate, its Python
      // primary (family replicate-image). None of these takes moodboard
      // pictures, so style_refs is ignored, as Python's _accepts_refs does.
      const onReplicate = RUNNER_REPLICATE_IMAGE_MODELS[String(inputs.model)]
      if (!RUNNER_IMAGE_MODELS[String(inputs.model)] && onReplicate) {
        const payload = onReplicate.build({
          prompt: nodeImagePrompt(inputs),
          aspectRatio: asText(inputs.aspect_ratio) || '1:1',
          seed: asInt(inputs.seed, 0),
          adv: parseJsonObject(inputs.model_options),
          refs: null,
        })
        const backup = IMAGE_BACKUPS[String(inputs.model)]?.(payload)
        return {
          kind: 'provider', provider: 'replicate', endpoint: onReplicate.slug, payload, media: 'image', prefix: 'generate_image',
          uiFor: files => ({ images: files, animated: [false] }),
          ...(backup ? { backup } : {}),
        }
      }
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
      const prompt = nodeImagePrompt(inputs, !!refs)
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
      // Wan 3.0 (family wan-3): fal only, the endpoint by mode (wan3.ts); no backup.
      if (isWan3Model(id)) {
        const first = linkedFirstFile('image')
        const call = wan3Call(id, {
          prompt: asText(inputs.prompt),
          aspectRatio: asText(inputs.aspect_ratio) || '16:9',
          duration: asInt(inputs.duration, RUNNER_WAN3_MODELS[id].defaultDuration),
          seed: asInt(inputs.seed, 0),
          image: first ? await ctx.toUrl(first) : null,
          adv: parseJsonObject(inputs.model_options),
        })
        return {
          kind: 'provider', provider: call.provider, endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'generate_video',
          uiFor: () => null,
        }
      }
      // LTX-2.5 Fast (family ltx-2.5-fast): Replicate only, its own builder (ltx25Fast.ts); no backup.
      if (isLtx25FastModel(id)) {
        const first = linkedFirstFile('image')
        const payload = ltx25Fast({
          prompt: asText(inputs.prompt),
          aspectRatio: asText(inputs.aspect_ratio) || '16:9',
          duration: asInt(inputs.duration, LTX_25_FAST_DEFAULT_SECONDS),
          seed: asInt(inputs.seed, 0),
          image: first ? await ctx.toUrl(first) : null,
          adv: parseJsonObject(inputs.model_options),
        })
        return {
          kind: 'provider', provider: 'replicate', endpoint: LTX_25_FAST_REPLICATE_SLUG, payload, media: 'video', prefix: 'generate_video',
          uiFor: () => null,
        }
      }
      // Luma Ray 3.2 (family luma-ray-3.2): Replicate first, fal the backup for image-to-video only (lumaRay32.ts).
      if (isLumaRay32Model(id)) {
        const first = linkedFirstFile('image')
        const { call, backup } = lumaRay32Call({
          prompt: asText(inputs.prompt),
          aspectRatio: asText(inputs.aspect_ratio) || '16:9',
          duration: asInt(inputs.duration, LUMA_RAY_32_DEFAULT_SECONDS),
          seed: asInt(inputs.seed, 0),
          image: first ? await ctx.toUrl(first) : null,
          adv: parseJsonObject(inputs.model_options),
        })
        return {
          kind: 'provider', provider: call.provider, endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'generate_video',
          uiFor: () => null,
          ...(backup ? { backup } : {}),
        }
      }
      // A model that isn't one of the fal ids goes to Replicate, its Python
      // provider (family replicate-video): _run_prediction on the slug, the
      // first output URL is the clip. The first frame goes in the model's own
      // field; a text-to-video-only model ignores a linked one, as Python
      // does, so it isn't handed off at all.
      const onReplicate = RUNNER_REPLICATE_VIDEO_MODELS[id]
      if (!RUNNER_VIDEO_MODELS[id] && onReplicate) {
        const first = onReplicate.modes.includes('i2v') ? linkedFirstFile('image') : null
        const args = {
          prompt: asText(inputs.prompt),
          aspectRatio: asText(inputs.aspect_ratio) || '16:9',
          duration: asInt(inputs.duration, onReplicate.defaultDuration),
          seed: asInt(inputs.seed, 0),
          image: first ? await ctx.toUrl(first) : null,
          adv: parseJsonObject(inputs.model_options),
        }
        const payload = onReplicate.build(args)
        // Kling 3.0 and PixVerse v6 go to fal first; this Replicate request is their backup (twins.ts).
        const falFirst = FAL_FIRST_VIDEO[id]
        if (falFirst) {
          const call = falFirst(args)
          return {
            kind: 'provider', provider: 'fal', endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'generate_video',
            uiFor: () => null,
            backup: { provider: 'replicate', endpoint: onReplicate.slug, payload },
          }
        }
        return {
          kind: 'provider', provider: 'replicate', endpoint: onReplicate.slug, payload, media: 'video', prefix: 'generate_video',
          uiFor: () => null,
        }
      }
      // Hailuo H3 Max Turbo (family h3-max-turbo): H3 Max's builder on its own fal app (h3MaxTurbo.ts); no backup.
      // Gemini Omni Flash (family gemini-omni-flash): its own builder on fal (geminiOmniFlash.ts); no backup.
      // Veo 3.1 Lite (family veo-3.1-lite): Veo 3.1's builder on its own fal app (veo31Lite.ts); no backup.
      // HappyHorse 1.1 (family happyhorse-1.1): its own builder on fal, Replicate the backup (happyHorse11.ts, twins.ts VIDEO_BACKUPS).
      // Grok Imagine Video 1.5 (family grok-imagine-video-1.5): its own builder on fal, Replicate the backup for
      // image-to-video at 480p or 720p (grokImagineVideo15.ts, twins.ts VIDEO_BACKUPS).
      const desc = RUNNER_VIDEO_MODELS[id] ?? RUNNER_ONLY_FAL_VIDEO_MODELS[id] ?? RUNNER_GEMINI_OMNI_FLASH_MODELS[id] ?? RUNNER_VEO_31_LITE_MODELS[id]
        ?? RUNNER_HAPPYHORSE_11_MODELS[id] ?? RUNNER_GROK_IMAGINE_VIDEO_15_MODELS[id]
      if (!desc) throw new Error(`Unknown video model: ${String(inputs.model)}`)
      const first = linkedFirstFile('image')
      // Seedance 2.0: a first frame beside references is refused, not sent with them dropped (requestRules.ts).
      if (id === 'seedance-2.0') {
        const refused = seedanceReferenceProblem(parseJsonObject(inputs.model_options), !!first)
        if (refused) throw new Error(refused.message)
      }
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
      const backup = VIDEO_BACKUPS[id]?.(payload)
      return {
        kind: 'provider', provider: 'fal', endpoint: fn ? `${desc.app}/${fn}` : desc.app, payload, media: 'video', prefix: 'generate_video',
        // GenerateVideoNode shows nothing itself; the Video card after it does.
        uiFor: () => null,
        ...(backup ? { backup } : {}),
      }
    }

    // ── fal-edit family (nodes_replicate.py EditImageNode :2725) ──
    case 'EditImageNode': {
      const image = await pictureUrl('input_image', 'There is no picture to edit')
      const model = String(inputs.model)
      const prompt = asText(inputs.prompt)
      const outputFormat = asText(inputs.output_format) || 'png'
      const seed = asInt(inputs.seed, 0)
      if (model === 'Nano Banana 2') {
        return still(NANO_BANANA_2_EDIT_APP, falNanoBananaEdit({
          imageUrls: [image], prompt, resolution: asText(inputs.resolution) || '1K', outputFormat, seed,
        }), 'edit_image')
      }
      if (model === 'Flux 2 Pro') {
        return flux2Edit(falFlux2Edit({ imageUrls: [image], prompt, outputFormat, seed }), 'edit_image')
      }
      // GPT Image 2.5 (family gpt-image-2.5): fal's Flare edit first, Replicate the backup; no seed on either.
      if (model === GPT_IMAGE_25_EDIT_OPTION) {
        const call = gptImage25Edit({ image, prompt, outputFormat })
        return stillCall(call, 'edit_image', gptImage25OnReplicate(call))
      }
      // Seedream 5 Pro (family seedream-5-pro-edit): Replicate only, the references builder with one picture; no seed.
      if (isSeedream5ProEdit(model)) {
        return stillCall(seedream5ProEdit({
          image, prompt, resolution: inputs.resolution, aspectRatio: inputs.aspect_ratio, outputFormat: inputs.output_format,
        }), 'edit_image')
      }
      if (model === 'Flux Kontext Pro') {
        return still(FLUX_KONTEXT_APP, falKontext({
          imageUrl: image, prompt,
          aspectRatio: asText(inputs.aspect_ratio) || 'match_input_image',
          safetyTolerance: asInt(inputs.safety_tolerance, 2),
          enhancePrompt: flag('prompt_upsampling', false),
          outputFormat, seed,
        }), 'edit_image')
      }
      throw new Error(`Unknown edit model: ${model}`)
    }

    // DevelopImageNode (:2806): Nano Banana 2 with the fixed polish instruction, always png.
    case 'DevelopImageNode': {
      const image = await pictureUrl('input_image', 'There is no picture to develop')
      return still(NANO_BANANA_2_EDIT_APP, falNanoBananaEdit({
        imageUrls: [image], prompt: DEVELOP_PROMPT,
        resolution: asText(inputs.resolution) || '1K', outputFormat: 'png', seed: asInt(inputs.seed, 0),
      }), 'edit_image')
    }

    // RelightNode (comfy_extras/nodes_relight.py): image, then the reference; 1K, png, no seed.
    // Replicate's Nano Banana 2 first (cheaper), fal's the backup (twins.ts);
    // the ComfyUI path still tries fal first.
    case 'RelightNode': {
      const image = await pictureUrl('image', 'There is no picture to relight')
      const hasReference = isLink(inputs.reference)
      const imageUrls = [image]
      if (hasReference) imageUrls.push(await pictureUrl('reference', 'There is no reference picture'))
      const light = parseLight(inputs.light)
      const prompt = relightInstruction(
        typeof inputs.preset === 'string' ? inputs.preset : 'Custom',
        light.azimuth, light.elevation, light.intensity,
        flag('keep_background', true), hasReference, asText(inputs.instructions),
      )
      const onFal = falNanoBananaEdit({ imageUrls, prompt, resolution: '1K', outputFormat: 'png', seed: 0 })
      return stillCall(nanoBananaOnReplicate(NANO_BANANA_2_REPLICATE, onFal), 'relight', { provider: 'fal', endpoint: NANO_BANANA_2_EDIT_APP, payload: onFal })
    }

    // BlendSceneNode (:2940), the two Flux modes, the first Nano Banana, and
    // Nano Banana 2 (runner-only, F11). A custom prompt wins over the toggles.
    // keep_subject wired (a Frame's protect_mask, Task F11b): every model's
    // answer goes under the kept region after the call (compositor/keep.ts).
    // Its checks come first, so a kept subject the runner can't finish is
    // refused before the picture is handed off or anything is sent.
    case 'BlendSceneNode': {
      let keep: KeepStep | undefined
      if (isLink(inputs.keep_subject)) {
        const link = inputs.image
        if (!isLink(link)) throw new Error('There is no picture to blend')
        let source
        try { source = pictureSourceOf(ctx.prompt, link) }
        catch { throw new Error('The runner cannot keep the subject of this picture') }
        keep = await planKeepSubject(ctx, inputs, { link, source }, ctx.keepHeld)
      }
      const plan = await planBlendScene()
      if (keep && plan.kind === 'provider') plan.keep = keep
      return plan
    }

    // ── nano-actions family (comfy_extras/nodes_edit_actions.py, nodes_swap_*.py, nodes_person_swap.py) ──
    // Each reaches here only when it makes its call (see actionPassThrough above).
    case 'RemoveObjectNode': {
      const image = await pictureUrl('image', 'There is no picture to edit')
      return nanoAction(removeObjectInstruction(asText(inputs.target), asText(inputs.instructions)), [image], 'remove_object')
    }
    case 'TextEditNode': {
      const image = await pictureUrl('image', 'There is no picture to edit')
      return nanoAction(textEditInstruction(asText(inputs.find), asText(inputs.replace), asText(inputs.instructions)), [image], 'text_edit')
    }
    case 'RecolorObjectNode': {
      const image = await pictureUrl('image', 'There is no picture to edit')
      return nanoAction(recolorInstruction(asText(inputs.target), asText(inputs.color), asText(inputs.instructions)), [image], 'recolor_object')
    }
    // Reference mode sends [background, product] (the prompt's "first image /
    // second image"); prompt mode sends [product] only.
    case 'SwapBackgroundNode': {
      const product = await pictureUrl('product', 'There is no product picture')
      const hasReference = isLink(inputs.background_reference)
      const imageInput = hasReference
        ? [await pictureUrl('background_reference', 'There is no background picture'), product]
        : [product]
      const prompt = swapBackgroundInstruction({
        hasReference,
        scenePrompt: asText(inputs.scene_prompt),
        relightToScene: flag('relight_to_scene', true),
        groundWithShadow: flag('ground_with_shadow', true),
        keepScaleAndPlacement: flag('keep_scale_and_placement', true),
        instructions: asText(inputs.instructions),
      })
      return nanoAction(prompt, imageInput, 'swap_background')
    }
    // Order is load-bearing: [scene reference, new product].
    case 'SwapProductNode': {
      const scene = await pictureUrl('scene_reference', 'There is no scene picture')
      const product = await pictureUrl('product', 'There is no product picture')
      return nanoAction(swapProductInstruction(asText(inputs.instructions)), [scene, product], 'swap_product')
    }
    // Order is load-bearing: [scene, new person].
    case 'PersonSwap': {
      const scene = await pictureUrl('scene', 'There is no scene picture')
      const person = await pictureUrl('person', 'There is no picture of the person')
      return nanoAction(personSwapInstruction(flag('keep_original_outfit', true), asText(inputs.instructions)), [scene, person], 'person_swap')
    }

    // ── ref-edits family (nodes_replicate.py :2851, :3453, :3604) ──
    // GenerateFromReferencesNode: the linked references in slot order (empty
    // slots skipped), the model's builder, then _run_image_edit_prediction's
    // first call: Seedream on Replicate, Nano Banana 2 on fal.
    case 'GenerateFromReferencesNode': {
      const model = String(inputs.model)
      const desc = (REFERENCE_MODEL_IDS as readonly string[]).includes(model) ? IMAGE_EDIT_MODELS[model] : undefined
      if (!desc) throw new Error(`The runner cannot generate from references with ${model}`)
      const prompt = textSetting(inputs, 'prompt', '', 'prompt')
      const imageUrls: string[] = []
      // One at a time, so the hand-offs happen in slot order too.
      for (const slot of REFERENCE_SLOTS) {
        if (isLink(inputs[slot])) imageUrls.push(await pictureUrl(slot, 'There is no reference picture'))
      }
      const input = desc.build(prompt, imageUrls, asInt(inputs.seed, 0), {
        size: inputs.size === undefined ? '2K' : inputs.size,
        aspect_ratio: inputs.aspect_ratio === undefined ? 'match_input_image' : inputs.aspect_ratio,
      })
      const call = imageEditCall(desc.slug, input)
      return still(call.endpoint, call.payload, 'generate_from_references', call.provider)
    }

    // RotateCameraNode: the gimbal's angles as a director's phrase, Qwen Image Edit Plus on Replicate.
    // With qwen-2511-angles on (Task F10): the angles themselves, Qwen Image
    // Edit 2511 multiple angles on fal, no backup (qwen2511Angles.ts).
    case 'RotateCameraNode': {
      const cam = parseCamera(inputs.camera)
      const image = await pictureUrl('image', 'There is no picture to turn')
      if (classUpgradeOn('RotateCameraNode', ctx.families ?? NO_FAMILIES)) {
        return stillCall(qwen2511Angles({ image, camera: cam, seed: asInt(inputs.seed, 0) }), 'rotate_camera')
      }
      const input = IMAGE_EDIT_MODELS['qwen-image-edit-plus']!.build(
        cameraToPhrase(cam.yaw, cam.pitch, cam.roll), [image], asInt(inputs.seed, 0), {})
      const call = imageEditCall(QWEN_IMAGE_EDIT_PLUS_SLUG, input)
      return still(call.endpoint, call.payload, 'rotate_camera', call.provider)
    }

    // ProductShotNode: catacolabs/sdxl-ad-inpaint on Replicate (a community model).
    // With bria-product-shot on (Task F12): Bria Product Shot on fal, no
    // backup (briaProductShot.ts); the size, exactness and seed aren't sent.
    case 'ProductShotNode': {
      const scenePrompt = textSetting(inputs, 'scene_prompt', '', 'scene description')
      const image = await pictureUrl('image', 'There is no product picture')
      const aspect = inputs.aspect === undefined ? 'Square' : inputs.aspect
      if (classUpgradeOn('ProductShotNode', ctx.families ?? NO_FAMILIES)) {
        return stillCall(briaProductShot({ image, scenePrompt, aspect }), 'product_shot')
      }
      return still(PRODUCT_SHOT_SLUG, productShotInput({
        image,
        scenePrompt,
        aspect,
        productSize: inputs.product_size === undefined ? 'Original' : inputs.product_size,
        keepProductExact: flag('keep_product_exact', true),
        seed: asInt(inputs.seed, 0),
      }), 'product_shot', 'replicate')
    }

    // ── fix-faces: Fix faces on fal's Topaz, no backup (topazImage.ts) ──
    case 'FixFacesNode': {
      const image = await pictureUrl('image', 'There is no picture to fix')
      return stillCall(topazFixFaces({ image, inputs }), 'fix_faces')
    }

    // ── face-swap: Face swap on Easel, no backup (easelFaceSwap.ts). Python sends
    // only an IMAGE batch's first frame; so does the runner (linkedFirstFile). ──
    case 'FaceSwap': {
      const face = await pictureUrl('source_face', 'There is no face picture')
      const target = await pictureUrl('target_frames', 'There is no picture to put the face in')
      return stillCall(easelFaceSwap({ face, target, inputs }), 'face_swap')
    }

    // ── restyle family (nodes_replicate.py RestyleFromImageNode :3070) ──
    // Moodboard pictures (style_refs, at most 3) win over the style picture;
    // one that can't be read is skipped. The style-source guard runs before
    // anything is handed off when it can already tell there is no source.
    case 'RestyleFromImageNode': {
      const model = String(inputs.model)
      if (!isRestyleModel(model)) throw new Error(`The runner cannot restyle with ${model}`)
      const guidance = pyStrip(textSetting(inputs, 'prompt', '', 'prompt'))
      const taste = pyStrip(textSetting(inputs, 'style_in', '', 'style direction'))
      const structureStrength = structureStrengthOf(inputs.structure_strength)
      const boardFiles = moodboardFiles(inputs.style_refs)
      const styleLinked = isLink(inputs.style_image)
      // First run of the guard (before any hand-off); restyleCall runs it again once the readable board pictures are known.
      checkStyleSource(model, { hasBoard: boardFiles.length > 0, hasStyleImage: styleLinked, taste })
      const content = await pictureUrl('content_image', 'There is no picture to restyle')
      const board: string[] = []
      for (const f of boardFiles) {
        // IP-Adapter takes one picture: the first one that can be read.
        if (!isNanoBananaRestyle(model) && board.length) break
        try { board.push(await ctx.toUrl(f)) }
        catch (e) {
          if (!isUnreadableFile(e)) throw e
          console.warn(`[runner] moodboard picture unreadable, skipping: ${f.subfolder}/${f.filename}`)
        }
      }
      const styleImage = !board.length && styleLinked ? await pictureUrl('style_image', 'There is no style picture') : null
      const call = restyleCall({
        model, content, board, styleImage, guidance, taste, structureStrength,
        resolution: inputs.resolution === undefined ? '1K' : inputs.resolution,
        outputFormat: inputs.output_format === undefined ? 'png' : inputs.output_format,
        seed: asInt(inputs.seed, 0),
      })
      return stillCall(call, 'restyle', call.backup)
    }

    // ── sync-3 (model line-up F22): Lip-sync a character's sync-3 engine on fal, no backup ──
    // The face video and the sound go through the pictures' hand-off; the
    // engine has already read and measured both (sync3Media.ts), so here they
    // are only named, handed off and sent. Python's other engines never come
    // here (eligibility.ts takes only sync-3).
    case 'LipSyncNode': {
      if (!isSync3LipSync(inputs)) throw new Error('The runner runs Lip-sync a character on sync-3 only')
      const problem = sync3NodeProblem(ctx.prompt, ctx.nodeId)
      if (problem) throw new Error(problem.message)
      const sources = sync3Sources(ctx.prompt, ctx.nodeId)
      if (!('file' in sources.video) || !('file' in sources.audio)) throw new Error('This lip-sync has no face video or sound')
      // A linked Audio card hands its file on; the file the link brought is the one sent.
      const audio = sources.audio.link ? (linkedFirstFile('audio') ?? sources.audio.file) : sources.audio.file
      const call = sync3Lipsync({
        videoUrl: await ctx.toUrl(sources.video.file),
        audioUrl: await ctx.toUrl(audio),
        syncMode: String(lipSyncSyncMode(inputs)),
      })
      return {
        kind: 'provider', provider: call.provider, endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'lip_sync',
        // LipSyncNode shows nothing itself (its Python execute returns only the video); a Video card after it does.
        uiFor: () => null,
      }
    }

    // ── topaz-video (model line-up F23): Enhance a video on fal's Topaz, no backup ──
    // The engine has already read and measured the video (topazMedia.ts); the
    // factor comes from that measurement, the same one the price read.
    case 'EnhanceVideoNode': {
      const problem = topazVideoNodeProblem(ctx.prompt, ctx.nodeId)
      if (problem) throw new Error(problem.message)
      const source = topazVideoSource(ctx.prompt, ctx.nodeId)
      if (!('file' in source)) throw new Error('This upscale has no video')
      const m = ctx.measured
      if (!m) throw new Error(TOPAZ_VIDEO_UNMEASURED)
      const plan = topazVideoPlan(inputs, { width: m.videoWidth, height: m.videoHeight, fps: m.videoFps })
      if ('refused' in plan) throw new Error(plan.refused)
      const call = topazVideoUpscale({ videoUrl: await ctx.toUrl(source.file), plan })
      return {
        kind: 'provider', provider: call.provider, endpoint: call.endpoint, payload: call.payload, media: 'video', prefix: 'enhance_video',
        // EnhanceVideoNode shows nothing itself (its Python execute returns only the video); a Video card after it does.
        uiFor: () => null,
      }
    }

    // The Audio card a sync-3 lip-sync reads (family sync-3): its own file, handed on.
    // The card plays its file itself; nothing to show.
    case 'Audio': {
      const f = parseInputFileRef(inputs.audio)
      return { kind: 'pass', files: f ? [f] : [], ui: null }
    }

    // ── frame family (comfy_extras/nodes_compositor.py) ──
    case 'Compositor':
      return planCompositor(ctx)

    // LoadImage: feeding only Frames with cards off, the Frame editor's
    // injected file handed on as before (the Frame reads the picture, or its
    // alpha as the mask, by the wire's slot); otherwise a card (R1.3) whose
    // picture and mask are Python's.
    case 'LoadImage':
      return planLoadImageCard(ctx)

    // ── cards (step 3, R0.4): the Primitive cards hand on their value ──
    case 'PrimitiveString':
    case 'PrimitiveStringMultiline':
    case 'PrimitiveInt':
    case 'PrimitiveFloat':
    case 'PrimitiveBoolean':
      return staticDerive(ctx)

    // ── cards (step 3, R1.1): Text, Moodboard, 3D model ──
    case 'Text': return staticDerive(ctx, textCardUi)
    case 'Moodboard': return staticDerive(ctx)
    case 'Model3D': return staticDerive(ctx, textCardUi)

    // ── cards (step 3, R1.3): the bake-replay cards hand on their studio's bake ──
    case 'Scene3DStudio': return planScene3D(ctx)
    case 'TextOnPath': return planTextOnPath(ctx)
    // With a source wired (R1.4): the source clipped by the mask.
    case 'TextMask': return isLink(inputs.source) ? planTextMaskWithSource(ctx) : planTextMask(ctx)

    // ── cards (step 3, R1.4): the picture utilities ──
    case 'EmptyImage': return planEmptyImage(ctx)
    case 'GetImageSize': return planGetImageSize(ctx)
    case 'ImageToMask': return planImageToMask(ctx)

    case GATE_CLASS: {
      // A value (not files) reaching a Gate is handed on when it is open or
      // on pass-through (spec ruling 2); a closed Gate on a value pauses with
      // no pictures to pick from, keeping the value for Continue.
      const link = inputs.data_in
      const v = isLink(link) ? ctx.valueFrom?.(link) : undefined
      const files = v ? filesOf(v) : linked('data_in')
      const open = inputs.bypass === true || ctx.gateOpen
      if (open && v && v.kind !== 'files') return { kind: 'derive', derive: async () => ({ values: { 0: v }, ui: null }) }
      if (open) return { kind: 'pass', files, ui: null }
      return v && v.kind !== 'files' ? { kind: 'pause', files, values: { 0: v } } : { kind: 'pause', files }
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
      // A picture the runner made (kept bytes) is never served by /view: the
      // card hands the kept file on and shows a copy in temp (R1.5).
      if (files.some(f => f.type === 'kept')) return imageCardShowingKept(files)
      return { kind: 'pass', files, ui: { images: files } }
    }

    // ── cards (step 3, R1.5): Save image and Preview image ──
    case 'SaveImage': return planSaveImage(ctx)
    case 'PreviewImage': return planPreviewImage(ctx)

    // ── cards (step 3, R1.6): Smart Layout renders its layout here ──
    case 'SmartLayout': return planSmartLayout(ctx)

    case 'Video': {
      let files: OutputFile[]
      if (isLink(inputs.source)) files = linked('source')
      else {
        const f = parseInputFileRef(inputs.file)
        files = f ? [f] : []
      }
      return { kind: 'pass', files, ui: files.length ? { images: files, animated: [true] } : { images: [] } }
    }

    default: {
      // ── effects-* (step 3, R2): the still-picture effects, computed here ──
      const fx = effectSpec(node.class_type)
      if (fx) return planEffect(ctx)
      throw new Error(`The runner cannot run a ${node.class_type} node`)
    }
  }
}
