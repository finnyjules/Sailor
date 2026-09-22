// No imports on purpose: the painter (useCompositorLayers.ts) imports this at runtime,
// and units.ts imports the painter at runtime, so nothing here may import the resolver.

/** The transient draw-time scale a responsive layout asks the painter for. 1 when absent. */
export function layoutScaleOf(layer: { layoutScale?: number }): number {
  const v = layer.layoutScale
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}
