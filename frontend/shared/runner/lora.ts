/**
 * Flux Dev + LoRA and Flux Dev + LoRAs (step 3, R3.13, family `lora`): what
 * the runner (server/runner/generators/lora.ts, server/runner/loraFiles.ts),
 * the rule rows (./eligibility.ts), the request rules and the price module
 * (shared/pricing/paidSettings.ts) all read about the two classes of
 * comfy_api_nodes/nodes_replicate.py:
 *
 *  - FluxLoRARemoteNode (:480-665): one Replicate call, the user's own trained
 *    model run directly, else black-forest-labs/flux-dev-lora with
 *    `lora_weights` (replicate_refs.py resolve_flux_lora_plan, :233-249);
 *  - FluxMultiLoRARemoteNode (:678-977): lucataco/flux-dev-multi-lora, with the
 *    reload retry (a second call, the order flipped, when the answer's logs
 *    lack "Downloading LoRA weights", :955-968);
 *  - RestyleWithLoRANode (:3180-3432, R3.14): its Flux call is Flux Dev +
 *    LoRA's plan with the same `lora_name` and `lora_url` widgets, but it
 *    reads the picked LoRA's sidecar (its trigger and aesthetic) even when a
 *    link is pasted, and its guidance widget is `flux_guidance`.
 *
 * The pure parts of replicate_refs.py that decide what a LoRA reference is
 * are ported here, line for line (`_is_replicate_model_ref`,
 * `_bare_owner_model`, `_replicate_model_to_lora_ref`, `_normalize_lora_ref`,
 * `_multilora_collect`, and nodes_replicate.py `_fold_prompt_in`), so the
 * hosted rule (ruling (i)) reads a reference exactly as the node does (the
 * runner's own reading of a pasted link, `runnerLoraLink`, is fix round 1's
 * deliberate deviation). What
 * reads a sidecar file lives on the server (server/runner/loraFiles.ts).
 *
 * Pure; relative imports only.
 */
import { isLink } from './graph'
import { pyStrip } from './pyText'

export const FLUX_LORA_CLASS = 'FluxLoRARemoteNode'
export const FLUX_MULTI_LORA_CLASS = 'FluxMultiLoRARemoteNode'
export const LORA_CLASSES = [FLUX_LORA_CLASS, FLUX_MULTI_LORA_CLASS] as const
export type LoraClass = typeof LORA_CLASSES[number]

export const FLUX_DEV_LORA_SLUG = 'black-forest-labs/flux-dev-lora'
export const FLUX_MULTI_LORA_SLUG = 'lucataco/flux-dev-multi-lora'

/** `_FLUX_LORA_ASPECT_RATIOS` (nodes_replicate.py:484). */
export const FLUX_LORA_ASPECT_RATIOS = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21'] as const
export const FLUX_LORA_MEGAPIXELS = ['1', '0.25'] as const
/** The steps both nodes offer (4–50, default 28). */
export const FLUX_LORA_STEPS = { min: 4, max: 50, default: 28 } as const
/** The LoRA picker's "no LoRA" entry (`folder_paths.get_filename_list("loras") + ["[None]"]`). */
export const LORA_NONE = '[None]'

/** Flux Dev + LoRAs' four slots, in Python's order: picker, override link, scale. */
export const MULTI_LORA_SLOTS = [
  { name: 'lora_a', url: 'lora_a_url', scale: 'scale_a', def: 0.9 },
  { name: 'lora_b', url: 'lora_b_url', scale: 'scale_b', def: 0.8 },
  { name: 'lora_c', url: 'lora_c_url', scale: 'scale_c', def: 0.7 },
  { name: 'lora_d', url: 'lora_d_url', scale: 'scale_d', def: 0.6 },
] as const

/**
 * The most guidance flux-dev-lora's published schema takes (`guidance`,
 * maximum 10); Flux Dev + LoRA offers up to 20 and Python sends it, and
 * Replicate refuses the request. The user's trained model (`guidance_scale`)
 * and flux-dev-multi-lora (the node's own maximum is 10) are not limited here.
 */
