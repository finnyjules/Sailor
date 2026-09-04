<script setup lang="ts">
/**
 * The right-inspector half of the Motion tab (`2026-09-04-motion-timeline-
 * design.md` §5 — amends the 2026-09-03 card-stack design). The timeline
 * itself (`MoveTimeline.vue`, Task 5) lives elsewhere, docked under the
 * preview and mounted by the surface (Task 7); this panel no longer renders
 * a band strip or a card list — it shows ONE thing at a time:
 *
 *  - a move is SELECTED (`selectedId` names an id in `clip.moves` or a
 *    studio's `adapter.derivedMoves?.(cfg)` marker): that move's own
 *    controls — name, Change, In/Out, Loop, Bounce, Length, ease, dials,
 *    Remove.
 *  - NOTHING is selected: the clip settings (Length, Frame rate, a studio's
 *    own `clipExtras`) and an Add-move entry point.
 *
 * Studio-agnostic by construction — driven entirely through the `adapter`/
 * `cfg` props, same as `MoveGallery.vue`. NOTHING here may import from
 * `lib/vectortype`. Props are never mutated — every edit is a granular
 * event; the parent (ultimately the surface) owns applying it and
 * re-passing the updated `clip`/`cfg`/`selectedId` back down.
 *
 * ── Event API (Task 7, the Vector Type surface, wires against this) ──────
 *
 *  - `patch-clip(partial: Partial<Pick<MotionClip,'duration'|'fps'>>)` —
 *    the Length slider / Frame rate select, nothing-selected view.
 *  - `patch-cfg(partial: Record<string, any>)` — forwarded verbatim from
 *    `adapter.clipExtras`'s own `patch` event, AND from a `noTiming` kind's
 *    card body (Vector Type's Blink/Scatter — see `~/lib/studio/moves
 *    /adapter.ts`'s `noTiming` doc — which edits `cfg` directly since
 *    neither marker has real config on the move itself). This panel never
 *    inspects or produces one itself, only relays what the card body/
 *    `clipExtras` emits.
 *  - `patch-move(move: Move, partial: Partial<Move>)` — every edit to the
 *    SELECTED move: In/Out (`{ presetId }`), Loop (`{ loop }`), Bounce
 *    (`{ bounce }`), Length (`{ duration }`), ease (`{ ease }`), a card
 *    body's own `patch` (kind params), or the `'tracks'` fallback editor's
 *    `{ tracks }`. Carries the FULL move, not just an id, so the parent can
 *    tell a stored move (patch `clip.moves`) from a derived one (Vector
 *    Type: `move.kind === 'blink' | 'scatter'` with no entry in
 *    `clip.moves` — the surface translates that into `cfg.motion.blink`/
 *    `.scatter` writes instead, same reasoning as `remove-move` below).
 *  - `remove-move(move: Move)` — the ✕ on the selected move. The FULL move
 *    again, for the same stored-vs-derived reason: a derived marker has no
 *    `clip.moves` entry to splice, so the surface decides (Vector Type:
 *    zero `cfg.motion.blink.amount`/`.scatter.spread`) rather than this
 *    panel guessing at a shape it cannot know.
 *  - `open-gallery()` — the Add-move button (nothing selected) AND the
 *    selected move's Change button. No payload: the surface already holds
 *    `selectedId` (it's the prop driving this panel), so it alone decides
 *    whether opening the gallery means "add a new move" or "swap this
 *    move's preset" — a same-move swap needs only `patch-move` with the
 *    freshly-picked `kind`/`presetId`/`tracks`/`params`, since `id`/`at`/
 *    `duration`/`ease`/`loop`/`bounce` are untouched by a partial patch.
 *    This panel does not mount `MoveGallery` itself (a pick needs the
 *    surface's own playhead to anchor a fresh transition's `at` — see
 *    `MoveGallery.vue`'s header — which this panel's props don't carry).
 *  - `add-move(move: Move)` — declared for interface completeness with
 *    `~/lib/studio/moves/adapter.ts`'s sibling components, but NOT fired by
 *    this implementation: since this panel never mounts `MoveGallery` (the
 *    previous bullet), there is no local pick to forward. Reserved for a
 *    future variant that nests the gallery here instead of in the surface.
 */
import { computed } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move, MotionClip, MoveTrack } from '~/lib/studio/moves/types'
import { EASE_LABELS, easeGlyphPath } from '~/lib/studio/moves/ease'
import { lastPathSegment, moveCardLabel } from './moveCardLabel'
import EasePicker from './EasePicker.vue'

