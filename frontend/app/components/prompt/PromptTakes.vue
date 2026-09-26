<script setup lang="ts">
// The takes strip above the prompt (spec §3.1): the version it started from,
// then three tiles that fill in as takes arrive. Presentational: the host owns
// the session and previews on the work. Identical in every host (spec §2.1a).
//
// Hover (or focus) a tile to preview it on the work; click it (Enter / Space) to
// keep it, which closes the strip. "Current" keeps what was there (the strip's
// close). With no hover (touch), the first tap previews a tile and a second tap on
// the same tile keeps it.
import { computed, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { CURRENT, failedTileText, isTakesWorking, readyCount, takesStatus, type TakesSession } from '~/lib/prompt/takesSession'

// `saving`: a kept take is being saved (effect takes, stage 5) — no second keep until it settles.
// `error`: why the last keep failed (or why takes were refused), shown on the strip while it stays open.
// `moreNote`: what "Three more" will cost (a paid effect set), shown on the button before the click.
const props = withDefaults(defineProps<{ session: TakesSession; saving?: boolean; error?: string | null; moreNote?: string | null }>(), { saving: false, error: null, moreNote: null })
const emit = defineEmits<{ hover: [id: string | null]; keep: [id: string]; more: []; close: [] }>()

const working = computed(() => isTakesWorking(props.session))
const status = computed(() => takesStatus(props.session))
const title = computed(() => (props.session.request ? `“${props.session.request}”` : 'Variations'))

// Touch: a device without hover says "tap"; a touch tap anywhere switches to it too.
const noHover = ref(false)
onMounted(() => { try { noHover.value = !!window.matchMedia?.('(hover: none)').matches } catch { /* no matchMedia */ } })
const hint = computed(() => (noHover.value ? 'Tap to preview, tap again to keep' : 'Hover to preview, click to keep'))
/** The tile a first tap previewed; a second tap on it keeps it. */
const armed = ref<string | null>(null)
let lastPointer = ''
function onPointerDown(e: PointerEvent) {
  lastPointer = e.pointerType
  if (e.pointerType === 'touch') noHover.value = true
}
function pick(id: string, e: MouseEvent) {
  const pointer = lastPointer
  lastPointer = ''
  // A keyboard click (Enter / Space) has no pointer and detail 0: it keeps at once.
  const tap = pointer === 'touch' || (pointer === '' && e.detail > 0 && noHover.value)
  if (tap && armed.value !== id) { armed.value = id; emit('hover', id); return }
  armed.value = null
  if (id === CURRENT) { emit('close'); return }
  if (props.saving) return
  emit('keep', id)
}
const isMarked = (id: string | null) => !!id && (armed.value === id || props.session.chosen === id)
const currentMarked = computed(() => (armed.value ? armed.value === CURRENT : !props.session.chosen || props.session.chosen === CURRENT))
// Tabbing out of the strip ends the preview, as leaving it with the mouse does.
function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (!to || !(e.currentTarget as HTMLElement).contains(to)) { armed.value = null; emit('hover', null) }
}
function onLeave() { if (!armed.value) emit('hover', null) }
</script>

<template>
  <div data-testid="prompt-takes" class="grid grid-cols-1 gap-2" @mouseleave="onLeave" @focusout="onFocusOut" @pointerdown.capture="onPointerDown">
    <div class="flex items-center gap-2 px-1 text-[12px] text-white/55">
      <span data-testid="prompt-takes-target" class="max-w-[40%] shrink-0 truncate rounded-full bg-white/[0.08] px-2.5 py-0.5 text-white/80">{{ session.nodeLabel }}</span>
      <span class="min-w-0 truncate"><span class="text-white/85">{{ title }}</span> · {{ status }}<template v-if="readyCount(session)"> · <span data-testid="prompt-takes-hint" class="text-white/40">{{ hint }}</span></template></span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button" :disabled="working || session.loopDone === false"
          class="rounded-md border border-[#2a2a2a] bg-[#1e1f23] px-2.5 py-0.5 text-white/75 transition hover:text-white disabled:opacity-40"
          @click="emit('more')"
        >Three more<template v-if="moreNote"> · <span data-testid="prompt-takes-more-note" class="tabular-nums">{{ moreNote }}</span></template></button>
        <button
          type="button" aria-label="Close takes"
          class="grid size-6 place-items-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white/85"
          @click="emit('close')"
        ><X class="size-3.5" /></button>
      </span>
    </div>
    <p v-if="error" data-testid="prompt-takes-error" role="alert" class="px-1 text-[12px] leading-snug text-red-400/90">{{ error }}</p>

    <div class="grid grid-cols-4 gap-2">
      <button
        type="button" data-testid="prompt-take-current" class="tile" :class="{ 'is-chosen': currentMarked }"
        @mouseenter="emit('hover', CURRENT)" @focus="emit('hover', CURRENT)" @click="pick(CURRENT, $event)"
      >
        <img v-if="session.currentThumb" :src="session.currentThumb" alt="" class="thumb">
        <span v-else class="thumb block bg-white/[0.04]" />
        <span class="label">Current</span>
      </button>

      <div
        v-for="(t, i) in session.tiles" :key="i"
        data-testid="prompt-take-tile" :data-state="t.state"
        class="tile" :class="{ 'is-chosen': isMarked(t.takeId) }"
      >
        <template v-if="t.state === 'ready' && t.takeId">
          <button
            type="button" class="block w-full text-left" :aria-disabled="saving || undefined"
            @mouseenter="emit('hover', t.takeId)" @focus="emit('hover', t.takeId)" @click="pick(t.takeId, $event)"
          >
            <img :src="t.thumb ?? ''" alt="" class="thumb">
            <span class="label">Take {{ i + 1 }}</span>
          </button>
        </template>
        <template v-else-if="t.state === 'pending'">
          <span class="thumb block animate-pulse bg-white/[0.06]" />
          <span class="label text-white/35">Working…</span>
        </template>
        <template v-else>
          <span class="thumb grid place-items-center bg-white/[0.03] px-1 text-center text-[11px] text-white/40">{{ failedTileText(t.reason) }}</span>
          <span class="label text-white/35">Take {{ i + 1 }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tile { display: grid; gap: 4px; border: 1px solid transparent; border-radius: 8px; padding: 3px; text-align: left; transition: border-color 0.15s ease; }
.tile:hover, .tile:focus-within { border-color: rgba(255, 255, 255, 0.35); }
.tile.is-chosen { border-color: rgba(255, 255, 255, 0.6); }
/* width 0 + min-width 100%: a thumbnail's own pixel size never widens the strip (a host whose
   width comes from its content, like Frame's dock, would otherwise grow past its panels). */
.thumb { display: block; width: 0; min-width: 100%; aspect-ratio: 16 / 10; border-radius: 6px; object-fit: cover; }
.label { padding-inline: 2px; font-size: 11.5px; color: rgba(255, 255, 255, 0.7); }
[aria-disabled="true"] { cursor: progress; }
</style>
