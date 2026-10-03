/**
 * Which classes Sailor offers (node search, the toolbox, the menus, the
 * agent's catalogue). Step 3, R10.6 made this hosted's rule; step 4, C5 made
 * it the only rule, here and hosted alike: there is no local engine.
 *
 * Sailor offers only the classes the runner takes (in some setting: a family
 * row, a runner type, Film a shot for the models it films) plus the cards made
 * in their own editor (the Timeline). Never a stock class Sailor doesn't run
 * (./stockClasses.ts), a custom node, or a retired one. Blueprints are built
 * from stock classes, so none is offered either (`/global_subgraphs` answers
 * an empty list).
 *
 * Pure; relative imports only.
 */
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, RUNNER_SPECIAL_CLASSES } from './eligibility'
import { isEditorOnlyClass, isRetiredClass } from './retired'

/** Whether Sailor offers `classType` to be added to a canvas. */
export function sailorOffersClass(classType: string): boolean {
  if (isRetiredClass(classType)) return false
  return RUNNER_NODE_TYPES.has(classType)
    || Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType)
    || RUNNER_SPECIAL_CLASSES.has(classType)
    || isEditorOnlyClass(classType)
}
