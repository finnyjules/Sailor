/**
 * Stage 5 Task 4: the metered graph submission path. In hosted mode the
 * comfyui-proxy middleware routes POST /prompt here instead of raw-proxying
 * (local mode falls through to the raw proxy unchanged). Invariants:
 * (1) hold BEFORE forward — an underfunded run never reaches the engine;
 * (2) ComfyUI's response body passes through VERBATIM (clients parse
 *     prompt_id / node_errors from the real shape);
 * (3) settlement is watcher-driven: settle the hold + record output filenames
 *     on success; on an error charge the paid nodes that finished and release
 *     the rest (Task G2, watchGraphRun); release the hold on a timeout.
 *     Refusals cost nothing.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { readBody, setResponseStatus } from 'h3'
import { priceGraph, UnpricedGraphError } from './priceBook'
import { createGateReads, graphInputSizes, pictureSize } from './graphInputPixels'
import { INPUTS_TOO_LARGE, createGateSnapshots, rewriteMeasuredInputs } from './gateSnapshots'
import { normalizeHostedPrompt } from './hostedPrompt'
import { storedNodeCatalog } from '../native/objectInfo'
import { graphInputSeconds, mediaSeconds, seedanceReferenceSeconds, type MediaFile, type MediaKind } from './graphInputSeconds'
import { MeterRefusalError } from './requestMeter'
import { createGraphRun, resolveGraphRun, outputKey, ownedOutputKeys, RUNNER_SAVED_INPUT } from './graphRuns'
import { partialCharge, settleOnCompletion, type HistoryEntry, type RunChargePlan } from './settleWatcher'
import { FRAME_RENDER_TYPES } from '#shared/runner/eligibility'
import { stripForeignComfyOrgCreds } from './spikeAuth'
import { resolveWorkerTarget } from './workerRoute'
import { getLiveLedger } from './ledgerLive'
import { captureError } from './observe'
import { annotatedFilepath, collectUploadFlaggedInputs } from './engineGate'
import { canonicalUploadKey, uploadOwner } from './inputUploads'
import { GRAPH_FILE_READERS, GRAPH_FOLDER_READERS, GRAPH_OUTPUT_WRITERS, extractFileRefs, graphFolderOwnedBy, type FileRefSemantics } from './engineFileSurface'
import { extractGraphPromptTexts } from './graphPromptText'
import { staticWiredTexts } from '#shared/runner/staticValues'
import { extraPromptTexts } from '../runner/metering'
import type { ApiPrompt } from '#shared/runner/graph'
import { moderatePrompt, moderateTexts, moderationRefusal, type ModerationResult } from './moderation'
import { assertSpendAllowed } from './systemControls'
import { blockedPromptRefusal, nodeProblemsBody, retiredEngineRefusal } from './blockedModels'
import { hostedRequestProblems, measuredInputProblems } from '../runner/requestRules'
import { executedPart } from '#shared/runner/validate'
import { savedPoseRefs } from '#shared/runner/nanoExtras'

export function isPromptPath(path: string): boolean {
  return path === '/prompt' || path.startsWith('/prompt?')
}

// ---------------------------------------------------------------------------
// Stage 6 Task 7 — per-user output subfolders + graph file-reference ownership.
// ---------------------------------------------------------------------------

/**
 * A stable, non-reversible per-user path segment: the first 12 hex chars of
 * sha256(userId). Deterministic (same user → same subfolder across restarts)
 * and carries no PII into the output directory name. 12 hex = 48 bits, ample
 * to keep tenants apart on a shared engine disk.
 */
export function shortUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12)
}

/**
 * Rewrite a client-supplied output-path field so EVERY writer node — not just
 * the filename_prefix family — writes under the caller's OWN `u_<hash>/`
 * subfolder. Task 7/7b only ever touched `filename_prefix`; Task 7c
 * generalizes to GRAPH_OUTPUT_WRITERS (engineFileSurface.ts), a per-class map
 * of WHICH input field carries that class's output path (`filename_prefix`
 * for the SaveImage family, `prefix` for SaveLoRA, `folder_name` for the
 * dataset savers). filename_prefix writers route through
 * folder_paths.get_save_image_path, which containment-checks the resulting
 * path (folder_paths.py:453-458) — but SaveImageDataSetToFolder /
 * SaveImageTextDataSetToFolder / SaveTrainingDataset join `folder_name` onto
 * get_output_directory() with a bare os.path.join and NO commonpath check
 * (nodes_dataset.py:237), so a client `folder_name: "../.."` writes OUTSIDE
 * the output root entirely. We harden the SAME boundary up front for every
 * declared field, regardless of whether the engine also checks it.
 *
 * The caller's segment is PREPENDED exactly once: any leading `u_<segment>/`
 * runs the client supplied (their own hash repeated, or a forged
 * `u_otherhash/`) are stripped first, then `..`/`.`/empty segments are dropped,
 * so a forged `u_otherhash/evil` becomes `u_<caller>/evil` — replaced, never
 * nested — and `../../etc` becomes `u_<caller>/etc` — traversal neutralized.
 * A class with NO client-controllable path field (Preview3D — a random-uuid
 * filename, GRAPH_OUTPUT_WRITERS value `null`) is left untouched; there is
 * nothing to rewrite. Returns a CLONE; the input graph is never mutated (no
 * cross-request bleed through a shared body object).
 */
export function injectOutputSubfolder(prompt: Record<string, any>, userId: string): Record<string, any> {
  const hash = shortUserHash(userId)
  const clone = structuredClone(prompt)
  for (const node of Object.values(clone)) {
    if (!node || typeof node !== 'object') continue
    const field = GRAPH_OUTPUT_WRITERS[(node as any).class_type]
    if (!field) continue
    const inputs = (node as any).inputs
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) (node as any).inputs = {}
    const target = (node as any).inputs as Record<string, unknown>
    const existing = typeof target[field] === 'string' ? target[field] as string : ''
    target[field] = `u_${hash}/${sanitizeExistingPrefix(existing)}`
  }
  return clone
}

