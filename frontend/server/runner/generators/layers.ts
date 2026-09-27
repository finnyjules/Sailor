/**
 * Layers from one call, and outpaint, as runner plans (step 3, R3.6, family
 * `layers`): LayerizeGraphicNode ("Separate text from image"),
 * SeedreamLayerizeNode ("Layerize an image") and OutpaintImageNode ("Expand /
 * outpaint an image"), each one provider call built as its Python builds it.
 * No backup: no same-model twin on the other service is carded.
 *
 *  - A picture is sent as Python sends the first frame of its batch
 *    (`_image_tensor_to_data_url`): the handed-off file of the linked slot.
 *  - Separate text from image is a `pipeline` of its one call and its two
 *    downloads: the picture (the first answer URL with a picture extension,
 *    else the first that isn't the JSON), saved as downloaded and shown
 *    under `layerize`; then the layer JSON's body text as it came, handed on
 *    as a `json` value (a fetch that fails gives Python's error JSON, with
 *    the runner's own words for why).
 *  - Layerize an image is a `pipeline` of its one fal call and its
 *    downloads: each layer saved as the RGBA PNG Python's
 *    `save_image_to_input` writes, into the input folder (the user's own in
 *    hosted, ruling (o)), named in the JSON it hands on; the preview is the
 *    answer's flat picture, else the input picture. Charged by the pictures
 *    that came back (fal bills each), never above its hold.
 *  - Expand / outpaint is one Replicate call whose first answer URL is its
 *    picture, alpha dropped (Python's `tensor[..., :3]`, rule 3: `rgb`); it
 *    shows nothing itself.
 */
import { isLink } from '#shared/runner/graph'
import { parsePyJson, pyJsonDumps, pyStr, type PyJson } from '#shared/runner/pyJson'
import { PY_INT_RE, pyNumStrip, pyStrip } from '#shared/runner/pyText'
import { pyFalsy } from '#shared/runner/llm'
import {
  LAYERIZE_SLUG, OUTPAINT_SLUGS, SEEDREAM_IMAGE_SIZES, SEEDREAM_LAYERIZE_APP, type LayersClass, type OutpaintModel,
} from '#shared/runner/layers'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { seedreamCallAnswered, seedreamCallCeiling } from '#shared/pricing/paidSettings'
import { MAX_VALUE_TEXT_CHARS } from '../values'
import { answerExt } from '../answerDownload'
import { answerRgbaPng } from '../pictures/pythonView'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { firstOutputUrl } from './repair'

// ── A widget as ComfyUI hands it to execute (missing: the node's default) ──

/** str(val) for a STRING widget (missing: its default ""). */
function strOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

/** int(val) for an INT widget (missing: its default 0). */
function intOf(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const t = pyNumStrip(v)
    if (PY_INT_RE.test(t)) return Number.parseInt(t.replace(/_/g, ''), 10)
  }
  throw new Error('This number setting must be a whole number')
}

/** A COMBO widget's option (ComfyUI has checked it is one). */
function comboOf(v: unknown, def: string): string {
  if (v === undefined) return def
  if (typeof v !== 'string') throw new Error('This setting must be one of its options')
  return v
}

// ── What each node sends (its Python, as ported) ──

/**
 * Separate text from image (:4496-4500): the picture as
 * `flat_graphic_image`, the prompt stripped only when it isn't blank, the
 * seed only above 0.
 */
export function layerizeInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { flat_graphic_image: image }
  const prompt = pyStrip(strOf(inputs.prompt))
  if (prompt) payload.prompt = prompt
  const seed = intOf(inputs.seed)
  if (seed > 0) payload.seed = seed
  return payload
}

/**
 * Layerize an image: `seedream_layerize_input` (seedream_layerize.py:12-19):
 * the prompt as typed (`prompt or ""`), the picture, and `image_size` when it
 * is one of the four, else `auto`.
 */
export function seedreamLayerizeInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  const size = inputs.image_size === undefined ? 'auto' : inputs.image_size
  return {
    prompt: strOf(inputs.prompt),
    image_url: image,
    image_size: typeof size === 'string' && (SEEDREAM_IMAGE_SIZES as readonly string[]).includes(size) ? size : 'auto',
  }
}

/** A Replicate call: the slug and the input dict. */
export interface LayersCall { endpoint: string; payload: Record<string, unknown> }

