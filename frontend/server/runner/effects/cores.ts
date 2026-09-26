/**
 * The effect cores, in dependency order (step 3, R2): what the compositor
 * worker composes from each core's source text (compositor/worker.ts
 * workerScript), and the same cores built in this thread for tests.
 *
 * Each entry is a self-contained function called with the cores named in
 * `args`, already built (`px` is ../pixels/core.ts pixelsCore). An effect's
 * worker op is '<name>.<fn>' (effects/table.ts EffectSpec.op). R2.2's
 * kernels and R2.3's random numbers join this list before the families
 * that consume them. `kn` (R2.2, ./core/kernels.ts) is the kernels: helpers,
 * not ops. `rng` (R2.3, ./core/rng.ts) is torch's CPU generator: helpers too.
 */
import { pixels } from '../pixels/core'
import { tensorCore } from './core/tensor'
import { toneCore } from './core/tone'
import { kernelsCore } from './core/kernels'
import { rngCore } from './core/rng'

export interface EffectCoreEntry {
  /** The name the worker (and an op) knows the built core by. */
  name: string
  fn: (...deps: never[]) => unknown
  /** The built cores it takes, by name, in order ('px': the pixels core). */
  args: readonly string[]
}

export const EFFECT_CORES: readonly EffectCoreEntry[] = [
  { name: 'tk', fn: tensorCore as EffectCoreEntry['fn'], args: ['px'] },
  { name: 'tone', fn: toneCore as EffectCoreEntry['fn'], args: ['tk'] },
  { name: 'kn', fn: kernelsCore as EffectCoreEntry['fn'], args: ['tk', 'px'] },
  { name: 'rng', fn: rngCore as EffectCoreEntry['fn'], args: [] },
]

/** The cores whose functions are effect ops (not helpers). */
export const EFFECT_OP_CORES: readonly string[] = ['tone']

/** The cores in this thread (tests), built as the worker builds them. */
export const effectCores = (() => {
  const tk = tensorCore(pixels)
  return { px: pixels, tk, tone: toneCore(tk), kn: kernelsCore(tk, pixels), rng: rngCore() }
})()
