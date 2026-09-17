// What Cinematic (path-traced) render can and cannot faithfully show — pure, so the
// warn-then-render toast, the capability gate and tests all read one description. No three here.
import type { MaterialType, SceneDoc, SceneObject } from '~/lib/scene3d/config'

/** Materials the path-tracer renders TRUE (it reads their PBR params directly). Everything else
 *  is approximated by its base colour/roughness/metalness — the custom `onBeforeCompile` shader
 *  (gradient/opalescent/holographic ramp, shader-fill field) and the image map do not run. */
export const PATH_TRACEABLE_MATERIALS: readonly MaterialType[] = ['standard', 'glass', 'gemstone']

export function isPathTraceableMaterial(type: MaterialType): boolean {
  return (PATH_TRACEABLE_MATERIALS as readonly string[]).includes(type)
}

/** Does this object carry at least one enabled treatment (blur/glow/outline/AI-restyle …)?
 *  The treatment stack is a raster compositor pass Cinematic bypasses entirely. */
function hasActiveTreatment(obj: SceneObject): boolean {
  const t = (obj as { treatments?: Array<{ enabled?: boolean }> }).treatments
  return Array.isArray(t) && t.some((x) => x?.enabled !== false)
}

export interface CinematicScope {
  /** Total objects in the scene (primitives, glb, text, …; lights/decals excluded). */
  total: number
  /** Objects that will render SIMPLIFIED — a non-path-traceable material and/or a treatment. */
  simplified: SceneObject[]
  /** Whether any object uses a custom-shader material Cinematic can't run. */
  hasCustomMaterial: boolean
  /** Whether any object has a treatment the trace ignores. */
  hasTreatment: boolean
}

/** The renderable objects a scene contains and which of them Cinematic must simplify. Lights and
 *  decals are not scene bodies, so they don't count toward the object total. */
export function cinematicScope(doc: SceneDoc): CinematicScope {
  const bodies = doc.objects.filter((o) => o.kind !== 'light' && o.kind !== 'decal')
  const simplified: SceneObject[] = []
  let hasCustomMaterial = false
  let hasTreatment = false
  for (const o of bodies) {
    const custom = o.material ? !isPathTraceableMaterial(o.material.type) : false
    const treat = hasActiveTreatment(o)
    if (custom) hasCustomMaterial = true
    if (treat) hasTreatment = true
    if (custom || treat) simplified.push(o)
  }
  return { total: bodies.length, simplified, hasCustomMaterial, hasTreatment }
}

/** The one-line heads-up shown the first time Cinematic is enabled on a scene it can't fully
 *  render — or null when everything path-traces faithfully (no warning needed). */
export function cinematicScopeWarning(doc: SceneDoc): string | null {
  const s = cinematicScope(doc)
  if (s.simplified.length === 0) return null
  const parts: string[] = []
  if (s.hasCustomMaterial) parts.push('shader materials')
  if (s.hasTreatment) parts.push('object effects')
  const what = parts.join(' and ')
  const n = s.simplified.length
  return `Cinematic can't ray-trace ${what} — ${n} object${n === 1 ? '' : 's'} will render simplified.`
}
