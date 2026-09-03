<script setup lang="ts">
/**
 * One move's card: a ~28px collapsed row (label, phase tag, ease glyph,
 * delete-on-hover) that expands into Length / Ease / Play / the move's own
 * dials. Driven entirely by the `adapter`/`cfg` props — the ONLY per-kind
 * branch this file hardcodes is `'tracks'`, the universal kind every studio
 * gets for free (`~/lib/studio/moves/adapter.ts`'s `MoveKindDef` doc); any
 * other kind's dials come from `adapter.kinds[move.kind].cardBody`, or, if
 * that is absent, a plain "no settings yet" line — a studio that hasn't
 * wired a card body for one of its kinds (Vector Type's `preset`/`blink`/
 * `scatter`, as of this file, per `movesAdapter.ts`'s own comment) still
 * gets a working card, just a plainer one.
 *
 * NOTHING here may import from `lib/vectortype`. Props are never mutated —
 * every change emits `patch` with a shallow-cloned partial and lets the
 * parent (ultimately the studio surface) own the write.
 */
import { computed, ref } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move, MovePlay, MoveTrack } from '~/lib/studio/moves/types'
import { EASE_LABELS, easeGlyphPath } from '~/lib/studio/moves/ease'
import { lastPathSegment, moveCardLabel } from './moveCardLabel'
import EasePicker from './EasePicker.vue'

const props = defineProps<{
  move: Move
  adapter: MovesAdapter<any>
  cfg: any
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'patch', partial: Partial<Move>): void
  (e: 'remove'): void
  (e: 'change'): void
  (e: 'toggle'): void
}>()

// ── Collapsed row ────────────────────────────────────────────────────────

const label = computed(() => moveCardLabel(props.move, props.adapter))

const PHASE_TAG: Record<Move['phase'], string> = { in: 'In', loop: 'Loop', out: 'Out' }
const PHASE_TAG_CLASS: Record<Move['phase'], string> = {
  in: 'text-amber-300/90 bg-amber-400/15',
  out: 'text-amber-300/90 bg-amber-400/15',
  loop: 'text-emerald-300/90 bg-emerald-400/15',
}

const collapsedGlyph = computed(() => easeGlyphPath(props.move.ease, 24, 12))

// ── Ease ─────────────────────────────────────────────────────────────────

const easeOpen = ref(false)
const easeLabel = computed(() => props.move.ease.kind === 'bezier' ? 'Custom' : EASE_LABELS[props.move.ease.name])
const easeRowGlyph = computed(() => easeGlyphPath(props.move.ease, 40, 16))

// ── Play (hidden on in/out — only a loop actually repeats) ────────────────

const PLAY_MODE_LABEL: Record<MovePlay['mode'], string> = { once: 'Once', backAndForth: 'Back and forth', repeat: 'Repeat' }
const PLAY_MODES: readonly MovePlay['mode'][] = ['once', 'backAndForth', 'repeat']

function setPlayMode(mode: MovePlay['mode']) {
  emit('patch', { play: { mode, times: props.move.play.times } })
}
function setPlayTimes(raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  emit('patch', { play: { mode: props.move.play.mode, times: Math.max(1, Math.min(20, Math.round(n))) } })
}

// ── Length ───────────────────────────────────────────────────────────────

function setDuration(raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  emit('patch', { duration: Math.max(0.05, Math.min(60, n)) })
}

// ── Dials: adapter cardBody, or the 'tracks' fallback, or nothing ─────────

const cardBody = computed(() => props.adapter.kinds[props.move.kind]?.cardBody)

/** `path -> label` from `adapter.animatable(cfg)`, for naming a track's dial
 *  in the fallback editor — falls back to the path's own last segment for a
 *  dial the adapter doesn't (or no longer) declare. */
const dialLabels = computed(() => {
  const map = new Map<string, string>()
  for (const group of props.adapter.animatable(props.cfg)) {
    for (const dial of group.dials) map.set(dial.path, dial.label)
  }
  return map
})
function trackLabel(track: MoveTrack): string {
  return dialLabels.value.get(track.path) ?? lastPathSegment(track.path)
}
function isColorTrack(track: MoveTrack): boolean {
  return typeof track.fromColor === 'string' && typeof track.toColor === 'string'
}

