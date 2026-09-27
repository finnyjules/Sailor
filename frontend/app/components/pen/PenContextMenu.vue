<!-- app/components/pen/PenContextMenu.vue -->
<script setup lang="ts">
// The pen's right-click list menu (pen stage 6). Draws `pen.menu` — built by
// penActions.ts — and nothing else: the pen owns its keys (usePen menuKey:
// arrows, Enter, Escape), so this component only renders, follows the mouse
// and closes on a click away. Mounted by PenOverlay while `pen.menu` is set,
// teleported to <body> above every modal (z 10040, under the tip cards).
// Greyed items are aria-disabled, not disabled, so their card still opens on
// hover and says why.
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import { TooltipProvider } from '~/components/ui/tooltip'
import { tipKeyLabel } from '~/composables/pen/penTips'

const props = defineProps<{ pen: Pen }>()
const { menu, closeMenu, runMenuItem, setMenuActive } = props.pen
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const root = ref<HTMLElement | null>(null)
const pos = ref({ x: menu.value?.at.x ?? 0, y: menu.value?.at.y ?? 0 })
// keep the whole menu inside the window (8 px margin), measured once drawn
async function place() {
  const m = menu.value
  if (!m) return
  pos.value = { x: m.at.x, y: m.at.y }
  await nextTick()
  const el = root.value
  if (!el || typeof window === 'undefined') return
  const r = el.getBoundingClientRect()
  pos.value = {
    x: Math.max(8, Math.min(m.at.x, window.innerWidth - r.width - 8)),
    y: Math.max(8, Math.min(m.at.y, window.innerHeight - r.height - 8)),
  }
}
watch(() => menu.value?.at, place)

// a press outside closes it; on the drawing a left / middle press only closes
// it (no marquee, no point) — a right press there opens a new menu
function onWindowPointerDown(e: PointerEvent) {
  if (!menu.value) return
  const t = e.target as Element | null
  if (t && (root.value?.contains(t) || t.closest?.('[data-pen-tip]'))) return
  closeMenu()
  if (e.button !== 2 && !(e.ctrlKey && isMac) && t?.closest?.('[data-pen-overlay]')) { e.stopPropagation(); e.preventDefault() }
}
function onAway() { closeMenu() }
onMounted(() => {
  void place()
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('wheel', onAway, { capture: true, passive: true })
  window.addEventListener('resize', onAway)
  window.addEventListener('blur', onAway)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('wheel', onAway, { capture: true } as EventListenerOptions)
  window.removeEventListener('resize', onAway)
  window.removeEventListener('blur', onAway)
})
</script>

<template>
  <Teleport to="body">
    <TooltipProvider :delay-duration="350" :skip-delay-duration="600" disable-hoverable-content>
      <div v-if="menu" ref="root" data-pen-menu role="menu" :aria-label="menu.header ?? 'Drawing'" class="pen-menu"
           :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @contextmenu.prevent>
        <div v-if="menu.header" class="pen-menu-header" data-pen-menu-header>{{ menu.header }}</div>
        <template v-for="(group, gi) in menu.groups" :key="gi">
          <div v-if="gi > 0 || menu.header" class="pen-menu-sep" role="separator" />
          <PenTipCard v-for="it in group" :id="it.tip" :key="it.id" :name="it.label" side="right"
                      :reason="it.state.ok ? undefined : it.state.reason">
            <button type="button" role="menuitem" tabindex="-1" class="pen-menu-item" :class="{ danger: it.danger }"
                    :data-menu-item="it.id" :aria-disabled="it.state.ok ? undefined : 'true'"
                    :data-active="menu.active === it.id ? '' : null"
                    @mouseenter="setMenuActive(it.state.ok ? it.id : null)" @click="runMenuItem(it.id)">
              <span class="label">{{ it.label }}</span>
              <kbd v-if="it.key" class="key">{{ tipKeyLabel(it.key, isMac) }}</kbd>
            </button>
          </PenTipCard>
        </template>
      </div>
    </TooltipProvider>
  </Teleport>
</template>

<style scoped>
/* the look of CanvasContextMenu (the app's other right-click menus) */
.pen-menu {
  position: fixed; z-index: 10040; min-width: 208px; max-width: 280px; padding: 4px 0;
  background: color-mix(in srgb, #1a1a1a 97%, transparent); border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.9); font: 400 13px/1.2 ui-sans-serif, system-ui, sans-serif; user-select: none;
}
.pen-menu-header { padding: 6px 12px 5px; font-size: 11px; color: rgba(255, 255, 255, 0.5); }
.pen-menu-sep { height: 1px; margin: 4px 8px; background: rgba(255, 255, 255, 0.1); }
.pen-menu-item {
  display: flex; width: 100%; align-items: center; gap: 12px; padding: 6px 12px; border: 0; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.pen-menu-item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pen-menu-item .key { font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: rgba(255, 255, 255, 0.4); }
.pen-menu-item[data-active] { background: rgba(255, 255, 255, 0.08); }
.pen-menu-item.danger { color: #fda4af; }
.pen-menu-item[aria-disabled='true'] { opacity: 0.4; cursor: default; }
</style>
