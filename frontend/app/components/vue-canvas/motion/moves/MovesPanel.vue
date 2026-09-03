<script setup lang="ts">
/**
 * The whole Motion tab body: the Clip block (length, frame rate, a studio's
 * own `clipExtras`), the move list (stored + a studio's derived markers —
 * see `~/lib/studio/moves/adapter.ts`'s `derivedMoves` doc), Add move, and
 * the band strip.
 *
 * Studio-agnostic by construction — driven entirely through the `adapter`/
 * `cfg` props, same as `MoveGallery.vue`. NOTHING here may import from
 * `lib/vectortype`.
 *
 * ── Event API (Task 9, the Vector Type surface, wires against this) ───────
 *
 * This component NEVER mutates `clip`/`cfg` and holds no config state of its
 * own beyond `galleryOpen` (transient UI). Every edit is a granular event;
 * the parent owns applying it and re-passing the updated `clip`/`cfg`/
 * `openMoveId` back down:
 *
 *  - `patch-clip(partial: Partial<Pick<MotionClip,'duration'|'fps'>>)` —
 *    the Length slider / Frame rate select.
 *  - `patch-cfg(partial: Record<string, any>)` — forwarded verbatim from
 *    `adapter.clipExtras`'s own `patch` event (Vector Type's Letter-by-
 *    letter reads/writes `cfg.motion.stagger`, which is not on `MotionClip`
 *    at all — this panel cannot know that shape, so `clipExtras` emits
 *    `patch` the same way a `MoveKindDef.cardBody` does, and this event is
 *    a pure pass-through of that).
 *  - `add-move(move: Move)` — a tile picked in `MoveGallery` (which already
 *    minted the move's `id`); append it to `clip.moves`.
 *  - `remove-move(move: Move)` — the FULL move, not just an id: a derived
 *    marker (Blink/Scatter) has no entry in `clip.moves` to look an id up
 *    against, so the parent needs `move.kind`/`move.id` to decide whether
 *    this is a real removal (splice `clip.moves`) or a derived one (Vector
 *    Type: set `cfg.motion.blink.amount`/`cfg.motion.scatter.spread` to 0 —
 *    see the adapter doc).
 *  - `patch-move(move: Move, partial: Partial<Move>)` — same reasoning:
 *    the full move plus the partial, so the parent can tell a stored move
 *    (patch `clip.moves`) from a derived one (Vector Type: no-op today —
 *    Blink/Scatter's evaluators never read a Move's own fields, only
 *    `cfg.motion.blink`/`.scatter` directly) without re-deriving anything.
 *  - `change-move(move: Move)` — a card's "Change" button (re-point a
 *    `'tracks'` move at a different dial). This panel has no gallery mode
 *    for "replace this move's dial", so it only forwards the request; the
 *    parent decides what "change" means (e.g. open the gallery's Custom
 *    tab and swap the move's `tracks` on pick).
 *  - `set-open(id: string | null)` — a card's collapsed row was clicked, or
 *    the gallery just added a move that should open. Only one card is open
 *    at a time: this component computes the next id (toggling the clicked
 *    one closed, or opening a freshly-added one) and asks the parent to
 *    hold it — `openMoveId` is a controlled prop, not local state, so the
 *    parent's own layout (e.g. scrolling the opened card into view) stays
 *    in sync for free.
 *
 * `#thumb` is a passthrough scoped slot straight to the inner `MoveGallery`
 * (same scope: `{ offer: MoveOffer }`), so a studio can supply its own tile
 * thumbnails (Vector Type: preset preview renders) without this panel
 * knowing what they are.
 */
import { computed, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move, MotionClip } from '~/lib/studio/moves/types'
import MoveCard from './MoveCard.vue'
import MoveGallery from './MoveGallery.vue'
import MoveBandStrip from './MoveBandStrip.vue'

const props = defineProps<{
  clip: MotionClip
  adapter: MovesAdapter<any>
  cfg: any
  openMoveId: string | null
}>()

const emit = defineEmits<{
  (e: 'patch-clip', partial: Partial<Pick<MotionClip, 'duration' | 'fps'>>): void
  (e: 'patch-cfg', partial: Record<string, any>): void
  (e: 'add-move', move: Move): void
  (e: 'remove-move', move: Move): void
  (e: 'patch-move', move: Move, partial: Partial<Move>): void
  (e: 'change-move', move: Move): void
  (e: 'set-open', id: string | null): void
}>()

// ── Clip block ───────────────────────────────────────────────────────────

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

// ── Move list: stored + derived (adapter.ts's `derivedMoves` doc) ─────────

const moveCards = computed<Move[]>(() => [
  ...props.clip.moves,
  ...(props.adapter.derivedMoves?.(props.cfg) ?? []),
])

function onToggle(move: Move) {
  emit('set-open', props.openMoveId === move.id ? null : move.id)
}
function onPatch(move: Move, partial: Partial<Move>) {
  emit('patch-move', move, partial)
}
function onRemove(move: Move) {
  emit('remove-move', move)
}
function onChange(move: Move) {
  emit('change-move', move)
}

// ── Add move gallery ─────────────────────────────────────────────────────

const galleryOpen = ref(false)
function onAdd(move: Move) {
  emit('add-move', move)
  emit('set-open', move.id)
  galleryOpen.value = false
}
</script>

<template>
  <div class="flex flex-col gap-3">
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

    <StudioSection title="Moves">
      <template #badge>
        <span class="flex items-center gap-2">
          <span v-if="moveCards.length" class="text-[10px] uppercase tracking-wide text-white/30">{{ moveCards.length }}</span>
          <button
            type="button"
            class="flex items-center gap-1 normal-case text-white/40 hover:text-white"
            @click.stop="galleryOpen = true"
          ><Plus class="h-3 w-3" /> Add move</button>
        </span>
      </template>

      <div v-if="!moveCards.length" class="py-4 text-center text-[11px] text-white/35">
        Nothing moves yet.
      </div>
      <div v-else class="flex flex-col gap-1.5">
        <MoveCard
          v-for="move in moveCards" :key="move.id"
          :move="move" :adapter="adapter" :cfg="cfg" :open="move.id === openMoveId"
          @toggle="onToggle(move)"
          @patch="(p: Partial<Move>) => onPatch(move, p)"
          @remove="onRemove(move)"
          @change="onChange(move)"
        />
      </div>

      <MoveBandStrip :moves="clip.moves" :clip="clip.duration" />
    </StudioSection>

    <MoveGallery v-if="galleryOpen" :adapter="adapter" :cfg="cfg" @add="onAdd" @close="galleryOpen = false">
      <template v-if="$slots.thumb" #thumb="slotProps"><slot name="thumb" v-bind="slotProps" /></template>
    </MoveGallery>
  </div>
</template>