/**
 * Expand / outpaint (:4773-4793): the prompt stripped. Flux Fill sends the
 * direction as `outpaint`, the prompt even when blank, PNG and safety 6;
 * Bria Expand the aspect ratio, and the prompt only when it isn't blank.
 * Both send the seed only above 0.
 */
export function outpaintInput(inputs: Record<string, unknown>, image: string): LayersCall {
  const model = comboOf(inputs.model, 'Flux Fill')
  const prompt = pyStrip(strOf(inputs.prompt))
  const seed = intOf(inputs.seed)
  let payload: Record<string, unknown>
  if (model === 'Flux Fill') {
    payload = { image, outpaint: comboOf(inputs.direction, 'Zoom out 1.5x'), prompt, output_format: 'png', safety_tolerance: 6 }
  }
  else if (model === 'Bria Expand') {
    payload = { image, aspect_ratio: comboOf(inputs.aspect_ratio, '16:9') }
    if (prompt) payload.prompt = prompt
  }
  else {
    throw new Error(`The runner cannot expand a picture with ${model}`)
  }
  if (seed > 0) payload.seed = seed
  return { endpoint: OUTPAINT_SLUGS[model as OutpaintModel], payload }
}

// ── What comes back ──

/** `_all_output_urls` (replicate_refs.py:261-267): a list's text items, a text alone, else none. */
function allOutputUrls(result: unknown): string[] {
  const out = result && typeof result === 'object' ? (result as Record<string, unknown>).output : undefined
  if (Array.isArray(out)) return out.filter((u): u is string => typeof u === 'string')
  return typeof out === 'string' ? [out] : []
}

/** Layerize's `_ext`: the text after the last dot of the address before any `?`, lower-cased. */
function extOf(u: string): string {
  const path = u.toLowerCase().split('?')[0]!
  const dot = path.lastIndexOf('.')
  return dot < 0 ? path : path.slice(dot + 1)
}

const PICTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])

/**
 * Layerize's answer (:4503-4516): every URL, the picture (the first with a
 * picture extension, else the first that isn't the JSON) and the JSON link
 * (the first ending `.json`).
 */
export function layerizeUrls(result: unknown): { urls: string[]; image: string | null; json: string | null } {
  const urls = allOutputUrls(result)
  const json = urls.find(u => extOf(u) === 'json') ?? null
  const image = urls.find(u => PICTURE_EXTS.has(extOf(u))) ?? urls.find(u => u !== json) ?? null
  return { urls, image, json }
}

export const LAYERIZE_NO_OUTPUT = 'The service sent back nothing to separate'
export const LAYERIZE_NO_PICTURE = 'The service sent back no background picture'
export const LAYER_DATA_UNREADABLE = 'it is in a character set Sailor can’t read'
export const LAYER_DATA_TOO_LONG = 'it is too long to keep'

/**
 * The layer JSON's body as aiohttp's `r.text()` reads it: the charset the
 * answer names, else UTF-8 (application/json's, and aiohttp's own
 * fallback), strictly, a byte-order mark kept. The runner reads UTF-8 and
 * ASCII; another named charset is a failed fetch (thrown, in plain words).
 */
export function layerDataText(bytes: Uint8Array, contentType: string | null): string {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')
  const charset = (m?.[1] ?? 'utf-8').toLowerCase().replace(/_/g, '-')
  let text: string
  if (['utf-8', 'utf8', 'u8', 'utf'].includes(charset)) {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new Error('it isn’t valid UTF-8 text') }
  }
  else if (['ascii', 'us-ascii', '646'].includes(charset)) {
    if (bytes.some(b => b > 0x7f)) throw new Error('it isn’t valid ASCII text')
    text = String.fromCharCode(...bytes)
  }
  else throw new Error(LAYER_DATA_UNREADABLE)
  if (text.length > MAX_VALUE_TEXT_CHARS) throw new Error(LAYER_DATA_TOO_LONG)
  return text
}

/** Why the layer JSON couldn't be fetched, in the runner's own words (Python prints aiohttp's). */
export function layerDataWhy(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  // The download's own plain words (answerDownload.ts, falQueue.ts downloadResult) and layerDataText's.
  if (/^(Could not download|The data |The service’s result|it )/.test(msg)) return msg.charAt(0).toLowerCase() + msg.slice(1)
  return 'the connection failed'
}