const props = defineProps<{
  clip: MotionClip
  adapter: MovesAdapter<any>
  cfg: any
  selectedId: string | null
}>()

const emit = defineEmits<{
  (e: 'patch-clip', partial: Partial<Pick<MotionClip, 'duration' | 'fps'>>): void
  (e: 'patch-cfg', partial: Record<string, any>): void
  (e: 'add-move', move: Move): void
  (e: 'remove-move', move: Move): void
  (e: 'patch-move', move: Move, partial: Partial<Move>): void
  (e: 'open-gallery'): void
}>()

// ── Selected move: stored or derived ────────────────────────────────────

const allMoves = computed<Move[]>(() => [
  ...props.clip.moves,
  ...(props.adapter.derivedMoves?.(props.cfg) ?? []),
])
const selectedMove = computed<Move | null>(() =>
  allMoves.value.find((m) => m.id === props.selectedId) ?? null,
)

function patch(partial: Partial<Move>) {
  if (!selectedMove.value) return
  emit('patch-move', selectedMove.value, partial)
}

const label = computed(() => (selectedMove.value ? moveCardLabel(selectedMove.value, props.adapter) : ''))

/** No ease/loop/bounce/length for this kind (Blink, Scatter) — `~/lib/studio
 *  /moves/adapter.ts`'s `noTiming` doc. */
const noTiming = computed(() => !!selectedMove.value && props.adapter.kinds[selectedMove.value.kind]?.noTiming === true)

// ── In / Out ─────────────────────────────────────────────────────────────

const direction = computed<'in' | 'out' | null>(() => {
  const move = selectedMove.value
  if (!move?.presetId || !props.adapter.direction) return null
  return props.adapter.direction(move.presetId)
})
function toggleDirection() {
  const move = selectedMove.value
  if (!move?.presetId || !direction.value || !props.adapter.flip) return
  patch({ presetId: props.adapter.flip(move.presetId) })
}

// ── Loop / Bounce ────────────────────────────────────────────────────────

function setLoop(v: boolean) { patch({ loop: v }) }
function setBounce(v: boolean) { patch({ bounce: v }) }

// ── Length ───────────────────────────────────────────────────────────────

function setMoveDuration(raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  patch({ duration: Math.max(0.05, Math.min(60, n)) })
}

// ── Ease ─────────────────────────────────────────────────────────────────

const easeLabel = computed(() => {
  const move = selectedMove.value
  if (!move) return ''
  return move.ease.kind === 'bezier' ? 'Custom' : EASE_LABELS[move.ease.name]
})
const easeRowGlyph = computed(() => (selectedMove.value ? easeGlyphPath(selectedMove.value.ease, 40, 16) : ''))

// ── Dials: adapter cardBody, or the 'tracks' fallback, or nothing ─────────

const cardBody = computed(() => selectedMove.value ? props.adapter.kinds[selectedMove.value.kind]?.cardBody : undefined)

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
  const move = selectedMove.value
  if (!move) return
  const tracks = (move.tracks ?? []).map((t, i) => (i === index ? { ...t, [field]: n } : t))
  patch({ tracks })
}

// ── Clip block (nothing selected) ───────────────────────────────────────

const FPS_OPTIONS = [24, 30, 60] as const

