/**
 * Per-model input adaptation for the video nodes (FilmShotNode +
 * GenerateVideoNode). Pure functions over the video-model registry: which
 * widgets make sense for the selected model, and what their option lists are.
 *
 * Unknown/empty model ids are PERMISSIVE (everything visible) so stale
 * workflows never lose widgets, except that their duration list leaves out
 * the runner-only lengths (allowedDurations).
 *
 * Design: docs/plans/2026-06-10-video-model-adaptive-inputs-design.md
 */
import { VIDEO_MODELS, VIDEO_MODELS_BY_ID } from '../data/video-models'

/** False only when the registry explicitly says the model takes no seed. */
export function modelSupportsSeed(modelId: string): boolean {
  const m = VIDEO_MODELS_BY_ID[modelId]
  return m ? m.supportsSeed : true
}

/**
 * The model's duration options as combo-value strings. An id the catalogue
 * doesn't know (empty, a legacy label, a stale value) keeps every length
 * except those only a runner-only model offers (Wan 3.0's 12, 25 and 30 s,
 * which Sailor's menu adds to the engine's list; shared/runner/modelMenus.ts).
 */
export function allowedDurations(modelId: string): string[] {
  const m = VIDEO_MODELS_BY_ID[modelId]
  return m ? m.durations.map(String) : engineModelDurations()
}

let engineDurationsMemo: string[] | null = null
/** Every length some non-runner-only catalogue model offers (built on first use). */
function engineModelDurations(): string[] {
  if (!engineDurationsMemo) {
    engineDurationsMemo = [...new Set(VIDEO_MODELS.filter(m => !m.runnerOnly).flatMap(m => m.durations))]
      .sort((a, b) => a - b).map(String)
  }
  return engineDurationsMemo
}

/** The model's aspect-ratio options; null = don't filter. */
export function allowedAspectRatios(modelId: string): string[] | null {
  const m = VIDEO_MODELS_BY_ID[modelId]
  return m ? [...m.aspectRatios] : null
}

export interface WidgetCorrection { name: string; value: string }

/**
 * After a model change, corrections for `duration` / `aspect_ratio` values the
 * new model doesn't support (duration → model default; aspect → model default).
 * Positional slots are untouched — callers apply values at the widget's index.
 */
export function snapWidgetsToModel(
  widgetDefs: any[], widgetsValues: any[], modelId: string,
): WidgetCorrection[] {
  const m = VIDEO_MODELS_BY_ID[modelId]
  if (!m) return []
  const out: WidgetCorrection[] = []
  const idxOf = (name: string) => (widgetDefs ?? []).findIndex((d: any) => d?.name === name)

  const durIdx = idxOf('duration')
  if (durIdx >= 0) {
    const cur = String(widgetsValues?.[durIdx] ?? '')
    if (!m.durations.map(String).includes(cur)) {
      out.push({ name: 'duration', value: String(m.defaultDuration) })
    }
  }
  const arIdx = idxOf('aspect_ratio')
  if (arIdx >= 0) {
    const cur = String(widgetsValues?.[arIdx] ?? '')
    // Only snap to a real W:H ratio. Some entries use placeholder strings
    // (fabric-1.0's 'matches image') that the schema combo can't display —
    // for those, leave the current value alone (the backend ignores it).
    if (!m.aspectRatios.includes(cur) && m.defaultAspectRatio.includes(':')) {
      out.push({ name: 'aspect_ratio', value: m.defaultAspectRatio })
    }
  }
  return out
}
