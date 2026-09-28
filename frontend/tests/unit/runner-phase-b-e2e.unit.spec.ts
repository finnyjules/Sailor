/**
 * Phase B, Task B10: the controller check, end to end, every family switched
 * on. This file is the evidence for the B10 checklist
 * (.superpowers/sdd/2026-09-24-engine-free-phase-b/task-B10-brief.md).
 *
 * Everything goes through the real routes (h3 `toWebHandler`, as
 * runner-routes.unit.spec.ts does): POST /api/runs, POST /api/runs/gate,
 * POST /api/runs/stop and the SSE stream GET /api/runs/events. Behind them is
 * the real engine, file store and metering (hosted, with the kit's fake
 * ledger), and the kit's fake fal and fake Replicate. The server's families
 * come from the real `runnerFamilies()` (NUXT_RUNNER_ENABLED +
 * NUXT_RUNNER_FAMILIES). No provider key is read and nothing reaches the
 * network: run with FAL_KEY, NUXT_REPLICATE_TOKEN and REPLICATE_API_TOKEN unset.
 *
 * Request bodies are checked against the Python fixtures
 * (fixtures/runner-families.json), with each `IMG:<input>` placeholder
 * replaced by the fal storage link the kit's hand-off gives that card's file,
 * and without the fields the provider's schema doesn't define (the runner
 * follows the schema since Task S1b: no seed or cfg_scale on Kling 3, no seed
 * on Seedream 5).
 * Charges are checked against `priceGraph` for the nodes that ran.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import { __setEngineForTests } from '~~/server/runner/index'
import { runnerFamilies } from '~~/server/runner/config'
import { nodeCredits } from '~~/server/runner/metering'
import { _resetRateLimits } from '~~/server/lib/rateLimit'
import { BASE_RENDER_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import startRoute from '~~/server/api/runs/index.post'
import gateRoute from '~~/server/api/runs/gate.post'
import stopRoute from '~~/server/api/runs/stop.post'
import eventsRoute from '~~/server/api/runs/events.get'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, type RunnerNodeRule } from '#shared/runner/eligibility'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerMessage } from '#shared/runner/messages'
import { nodesNeedingEngine } from '~~/app/lib/runner/needsEngine'
import { isRunnerDeclined } from '~~/app/lib/runner/client'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, rgbPng1x1, until } from './__runner__/kit'
import { withoutUnknownFields } from './helpers/pythonParity'

// ── Fixtures ─────────────────────────────────────────────────────────────

interface NodeCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call: { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> } | { passthrough: true }
  passes?: string
  error?: string
}
interface VideoCase {
  model: string
  slug: string
  args: { prompt: string; ar: string; dur: number; seed: number; image: string | null; adv: Record<string, unknown> }
  payload?: Record<string, unknown>
  error?: string
}
const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as {
  falEdit: NodeCase[]; replicateImage: NodeCase[]; nanoActions: NodeCase[]; refEdits: NodeCase[]; restyle: NodeCase[]; replicateVideo: VideoCase[]
}

const called = (c: NodeCase) => c.call as { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }
function pick<T>(list: T[], label: string, ok: (c: T) => boolean): T {
  const c = list.find(ok)
  if (!c) throw new Error(`fixture has no ${label} case`)
  return c
}

const storageUrl = (name: string) => `https://fal.storage/${name}.png`
/** The fixture body with each `IMG:<input>` (or the video's IMAGE_URL) as the storage link the card's file was handed off as. */
function expectedBody(payload: Record<string, unknown>, swaps: Record<string, string>): Record<string, unknown> {
  let text = JSON.stringify(payload)
  for (const [from, to] of Object.entries(swaps)) text = text.split(JSON.stringify(from)).join(JSON.stringify(to))
  return JSON.parse(text) as Record<string, unknown>
}

const imageCard = (file: string) => ({ class_type: 'Image', inputs: { image: file } })
const outImage = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const outVideo = (from: string) => ({ class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [from, 0] } })

/**
 * A real, mediabunny-readable MP4 whose video track lasts `seconds` at
 * `fps`, `width` × `height`, muxed without an encoder (the same recipe as
 * runner-topaz-video.unit.spec.ts and runner-person-swap-video.unit.spec.ts).
 * A video-measured family's FLOWS entry (person-swap-video) needs its file
 * to be genuinely parseable, since the engine's own media check reads it
 * for real (no mock): the synthetic filler bytes `writeCards` writes for
 * every other card would fail that check.
 */
async function realMp4(seconds: number, width = 1280, height = 720, fps = 24): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: fps })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / fps, 1 / fps),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

interface FamilyFlow {
  family: RunnerFamily
  label: string
  prompt: ApiPrompt
  /** Card files to write into the input folder. */
  files: string[]
  provider: 'fal' | 'replicate'
  endpoint: string
  body: Record<string, unknown>
  /** Families switched off with this one when it is off in turn (another family would take the workflow). */
  alsoOff?: RunnerFamily[]
  /** Its cards must start as real PNGs: the runner reads the file's format before sending (Product shot on Bria, F12 fix round 1). */
  png?: true
  /**
   * Its cards must be pictures whose size can be read: the node is priced by
   * the picture's size, and hosted refuses one it can't size (Task G1).
   */
  measured?: true
  /**
   * A real video file this flow needs read and measured before the hold
   * (person-swap-video): its name (among `files`) and its length in
   * seconds, so the price can be checked against the same figure the
   * engine actually measured.
   */
  realVideoFile?: { name: string, seconds: number }
}

/**
 * A node fixture case as the canvas sends it: each linked picture comes from
 * its own loaded Image card (`<input>.png`, node ids 11, 12, …), the node is
 * `1`, and an Image card `2` shows its output.
 */
function nodeFlow(family: RunnerFamily, c: NodeCase, o: { output?: boolean } = {}): FamilyFlow {
  const prompt: ApiPrompt = {}
  const inputs: Record<string, unknown> = { ...c.widgets }
  const swaps: Record<string, string> = {}
  c.links.forEach((name, i) => {
    const id = String(11 + i)
    prompt[id] = imageCard(`${name}.png`)
    inputs[name] = [id, 0]
    swaps[`IMG:${name}`] = storageUrl(name)
  })
  prompt['1'] = { class_type: c.class_type, inputs }
  if (o.output !== false) prompt['2'] = outImage('1')
  const call = called(c)
  return {
    family,
    label: `${c.class_type} ${String(c.widgets.model ?? '')}`.trim(),
    prompt,
    files: c.links.map(n => `${n}.png`),
    provider: call.provider,
    endpoint: call.endpoint,
    body: call.payload ? expectedBody(withoutUnknownFields(call.provider, call.endpoint, call.payload), swaps) : {},
  }
}

