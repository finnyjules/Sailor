/**
 * The LoRA files Flux Dev + LoRA and Flux Dev + LoRAs read by name (step 3,
 * R3.13): each LoRA in models/loras/ (the folders folder_paths lists for
 * "loras", extra_model_paths.yaml included) may have a sidecar JSON beside it,
 * written by the cloud trainer (server/api/cloud-train/status.get.ts), naming
 * its Replicate model and its weights file. The node reads only the sidecar;
 * the LoRA's weights file itself is never read or uploaded (Python's
 * `_read_lora_sidecar`, replicate_refs.py:95-111, does the same: the provider
 * fetches the weights from the address in the sidecar).
 *
 *  - The name must be one ComfyUI lists for the picker (`get_filename_list
 *    ("loras")` + "[None]"): any other fails ComfyUI's validation, and a
 *    name that would reach outside the folder is refused.
 *  - The sidecar is read with a cap (LORA_SIDECAR_MAX_BYTES), checked before
 *    the hold (`loraStartProblem`) and again when read. Flux Dev + LoRA's
 *    guidance over flux-dev-lora's maximum is refused there too when the
 *    sidecar shows it runs flux-dev-lora.
 *  - Hosted: never read. A LoRA picked by name is refused there (ruling (i),
 *    #shared/runner/lora hostedLoraProblem) until LoRAs are stored per user.
 *
 * `_read_lora_sidecar` as Python reads it: the first folder with the file
 * wins; a file that can't be opened or isn't JSON is no sidecar (None);
 * `json.load(f) or {}`, so null, false, 0, "", [] and {} are an empty one; any
 * other kind of JSON (a list with items, a string, a number) makes Python fail
 * on it (`meta.get`): the node fails plainly.
 */
import fs from 'node:fs/promises'
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { FLUX_LORA_CLASS, LORA_BY_NAME_HOSTED, LORA_NAME_INPUTS, LORA_NONE, fluxLoraGuidanceProblem, isLoraClass, loraNamesUsed } from '#shared/runner/lora'
import { pyStrip } from '#shared/runner/pyText'
import { parsePyJson, type PyJson } from '#shared/runner/pyJson'
import { resolveEngineRoot } from '../utils/inputUploads'
import { getFilenameList, modelFolderTable, pySplitext } from '../native/objectInfo'
import { resolveInside } from '../native/paths'

/** The most bytes one LoRA sidecar may be (the trainer writes a few hundred). */
export const LORA_SIDECAR_MAX_BYTES = 1024 * 1024

export const LORA_NOT_LISTED = 'This LoRA isn’t in the LoRA folder. Pick another one.'
export const LORA_SIDECAR_TOO_LARGE = 'This LoRA’s settings file is too large to read (over 1 MB).'
export const LORA_SIDECAR_UNREADABLE = 'This LoRA’s settings file can’t be read. Pick another LoRA.'

/** A sidecar as Python's dict: each key's last value. */
export type LoraSidecar = ReadonlyMap<string, PyJson>

/** The folders folder_paths lists for "loras", or none when the engine root can't be found. */
export function loraFolders(): string[] {
  const root = resolveEngineRoot()
  return root ? [...(modelFolderTable(root).get('loras')?.paths ?? [])] : []
}

/** The LoRA picker's options: `get_filename_list("loras") + ["[None]"]`. */
export function loraOptions(): string[] {
  const root = resolveEngineRoot()
  return [...(root ? getFilenameList(modelFolderTable(root), 'loras') : []), LORA_NONE]
}

/** Python's bool() of a JSON value as json.loads reads it. */
export function pyJsonTruthy(v: PyJson | undefined): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if ('int' in v) return !/^-?0+$/.test(v.int)
  if ('float' in v) return v.float !== 0
  return v.obj.length > 0
}

/** Where a LoRA's sidecar would be in a folder (`splitext(name)[0] + ".json"`), or null when that is outside it. */
function sidecarPath(dir: string, name: string): string | null {
  return resolveInside(dir, `${pySplitext(name)[0]}.json`)
}

/** The first folder's sidecar file for this LoRA, with its size, or null (no sidecar). */
async function findSidecar(name: string): Promise<{ file: string, size: number } | null> {
  for (const dir of loraFolders()) {
    const file = sidecarPath(dir, name)
    if (!file) throw new Error(LORA_NOT_LISTED)
    try {
      const st = await fs.stat(file)
      if (st.isFile()) return { file, size: st.size }
    }
    catch { /* not in this folder */ }
  }
  return null
}

