/**
 * Shared helpers for the paid-node parity specs (step 3, R3 rule 16): a case
 * written by scripts/runner_paid_fixtures.py (runner-paid-<group>.json) run
 * through planNode and the kit with Python's own answers, and the calls it
 * sent compared with the calls Python made, in order.
 *
 * Pictures: each picture input of a case is a LoadImage of `<input>.png` (an
 * RGB PNG, which the LoadImage card hands on as it is), so the handed-off
 * link is `https://fal.storage/<input>.png`, compared with Python's
 * `IMG:<input>`. Sounds the same way: `<input>.wav` ↔ `WAV:<input>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { parsePyJson, pyJsonDumps, type PyJson } from '#shared/runner/pyJson'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { isAudioGenClass } from '#shared/runner/audioGen'
import { createFakeFal, createFakeReplicate, makeKit, type FakeRequest } from './kit'

/**
 * One provider call as Python made it (capture_calls). `payload_json`: the
 * payload as Python's wire has it (json.dumps, keys sorted), so a float
 * written `1.0` is told from an int `1`; absent on hand-made calls.
 */
export interface PyCall { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; payload_json?: string }

/** A GET a node made: its URL and the status served (capture_calls `gets`). */
export interface PyGet { url: string; status: number | null }

/** A JSON link's body as served: its text, a status with a text (a 404), or a fetch that fails outright (R3.6). */
export type LinkBody = string | { status: number; text: string } | { raise: string }

/** A body text given as it is (numbers keep their written form): `{ __body__: '<text>' }`. */
export interface RawBody { __body__: string }

export interface PaidCase {
  name: string
  class_type: string
  /** The node's widget values, as typed. */
  widgets: Record<string, unknown>
  /** Picture inputs, by input name: each fed by a LoadImage of `<name>.png`. */
  pictures?: string[]
  /** Sound inputs, by input name (the runner's sound source is set up by the task that needs it). */
  sounds?: string[]
  /** The provider's answers in call order: Replicate's prediction, fal's result body, or a raw body text. */
  answers: unknown[]
  /** The input files Python was given, base64, by input name (else a small picture of its own per input). */
  picture_files?: Record<string, string>
  sound_files?: Record<string, string>
  /** Linked JSON files the node fetches, by URL (a status besides 200 as `{ status, text }`). */
  links?: Record<string, LinkBody>
  /** Answer files the node downloads, base64, by URL. */
  files?: Record<string, string>
  /** Every GET Python made, in order. */
  gets?: PyGet[]
  /** Python's calls, in order. */
  calls: PyCall[]
  /** What Python's execute returned (strings verbatim; a picture as the URL it came from). */
  output: unknown
  /** Python's ui. */
  ui: unknown
  /** Python raised instead: its type and message. */
  error?: { type: string; message: string }
}

export interface SentCall { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }

export interface PaidRun {
  /** Every request the engine sent, in order, with its service. */
  sent: (FakeRequest & { provider: 'fal' | 'replicate' })[]
  values: Record<number, RunnerValue> | undefined
  files: OutputFile[]
  /** The node's price in credits (its record). */
  credits: number
  /** The node's record status and error, for cases that fail. */
  status: string
  error: string | null
}

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const NODE = 'n'

const isRaw = (a: unknown): a is RawBody => !!a && typeof a === 'object' && typeof (a as RawBody).__body__ === 'string'

/** A small RGB PNG of its own colour per input, so two pictures are never the same bytes. */
async function pictureBytes(name: string): Promise<Uint8Array> {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const px = Buffer.from([h & 255, (h >> 8) & 255, (h >> 16) & 255].flatMap(v => [v, v, v, v]).slice(0, 12))
  return new Uint8Array(await sharp(px, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer())
}

const PICTURE = /\.(png|jpe?g|webp|gif)(\?|$)/i

/**
 * Runs a case: the node fed its widgets and a LoadImage per picture input,
 * the fake providers answering the case's answers in call order, and the
 * answers' files downloaded from the case (a JSON link's text, else a small
 * picture or the URL's own bytes).
 */
export async function runPaidCase(c: PaidCase, o: { families: ReadonlySet<RunnerFamily>; hosted?: boolean; root?: string }): Promise<PaidRun> {
  // Each request gets the next answer when it is sent (keyed by its payload,
  // which the fakes hand back as `input`), however often its body is read.
  const queue = [...c.answers]
  const answerOf = new Map<unknown, unknown>()
  const bodyOf = (input: unknown, wrap: (a: Record<string, unknown>) => unknown) => {
    const a = answerOf.get(input)
    return isRaw(a) ? a.__body__ : JSON.stringify(wrap(a as Record<string, unknown>))
  }
  const fal = createFakeFal({ bodyText: ({ input }) => bodyOf(input, a => a) })
  const replicate = createFakeReplicate({ bodyText: ({ input }) => bodyOf(input, a => ({ id: 'pred', status: 'succeeded', ...a })) })
  const sent: PaidRun['sent'] = []
  for (const [provider, fake] of [['fal', fal], ['replicate', replicate]] as const) {
    const submit = fake.client.submit
    fake.client.submit = (async (endpoint: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      if (!queue.length) throw new Error(`${c.name}: the node made more calls than Python`)
      answerOf.set(payload, queue.shift())
      const r = await (submit as (...a: unknown[]) => Promise<{ requestId: string }>)(endpoint, payload, ...rest)
      sent.push({ ...fake.reqs.get(r.requestId)!, provider })
      return r
    }) as typeof submit
  }
  // Served exactly as Python's capture served them: a GET the case doesn't serve fails the case.
  const download = async (url: string) => {
    const link = c.links && Object.prototype.hasOwnProperty.call(c.links, url) ? c.links[url]! : undefined
    if (link !== undefined) {
      if (typeof link === 'object' && 'raise' in link) throw new Error(link.raise)
      const { status, text } = typeof link === 'string' ? { status: 200, text: link } : link
      if (status !== 200) throw new Error(`HTTP ${status} for ${url}`)
      return { bytes: new TextEncoder().encode(text), contentType: 'application/json' }
    }
    if (c.files && Object.prototype.hasOwnProperty.call(c.files, url)) {
      return { bytes: new Uint8Array(Buffer.from(c.files[url]!, 'base64')), contentType: PICTURE.test(url) ? 'image/png' : null }
    }
    throw new Error(`${c.name}: GET ${url} is not served by the case`)
  }
  // `root` (R3.13): the engine folder the kit works in, set up by the caller (a models/loras/ of its own).
  const k = makeKit({ hosted: o.hosted, root: o.root, fal, replicate, deps: { download, families: () => o.families } })

  const prompt: ApiPrompt = { [NODE]: { class_type: c.class_type, inputs: { ...c.widgets } }, ...readerFor(c.class_type) }
  for (const name of c.pictures ?? []) {
    const file = `${name}.png`
    mkdirSync(join(k.root, 'input'), { recursive: true })
    const given = c.picture_files?.[name]
    writeFileSync(join(k.root, 'input', file), given ? new Uint8Array(Buffer.from(given, 'base64')) : await pictureBytes(name))
    prompt[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: file, upload: 'image' } }
    prompt[NODE]!.inputs[name] = [`p_${name}`, 0]
  }
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const rec = (await k.store.get(runId))!.takes[0]!.nodes[NODE]!
  return { sent, values: rec.values, files: rec.outputs, credits: rec.credits, status: rec.status, error: rec.error }
}