/** A video fixture case: the first frame from a loaded card `image.png` (11) → GenerateVideoNode (1) → Video card (2). */
function videoFlow(c: VideoCase): FamilyFlow {
  const inputs: Record<string, unknown> = {
    model: c.model, prompt: c.args.prompt, aspect_ratio: c.args.ar, duration: String(c.args.dur),
    seed: c.args.seed, model_options: JSON.stringify(c.args.adv),
  }
  const prompt: ApiPrompt = {}
  if (c.args.image) {
    prompt['11'] = imageCard('image.png')
    inputs.image = ['11', 0]
  }
  prompt['1'] = { class_type: 'GenerateVideoNode', inputs }
  prompt['2'] = outVideo('1')
  return {
    family: 'replicate-video',
    label: `GenerateVideoNode ${c.model}`,
    prompt,
    files: c.args.image ? ['image.png'] : [],
    provider: 'replicate',
    endpoint: c.slug,
    body: expectedBody(withoutUnknownFields('replicate', c.slug, c.payload!), c.args.image ? { [c.args.image]: storageUrl('image') } : {}),
  }
}

const hasCall = (c: NodeCase) => 'endpoint' in c.call && !c.error

/**
 * One workflow per family, each a Python fixture case (see the labels). Since
 * Task S3 Kling 3.0 and Restyle's Nano Banana 2 go to a different first
 * service than Python's (server/runner/generators/twins.ts), so those two
 * families take a model whose first service is still Python's.
 */
