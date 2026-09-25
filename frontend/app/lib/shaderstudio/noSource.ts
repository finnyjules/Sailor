/** The Shader studio with no source image. A generative effect makes its own picture; one that
 *  reads its input is shown over the same neutral sample picture its takes were judged and
 *  thumbnailed on (`placeholderSource`), with a quiet hint, rather than showing nothing. */
import { placeholderSource } from '~/lib/shadergen/productRequest'

export type NoSourceMode = 'sample' | 'generative' | 'none'

export const SAMPLE_PICTURE_HINT = 'Shown over a sample picture. Upload an image to see it on yours.'

/** `defs`: the effects that render (enabled layers, plus the active one). */
export function noSourceMode(defs: ReadonlyArray<{ generative?: boolean } | null | undefined>): NoSourceMode {
  const real = defs.filter((d): d is { generative?: boolean } => !!d)
  if (!real.length) return 'none'
  return real.some(d => !d.generative) ? 'sample' : 'generative'
}

/** The picture to render over when there is no source. */
export function noSourceBase(mode: NoSourceMode, generativeBase: HTMLCanvasElement): HTMLCanvasElement {
  return mode === 'sample' ? placeholderSource() : generativeBase
}
