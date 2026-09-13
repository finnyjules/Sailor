import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { planPattern, applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'
import type { PatternPlan, PosterState } from '~/lib/frame/patterns/applyToFrame'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { sheetFor, variantsFor } from '~/lib/frame/patterns/sheet'
import type { Tile } from '~/lib/frame/patterns/sheet'
import { PATTERNS } from '~/lib/frame/patterns/catalog'
import { buildFrameContext, posterLayerViews } from '~/lib/frame/patterns/frameContext'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { makeFrameMeasure, titleMeasureFrom } from '~/lib/frame/patterns/frameMeasure'
import type { TextLayer } from '~/composables/useCompositorLayers'
import type { FrameElements } from '~/lib/frame/patterns/types'

export type SheetTile = Tile & { plan: PatternPlan }

export interface LayoutSheetSource {
  props: () => Record<string, unknown> | undefined
  frameW: () => number
  frameH: () => number
  connectedSlots: () => number[]
  editor: () => { recordHistory(): void; commit(next: any[]): void; writeOrder(order: string[]): void }
  /** Persist the applied state (UI memory, outside the undo step). */
  remember: (s: PosterState) => void
}

const VARIANTS = 6

/** The Layout tab's state: a seed, an optional focus pattern, and the tiles
 *  (each already planned, so a tile can be painted and applied without re-running
 *  the engine). Pure over the engine; the only side effects are in apply(). */
export function useLayoutSheet(src: LayoutSheetSource): {
  seed: Ref<number>; focus: Ref<string | null>; tiles: ComputedRef<SheetTile[]>
  shapeMode: Ref<FrameElements['shapeMode'] | undefined>; setShapeMode(m: FrameElements['shapeMode']): void
  apply(tile: SheetTile): void; another(): void; moreLikeThis(tile: SheetTile): void; back(): void
} {
  const remembered = (src.props()?.sailor_posterState as PosterState | undefined)?.seed
  const seed = ref<number>(Number.isFinite(remembered) ? (remembered as number) : 1)
  const focus = ref<string | null>(null)

  const stored = src.props()?.sailor_posterState as { shapeMode?: FrameElements['shapeMode'] } | undefined
  const shapeMode = ref<FrameElements['shapeMode'] | undefined>(stored?.shapeMode ?? undefined)
  function setShapeMode(m: FrameElements['shapeMode']) {
    shapeMode.value = m
    const p = src.props(); if (p) (p as any).sailor_posterState = { ...(p as any).sailor_posterState, shapeMode: m }
  }

  function context() {
    const props = src.props()
    const layers = ((props?.sailor_localLayers as any[] | undefined) ?? [])
    const elements = inferElements(posterLayerViews(props), shapeMode.value)
    const titleLayer = layers.find(l => l.id === elements.title?.id && l.kind === 'text') as TextLayer | undefined
    const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
    return buildFrameContext(props, src.frameW(), src.frameH(), makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform), elements)
  }

  // The sheet always plans from the frame AS IT IS NOW, so after an apply the
  // next sheet branches from the applied layout rather than the original —
  // by design (Cmd+Z returns to the original and the sheet follows).
  const tiles = computed<SheetTile[]>(() => {
    const ctx = context()
    if (!ctx.elements.title) return []
    const raw = focus.value
      ? (() => { const p = PATTERNS.find(x => x.id === focus.value); return p ? variantsFor(ctx, p, seed.value, VARIANTS) : [] })()
      : sheetFor(ctx, seed.value)
    const palette = paletteFromFrame(src.props())
    const out: SheetTile[] = []
    for (const t of raw) {
      const plan = planPattern({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: t.patternId, seed: t.seed, palette, connectedSlots: src.connectedSlots(), placement: { ops: t.ops, did: t.did }, shapeMode: shapeMode.value })
      if (plan) out.push({ ...t, plan })
    }
    return out
  })

  function apply(tile: SheetTile) {
    const out = applyPatternToFrame({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: tile.patternId, seed: tile.seed, palette: paletteFromFrame(src.props()), connectedSlots: src.connectedSlots(), shapeMode: shapeMode.value, editor: src.editor() })
    if (out.ok && out.posterState) src.remember(out.posterState)
  }
  function another() { seed.value += 1 }
  function moreLikeThis(tile: SheetTile) { focus.value = tile.patternId }
  function back() { focus.value = null }
  return { seed, focus, tiles, shapeMode, setShapeMode, apply, another, moreLikeThis, back }
}