const FLOWS: FamilyFlow[] = [
  nodeFlow('fal-edit', pick(FIX.falEdit, 'fal-edit Edit', c => c.class_type === 'EditImageNode' && hasCall(c) && c.links.length === 1)),
  nodeFlow('replicate-image', pick(FIX.replicateImage, 'flux-2-pro seed 42', c => c.widgets.model === 'flux-2-pro' && c.widgets.seed === 42 && hasCall(c))),
  nodeFlow('nano-actions', pick(FIX.nanoActions, 'Remove object', c => c.class_type === 'RemoveObjectNode' && hasCall(c))),
  videoFlow(pick(FIX.replicateVideo, 'runway-gen-4.5 with a frame', c => c.model === 'runway-gen-4.5' && !!c.args.image && !c.error)),
  nodeFlow('ref-edits', pick(FIX.refEdits, 'references ×3', c => c.class_type === 'GenerateFromReferencesNode' && c.links.length === 3 && hasCall(c))),
  nodeFlow('restyle', pick(FIX.restyle, 'restyle on Nano Banana Pro with a style picture', c => c.class_type === 'RestyleFromImageNode' && c.widgets.model === 'Nano Banana Pro' && hasCall(c) && c.links.includes('style_image'))),
  // Task F1: Wan 3.0 has no Python builder, so no fixture case; the body is
  // written from its saved schema (runner-wan3.unit.spec.ts), first frame from a card.
  {
    family: 'wan-3',
    label: 'GenerateVideoNode wan-3.0',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'wan-3.0', prompt: 'a fox in the snow', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{"resolution":"480p"}', image: ['11', 0] } },
      2: outVideo('1'),
    },
    files: ['image.png'],
    provider: 'fal',
    endpoint: 'alibaba/wan-3.0/image-to-video',
    body: { prompt: 'a fox in the snow', resolution: '480p', duration: 5, audio: true, enable_prompt_expansion: true, start_image_url: storageUrl('image') },
  },
  // Task F3: Hailuo H3 Max Turbo has no Python builder either; H3 Max's body
  // on Turbo's app, from its saved schema (runner-h3-max-turbo.unit.spec.ts).
  {
    family: 'h3-max-turbo',
    label: 'GenerateVideoNode hailuo-h3-max-turbo',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3-max-turbo', prompt: 'a fox in the snow', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'minimax/h3-max-turbo/text-to-video',
    body: { prompt: 'a fox in the snow', duration: 5, resolution: '768P', prompt_expansion_mode: 'balanced', aspect_ratio: '16:9' },
  },
  // Task F4: Gemini Omni Flash has no Python builder either; the body is
  // written from its saved schema (runner-gemini-omni-flash.unit.spec.ts).
  // Text-to-video is the bare app id.
  {
    family: 'gemini-omni-flash',
    label: 'GenerateVideoNode gemini-omni-flash',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'gemini-omni-flash', prompt: 'a fox in the snow', aspect_ratio: '9:16', duration: '4', seed: 0, model_options: '{}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'google/gemini-omni-flash',
    body: { prompt: 'a fox in the snow', aspect_ratio: '9:16', duration: 4 },
  },
  // Task F5: Veo 3.1 Lite has no Python builder either; Veo 3.1's body on
  // Lite's app, from its saved schema (runner-veo-31-lite.unit.spec.ts).
  // Text-to-video is the bare app id.
  {
    family: 'veo-3.1-lite',
    label: 'GenerateVideoNode veo-3.1-lite',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1-lite', prompt: 'a fox in the snow', aspect_ratio: '16:9', duration: '4', seed: 0, model_options: '{"generate_audio":false}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'fal-ai/veo3.1/lite',
    body: { prompt: 'a fox in the snow', duration: '4s', resolution: '720p', generate_audio: false, auto_fix: true, aspect_ratio: '16:9' },
  },
  // Task F2: GPT Image 2.5 has no Python builder either; the body is written
  // from its saved schema (runner-gpt-image-25.unit.spec.ts). fal first, so
  // Replicate (the backup) is never called.
  {
    family: 'gpt-image-2.5',
    label: 'GenerateImageNode gpt-image-2.5',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'gpt-image-2.5', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{"quality":"medium"}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'openai/gpt-image-2.5/flare/text-to-image',
    body: { prompt: 'a poster that says HELLO', image_size: { width: 1024, height: 1024 }, quality: 'medium', background: 'auto', output_format: 'png', num_images: 1 },
  },
  // Task F6: Qwen Image 3 has no Python builder either; Replicate only, the
  // body written from its saved schema (runner-qwen-image-3.unit.spec.ts).
  {
    family: 'qwen-image-3',
    label: 'GenerateImageNode qwen-image-3',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'qwen-image-3', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'replicate',
    endpoint: 'alibaba/qwen-image-3',
    body: { prompt: 'a poster that says HELLO', aspect_ratio: '1:1', enable_prompt_expansion: true },
  },
  // Task F7: Grok Imagine 2, no Python builder; Replicate only, the body
  // written from its saved schema (runner-grok-imagine-2.unit.spec.ts).
  {
    family: 'grok-imagine-2',
    label: 'GenerateImageNode grok-imagine-2',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'grok-imagine-2', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'replicate',
    endpoint: 'xai/grok-imagine-image-2',
    body: { prompt: 'a poster that says HELLO', aspect_ratio: '1:1', resolution: '2k', quality: 'medium' },
  },
  // Task F8: Ideogram 4, no Python builder; fal first, the body written from
  // its saved schema (runner-ideogram-4.unit.spec.ts). At 1K there is no
  // Replicate backup, and fal answers, so Replicate is never called.
  {
    family: 'ideogram-4',
    label: 'GenerateImageNode ideogram-4',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'ideogram-4', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{"rendering_speed":"TURBO"}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'ideogram/v4',
    body: { prompt: 'a poster that says HELLO', image_size: { width: 992, height: 992 }, rendering_speed: 'TURBO', expansion_model: 'None', output_format: 'png', num_images: 1 },
  },
  // Task F9: Seedream 5 Pro in Edit an image, no Python builder; Replicate
  // only, the body written from its saved schema (runner-seedream-5-pro-edit.unit.spec.ts).
  {
    family: 'seedream-5-pro-edit',
    label: 'EditImageNode Seedream 5 Pro',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'EditImageNode', inputs: { model: 'Seedream 5 Pro', input_image: ['11', 0], prompt: 'make the sky pink', aspect_ratio: 'match_input_image', resolution: '1K', seed: 0, safety_tolerance: 2, prompt_upsampling: false, output_format: 'png' } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'replicate',
    endpoint: 'bytedance/seedream-5-pro',
    body: { prompt: 'make the sky pink', image_input: [storageUrl('image')], size: '1K', aspect_ratio: 'match_input_image', output_format: 'png' },
  },
  // Task F10: Rotate camera on Qwen Image Edit 2511 multiple angles, no Python
  // builder; fal only, the body written from its saved schema
  // (runner-qwen-2511-angles.unit.spec.ts). With every family on, the node
  // runs its newer model (ref-edits' 2509 call is not made).
  {
    family: 'qwen-2511-angles',
    label: 'RotateCameraNode on Qwen Image Edit 2511',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'RotateCameraNode', inputs: { image: ['11', 0], camera: '{"yaw":-45,"pitch":-30,"roll":15}', seed: 3 } },
      2: outImage('1'),
    },
    files: ['image.png'],
    measured: true,
    provider: 'fal',
    endpoint: 'fal-ai/qwen-image-edit-2511-multiple-angles',
    // With only this one off, ref-edits takes the node on its 2509 call.
    alsoOff: ['ref-edits'],
    body: { image_urls: [storageUrl('image')], horizontal_angle: 315, vertical_angle: -30, additional_prompt: 'with the camera tilted slightly clockwise', seed: 3, output_format: 'png', num_images: 1 },
  },
  // Task F11: Nano Banana 2 in Blend scene, no Python builder; the nano
  // actions' Replicate call, the instruction from the toggles
  // (runner-blend-nano-banana-2.unit.spec.ts).
  {
    family: 'nano-banana-2-blend',
    label: 'BlendSceneNode Nano Banana 2',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'BlendSceneNode', inputs: { model: 'Nano Banana 2', image: ['11', 0], unify_lighting: true, contact_shadows: false, match_camera_look: false, preserve_identity: true, keep_feather: 2, prompt: '', seed: 0, output_format: 'jpg' } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'replicate',
    endpoint: 'google/nano-banana-2',
    body: {
      prompt: 'Blend all elements into a single cohesive, photorealistic image. '
        + 'Unify the lighting direction, color temperature and ambient tone across the whole scene. '
        + 'Keep each element\'s shape, position, proportions and identity unchanged. Do not move, rotate, rescale or reflow any element.',
      image_input: [storageUrl('image')], resolution: '1K', output_format: 'jpg',
    },
  },
  // Task F12: Product shot on Bria Product Shot, no Python builder; fal only,
  // the body written from its saved schema (runner-bria-product-shot.unit.spec.ts).
  // No other family takes the node (its SDXL call is retired from the runner).
  {
    family: 'bria-product-shot',
    label: 'ProductShotNode on Bria Product Shot',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'ProductShotNode', inputs: { image: ['11', 0], scene_prompt: 'on a rock by the sea', aspect: 'Portrait', product_size: '60', keep_product_exact: true, seed: 4 } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'fal',
    endpoint: 'fal-ai/bria/product-shot',
    png: true,
    body: {
      image_url: storageUrl('image'), scene_description: 'on a rock by the sea', placement_type: 'manual_placement',
      manual_placement_selection: 'bottom_center', shot_size: [832, 1216], num_results: 1,
    },
  },
  // Task F13: Muse Image (Meta), no Python builder; fal only, the body
  // written from its saved schema (runner-muse-image.unit.spec.ts).
  {
    family: 'muse-image',
    label: 'GenerateImageNode muse-image',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'muse-image', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'meta/muse-image/text-to-image',
    body: { prompt: 'a poster that says HELLO', aspect_ratio: '1:1', num_images: 1, output_format: 'png' },
  },
  // Task F14: Nano Banana 2 Lite (Google), no Python builder; Replicate only,
  // the body written from its saved schema (runner-nano-banana-2-lite.unit.spec.ts).
  {
    family: 'nano-banana-2-lite',
    label: 'GenerateImageNode nano-banana-2-lite',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2-lite', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'replicate',
    endpoint: 'google/nano-banana-2-lite',
    body: { prompt: 'a poster that says HELLO', aspect_ratio: '1:1', output_format: 'png' },
  },
  // Task F15: Reve 2.1, no Python builder; fal only, the body written from
  // its saved schema (runner-reve-2-1.unit.spec.ts).
  {
    family: 'reve-2.1',
    label: 'GenerateImageNode reve-2.1',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'reve-2.1', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'reve/2.1/text-to-image',
    body: { prompt: 'a poster that says HELLO', aspect_ratio: '1:1', num_images: 1, output_format: 'png' },
  },
  // Task F16: Recraft V4.1, no Python builder; fal first, the body written
  // from its saved schema (runner-recraft-v4-1.unit.spec.ts).
  {
    family: 'recraft-v4.1',
    label: 'GenerateImageNode recraft-v4.1',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'recraft-v4.1', prompt: 'a poster that says HELLO', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'fal-ai/recraft/v4.1/text-to-image',
    body: { prompt: 'a poster that says HELLO', image_size: 'square_hd' },
  },
  // Task F17: Krea 2 Medium, which also runs on ComfyUI (Python _fal_krea2);
  // fal first, the body its saved schema and the Python builder agree on
  // (runner-krea-2.unit.spec.ts).
  {
    family: 'krea-2',
    label: 'GenerateImageNode krea-2-medium',
    prompt: {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'krea-2-medium', prompt: 'a red fox in the snow', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      2: outImage('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'krea/v2/medium/text-to-image',
    body: { prompt: 'a red fox in the snow', aspect_ratio: '1:1', creativity: 'medium' },
  },
  // Task F18: HappyHorse 1.1 has no Python builder; the body is written from
  // its saved schema (runner-happyhorse-1-1.unit.spec.ts). fal first, so
  // Replicate (the backup) is never called.
  {
    family: 'happyhorse-1.1',
    label: 'GenerateVideoNode happyhorse-1.1',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'happyhorse-1.1', prompt: 'a fox says hello', aspect_ratio: '16:9', duration: '3', seed: 0, model_options: '{}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'alibaba/happy-horse/v1.1/text-to-video',
    body: { prompt: 'a fox says hello', aspect_ratio: '16:9', resolution: '720p', duration: 3 },
  },
  // Task F19: Grok Imagine Video 1.5 has no Python builder; the body is written
  // from its saved schema (runner-grok-imagine-video-1-5.unit.spec.ts). fal
  // first; text-to-video has no backup (Replicate's is image-to-video only).
  {
    family: 'grok-imagine-video-1.5',
    label: 'GenerateVideoNode grok-imagine-video-1.5',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'grok-imagine-video-1.5', prompt: 'a fox runs through snow', aspect_ratio: '16:9', duration: '1', seed: 0, model_options: '{"resolution":"480p"}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'fal',
    endpoint: 'xai/grok-imagine-video/v1.5/text-to-video',
    body: { prompt: 'a fox runs through snow', aspect_ratio: '16:9', resolution: '480p', duration: 1 },
  },
  // Task F20: LTX-2.5 Fast has no Python builder; the body is written from its
  // saved schema (runner-ltx-2-5-fast.unit.spec.ts). Replicate first; a 2 s
  // clip has no backup (fal's shortest is 6 s).
  {
    family: 'ltx-2.5-fast',
    label: 'GenerateVideoNode ltx-2.5-fast',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'ltx-2.5-fast', prompt: 'a fox runs through snow', aspect_ratio: '16:9', duration: '2', seed: 0, model_options: '{"resolution":"720p"}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'replicate',
    endpoint: 'lightricks/ltx-2.5-fast',
    body: { prompt: 'a fox runs through snow', duration: 2, resolution: '720p', aspect_ratio: '16:9', generate_audio: true, fps: 25 },
  },
  // Task F21: Luma Ray 3.2 has no Python builder; the body is written from its
  // saved schema (runner-luma-ray-3-2.unit.spec.ts). Replicate first; text-to-video
  // has no backup (fal's image-to-video backs up a clip from a picture only).
  {
    family: 'luma-ray-3.2',
    label: 'GenerateVideoNode luma-ray-3.2',
    prompt: {
      1: { class_type: 'GenerateVideoNode', inputs: { model: 'luma-ray-3.2', prompt: 'a fox runs through snow', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{"resolution":"720p"}' } },
      2: outVideo('1'),
    },
    files: [],
    provider: 'replicate',
    endpoint: 'luma/ray-3.2',
    body: { prompt: 'a fox runs through snow', duration: 5, resolution: '720p', aspect_ratio: '16:9', loop: false },
  },
  // Face swap on Easel's advanced face swap (family face-swap), no backup: the
  // whole FaceSwap node runs only in the runner (there is no ComfyUI path any
  // more — InsightFace / inswapper was removed, non-commercial licence). The
  // body is written from its saved schema (runner-face-swap.unit.spec.ts).
  {
    family: 'face-swap',
    label: 'FaceSwap on Easel',
    prompt: {
      11: imageCard('face.png'),
      12: imageCard('target.png'),
      1: { class_type: 'FaceSwap', inputs: { source_face: ['11', 0], target_frames: ['12', 0], gender: 'Female', keep_hair_from: 'The picture' } },
      2: outImage('1'),
    },
    files: ['face.png', 'target.png'],
    provider: 'fal',
    endpoint: 'easel-ai/advanced-face-swap',
    body: {
      face_image_0: { url: storageUrl('face') },
      gender_0: 'female',
      target_image: { url: storageUrl('target') },
      workflow_type: 'target_hair',
      upscale: true,
    },
  },
  // Fix faces on fal's Topaz image upscale with face enhancement (family
  // fix-faces), no backup: the whole FixFacesNode runs only in the runner
  // (CodeFormer was removed, non-commercial licence; there is no ComfyUI
  // path any more). The body is written from its saved schema
  // (runner-fix-faces.unit.spec.ts).
  {
    family: 'fix-faces',
    label: 'FixFacesNode on fal\'s Topaz',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'FixFacesNode', inputs: { image: ['11', 0] } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'fal',
    endpoint: 'fal-ai/topaz/upscale/image',
    // Fix faces is priced by the picture's measured size (editSettings.ts pricedInputPixels): a
    // 1 × 1 real PNG so the runner can size it, exactly like the other size-priced flows above.
    measured: true,
    body: {
      image_url: storageUrl('image'), model: 'Standard V2', upscale_factor: 2,
      face_enhancement: true, face_enhancement_strength: 0.8, face_enhancement_creativity: 0, output_format: 'png',
    },
  },
  // Remove background on Replicate (family image-repair, step 3 R3.5), no backup:
  // the Python call as it is (runner-paid-repair.unit.spec.ts has every class).
  {
    family: 'image-repair',
    label: 'RemoveBackgroundNode on Replicate',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['11', 0] } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'replicate',
    endpoint: '851-labs/background-remover',
    body: { image: storageUrl('image') },
  },
  // Separate text from image on Replicate's Ideogram Layerize (family layers, step 3 R3.6), no
  // backup: the Python call as it is, a pipeline of one call (runner-paid-layers.unit.spec.ts has
  // every class, Outpaint and Seedream among them).
  {
    family: 'layers',
    label: 'LayerizeGraphicNode on Ideogram Layerize',
    prompt: {
      11: imageCard('image.png'),
      1: { class_type: 'LayerizeGraphicNode', inputs: { model: 'Ideogram Layerize', prompt: '', seed: 0, image: ['11', 0] } },
      2: outImage('1'),
    },
    files: ['image.png'],
    provider: 'replicate',
    endpoint: 'ideogram-ai/layerize',
    body: { flat_graphic_image: storageUrl('image') },
  },
  // Person swap (video) on fal's Pixverse Swap (family person-swap-video), no
  // backup (Replicate has no Pixverse Swap): the whole PersonSwapVideo node
  // runs only in the runner; there is no ComfyUI path at all (its Python
  // definition always raises). The video is read and measured before the
  // hold (personSwapMedia.ts), so `realVideoFile` gives it a genuine,
  // mediabunny-readable clip rather than the synthetic filler `writeCards`
  // writes for a plain picture. Its saved schema is
  // runner-person-swap-video.unit.spec.ts's.
  {
    family: 'person-swap-video',
    label: 'PersonSwapVideo on Pixverse Swap',
    prompt: {
      11: imageCard('person.png'),
      1: { class_type: 'PersonSwapVideo', inputs: { image: ['11', 0], video_url: '/view?filename=clip.mp4&type=input', resolution: '720p' } },
      2: outVideo('1'),
    },
    files: ['person.png', 'clip.mp4'],
    realVideoFile: { name: 'clip.mp4', seconds: 3 },
    provider: 'fal',
    endpoint: 'fal-ai/pixverse/swap',
    body: {
      video_url: 'https://fal.storage/clip.mp4',
      image_url: storageUrl('person'),
      mode: 'person', resolution: '720p', original_sound_switch: true,
    },
  },
]

// ── The routes ───────────────────────────────────────────────────────────

const USER = 'user_1'
function handler(route: any, userId: string | null = USER) {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (route: any, body: unknown) => handler(route)(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const startRun = (takes: ApiPrompt[]) => post(startRoute, { takes, workflow: { nodes: [] }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Phase B' })
async function started(takes: ApiPrompt[]): Promise<{ runId: string; legId: string; promptIds: string[] }> {
  const res = await startRun(takes)
  if (res.status !== 200) throw new Error(`POST /api/runs → ${res.status}: ${await res.text()}`)
  return await res.json()
}

/** GET /api/runs/events, read in the background: every runner message, in order (the named ready/ping events left out). */
async function openEvents() {
  const res = await handler(eventsRoute)(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  const reader = res.body!.getReader()
  const msgs: RunnerMessage[] = []
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (/^event:/m.test(block)) continue
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data: ?/, '')).join('\n')
        if (data) msgs.push(JSON.parse(data) as RunnerMessage)
      }
    }
  })().catch(() => {})
  return {
    msgs,
    until: (check: (m: RunnerMessage[]) => boolean) => until(() => check(msgs), 5000),
    // Not reader.cancel(): under toWebHandler (no socket) h3 re-raises the
    // cancel reason as unhandled rejections. Over a real Node socket a client
    // that goes away raises nothing (checked by hand, 2026-09-24), so this is
    // the harness, not the route. The stream is simply left; its ping
    // interval is faked, and each test has its own kit and event bus.
    close: async () => {},
  }
}
const ends = (promptId: string) => (m: RunnerMessage) =>
  (m.type === 'execution_success' || m.type === 'execution_error') && m.data.prompt_id === promptId

// ── Harness ──────────────────────────────────────────────────────────────

const ALL = RUNNER_FAMILIES.join(',')
const kits: ReturnType<typeof makeKit>[] = []
function kit(o: Parameters<typeof makeKit>[0] = {}) {
  const k = makeKit({ hosted: true, ...o, deps: { families: runnerFamilies, ...o.deps } })
  kits.push(k)
  __setEngineForTests(k.engine)
  return k
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
/** A whole 1 × 1 grey PNG, whose header gives its size (bytes after IEND are ignored by readers). */
const PNG_1X1 = [
  ...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00,
  0x00, 0x3A, 0x7E, 0x9B, 0x55, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0x48, 0xAF, 0xA4, 0x71, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]
function writeCards(k: ReturnType<typeof makeKit>, files: string[], png = false, measured = false) {
  // R3.H: with `cards` on, an Image card's file is decoded before it is handed off (as
  // Python's loader decodes it): each card is a real 1 × 1 picture of its own colour.
  if (runnerFamilies().has('cards')) {
    files.forEach((f, i) => writeFileSync(join(k.root, 'input', f), rgbPng1x1(i + 1, 7, 7)))
    return
  }
  const head = measured ? PNG_1X1 : png ? PNG_SIGNATURE : []
  files.forEach((f, i) => writeFileSync(join(k.root, 'input', f), new Uint8Array([...head, i + 1, 7, 7])))
}
const holds = (ledger: ReturnType<typeof createFakeLedger>) => [...ledger.holds.values()].map(h => [h.state, h.actual])

beforeAll(() => {
  // The evidence only counts with no provider key in the environment.
  expect(process.env.FAL_KEY).toBeUndefined()
  expect(process.env.NUXT_REPLICATE_TOKEN).toBeUndefined()
  expect(process.env.REPLICATE_API_TOKEN).toBeUndefined()
})
beforeEach(() => {
  process.env.NUXT_RUNNER_ENABLED = 'true'
  process.env.NUXT_RUNNER_FAMILIES = ALL
  _resetRateLimits()
  // Only the SSE route's 25 s ping interval is faked, so it never fires or leaks.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  delete process.env.NUXT_RUNNER_ENABLED
  delete process.env.NUXT_RUNNER_FAMILIES
  __setEngineForTests(null)
  kits.length = 0
})

// ── 1. One workflow per family, every switch on ──────────────────────────

describe('B10 · one workflow per family, POST /api/runs to the last event', () => {
  it('the server has every family on', () => {
    expect([...runnerFamilies()].sort()).toEqual([...RUNNER_FAMILIES].sort())
    // `frame` makes no provider call (the runner renders it): its end-to-end is runner-compositor-engine.unit.spec.ts.
    // `sync-3` needs real media files, measured before the hold, and charges the clip it measures (below the
    // unmeasured price this loop checks): its end-to-end is runner-sync-3.unit.spec.ts. `topaz-video` the same
    // (Task F23): a real video, measured before the hold: runner-topaz-video.unit.spec.ts. `cards` (step 3, R0.3)
    // makes no provider call either (the runner computes the cards): runner-value-wires.unit.spec.ts and the R1 card specs.
    // Nor do the picture effects, the Shader effect's bake and the live previews (step 3, R2): runner-effects-*.unit.spec.ts.
    // `face-swap`, `fix-faces` and `person-swap-video` (Tasks 1–3, non-commercial face models
    // replacement) are provider families like any other: each has its own FLOWS entry below.
    const local: readonly string[] = [
      'frame', 'sync-3', 'topaz-video', 'cards',
      'effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake', 'live-previews',
      // The LLM text nodes (R3.3) hand on text, not files: their end-to-end is runner-paid-llm.unit.spec.ts.
      'llm-text',
      // Describe, read and find (R3.4) hand on text and JSON: runner-paid-describe.unit.spec.ts.
      'describe',
      // Music and speech (R3.8) make a sound an Audio card shows: runner-paid-audio-gen.unit.spec.ts.
      'audio-gen',
      // 3D models (R3.9) hand on a 3D file's address: runner-paid-3d.unit.spec.ts.
      'gen-3d',
      // Film a shot's preset path (R3.11) films as Generate a video does (replicate-video's and the
      // no-family models' flows): its engine runs are runner-paid-film-shot.unit.spec.ts.
      'film-shot',
      // Text effect, sketch to image and face references (R3.12) make a picture on Replicate:
      // runner-paid-image-extras.unit.spec.ts.
      'image-extras',
      // Flux Dev + LoRA and Flux Dev + LoRAs (R3.13) make a picture on Replicate: runner-paid-lora.unit.spec.ts.
      'lora',
      // Lens · 3D Reframe and Pose Mannequin (R3.15) make a picture on Replicate: runner-paid-nano-extras.unit.spec.ts.
      'nano-extras',
      // Turntable (R3.16) makes a video on Replicate: runner-paid-turntable.unit.spec.ts.
      'turntable',
    ]
    expect(FLOWS.map(f => f.family).sort()).toEqual(RUNNER_FAMILIES.filter(f => !local.includes(f)).sort())
  })

  it.each(FLOWS.map(f => [`${f.family}: ${f.label} → ${f.endpoint}`, f] as const))('%s', async (_l, f) => {
    const k = kit()
    writeCards(k, f.files, f.png, f.measured)
    // A video-measured family (person-swap-video): replace the synthetic filler with a real,
    // mediabunny-readable clip, since the engine's own media check reads it for real.
    if (f.realVideoFile) writeFileSync(join(k.root, 'input', f.realVideoFile.name), await realMp4(f.realVideoFile.seconds))
    const events = await openEvents()
    try {
      const { runId, promptIds } = await started([f.prompt])
      expect(promptIds).toEqual([`${runId}.0.t0`])
      await events.until(m => m.some(ends(promptIds[0]!)))
      await k.engine.settled(runId)

      // Exactly one request, to the fixture's provider and endpoint, with the fixture's body.
      const [mine, other] = f.provider === 'fal' ? [k.fal, k.replicate] : [k.replicate, k.fal]
      expect(mine.submitted().map(r => r.endpoint)).toEqual([f.endpoint])
      expect(mine.submitted()[0]!.payload).toEqual(f.body)
      expect(other.client.submit).not.toHaveBeenCalled()
      // Each card was handed off once.
      expect((k.upload.mock.calls as unknown as [Uint8Array, string][]).map(c => c[1]).sort()).toEqual([...f.files].sort())

      // The charge is priceGraph for the nodes that ran (all of them), held and settled once,
      // with the server's switches (Rotate camera prices its 2511 call while that one is on).
      // A card whose size is read (`measured`: a 1 × 1 picture) is charged on that size; a
      // video-measured family (person-swap-video) is charged on its real clip's length.
      const px = f.measured ? 1 : undefined
      const inputSeconds = f.realVideoFile ? { video: f.realVideoFile.seconds } : undefined
      const price = priceGraph(f.prompt, {
        families: runnerFamilies(), ...(px ? { inputPixels: { 1: px } } : {}), ...(inputSeconds ? { inputSeconds: { 1: inputSeconds } } : {}),
      }).credits
      expect(price).toBe(nodeCredits(f.prompt['1']!, px, runnerFamilies(), inputSeconds) + BASE_RENDER_CREDITS)
      expect(k.ledger.hold).toHaveBeenCalledTimes(1)
      expect(k.ledger.settle).toHaveBeenCalledTimes(1)
      expect(holds(k.ledger)).toEqual([['settled', price]])

      // The last event on the stream closes the stage, with that charge.
      const last = events.msgs.at(-1)!
      expect(last.type).toBe('execution_success')
      expect(last.data).toMatchObject({ prompt_id: promptIds[0], run_id: runId, credits: price, stopped: false, canvas_id: 'c1' })
      expect(events.msgs[0]).toMatchObject({ type: 'execution_start', data: { prompt_id: promptIds[0] } })
      expect(events.msgs.some(m => m.type === 'executing' && m.data.node === '1')).toBe(true)
      // A still shows itself on the node; a video node has no ui of its own (as today).
      expect(events.msgs.some(m => m.type === 'executed' && m.data.node === '1')).toBe(f.prompt['1']!.class_type !== 'GenerateVideoNode')

      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      // A pipeline (R3.6's Layerize) keeps its one call's request on the call.
      const node = run.takes[0]!.nodes['1']!
      expect((node.request ?? node.calls?.[0]?.request)!.provider).toBe(f.provider)
      expect(k.records.write).toHaveBeenCalledTimes(1)
    }
    finally { await events.close() }
  })
})

// ── 2. Replicate image → Gate → Replicate video ─────────────────────────

describe('B10 · a Replicate image feeds a Gate, which feeds a Replicate video', () => {
  const img = FLOWS.find(f => f.family === 'replicate-image')!
  const vid = FLOWS.find(f => f.family === 'replicate-video')!
  /** The fixture image node (1) → Gate (2) → the fixture video node (3) → Video card (4); image → Image card (5). */
  const gated = (seed: number): ApiPrompt => ({
    '1': { class_type: 'GenerateImageNode', inputs: { ...img.prompt['1']!.inputs, seed } },
    '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
    '3': { class_type: 'GenerateVideoNode', inputs: { ...vid.prompt['1']!.inputs, image: ['2', 0] } },
    '4': outVideo('3'),
    '5': outImage('1'),
  })

  it('Re-roll ×4, pick 2, Continue, pay for 2', async () => {
    // R3.H2: with `cards` on, a provider's picture is decoded (Python's bytesio_to_image_tensor)
    // before it is handed on, so each answer is a real 1 × 1 picture, its own colour per link.
    const colourOf = (url: string) => [...url].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7)
    const k = kit({ deps: { download: async (url: string) => { const h = colourOf(url); return { bytes: rgbPng1x1(h & 255, (h >>> 8) & 255, (h >>> 16) & 255), contentType: 'image/png' } } } })
    const seeds = [42, 43, 44, 45]
    const takes = seeds.map(gated)
    const events = await openEvents()
    try {
      // Four takes (the re-rolls), one POST.
      const { runId, promptIds } = await started(takes)
      expect(promptIds).toHaveLength(4)
      await events.until(m => m.some(x => x.type === 'gate_paused'))
      await k.engine.settled(runId)
      expect((await k.store.get(runId))!.status).toBe('paused')
      // Four Replicate pictures, each the fixture body at its own seed (take 0 is the fixture exactly); no video yet.
      const pics = k.replicate.submitted()
      expect(pics.map(r => r.endpoint)).toEqual(Array(4).fill(img.endpoint))
      expect(pics[0]!.payload).toEqual(img.body)
      expect(pics.map(r => r.payload)).toEqual(seeds.map(seed => ({ ...img.body, seed })))
      expect(k.fal.client.submit).not.toHaveBeenCalled()
      const paused = events.msgs.at(-1)!
      expect(paused.type).toBe('gate_paused')
      expect((paused.data.choices as unknown[]).length).toBe(4)
      expect(events.msgs.filter(m => m.type === 'execution_success')).toHaveLength(4)

      // Pick takes 1 and 3, Continue.
      const cont = await post(gateRoute, { runId, nodeId: '2', action: 'continue', takes: [1, 3] })
      expect(cont.status).toBe(200)
      const leg = await cont.json() as { promptIds: string[] }
      expect(leg.promptIds).toEqual([`${runId}.1.t1`, `${runId}.1.t3`])
      await events.until(m => leg.promptIds.every(p => m.some(ends(p))))
      await k.engine.settled(runId)

      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      expect(run.takes.map(t => t.nodes['2']!.status)).toEqual(['dropped', 'done', 'dropped', 'done'])
      // Two Replicate videos, each the fixture body with its own take's picture as the first frame.
      const videos = k.replicate.submitted().slice(4)
      expect(videos).toHaveLength(2)
      for (const [j, t] of [1, 3].entries()) {
        const frame = run.takes[t]!.nodes['1']!.outputs[0]!.filename
        expect(videos[j]!.endpoint).toBe(vid.endpoint)
        expect(videos[j]!.payload).toEqual({ ...vid.body, image: `https://fal.storage/${frame}` })
        expect(run.takes[t]!.nodes['3']!.request!.provider).toBe('replicate')
      }
      for (const t of [0, 2]) expect(run.takes[t]!.nodes['3']!.request ?? null).toBeNull()
      expect(k.fal.client.submit).not.toHaveBeenCalled()

      // Pay for 4 pictures (+ the render credit once) and exactly 2 videos, each at priceGraph.
      const picPrice = priceGraph({ '1': takes[0]!['1']! }).credits
      const vidPrice = priceGraph({ '3': takes[0]!['3']! }).credits
      expect(vidPrice).toBeGreaterThan(0)
      const all = [...k.ledger.holds.values()]
      const videoHolds = all.filter(h => h.key.includes('.1.'))
      expect(videoHolds.map(h => [h.state, h.actual])).toEqual([['settled', vidPrice], ['settled', vidPrice]])
      const picHolds = all.filter(h => !h.key.includes('.1.'))
      expect(picHolds.every(h => h.state === 'settled')).toBe(true)
      expect(picHolds.reduce((n, h) => n + h.actual!, 0)).toBe(4 * picPrice + BASE_RENDER_CREDITS)
      for (const p of leg.promptIds) {
        expect(events.msgs.find(ends(p))!.data).toMatchObject({ credits: vidPrice, stopped: false })
      }
      expect(events.msgs.at(-1)!.type).toBe('execution_success')
    }
    finally { await events.close() }
  })
})

// ── 3. Restart, Stop, a transient failure — on Replicate ────────────────

describe('B10 · Replicate: restart, Stop, a transient failure', () => {
  const f = FLOWS.find(x => x.family === 'replicate-image')!
  const price = priceGraph(f.prompt).credits

  it('a restart halfway through a Replicate request resumes on Replicate', async () => {
    const fal = createFakeFal()
    const replicate = createFakeReplicate()
    const ledger = createFakeLedger()
    const state = { crashed: false }
    const k1 = kit({
      fal, replicate, ledger,
      deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    replicate.holdNext(1)
    const { runId, promptIds } = await started([f.prompt])
    await until(() => (replicate.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true // the old server stops mid-request
    await new Promise(r => setTimeout(r, 20))
    expect((await k1.store.get(runId))!.takes[0]!.nodes['1']!.request).toMatchObject({ provider: 'replicate', requestId: 'pred1' })

    // A new server on the same run store. Picking up saved runs happens at
    // server start (reattach), which no route exposes, so it is called on the
    // engine directly; the browser's side still goes through the event route.
    const k2 = kit({ dir: k1.dir, root: k1.root, fal, replicate, ledger })
    const events = await openEvents()
    try {
      const pollsBefore = replicate.submitted()[0]!.polls
      expect(await k2.engine.reattach()).toBe(1)
      replicate.release()
      await events.until(m => m.some(ends(promptIds[0]!)))
      await k2.engine.settled(runId)

      expect(replicate.submitted()).toHaveLength(1) // polled again, not sent again
      expect(replicate.submitted()[0]!.polls).toBeGreaterThan(pollsBefore)
      expect(replicate.submitted()[0]!.payload).toEqual(f.body)
      expect(fal.client.submit).not.toHaveBeenCalled()
      expect(fal.client.status).not.toHaveBeenCalled()
      expect((await k2.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('done')
      expect(holds(ledger)).toEqual([['settled', price]])
      expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: price } })
    }
    finally { await events.close() }
  })

  it('Stop cancels at Replicate', async () => {
    const k = kit()
    k.replicate.holdNext(1)
    const events = await openEvents()
    try {
      const { runId, promptIds } = await started([f.prompt])
      await until(() => (k.replicate.submitted()[0]?.polls ?? 0) >= 2)
      const res = await post(stopRoute, {})
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ stopped: [runId] })
      await events.until(m => m.some(ends(promptIds[0]!)))

      expect(k.replicate.client.cancel).toHaveBeenCalledWith('replicate://pred1/cancel')
      expect(k.fal.client.cancel).not.toHaveBeenCalled()
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('stopped')
      expect(run.takes[0]!.nodes['1']!.status).toBe('stopped')
      expect(holds(k.ledger)).toEqual([['released', null]])
      expect(k.records.write).not.toHaveBeenCalled()
      expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: 0, stopped: true } })
    }
    finally { await events.close() }
  })

  it('a transient failure re-runs once and charges once', async () => {
    const k = kit()
    k.replicate.hiccupNext(1)
    const events = await openEvents()
    try {
      const { runId, promptIds } = await started([f.prompt])
      await events.until(m => m.some(ends(promptIds[0]!)))
      await k.engine.settled(runId)

      const sent = k.replicate.submitted()
      expect(sent).toHaveLength(2)
      expect(sent.map(r => [r.endpoint, r.payload])).toEqual([[f.endpoint, f.body], [f.endpoint, f.body]])
      const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
      expect(rec.status).toBe('done')
      expect(rec.request).toMatchObject({ provider: 'replicate', requestId: 'pred2', retries: 1 })
      expect(k.ledger.hold).toHaveBeenCalledTimes(1)
      expect(k.ledger.settle).toHaveBeenCalledTimes(1)
      expect(holds(k.ledger)).toEqual([['settled', price]])
      expect(k.records.write).toHaveBeenCalledTimes(1)
      expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: price } })
    }
    finally { await events.close() }
  })
})

