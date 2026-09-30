/**
 * Per-wired-layer treatments (Phase 1: mask reference) persisted on the node as
 * `sailor_wiredTreatments`, keyed by the unified StackKey ('w:<slot>'). This
 * mirrors how sailor_stackOrder lives in node.data.properties. Pure helpers so
 * the logic is unit-testable outside the SFC.
 */
export interface WiredTreatment {
  maskedByKey?: string
  showSource?: boolean
  maskUrl?: string
  /** Depth of field, the same shape a local layer carries in `LocalLayer.effects`.
   *  Wired and uploaded images must expose the same features — a gap reads as a bug —
   *  and this is the per-slot store that already exists for exactly that reason
   *  (`maskUrl` was added here to give Smart Select and brush Mask wired parity). */
  dof?: import('~/lib/compositor/postEffects').DofEffect
  /** Relight, the same shape a local layer carries — wired parity, same as `dof` above. */
  relight?: import('~/lib/relight/settings').RelightEffect
}
export type WiredTreatments = Record<string, WiredTreatment>

export function readWiredTreatments(node: any): WiredTreatments {
  return (node?.data?.properties?.sailor_wiredTreatments as WiredTreatments | undefined) ?? {}
}

function writeWiredTreatments(node: any, next: WiredTreatments) {
  if (!node?.data) return
  if (!node.data.properties) node.data.properties = {}
  node.data.properties.sailor_wiredTreatments = next
}

/** Set/clear the mask reference for a wired slot (1-based). Empty key clears. */
export function setWiredMask(node: any, slot: number, maskedByKey: string) {
  const key = `w:${slot}`
  const cur = { ...readWiredTreatments(node) }
  if (maskedByKey) {
    cur[key] = { ...cur[key], maskedByKey }
  } else {
    // Drop the mask ref; preserve any other fields on this entry, and remove the
    // entry entirely if it's now empty (avoids stale w:<slot> keys lingering).
    const t = { ...cur[key] }
    delete t.maskedByKey
    if (Object.keys(t).length) cur[key] = t
    else delete cur[key]
  }
  writeWiredTreatments(node, cur)
}

/** Set/clear the showSource flag for a wired slot (1-based). Preserves other fields. */
export function setWiredMaskShowSource(node: any, slot: number, show: boolean) {
  const key = `w:${slot}`
  const cur = { ...readWiredTreatments(node) }
  if (show) {
    cur[key] = { ...cur[key], showSource: true }
  } else {
    const t = { ...cur[key] }
    delete t.showSource
    if (Object.keys(t).length) cur[key] = t
    else delete cur[key]
  }
  writeWiredTreatments(node, cur)
}

/** Set/clear the per-slot raster visibility mask (data URL, white = hidden).
 *  Empty url clears the field, dropping the entry if nothing else remains. */
export function setWiredMaskUrl(node: any, slot: number, url: string) {
  const key = `w:${slot}`
  const cur = { ...readWiredTreatments(node) }
  if (url) {
    cur[key] = { ...cur[key], maskUrl: url }
  } else {
    const t = { ...cur[key] }
    delete t.maskUrl
    if (Object.keys(t).length) cur[key] = t
    else delete cur[key]
  }
  writeWiredTreatments(node, cur)
}

/** Every other present layer key (cross-source), excluding `selfKey`. */
export function maskCandidateKeys(presentKeys: string[], selfKey: string): string[] {
  return presentKeys.filter(k => k !== selfKey)
}

/**
 * Set/clear depth of field for a wired slot (1-based). Preserves other fields.
 *
 * Wired images get the same effects as uploaded ones — a feature that appears on one
 * and not the other reads as a bug rather than a limitation.
 */
export function setWiredDof(node: any, slot: number, dof: WiredTreatment['dof'] | null) {
  const key = `w:${slot}`
  const cur = { ...readWiredTreatments(node) }
  if (dof) {
    cur[key] = { ...cur[key], dof }
  } else {
    const t = { ...cur[key] }
    delete t.dof
    if (Object.keys(t).length) cur[key] = t
    else delete cur[key]   // no stale w:<slot> entries
  }
  writeWiredTreatments(node, cur)
}

/**
 * Set/clear Relight for a wired slot (1-based). Preserves other fields. Mirrors
 * `setWiredDof` exactly (same key, same delete-when-null rule).
 */
export function setWiredRelight(node: any, slot: number, relight: WiredTreatment['relight'] | null) {
  const key = `w:${slot}`
  const cur = { ...readWiredTreatments(node) }
  if (relight) {
    cur[key] = { ...cur[key], relight }
  } else {
    const t = { ...cur[key] }
    delete t.relight
    if (Object.keys(t).length) cur[key] = t
    else delete cur[key]   // no stale w:<slot> entries
  }
  writeWiredTreatments(node, cur)
}
