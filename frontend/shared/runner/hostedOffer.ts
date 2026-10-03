/**
 * Step 3, R10.6 (decision 4): which classes hosted's node search offers.
 *
 * Hosted has no local engine, so it offers only the classes the runner takes
 * (in some setting: a family row, a runner type, Film a shot for the models it
 * films) plus the cards made in their own editor (the Timeline). Never a
 * local-only class (./localOnly.ts), a custom node, or a retired one (step 4,
 * C4: NEEDS_LOCAL_ENGINE is empty, each of its classes ported or retired).
 * Blueprints are built from local-only classes, so hosted offers none of them
 * either (`/global_subgraphs` answers an empty list there).
 *
 * Pure; relative imports only.
 */
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, RUNNER_SPECIAL_CLASSES } from './eligibility'
import { isEditorOnlyClass, isRetiredClass } from './retired'

/** Whether hosted's node search offers `classType`. */
export function hostedOffersClass(classType: string): boolean {
  if (isRetiredClass(classType)) return false
  return RUNNER_NODE_TYPES.has(classType)
    || Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType)
    || RUNNER_SPECIAL_CLASSES.has(classType)
    || isEditorOnlyClass(classType)
}
