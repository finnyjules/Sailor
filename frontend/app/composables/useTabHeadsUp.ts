/**
 * When a run finishes (or pauses at a Gate) while Sailor is in a background
 * tab, the tab title and icon say so. Both clear when you come back.
 * No notifications, no sound — just the tab.
 */
export const BASE_TITLE = 'Sailor'
export const FAVICON_URL = '/favicon.svg'

const DOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#111"/><path d="M15 5v18H7z" fill="#fff"/><path d="M17.5 9v14H25z" fill="#fff" opacity=".7"/><path d="M6 26h20" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="25" cy="7" r="6" fill="#ff6b57" stroke="#111" stroke-width="2"/></svg>'
export const FAVICON_DOT_URL = `data:image/svg+xml,${encodeURIComponent(DOT_SVG)}`

export type HeadsUpKind = 'image' | 'video' | 'paused' | 'failed'

export function headsUpTitle(kind: HeadsUpKind): string {
  switch (kind) {
    case 'image': return `✓ Image ready · ${BASE_TITLE}`
    case 'video': return `✓ Video ready · ${BASE_TITLE}`
    case 'paused': return `Ready to review · ${BASE_TITLE}`
    case 'failed': return `Run failed · ${BASE_TITLE}`
  }
}

export function createHeadsUp(page: { isHidden(): boolean; setTitle(t: string): void; setIcon(href: string): void }) {
  let showing = false
  return {
    notify(kind: HeadsUpKind): void {
      if (!page.isHidden()) return
      page.setTitle(headsUpTitle(kind))
      page.setIcon(FAVICON_DOT_URL)
      showing = true
    },
    clear(): void {
      if (!showing) return
      page.setTitle(BASE_TITLE)
      page.setIcon(FAVICON_URL)
      showing = false
    },
  }
}

export function useTabHeadsUp() {
  const h = createHeadsUp({
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    setTitle: (t) => { document.title = t },
    setIcon: (href) => {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) {
        link = document.createElement('link')
        link.rel = 'icon'
        document.head.appendChild(link)
      }
      link.type = 'image/svg+xml'
      link.href = href
    },
  })
  const onVisible = () => { if (!document.hidden) h.clear() }
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  })
  return { notify: h.notify }
}