// ── 4. A pass-through action ─────────────────────────────────────────────

describe('B10 · a pass-through action', () => {
  it('charges nothing and records nothing', async () => {
    const c = pick(FIX.nanoActions, 'Remove object pass-through', x => x.class_type === 'RemoveObjectNode' && 'passthrough' in x.call && x.passes === 'image')
    const prompt: ApiPrompt = {
      '11': imageCard('image.png'),
      '1': { class_type: c.class_type, inputs: { ...c.widgets, image: ['11', 0] } },
      '2': outImage('1'),
    }
    const k = kit()
    writeCards(k, ['image.png'])
    const events = await openEvents()
    try {
      const { runId, promptIds } = await started([prompt])
      await events.until(m => m.some(ends(promptIds[0]!)))
      await k.engine.settled(runId)

      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      expect(k.fal.client.submit).not.toHaveBeenCalled()
      expect(k.upload).not.toHaveBeenCalled()
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.ledger.settle).not.toHaveBeenCalled()
      expect(k.records.write).not.toHaveBeenCalled()
      expect(k.graphRuns.appendOutput).not.toHaveBeenCalled()
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      expect(run.charges[0]).toMatchObject({ estimate: 0, holdId: null, state: 'free', actual: 0 })
      // The node hands the card's picture on unchanged.
      expect(run.takes[0]!.nodes['1']!.outputs).toEqual(run.takes[0]!.nodes['11']!.outputs)
      expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: 0 } })
    }
    finally { await events.close() }
  })
})

