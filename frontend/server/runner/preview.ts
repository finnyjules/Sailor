/**
 * Live previews through the runner (step 3, R2.11). A slider change on a
 * ported effect asks for its preview: the chain of local nodes behind it
 * (shared/runner/livePreview.ts) is worked out on the files the canvas
 * already shows for the nodes it pins, with exactly the derive plans a full
 * run uses (so every effect's caps, its work budget and memory cap, and the
 * start-of-take header checks apply as they do there). Nothing is held,
 * recorded or charged, and no run event is sent: previews are free.
 *
 * What the nodes make lives in this request's own memory and is let go when
 * it answers (done, failed or stopped). Nothing is written to disk but the
 * target's `live_preview_<id>.png`, the same file a full run writes.
 *
 * One preview in flight per user and node (a newer one stops the older, which
 * answers 409), and at most PREVIEW_MAX_PER_USER per user.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { familyOn, type RunnerFamily } from '#shared/runner/families'
import {
  EFFECT_PICTURES_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_FOR_CLASS, EFFECT_PICTURE_TOO_LARGE_HOSTED,
  EFFECT_MAX_WORK, EFFECT_TOO_MUCH_MEMORY, EFFECT_TOO_MUCH_WORK,
} from '#shared/runner/effects'
import {
  PREVIEW_MAX_PINNED_FILES, PREVIEW_NEEDS_FULL_RUN, PREVIEW_NEEDS_FULL_RUN_REASON, PREVIEW_SUPERSEDED, PREVIEW_SUPERSEDED_REASON, previewPlan,
  type PreviewFile,
} from '#shared/runner/livePreview'
import { MeterRefusalError } from '../utils/requestMeter'
import { planNode, type DeriveIO, type Derived } from './executors'
import { assertFilesOwned, collectInputFiles, type OwnershipCheck } from './inputs'
import { pictureSourceOf } from './compositor/plan'
import { cardPictureFiles, cardPictureRefusal, oneFrameRefused } from './cards/bakeReplay'
import { effectOutRefusal } from './effects/plan'
import { PICTURE_ANIMATED, pictureHasFrames, pictureMeta, pictureRefusal } from './pictures/pythonView'
import { sha256Hex } from './handoff'
import { userSubfolder, type ResultStore } from './results'
import { checkValue, filesOf, slotValue, withWiredValues } from './values'
import { emptyNodeRecord, type NodeRecord, type OutputFile, type RunnerValue } from './types'
import type { KeptExt } from './keptBytes'

/** At most this many previews in flight per user. */
export const PREVIEW_MAX_PER_USER = 2
/** The most nodes a request may name (the target, what it works out and what it pins). */
export const PREVIEW_MAX_PROMPT_NODES = 64

export const PREVIEW_UNREADABLE = 'This preview request can’t be read'
export const PREVIEW_TOO_MANY = 'Too many previews are being made at once. Try again in a moment.'
export const PREVIEW_STOPPED = 'This preview was stopped'
export const PREVIEW_PICTURE_GONE = 'A picture this preview reads is gone. Run the workflow again.'
export const PREVIEW_PICTURE_UNREAD = 'A picture this preview reads could not be read'
export const PREVIEW_NOT_YOURS = 'This workflow uses a file that isn’t one of yours'

/** A preview's refusal, as the route answers it (h3 reads statusCode, message and data). */
const refuse = (message: string, status: number, data?: unknown) => new MeterRefusalError(message, status, data)
/** The 409 the browser reads as "run it as before" (a full run), with the node it is about. */
const needsFullRun = (nodeId?: string) => refuse(PREVIEW_NEEDS_FULL_RUN, 409, { reason: PREVIEW_NEEDS_FULL_RUN_REASON, ...(nodeId ? { nodeId } : {}) })
/** Thrown when a preview's chain would do more work than one effect may on a full run. */
class PreviewOverBudget extends Error {}

/** Refusals about size: the route answers them 413, as a too-large request. */
const SIZE_REFUSALS: ReadonlySet<string> = new Set([
  EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_PICTURE_TOO_LARGE_FOR_CLASS, EFFECT_PICTURES_TOO_LARGE,
  EFFECT_TOO_MUCH_WORK, EFFECT_TOO_MUCH_MEMORY, 'This picture is larger than 8192 × 8192, too large to read here',
])

