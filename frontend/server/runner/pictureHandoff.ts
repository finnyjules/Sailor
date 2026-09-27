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
 * Any other picture (made in the run: a provider's answer, an effect, the
 * Frame) is handed off as before; so is everything with `cards` off, and
 * every file Python sends as it is (moodboard pictures, shot references,
 * videos, sounds).
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { PROVIDER_TYPES } from '#shared/runner/eligibility'
import type { RunnerFamily } from '#shared/runner/families'
import { loaderFileBehind } from './cards/bakeReplay'
import { actionPassThrough } from './generators/actions'
import { pixelsInWorker } from './compositor/worker'
import { handoffView, type LoaderKind } from './pictures/handoffView'
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

/**
 * The bytes a loader's file is handed off as: the PNG of its tensor (`made`),
 * or the file's own bytes when they already are that PNG. A CMYK or 16-bit
 * grey file is converted per pixel on the Frame's worker.
 */
export async function loaderHandoffBytes(bytes: Uint8Array, kind: LoaderKind, signal?: AbortSignal): Promise<{ bytes: Uint8Array; made: boolean }> {
  const view = await handoffView(bytes, kind, raw => pixelsInWorker(signal, w => w.rgbOf(raw), HANDOFF_TIMEOUT))
  return view.png ? { bytes: view.png, made: true } : { bytes, made: false }
}

/** The upload name of a made PNG: the loader file's own name, as a .png. */
export function handoffPngName(file: OutputFile): OutputFile {
  const dot = file.filename.lastIndexOf('.')
  return { ...file, filename: `${dot > 0 ? file.filename.slice(0, dot) : file.filename}.png` }
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
    const checked = checkedInputFile(n.class_type, families, inputs.model)
    for (const [input, v] of Object.entries(inputs)) {
      const src = loaderSourceOf(prompt, v, families)
      if (src) out.push({ ...src, at, classType: n.class_type, input, checked: checked === input })
    }
  }
  return out
}
