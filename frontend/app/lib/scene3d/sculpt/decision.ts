// Which entry path the unified Sculpt verb takes for the current
// single-primitive selection. A `mesh` primitive sculpts directly; a non-mesh
// primitive must first be frozen to a mesh (convertToMesh — irreversible), so
// that is gated behind a one-time confirm unless the user suppressed it this
// session.
export type SculptAction = 'enter' | 'confirm' | 'convert-then-enter'

export function sculptDecision(isMesh: boolean, confirmSuppressed: boolean): SculptAction {
  if (isMesh) return 'enter'
  return confirmSuppressed ? 'convert-then-enter' : 'confirm'
}