function setClipDuration(raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  emit('patch-clip', { duration: Math.max(0.5, Math.min(30, n)) })
}
function setClipFps(raw: string) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  emit('patch-clip', { fps: n })
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Selected move's own controls -->
    <StudioSection v-if="selectedMove" title="Move">
      <div class="flex items-center justify-between gap-2">
        <span class="min-w-0 flex-1 truncate text-[11px] text-white/80">{{ label }}</span>
        <span class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="rounded border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-white/50 transition-colors hover:text-white/85"
            @click="emit('open-gallery')"
          >Change</button>
          <button
            type="button"
            class="rounded p-1 text-white/40 transition-colors hover:!text-red-400"
            title="Remove move"
            @click="emit('remove-move', selectedMove)"
          ><Trash2 class="size-3.5" /></button>
        </span>
      </div>

      <!-- In / Out (hidden when the preset has no pair) -->
      <div v-if="direction" class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-white/60">Direction</span>
        <span class="flex overflow-hidden rounded border border-white/10">
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] transition-colors"
            :class="direction === 'in' ? 'bg-white/[0.12] text-white' : 'text-white/45 hover:text-white/75'"
            @click="direction !== 'in' && toggleDirection()"
          >In</button>
          <button
            type="button"
            class="px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] transition-colors"
            :class="direction === 'out' ? 'bg-white/[0.12] text-white' : 'text-white/45 hover:text-white/75'"
            @click="direction !== 'out' && toggleDirection()"
          >Out</button>
        </span>
      </div>

      <template v-if="!noTiming">
        <!-- Loop -->
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-white/60">Loop</span>
          <button
            type="button" role="switch" :aria-checked="!!selectedMove.loop"
            class="relative h-4 w-7 shrink-0 rounded-full transition-colors"
            :class="selectedMove.loop ? 'bg-white/70' : 'bg-white/[0.12]'"
            @click="setLoop(!selectedMove.loop)"
          >
            <span class="absolute top-0.5 h-3 w-3 rounded-full bg-[#141416] transition-transform" :class="selectedMove.loop ? 'translate-x-3.5' : 'translate-x-0.5'" />
          </button>
        </div>

        <!-- Bounce -->
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-white/60">Bounce</span>
          <button
            type="button" role="switch" :aria-checked="!!selectedMove.bounce"
            class="relative h-4 w-7 shrink-0 rounded-full transition-colors"
            :class="selectedMove.bounce ? 'bg-white/70' : 'bg-white/[0.12]'"
            @click="setBounce(!selectedMove.bounce)"
          >
            <span class="absolute top-0.5 h-3 w-3 rounded-full bg-[#141416] transition-transform" :class="selectedMove.bounce ? 'translate-x-3.5' : 'translate-x-0.5'" />
          </button>
        </div>

        <!-- Length -->
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-white/60">Length</span>
          <span class="flex items-center gap-1">
            <input
              type="number" min="0.05" max="60" step="0.05"
              class="w-16 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-right text-[11px] text-white/85 outline-none focus:border-white/30"
              :value="selectedMove.duration"
              @change="setMoveDuration(($event.target as HTMLInputElement).value)"
            />
            <span class="text-[10px] text-white/35">s</span>
          </span>
        </div>

        <!-- Ease -->
        <div class="flex flex-col gap-1.5">
          <span class="text-[11px] text-white/60">Ease</span>
          <span class="flex items-center gap-1.5">
            <svg viewBox="0 0 40 16" class="h-3.5 w-9 shrink-0">
              <path :d="easeRowGlyph" fill="none" stroke-width="1.5" class="stroke-white/55" />
            </svg>
            <span class="text-[11px] text-white/75">{{ easeLabel }}</span>
          </span>
          <EasePicker :model-value="selectedMove.ease" @update:model-value="(v) => patch({ ease: v })" />
        </div>
      </template>

      <!-- The move's own dials -->
      <div v-if="cardBody" class="border-t border-white/[0.06] pt-2.5">
        <component
          :is="cardBody"
          :move="selectedMove"
          :cfg="cfg"
          @patch="(p: Partial<Move>) => patch(p)"
          @patch-cfg="(p: Record<string, unknown>) => emit('patch-cfg', p)"
        />
      </div>
      <div v-else-if="selectedMove.kind === 'tracks'" class="flex flex-col gap-1.5 border-t border-white/[0.06] pt-2.5">
        <div v-for="(track, i) in selectedMove.tracks ?? []" :key="`${track.path}:${i}`" class="flex items-center justify-between gap-2">
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
      </div>
      <div v-else class="border-t border-white/[0.06] pt-2.5 text-[11px] text-white/35">
        No settings for this move yet.
      </div>
    </StudioSection>

    <!-- Nothing selected: clip settings -->
    <template v-else>
      <StudioSection title="Clip">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-white/60">Length</span>
          <span class="flex items-center gap-2">
            <input
              type="range" min="0.5" max="30" step="0.1"
              class="w-28 accent-white/70"
              :value="clip.duration"
              @input="setClipDuration(($event.target as HTMLInputElement).value)"
            />
            <span class="w-10 text-right text-[11px] text-white/75">{{ clip.duration.toFixed(1) }}s</span>
          </span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-white/60">Frame rate</span>
          <select
            class="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-white/85 outline-none focus:border-white/30"
            :value="clip.fps"
            @change="setClipFps(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="fps in FPS_OPTIONS" :key="fps" :value="fps">{{ fps }} fps</option>
          </select>
        </div>
        <component
          :is="adapter.clipExtras" v-if="adapter.clipExtras" :cfg="cfg"
          @patch="(p: Record<string, any>) => emit('patch-cfg', p)"
        />
      </StudioSection>

      <button
        type="button"
        class="flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] py-2 text-[11px] text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/90"
        @click="emit('open-gallery')"
      ><Plus class="h-3.5 w-3.5" /> Add move</button>
    </template>
  </div>
</template>
