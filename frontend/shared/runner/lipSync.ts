/**
 * How "Lip-sync a character" (LipSyncNode, comfy_api_nodes/nodes_replicate.py)
 * reads its engine and sync mode, for the one engine only Sailor's runner
 * runs: sync-3 (sync.so) on fal, family `sync-3` (model line-up F22).
 *
 * LipSyncNode.execute reads `opts = json.loads(model_options or "{}")` (not a
 * dict → {}), then `engine = opts.get("engine", engine)` and
 * `sync_mode = opts.get("sync_mode", sync_mode)`: a key in the options wins
 * over the widget. Python knows only "auto", "fabric" and "sync"; given
 * "sync-3" it would quietly pick Fabric or Kling instead
 * (`_lipsync_resolve_engine`), so the ComfyUI path refuses sync-3 wherever it
 * is set (./blockedModels.ts through the "LipSyncNode.engine" menu).
 *
 * Pure; relative imports only (the browser, the server and vitest load it).
 */
import { isLink } from './graph'

/** The engine value for sync-3 (the studio's option, the widget and `model_options.engine`). */
export const SYNC_3_ENGINE = 'sync-3'

/** The widget's default sync mode (LipSyncNode `sync_mode`, default "cut_off"). */
export const LIPSYNC_DEFAULT_SYNC_MODE = 'cut_off'

/**
 * The sync modes sync-3 is run with: each makes a clip no longer than the
 * sound, so the price can be read from the files (sync.so's sync mode guide:
 * loop, bounce and remap give the sound's length, cut_off the shorter of the
 * two). "silence" pads the sound to the video's full length and is refused.
 */
export const SYNC_3_SYNC_MODES: readonly string[] = ['cut_off', 'loop', 'bounce', 'remap']

/** The plain refusals for a sync mode sync-3 isn't run with (the price, the runner and the studio say the same). */
export const SYNC_3_SILENCE_REFUSED = 'sync-3 can’t use the silence sync mode: it makes the whole video, however short the sound. Choose cut off, loop, bounce or remap.'
export const SYNC_3_MODE_REFUSED = 'sync-3 can’t use this sync mode. Choose cut off, loop, bounce or remap.'
export const SYNC_3_MODE_LINKED = 'Set the sync mode on the node, not through a link: the price depends on it.'

type Inputs = Record<string, unknown>

/**
 * `model_options` as LipSyncNode reads it: an object, `{}` for blank text or
 * anything that isn't an object, and null for text JSON.parse refuses (Python's
 * json.loads also reads NaN and Infinity, so what it would find there is unknown).
 * A wired `model_options` is null too: known only at run time.
 */
export function lipSyncOptions(raw: unknown): Record<string, unknown> | null {
  if (isLink(raw)) return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try { v = JSON.parse(raw) }
    catch { return null }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** The engine the node runs: `model_options.engine` when set, else the widget. Unreadable options: the widget. */
export function lipSyncEngine(inputs: Inputs): unknown {
  const opts = lipSyncOptions(inputs.model_options)
  return opts && own(opts, 'engine') ? opts.engine : inputs.engine
}

/**
 * The sync mode the node sends: `model_options.sync_mode` when set, else the
 * widget, else the widget's default. Unreadable options: the widget.
 */
export function lipSyncSyncMode(inputs: Inputs): unknown {
  const opts = lipSyncOptions(inputs.model_options)
  if (opts && own(opts, 'sync_mode')) return opts.sync_mode
  return inputs.sync_mode === undefined ? LIPSYNC_DEFAULT_SYNC_MODE : inputs.sync_mode
}

/**
 * The node runs on sync-3, as the runner reads it: its options readable (not
 * wired, text JSON.parse accepts) and the engine they give is sync-3.
 */
export function isSync3LipSync(inputs: Inputs): boolean {
  return lipSyncOptions(inputs.model_options) !== null && lipSyncEngine(inputs) === SYNC_3_ENGINE
}

/**
 * The node MAY ask for sync-3, read the fail-safe way for the ComfyUI path's
 * refusal: the widget says sync-3, or the options do, or options text
 * JSON.parse can't read mentions it.
 */
export function mentionsSync3(inputs: Inputs): boolean {
  if (inputs.engine === SYNC_3_ENGINE || isSync3LipSync(inputs)) return true
  const raw = inputs.model_options
  return typeof raw === 'string' && lipSyncOptions(raw) === null && raw.includes(SYNC_3_ENGINE)
}

/**
 * Seconds of video sync-3 makes (sync.so's sync mode guide): the sound's
 * length for loop, bounce and remap; the shorter of the two for cut_off.
 * Null for a mode it isn't run with ("silence", anything else).
 */
export function sync3OutputSeconds(mode: unknown, audioSeconds: number, videoSeconds: number): number | null {
  if (mode === 'cut_off') return Math.min(audioSeconds, videoSeconds)
  if (mode === 'loop' || mode === 'bounce' || mode === 'remap') return audioSeconds
  return null
}

/** Why sync-3 can't run with this sync mode, or null when it can. */
export function sync3ModeRefusal(mode: unknown): string | null {
  if (Array.isArray(mode)) return SYNC_3_MODE_LINKED
  if (typeof mode === 'string' && SYNC_3_SYNC_MODES.includes(mode)) return null
  return mode === 'silence' ? SYNC_3_SILENCE_REFUSED : SYNC_3_MODE_REFUSED
}
