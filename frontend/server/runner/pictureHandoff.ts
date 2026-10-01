/**
 * A loader's picture on its way to a provider (step 3, R3.H). With `cards`
 * on, a paid node's IMAGE input fed by a LoadImage or an Image card's own
 * file (through what hands a picture on unchanged: an Image card fed by a
 * wire, a Gate, an action with nothing to do; cards/bakeReplay.ts
 * loaderFileBehind) is handed off as Python sends it: the PNG of the loader's
 * tensor (./pictures/handoffView.ts), made from the loader's own file. The
 * same bytes are measured for a model's file cap (requestRules.ts
 * linkedFileCheck) and fingerprinted (handoff.ts keys a link by the sha256 of
 * the bytes uploaded), so what is checked, charged and sent is one picture.
 *
 * A picture made in the run (R3.H2) is handed off as the tensor the node
 * that made it hands on (madeSourceOf): a provider's answer as PIL's RGBA of
 * the download, a picture the runner wrote of Python's own tensor (an
 * alpha-dropped answer, an effect, a card) as its pixels. The Frame and Blend
 * scene's kept subject (8-bit files truncated from Python's float, where the
 * hand-off rounds it) and anything unlisted are handed off as before; so is
 * everything with `cards` off, and every file Python sends as it is
 * (moodboard pictures, shot references, videos, sounds).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { PROVIDER_TYPES } from '#shared/runner/eligibility'
import { EFFECT_PICTURE_OUTPUTS } from '#shared/runner/effects'
import { FLUX_LORA_CLASS, FLUX_MULTI_LORA_CLASS, RESTYLE_LORA_CLASS } from '#shared/runner/lora'
import type { RunnerFamily } from '#shared/runner/families'
import { loaderFileBehind } from './cards/bakeReplay'
import { actionPassThrough } from './generators/actions'
import { pixelsInWorker } from './compositor/worker'
import { handoffView, madeHandoffView, type LoaderKind, type MadeView } from './pictures/handoffView'
import sharp from 'sharp'
import { checkedInputFile } from './requestRules'
import type { OutputFile } from './types'

/** Converting a CMYK or 16-bit picture took longer than the worker's limit. */
export const HANDOFF_TIMEOUT = 'Getting this picture ready to send took longer than 2 minutes, so it was stopped'

/** The loader whose tensor a picture wire brings: its own file and how it hands it on. */
export interface LoaderSource { nodeId: string; file: OutputFile; kind: LoaderKind }

/**
 * The loader behind a paid node's picture wire, or null (the picture is
 * handed off as it is). Only with `cards` on; only the IMAGE of an Image card
 * (slot 0), as LoadImage's own walk already keeps to its slot 0.
 */
export function loaderSourceOf(prompt: ApiPrompt, link: unknown, families: ReadonlySet<RunnerFamily>): LoaderSource | null {
  if (!families.has('cards') || !isLink(link)) return null
  if (prompt[link[0]]?.class_type === 'Image' && link[1] !== 0) return null
  const behind = loaderFileBehind(prompt, link as ApiLink)
  return behind ? { nodeId: behind.nodeId, file: behind.file, kind: { keepsAlpha: behind.classType === 'Image' } } : null
}

/** A model's upload caps for the picture (requestRules.ts inputFileCaps); `backupCap` only while backups can run. */
export interface HandoffCaps { cap: number; backupCap?: number }

/** What is handed off: the bytes, whether they were made here, their kind, and whether they keep see-through parts. */
export interface LoaderHandoff { bytes: Uint8Array; made: boolean; format: 'png' | 'jpeg'; alpha: boolean }

/** The quality of the JPEG handed off in place of a PNG over a cap (the controller's ruling). */
export const OVER_CAP_JPEG_QUALITY = 95

/**
 * The bytes a loader's file is handed off as: the PNG of its tensor (`made`),
 * or the file's own bytes when they already are that PNG. A CMYK or 16-bit
 * grey file is converted per pixel on the Frame's worker.
 *
 * Over a cap (R3.H fix, "JPEG over caps", a ruled departure from Python,
 * which sends the PNG and fails at the provider): an RGB picture whose PNG is
 * over the tightest cap is handed off as a quality-95 JPEG of the SAME
 * picture (upright, RGB, sRGB, no EXIF), when that fits the backup's cap too
 * (the backup stays available); else the PNG if it fits the model's own cap
 * (the backup is dropped, as before); else the JPEG (under the model's cap,
 * the backup dropped; over it, refused by the caller's check). An RGBA
 * picture keeps its PNG (a JPEG has no alpha): over the cap it is refused.
 */
