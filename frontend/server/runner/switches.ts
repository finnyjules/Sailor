/**
 * The runner's families are read again at each node's turn (the env is read
 * per step, so a reattached or later-queued node sees the value now). A node
 * whose model depends on a switch that changed since its leg's hold was taken
 * must not be sent: it would run a model the hold wasn't priced for, or the
 * old model the switch moved it off (line-up Ruling 10). One check for every
 * such node (final review finding 2; final fix F2), generalising Topaz's
 * (F23 fix round 1):
 *   - a class moved onto a newer model as a whole (RunnerNodeRule.upgrade:
 *     Rotate camera on Qwen Image Edit 2511, Product shot on Bria Product
 *     Shot, Enhance a video on fal's Topaz) whose switch is not where it was
 *     when the hold was taken (LegRecord.families). A leg written before that
 *     was recorded is judged as Topaz was: refused only when the switch is off
 *     now and the class has no other way into the runner;
 *   - a runner-only model (Blend scene's Nano Banana 2, and every other) whose
 *     switch is off now (blockedModels.ts, as startRun asks).
 * The node fails at its turn, before anything is read or handed off, and its
 * hold is released. A node resuming a request already sent is never asked:
 * its job is running and was priced at submit.
 *
 * Pure: no I/O.
 */
import type { ApiNode } from '#shared/runner/graph'
import { RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import type { RunnerFamily } from '#shared/runner/families'
import { blockedModelLabel, blockedModelUses } from '#shared/runner/blockedModels'
import { TOPAZ_VIDEO_SWITCHED_OFF } from '#shared/runner/topazVideo'

/** The refusal when a node's model was switched off in Sailor after Run was pressed. */
export function switchedOffWords(label: string): string {
  return `${label} in Sailor was switched off after you pressed Run, so this step wasn’t sent. Run it again.`
}

/** The refusal when a node's newer model was switched on after Run was pressed (the hold was priced for the older one). */
export function switchedOnWords(label: string): string {
  return `${label} in Sailor was switched on after you pressed Run, so this step wasn’t sent. Run it again.`
}

/**
 * Why a node must not be sent at its turn because a switch changed since its
 * leg's hold, or null. `now`: the families on now; `atHold`: those on when
 * the leg's hold was taken (undefined for a leg written before they were recorded).
 */
export function switchedSinceHold(
  node: ApiNode | undefined,
  now: ReadonlySet<RunnerFamily>,
  atHold?: ReadonlySet<RunnerFamily>,
): string | null {
  if (!node || typeof node.class_type !== 'string') return null
  const rule = Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, node.class_type) ? RUNNER_NODE_RULES[node.class_type] : undefined
  const upgrade = rule?.upgrade
  if (upgrade) {
    const onNow = now.has(upgrade.family)
    const wasOn = atHold ? atHold.has(upgrade.family) : !(rule.family || rule.models) || onNow
    if (wasOn && !onNow) return node.class_type === 'EnhanceVideoNode' ? TOPAZ_VIDEO_SWITCHED_OFF : switchedOffWords(upgrade.label)
    if (!wasOn && onNow) return switchedOnWords(upgrade.label)
  }
  const offModel = blockedModelUses({ n: node }, { families: now, runnerTakes: true }).find(u => u.reason === 'runner-only')
  return offModel ? switchedOffWords(blockedModelLabel(offModel)) : null
}
