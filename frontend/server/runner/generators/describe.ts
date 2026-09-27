/**
 * Describe, read and find as runner plans (step 3, R3.4, family `describe`):
 * Describe an image and its hidden twin (moondream2), Describe a video
 * (Gemini 2.5 Flash), Extract text (Dolphin) and Find objects (YOLO-World),
 * each one Replicate call (`_run_prediction` on the slug; ruling (e): one
 * call per node, as Python) whose answer is the node's value, byte-identical
 * to Python's STRING. No backup: no same-model twin on fal is carded.
 *
 *  - A picture is sent as Python sends the first frame of its batch
 *    (`_image_tensor_to_data_url`): the handed-off file of the linked slot,
 *    as the line-up's builders send theirs.
 *  - Describe a video sends its address as typed, or, for a file uploaded
 *    to Sailor (a `/view?…&type=input` link, which the engine has read and
 *    measured: ../nodeMedia.ts), its hand-off link. Hosted takes only such a
 *    file (ruling (s); refused before the hold by the media check). It waits
 *    as a video does (Python's `_VIDEO_POLL_DEADLINE_SEC`), and is charged
 *    the tokens the prediction reports, capped by the ceiling the hold was
 *    priced from (ruling (c)); none reported, the hold.
 *  - The other three are priced per call: the charge is the hold.
 *  - A request byte-identical to one this user already made gives back that
 *    answer, free (ruling (d)).
 *  - None of them shows anything itself (Python returns no ui).
 */
import { isLink } from '#shared/runner/graph'
import { pyJsonDumps, pyStr, type PyJson } from '#shared/runner/pyJson'
import { pyFloatOf, pyStrip } from '#shared/runner/pyText'
import { llmText, pyFalsy } from '#shared/runner/llm'
import {
  DESCRIBE_ENDPOINTS, DESCRIBE_VIDEO_NEEDS_LINK, DESCRIBE_VIDEO_UPLOAD_ONLY, describeVideoSource, type DescribeClass,
} from '#shared/runner/describe'
import { priceNode } from '#shared/pricing/nodePrice'
import type { NodePlan, PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'
import type { RunnerValue } from '../types'
import { answerOutput, answerUsage } from './llm'

const DESCRIBE_CLASS_SET: ReadonlySet<string> = new Set(Object.keys(DESCRIBE_ENDPOINTS))

export function isDescribeClass(classType: string): classType is DescribeClass {
  return DESCRIBE_CLASS_SET.has(classType)
}

/** ComfyUI's str(val) for a STRING input (missing = its default ""). */
function strOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

/** ComfyUI's float(val) for a FLOAT widget (missing = the widget's default). */
function floatOf(v: unknown, def: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyFloatOf(v) ?? def
  return def
}

// ── What each node sends (its Python, as ported) ──

/** Describe an image and its twin (:4830, :2129-2133): the picture and the prompt as typed. */
export function describeImageInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  return { image, prompt: strOf(inputs.prompt) }
}

/** Describe a video (:5381-5384): the prompt as typed, the video in a list. */
export function describeVideoInput(inputs: Record<string, unknown>, video: string): Record<string, unknown> {
  return { prompt: strOf(inputs.prompt), videos: [video] }
}

/** Extract text (:5175-5178): the picture as `file`, markdown out. */
export function extractTextInput(image: string): Record<string, unknown> {
  return { file: image, output_format: 'markdown_content' }
}

/** Find objects (:5238-5241): the picture, the query as typed, the confidence (0.25 its default). */
export function findObjectsInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  return { input_media: image, class_names: strOf(inputs.query), score_thr: floatOf(inputs.confidence, 0.25) }
}

// ── What each node hands on ──

/** Python's `x.get(key)` of a JSON object (None when absent). */
function getKey(v: PyJson, key: string): PyJson {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'obj' in v) {
    const hit = v.obj.find(([k]) => k === key)
    return hit ? hit[1] : null
  }
  return null
}

/**
 * Extract text's text (:5180-5190): a list joined with "\n" from `str()` of
 * each item; a dict's `text or markdown or transcription or ""` through
 * `str()`; a string as it is; anything else ""; then `.strip()`. A list or
 * dict where Python would print its repr fails plainly (PY_STR_UNREADABLE).
 */