/** Python's `json.dumps({"error": f"failed to fetch layer data: {why}"})` (:4527). */
export function layerDataError(why: string): string {
  return pyJsonDumps({ obj: [['error', `failed to fetch layer data: ${why}`]] })
}

/**
 * The layer JSON (:4520-4528): its body text as it came, or, when the
 * fetch fails (30 seconds, the runner's safe fetch), the error JSON. Python
 * keeps a failed status's body (aiohttp reads any status); the runner treats
 * it as a failed fetch. The call stays delivered either way.
 */
async function layerData(io: PipelineIO, url: string): Promise<string> {
  try {
    const got = await io.download(url, { kind: 'json', optional: true })
    return layerDataText(got.bytes, got.contentType)
  }
  catch (e) {
    if (io.signal.aborted) throw e
    return layerDataError(layerDataWhy(e))
  }
}

// ── Seedream's answer: `parse_seedream_layers` (seedream_layerize.py:23-60) ──

/** What the Seedream answer is not, in plain words (Python raises on it). */
export const SEEDREAM_ANSWER_UNREADABLE = 'The service answered in a form Sailor can’t read'

const isObj = (v: PyJson): v is { obj: [string, PyJson][] } => !!v && typeof v === 'object' && !Array.isArray(v) && 'obj' in v

/** Python's `d.get(key)` (None when absent). */
function getKey(v: { obj: [string, PyJson][] }, key: string): PyJson | undefined {
  let hit: PyJson | undefined
  for (const [k, x] of v.obj) if (k === key) hit = x
  return hit
}

/** `d.get(key) or default`: the value when truthy. */
function getOr(v: { obj: [string, PyJson][] }, key: string): PyJson | null {
  const x = getKey(v, key)
  return x === undefined || pyFalsy(x) ? null : x
}

/** Python `int(v)` of a JSON value, as its exact digits (an int of any size); raises where int() does. */
export function pyIntJson(v: PyJson): { int: string } {
  if (v === true || v === false) return { int: v ? '1' : '0' }
  if (typeof v === 'string') {
    const t = pyNumStrip(v)
    if (!PY_INT_RE.test(t)) throw new Error(SEEDREAM_ANSWER_UNREADABLE)
    return { int: BigInt(t.replace(/_/g, '').replace(/^\+/, '')).toString() }
  }
  if (v && typeof v === 'object' && 'int' in v) return { int: BigInt(v.int).toString() }
  if (v && typeof v === 'object' && 'float' in v) {
    if (!Number.isFinite(v.float)) throw new Error(SEEDREAM_ANSWER_UNREADABLE)
    return { int: BigInt(Math.trunc(v.float)).toString() }
  }
  throw new Error(SEEDREAM_ANSWER_UNREADABLE)
}

/**
 * Python iterating `v` (a truthy value `or []` left): a list's items, a
 * dict's keys, a string's characters; a number or true can't be iterated.
 */
function pyItems(v: PyJson): PyJson[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [...v]
  if (isObj(v)) return v.obj.map(([k]) => k)
  throw new Error(SEEDREAM_ANSWER_UNREADABLE)
}

/** Python's `v[0]` of a truthy value: a list's first item, a string's first character; a dict or a number raises. */
function pyFirst(v: PyJson): PyJson {
  if (Array.isArray(v)) return v[0]!
  if (typeof v === 'string') return v[0]!
  throw new Error(SEEDREAM_ANSWER_UNREADABLE)
}

/** One layer as `parse_seedream_layers` keeps it. */
export interface SeedreamLayer {
  url: string
  z_index: { int: string }
  box: PyJson[] | null
  name: string
  description: string
  width: { int: string }
  height: { int: string }
}

/**
 * `parse_seedream_layers(result)`: the layers that carry an image URL, in
 * order (a non-dict layer, or one whose `image.url` isn't text, is left out),
 * each with its z_index as int(), its `bounding_box.absolute` when a list of
 * four (else None), its name and description as str() (None or empty: ""),
 * and the base picture's size: the first z_index 0 layer with a width, else
 * `images[0]`'s, else 0. Python's AttributeError / TypeError / ValueError on
 * a malformed answer fail the node plainly.
 */