/** At most `max + 1` bytes of a file (a file that grew past its size check can't be read whole). */
async function readBounded(file: string, max: number): Promise<Uint8Array> {
  const fh = await fs.open(file, 'r')
  try {
    const buf = new Uint8Array(max + 1)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
      if (!bytesRead) break
      got += bytesRead
    }
    return buf.subarray(0, got)
  }
  finally { await fh.close() }
}

/**
 * `_read_lora_sidecar(name)`: the sidecar as a dict, null when there is none
 * (or it isn't JSON). Hosted (fix round 1): a LoRA named by name is refused
 * here too, whatever the caller checked (ruling (i)); `[None]` and a blank
 * name read nothing either way. The read is bounded by the cap.
 */
export async function readLoraSidecar(name: string, o: { hosted?: boolean } = {}): Promise<LoraSidecar | null> {
  if (!name || name === LORA_NONE) return null
  if (o.hosted) throw new Error(LORA_BY_NAME_HOSTED)
  const found = await findSidecar(name)
  if (!found) return null
  if (found.size > LORA_SIDECAR_MAX_BYTES) throw new Error(LORA_SIDECAR_TOO_LARGE)
  let bytes: Uint8Array
  try { bytes = await readBounded(found.file, LORA_SIDECAR_MAX_BYTES) }
  catch { return null } // OSError
  if (bytes.byteLength > LORA_SIDECAR_MAX_BYTES) throw new Error(LORA_SIDECAR_TOO_LARGE)
  let text: string
  // Not UTF-8: Python's read raises (a UnicodeDecodeError json.load doesn't catch).
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error(LORA_SIDECAR_UNREADABLE) }
  let v: PyJson
  try { v = parsePyJson(text) }
  catch { return null } // JSONDecodeError
  if (!pyJsonTruthy(v)) return new Map()
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !('obj' in v)) throw new Error(LORA_SIDECAR_UNREADABLE)
  return new Map(v.obj)
}

/** `_resolve_trained_model` (replicate_refs.py:114-132): the sidecar's `replicate_model` as `<owner>/<model>`, or null. */
export function resolveTrainedModel(meta: LoraSidecar | null): string | null {
  const ref = meta?.get('replicate_model')
  if (!pyJsonTruthy(ref) || typeof ref !== 'string') return null
  const s = pyStrip(ref)
  if (s.includes('://')) return null
  return pyStrip(s.split(':')[0]!) || null
}

/**
 * What the start of a run refuses about the LoRAs its nodes name, before the
 * hold: a picker whose name ComfyUI doesn't list (its validation would refuse
 * the node), and a sidecar the node would read that is over its cap. A
 * wired picker is left to the engine.
 */
export async function loraStartProblem(prompt: ApiPrompt, o: { hosted?: boolean } = {}): Promise<{ nodeId: string, classType: string, message: string } | null> {
  let options: Set<string> | null = null
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const ct = node?.class_type
    if (!isLoraClass(ct)) continue
    const inputs = node.inputs ?? {}
    for (const input of LORA_NAME_INPUTS[ct]) {
      const v = inputs[input]
      if (v === undefined || isLink(v)) continue
      options ??= new Set(loraOptions())
      if (typeof v !== 'string' || !options.has(v)) return { nodeId, classType: ct, message: LORA_NOT_LISTED }
    }
    for (const { name } of loraNamesUsed(ct, inputs)) {
      // Hosted never reads (or even looks for) a LoRA's files (ruling (i)).
      if (o.hosted) return { nodeId, classType: ct, message: LORA_BY_NAME_HOSTED }
      let found: { size: number } | null
      try { found = await findSidecar(name) }
      catch (e) { return { nodeId, classType: ct, message: e instanceof Error ? e.message : LORA_NOT_LISTED } }
      if (found && found.size > LORA_SIDECAR_MAX_BYTES) return { nodeId, classType: ct, message: LORA_SIDECAR_TOO_LARGE }
      // Flux Dev + LoRA picked by name runs flux-dev-lora unless the sidecar names a trained model:
      // then a guidance flux-dev-lora refuses is refused now (a sidecar that can't be read fails at the node's turn).
      if (ct === FLUX_LORA_CLASS) {
        const tooHigh = fluxLoraGuidanceProblem(inputs)
        let trained: string | null = null
        try { trained = resolveTrainedModel(await readLoraSidecar(name, o)) }
        catch { continue }
        if (tooHigh && !trained) return { nodeId, classType: ct, message: tooHigh.message }
      }
    }
  }
  return null
}