export const FLUX_DEV_LORA_GUIDANCE_MAX = 10
export const FLUX_LORA_GUIDANCE_TOO_HIGH = 'Flux Dev + LoRA takes a guidance up to 10 with this LoRA. Pick a smaller one.'

/** The marker the multi-LoRA model prints once per LoRA it loads (:952). */
export const LORA_LOADED_MARKER = 'Downloading LoRA weights'

/** Every LoRA picker and link widget, by class: the names the picker lists from library/loras/, the links sent. */
export const LORA_NAME_INPUTS: Readonly<Record<LoraClass, readonly string[]>> = {
  FluxLoRARemoteNode: ['lora_name'],
  FluxMultiLoRARemoteNode: MULTI_LORA_SLOTS.map(s => s.name),
}
export const LORA_URL_INPUTS: Readonly<Record<LoraClass, readonly string[]>> = {
  FluxLoRARemoteNode: ['lora_url'],
  FluxMultiLoRARemoteNode: MULTI_LORA_SLOTS.map(s => s.url),
}

/** Restyle an Image · Style LoRA (R3.14): a pipeline whose Flux call is Flux Dev + LoRA's plan. */
export const RESTYLE_LORA_CLASS = 'RestyleWithLoRANode'
/** Its Nano Banana resolutions and output formats (define_schema's options). */
export const RESTYLE_LORA_RESOLUTIONS = ['1K', '2K', '4K'] as const
export const RESTYLE_LORA_FORMATS = ['png', 'jpg'] as const
/** Restyle's Flux guidance over flux-dev-lora's schema maximum (FLUX_DEV_LORA_GUIDANCE_MAX): its own words. */
export const RESTYLE_GUIDANCE_TOO_HIGH = 'Restyle an image takes a Flux guidance up to 10 with this LoRA. Pick a smaller one.'

export function isLoraClass(classType: unknown): classType is LoraClass {
  return classType === FLUX_LORA_CLASS || classType === FLUX_MULTI_LORA_CLASS
}

// ── replicate_refs.py, ported ──

/** `_is_replicate_model_ref` (:135-150): `<owner>/<model>` or `<owner>/<model>/<version>` (or `:<version>`), not a URL / HF / CivitAI / .safetensors. */
export function isReplicateModelRef(value: string): boolean {
  const s = pyStrip(value ?? '')
  if (!s || s.includes('://')) return false
  const low = s.toLowerCase()
  if (low.endsWith('.safetensors')) return false
  if (low.includes('huggingface.co') || low.includes('civitai.com') || low.startsWith('hf.co/')) return false
  const parts = s.split('/').filter(p => p)
  return parts.length === 2 || parts.length === 3
}

/** `_bare_owner_model` (:153-157): `<owner>/<model>:<hash>` or `<owner>/<model>/<version>` → `<owner>/<model>`. */
export function bareOwnerModel(value: string): string {
  const s = pyStrip(value ?? '').split(':')[0]!
  return s.split('/').filter(p => p).slice(0, 2).join('/')
}

/** `_replicate_model_to_lora_ref` (:196-206): `<owner>/<model>:<hash>` → `<owner>/<model>/<hash>`. */
export function replicateModelToLoraRef(modelRef: string): string {
  const ref = pyStrip(modelRef ?? '')
  if (ref.includes('://')) return ref
  if (ref.includes(':') && ref.includes('/')) {
    const at = ref.lastIndexOf(':')
    const version = ref.slice(at + 1)
    if (version) return `${ref.slice(0, at)}/${version}`
  }
  return ref
}