export async function loaderHandoffBytes(bytes: Uint8Array, kind: LoaderKind, signal?: AbortSignal, caps?: HandoffCaps | null): Promise<LoaderHandoff> {
  const view = await handoffView(bytes, kind, raw => pixelsInWorker(signal, w => w.rgbOf(raw), HANDOFF_TIMEOUT))
  // The Image card hands on RGBA only when a pixel is see-through (./pictures/handoffView.ts).
  return chosenHandoff(bytes, view.png, view.channels === 4, caps)
}

/**
 * What is sent of a picture's PNG (`png`; null: `bytes` already is it), by
 * the caps (loaderHandoffBytes): a picture with see-through pixels always as
 * its PNG; otherwise the PNG, or over a cap the quality-95 JPEG of the same
 * picture. A 4-channel picture with no see-through pixel (R3.H2: a
 * provider's opaque answer, which Python holds as RGBA) may go as that JPEG
 * too: it has no alpha a JPEG would lose.
 */
async function chosenHandoff(bytes: Uint8Array, made: Uint8Array | null, seeThrough: boolean, caps?: HandoffCaps | null): Promise<LoaderHandoff> {
  const png: LoaderHandoff = made ? { bytes: made, made: true, format: 'png', alpha: seeThrough } : { bytes, made: false, format: 'png', alpha: seeThrough }
  if (!caps || seeThrough) return png
  const tightest = Math.min(caps.cap, caps.backupCap ?? Number.POSITIVE_INFINITY)
  if (png.bytes.byteLength <= tightest) return png
  const jpg = await sharp(png.bytes).removeAlpha().jpeg({ quality: OVER_CAP_JPEG_QUALITY }).toBuffer()
  const jpeg: LoaderHandoff = { bytes: new Uint8Array(jpg.buffer, jpg.byteOffset, jpg.byteLength), made: true, format: 'jpeg', alpha: false }
  if (jpeg.bytes.byteLength <= tightest) return jpeg
  return png.bytes.byteLength <= caps.cap ? png : jpeg
}

/**
 * The key a capped picture chosen at the start of a run is kept under
 * (R3.H fix round 2, TakeRecord.handoffs): the loader file's sha256, how
 * the loader hands it on, and the caps it was chosen against, which decide
 * its format (so the node's turn finds it only when it would choose the same).
 */
export function handoffKey(sourceSha: string, kind: LoaderKind, caps: HandoffCaps): string {
  return `${sourceSha}:${kind.keepsAlpha ? 'rgba' : 'rgb'}:${caps.cap}:${caps.backupCap ?? ''}`
}

/** The upload name of made bytes: the loader file's own name, as a .png (or a .jpg, over a cap). */
export function handoffPngName(file: OutputFile, format: 'png' | 'jpeg' = 'png'): OutputFile {
  const dot = file.filename.lastIndexOf('.')
  return { ...file, filename: `${dot > 0 ? file.filename.slice(0, dot) : file.filename}.${format === 'jpeg' ? 'jpg' : 'png'}` }
}

/**
 * Every loader picture a paid node of this prompt will hand off (the start
 * of a run checks each before anything is held): each linked input of a
 * provider node with a loader behind it, unless the node passes its picture
 * on without a call (an action with nothing to do). `checked`: the input
 * whose file a model caps (requestRules.ts checkedInputFile).
 */
export function loaderHandoffs(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): Array<LoaderSource & { at: string; classType: string; input: string; checked: boolean }> {
  if (!families.has('cards')) return []
  const out: Array<LoaderSource & { at: string; classType: string; input: string; checked: boolean }> = []
  for (const [at, n] of Object.entries(prompt)) {
    if (!PROVIDER_TYPES.has(n.class_type)) continue
    const inputs = n.inputs ?? {}
    if (actionPassThrough(n.class_type, inputs)) continue
    const checked = checkedInputFile(n.class_type, families, inputs.model, inputs)
    for (const [input, v] of Object.entries(inputs)) {
      const src = loaderSourceOf(prompt, v, families)
      if (src) out.push({ ...src, at, classType: n.class_type, input, checked: checked === input })
    }
  }
  return out
}

// ── Pictures made in the run (R3.H2) ─────────────────────────────────────────

/** The node that made a picture a wire brings, which slot, and how Python holds it (./pictures/handoffView.ts MadeView). */
export interface MadeSource { nodeId: string; slot: number; classType: string; view: MadeView }

/** Provider classes whose picture is a PNG the runner wrote of Python's RGB tensor (`tensor[..., :3]`, R3 rule 3), by slot. */
const PROVIDER_KEPT_SLOTS: Readonly<Record<string, readonly number[]>> = {
  [FLUX_LORA_CLASS]: [0],
  [FLUX_MULTI_LORA_CLASS]: [0],
  [RESTYLE_LORA_CLASS]: [0],
  OutpaintImageNode: [0],
  // The background (its fill, alpha dropped); the subject (slot 0) is the remover's file.
  SplitPhotoLayersNode: [1],
  // R7.2: Upscale (2×)'s picture is an 8-bit RGB PNG of Python's tensor (generators/localModels.ts).
  UpscaleImage: [0],
  // R7.3's fix to R7.1: Background remove's picture is the PNG of Python's tensor (RGBA for
  // `transparent`, RGB for `premultiplied` and `matte_only`), not the provider's RGBA view.
  BackgroundRemove: [0],
  // R7.3: Object removal's picture is an 8-bit RGB PNG of Python's tensor (generators/localModels.ts).
  ObjectRemove: [0],
}