/**
 * Strip a client-supplied output-path value down to a contained,
 * foreign-namespace-free suffix: fold backslashes, drop any leading
 * `u_<segment>/` runs (so the caller's own hash is the ONLY per-user
 * segment), then drop `..`/`.`/empty path segments. Falls back to `ComfyUI`
 * when nothing usable remains. Shared by every GRAPH_OUTPUT_WRITERS field —
 * filename_prefix, prefix, and folder_name alike.
 */
function sanitizeExistingPrefix(existing: string): string {
  let base = existing.replace(/\\/g, '/').replace(/^(u_[^/]+\/)+/, '')
  base = base.split('/').filter(s => s && s !== '.' && s !== '..').join('/')
  return base || 'ComfyUI'
}

export interface GraphFileRefCtx {
  /** `ClassType.inputName` pairs whose widget carries a shared-directory filename. */
  uploadFlagged: Set<string>
  /**
   * The caller's OWN per-user path segment (sha256(userId).slice(0,12)). Used
   * by the per-FOLDER readers: a folder value is owned only when it resolves to
   * `u_<callerHash>` (or a path nested under it). Pure — no DB round-trip.
   */
  callerHash: string
  /** Does the caller own this input file (annotation stripped)? */
  ownsInput(name: string): Promise<boolean>
  /** Does the caller own this output file (value may still carry `[output]`)? */
  ownsOutput(annotated: string): Promise<boolean>
}

/** Ownership check for one resolved filename per its input's semantics. */
async function checkFileOwnership(ct: string, inputName: string, value: string, semantics: FileRefSemantics, ctx: GraphFileRefCtx): Promise<void> {
  if (semantics === 'output') {
    if (!(await ctx.ownsOutput(value))) {
      throw new MeterRefusalError(`graph references an output file you do not own (${ct}.${inputName})`, 403)
    }
    return
  }
  if (semantics === 'input') {
    // The engine reads this value literally from the input tree with NO
    // annotation routing (Timeline joins it onto input_dir as-is), so the
    // literal value is vetted — an absolute path or a foreign subfolder fails.
    if (!(await ctx.ownsInput(value))) {
      throw new MeterRefusalError(`graph references an input file you do not own (${ct}.${inputName})`, 403)
    }
    return
  }
  // either — route by the trailing ` [output]`/` [input]`/` [temp]` annotation.
  const { name, type } = annotatedFilepath(value)
  if (type === 'output') {
    if (!(await ctx.ownsOutput(value))) {
      throw new MeterRefusalError(`graph references an output file you do not own (${ct}.${inputName})`, 403)
    }
  }
  else if (!(await ctx.ownsInput(name))) {
    throw new MeterRefusalError(`graph references an input file you do not own (${ct}.${inputName})`, 403)
  }
}

/**
 * Refuse (403) a graph that references any file the caller does not own.
 *
 * Three sources define what the engine will READ: the checked-in
 * GRAPH_FILE_READERS map (Stage 6 Task 7b — plain strings, dict-valued inputs
 * like Load3D.image, and JSON blobs like Compositor.motion_params / the type
 * nodes' params / Timeline.edit_state), the GRAPH_FOLDER_READERS map (the
 * per-FOLDER dataset readers — a whole attacker-named folder, not a single
 * file), and the object_info-derived `uploadFlagged` set (any upload-flagged
 * input the maps don't already cover, treated as a plain annotated filename
 * string). Each referenced FILE name is ownership-checked per its semantics:
 * `output` → the output-ownership check, `input` → the literal input-ownership
 * check, `either` → routed by its ` [output]`/` [input]`/` [temp]` annotation.
 * Each referenced FOLDER must resolve to the caller's OWN u_<hash> subtree
 * (graphFolderOwnedBy) — nothing else has a legitimate use.
 *
 * Fail closed: a PRESENT value that is not in the shape we can read (a wired
 * link, a number, a non-object dict, unparseable JSON, an unexpected `rendered`
 * shape) is refused — we cannot vet what we cannot read. Absent/empty values
 * reference no file and are skipped, so zero-file and partial graphs are
 * untouched.
 *
 * Pure over `ctx`: it takes NO ledger/DB action, so the caller can run it
 * BEFORE any credit hold and a refusal costs nothing.
 */
export async function validateGraphFileRefs(prompt: Record<string, any>, ctx: GraphFileRefCtx): Promise<void> {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return
  for (const node of Object.values(prompt)) {
    const ct = (node as any)?.class_type
    if (typeof ct !== 'string') continue
    const inputs = (node as any)?.inputs
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue

    // 1) Explicit file-reader specs (the authoritative map).
    const specs = GRAPH_FILE_READERS[ct] ?? []
    const covered = new Set<string>()
    for (const spec of specs) {
      covered.add(spec.input)
      const names = extractFileRefs(spec, (inputs as Record<string, unknown>)[spec.input])
      if (names === null) {
        throw new MeterRefusalError(`graph references a file through ${ct}.${spec.input} in an unexpected shape`, 403)
      }
      for (const name of names) await checkFileOwnership(ct, spec.input, name, spec.semantics, ctx)
    }

    // 1b) Per-FOLDER readers (Task 7b Critical). The engine joins this value
    // onto the shared input/output tree and reads the WHOLE folder, so the
    // value must resolve to the caller's OWN u_<hash> subtree or the run is
    // refused. Fail closed on a wired/absent/traversing/foreign value — an
    // absent folder still makes the engine read the tree root.
    for (const spec of GRAPH_FOLDER_READERS[ct] ?? []) {
      covered.add(spec.input)
      const value = (inputs as Record<string, unknown>)[spec.input]
      if (!graphFolderOwnedBy(value, ctx.callerHash)) {
        throw new MeterRefusalError(`graph references a ${spec.semantics} folder you do not own (${ct}.${spec.input})`, 403)
      }
    }

    // 2) Upload-flagged inputs the map does not already cover — a plain
    // annotated filename string (the Stage-6-Task-7 behaviour, retained as a
    // catch-all so a catalog-flagged input we didn't enumerate is still vetted).
    for (const [inputName, value] of Object.entries(inputs as Record<string, unknown>)) {
      if (covered.has(inputName)) continue
      if (!ctx.uploadFlagged.has(`${ct}.${inputName}`)) continue
      if (value === undefined || value === null) continue
      if (typeof value !== 'string') {
        throw new MeterRefusalError(`graph references a file through ${ct}.${inputName} in an unexpected shape`, 403)
      }
      if (value === '') continue
      await checkFileOwnership(ct, inputName, value, 'either', ctx)
    }
  }
}

