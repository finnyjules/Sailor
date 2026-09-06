/**
 * Motion targets for Scene3D's path-based tracks (`SceneMotionTrack`, ./types.ts) —
 * mirrors `~/lib/gradientfx/motion.ts`'s and `~/lib/vectortype/motion.ts`'s own
 * `animatableTargets`: derived from the ONE control declaration (`SCENE_CONTROLS`)
 * rather than hand-listed, so a new slider is motion-animatable by default and an
 * `animatable: false` opt-out actually opts out.
 *
 * Split from `SCENE_CONTROLS` into two halves:
 *   - doc-level groups (Lighting/Camera/Post) pass straight through as absolute paths;
 *   - `object.`-prefixed controls do NOT come from `visibleSceneControls(doc)` (which
 *     gates on a single active/undefined object — right for a panel, wrong here: a
 *     track must be able to reach ANY object, not just whichever one is selected).
 *     They are expanded instead through `iterateObjectControls`
 *     (`~/lib/scene3d/agentControls.ts`) — the SAME id-addressed expansion
 *     `sceneStackControls` uses for the agent/Collection vocabulary — so the id-safety
 *     refusal (missing/empty/dotted/all-digit ids) and the `<object name> · <label>`
 *     labelling exist in exactly one place, not two that can drift.
 *
 * Transform controls (`object.position/rotation/scale`) never appear here: SCENE_CONTROLS
 * declares them `animatable: false` because Scene3D's OWN preset system (`ObjectMotion`,
 * ./types.ts) already owns position/rotation/scale, composing per-frame deltas onto the
 * home transform — a second system writing the same fields would fight it. See
 * controls.ts's Transform section doc for the full reasoning.
 */
import type { SceneDoc } from '~/lib/scene3d/config'
import { visibleSceneControls, type SceneControl } from '~/lib/scene3d/controls'
import { OBJECT_PREFIX, iterateObjectControls, iterateTreatmentControls } from '~/lib/scene3d/agentControls'

export interface SceneAnimatableTarget { path: string; label: string; min: number; max: number }

/** A slider's declared range, or its `animatable` override when present. Exported and
 *  pure (no SCENE_CONTROLS dependency) so the widening mechanism is testable on a
 *  synthetic control without needing a real widened member of SCENE_CONTROLS to exist. */
export function animatableRange(c: { min: number; max: number; animatable?: boolean | { min: number; max: number } }): { min: number; max: number } {
  const flag = c.animatable
  return flag && typeof flag === 'object' ? flag : { min: c.min, max: c.max }
}

const usable = (c: SceneControl): boolean => c.kind === 'slider' && (c as { animatable?: unknown }).animatable !== false

/**
 * Every path a motion track may point at. `doc` is used only to know which objects
 * exist and which `when`-gated controls apply to each — the returned paths are stable
 * strings, not live bindings.
 */
export function animatableTargets(doc: SceneDoc): SceneAnimatableTarget[] {
  const out: SceneAnimatableTarget[] = []

  // Doc-level groups: visibleSceneControls(doc) with no active object still describes
  // what a control WOULD do (controls.ts's own `isEditableMaterial` doc), but here we
  // only want the non-object-prefixed half — the object half is expanded separately
  // below, against every real object rather than a single (or absent) selection.
  for (const c of visibleSceneControls(doc)) {
    if (c.key.startsWith(OBJECT_PREFIX) || !usable(c)) continue
    out.push({ path: c.key, label: c.label, ...animatableRange(c as any) })
  }

  iterateObjectControls(doc, (c, obj, id) => {
    if (!usable(c)) return
    const rest = c.key.slice(OBJECT_PREFIX.length)
    out.push({
      path: `objects.${id}.${rest}`,
      label: `${obj.name || 'Object'} · ${c.label}`,
      ...animatableRange(c as any),
    })
  })

  // Treatment dials — slider rows only: a track is numeric, so the on/off flag and colour
  // rows are not targets (key a fade to 0 to switch an effect off over time).
  iterateTreatmentControls(doc, (c, obj, id) => {
    if (c.kind !== 'slider') return
    out.push({
      path: `objects.${id}.${c.key.slice(OBJECT_PREFIX.length)}`,
      label: `${obj.name || 'Object'} · ${c.label}`,
      ...animatableRange(c as any),
    })
  })

  return out
}
