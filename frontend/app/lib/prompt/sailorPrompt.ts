// The small rules behind the one prompt (spec §2.1, §2.1a). Pure, so the
// component and every host agree on them and they can be tested without a DOM.

export function promptPlaceholder(selectionLabel?: string | null): string {
  const label = selectionLabel?.trim()
  return label ? `Change or ask about ${label}` : 'Ask Sailor'
}

/** Esc clears a mode chip first (only on an empty field), then leaves the field. */
export function escapeStep(s: { text: string; mode: string | null }): 'clearMode' | 'blur' {
  return !s.text.trim() && s.mode ? 'clearMode' : 'blur'
}

export function isEditableTarget(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { tagName?: unknown; isContentEditable?: unknown }
  const tag = String(el.tagName ?? '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

/** `/` outside a field, or ⌘K / Ctrl+K anywhere, focuses the prompt. */
export function shouldFocusPrompt(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return true
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)
}