// The upload-flag map is derived from the live engine's object_info catalog —
// the SAME source the /object_info scrubber reads — and cached per process so a
// graph submission doesn't refetch a large catalog on every run.
const FLAG_MAP_TTL_MS = 60000
let flagMapCache: { at: number, set: Set<string> } | null = null

export function __resetUploadFlagMapForTests(): void { flagMapCache = null }

export async function loadUploadFlaggedInputs(fetchCatalog: () => Promise<unknown>): Promise<Set<string>> {
  const now = Date.now()
  if (flagMapCache && now - flagMapCache.at < FLAG_MAP_TTL_MS) return flagMapCache.set
  const set = collectUploadFlaggedInputs(await fetchCatalog())
  // LoadImageOutput.image is remote-routed, not upload-flagged (nodes.py:1951-
  // 1959), so the catalog walk never yields it — but GRAPH_FILE_READERS now
  // covers it explicitly (semantics: output), so it no longer needs adding here.
  flagMapCache = { at: now, set }
  return set
}

/**
 * The live wiring of validateGraphFileRefs for a hosted submission: build the
 * ownership ctx against input_uploads / graph_runs for `userId`, pull the
 * upload-flag map from `target`'s object_info, and validate. Short-circuits
 * BEFORE touching the catalog or the DB when the graph carries no candidate
 * file reference at all (no string-valued input, no LoadImageOutput) — a graph
 * that references no file can leak nothing.
 */
export async function runGraphFileValidation(prompt: Record<string, any>, userId: string, target: string): Promise<void> {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return
  const hasCandidate = Object.values(prompt).some((n: any) =>
    (typeof n?.class_type === 'string' && (GRAPH_FILE_READERS[n.class_type] || GRAPH_FOLDER_READERS[n.class_type]))
    || (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)
      && Object.values(n.inputs).some(v => typeof v === 'string' && v !== '')))
  if (!hasCandidate) return

  const uploadFlagged = await loadUploadFlaggedInputs(async () => {
    const r = await fetch(`${target}/object_info`, { headers: { origin: target } })
    if (!r.ok) throw new MeterRefusalError('could not resolve engine catalog to validate file references', 502)
    return r.json()
  })

  const splitRef = (raw: string): { subfolder: string, filename: string } => {
    const cleaned = raw.replace(/\\/g, '/')
    const slash = cleaned.lastIndexOf('/')
    return slash >= 0
      ? { subfolder: cleaned.slice(0, slash), filename: cleaned.slice(slash + 1) }
      : { subfolder: '', filename: cleaned }
  }

  let ownedOutputs: Set<string> | null = null
  await validateGraphFileRefs(prompt, {
    uploadFlagged,
    callerHash: shortUserHash(userId),
    ownsInput: async (name) => {
      const { subfolder, filename } = splitRef(name)
      if (!filename) return false
      return (await uploadOwner(canonicalUploadKey('input', subfolder, filename))) === userId
    },
    ownsOutput: async (annotated) => {
      if (!ownedOutputs) ownedOutputs = await ownedOutputKeys(userId)
      const { name } = annotatedFilepath(annotated)
      const { subfolder, filename } = splitRef(name)
      if (!filename) return false
      return ownedOutputs.has(outputKey({ filename, subfolder, type: 'output' }))
    },
  })
}

/**
 * Review fix (Stage 5 Task 4, Finding 1): ledger.hold THROWS a plain Error
 * for a user with no wallet row ("no wallet for <id> — call ensureUser
 * first") — reachable on the primary hosted action for a new signup before
 * lazy sync lands. Left unwrapped, that throw escapes as an opaque 500
 * instead of the 402 credits-refusal every other insufficient-funds path
 * returns. Mirrors requestMeter.ts's preflightForUser catch exactly —
 * `available: 0` is asserted rather than read back, because getAvailable
 * would throw for the same missing-wallet reason.
 */
export async function holdWithRefusal(
  ledger: { hold(userId: string, credits: number, idempotencyKey: string): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }> },
  userId: string,
  credits: number,
): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }> {
  try {
    return await ledger.hold(userId, credits, `graph:${randomUUID()}`)
  } catch (e) {
    console.error('[graphMeter] HOLD FAILED — refusing as insufficient credits', { userId, credits, error: e })
    throw new MeterRefusalError('insufficient credits', 402, { required: credits, available: 0 })
  }
}

