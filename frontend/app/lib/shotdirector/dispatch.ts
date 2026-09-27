/**
 * Pure mapping from a compiled ShotSheet to the FilmShotNode widget patch that
 * dispatches it, plus target-node discovery. The FilmShotNode's own widgets
 * carry prompt/model/aspect_ratio/duration/seed; everything else the Seedance
 * builder needs (resolution, references, first/last frame, generate_audio)
 * rides in the model_options JSON, which reaches the Python builder as `adv`.
 */
import type { CompileResult } from '~/lib/shotdirector/compile'
import { clampDuration, SEEDANCE_PROFILE, type ModelProfile } from '~/lib/shotdirector/profiles'
import type { ShotSheet } from '~/lib/shotdirector/types'

export interface FilmShotWidgetPatch {
  prompt: string
  model: string
  aspect_ratio: string
  duration: string
  seed: number
  model_options: string
}

/** Keys of the compiled Replicate input that map to FilmShotNode widgets —
 *  everything else goes into model_options. */
const WIDGET_NATIVE = new Set(['prompt', 'duration', 'aspect_ratio', 'seed'])

export function buildFilmShotPatch(sheet: ShotSheet, result: CompileResult, profile: ModelProfile = SEEDANCE_PROFILE): FilmShotWidgetPatch {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result.input)) {
    if (!WIDGET_NATIVE.has(key)) extras[key] = value
  }
  // FilmShotNode.execute always prepends a shot-preset camera phrase (e.g.
  // "push-in") to the prompt — appropriate for its own gallery UI, but Shot
  // Director already compiles a complete, deliberate prompt of its own.
  // This marker tells FilmShotNode to skip the preset phrase and use the
  // prompt verbatim; the node pops it out of `adv` before it ever reaches
  // the Seedance builder, so it never leaks into the Replicate payload.
  extras.__shot_directed = true
  // FilmShotNode's duration widget is a Combo with STRING options
  // ["3","5","6","8","9","10","15","60"] — the pre-run combo sweep
  // (realignWidgetValues in useFilteredPrompt.ts) silently coerces any
  // non-member value to the default "5", so a raw number here (e.g. 10)
  // never matches and always regresses to 5s clips. durationS === -1 also
  // means "Auto" in the surface, a legal sheet state with no numeric
  // meaning. clampDuration maps it (and any length the model doesn't accept)
  // to the profile's nearest allowed length — Seedance's is unclamped and
  // still falls back to 5, same as before. Same String()-of-combo-value
  // pattern as snapWidgetsToModel in lib/videoModelAdapt.ts.
  const durationS = clampDuration(profile, sheet.format.durationS)
  return {
    prompt: result.prompt,
    model: profile.id,
    // In firstLastFrame mode the compiled input has no aspect_ratio (image
    // dims win); send the sheet's anyway — the builder ignores it then.
    aspect_ratio: sheet.format.aspectRatio,
    duration: String(durationS),
    seed: sheet.format.seed && sheet.format.seed > 0 ? sheet.format.seed : 0,
    model_options: JSON.stringify(extras),
  }
}

export interface TargetNode { id: string, nodeType?: string }
export interface TargetEdge { source: string, target: string }

/** The FilmShotNode a Shot Director drives: the remembered target if it still
 *  exists, else the first FilmShotNode reachable downstream, else null. */
export function findShotTarget(
  nodes: TargetNode[],
  edges: TargetEdge[],
  studioId: string,
  storedTargetId?: string | null,
): string | null {
  if (storedTargetId && nodes.some(n => n.id === storedTargetId && n.nodeType === 'FilmShotNode')) {
    return storedTargetId
  }
  const byId = new Map(nodes.map(n => [n.id, n]))
  const queue = [studioId]
  const seen = new Set<string>(queue)
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of edges) {
      if (e.source !== cur || seen.has(e.target)) continue
      seen.add(e.target)
      if (byId.get(e.target)?.nodeType === 'FilmShotNode') return e.target
      queue.push(e.target)
    }
  }
  return null
}
