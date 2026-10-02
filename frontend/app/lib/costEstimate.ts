/**
 * costEstimate — pure USD estimation from node price badges.
 *
 * Spans two billing modes:
 * - Replicate BYOK nodes (class names end in "RemoteNode", see
 *   comfy_api_nodes/nodes_replicate.py) declare a price_badge whose expr is
 *   either a static JSON literal (`{"type":"usd","usd":0.04,...}`) or a dynamic
 *   JSONata expression. Static parses exactly; dynamic contributes its first
 *   numeric "usd" value as a floor and marks the whole estimate approximate.
 * - Credit-billed API nodes (category starts with "api node", e.g. Kling,
 *   OpenAI) use the same badge structure as a USD-equivalent estimate for
 *   pre-run warning; post-run actual tally via credit-delta (Replicate-only).
 * Used pre-run (Run button + confirm guard) and post-run (status bar tally).
 *
 * HOSTED (opt-in, `{ hosted: true }`): the static badge is a fiction on the
 * five model-PICKER classes — GenerateVideoNode ships ONE badge figure for a
 * model range spanning $0.04 to $3.20 — so those nodes are re-priced from the
 * node's whole widget map through the one shared price calculation
 * (shared/pricing/nodePrice.ts), the one the node badge and the server charge
 * read too. The result carries `hostedCredits`, the credits figure to
 * DISPLAY: the run surfaces must
 * not re-convert it (creditsForUsd would ceil a second time and the dialog
 * would disagree with the badge it sits next to). Local mode never takes any
 * of this path — the flag is a parameter, never read from runtime config here,
 * so this module stays pure and unit-testable.
 */
import { BASE_RENDER_CREDITS } from '~/lib/nodeCreditEstimate'
import { creditsForUsd } from '~/lib/pricing'
import { FAMILY_PRICED_CLASSES, priceNode } from '#shared/pricing/nodePrice'
import { estimateFloored } from '#shared/pricing/estimateFloor'
import { sizePricedInput, sourceOutputPixels } from '#shared/pricing/editSettings'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY } from '#shared/runner/eligibility'
import { LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_PICTURE_INPUT, SAM_MASK_CLASSES, isLocalModelClass } from '#shared/runner/localModels'
import { LIPSYNC_MAX_SECONDS, allotMediaFiles, gateNodeOrder, mediaFileKey, readViewRef, secondsPricedMedia, sourceAudioSeconds, type InputSeconds, type MediaFileRef, type MediaSource } from '#shared/pricing/clipSettings'

export interface BadgeCost { usd: number; approximate: boolean }

export function parseBadgeUsd(expr: string | null | undefined): BadgeCost | null {
  if (!expr) return null
  const s = String(expr).trim()
  try {
    const parsed = JSON.parse(s)
    if (typeof parsed?.usd === 'number') {
      return { usd: parsed.usd, approximate: !!parsed?.format?.approximate }
    }
  } catch { /* not a JSON literal — fall through to the JSONata floor */ }
  const match = s.match(/"usd"\s*:\s*([0-9]+\.?[0-9]*)/)
  if (match) return { usd: parseFloat(match[1]!), approximate: true }
  return null
}

export interface EstimateInputNode {
  id: string
  type: string
  title?: string
  badgeExpr?: string | null
  category?: string | null
  /** Ordered widget definitions (Vue node `data.widgetDefs`). Carried so the
   *  hosted path can price the node from its widgets; unused in local mode. */
  widgetDefs?: { name?: string }[] | null
  /** Widget values, positionally aligned with `widgetDefs`. */
  widgetsValues?: unknown[] | null
  /** Names of the node's inputs fed by a link (see `linkedInputNames`). */
  linkedInputs?: string[] | null
  /** Size-priced nodes: the picture size the canvas can see upstream (upstreamInputPixels), else absent (the cap). */
  inputPixels?: number | null
  /** Lip-sync nodes: the media lengths the canvas knows (upstreamInputSeconds), else absent (the 60 s cap). */
  inputSeconds?: InputSeconds | null
  /**
   * R7 per-frame nodes (Background remove): how many pictures the canvas can
   * see coming in (upstreamPictureCount), or null when it can't (a clip, a
   * source it can't bound): priced then at the frame cap, "up to".
   */
  pictures?: number | null
}
/** `upTo`: priced at its ceiling (a clip's frame cap), the run may cost less. */
export interface CostBreakdownItem { id: string; label: string; usd: number; credits?: boolean; upTo?: true }
export interface CostEstimate {
  usd: number
  approximate: boolean
  breakdown: CostBreakdownItem[]
  /** Hosted only: the total to DISPLAY, already through the markup policy.
   *  Null/absent in local mode. Never feed this back through creditsForUsd. */
  hostedCredits?: number | null
}