export interface GraphRunDeps {
  priceGraph: typeof priceGraph
  /**
   * Whether a class is an output node (the node catalog's `output_node`; a
   * class the catalog doesn't know counts as one, so nothing it reads goes
   * unpriced). Given, the price and the hold cover only what ComfyUI
   * executes: the nodes an output node reads (shared/runner/validate.ts
   * executedPart, the runner's own closure; R3.8 fix round 2). Absent, the
   * whole prompt.
   */
  isOutputClass?: (classType: string) => boolean
  /**
   * Node id → the measured size of the picture each size-priced node
   * (Upscale, Enhance detail, FLUX.2 edit) is sent — graphInputPixels. Runs
   * after the file-ownership check, so it only reads the caller's own files.
   * Absent (the unit tests), every such picture is priced at the input cap.
   */
  measureInputPixels?(prompt: any): Promise<Record<string, number>>
  /**
   * Task G1 (one walk, fix round 1 R7): graphInputSizes — the sizes the price
   * reads (`pixels`) AND the size-priced nodes refused because the gate can't
   * size their picture before the run, can't read a loaded file's size, or
   * left it unread (`problems`). Refused before the price and any hold. When
   * present it replaces measureInputPixels. A throw fails the request (no hold).
   */
  measureInputSizes?(prompt: any): Promise<import('./graphInputPixels').GraphInputSizes>
  /**
   * G1 fix round 1 (R2/R4): the prompt as ComfyUI's validation leaves it
   * (hostedPrompt.ts normalizeHostedPrompt) — unwrapped and coerced — or the
   * problems that stop it being matched exactly (refused, 400). Runs before
   * the file check, the sizing and the price; the NORMALISED prompt is the
   * one forwarded. Absent (the unit tests), the prompt is used as sent.
   */
  normalizePrompt?(prompt: any): { prompt: any } | { problems: import('../runner/requestRules').RequestProblem[] }
  /**
   * G1 fix round 3: the prompt with every measured file named by the run's
   * own copy (gateSnapshots.ts rewriteMeasuredInputs), or problems (refused).
   * Runs after all measuring, before the price; its prompt is forwarded.
   */
  finalizePrompt?(prompt: any): { prompt: any } | { problems: import('../runner/requestRules').RequestProblem[] }
  /**
   * G1 fix round 3: remove the run's copies. Called by meterGraphSubmit on
   * every way out but a queued run; for a queued run, startSettle's caller
   * calls it when the settle watcher ends.
   */
  releaseInputs?(): Promise<void>
  /**
   * G1 follow-up: a plain refusal when the request's measured files came to
   * more than the gate copies for one request (gateSnapshots.ts
   * MAX_SNAPSHOT_BYTES_PER_RUN), else null. Asked after each measuring step,
   * before that step's own refusals.
   */
  inputsRefusal?(): string | null
  /**
   * G1 follow-up: the caller's available credits, asked before anything is
   * copied or measured. A prompt that costs anything, from a caller with no
   * credit at all, is refused (402) before the gate copies a byte. Absent
   * (the unit tests), not asked; the hold decides as before.
   */
  availableBeforeMeasuring?(userId: string): Promise<number>
  /**
   * Node id → the measured length of each lip-sync node's sound clip (and
   * Kling lip-sync's source video) — graphInputSeconds. Runs after the
   * file-ownership check. Absent, every lip-sync is priced at the 60 s cap.
   */
  measureInputSeconds?(prompt: any): Promise<Record<string, import('../../shared/pricing/clipSettings').InputSeconds>>
  /**
   * R3.15 fix round 1: node id → true for each Pose Mannequin whose saved
   * pose (`result_image`, #shared/runner/nanoExtras savedPoseRefs) the gate
   * read from the run's own copy and found to be a picture: that node makes
   * no call and is priced at nothing (ruling (p)). Every other named saved
   * pose (gone, unreadable, not read) is priced as the call Python falls
   * to, so the engine never makes a call nothing was held for. Absent (the
   * unit tests), every named saved pose is priced as a call.
   */
  measureSavedPoses?(prompt: any): Promise<Record<string, boolean>>
  /**
   * Seedance 2.0 references longer than the model takes (15 s of video, 15 s
   * of sound, in all) — seedanceReferenceSeconds. Runs after the
   * file-ownership check, before pricing and any hold. Absent (the unit
   * tests), the lengths aren't checked.
   */
  referenceSecondsProblems?(prompt: any): Promise<import('../runner/requestRules').RequestProblem[]>
  /**
   * Operator safety valves (Stage 7 final review C1) — the global kill-switch,
   * the per-user disable set, and the daily spend ceiling. Runs FIRST, before
   * file-ref validation / moderation / pricing / hold, so a paused or
   * over-ceiling system refuses (503) at the cheapest possible point with NO
   * hold taken and the engine never touched. The canvas graph path takes its
   * hold via holdWithRefusal directly and never passes through
   * preflightForUser (requestMeter.ts), the OTHER place this guard is wired, so
   * without this call flipping the kill-switch would NOT stop canvas runs — the
   * biggest spend surface. Fails CLOSED (an unreadable control state → 503).
   */
  spendGuard(userId: string): Promise<void>
  /**
   * Refuse (throw MeterRefusalError 403) a graph that references a file the
   * caller does not own. Runs BETWEEN the shape check and pricing so a refusal
   * never takes a hold — see meterGraphSubmit.
   */
  validateFileRefs(prompt: any): Promise<void>
  /**
   * Prompt-side content moderation. Runs AFTER file-ref validation and BEFORE
   * pricing/hold, so a ToS-violating prompt is refused (400) at zero cost —
   * the hold is never taken and the engine is never touched. Fails CLOSED in
   * hosted (G3, see moderation.ts): an outage or an over-long text comes back
   * not-ok with a `reason`, refused with its own message. Never called with
   * empty text.
   */
  moderatePrompt(text: string): Promise<ModerationResult>
  hold(userId: string, credits: number): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }>
  getAvailable(userId: string): Promise<number>
  forward(body: any): Promise<{ status: number; body: any }>
  registerRun(r: { promptId: string; userId: string; credits: number; holdId: number | null }): Promise<void>
  /** `plan` (Task G2): what the hold was the sum of, so a failed run can be charged for the paid nodes that finished. */
  startSettle(r: { promptId: string; holdId: number | null; credits: number; plan?: RunChargePlan }): void
  releaseHold(holdId: number): Promise<void>
}

export async function meterGraphSubmit(userId: string | null, body: any, deps: GraphRunDeps): Promise<{ status: number; body: any }> {
  // G1 fix round 3: the run's copies of its measured inputs live until its
  // settle watcher ends (startSettle's caller releases them then); on every
  // other way out — a refusal, a throw, the engine not queuing it — now.
  const run = { handedOff: false }
  try {
    return await submitMetered(userId, body, deps, run)
  }
  finally {
    if (!run.handedOff && deps.releaseInputs) {
      await deps.releaseInputs().catch(e => console.error('[graphMeter] releasing measured copies failed', { error: e }))
    }
  }
}