/** Provider classes whose later slot is a provider's file too (Separate background and foreground's subject is slot 0). */
const PROVIDER_ANSWER_SLOTS: Readonly<Record<string, readonly number[]>> = {
  SplitPhotoLayersNode: [0],
}

/**
 * Cards whose picture is a PNG the runner wrote of Python's own tensor, by
 * slot (compositor/plan.ts pictureSourceOf): Empty image, Smart Layout and
 * the Shader effect (RGB, exact); Text mask's image (round(255·x) whenever a
 * provider reads it, cards/utilities.ts onlySavesRead); the bake-replay
 * cards (the loader's PNG, cards/bakeReplay.ts). Every effect's picture
 * (effects/plan.ts, rounded whenever a provider reads it) is kept too.
 */
const CARD_KEPT_SLOTS: Readonly<Record<string, readonly number[] | 'all'>> = {
  EmptyImage: [0],
  SmartLayout: [0],
  ShaderEffect: [0],
  TextMask: [0],
  TextOnPath: [0],
  Scene3DStudio: 'all',
}

/**
 * The node that made the picture a paid node's wire brings, followed back
 * through what hands a picture on unchanged (an Image card fed by a wire, a
 * Gate, an action with nothing to do: cards/bakeReplay.ts loaderFileBehind's
 * walk), and how Python holds it; null when the picture comes from a loader
 * (loaderSourceOf), or from a node whose tensor isn't the file the runner kept
 * (the Frame, Blend scene's kept subject: Python rounds a float the runner
 * kept truncated; a Pose Mannequin or Lens that made no call; Seedream's
 * preview, which may be its input): those are handed off as before. Only
 * with `cards` on. `called`: whether a node made a provider call (its record),
 * where that decides what it handed on.
 */
export function madeSourceOf(prompt: ApiPrompt, link: unknown, families: ReadonlySet<RunnerFamily>, called?: (nodeId: string) => boolean, depth = 0): MadeSource | null {
  if (!families.has('cards') || !isLink(link) || depth > 64) return null
  const [nodeId, slot] = link as ApiLink
  const node = prompt[nodeId]
  if (!node) return null
  const inputs = node.inputs ?? {}
  const made = (view: MadeView): MadeSource => ({ nodeId, slot, classType: node.class_type, view })
  if (node.class_type === 'Image') return isLink(inputs.images) && slot === 0 ? madeSourceOf(prompt, inputs.images, families, called, depth + 1) : null
  if (node.class_type === GATE_CLASS) return madeSourceOf(prompt, inputs.data_in, families, called, depth + 1)
  if (Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, node.class_type)) return EFFECT_PICTURE_OUTPUTS[node.class_type]!.includes(slot) ? made('kept') : null
  const card = Object.prototype.hasOwnProperty.call(CARD_KEPT_SLOTS, node.class_type) ? CARD_KEPT_SLOTS[node.class_type]! : null
  if (card) return card === 'all' || card.includes(slot) ? made('kept') : null
  if (!PROVIDER_TYPES.has(node.class_type)) return null
  const pass = actionPassThrough(node.class_type, inputs)
  if (pass) return madeSourceOf(prompt, inputs[pass], families, called, depth + 1)
  if (PROVIDER_KEPT_SLOTS[node.class_type]?.includes(slot)) return made('kept')
  if (PROVIDER_ANSWER_SLOTS[node.class_type]?.includes(slot)) return made('answer')
  if (slot !== 0) return null
  switch (node.class_type) {
    case 'BlendSceneNode': return isLink(inputs.keep_subject) ? null : made('answer')
    case 'PoseMannequin':
    case 'LensReframe': return called?.(nodeId) ? made('answer') : null
    case 'SeedreamLayerizeNode': return null
    default: return made('answer')
  }
}

/**
 * The bytes a picture made in the run is handed off as: the PNG of the
 * tensor its node hands on (./pictures/handoffView.ts madeHandoffView), or
 * the file itself when it already is that PNG; over a cap, the JPEG of the
 * same picture as loaderHandoffBytes chooses it.
 */
export async function madeHandoffBytes(bytes: Uint8Array, view: MadeView, caps?: HandoffCaps | null): Promise<LoaderHandoff> {
  const v = await madeHandoffView(bytes, view)
  return chosenHandoff(bytes, v.png, v.seeThrough, caps)
}