/**
 * A card that shows the node's result, for a class that is not an output
 * node itself: ComfyUI (and the runner, R3.8 fix round 1) never runs a node
 * no output reads. A sound goes to an Audio card, a picture to an Image card.
 */
export function readerFor(classType: string, id = NODE): ApiPrompt {
  if (RUNNER_OUTPUT_CLASSES.has(classType)) return {}
  if (isAudioGenClass(classType)) {
    return { [`${id}_card`]: { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: [id, 0] } } }
  }
  if (VIDEO_CLASSES.has(classType)) {
    return { [`${id}_card`]: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [id, 0] } } }
  }
  return { [`${id}_card`]: { class_type: 'Image', inputs: { image: '', export: false, images: [id, 0], batch_index: -1 } } }
}

/**
 * The prompt with a card after each node nothing reads that is not an output
 * node itself (readerFor), so each one runs, as it would on a canvas (the
 * canvas adds such a card at Run: VueNodeCanvas's auto-sink).
 */
export function showing(prompt: ApiPrompt): ApiPrompt {
  const read = new Set(Object.values(prompt).flatMap(n => Object.values(n.inputs ?? {}).filter(v => Array.isArray(v) && v.length === 2).map(v => String((v as unknown[])[0]))))
  let out: ApiPrompt = { ...prompt }
  for (const [id, n] of Object.entries(prompt)) if (!read.has(id)) out = { ...out, ...readerFor(n.class_type, id) }
  return out
}

/** The classes whose slot 0 is a video (a Video card shows it). */
const VIDEO_CLASSES: ReadonlySet<string> = new Set(['GenerateVideoNode', 'FilmShotNode', 'LipSyncNode', 'EnhanceVideoNode'])

/** The calls as Python writes them: a handed-off picture as `IMG:<input>`, a sound as `WAV:<input>`. */
export function normalizeSent(sent: readonly SentCall[], pictures: readonly string[] = [], sounds: readonly string[] = []): SentCall[] {
  const names = new Map<string, string>([
    ...pictures.map(n => [`https://fal.storage/${n}.png`, `IMG:${n}`] as [string, string]),
    ...sounds.map(n => [`https://fal.storage/${n}.wav`, `WAV:${n}`] as [string, string]),
  ])
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return names.get(v) ?? v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return sent.map(s => ({ provider: s.provider, endpoint: s.endpoint, payload: walk(s.payload) as Record<string, unknown> }))
}

/** A payload as a wire text with keys sorted: numbers keep their written form (pyJson). */
export function wireText(payload: unknown): string {
  const sorted = (v: PyJson): PyJson => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v && typeof v === 'object' && 'obj' in v) {
      return { obj: [...v.obj].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)] as [string, PyJson]) }
    }
    return v
  }
  return pyJsonDumps(sorted(parsePyJson(JSON.stringify(payload))))
}

/**
 * The engine sent exactly Python's calls, in order: service, endpoint and
 * payload (deep-equal). Where Python's wire text is recorded
 * (`payload_json`), the payloads are compared as wire texts too, so Python's
 * `1.0` and a sent `1` differ, as they do on the wire.
 */
export function expectCalls(sent: readonly SentCall[], pyCalls: readonly PyCall[], pictures: readonly string[] = [], sounds: readonly string[] = []): void {
  const got = normalizeSent(sent, pictures, sounds)
  expect(got.length, 'the number of calls').toBe(pyCalls.length)
  for (const [i, py] of pyCalls.entries()) {
    expect(got[i], `call ${i + 1}`).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    if (py.payload_json !== undefined) expect(wireText(got[i]!.payload), `call ${i + 1} on the wire`).toBe(py.payload_json)
  }
}