async function submitMetered(userId: string | null, body: any, deps: GraphRunDeps, run: { handedOff: boolean }): Promise<{ status: number; body: any }> {
  const executed = (prompt: any) => (deps.isOutputClass && prompt && typeof prompt === 'object' && !Array.isArray(prompt) ? executedPart(prompt as ApiPrompt, deps.isOutputClass) : prompt)
  if (!userId) throw new MeterRefusalError('Sign in to run graphs', 401)
  if (!body || typeof body.prompt !== 'object' || body.prompt === null) {
    throw new MeterRefusalError('Missing prompt graph', 400)
  }

  // Operator safety valves FIRST (Stage 7 final review C1): a paused system, a
  // disabled user, or a tripped daily ceiling refuses (503) here — before any
  // file-ref validation, moderation, pricing or hold — so a paused system
  // refuses at the cheapest possible point and NO hold is ever taken. This is
  // the only enforcement point on the canvas graph surface (it never passes
  // through preflightForUser). Fails CLOSED.
  await deps.spendGuard(userId)

  // G1 fix round 1 (R2/R4): the prompt ComfyUI will run — `__value__`
  // unwrapped, numbers coerced by each input's declared type — before
  // anything reads it for money; it is also the prompt forwarded.
  if (deps.normalizePrompt) {
    const n = deps.normalizePrompt(body.prompt)
    if ('problems' in n) {
      const refusal = nodeProblemsBody(n.problems)
      if (refusal) return { status: 400, body: refusal }
    }
    else body = { ...body, prompt: n.prompt }
  }

  // Ownership of every file the graph references is checked BEFORE pricing or
  // any hold — a graph that reaches for another tenant's input/output is
  // refused (403) at zero cost, and the engine is never touched.
  await deps.validateFileRefs(body.prompt)

  // Prompt-side moderation, AFTER file-ref validation and BEFORE pricing/hold:
  // a ToS-violating prompt is refused (400) at zero cost — no hold is taken and
  // the engine is never touched. In hosted, moderatePrompt fails CLOSED (G3):
  // an outage refuses after one retry, and over-long text is refused. A card's text wired into a node (a
  // Primitive's value, through Gates too) is part of what runs, so it is read
  // with the typed prompts (R0.5), and the typed extras the runner also checks
  // (style_in, instructions, target, find, replace, scene_prompt — R0.5
  // follow-up) are read too; with nothing extra typed or wired the moderated
  // text is unchanged. Malformed nodes are left to ComfyUI's own validation.
  // Each text is moderated on its own call — every node's prompt and every
  // extra, never joined across nodes or extras (G3 follow-up) — so a short
  // harmful phrase beside long harmless text is judged on its own and the size
  // limit is per text. Identical texts are checked once; all checks run at once.
  const wellFormed = Object.fromEntries(Object.entries(body.prompt).filter(([, n]: [string, any]) =>
    n && typeof n === 'object' && !Array.isArray(n) && typeof n.class_type === 'string'
    && (n.inputs === undefined || (n.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)))))
  const moderationTexts = [
    ...extractGraphPromptTexts(body.prompt),
    ...extraPromptTexts(wellFormed as ApiPrompt),
    ...staticWiredTexts(wellFormed as ApiPrompt),
  ]
  // A graph with no text makes no moderation call at all: moderation fails
  // CLOSED in hosted (G3), so a call with nothing to check must never be able
  // to refuse a run. An unavailable service or an over-long text refuses here,
  // before pricing and any hold, with its own plain message.
  const mod = await moderateTexts(moderationTexts, t => deps.moderatePrompt(t))
  if (!mod.ok) throw moderationRefusal(mod)

  // A discontinued or runner-only model can't run on ComfyUI: refused in
  // ComfyUI's own 400 shape before pricing and any hold (blockedModels.ts).
  const blocked = blockedPromptRefusal(body.prompt)
  if (blocked) return { status: 400, body: blocked }
  // Hosted, until F12: the two estimate-priced edit engines are refused too.
  const retired = retiredEngineRefusal(body.prompt)
  if (retired) return { status: 400, body: retired }
  // Hosted: Generate speech takes the 17 preset voices only (R3.8, ruling (j)).
  const voice = body.prompt && typeof body.prompt === 'object' && !Array.isArray(body.prompt)
    ? nodeProblemsBody(hostedRequestProblems(body.prompt as ApiPrompt))
    : null
  if (voice) return { status: 400, body: voice }
  // G1 follow-up: measuring copies files (below), before the hold. A caller
  // with no credit at all can't pay for a prompt that costs anything, so it
  // is refused before a byte is copied. The price here is the unmeasured one
  // (every size at its cap); only "costs anything" is read from it.
  if (deps.availableBeforeMeasuring) {
    let unmeasured: { credits: number } | null = null
    try { unmeasured = deps.priceGraph(executed(body.prompt)) }
    catch { unmeasured = null } // refused with its own words below
    if (unmeasured && unmeasured.credits > 0) {
      const available = await deps.availableBeforeMeasuring(userId)
      if (!(available >= 1)) throw new MeterRefusalError('Not enough credits', 402, { required: 1, available: Math.max(0, available || 0) })
    }
  }
  // Too much file data to copy for one request: refused plainly (G1 follow-up).
  const overBudget = () => {
    const message = deps.inputsRefusal?.() ?? null
    return message ? { status: 400, body: { error: { type: 'value_not_valid', message, details: '', extra_info: {} }, node_errors: {} } } : null
  }

  // Seedance references longer than the model takes, refused in plain words (S1b fix round 1).
  const referenceProblems = deps.referenceSecondsProblems ? await deps.referenceSecondsProblems(body.prompt) : []
  const refsOver = overBudget()
  if (refsOver) return refsOver
  const tooLong = nodeProblemsBody(referenceProblems)
  if (tooLong) return { status: 400, body: tooLong }

  // The size of the pictures a size-priced node is sent, where the gate can
  // read it; the rest price at the input cap (never below what runs).
  // One walk gives both (G1 fix round 1, R7).
  const sizes = deps.measureInputSizes
    ? await deps.measureInputSizes(body.prompt)
    : deps.measureInputPixels ? { pixels: await deps.measureInputPixels(body.prompt).catch(() => ({})), problems: [] } : undefined
  const inputPixels = sizes?.pixels
  const picturesOver = overBudget()
  if (picturesOver) return picturesOver
  // A measured picture above the input cap is refused before the hold: each
  // size-priced model bills the picture's real size and the price stops at the
  // cap (requestRules.ts measuredInputProblems; final review finding 1).
  // A picture the gate can't size before the run, or a loaded file whose size
  // it can't read or didn't read, is refused too (Task G1): it could be larger than the cap.
  const tooLarge = nodeProblemsBody([...(inputPixels ? measuredInputProblems(body.prompt, inputPixels) : []), ...(sizes?.problems ?? [])])
  if (tooLarge) return { status: 400, body: tooLarge }
  // The length of each lip-sync node's sound (and Kling's source video), where
  // it can read it; the rest price at the 60 s cap.
  const inputSeconds = deps.measureInputSeconds ? await deps.measureInputSeconds(body.prompt).catch(() => ({})) : undefined
  // Pose Mannequin's saved poses, read from the run's copy (R3.15 fix round 1); a read that fails prices them as calls.
  const savedPoses = deps.measureSavedPoses ? await deps.measureSavedPoses(body.prompt).catch(() => ({})) : undefined
  const mediaOver = overBudget()
  if (mediaOver) return mediaOver

  // G1 fix round 3 (R3 + R4): every file measured above was measured from the
  // run's own copy; the prompt priced and forwarded names those copies, so
  // ComfyUI reads the bytes that were priced, however long it queues.
  if (deps.finalizePrompt) {
    const f = deps.finalizePrompt(body.prompt)
    if ('problems' in f) {
      const refusal = nodeProblemsBody(f.problems)
      if (refusal) return { status: 400, body: refusal }
    }
    else body = { ...body, prompt: f.prompt }
  }

  // What ComfyUI executes: a node no output reads is never run, so never priced or held (R3.8 fix round 2).
  const priced = executed(body.prompt)
  let price
  try {
    price = deps.priceGraph(priced, inputPixels || inputSeconds || savedPoses ? { inputPixels, inputSeconds, ...(savedPoses ? { savedPoses } : {}) } : undefined)
  } catch (e) {
    if (e instanceof UnpricedGraphError) throw new MeterRefusalError(e.message, 500)
    throw e
  }

  let holdId: number | null = null
  if (price.credits > 0) {
    const res = await deps.hold(userId, price.credits)
    if (!res.ok) {
      const available = await deps.getAvailable(userId)
      throw new MeterRefusalError('Not enough credits', 402, { required: price.credits, available })
    }
    holdId = res.holdId
  }

  // Finding 2: a thrown forward() (e.g. ECONNREFUSED to a wedged pool worker)
  // must not leave the hold open until the 2h sweep — release it, then
  // propagate the original error so the caller still sees the real failure.
  let fwd: { status: number; body: any }
  try {
    fwd = await deps.forward(body)
  } catch (e) {
    if (holdId !== null) {
      // Minor 4: a release failure here must not mask the original forward
      // error — log it and keep propagating what actually broke.
      await deps.releaseHold(holdId).catch(re => console.error('[graphMeter] release after forward failure failed', { userId, holdId, error: re }))
    }
    throw e
  }

  const promptId: string | undefined = fwd.body?.prompt_id
  if (fwd.status !== 200 || !promptId) {
    if (holdId !== null) {
      // Minor 4: if ledger.release throws here it would replace ComfyUI's
      // real 4xx {error, node_errors} body with an opaque 500 — log instead.
      await deps.releaseHold(holdId).catch(e => console.error('[graphMeter] release on refused/errored forward failed', { userId, holdId, error: e }))
    }
    return fwd // verbatim — clients parse node_errors from this exact shape
  }

  // Finding 3: the money path must not depend on the ownership-row insert.
  // ComfyUI already queued this run — if createGraphRun throws (Neon
  // transient), settlement still has to run or the hold sits open until the
  // 2h sweep while the client also gets a spurious 500 for a run that WILL
  // execute (inviting a double-spend resubmit). Log and keep going.
  try {
    await deps.registerRun({ promptId, userId, credits: price.credits, holdId })
  } catch (e) {
    console.error('[graphMeter] registerRun failed — run will settle but ownership row is missing', { promptId, userId, holdId, error: e })
  }
  run.handedOff = true
  // Task G2: the per-node figures the hold is the sum of, kept for an error settle.
  const plan = price.nodes ? chargePlanOf(priced, price.nodes, price.base ?? 0) : undefined
  deps.startSettle({ promptId, holdId, credits: price.credits, ...(plan ? { plan } : {}) })
  return fwd
}

