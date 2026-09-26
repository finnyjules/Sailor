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
import { blurCore } from './core/blur'
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
  { name: 'kn', fn: kernelsCore as EffectCoreEntry['fn'], args: ['tk', 'px'] },
  // R2.4: the tone effects use the kernels (torchvision's colour ops, linspace, pow, clamp).
  { name: 'tone', fn: toneCore as EffectCoreEntry['fn'], args: ['tk', 'kn'] },
  { name: 'rng', fn: rngCore as EffectCoreEntry['fn'], args: [] },
  // R2.5: the blur and convolution effects (gaussian blur, depthwise conv, resizes, pools, topk).
  { name: 'blur', fn: blurCore as EffectCoreEntry['fn'], args: ['tk', 'kn'] },
]

/** The cores whose functions are effect ops (not helpers). */
export const EFFECT_OP_CORES: readonly string[] = ['tone', 'blur']

/** The cores in this thread (tests), built as the worker builds them. */
export const effectCores = (() => {
  const tk = tensorCore(pixels)
  const kn = kernelsCore(tk, pixels)
  return { px: pixels, tk, kn, tone: toneCore(tk, kn), rng: rngCore(), blur: blurCore(tk, kn) }
})()