/** `_normalize_lora_ref` (:209-230): the scheme of any pasted URL stripped, hf.co → huggingface.co. */
export function normalizeLoraRef(value: string): string {
  let ref = pyStrip(value ?? '')
  if (!ref) return ref
  let low = ref.toLowerCase()
  for (const scheme of ['https://', 'http://']) {
    if (low.startsWith(scheme)) {
      ref = ref.slice(scheme.length)
      low = ref.toLowerCase()
      break
    }
  }
  if (low.startsWith('hf.co/')) ref = `huggingface.co/${ref.slice('hf.co/'.length)}`
  return ref
}

/** The hosts whose pasted links flux-dev-lora reads without their scheme (its `lora_weights` forms). */
const SCHEMELESS_HOSTS = ['huggingface.co/', 'hf.co/', 'civitai.com/']
const SCHEME_RE = /^https?:\/\//i

/**
 * A pasted LoRA link as the RUNNER sends it (R3.13 fix round 1, a deliberate
 * deviation from Python, runner only; the ComfyUI path keeps Python's).
 * Python's `_normalize_lora_ref` strips the scheme from ANY link, although
 * its own docstring says "for known hosts": `https://cdn.x/w.safetensors`
 * goes out as `cdn.x/w.safetensors`, which flux-dev-lora reads as a
 * Replicate model address and flux-dev-multi-lora (a "Huggingface path, or
 * URL") as neither. So:
 *  - Flux Dev + LoRA (flux-dev-lora): the scheme is stripped only for
 *    huggingface.co, hf.co and civitai.com (then hf.co → huggingface.co, as
 *    Python); a link to any other host keeps its `https://`.
 *  - Flux Dev + LoRAs (flux-dev-multi-lora): a pasted http(s) link is sent as
 *    pasted (stripped of blanks only).
 *  - A link with no scheme is read exactly as Python reads it.
 * A link that keeps its scheme is never looked up on HuggingFace (the look-up
 * leaves full URLs alone). The fixture records Python's own requests and,
 * beside them, Python's with this rule (`runner`), so the spec shows each
 * case where the two differ.
 */
export function runnerLoraLink(classType: LoraClass, value: string): string {
  const s = pyStrip(value ?? '')
  const m = SCHEME_RE.exec(s)
  if (!m) return normalizeLoraRef(s)
  if (classType === FLUX_MULTI_LORA_CLASS) return s
  const rest = s.slice(m[0].length).toLowerCase()
  return SCHEMELESS_HOSTS.some(h => rest.startsWith(h)) ? normalizeLoraRef(s) : s
}

/** Where `_autodetect_huggingface` (nodes_replicate.py:162-192) leaves a reference alone: blank, no '/', or a full URL / explicit host. */
export function huggingfaceLookupRepo(value: string): string | null {
  const ref = pyStrip(value ?? '')
  if (!ref || !ref.includes('/')) return null
  const low = ref.toLowerCase()
  if (['http://', 'https://', 'huggingface.co/', 'civitai.com/', 'replicate.com/'].some(p => low.startsWith(p))) return null
  return ref.split('/').slice(0, 2).join('/')
}

/** `_multilora_collect` (:517-540): slots that resolved to nothing dropped, a repeated reference collapsed onto its highest scale. */
export function multiloraCollect(resolved: readonly (readonly [string | null, number])[]): { loras: string[], scales: number[] } {
  const loras: string[] = []
  const scales: number[] = []
  for (const [ref, scale] of resolved) {
    if (!ref) continue
    const i = loras.indexOf(ref)
    if (i >= 0) {
      scales[i] = Math.max(scales[i]!, scale)
      continue
    }
    loras.push(ref)
    scales.push(scale)
  }
  return { loras, scales }
}

/** `_fold_prompt_in` (nodes_replicate.py:113-117): the wired idea leads, the typed prompt follows. */
export function foldPromptIn(prompt: string, promptIn: string): string {
  const idea = pyStrip(promptIn ?? '')
  if (!idea) return prompt
  return !pyStrip(prompt ?? '') ? idea : `${idea} ${prompt}`
}

