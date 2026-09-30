/**
 * The video effects' cores, in dependency order (step 3, R6): what the
 * compositor worker composes from each core's source text after the effect
 * cores (compositor/worker.ts workerScript: `tk`, the tensors, is theirs), and
 * the same cores built in this thread for tests.
 *
 * `vx` (./core/time.ts framesCore) turns frames into tensors and back: the
 * worker's `vfx.frame` op uses it for every video effect. A video effect's op
 * is '<name>.<fn>' (./table.ts VideoEffectSpec.op). Each task adds its core.
 */
import type { EffectCoreEntry } from '../effects/cores'
import { effectCores } from '../effects/cores'
import { framesCore, timeCore } from './core/time'
import { joinCore } from './core/join'
import { lookCore } from './core/look'

export const VIDEO_CORES: readonly EffectCoreEntry[] = [
  { name: 'vx', fn: framesCore as EffectCoreEntry['fn'], args: ['tk'] },
  // R6.1: Trim, Reverse and Frame trail; R6.2: Slit scan, Time displacement and Speed ramp.
  { name: 'time', fn: timeCore as EffectCoreEntry['fn'], args: ['tk', 'kn', 'rng'] },
  // R6.3: Crossfade and Transition.
  { name: 'join', fn: joinCore as EffectCoreEntry['fn'], args: ['tk', 'kn', 'rng'] },
  // R6.4: Ken Burns, Aspect convert, Chroma key, LUT and 3-way color.
  { name: 'look', fn: lookCore as EffectCoreEntry['fn'], args: ['tk', 'kn'] },
]

/** The cores whose functions are video ops (not helpers). */
export const VIDEO_OP_CORES: readonly string[] = ['time', 'join', 'look']

/** The cores in this thread (tests), built as the worker builds them. */
export const videoCores = (() => {
  const { tk, kn, rng } = effectCores
  return { tk, vx: framesCore(tk), time: timeCore(tk, kn, rng), join: joinCore(tk, kn, rng), look: lookCore(tk, kn) }
})()