export interface PreviewDeps {
  runnerOn(): boolean
  families(): ReadonlySet<RunnerFamily>
  hosted(): boolean
  /** The canvas's files (input, output, temp) and the target's preview. */
  results: Pick<ResultStore, 'read' | 'exists' | 'savePreviewAs'>
  ownership: OwnershipCheck
  /** The work one preview's whole chain may do (absent: EFFECT_MAX_WORK, one effect's full-run budget). Tests lower it. */
  workBudget?: number
}

export interface PreviewInput {
  userId: string | null
  /** The request body: `{ canvasId, nodeId, prompt, pinned }`. */
  body: unknown
  /** Aborted when the browser goes away. */
  signal?: AbortSignal
  /**
   * When the request arrived (previewArrival, taken by the route before it
   * reads the body): a later arrival replaces an earlier one for the same
   * node, never the reverse. Absent: taken when runPreview is called.
   */
  arrival?: number
}

// ── What is in flight ────────────────────────────────────────────────────────

interface Flight { ctrl: AbortController; superseded: boolean; arrival: number }
const flights = new Map<string, Map<string, Flight>>()
let arrivals = 0

/** The next arrival number: the route takes one the moment a request comes in. */
export function previewArrival(): number { return ++arrivals }
/** Bytes this module holds right now across requests (made by the nodes, let go when each answers). */
let heldBytes = 0

/** For tests: what previews hold right now. */
export function previewsInFlight(): { requests: number; bytes: number } {
  let requests = 0
  for (const m of flights.values()) requests += m.size
  return { requests, bytes: heldBytes }
}

const superseded = () => refuse(PREVIEW_SUPERSEDED, 409, { reason: PREVIEW_SUPERSEDED_REASON })

/**
 * Takes the (user, node) slot, synchronously (no await between the request's
 * arrival and this): a request that arrived after the one holding the slot
 * replaces it; one that arrived before it is refused as replaced.
 */
function enter(user: string, node: string, arrival: number): Flight {
  let mine = flights.get(user)
  if (!mine) { mine = new Map(); flights.set(user, mine) }
  const held = mine.get(node)
  if (held) {
    if (held.arrival > arrival) throw superseded()
    held.superseded = true
    held.ctrl.abort()
    mine.delete(node)
  }
  if (mine.size >= PREVIEW_MAX_PER_USER) throw refuse(PREVIEW_TOO_MANY, 429)
  const f: Flight = { ctrl: new AbortController(), superseded: false, arrival }
  mine.set(node, f)
  return f
}

function leave(user: string, node: string, f: Flight): void {
  const mine = flights.get(user)
  if (!mine) return
  if (mine.get(node) === f) mine.delete(node)
  if (!mine.size) flights.delete(user)
}

// ── Reading the request ──────────────────────────────────────────────────────

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A file the canvas shows, with a plain name: never a kept file, never a path out of its folder. */
function previewFile(v: unknown): OutputFile | null {
  if (!plainObject(v)) return null
  const { filename, subfolder, type } = v
  if (typeof filename !== 'string' || typeof subfolder !== 'string') return null
  if (type !== 'input' && type !== 'output' && type !== 'temp') return null
  if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) return null
  if (subfolder && (/[\\\0]/.test(subfolder) || subfolder.split('/').some(p => !p || p === '.' || p === '..'))) return null
  return { filename, subfolder, type }
}

interface ReadRequest { canvasId: string | null; nodeId: string; prompt: ApiPrompt; pinned: Record<string, OutputFile[]> }