// ── What each node uses ──

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Whether a picker names a LoRA (`_read_lora_sidecar` reads nothing for '' or '[None]'). */
export function namesLora(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== LORA_NONE
}

/**
 * The LoRAs a node reads by name (their sidecars): Flux Dev + LoRA's picker
 * only when `lora_url` is blank (the link wins; Python never reads the
 * sidecar then), each Flux Dev + LoRAs slot the same way. A wired picker or
 * link is left out (the rule row sends a wired widget to the engine).
 */
export function loraNamesUsed(classType: string, inputs: Record<string, unknown>): { input: string, name: string }[] {
  // Restyle reads its picked LoRA's sidecar whatever the link (the trigger and aesthetic go into its prompt).
  if (classType === RESTYLE_LORA_CLASS) return !isLink(inputs.lora_name) && namesLora(inputs.lora_name) ? [{ input: 'lora_name', name: inputs.lora_name }] : []
  if (!isLoraClass(classType)) return []
  const pairs = classType === FLUX_LORA_CLASS ? [{ name: 'lora_name', url: 'lora_url' }] : MULTI_LORA_SLOTS
  const out: { input: string, name: string }[] = []
  for (const s of pairs) {
    const name = inputs[s.name]
    const url = inputs[s.url]
    if (isLink(name) || isLink(url) || pyStrip(str(url))) continue
    if (namesLora(name)) out.push({ input: s.name, name })
  }
  return out
}

// ── Hosted (ruling (i)) and the request rules ──

export const LORA_BY_NAME_HOSTED = 'Your own LoRAs can’t be used here yet. Paste a public LoRA link from HuggingFace or CivitAI, or a .safetensors link.'
export const LORA_TRAINED_MODEL_HOSTED = 'A trained model’s address can’t be used here yet. Paste a public LoRA link from HuggingFace or CivitAI, or a .safetensors link.'
export const LORA_LINK_NOT_PUBLIC = 'This LoRA link isn’t one Sailor can use here. Paste a public LoRA link from HuggingFace or CivitAI, or a .safetensors link.'
export const LORA_WIRED_HOSTED = 'A LoRA can’t come from a wire here. Paste a public LoRA link from HuggingFace or CivitAI, or a .safetensors link.'
/** Restyle reads a picked LoRA's settings file even beside a pasted link: hosted asks for none picked. */
export const RESTYLE_LORA_BY_NAME_HOSTED = 'Your own LoRAs can’t be used here yet. Set the LoRA to none, and paste a public LoRA link from HuggingFace or CivitAI, or a .safetensors link.'
/** Python raises "No LoRAs resolved…" (:909-914) before any call: the runner's plain words for it. */
export const MULTI_LORA_NEEDS_LORA = 'Flux Dev + LoRAs needs at least one LoRA. Pick one, or paste a HuggingFace, CivitAI or .safetensors link.'
/**
 * LC1 fix round 1: lucataco/flux-dev-multi-lora crashes in its own code after
 * loading the LoRAs ("Cannot copy out of meta tensor", predict.py:311
 * `pipe.to("cuda")`, prediction vy2s2cd219rny0d0zbfbdmp974, 2026-10-02), billed
 * each time. Refused before the hold until a live check shows it working (parked).
 */
export const MULTI_LORA_PROVIDER_DOWN = 'Flux Dev + LoRAs isn’t working at its provider right now. Use Flux Dev + LoRA with one LoRA instead.'
/** Whether Flux Dev + LoRAs is refused (true until a live check shows it working). The request specs turn it off to check its request. */
export const MULTI_LORA_IS_DOWN = { on: true }

/**
 * A LoRA link hosted Sailor lets through (ruling (i)): read as the node
 * reads it (`_normalize_lora_ref`: any scheme stripped, hf.co →
 * huggingface.co), a HuggingFace or CivitAI address, or a link to a
 * .safetensors file (its path, before any query). On Flux Dev + LoRAs a bare
 * `owner/model` is a HuggingFace name too (that model stacks weights and
 * reads it as one; it can't run a private Replicate model).
 */
