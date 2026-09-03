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
 *    a pure pass-through of that). ALSO forwarded from a `MoveCard`'s own
 *    `patch-cfg` — a card body whose kind has no config of its own on the
 *    move (Vector Type's Blink/Scatter, per `~/lib/studio/moves/adapter
 *    .ts`'s `noTiming` doc) edits `cfg` directly the same way, and this
 *    panel relays it unchanged rather than trying to interpret it.
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
 *  - `replace-move(oldMove: Move, newMove: Move)` — a card's "Change"
 *    button, resolved entirely within this panel (see `changingMove`
 *    below): reopens the gallery pre-selected to the move's own phase,
 *    and on the next pick emits this instead of `add-move`, carrying the
 *    OLD move (identity: `id`, plus `duration`/`ease`/`play` when the pick
 *    is the same phase — see `changingMove`'s doc) and the freshly-built
 *    NEW move (`kind`/`presetId`/`tracks`/`params`). The parent's job is
 *    just to splice `clip.moves` at `oldMove.id`, keeping that id.
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
  (e: 'replace-move', oldMove: Move, newMove: Move): void
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

// ── Add move gallery / Change-in-place ─────────────────────────────────────
/**
 * `changingMove`: the move a card's "Change" button asked to replace, or
 * null for a plain Add. Both flows share the one `MoveGallery` instance
 * below — `onChange` opens it pre-selected to the move's own phase
 * (`MoveGallery`'s `initialPhase` prop); `onGalleryAdd` then either appends
 * a brand-new move (`changingMove` null) or, when it's set, resolves the
 * swap itself and emits `replace-move` instead of `add-move` — see that
 * function's own doc for the merge policy. Closing the gallery without a
 * pick (`onGalleryClose`, from `MoveGallery`'s `close`) just clears
 * `changingMove`, leaving the move being replaced untouched.
 */
const changingMove = ref<Move | null>(null)
const galleryOpen = ref(false)

function openAddGallery() {
  changingMove.value = null
  galleryOpen.value = true
}
function onChange(move: Move) {
  changingMove.value = move
  galleryOpen.value = true
}

/**
 * A tile/dial picked in the gallery. Plain Add: forward as `add-move`,
 * same as before. Change-in-place (`changingMove` set): swap the OLD
 * move's identity-carrying fields onto the NEW pick — keep the old
 * `id` always (so band strip / open-card tracking survive the swap), and
 * keep its `duration`/`ease`/`play` too UNLESS the new pick lands in a
 * different phase (an In/Loop/Out preset tile in a different tab than the
 * move being changed), in which case those no longer make sense against
 * the new phase's own window and the pick's own values win instead. Kind/
 * presetId/tracks/params always come from the new pick.
 */
function onGalleryAdd(picked: Move) {
  const old = changingMove.value
  if (old) {
    const samePhase = picked.phase === old.phase
    const merged: Move = {
      ...picked,
      id: old.id,
      duration: samePhase ? old.duration : picked.duration,
      ease: samePhase ? old.ease : picked.ease,
      play: samePhase ? old.play : picked.play,
    }
    emit('replace-move', old, merged)
    emit('set-open', old.id)
    changingMove.value = null
    galleryOpen.value = false
    return
  }
  emit('add-move', picked)
  emit('set-open', picked.id)
  galleryOpen.value = false
}
function onGalleryClose() {
  changingMove.value = null
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
            @click.stop="openAddGallery()"
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
          @patch-cfg="(p: Record<string, unknown>) => emit('patch-cfg', p)"
          @remove="onRemove(move)"
          @change="onChange(move)"
        />
      </div>

      <MoveBandStrip :moves="clip.moves" :clip="clip.duration" />
    </StudioSection>

    <MoveGallery
      v-if="galleryOpen" :adapter="adapter" :cfg="cfg" :initial-phase="changingMove?.phase"
      @add="onGalleryAdd" @close="onGalleryClose"
    >
      <template v-if="$slots.thumb" #thumb="slotProps"><slot name="thumb" v-bind="slotProps" /></template>
    </MoveGallery>
  </div>
</template>
