// The two studio targets for effect takes (stage 5 Task 9): the Shader studio's layer
// and Frame's background. Pure over what the host hands in, so restore and Keep are
// unit-tested here; the host components only wire their state to them.
import { EFFECT_MESSAGES, type EffectTarget } from '~/composables/useEffectTakes'
import { myEffectIdOf } from '~/lib/myEffects/defs'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import { isFill, isGradient, type Paint } from '~/lib/compositor/paint'
import { unprefixedKey } from '~/lib/shaderfill/descriptor'
import { DEFAULT_FILL, DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import type { EffectDef, ParamValue } from '~/lib/shaderfx/types'
import type { StudioEffect } from '~/lib/shaderstudio/types'

/** My-effect values are keyed by uniform (`u_amount`); ShaderSpec.params drops the prefix
 *  (preflight C2). */
export function specParamsFromValues(values: Record<string, ParamValue>): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [unprefixedKey(k), v]))
}

/**
 * Frame's background showing `effectId` with `values` (uniform-keyed):
 * - a shader background keeps everything but its effect and dials (input, anchor, speed, seed);
 * - a plain background (a colour, a gradient, a non-shader fill) becomes the new shader's input,
 *   so the effect runs over what was there;
 * - anything else (none, an image, foil) starts from the default input.
 */
export function backgroundShaderPaint(original: Paint | undefined, effectId: string, values: Record<string, ParamValue>): Paint {
  const params = specParamsFromValues(values)
  if (isFill(original) && original.type === 'shader' && original.shader) {
    return { ...original, shader: { ...original.shader, effectId, params } }
  }
  const plain = typeof original === 'string' ? (original && original !== 'none' ? original : null)
    : isGradient(original) || (isFill(original) && original.type !== 'shader') ? structuredClone(original) : null
  return { ...DEFAULT_FILL, type: 'shader', shader: { ...structuredClone(DEFAULT_SHADER_SPEC), effectId, params, input: plain ?? structuredClone(DEFAULT_SHADER_SPEC.input) } }
}

/** The picture takes are written against, taken once per target: "Three more" reuses the
 *  target after × has restored it, so a later capture could catch a take still on screen. */
function once<T>(f: () => T): () => T {
  let done = false, v: T
  return () => { if (!done) { v = f(); done = true } return v }
}

/**
 * Frame's background. Previews go to `show` only (a local overlay the artboard paints; the
 * saved Frame node is never touched, so no canvas undo step or autosave sees a draft).
 * Keep clears the overlay and `commit`s once (one undo step, holding the old background).
 */
export function makeBackgroundTarget(o: {
  read: () => Paint | undefined
  /** A paint to show instead of the saved background; null shows the saved one again. */
  show: (p: { paint: Paint } | null) => void
  commit: (p: Paint) => void
  snapshot: () => CanvasImageSource | null
  base: EffectDef | null
}): EffectTarget {
  const original = o.read()
  return {
    key: 'frame-background', label: 'Background', base: o.base,
    image: once(o.snapshot),
    preview: id => o.show(id ? { paint: backgroundShaderPaint(original, id, {}) } : null),
    apply: (id, values) => { o.show(null); o.commit(backgroundShaderPaint(original, id, values)) },
  }
}

/**
 * The Shader studio's layer: takes preview on the active layer, or (`add`) on a temporary
 * layer at the END of the stack, so motion tracks (addressed by index) never shift. The
 * caller refuses `add` when the stack is full. Params are uniform-keyed, as StudioEffect's.
 */
export function makeLayerTarget(o: {
  effects: () => StudioEffect[]
  active: () => number
  setActive: (i: number) => void
  add: boolean
  label: string
  base: EffectDef | null
  newLayerId: () => string
  /** A draft is on screen (true) or not (false): the host never saves while it is. */
  previewing: (on: boolean) => void
  redraw: () => void
  snapshot: () => CanvasImageSource | null
}): EffectTarget & { layerId: string } {
  const index = o.active()
  const original = { ...o.effects()[index]! }
  const tempId = o.newLayerId()
  let tempIndex: number | null = null
  const set = (id: string, params: Record<string, ParamValue>) => {
    o.previewing(true)
    const fx = o.effects()
    if (o.add) {
      if (tempIndex == null) { fx.push({ layerId: tempId, id, params, enabled: true, blend: 'normal', opacity: 1 }); tempIndex = fx.length - 1 }
      else fx[tempIndex] = { ...fx[tempIndex]!, id, params }
    } else fx[index] = { ...original, id, params, customChars: '' }
    o.redraw()
  }
  return {
    layerId: o.add ? tempId : original.layerId,
    key: 'shader-studio', label: o.label, base: o.base,
    image: once(o.snapshot),
    preview: (id) => {
      if (id) return set(id, {})
      const fx = o.effects()
      if (o.add) {
        if (tempIndex != null) { fx.splice(tempIndex, 1); tempIndex = null }
        // The temporary layer may have been selected: go back to the layer that was active.
        if (o.active() >= fx.length) o.setActive(Math.min(index, fx.length - 1))
      } else fx[index] = original
      o.previewing(false)
      o.redraw()
    },
    apply: (id, values) => {
      set(id, { ...values })
      if (o.add && tempIndex != null) o.setActive(tempIndex)
      tempIndex = null
      o.previewing(false) // the kept effect is an edit: the host's next save keeps it
    },
  }
}

/**
 * Ruling 8: a kept Tune take on a My effect becomes a dial version, said in a plain sentence
 * either way. `add` gets the target's own effect id (pinned, `…~vN`) and decides: it adds
 * nothing (returns null) unless that is the effect's newest code version in the user's library
 * (an old version's dials would bind to the wrong code, preflight C11; a shared project's copy
 * has no library record to add to), or when the take changes no dial. The caller only asks for
 * Tune (a request with words), not Vary.
 */
export async function recordTuneVersion(o: {
  effectId: string
  params: Record<string, ParamValue>
  request: string
  add: (effectId: string, values: Record<string, ParamValue>, request: string) => Promise<MyEffectRecord | null>
  notify: (kind: 'notice' | 'error', text: string) => void
}): Promise<void> {
  if (!myEffectIdOf(o.effectId)) return
  try {
    const rec = await o.add(o.effectId, { ...o.params }, o.request)
    if (rec) o.notify('notice', EFFECT_MESSAGES.savedVersion(rec.versions.at(-1)!.label, rec.name))
  } catch (e) {
    o.notify('error', EFFECT_MESSAGES.saveFailed(String((e as Error)?.message ?? '')))
  }
}