/**
 * Whether a class is an output node, by the node catalog (`output_node`); a
 * class the catalog doesn't list counts as one (its whole upstream is priced:
 * never less than what runs). No catalog: undefined (the whole prompt is priced).
 */
export function outputClassesOf(catalog: Readonly<Record<string, { output_node?: unknown } | undefined>> | null): ((classType: string) => boolean) | undefined {
  if (!catalog) return undefined
  return (ct) => {
    const def = Object.prototype.hasOwnProperty.call(catalog, ct) ? catalog[ct] : undefined
    return !def || def.output_node === true
  }
}

/**
 * settleOnCompletion's default (120 polls @ 1s = 2min) is too short for
 * video-model graph runs, which can run well past 2 minutes. 30 minutes at a
 * 2s cadence covers any real run while staying well under the ledger's 2h
 * hold-sweep TTL, so a slow-but-completing run is never voided out from
 * under itself before it has a chance to settle.
 */
const SETTLE_INTERVAL_MS = 2000
const SETTLE_MAX_POLLS = 900

export async function handleMeteredPrompt(event: H3Event): Promise<any> {
  const userId = event.context.userId ?? null
  const body = await readBody(event)
  const { port } = resolveWorkerTarget(event.path)
  const target = `http://127.0.0.1:${port}`
  const ledger = getLiveLedger()

  // One read budget for the prompt: pictures and media lengths share it.
  const reads = createGateReads()
  // G1 fix round 3: every file measured is measured from this run's own copy.
  const snaps = createGateSnapshots()
  const pictureOfCopy = async (value: string) => {
    const copy = await snaps.take({ value, literalInput: false })
    return copy ? pictureSize(copy.path) : null
  }
  const mediaOfCopy = async (file: MediaFile, kind: MediaKind) => {
    const copy = await snaps.take(file)
    return copy ? mediaSeconds(copy.path, kind) : null
  }
  const result = await meterGraphSubmit(userId, body, {
    priceGraph,
    // Only what ComfyUI executes is priced: output nodes from the stored node catalog (R3.8 fix round 2).
    isOutputClass: outputClassesOf(storedNodeCatalog()),
    // Hosted: the prompt ComfyUI will run, from the stored node catalog (G1 fix round 1).
    normalizePrompt: prompt => normalizeHostedPrompt(prompt, storedNodeCatalog()),
    // One walk: the sizes the price reads and the refusals (G1 fix round 1, R7).
    measureInputSizes: prompt => graphInputSizes(prompt, pictureOfCopy, reads),
    measureInputSeconds: prompt => graphInputSeconds(prompt, mediaOfCopy, reads),
    // A saved pose is free only when its copy is a picture (R3.15 fix round 1).
    measureSavedPoses: async (prompt) => {
      const out: Record<string, boolean> = {}
      for (const [id, value] of Object.entries(savedPoseRefs(prompt))) {
        const size = await pictureOfCopy(value).catch(() => null)
        out[id] = !!size && size.pixels > 0
      }
      return out
    },
    // Hosted: a Seedance reference whose length can't be read is refused, not counted as 0 (S1b fix round 2).
    referenceSecondsProblems: prompt => seedanceReferenceSeconds(prompt, mediaOfCopy, { strict: true, reads }),
    finalizePrompt: prompt => rewriteMeasuredInputs(prompt, snaps),
    releaseInputs: () => snaps.release(),
    inputsRefusal: () => (snaps.overBudget() ? INPUTS_TOO_LARGE : null),
    availableBeforeMeasuring: u => ledger.getAvailable(u),
    // Stage 7 final review C1: the operator kill-switch + daily ceiling. Wired
    // the SAME way moderatePrompt (Task 3) is — the real implementation passed
    // in here, stubbed in the unit tests. Local mode is a no-op inside
    // assertSpendAllowed itself, so this is inert off the hosted path.
    spendGuard: assertSpendAllowed,
    // Stage 6 Task 7: refuse a graph that references a file the caller doesn't
    // own, before any hold. userId is non-null here (meterGraphSubmit's 401
    // fires first), but guard anyway so a null can never widen ownership.
    validateFileRefs: prompt => userId ? runGraphFileValidation(prompt, userId, target) : Promise.resolve(),
    moderatePrompt,
    hold: (u, credits) => holdWithRefusal(ledger, u, credits),
    getAvailable: u => ledger.getAvailable(u),
    forward: async (b) => {
      // Review I2: ComfyUI honours a client-supplied `prompt_id`. Left in
      // place, an attacker who learns a victim's id can submit their own
      // graph under it — ComfyUI runs it, and this request's settle watcher
      // then UPDATEs graph_runs WHERE prompt_id = <victim's>, replacing the
      // victim's recorded outputs with the attacker's. The engine assigns
      // ids; clients don't get to.
      const { prompt_id: _clientChosenPromptId, ...rest } = (b ?? {}) as Record<string, unknown>
      const safe: Record<string, unknown> = { ...rest, extra_data: stripForeignComfyOrgCreds((b as any)?.extra_data, null) }
      // Stage 6 Task 7: every SaveImage-family node writes under the caller's
      // own u_<hash>/ subfolder — outputs land in output/u_<hash>/... and can
      // never clobber another tenant's tree. Operates on a clone (the original
      // body is left untouched).
      if (userId && safe.prompt && typeof safe.prompt === 'object' && !Array.isArray(safe.prompt)) {
        safe.prompt = injectOutputSubfolder(safe.prompt as Record<string, any>, userId)
      }
      const res = await fetch(`${target}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: target },
        body: JSON.stringify(safe),
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
    // Review I4: record WHICH engine ran this prompt. Without it the /view
    // race-window harvest always polled :8188, so a run dispatched to a pool
    // worker (?comfyWorker=N) could never be settled from the harvest path.
    registerRun: r => createGraphRun({ ...r, target }),
    startSettle: (r) => {
      // The run's copies go when its watcher ends (success, error or timeout).
      void watchGraphRun(r, {
        pollHistory: async (id) => {
          const res = await fetch(`${target}/history/${encodeURIComponent(id)}`)
          if (!res.ok) return null
          const hist = await res.json() as Record<string, any>
          return hist[id] ?? null
        },
        settleSuccess: id => settleGraphSuccess(target, id, r.holdId, r.credits),
        ledger,
        resolve: resolveGraphRun,
        intervalMs: SETTLE_INTERVAL_MS,
        maxPolls: SETTLE_MAX_POLLS,
      }).catch(() => {}).finally(() => { void snaps.release() })
    },
    releaseHold: id => ledger.release(id),
  })

  setResponseStatus(event, result.status)
  return result.body
}

/**
 * Task G2: the charge plan for a graph — priceGraph's per-node credits and
 * render credit (the figures the hold is the sum of), plus the nodes that are
 * local renders (the Frame), which earn the render credit when they finish.
 */
export function chargePlanOf(prompt: Record<string, any>, nodes: Record<string, number>, base: number): RunChargePlan {
  const renderNodes = Object.keys(prompt).filter(id => FRAME_RENDER_TYPES.has(prompt[id]?.class_type)).sort()
  return { nodes: { ...nodes }, base, renderNodes }
}

export interface WatchGraphRunIO {
  pollHistory(promptId: string): Promise<HistoryEntry | null>
  settleSuccess(promptId: string): Promise<void>
  ledger: {
    settle(holdId: number, actual: number, reason: string): Promise<{ settled: boolean }>
    release(holdId: number): Promise<void>
  }
  resolve(promptId: string, state: 'settled' | 'voided', outputs?: string[]): Promise<void>
  sleep?: (ms: number) => Promise<void>
  intervalMs?: number
  maxPolls?: number
}

/**
 * Watch one queued graph run to its end and settle its hold:
 * - success: settleSuccess (the whole hold, unchanged);
 * - error (Task G2, user decision 09-25): charge the paid nodes that
 *   finished — partialCharge reads which from the history entry — never
 *   more than the hold; the ledger's settle releases the rest. The render
 *   credit rides on something made, as in the runner. Nothing finished, no
 *   plan, or a history entry that doesn't say what ran: release, as before G2;
 * - timeout: release (we can't confirm anything ran).
 * Resolves once the ledger work is done.
 */
export async function watchGraphRun(
  r: { promptId: string; holdId: number | null; credits: number; plan?: RunChargePlan },
  io: WatchGraphRunIO,
): Promise<'success' | 'error' | 'timeout'> {
  let settling: Promise<void> = Promise.resolve()
  const outcome = await settleOnCompletion({
    promptId: r.promptId,
    pollHistory: io.pollHistory,
    sleep: io.sleep,
    intervalMs: io.intervalMs,
    maxPolls: io.maxPolls,
    onSuccess: (id) => { settling = io.settleSuccess(id).catch(e => console.error('[graphMeter] settle failed', { id, e })) },
    onError: (id, entry) => { settling = settleGraphFailure(r, entry, io) },
  })
  await settling
  return outcome
}

async function settleGraphFailure(
  r: { promptId: string; holdId: number | null; credits: number; plan?: RunChargePlan },
  entry: HistoryEntry | undefined,
  io: WatchGraphRunIO,
): Promise<void> {
  const id = r.promptId
  const voidRun = async () => {
    if (r.holdId !== null) await io.ledger.release(r.holdId).catch(e => console.error('[graphMeter] release failed', { id, holdId: r.holdId, e }))
    await io.resolve(id, 'voided').catch(() => {})
  }
  // A timeout (no entry), or no hold to charge from: release, as before G2.
  if (!entry || r.holdId === null) return voidRun()
  if (!r.plan) {
    console.error('[graphMeter] failed run released uncharged — no charge plan recorded', { id, holdId: r.holdId })
    return voidRun()
  }
  const owed = partialCharge(entry, r.plan, r.credits)
  if ('unknown' in owed) {
    console.error('[graphMeter] failed run released uncharged — cannot tell which nodes ran', { id, holdId: r.holdId, why: owed.unknown })
    return voidRun()
  }
  if (owed.credits <= 0) return voidRun()

  const reason = `graph:${id} partial: ${owed.credits} of ${r.credits} held credits for finished nodes ${owed.nodeIds.join(', ') || '(none)'}`
    + `${owed.base ? ` + ${owed.base} render` : ''}; ${owed.interrupted ? 'stopped' : 'failed'}${owed.failedNode ? ` at node ${owed.failedNode}` : ''}`
  try {
    const s = await io.ledger.settle(r.holdId, owed.credits, reason)
    if (!s.settled) {
      console.error('[graphMeter] PARTIAL SETTLE ON RELEASED HOLD — finished nodes uncharged', { id, holdId: r.holdId, credits: owed.credits })
      captureError(new Error('graphMeter: partial settle on released hold'), { site: 'meterGraphRun.partial', promptId: id, holdId: r.holdId, credits: owed.credits })
    }
  } catch (e) {
    console.error('[graphMeter] PARTIAL SETTLE FAILED — releasing', { id, holdId: r.holdId, credits: owed.credits, e })
    return voidRun()
  }
  await io.resolve(id, 'settled', historyOutputKeys(entry)).catch(e => console.error('[graphMeter] resolve failed', { id, e }))
}

/** The output files a history entry lists (the saved pictures, clips and sounds), as graph_runs keys. */
function historyOutputKeys(entry: { outputs?: unknown } | null | undefined): string[] {
  const outputs: string[] = []
  const nodeOutputs = entry?.outputs && typeof entry.outputs === 'object' ? entry.outputs as Record<string, any> : {}
  for (const node of Object.values(nodeOutputs)) {
    for (const arr of [node?.images, node?.gifs, node?.videos, node?.audio]) {
      if (!Array.isArray(arr)) continue
      // The runner's own saved-input kind is never taken from a history (R3.6 fix round 1).
      for (const f of arr) if (f?.filename && f.type !== RUNNER_SAVED_INPUT) outputs.push(outputKey(f))
    }
  }
  return outputs
}

// Exported (Stage 5 Task 5): engineGate.ts's harvestPendingOutputs calls this
// SAME function for the /view race-window fallback, so there is exactly one
// settlement implementation rather than a second copy drifting from this one.
export async function settleGraphSuccess(target: string, promptId: string, holdId: number | null, credits: number): Promise<void> {
  let outputs: string[] = []
  try {
    const r = await fetch(`${target}/history/${encodeURIComponent(promptId)}`)
    if (r.ok) {
      const hist = await r.json() as Record<string, any>
      outputs = historyOutputKeys(hist[promptId])
    }
  } catch (e) { console.error('[graphMeter] output harvest failed', { promptId, e }) }

  if (holdId !== null) {
    try {
      const s = await getLiveLedger().settle(holdId, credits, `graph:${promptId}`)
      if (!s.settled) {
        console.error('[graphMeter] SETTLE ON RELEASED HOLD — run shipped uncharged', { promptId, holdId, credits })
        captureError(new Error('graphMeter: settle on released hold — run shipped uncharged'), { site: 'meterGraphRun', promptId, holdId, credits })
      }
    } catch (e) {
      console.error('[graphMeter] SETTLE FAILED after successful run', { promptId, holdId, credits, e })
    }
  }
  await resolveGraphRun(promptId, 'settled', outputs).catch(e => console.error('[graphMeter] resolve failed', { promptId, e }))
}
