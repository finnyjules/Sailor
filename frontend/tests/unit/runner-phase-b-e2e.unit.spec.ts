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
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, until } from './__runner__/kit'
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
function writeCards(k: ReturnType<typeof makeKit>, files: string[], png = false) {
  files.forEach((f, i) => writeFileSync(join(k.root, 'input', f), new Uint8Array([...(png ? PNG_SIGNATURE : []), i + 1, 7, 7])))
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
    expect(FLOWS.map(f => f.family).sort()).toEqual(RUNNER_FAMILIES.filter(f => f !== 'frame').sort())
  })

  it.each(FLOWS.map(f => [`${f.family}: ${f.label} → ${f.endpoint}`, f] as const))('%s', async (_l, f) => {
    const k = kit()
    writeCards(k, f.files, f.png)
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
      const price = priceGraph(f.prompt, { families: runnerFamilies() }).credits
      expect(price).toBe(nodeCredits(f.prompt['1']!, undefined, runnerFamilies()) + BASE_RENDER_CREDITS)
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
      expect(run.takes[0]!.nodes['1']!.request!.provider).toBe(f.provider)
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
    const k = kit()
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
    writeCards(k, f.files, f.png)
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
    writeCards(k, f.files, f.png)

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