function patchTrackNumber(index: number, field: 'from' | 'to', raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  const tracks = (props.move.tracks ?? []).map((t, i) => (i === index ? { ...t, [field]: n } : t))
  emit('patch', { tracks })
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.03]">
    <div
      class="group flex h-7 cursor-pointer select-none items-center gap-2 px-2.5 transition-colors hover:bg-white/[0.04]"
      @click="emit('toggle')"
    >
      <span class="min-w-0 flex-1 truncate text-[11px] text-white/80">{{ label }}</span>
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em]" :class="PHASE_TAG_CLASS[move.phase]">
        {{ PHASE_TAG[move.phase] }}
      </span>
      <svg viewBox="0 0 24 12" class="h-3 w-6 shrink-0">
        <path :d="collapsedGlyph" fill="none" stroke-width="1.5" class="stroke-white/40" />
      </svg>
      <button
        type="button"
        class="shrink-0 rounded p-1 text-white/0 transition-colors group-hover:text-white/45 hover:!text-red-400"
        title="Remove move"
        @click.stop="emit('remove')"
      >
        <Trash2 class="size-3" />
      </button>
    </div>

    <div v-if="open" class="space-y-2.5 border-t border-white/[0.07] px-2.5 py-2.5" @click.stop>
      <!-- Length -->
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-white/60">Length</span>
        <span class="flex items-center gap-1">
          <input
            type="number" min="0.05" max="60" step="0.05"
            class="w-16 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-right text-[11px] text-white/85 outline-none focus:border-white/30"
            :value="move.duration"
            @change="setDuration(($event.target as HTMLInputElement).value)"
          />
          <span class="text-[10px] text-white/35">s</span>
        </span>
      </div>

      <!-- Ease -->
      <div class="flex flex-col gap-1.5">
        <button
          type="button"
          class="flex items-center justify-between gap-2 rounded border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-left transition-colors hover:bg-white/[0.05]"
          @click="easeOpen = !easeOpen"
        >
          <span class="text-[11px] text-white/60">Ease</span>
          <span class="flex items-center gap-1.5">
            <svg viewBox="0 0 40 16" class="h-3.5 w-9">
              <path :d="easeRowGlyph" fill="none" stroke-width="1.5" class="stroke-white/55" />
            </svg>
            <span class="text-[11px] text-white/75">{{ easeLabel }}</span>
          </span>
        </button>
        <EasePicker v-if="easeOpen" :model-value="move.ease" @update:model-value="(v) => emit('patch', { ease: v })" />
      </div>

      <!-- Play (loop only — in/out play exactly once through their own window) -->
      <div v-if="move.phase === 'loop'" class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-white/60">Play</span>
        <span class="flex items-center gap-1">
          <span class="flex overflow-hidden rounded border border-white/10">
            <button
              v-for="mode in PLAY_MODES" :key="mode" type="button"
              class="px-1.5 py-0.5 text-[10px] transition-colors"
              :class="move.play.mode === mode ? 'bg-white/[0.12] text-white' : 'text-white/45 hover:text-white/75'"
              :title="PLAY_MODE_LABEL[mode]"
              @click="setPlayMode(mode)"
            >{{ mode === 'once' ? '1×' : mode === 'backAndForth' ? '↔' : '↻' }}</button>
          </span>
          <input
            v-if="move.play.mode === 'repeat'"
            type="number" min="1" max="20" step="1"
            class="w-11 rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 text-right text-[11px] text-white/85 outline-none focus:border-white/30"
            :value="move.play.times"
            @change="setPlayTimes(($event.target as HTMLInputElement).value)"
          />
        </span>
      </div>

      <!-- The move's own dials -->
      <div v-if="cardBody" class="border-t border-white/[0.06] pt-2.5">
        <component
          :is="cardBody"
          :move="move"
          :cfg="cfg"
          @patch="(p: Partial<Move>) => emit('patch', p)"
        />
      </div>
      <div v-else-if="move.kind === 'tracks'" class="flex flex-col gap-1.5 border-t border-white/[0.06] pt-2.5">
        <div v-for="(track, i) in move.tracks ?? []" :key="`${track.path}:${i}`" class="flex items-center justify-between gap-2">
          <span class="min-w-0 flex-1 truncate text-[11px] text-white/60">{{ trackLabel(track) }}</span>
          <template v-if="isColorTrack(track)">
            <span class="flex items-center gap-1">
              <span class="size-3.5 rounded-full border border-white/20" :style="{ background: track.fromColor }" />
              <span class="text-white/30">→</span>
              <span class="size-3.5 rounded-full border border-white/20" :style="{ background: track.toColor }" />
            </span>
          </template>
          <span v-else class="flex items-center gap-1">
            <input
              type="number" step="0.01"
              class="w-14 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-right text-[11px] text-white/85 outline-none focus:border-white/30"
              :value="track.from"
              @change="patchTrackNumber(i, 'from', ($event.target as HTMLInputElement).value)"
            />
            <span class="text-white/30">→</span>
            <input
              type="number" step="0.01"
              class="w-14 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-right text-[11px] text-white/85 outline-none focus:border-white/30"
              :value="track.to"
              @change="patchTrackNumber(i, 'to', ($event.target as HTMLInputElement).value)"
            />
          </span>
        </div>
        <button
          type="button"
          class="mt-0.5 self-start rounded border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-white/50 transition-colors hover:text-white/80"
          @click="emit('change')"
        >Change</button>
      </div>
      <div v-else class="border-t border-white/[0.06] pt-2.5 text-[11px] text-white/35">
        No settings for this move yet.
      </div>
    </div>
  </div>
</template>
