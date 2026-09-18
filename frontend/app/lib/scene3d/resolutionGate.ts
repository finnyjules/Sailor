// Resolution gate math (pure — no three, no DOM, unit-tested).
//
// The viewport fills the pane at the PANE aspect, but an export renders at the OUTPUT aspect with the
// same vertical FOV — so the export can frame content off the sides of the viewport, and the user
// can't see the crop. The gate fixes this: the viewport camera OVERSCANS (a slightly wider FOV) so
// the output frame always fits inside the pane, drawn as a bordered rectangle with the rest dimmed.
// Exports keep the TRUE (un-overscanned) FOV, so what's inside the gate is exactly what's exported.

const DEG = Math.PI / 180

/** The viewport FOV (vertical, degrees) that fits the output frame inside the pane with a `fill`
 *  margin (output occupies `fill` of the limiting dimension). Always ≥ baseFov (never zooms IN). */
export function overscanFov(baseFovDeg: number, paneAspect: number, outputAspect: number, fill = 0.9): number {
  const tb = Math.tan((baseFovDeg * DEG) / 2)
  // Need the output half-extents (tb*outputAspect, tb) to fit within `fill` of the viewport
  // half-extents (tanHalf*paneAspect, tanHalf) in BOTH axes → take the binding one.
  // Guard a degenerate/transient pane aspect (a collapsed or not-yet-measured viewport) so it can't
  // blow the fov up absurdly; a real pane is nowhere near this clamp.
  const pa = Number.isFinite(paneAspect) && paneAspect > 0 ? paneAspect : 1
  const tanHalf = Math.max((tb * outputAspect) / (fill * pa), tb / fill)
  return Math.min(110, Math.max(baseFovDeg, 2 * Math.atan(tanHalf) / DEG))
}

/** The output frame as centered fractions of the pane (width, height in 0..1), given the overscan
 *  above. wFrac/hFrac ≤ 1; the smaller one is the boxed axis (pillar- or letter-boxing). */
export function gateRect(baseFovDeg: number, paneAspect: number, outputAspect: number, fill = 0.9): { wFrac: number; hFrac: number } {
  const vFov = overscanFov(baseFovDeg, paneAspect, outputAspect, fill)
  const tb = Math.tan((baseFovDeg * DEG) / 2)
  const tv = Math.tan((vFov * DEG) / 2)
  return {
    wFrac: Math.min(1, (tb * outputAspect) / (tv * paneAspect)),
    hFrac: Math.min(1, tb / tv),
  }
}
