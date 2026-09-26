/**
 * LoadImage (nodes.py LoadImage.load_image) feeding anything (step 3, R1.3).
 * Its IMAGE is the file EXIF turned, first frame, RGB, as the PNG a provider
 * would be sent (../pictures/pythonView.ts; the file itself when it already is
 * that picture); its MASK is 1 − alpha, or a 64×64 zero mask
 * (../pictures/mask.ts), kept as the runner keeps masks.
 *
 * With `cards` off, the LoadImage the Frame editor injects is handed to its
 * Frames as a file, exactly as before step 3 (the Frame decodes it itself).
 */
import { linksOf } from '#shared/runner/graph'
import type { NodePlan, PlanContext } from '../executors'
import { parseInputFileRef } from '../inputs'
import { rgbTurnedPng } from '../pictures/pythonView'
import { encodeMask, loadImageMask } from '../pictures/mask'

export function planLoadImageCard(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = parseInputFileRef(inputs.image)
  if (!file) throw new Error('There is no picture to load')
  const onlyFrames = Object.values(ctx.prompt).every(n => n.class_type === 'Compositor' || !linksOf(n).some(l => l.from === ctx.nodeId))
  if (onlyFrames && !ctx.families?.has('cards')) return { kind: 'pass', files: [file], ui: null }
  return {
    kind: 'derive',
    async derive(io) {
      const bytes = await io.read(file)
      const { png } = await rgbTurnedPng(bytes)
      const image = png ? await io.keep(png, 'png') : file
      const mask = await io.keep(await encodeMask(await loadImageMask(bytes)), 'png')
      return { values: { 0: { kind: 'files', files: [image] }, 1: { kind: 'mask', files: [mask] } }, ui: null }
    },
  }
}
