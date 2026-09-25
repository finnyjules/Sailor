/**
 * Stage 5 Task 4: the metered graph submission path. In hosted mode the
 * comfyui-proxy middleware routes POST /prompt here instead of raw-proxying
 * (local mode falls through to the raw proxy unchanged). Invariants:
 * (1) hold BEFORE forward — an underfunded run never reaches the engine;
 * (2) ComfyUI's response body passes through VERBATIM (clients parse
 *     prompt_id / node_errors from the real shape);
 * (3) settlement is watcher-driven: settle the hold + record output filenames
 *     on success, release the hold on error/timeout. Refusals cost nothing.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { readBody, setResponseStatus } from 'h3'
import { priceGraph, UnpricedGraphError } from './priceBook'
import { createGateReads, graphInputPixels } from './graphInputPixels'
import { graphInputSeconds, seedanceReferenceSeconds } from './graphInputSeconds'
import { MeterRefusalError } from './requestMeter'
import { createGraphRun, resolveGraphRun, outputKey, ownedOutputKeys } from './graphRuns'
import { settleOnCompletion } from './settleWatcher'
import { stripForeignComfyOrgCreds } from './spikeAuth'
import { resolveWorkerTarget } from './workerRoute'
import { getLiveLedger } from './ledgerLive'
import { captureError } from './observe'
import { annotatedFilepath, collectUploadFlaggedInputs } from './engineGate'
import { canonicalUploadKey, uploadOwner } from './inputUploads'
import { GRAPH_FILE_READERS, GRAPH_FOLDER_READERS, GRAPH_OUTPUT_WRITERS, extractFileRefs, graphFolderOwnedBy, type FileRefSemantics } from './engineFileSurface'
import { extractGraphPromptText } from './graphPromptText'
import { moderatePrompt } from './moderation'
import { assertSpendAllowed } from './systemControls'
import { blockedPromptRefusal, nodeProblemsBody, retiredEngineRefusal } from './blockedModels'

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
   * Node id → the measured size of the picture each size-priced node
   * (Upscale, Enhance detail, FLUX.2 edit) is sent — graphInputPixels. Runs
   * after the file-ownership check, so it only reads the caller's own files.
   * Absent (the unit tests), every such picture is priced at the input cap.
   */
  measureInputPixels?(prompt: any): Promise<Record<string, number>>
  /**
   * Node id → the measured length of each lip-sync node's sound clip (and
   * Kling lip-sync's source video) — graphInputSeconds. Runs after the
   * file-ownership check. Absent, every lip-sync is priced at the 60 s cap.
   */
  measureInputSeconds?(prompt: any): Promise<Record<string, import('../../shared/pricing/clipSettings').InputSeconds>>
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
   * the hold is never taken and the engine is never touched. Fails OPEN (see
   * moderation.ts): an OpenAI outage yields { ok: true } and lets the run
   * through — a moderation blip must not take generation down.
   */
  moderatePrompt(text: string): Promise<{ ok: true } | { ok: false; categories: string[] }>
  hold(userId: string, credits: number): Promise<{ ok: true; holdId: number } | { ok: false; reason: 'insufficient' }>
  getAvailable(userId: string): Promise<number>
  forward(body: any): Promise<{ status: number; body: any }>
  registerRun(r: { promptId: string; userId: string; credits: number; holdId: number | null }): Promise<void>
  startSettle(r: { promptId: string; holdId: number | null; credits: number }): void
  releaseHold(holdId: number): Promise<void>
}