/** A node's widgets as a name → value map — the input map the shared price
 *  calculation takes. widgetsValues is positional against widgetDefs, so each
 *  name is resolved by index. Unnamed defs are skipped; a name that appears
 *  twice keeps its first value (the one `widgetIndex(name)` finds). */
export function widgetValueMap(
  widgetDefs: readonly ({ name?: string } | null | undefined)[] | null | undefined,
  widgetsValues: readonly unknown[] | null | undefined,
  linkedInputs?: Iterable<string> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const defs = widgetDefs || []
  for (let i = 0; i < defs.length; i++) {
    const name = defs[i]?.name
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue
    out[name] = widgetsValues?.[i]
  }
  // A linked input wins over its widget value, as graphToPrompt does: the API
  // prompt carries a [nodeId, slot] reference there, whose value is known only
  // at run time. The shared price reads such a reference as "linked" and
  // prices it at its most expensive — so the badge marks it the same way.
  for (const name of linkedInputs ?? []) out[name] = [LINKED_INPUT_SOURCE, 0]
  return out
}

/** Stand-in origin id for a linked input in the badge's map (only its array shape matters). */
export const LINKED_INPUT_SOURCE = 'linked'

/**
 * Names of a canvas node's inputs that are fed by a link: those whose saved
 * `.link` is set, or that a live Vue Flow edge targets (`input-<index>`; Vue
 * Flow's connect only updates edges, never `.link`).
 */