export function extractTextOf(out: PyJson): string {
  let text: string
  if (Array.isArray(out)) text = out.map(pyStr).join('\n')
  else if (out && typeof out === 'object' && 'obj' in out) {
    const pick = [getKey(out, 'text'), getKey(out, 'markdown'), getKey(out, 'transcription')].find(v => !pyFalsy(v))
    text = pick === undefined ? '' : pyStr(pick)
  }
  else if (typeof out === 'string') text = out
  else text = ''
  return pyStrip(text)
}

/**
 * Find objects' JSON (:5245): the answer's `output` as it is when it is a
 * string, else `json.dumps` of it as json.loads read it (numbers keep their
 * int or float form, keys their order; ensure_ascii, Python's separators).
 */
export function findObjectsJson(result: unknown, raw: string | null): string {
  const out = answerOutput(result, raw)
  return typeof out === 'string' ? out : pyJsonDumps(out)
}

/**
 * The node's one value, from the answer. A dict where Python would print its
 * repr (a top-level dict from Describe an image or a video, a list holding a
 * dict or a list, a dict or list under Extract text's `text`) fails the node
 * plainly (PY_STR_UNREADABLE) instead: R3.3's ruling for nested answers,
 * extended to top-level dicts (R3.4 fix round 1). None of these models
 * answers so.
 */
function valueOf(classType: DescribeClass, result: unknown, raw: string | null): RunnerValue {
  if (classType === 'FindObjectsNode') return { kind: 'json', text: findObjectsJson(result, raw) }
  const out = answerOutput(result, raw)
  return { kind: 'text', text: classType === 'ExtractTextNode' ? extractTextOf(out) : llmText(out) }
}

/** The node's plan: one Replicate call whose answer is its text (or JSON). */
export async function planDescribe(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as DescribeClass
  const inputs = node.inputs ?? {}
  const endpoint = DESCRIBE_ENDPOINTS[classType]
  /** The linked picture's first file, handed off (Python sends the batch's first frame). */
  const picture = async (): Promise<string> => {
    const v = inputs.image
    const f = isLink(v) ? ctx.filesFrom(v)[0] : undefined
    if (!f) throw new Error('There is no picture to look at')
    return imageUrlOf(ctx, f, v)
  }
  let payload: Record<string, unknown>
  switch (classType) {
    case 'DescribeImageNode':
    case 'DescribeImageRemoteNode':
      payload = describeImageInput(inputs, await picture())
      break
    case 'ExtractTextNode':
      payload = extractTextInput(await picture())
      break
    case 'FindObjectsNode':
      payload = findObjectsInput(inputs, await picture())
      break
    case 'DescribeVideoNode': {
      const s = describeVideoSource(inputs.video_url)
      if ('blank' in s) throw new Error(DESCRIBE_VIDEO_NEEDS_LINK)
      if ('refused' in s) throw new Error(s.refused)
      // Hosted: only a file uploaded to Sailor (the media check refused anything else before the hold).
      if ('address' in s && ctx.hosted) throw new Error(DESCRIBE_VIDEO_UPLOAD_ONLY)
      const video = 'inputFile' in s ? await ctx.toUrl({ filename: s.inputFile, subfolder: '', type: 'input' }) : s.address
      payload = describeVideoInput(inputs, video)
      break
    }
  }
  const tokens = classType === 'DescribeVideoNode'
  return {
    kind: 'provider', provider: 'replicate', endpoint, payload,
    media: 'value', prefix: 'describe',
    reuse: 'same-request',
    ...(tokens ? { wait: 'video' as const } : {}),
    valuesOf: (result, raw) => ({ 0: valueOf(classType, result, raw) }),
    // Python returns no ui: the node shows nothing itself (a Text card after it does).
    uiFor: () => null,
    ...(tokens
      ? {
          chargeOf: (result: unknown) => {
            const used = answerUsage(result)
            if (!used) return null
            // Priced as the hold was (metering.ts nodeCredits: the node as sent, the video as measured).
            const p = priceNode(classType, ctx.priceInputs ?? inputs, { answerUsage: used, ...(ctx.measured ? { inputSeconds: ctx.measured } : {}) })
            return 'refused' in p ? null : p.credits
          },
        }
      : {}),
  }
}