export function isPublicLoraLink(classType: LoraClass, value: string): boolean {
  const ref = normalizeLoraRef(value)
  const low = ref.toLowerCase()
  if (low.startsWith('huggingface.co/') || low.startsWith('civitai.com/')) return true
  // A .safetensors file only as a real https link with a host (fix round 1): a string with no scheme
  // shaped like `owner/model/x.safetensors` is a Replicate model address to flux-dev-lora.
  if (isHttpsSafetensors(value)) return true
  if (classType === FLUX_MULTI_LORA_CLASS) {
    const parts = ref.split('/')
    return parts.length === 2 && parts.every(p => p && !p.includes('.') && !p.includes(':'))
  }
  return false
}

/** An `https://<host>/…` link whose path ends in `.safetensors` (the host has a dot; no user info). */
export function isHttpsSafetensors(value: string): boolean {
  const s = pyStrip(value ?? '')
  if (!/^https:\/\//i.test(s)) return false
  let u: URL
  try { u = new URL(s) }
  catch { return false }
  return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password && u.pathname.toLowerCase().endsWith('.safetensors')
}

/**
 * Hosted (ruling (i), both paths): LoRAs picked by name and trained-model
 * addresses are refused until LoRAs are stored per user (library/loras/ is
 * one shared folder with no owner; a trained model runs under Sailor's own
 * Replicate account); public links are allowed. A wired picker or link
 * can't be judged before the run: refused too, as a wired voice is.
 */
export function hostedLoraProblem(classType: unknown, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (classType === RESTYLE_LORA_CLASS) return hostedRestyleLoraProblem(inputs)
  if (!isLoraClass(classType)) return null
  const pairs = classType === FLUX_LORA_CLASS ? [{ name: 'lora_name', url: 'lora_url' }] : MULTI_LORA_SLOTS
  for (const s of pairs) {
    const url = inputs[s.url]
    if (isLink(url)) return { input: s.url, message: LORA_WIRED_HOSTED }
    if (isLink(inputs[s.name])) return { input: s.name, message: LORA_WIRED_HOSTED }
    const link = pyStrip(str(url))
    if (link) {
      if (classType === FLUX_LORA_CLASS && isReplicateModelRef(link)) return { input: s.url, message: LORA_TRAINED_MODEL_HOSTED }
      if (!isPublicLoraLink(classType, link)) return { input: s.url, message: LORA_LINK_NOT_PUBLIC }
      continue
    }
    if (namesLora(inputs[s.name])) return { input: s.name, message: LORA_BY_NAME_HOSTED }
  }
  return null
}

/**
 * Restyle an Image · Style LoRA in hosted (ruling (i), R3.14): its link is
 * read as Flux Dev + LoRA's (a trained model's address and a link that isn't
 * public refused); a picked LoRA is refused even beside a link, since the
 * node reads its settings file either way; a wired picker or link too.
 */
function hostedRestyleLoraProblem(inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (isLink(inputs.lora_url)) return { input: 'lora_url', message: LORA_WIRED_HOSTED }
  if (isLink(inputs.lora_name)) return { input: 'lora_name', message: LORA_WIRED_HOSTED }
  const link = pyStrip(str(inputs.lora_url))
  if (link && isReplicateModelRef(link)) return { input: 'lora_url', message: LORA_TRAINED_MODEL_HOSTED }
  if (link && !isPublicLoraLink(FLUX_LORA_CLASS, link)) return { input: 'lora_url', message: LORA_LINK_NOT_PUBLIC }
  return namesLora(inputs.lora_name) ? { input: 'lora_name', message: RESTYLE_LORA_BY_NAME_HOSTED } : null
}

/**
 * What the runner refuses before the hold, from the prompt as sent: Flux Dev
 * + LoRAs with no LoRA in any slot (every link blank and every picker
 * '[None]'), where Python raises before its call. A wired slot is judged at
 * the node's turn.
 */
export function loraRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (classType === FLUX_LORA_CLASS) return fluxDevLoraSure(inputs) ? fluxLoraGuidanceProblem(inputs) : null
  // Restyle's Flux call is Flux Dev + LoRA's plan (R3.14): its `flux_guidance`, when the prompt shows flux-dev-lora.
  if (classType === RESTYLE_LORA_CLASS) return fluxDevLoraSure(inputs) ? fluxLoraGuidanceProblem(inputs, RESTYLE_GUIDANCE) : null
  if (classType !== FLUX_MULTI_LORA_CLASS) return null
  // LC1 fix round 1 (parked): the model fails at its provider whatever is sent.
  if (MULTI_LORA_IS_DOWN.on) return { input: MULTI_LORA_SLOTS[0].name, message: MULTI_LORA_PROVIDER_DOWN }
  for (const s of MULTI_LORA_SLOTS) {
    if (isLink(inputs[s.name]) || isLink(inputs[s.url])) return null
    if (pyStrip(str(inputs[s.url])) || namesLora(inputs[s.name])) return null
  }
  return { input: MULTI_LORA_SLOTS[0].name, message: MULTI_LORA_NEEDS_LORA }
}

