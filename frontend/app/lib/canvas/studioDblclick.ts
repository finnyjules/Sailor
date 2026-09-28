/** Double-click opens a studio card's studio — but not on its own buttons or form fields. */
export function isStudioControl(e: MouseEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, button')
}
