import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import { buildFrameContext } from './frameContext'
import { makeFrameMeasure } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'

export interface PosterState { patternId: string; seed: number }

export interface ApplyArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  titleFace: string
  titleWeight: number
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void }
}

/** Run a pattern on a frame and apply its ops as ONE undo step. Returns the
 *  PosterState the caller writes to props.sailor_posterState. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return { ok: false }
  const measure = makeFrameMeasure(args.titleFace, args.titleWeight)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure)
  ctx.seed = args.seed
  const placement = pattern.place(ctx)
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []).slice()
  const next = applyPlacement(layers, placement, ctx.elements, args.palette)
  args.editor.recordHistory()
  args.editor.commit(next)
  return { ok: true, posterState: { patternId: args.patternId, seed: args.seed } }
}