export function parseSeedreamLayers(result: PyJson): { layers: SeedreamLayer[]; width: { int: string }; height: { int: string } } {
  if (!pyFalsy(result) && !isObj(result)) throw new Error(SEEDREAM_ANSWER_UNREADABLE)
  const root = isObj(result) ? result : { obj: [] as [string, PyJson][] }
  const raw = getOr(root, 'layers')
  const out: SeedreamLayer[] = []
  for (const layer of raw === null ? [] : pyItems(raw)) {
    if (!isObj(layer)) continue
    const imgV = getOr(layer, 'image')
    if (imgV !== null && !isObj(imgV)) throw new Error(SEEDREAM_ANSWER_UNREADABLE)
    const img = imgV ?? { obj: [] }
    const url = getKey(img, 'url')
    if (typeof url !== 'string') continue
    const bboxV = getOr(layer, 'bounding_box')
    const abs = bboxV === null ? null : isObj(bboxV) ? (getKey(bboxV, 'absolute') ?? null) : null
    const box = Array.isArray(abs) && abs.length === 4 ? abs : null
    const z = getKey(layer, 'z_index')
    out.push({
      url,
      z_index: pyIntJson(z === undefined ? { int: '0' } : z),
      box,
      name: pyStr(getOr(layer, 'name') ?? ''),
      description: pyStr(getOr(layer, 'description') ?? ''),
      width: pyIntJson(getOr(img, 'width') ?? { int: '0' }),
      height: pyIntJson(getOr(img, 'height') ?? { int: '0' }),
    })
  }
  const base = out.find(l => l.z_index.int === '0' && l.width.int !== '0')
  if (base) return { layers: out, width: base.width, height: base.height }
  const imgs = getOr(root, 'images')
  const firstV = imgs === null ? null : pyFirst(imgs)
  const first = firstV !== null && isObj(firstV) ? firstV : { obj: [] as [string, PyJson][] }
  return { layers: out, width: pyIntJson(getOr(first, 'width') ?? { int: '0' }), height: pyIntJson(getOr(first, 'height') ?? { int: '0' }) }
}

/** The answer as Python's `json.loads` read it (numbers keep their written form). */
function answerJson(result: unknown, raw: string | null): PyJson {
  return parsePyJson(raw ?? JSON.stringify(result ?? null))
}

/** How many pictures a Seedream answer holds: its `images` or its `layers`, whichever lists more (fal bills each). */
export function seedreamImagesMade(answer: PyJson): number {
  if (!isObj(answer)) return 0
  const n = (k: string) => { const v = getKey(answer, k); return Array.isArray(v) ? v.length : 0 }
  return Math.max(n('images'), n('layers'))
}

/**
 * A Seedream call's price basis as answered: the pictures that came back, at
 * the rate their area takes (the base picture's size; not known, the dearer
 * rate). Null when the answer can't be read (the call is charged its hold).
 */
export function seedreamAnsweredUsd(result: unknown, raw: string | null): number | null {
  let answer: PyJson
  try { answer = answerJson(result, raw) }
  catch { return null }
  let pixels: number | null = null
  try {
    const { width, height } = parseSeedreamLayers(answer)
    const px = Number(width.int) * Number(height.int)
    pixels = Number.isFinite(px) && px > 0 ? px : null
  }
  catch { pixels = null }
  return paidCallUsd(seedreamCallAnswered(seedreamImagesMade(answer), pixels))
}

// ── The plans ──

/** A saved file as the Frame names it in the layers' JSON: `sub/name` in hosted (the user's own subfolder), the bare name locally (Python's). */
const inputName = (f: OutputFile): string => (f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename)

/** The node's ui: its picture, and its JSON as `text` when Python shows it. */
const shown = (file: OutputFile, text: string | null): Record<string, unknown> => ({ images: [file], animated: [false], ...(text !== null ? { text: [text] } : {}) })

function layerizePlan(inputs: Record<string, unknown>, image: string): NodePlan {
  const payload = layerizeInput(inputs, image)
  const usd = paidCallUsd({ endpoint: LAYERIZE_SLUG })
  if (usd == null) throw new Error('Separate text from image has no price yet')
  return {
    kind: 'pipeline', prefix: 'layerize',
    run: async (io) => {
      const r = await io.call({ key: 'layerize', provider: 'replicate', endpoint: LAYERIZE_SLUG, payload, media: 'value', usd })
      const { urls, image: picture, json } = layerizeUrls(r.result)
      if (!urls.length) throw new Error(LAYERIZE_NO_OUTPUT)
      if (!picture) throw new Error(LAYERIZE_NO_PICTURE)
      // The picture as downloaded (Python keeps its alpha), shown under `layerize` (save_generation_output).
      const got = await io.download(picture)
      const file = await io.saveAsset(got.bytes, { prefix: 'layerize', ext: answerExt('image', got.bytes, got.contentType, picture) })
      const text = json ? await layerData(io, json) : ''
      const values: Record<number, RunnerValue> = { 0: { kind: 'files', files: [file] }, 1: { kind: 'json', text } }
      return { values, ui: shown(file, text ? text : null) }
    },
  }
}