// ── 5. PersonSwap's price; a 0-credit class is refused ───────────────────

describe('B10 · money', () => {
  it('PersonSwap charges 14', async () => {
    const c = pick(FIX.nanoActions, 'PersonSwap call', x => x.class_type === 'PersonSwap' && hasCall(x))
    const f = nodeFlow('nano-actions', c)
    // The node is priced (B1's price-key fix; it was 0 before): since Task P4,
    // google/nano-banana-2 on Replicate at 1K, $0.067 → 14 credits. The Image
    // cards bring the flat render credit on top, as priceGraph has it.
    expect(nodeCredits(f.prompt['1']!)).toBe(14)
    expect(priceGraph(f.prompt).breakdown).toEqual([{ action: 'base_render', credits: BASE_RENDER_CREDITS }, { action: 'PersonSwap', credits: 14 }])
    const price = 14 + BASE_RENDER_CREDITS
    const k = kit()
    writeCards(k, f.files, f.png, f.measured)
    const events = await openEvents()
    try {
      const { runId, promptIds } = await started([f.prompt])
      await events.until(m => m.some(ends(promptIds[0]!)))
      await k.engine.settled(runId)
      expect(k.replicate.submitted().map(r => [r.endpoint, r.payload])).toEqual([[f.endpoint, f.body]])
      expect(k.ledger.hold).toHaveBeenCalledWith(USER, price, `runner:${promptIds[0]}`)
      expect(holds(k.ledger)).toEqual([['settled', price]])
      expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { credits: price } })
    }
    finally { await events.close() }
  })

  it('a test-only class at 0 credits is refused', async () => {
    // A test-only rule row under a family that is on. The row table and
    // PROVIDER_TYPES are built at load time, so the row is added (and taken
    // away) here; the class has no price-book entry, so it prices at 0.
    const CLASS = 'PhaseBZeroCreditTestNode'
    const rules = RUNNER_NODE_RULES as Record<string, RunnerNodeRule>
    const providers = PROVIDER_TYPES as Set<string>
    rules[CLASS] = { family: 'fal-edit' }
    providers.add(CLASS)
    try {
      const prompt: ApiPrompt = { '1': { class_type: CLASS, inputs: { prompt: 'free lunch' } }, '2': outImage('1') }
      expect(nodeCredits(prompt['1']!)).toBe(0)
      const k = kit()
      const res = await startRun([prompt])
      expect(res.status).toBe(500)
      const body = await res.json() as { statusMessage?: string; data?: unknown }
      expect(body.statusMessage).toBe('This step has no price yet, so it can’t run')
      expect(body.data).toEqual({ nodeId: '1', classType: CLASS })
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.graphRuns.create).not.toHaveBeenCalled()
      expect(k.fal.client.submit).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    }
    finally {
      delete rules[CLASS]
      providers.delete(CLASS)
    }
  })
})