function readRequest(body: unknown): ReadRequest {
  const bad = () => refuse(PREVIEW_UNREADABLE, 400)
  if (!plainObject(body)) throw bad()
  const { canvasId, nodeId, prompt, pinned } = body
  if (typeof nodeId !== 'string' || !nodeId || !plainObject(prompt) || !plainObject(pinned)) throw bad()
  if (canvasId !== undefined && canvasId !== null && typeof canvasId !== 'string') throw bad()
  const ids = Object.keys(prompt)
  if (ids.length > PREVIEW_MAX_PROMPT_NODES || !Object.prototype.hasOwnProperty.call(prompt, nodeId)) throw bad()
  const nodes: ApiPrompt = {}
  for (const id of ids) {
    const n = prompt[id]
    if (!plainObject(n) || typeof n.class_type !== 'string' || (n.inputs !== undefined && !plainObject(n.inputs))) throw bad()
    nodes[id] = { class_type: n.class_type, inputs: (n.inputs as Record<string, unknown> | undefined) ?? {} }
  }
  const pins: Record<string, OutputFile[]> = {}
  for (const [id, list] of Object.entries(pinned)) {
    if (!Object.prototype.hasOwnProperty.call(nodes, id) || !Array.isArray(list) || !list.length || list.length > PREVIEW_MAX_PINNED_FILES) throw bad()
    const files = list.map(previewFile)
    if (files.some(f => !f)) throw bad()
    pins[id] = files as OutputFile[]
  }
  return { canvasId: typeof canvasId === 'string' ? canvasId : null, nodeId, prompt: nodes, pinned: pins }
}

/** A file as a card's widget names it (inputs.ts parseInputFileRef reads it back). */
const refOf = (f: OutputFile) => `${f.subfolder ? `${f.subfolder}/` : ''}${f.filename} [${f.type}]`
const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** Hosted: every file the preview reads must be the user's own (as /api/runs checks them), a temp file in the user's own folder. */
async function assertOwned(files: OutputFile[], userId: string | null, hosted: boolean, ownership: OwnershipCheck): Promise<void> {
  if (!hosted) return
  await assertFilesOwned(files.filter(f => f.type !== 'temp'), userId, hosted, ownership)
  const own = userSubfolder(userId, true)
  const theirs = files.find(f => f.type === 'temp' && (!own || f.subfolder !== own))
  if (theirs) throw refuse(PREVIEW_NOT_YOURS, 403, { file: theirs.filename })
}

/** The message a failed node answers with: the plan's own words, never a file system's. */
function plainMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code?: unknown }).code === 'string') return PREVIEW_PICTURE_UNREAD
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 300 ? `${m.slice(0, 299)}…` : m
}

// ── The preview ──────────────────────────────────────────────────────────────