/** Restyle's guidance widget and its words (R3.14). */
export const RESTYLE_GUIDANCE = { input: 'flux_guidance', message: RESTYLE_GUIDANCE_TOO_HIGH } as const

/**
 * A guidance flux-dev-lora refuses (over FLUX_DEV_LORA_GUIDANCE_MAX), typed;
 * a wired one is left to the engine. `o`: the widget and the words (Flux Dev
 * + LoRA's `guidance` by default; Restyle's `flux_guidance`, RESTYLE_GUIDANCE).
 */
export function fluxLoraGuidanceProblem(
  inputs: Record<string, unknown>, o: { input: string, message: string } = { input: 'guidance', message: FLUX_LORA_GUIDANCE_TOO_HIGH },
): { input: string, message: string } | null {
  const g = inputs[o.input]
  const n = typeof g === 'number' ? g : typeof g === 'string' ? Number(pyStrip(g)) : Number.NaN
  return Number.isFinite(n) && n > FLUX_DEV_LORA_GUIDANCE_MAX ? { input: o.input, message: o.message } : null
}

/**
 * Whether Flux Dev + LoRA surely runs flux-dev-lora, from the prompt alone:
 * a link that isn't a trained model's address, or neither a link nor a
 * picked LoRA. A picked LoRA's sidecar decides otherwise (the server reads
 * it: server/runner/loraFiles.ts loraStartProblem).
 */
export function fluxDevLoraSure(inputs: Record<string, unknown>): boolean {
  if (isLink(inputs.lora_url) || isLink(inputs.lora_name)) return false
  const link = pyStrip(str(inputs.lora_url))
  if (link) return !isReplicateModelRef(link)
  return !namesLora(inputs.lora_name)
}

/**
 * How many distinct LoRAs Flux Dev + LoRAs may stack, for its price: a slot
 * counts when its link or picker is set (a wired one too); two slots with the
 * same link (as the runner sends it) or the same picker count once. With two
 * or more, the node may call twice (the reload retry, ruling (g)).
 */
export function multiLoraCount(inputs: Record<string, unknown>): number {
  const seen = new Set<string>()
  for (const [i, s] of MULTI_LORA_SLOTS.entries()) {
    const url = inputs[s.url]
    const name = inputs[s.name]
    if (isLink(url) || isLink(name)) seen.add(`wired:${i}`)
    // Keyed by the link as the runner sends it (before the look-up, which is cached per node run):
    // two slots that count once here are always one LoRA at run time.
    else if (pyStrip(str(url))) seen.add(`url:${runnerLoraLink(FLUX_MULTI_LORA_CLASS, str(url))}`)
    else if (namesLora(name)) seen.add(`name:${name}`)
  }
  return seen.size
}
