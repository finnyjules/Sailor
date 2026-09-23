import type { Component } from 'vue'

/** One action in a footer zone. Rendered as a menu row (downloads/canvas) or a
 *  subtle button (utilities). */
export interface StudioFooterAction {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean            // shows a spinner / busy label on the trigger + row
  icon?: Component          // optional leading icon (e.g. Dices for Roll)
  subtitle?: string         // small dim second line, menu rows only (e.g. a caveat)
  testId?: string           // data-testid on the row / button, for end-to-end specs
}

export interface StudioFooterStatus {
  saving?: boolean
  saved?: boolean
  error?: string | null
  notice?: string | null   // neutral progress / success / warning text
}

/** The whole footer, declarative. Utilities + status sit left; downloads then
 *  canvas dock right. An empty/absent zone renders nothing. */
export interface StudioFooterSpec {
  status?: StudioFooterStatus
  utilities?: StudioFooterAction[]
  downloads?: StudioFooterAction[]
  canvas?: StudioFooterAction[]
}

/** Status precedence: error > notice > saving > saved. Returns null when idle. */
export function resolveStatus(
  s?: StudioFooterStatus,
): { text: string; tone: 'error' | 'notice' | 'saving' | 'saved' } | null {
  if (!s) return null
  if (s.error) return { text: s.error, tone: 'error' }
  if (s.notice) return { text: s.notice, tone: 'notice' }
  if (s.saving) return { text: 'Saving…', tone: 'saving' }
  if (s.saved) return { text: 'Saved ✓', tone: 'saved' }
  return null
}