export async function runPreview(req: PreviewInput, deps: PreviewDeps): Promise<{ ui: Record<string, unknown> }> {
  const arrival = req.arrival ?? previewArrival()
  if (!deps.runnerOn()) throw refuse('Not found', 404)
  const families = deps.families()
  const hosted = deps.hosted()
  if (!familyOn('live-previews', families)) throw needsFullRun()
  const r = readRequest(req.body)
  // A browser that has gone already gets nothing; otherwise the slot is taken now, before any await.
  if (req.signal?.aborted) throw refuse(PREVIEW_STOPPED, 409, { reason: 'stopped' })
  const user = req.userId ?? 'local'
  const nodeKey = `${r.canvasId ?? ''}\n${r.nodeId}`
  const flight = enter(user, nodeKey, arrival)
  const signal = flight.ctrl.signal
  const onAbort = () => flight.ctrl.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })
  // What the nodes made (their kept bytes), and each one's size (a buffer handed to the worker is emptied).
  const mem = new Map<string, Uint8Array>()
  const sizes = new Map<string, number>()
  const hold = (f: OutputFile, b: Uint8Array) => {
    const k = keyOf(f)
    if (mem.has(k)) return
    mem.set(k, b)
    sizes.set(k, b.byteLength)
    heldBytes += b.byteLength
  }
  let current: string | null = null
  let sub: ApiPrompt = {}
  try {
    // The pinned cards read their pinned file, as their widget would name it.
    const prompt: ApiPrompt = { ...r.prompt }
    for (const [id, files] of Object.entries(r.pinned)) {
      const n = prompt[id]!
      const cls = n.class_type
      if ((cls === 'Image' && !isLink(n.inputs.images)) || (cls === 'LoadImage' && !isLink(n.inputs.image))) {
        prompt[id] = { ...n, inputs: { ...n.inputs, image: refOf(files[0]!) } }
      }
    }
    // Only what the runner itself works out: a provider (or anything else) not pinned needs a full run.
    const plan = previewPlan(prompt, r.nodeId, families, { hosted })
    if (!plan) throw needsFullRun(r.nodeId)
    // A node the preview would have to run (a provider, say) that isn't pinned needs a full run.
    const missing = plan.pins.find(id => !Object.prototype.hasOwnProperty.call(r.pinned, id))
    if (missing) throw needsFullRun(missing)
    const pins = new Set(plan.pins)
    if (Object.keys(r.pinned).some(id => !pins.has(id))) throw refuse(PREVIEW_UNREADABLE, 400)
    // Nothing else: a node in the request that the preview neither works out nor pins (a provider off to the side) needs a full run.
    const stray = Object.keys(prompt).find(id => !pins.has(id) && !plan.order.includes(id))
    if (stray) throw needsFullRun(stray)
    // What a pin brings is read as its real class hands it on (an action with nothing to do hands on what it reads: not here).
    for (const id of plan.pins) {
      try { pictureSourceOf(prompt, [id, 0]) }
      catch { throw needsFullRun(id) }
    }
    sub = Object.fromEntries([...plan.pins, ...plan.order].map(id => [id, prompt[id]!]))

    // Hosted: the pinned files and the local nodes' own files (Painter's) must be the user's.
    const pinnedFiles = plan.pins.flatMap(id => r.pinned[id]!)
    const ownFiles = collectInputFiles(Object.fromEntries(plan.order.map(id => [id, sub[id]!])))
    await assertOwned([...pinnedFiles, ...ownFiles], req.userId, hosted, deps.ownership)

    const stopped = () => {
      if (signal.aborted) {
        throw refuse(flight.superseded ? PREVIEW_SUPERSEDED : PREVIEW_STOPPED, 409, { reason: flight.superseded ? PREVIEW_SUPERSEDED_REASON : 'stopped' })
      }
    }
    // Every file the preview reads from the canvas is there, before anything is read.
    for (const f of pinnedFiles) {
      if (!(await deps.results.exists(f))) throw refuse(PREVIEW_PICTURE_GONE, 400, { file: f.filename })
    }
    stopped()
    // The start of a take's header checks (engine.ts startRun): a picture a card would refuse
    // (16-bit, CMYK, a see-through GIF…), an animation, an effect's output over its caps.
    const allowed = new Set([...pinnedFiles, ...ownFiles].map(keyOf))
    for (const c of cardPictureFiles(sub, families)) {
      if (!allowed.has(keyOf(c.file))) continue
      let bytes: Uint8Array
      try { bytes = await deps.results.read(c.file) }
      catch { continue }
      stopped()
      const why = await pictureRefusal(bytes)
      if (why) throw refuse(cardPictureRefusal(c.classType, why), 400, { nodeId: c.nodeId, classType: c.classType })
      const frameMeta = c.oneFrame ? await pictureMeta(bytes) : null
      if (frameMeta && oneFrameRefused(c, pictureHasFrames(frameMeta, bytes), frameMeta.pages)) throw refuse(c.animated ?? PICTURE_ANIMATED, 400, { nodeId: c.nodeId, classType: c.classType })
      if (c.resized) {
        const tooLarge = effectOutRefusal(c.resized, c.classType, await pictureMeta(bytes), hosted)
        if (tooLarge) throw refuse(tooLarge, 413, { nodeId: c.resized.nodeId, classType: c.resized.classType })
      }
    }

    // Each node's record, as the engine keeps one: pinned nodes carry their files.
    const recs: Record<string, NodeRecord> = {}
    for (const id of plan.pins) recs[id] = { ...emptyNodeRecord(sub[id]!.class_type), status: 'done', outputs: r.pinned[id]! }
    const valueAt = ([from, slot]: [string, number]): RunnerValue | undefined => slotValue(recs[from], slot)
    const filesFrom = (link: [string, number]) => filesOf(valueAt(link))
    const readFile = async (f: OutputFile): Promise<Uint8Array> => {
      if (f.type === 'kept') {
        const b = mem.get(keyOf(f))
        if (!b) throw new Error(PREVIEW_PICTURE_GONE)
        // A copy: the worker takes the buffer it is handed, and another node may read these bytes too.
        return b.slice()
      }
      try { return await deps.results.read(f) }
      catch { throw new Error(PREVIEW_PICTURE_UNREAD) }
    }
    const shown = (filename: string): OutputFile => ({ filename, subfolder: '', type: 'temp' })
    // The whole chain's work within one effect's full-run budget (plan.ts's EFFECT_MAX_WORK): past it, a full run.
    let spent = 0
    const spendWork = (work: number) => {
      spent += work
      if (spent > (deps.workBudget ?? EFFECT_MAX_WORK)) throw new PreviewOverBudget()
    }
    let made: Derived | null = null
    for (const id of plan.order) {
      stopped()
      current = id
      const target = id === r.nodeId
      const reads = new Map<string, Promise<Uint8Array>>()
      const readOnce = (f: OutputFile) => {
        let p = reads.get(keyOf(f))
        if (!p) { p = readFile(f); reads.set(keyOf(f), p) }
        return p
      }
      const node = await planNode({
        prompt: withWiredValues(sub, id, valueAt).prompt,
        nodeId: id,
        filesFrom,
        valueFrom: valueAt,
        toUrl: async () => { throw new Error(PREVIEW_NEEDS_FULL_RUN) },
        gateOpen: false,
        readFile: readOnce,
        hosted,
        families,
      })
      const rec: NodeRecord = { ...emptyNodeRecord(sub[id]!.class_type), status: 'done' }
      if (node.kind === 'pass') {
        rec.outputs = node.files
        recs[id] = rec
        continue
      }
      if (node.kind !== 'derive') throw needsFullRun(id)
      const io: DeriveIO = {
        read: readOnce,
        keep: async (bytes: Uint8Array, ext: KeptExt) => {
          const f: OutputFile = { filename: `${sha256Hex(bytes)}.${ext}`, subfolder: 'preview', type: 'kept' }
          hold(f, bytes)
          return f
        },
        // Only the target writes, and only its live preview: every other file a node would show stays unwritten.
        saveAsset: async (_bytes, o) => {
          if (target || (o.folder ?? 'output') !== 'temp') throw new Error(PREVIEW_NEEDS_FULL_RUN)
          return shown(`${o.prefix}.${o.ext}`)
        },
        savePreview: async (_bytes, o) => {
          if (target) throw new Error(PREVIEW_NEEDS_FULL_RUN)
          return shown(`live_preview_${o.nodeId ?? id}.png`)
        },
        savePreviewAs: async (bytes, o) => {
          if (!target) return shown(o.filename)
          stopped()
          return deps.results.savePreviewAs(bytes, { filename: o.filename, userId: req.userId })
        },
        hosted,
        signal,
        spendWork,
        nodeId: id,
        runWorkflow: null,
        runPrompt: sub,
      }
      const out = await node.derive(io)
      stopped()
      for (const v of Object.values(out.values)) checkValue(v)
      rec.values = out.values
      recs[id] = rec
      if (target) made = out
    }
    if (!made?.ui) throw new Error('This preview made nothing to show')
    return { ui: made.ui }
  }
  catch (e) {
    if (signal.aborted) {
      throw refuse(flight.superseded ? PREVIEW_SUPERSEDED : PREVIEW_STOPPED, 409, { reason: flight.superseded ? PREVIEW_SUPERSEDED_REASON : 'stopped' })
    }
    if (e instanceof MeterRefusalError) throw e
    if (e instanceof PreviewOverBudget) throw needsFullRun(current ?? r.nodeId)
    const message = plainMessage(e)
    const classType = current ? sub[current]?.class_type ?? null : null
    throw refuse(message, SIZE_REFUSALS.has(message) ? 413 : 400, { nodeId: current ?? r.nodeId, classType })
  }
  finally {
    for (const n of sizes.values()) heldBytes -= n
    sizes.clear()
    mem.clear()
    req.signal?.removeEventListener('abort', onAbort)
    leave(user, nodeKey, flight)
  }
}

// ── The route's wiring ───────────────────────────────────────────────────────

let depsOverride: PreviewDeps | null = null

/** Tests: the route's deps (null: the real ones). */
export function __setPreviewDepsForTests(d: PreviewDeps | null): void { depsOverride = d }
export function previewDepsOverride(): PreviewDeps | null { return depsOverride }

export type { PreviewFile }
