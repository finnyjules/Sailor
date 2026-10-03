/**
 * Step 3, R10.6 (decision 4): which classes hosted's node search offers.
 *
 * Hosted has no local engine, so it offers only the classes the runner takes
 * (in some setting: a family row, a runner type, Film a shot for the models it
 * films) plus the cards made in their own editor (the Timeline). Never a
 * local-only class (./localOnly.ts), a custom node, a Sailor class that still
 * needs the local engine (NEEDS_LOCAL_ENGINE, unless the runner takes it in
 * some setting), or a retired one. Blueprints are built from local-only
 * classes, so hosted offers none of them either (`/global_subgraphs` answers
 * an empty list there).
 *
 * Pure; relative imports only.
 */
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES } from './eligibility'
import { isEditorOnlyClass, isRetiredClass } from './retired'

/** Runner classes with no family row of their own, taken only for some settings (eligibility.ts runnerTakesNode). */
const RUNNER_SPECIAL_CLASSES: ReadonlySet<string> = new Set(['FilmShotNode'])

/** Whether hosted's node search offers `classType`. */
export function hostedOffersClass(classType: string): boolean {
  if (isRetiredClass(classType)) return false
  return RUNNER_NODE_TYPES.has(classType)
    || Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType)
    || RUNNER_SPECIAL_CLASSES.has(classType)
    || isEditorOnlyClass(classType)
}