function seedreamPlan(ctx: PlanContext, inputs: Record<string, unknown>, image: string, source: OutputFile): NodePlan {
  const payload = seedreamLayerizeInput(inputs, image)
  // Held at the most the call can make, priced from the node as sent (never a wired value).
  const usd = paidCallUsd(seedreamCallCeiling(ctx.priceInputs ?? inputs))
  if (usd == null) throw new Error('Layerize an image has no price yet')
  return {
    kind: 'pipeline', prefix: 'seedream_layerize',
    run: async (io) => {
      const r = await io.call({
        key: 'layerize', provider: 'fal', endpoint: SEEDREAM_LAYERIZE_APP, payload, media: 'value', usd,
        usdOf: seedreamAnsweredUsd,
      })
      const answer = answerJson(r.result, r.raw)
      const { layers, width, height } = parseSeedreamLayers(answer)
      // Each layer as save_image_to_input writes it: an RGBA PNG in the input folder, in order.
      const kept: PyJson[] = []
      for (const l of layers) {
        const got = await io.download(l.url)
        const f = await io.saveAsset(await answerRgbaPng(got.bytes), { prefix: 'seedream_layer', ext: 'png', folder: 'input' })
        kept.push({ obj: [['filename', inputName(f)], ['z_index', l.z_index], ['box', l.box], ['name', l.name], ['description', l.description]] })
      }
      const json = pyJsonDumps({ obj: [['source', 'seedream'], ['width', width], ['height', height], ['layers', kept]] })
      // The preview: the answer's flat picture (images[0].url), else the input picture.
      // (Python reads `result.get("images")` here without `or {}`: an answer that isn't a dict fails.)
      if (!isObj(answer)) throw new Error(SEEDREAM_ANSWER_UNREADABLE)
      const imgs = getOr(answer, 'images')
      const first = imgs === null ? null : pyFirst(imgs)
      const url = first !== null && isObj(first) ? getOr(first, 'url') : null
      let preview: OutputFile
      if (url !== null) {
        if (typeof url !== 'string') throw new Error(SEEDREAM_ANSWER_UNREADABLE)
        const got = await io.download(url)
        preview = await io.saveAsset(got.bytes, { prefix: 'seedream_layerize', ext: answerExt('image', got.bytes, got.contentType, url) })
      }
      else {
        // Python saves the input picture itself; the runner saves a copy of its file.
        const bytes = await io.read(source)
        const ext = answerExt('image', bytes, null, source.filename)
        preview = await io.saveAsset(bytes, { prefix: 'seedream_layerize', ext })
      }
      const values: Record<number, RunnerValue> = { 0: { kind: 'files', files: [preview] }, 1: { kind: 'json', text: json } }
      return { values, ui: shown(preview, kept.length ? json : null) }
    },
  }
}

function outpaintPlan(inputs: Record<string, unknown>, image: string): NodePlan {
  const call = outpaintInput(inputs, image)
  return {
    kind: 'provider', provider: 'replicate', endpoint: call.endpoint, payload: call.payload,
    media: 'image', take: 'first',
    urlsOf: firstOutputUrl,
    // Python drops alpha before its output (:4796-4798).
    rgb: true,
    prefix: 'outpaint',
    // Python returns no ui: the node shows nothing itself.
    uiFor: () => null,
  }
}

/** The node's plan (Separate text from image, Layerize an image, Expand / outpaint). */
export async function planLayers(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as LayersClass
  const inputs = node.inputs ?? {}
  const link = inputs.image
  const file = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!file) throw new Error('There is no picture to work on')
  const image = await ctx.toUrl(file)
  switch (classType) {
    case 'LayerizeGraphicNode': return layerizePlan(inputs, image)
    case 'SeedreamLayerizeNode': return seedreamPlan(ctx, inputs, image, file)
    case 'OutpaintImageNode': return outpaintPlan(inputs, image)
  }
}