// ── 6. Each family off in turn ───────────────────────────────────────────

describe('B10 · each family switched off in turn', () => {
  it.each(FLOWS.map(f => [f.family, f] as const))('%s off: /api/runs refuses its workflow and nodesNeedingEngine names its node', async (family, f) => {
    const off = [family, ...(f.alsoOff ?? [])]
    process.env.NUXT_RUNNER_FAMILIES = RUNNER_FAMILIES.filter(x => !off.includes(x)).join(',')
    expect(runnerFamilies().has(family)).toBe(false)
    expect(runnerFamilies().size).toBe(RUNNER_FAMILIES.length - off.length)
    const k = kit()
    writeCards(k, f.files, f.png, f.measured)

    const res = await startRun([f.prompt])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string; data?: unknown }
    expect(body.statusMessage).toBe('This workflow can’t run on the Sailor runner')
    // The stable marker: the browser reads it (as $fetch's FetchError: statusCode + parsed body) and runs on ComfyUI.
    expect(body.data).toEqual({ reason: 'not-eligible' })
    expect(isRunnerDeclined({ statusCode: res.status, data: body })).toBe(true)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()

    const titleOf = (id: string) => `${f.prompt[id]!.class_type} #${id}`
    expect(nodesNeedingEngine(f.prompt, { runnerOn: true, families: runnerFamilies(), titleOf })).toEqual([titleOf('1')])
    // With the family back on, nothing needs the engine.
    process.env.NUXT_RUNNER_FAMILIES = ALL
    expect(nodesNeedingEngine(f.prompt, { runnerOn: true, families: runnerFamilies(), titleOf })).toEqual([])
  })
  it('any other refusal carries no marker, so the browser shows it rather than falling back', async () => {
    kit()
    const res = await startRun([])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string; data?: unknown }
    expect(body.statusMessage).toBe('There is nothing to run')
    expect(isRunnerDeclined({ statusCode: res.status, data: body })).toBe(false)
  })
})
