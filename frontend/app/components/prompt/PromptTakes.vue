<script setup lang="ts">
// The takes strip above the prompt (spec §3.1): the version it started from,
// then three tiles that fill in as takes arrive. Presentational: the host owns
// the session and previews on the work. Identical in every host (spec §2.1a).
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { CURRENT, isTakesWorking, takesStatus, type TakesSession } from '~/lib/prompt/takesSession'

// `saving`: a Keep is being saved (effect takes, stage 5) — Keep is off until it settles.
const props = withDefaults(defineProps<{ session: TakesSession; saving?: boolean }>(), { saving: false })
const emit = defineEmits<{ hover: [id: string | null]; choose: [id: string]; keep: [id: string]; more: []; close: [] }>()

const working = computed(() => isTakesWorking(props.session))
const status = computed(() => takesStatus(props.session))
const title = computed(() => (props.session.request ? `“${props.session.request}”` : 'Variations'))
const currentChosen = computed(() => !props.session.chosen || props.session.chosen === CURRENT)
// Tabbing out of the strip ends the preview, as leaving it with the mouse does.
function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (!to || !(e.currentTarget as HTMLElement).contains(to)) emit('hover', null)
}
</script>

<template>
  <div data-testid="prompt-takes" class="grid grid-cols-1 gap-2" @mouseleave="emit('hover', null)" @focusout="onFocusOut">
    <div class="flex items-center gap-2 px-1 text-[12px] text-white/55">
      <span data-testid="prompt-takes-target" class="max-w-[40%] shrink-0 truncate rounded-full bg-white/[0.08] px-2.5 py-0.5 text-white/80">{{ session.nodeLabel }}</span>
      <span class="min-w-0 truncate"><span class="text-white/85">{{ title }}</span> · {{ status }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button" :disabled="working || session.loopDone === false"
          class="rounded-md border border-[#2a2a2a] bg-[#1e1f23] px-2.5 py-0.5 text-white/75 transition hover:text-white disabled:opacity-40"
          @click="emit('more')"
        >Three more</button>
        <button
          type="button" aria-label="Close takes"
          class="grid size-6 place-items-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white/85"
          @click="emit('close')"
        ><X class="size-3.5" /></button>
      </span>
    </div>

    <div class="grid grid-cols-4 gap-2">
      <button
        type="button" data-testid="prompt-take-current" class="tile" :class="{ 'is-chosen': currentChosen }"
        @mouseenter="emit('hover', CURRENT)" @focus="emit('hover', CURRENT)" @click="emit('choose', CURRENT)"
      >
        <img v-if="session.currentThumb" :src="session.currentThumb" alt="" class="thumb">
        <span v-else class="thumb block bg-white/[0.04]" />
        <span class="label">Current</span>
      </button>

      <div
        v-for="(t, i) in session.tiles" :key="i"
        data-testid="prompt-take-tile" :data-state="t.state"
        class="tile group relative" :class="{ 'is-chosen': t.takeId && session.chosen === t.takeId }"
      >
        <template v-if="t.state === 'ready' && t.takeId">
          <button
            type="button" class="block w-full text-left" :aria-label="`Preview take ${i + 1}`"
            @mouseenter="emit('hover', t.takeId)" @focus="emit('hover', t.takeId)" @click="emit('choose', t.takeId)"
          >
            <img :src="t.thumb ?? ''" alt="" class="thumb">
            <span class="label">Take {{ i + 1 }}</span>
          </button>
          <button type="button" class="keep" :disabled="saving" @click="emit('keep', t.takeId)">Keep</button>
        </template>
        <template v-else-if="t.state === 'pending'">
          <span class="thumb block animate-pulse bg-white/[0.06]" />
          <span class="label text-white/35">Working…</span>
        </template>
        <template v-else>
          <span class="thumb grid place-items-center bg-white/[0.03] text-[11px] text-white/40">Didn’t come back</span>
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
.keep { position: absolute; top: 7px; right: 7px; display: none; border-radius: 5px; background: #fff; padding: 1px 8px; font-size: 11.5px; font-weight: 600; color: #171717; }
.tile:hover .keep, .tile:focus-within .keep, .tile.is-chosen .keep { display: block; }
.keep:disabled { opacity: 0.5; cursor: default; }
</style>
