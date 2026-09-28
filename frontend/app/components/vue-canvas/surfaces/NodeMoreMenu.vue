<script lang="ts">
export interface MoreItem { label: string; onSelect: () => void; disabled?: boolean }
</script>

<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'

const props = defineProps<{ items: MoreItem[] }>()
const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })

// The menu lives on <body> (position: fixed) so no card, media box or canvas transform
// can clip or scale it. Placed from the More button: below it, right edges aligned;
// flipped above when it would pass the viewport bottom, kept inside the side edges.
const MENU_W = 192
const GAP = 4
const EDGE = 8
function place() {
  const r = btn.value?.getBoundingClientRect()
  if (!r) return
  const h = menu.value?.offsetHeight ?? props.items.length * 30 + 8
  let top = r.bottom + GAP
  if (top + h > window.innerHeight - EDGE) top = r.top - GAP - h
  let left = r.right - MENU_W
  if (left < EDGE) left = r.left
  if (left + MENU_W > window.innerWidth - EDGE) left = window.innerWidth - EDGE - MENU_W
  pos.value = { top: Math.max(EDGE, top), left: Math.max(EDGE, left) }
}

function enabledItems(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
}
function close(refocus = false) {
  open.value = false
  if (refocus) btn.value?.focus()
}
function toggle() { open.value = !open.value }
function pick(item: MoreItem) {
  if (item.disabled) return
  open.value = false
  item.onSelect()
}

function onOutside(e: Event) {
  const t = e.target as Node
  if (btn.value?.contains(t) || menu.value?.contains(t)) return
  close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation()
    close(true)
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault(); e.stopPropagation()
  const list = enabledItems()
  if (!list.length) return
  const i = list.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'ArrowDown'
    ? (i < 0 ? 0 : (i + 1) % list.length)
    : (i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length)
  list[next]!.focus()
}
function onDismiss() { close() }

function listen(on: boolean) {
  if (on) {
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onDismiss, { capture: true, passive: true })
    window.addEventListener('resize', onDismiss)
  } else {
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('wheel', onDismiss, { capture: true })
    window.removeEventListener('resize', onDismiss)
  }
}

watch(open, async (v) => {
  listen(v)
  if (!v) return
  place()
  await nextTick()
  place()
  enabledItems()[0]?.focus()
})
onBeforeUnmount(() => { if (open.value) listen(false) })
</script>

<template>
  <div v-if="items.length" class="relative">
    <button
      ref="btn" type="button" class="node-float-btn" aria-label="More" title="More"
      aria-haspopup="menu" :aria-expanded="open"
      @click.stop="toggle"
    >
      <MoreHorizontal class="size-3.5" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        role="menu"
        class="nopan nodrag fixed z-[1000] w-48 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl"
        :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      >
        <button
          v-for="item in items" :key="item.label"
          type="button" role="menuitem"
          :disabled="item.disabled"
          class="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-white/80 outline-none transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:bg-white/[0.08] focus-visible:text-white disabled:cursor-not-allowed disabled:opacity-40"
          @click.stop="pick(item)"
        >{{ item.label }}</button>
      </div>
    </Teleport>
  </div>
</template>