export function linkedInputNames(
  nodeId: string,
  inputs: readonly ({ name?: string, link?: unknown } | null | undefined)[] | null | undefined,
  edges?: readonly ({ target?: unknown, targetHandle?: string | null } | null | undefined)[] | null,
): string[] {
  const list = inputs || []
  const idx = new Set<number>()
  for (let i = 0; i < list.length; i++) if (list[i]?.link != null) idx.add(i)
  for (const e of edges || []) {
    if (String(e?.target) !== String(nodeId)) continue
    const m = /^input-(\d+)$/.exec(e?.targetHandle ?? '')
    if (m) idx.add(Number(m[1]))
  }
  const names: string[] = []
  for (const i of [...idx].sort((a, b) => a - b)) {
    const name = list[i]?.name
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** A node bills the user in USD (Replicate BYOK, or fal through Sailor's
 *  runner) rather than Comfy credits. Most are class-named `*RemoteNode`
 *  (comfy_api_nodes/nodes_replicate.py), but the Sailor wrappers that call
 *  Replicate from comfy_extras (Person Swap, Pose Mannequin) aren't — they're
 *  caught by their `…/Replicate` category; the fal runner nodes (Fix faces,
 *  Face swap, Person swap (video)) by `…/fal`.
 *  Stock Comfy API nodes (OpenAI, Kling, …) are credit-billed and excluded. */
export function isReplicateBilled(n: EstimateInputNode): boolean {
  return !!n.type?.endsWith('RemoteNode') || /\/(Replicate|fal)$/.test(n.category || '')
}

/** Stock Comfy API nodes (Kling, OpenAI, …) bill in Comfy credits. Their
 *  price_badge carries the same {"usd":N} literals, so the parsed floor doubles
 *  as a USD-equivalent estimate — approximate by nature. */
export function isApiCreditBilled(n: EstimateInputNode): boolean {
  return !isReplicateBilled(n) && (n.category || '').startsWith('api node')
}

/** Sum USD across Replicate BYOK and credit-billed API nodes in the list. Null when none are priced.
 *
 *  `opts.hosted` (default false → local mode unchanged) re-prices the five
 *  model-picker classes off their selected model and fills `hostedCredits`.
 *  Credits are summed PER NODE and only then totalled: the markup policy has a
 *  tier boundary at $0.10, so converting the summed dollars in one shot
 *  under-quotes any mix of cheap nodes ($0.10 + $0.10 → 30cr one-shot vs 40cr
 *  per node) and disagrees with the per-node badges.
 *
 *  base_render is added ONCE per run — priceGraph's semantics, since the run is
 *  one graph submit. (The per-node badge adds it per node; for a single-node
 *  run, the common case, both land on the same figure.) A run whose graph has
 *  no terminal output node would not be charged base_render at all, so this
 *  can over-quote by 1 credit — deliberate, an estimate should err high.
 *
 *  `opts.families`: the runner families the browser has on (none while the
 *  runner is off). Only Rotate camera reads them: on Qwen Image Edit 2511
 *  while its switch is on, priced as the runner charges it (Task F10). */
export function estimateUsdForNodes(
  nodes: EstimateInputNode[],
  opts: { hosted?: boolean, families?: ReadonlySet<RunnerFamily> } = {},
): CostEstimate | null {
  const hosted = opts.hosted === true
  let usd = 0
  let approximate = false
  let credits = 0
  const breakdown: CostBreakdownItem[] = []
  for (const n of nodes) {
    const creditBilled = isApiCreditBilled(n)
    // R7 (USER ruling, fix round 1): a per-frame node is priced as it is held: the pictures the canvas sees
    // coming in, else the frame cap ("up to"); local runs too (ruling (a): they cost the same few cents).
    const perFrame = isLocalModelClass(n.type)
    const frames = perFrame ? localModelFrames(n.pictures ?? null, hosted) : null
    // Hosted: a model-priced picker is charged by the server whatever its
    // billing class, so price it even if the badge/category filter misses it.
    // Priced from the WHOLE widget map, the same way the server charges it.
    // An estimate-priced R3 class off the runner at its flat price before R3, as priceGraph charges it (R3.9 fix round 2).
    const values = hosted || perFrame ? widgetValueMap(n.widgetDefs, n.widgetsValues, n.linkedInputs) : null
    const inputSeconds = frames ? { ...(n.inputSeconds ?? {}), ...localModelSeconds(frames, hosted) } : n.inputSeconds
    const shared = values ? estimateFloored(n.type, values, priceNode(n.type, values, { inputPixels: n.inputPixels, inputSeconds, families: opts.families }), opts.families) : null
    const modelPrice = shared && !('refused' in shared) ? shared : null
    if (modelPrice == null && !isReplicateBilled(n) && !creditBilled) continue
    // The selected model's real price beats the static badge when we have it.
    const cost = modelPrice != null ? { usd: modelPrice.usd, approximate: true } : parseBadgeUsd(n.badgeExpr)
    if (!cost) continue
    usd += cost.usd
    // A model-priced node carries its credits from the shared calculation; a
    // static badge's USD goes through the same markup function.
    if (hosted) credits += modelPrice != null ? modelPrice.credits : creditsForUsd(cost.usd)
    approximate = approximate || cost.approximate || creditBilled
    const upTo = !!(frames?.upTo && modelPrice != null)
    breakdown.push({
      id: n.id,
      label: (n.title || n.type) + (creditBilled ? ' (credits)' : '') + (upTo ? ' (up to)' : ''),
      usd: cost.usd,
      ...(creditBilled ? { credits: true } : {}),
      ...(upTo ? { upTo: true as const } : {}),
    })
  }
  if (!breakdown.length) return null
  return { usd, approximate, breakdown, ...(hosted ? { hostedCredits: credits + BASE_RENDER_CREDITS } : {}) }
}

/** Adapt Vue Flow canvas nodes (ComfyNode data shape) to estimate input.
 *  The LiteGraph class name lives in data.nodeType (data.type is the Vue Flow
 *  renderer type). Disabled nodes (mode 2) are excluded — they don't run.
 *  widgetDefs/widgetsValues ride along so the hosted estimate can price the
 *  node from its widgets; local mode ignores them. `edges` (the canvas's live
 *  Vue Flow edges) mark the linked inputs, as the node badge does.
 *  `families`: as estimateUsdForNodes' (which pictures are size-priced). */
export function vueNodesToEstimateInput(nodes: any[], edges?: any[] | null, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): EstimateInputNode[] {
  return (nodes || [])
    .filter((n: any) => ((n?.data?.mode ?? 0) !== 2))
    .map((n: any) => ({
      id: String(n.id),
      type: String(n?.data?.nodeType || ''),
      title: n?.data?.title,
      badgeExpr: n?.data?.priceBadge?.expr ?? null,
      category: n?.data?.category ?? null,
      widgetDefs: n?.data?.widgetDefs ?? null,
      widgetsValues: n?.data?.widgetsValues ?? null,
      linkedInputs: linkedInputNames(String(n.id), n?.data?.inputs, edges),
      inputPixels: upstreamInputPixels(n, nodes, edges, families),
      inputSeconds: upstreamInputSeconds(n, nodes, edges)?.seconds ?? null,
      ...(isLocalModelClass(String(n?.data?.nodeType || '')) ? { pictures: upstreamPictureCount(n, nodes, edges) } : {}),
    }))
}

/**
 * A per-frame node's frames for its price (R7, fix round 1): the pictures the
 * canvas sees, else the frame cap where it runs (hosted or this computer),
 * "up to". The runner holds the count it measures before the run, never above.
 */
export function localModelFrames(pictures: number | null, hosted: boolean): { frames: number; upTo: boolean } {
  if (pictures != null && pictures >= 1) return { frames: pictures, upTo: false }
  return { frames: hosted ? LOCAL_MODEL_MAX_FRAMES.hosted : LOCAL_MODEL_MAX_FRAMES.local, upTo: true }
}

/**
 * A per-frame node's priced media (R7.6 fix round 1): its frames, and, when
 * they are the frame cap ("up to"), WHERE the canvas runs, so a price that
 * grows with the clip's size (Slow motion (AI)) takes that place's largest
 * clip — this computer's caps locally, hosted's in hosted — never less than
 * the runner can hold there.
 */
export function localModelSeconds(f: { frames: number; upTo: boolean }, hosted: boolean): InputSeconds {
  return { frames: f.frames, ...(f.upTo ? { framesUpTo: hosted ? 'hosted' as const : 'local' as const } : {}) }
}

/** Sources that hand on one picture (the runner's server/runner/localModelStart.ts pictureBound, as far as the canvas sees). */
const ONE_PICTURE_SOURCES: ReadonlySet<string> = new Set(['LoadImage', 'Compositor', 'Scene3DStudio', 'TextOnPath', 'TextMask', 'ShaderEffect'])

/**
 * How many pictures a per-frame canvas node gets (R7, fix round 1), as far
 * as the canvas can tell from its wires and widgets: one from a loader, an
 * Image card, a Frame or a provider's picture; Empty image's batch; through
 * Gates, Image cards fed by a wire and another per-frame node. Null for a
 * clip or any source it can't bound (priced then at the frame cap).
 */
export function upstreamPictureCount(node: any, nodes?: readonly any[] | null, edges?: readonly any[] | null, depth = 0): number | null {
  if (!node?.data || !nodes || !edges || depth > 64) return null
  const ct = String(node.data.nodeType || '')
  // R7.4: Mask by text and Mask extractor read the first picture only: one call, whatever comes in.
  if (SAM_MASK_CLASSES.has(ct)) return 1
  const name = Object.prototype.hasOwnProperty.call(LOCAL_MODEL_PICTURE_INPUT, ct) ? LOCAL_MODEL_PICTURE_INPUT[ct]! : ct === 'ComfyGateNode' ? 'data_in' : ct === 'Image' ? 'images' : null
  if (!name) return null
  const port = (node.data.inputs || []).findIndex((i: any) => i?.name === name)
  const edge = port >= 0 ? edges.find((e: any) => String(e?.target) === String(node.id) && e?.targetHandle === `input-${port}`) : null
  if (!edge) return ct === 'Image' ? 1 : null
  const src = nodes.find((m: any) => String(m?.id) === String(edge.source))
  const st = String(src?.data?.nodeType || '')
  if (!src?.data) return null
  if (st === 'EmptyImage') {
    const own = widgetValueMap(src.data.widgetDefs, src.data.widgetsValues, linkedInputNames(String(src.id), src.data.inputs, edges))
    const b = own.batch_size === undefined ? 1 : Number(own.batch_size)
    return Number.isInteger(b) && b >= 1 ? b : null
  }
  if (st === 'Image' || st === 'ComfyGateNode' || isLocalModelClass(st)) return upstreamPictureCount(src, nodes, edges, depth + 1)
  if (ONE_PICTURE_SOURCES.has(st) || IMAGE_OUTPUT_CLASSES.has(st) || Object.prototype.hasOwnProperty.call(PAID_PICTURE_FAMILY, st)) return 1
  return null
}

/**
 * The size of the picture a size-priced canvas node (Upscale, Enhance detail,
 * FLUX.2 edit) will be sent, when the canvas can tell: the live edge into its
 * picture input comes from a GenerateImageNode whose settings say how large
 * its picture is (sourceOutputPixels — the hosted gate reads the same). Null
 * otherwise: the badge then shows the input-cap ceiling, never below the charge.
 * `families`: the runner families on (Rotate camera is size-priced only while
 * its Qwen Image Edit 2511 switch is on).
 */
export function upstreamInputPixels(node: any, nodes?: readonly any[] | null, edges?: readonly any[] | null, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): number | null {
  const data = node?.data
  if (!data || !nodes || !edges) return null
  const own = widgetValueMap(data.widgetDefs, data.widgetsValues, linkedInputNames(String(node.id), data.inputs, edges))
  const name = sizePricedInput(String(data.nodeType || ''), own, families)
  const port = name ? (data.inputs || []).findIndex((i: any) => i?.name === name) : -1
  if (port < 0) return null
  const edge = edges.find((e: any) => String(e?.target) === String(node.id) && e?.targetHandle === `input-${port}`)
  const src = edge ? nodes.find((m: any) => String(m?.id) === String(edge.source)) : null
  if (!src?.data) return null
  const srcInputs = widgetValueMap(src.data.widgetDefs, src.data.widgetsValues, linkedInputNames(String(src.id), src.data.inputs, edges))
  return sourceOutputPixels(String(src.data.nodeType || ''), srcInputs)
}

/**
 * The media lengths a lip-sync canvas node's price depends on, as far as the
 * canvas knows them (P5 fix rounds 1–2), and whether the price is still a ceiling:
 *  - the sound wired from an Audio card: the length the card read from its own
 *    file (`data.audioSeconds`, recorded by ArtifactAudioNode for that file),
 *    or its source followed on; an empty card is 1 s of silence;
 *  - from MusicGen / Generate music: its duration widget (sourceAudioSeconds —
 *    the hosted gate reads the same);
 *  - anything else (a loaded file the canvas hasn't read, text to speech, the
 *    Lip-Sync Studio's `/view` links, Kling's source video): not known.
 * A file counts as known only if the gate will also read it: the gate reads at
 * most LIPSYNC_MEDIA_READS media files per run, handed out in a fixed order
 * (canvasMediaAllotment mirrors it over the whole canvas, a superset of any
 * run's graph), and prices the rest at the cap.
 * `upTo` is true when an unknown length changes the price — the badge then
 * shows the 60 s figure as "up to", never below the charge. Null for a class
 * with no such media.
 */
export function upstreamInputSeconds(node: any, nodes?: readonly any[] | null, edges?: readonly any[] | null): { seconds: InputSeconds, upTo: boolean } | null {
  const data = node?.data
  if (!data) return null
  const ct = String(data.nodeType || '')
  // Enhance a video on fal's Topaz (F23): the canvas can't read the video, so
  // its price is always the ceiling (60 s, above 1080p, 60 fps): "up to".
  // (With its switch off the class isn't priced here and the badge is Python's.)
  if (Object.prototype.hasOwnProperty.call(FAMILY_PRICED_CLASSES, ct)) return { seconds: {}, upTo: true }
  // An R7 per-frame node (Background remove, fix round 1): the pictures the canvas sees, else the hosted
  // frame cap, "up to" (the badge's hosted credits; localModelFrames picks the cap where it runs).
  if (isLocalModelClass(ct)) {
    const f = localModelFrames(upstreamPictureCount(node, nodes, edges), true)
    return { seconds: localModelSeconds(f, true), upTo: f.upTo }
  }
  // Describe a video (R3.4): the canvas can't see the video's length, so it is
  // priced at its ceiling (45 minutes, the longest answer): "up to". The
  // runner charges an uploaded video by its length and the tokens used.
  if (ct === 'DescribeVideoNode') return { seconds: {}, upTo: true }
  const own = widgetValueMap(data.widgetDefs, data.widgetsValues, linkedInputNames(String(node.id), data.inputs, edges ?? []))
  const media = secondsPricedMedia(ct, own)
  if (!media) return null
  const seconds: InputSeconds = {}
  const origin = canvasMediaOrigin(node, media.audio, nodes, edges)
  if (origin && 'seconds' in origin) seconds.audio = origin.seconds
  else if (origin && origin.known != null && canvasMediaAllotment(nodes, edges).has(mediaFileKey('audio', origin.file))) seconds.audio = origin.known
  // Sync lips in "silence" on an uploaded video (R11.3, ruling (o)): the canvas can't read the video's
  // length; the runner measures it and refuses one over 60 s before the hold, so the badge is "up to" 60 s.
  if ((ct === 'LipsyncNode' || ct === 'LipsyncRemoteNode') && own.sync_mode === 'silence' && readViewRef(own.video_url)?.name) seconds.videoUpTo = LIPSYNC_MAX_SECONDS
  // Would a short clip lower the price? Then an unknown length is in it.
  const at = (s: InputSeconds) => { const p = priceNode(ct, own, { inputSeconds: s }); return 'refused' in p ? null : p.credits }
  const known = at(seconds)
  const shortest = at({ audio: seconds.audio ?? 1, video: seconds.video ?? 1 })
  return { seconds, upTo: known != null && shortest != null && shortest < known }
}

type CanvasOrigin = { file: MediaFileRef, known: number | null } | { seconds: number } | null

/** Where a canvas lip-sync node's sound comes from (the gate's mediaOrigin, over canvas nodes and edges). */
function canvasMediaOrigin(node: any, src: MediaSource, nodes?: readonly any[] | null, edges?: readonly any[] | null): CanvasOrigin {
  if (!src) return null
  if ('inputFile' in src) return { file: { value: src.inputFile, literalInput: true }, known: null }
  let cur = node
  let name = 'audio'
  for (let hop = 0; hop < 8 && cur?.data && nodes && edges; hop++) {
    const idx = (cur.data.inputs || []).findIndex((i: any) => i?.name === name)
    if (idx < 0) return null
    const edge = edges.find((e: any) => String(e?.target) === String(cur.id) && e?.targetHandle === `input-${idx}`)
    const from = edge ? nodes.find((m: any) => String(m?.id) === String(edge.source)) : null
    if (!from?.data) return null
    const sct = String(from.data.nodeType || '')
    const si = widgetValueMap(from.data.widgetDefs, from.data.widgetsValues, linkedInputNames(String(from.id), from.data.inputs, edges))
    if (sct === 'Audio' || sct === 'LoadAudio') {
      if (sct === 'Audio' && Array.isArray(si.source)) { cur = from; name = 'source'; continue }
      const file = typeof si.audio === 'string' ? si.audio : ''
      if (!file) return sct === 'Audio' ? { seconds: 1 } : null
      const meta = from.data.audioSeconds
      const known = meta && meta.file === file && Number.isFinite(meta.seconds) && meta.seconds > 0 ? meta.seconds : null
      return { file: { value: file, literalInput: false }, known }
    }
    const n = sourceAudioSeconds(sct, si)
    return n == null ? null : { seconds: n }
  }
  return null
}

/**
 * The media files the gate would read if the whole canvas ran: every lip-sync
 * node that runs (not muted), in the gate's order, its sound then its video,
 * the first LIPSYNC_MEDIA_READS distinct files (allotMediaFiles). A run of part
 * of the canvas holds fewer files, so a file allotted here is allotted there too.
 */
export function canvasMediaAllotment(nodes?: readonly any[] | null, edges?: readonly any[] | null): Set<string> {
  const byId = new Map<string, any>()
  for (const n of nodes ?? []) if (n?.data && (n.data.mode ?? 0) !== 2) byId.set(String(n.id), n)
  const keys: string[] = []
  for (const id of gateNodeOrder(byId.keys())) {
    const n = byId.get(id)
    const own = widgetValueMap(n.data.widgetDefs, n.data.widgetsValues, linkedInputNames(id, n.data.inputs, edges ?? []))
    const media = secondsPricedMedia(String(n.data.nodeType || ''), own)
    if (!media) continue
    const audio = canvasMediaOrigin(n, media.audio, nodes, edges)
    if (audio && 'file' in audio) keys.push(mediaFileKey('audio', audio.file))
    const video = media.video && 'inputFile' in media.video ? { value: media.video.inputFile, literalInput: true } : null
    if (video) keys.push(mediaFileKey('video', video))
  }
  return allotMediaFiles(keys)
}