export async function meterGraphSubmit(userId: string | null, body: any, deps: GraphRunDeps): Promise<{ status: number; body: any }> {
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

  // Ownership of every file the graph references is checked BEFORE pricing or
  // any hold — a graph that reaches for another tenant's input/output is
  // refused (403) at zero cost, and the engine is never touched.
  await deps.validateFileRefs(body.prompt)

  // Prompt-side moderation, AFTER file-ref validation and BEFORE pricing/hold:
  // a ToS-violating prompt is refused (400) at zero cost — no hold is taken and
  // the engine is never touched. moderatePrompt fails OPEN, so an OpenAI outage
  // can never take generation down.
  const mod = await deps.moderatePrompt(extractGraphPromptText(body.prompt))
  if (!mod.ok) {
    throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })
  }

  // A discontinued or runner-only model can't run on ComfyUI: refused in
  // ComfyUI's own 400 shape before pricing and any hold (blockedModels.ts).
  const blocked = blockedPromptRefusal(body.prompt)
  if (blocked) return { status: 400, body: blocked }
  // Hosted, until F12: the two estimate-priced edit engines are refused too.
  const retired = retiredEngineRefusal(body.prompt)
  if (retired) return { status: 400, body: retired }
  // Seedance references longer than the model takes, refused in plain words (S1b fix round 1).
  const tooLong = deps.referenceSecondsProblems ? nodeProblemsBody(await deps.referenceSecondsProblems(body.prompt)) : null
  if (tooLong) return { status: 400, body: tooLong }

  // The size of the pictures a size-priced node is sent, where the gate can
  // read it; the rest price at the input cap (never below what runs).
  const inputPixels = deps.measureInputPixels ? await deps.measureInputPixels(body.prompt).catch(() => ({})) : undefined
  // The length of each lip-sync node's sound (and Kling's source video), where
  // it can read it; the rest price at the 60 s cap.
  const inputSeconds = deps.measureInputSeconds ? await deps.measureInputSeconds(body.prompt).catch(() => ({})) : undefined

  let price
  try {
    price = deps.priceGraph(body.prompt, inputPixels || inputSeconds ? { inputPixels, inputSeconds } : undefined)
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
  deps.startSettle({ promptId, holdId, credits: price.credits })
  return fwd
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
  const result = await meterGraphSubmit(userId, body, {
    priceGraph,
    measureInputPixels: prompt => graphInputPixels(prompt, undefined, reads),
    measureInputSeconds: prompt => graphInputSeconds(prompt, undefined, reads),
    // Hosted: a Seedance reference whose length can't be read is refused, not counted as 0 (S1b fix round 2).
    referenceSecondsProblems: prompt => seedanceReferenceSeconds(prompt, undefined, { strict: true }),
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
    startSettle: ({ promptId, holdId, credits }) => {
      void settleOnCompletion({
        promptId,
        intervalMs: SETTLE_INTERVAL_MS,
        maxPolls: SETTLE_MAX_POLLS,
        pollHistory: async (id) => {
          const r = await fetch(`${target}/history/${encodeURIComponent(id)}`)
          if (!r.ok) return null
          const hist = await r.json() as Record<string, any>
          return hist[id] ?? null
        },
        onSuccess: (id) => { void settleGraphSuccess(target, id, holdId, credits) },
        onError: (id) => {
          void (async () => {
            if (holdId !== null) await ledger.release(holdId).catch(e => console.error('[graphMeter] release failed', { id, holdId, e }))
            await resolveGraphRun(id, 'voided').catch(() => {})
          })()
        },
      })
    },
    releaseHold: id => ledger.release(id),
  })

  setResponseStatus(event, result.status)
  return result.body
}

// Exported (Stage 5 Task 5): engineGate.ts's harvestPendingOutputs calls this
// SAME function for the /view race-window fallback, so there is exactly one
// settlement implementation rather than a second copy drifting from this one.
export async function settleGraphSuccess(target: string, promptId: string, holdId: number | null, credits: number): Promise<void> {
  const outputs: string[] = []
  try {
    const r = await fetch(`${target}/history/${encodeURIComponent(promptId)}`)
    if (r.ok) {
      const hist = await r.json() as Record<string, any>
      const nodeOutputs = hist[promptId]?.outputs ?? {}
      for (const node of Object.values(nodeOutputs) as any[]) {
        for (const arr of [node?.images, node?.gifs, node?.videos, node?.audio]) {
          if (!Array.isArray(arr)) continue
          for (const f of arr) if (f?.filename) outputs.push(outputKey(f))
        }
      }
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
