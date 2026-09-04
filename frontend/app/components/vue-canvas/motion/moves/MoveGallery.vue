<script setup lang="ts">
/**
 * Add-move gallery: ONE scrollable, grouped list — no more In/Loop/Out
 * tabs (`2026-09-04-motion-timeline-design.md` §5: "the gallery loses the
 * In/Out/Loop tabs — it now lists moves by type in one grouped list"). The
 * panel is driven ENTIRELY through the `adapter` prop (`MovesAdapter<Cfg>`,
 * `~/lib/studio/moves/adapter.ts`) — `adapter.gallery(cfg)`'s groups render
 * first (Letterform / Appear / Slide / Scale / Blur / Rotate / Physics /
 * Text / Loop-style / Effects, per that adapter's own grouping), followed
 * by a "Custom" section built from `adapter.animatable(cfg)`'s dial groups
 * (unchanged from before — this file still owns turning a `DialDef` into a
 * one-shot `Move` candidate; the adapter only supplies the raw dials).
 * Every tile's grey/enabled state comes from `adapter.availability(cfg,
 * candidate)`. A studio's own visuals reach a tile only two ways: the
 * `#thumb` scoped slot (preferred — lets a studio-specific renderer draw
 * the tile without this component knowing what it is) or, if the caller
 * doesn't fill that slot, the `MoveOffer.thumb` component the adapter
 * itself supplied.
 *
 * Anchored/Teleported like `MotionPresetPicker.vue` (see its header) —
 * `close()` on backdrop click or Escape.
 *
 * NOTHING here may import from `lib/vectortype`; studio specifics arrive
 * ONLY through `adapter`/`cfg` and the `#thumb` slot.
 *
 * A picked tile emits `add(move)` with a full, `id`-less-no-more (this
 * component mints a fresh `id`) `Move` — an `at`/`loop`-anchored placement
 * a gallery offer's own `build()` already chose (Vector Type: `placementFor`
 * in `movesAdapter.ts`), or, for a Custom dial pick, `at: 0, loop: true` (an
 * open-ended cycle — the sensible default for "animate this property
 * continuously" absent a playhead to anchor a one-shot transition to; the
 * mounting surface is free to re-anchor `at` to its own playhead before
 * applying the patch, same as any other `patch-move`).
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { X } from 'lucide-vue-next'
import type { MovesAdapter, MoveOffer, DialDef } from '~/lib/studio/moves/adapter'
import type { Move } from '~/lib/studio/moves/types'
import { DEFAULT_EASE } from '~/lib/studio/moves/ease'

const props = defineProps<{ adapter: MovesAdapter<any>; cfg: any }>()
const emit = defineEmits<{ (e: 'add', move: Move): void; (e: 'close'): void }>()

function freshId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return `move_${c?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

// ── Grouped list: adapter.gallery(cfg) ──────────────────────────────────

/** `offer.build()` already returns a complete-enough `Partial<Move>` (every
 *  adapter in this codebase fills kind/presetId/at/duration/loop/ease) —
 *  these fallbacks are a defensive floor for an adapter that leaves one out,
 *  not the expected path. `id` is a placeholder used only to test
 *  availability; `add(...)` mints the real one. */
function candidateFromOffer(offer: MoveOffer): Move {
  const built = offer.build()
  return {
    id: '__candidate__',
    kind: built.kind ?? offer.kind,
    presetId: built.presetId ?? offer.presetId,
    at: typeof built.at === 'number' ? built.at : 0,
    duration: typeof built.duration === 'number' ? built.duration : 1,
    loop: typeof built.loop === 'boolean' ? built.loop : false,
    bounce: built.bounce,
    ease: built.ease ?? DEFAULT_EASE,
    params: built.params,
    tracks: built.tracks,
  }
}

interface ResolvedOffer { offer: MoveOffer; candidate: Move; reason: string | null }
interface ResolvedGroup { label: string; offers: ResolvedOffer[] }

const presetGroups = computed<ResolvedGroup[]>(() =>
  props.adapter.gallery(props.cfg).map((g) => ({
    label: g.label,
    offers: g.offers.map((offer) => {
      const candidate = candidateFromOffer(offer)
      return { offer, candidate, reason: props.adapter.availability(props.cfg, candidate) }
    }),
  })),
)

function pick(resolved: ResolvedOffer) {
  if (resolved.reason) return
  emit('add', { ...resolved.candidate, id: freshId() })
}

// ── Custom section: adapter.animatable(cfg) dials ──────────────────────

// `cfg.motion.duration` is the shared clip-length convention (`MotionClip`,
// `~/lib/studio/moves/types`) every studio's config carries its moves under
// — duck-typed defensively here since `cfg` is intentionally untyped at this
// boundary, with the same `4` fallback the Vector Type adapter uses for a
// config that doesn't have one yet.
const clipDuration = computed(() => {
  const d = (props.cfg as any)?.motion?.duration
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 4
})

function dialCandidate(dial: DialDef): Move {
  return {
    id: '__candidate__',
    kind: 'tracks',
    presetId: 'custom',
    at: 0,
    duration: clipDuration.value,
    loop: true,
    ease: DEFAULT_EASE,
    tracks: [{ path: dial.path, from: dial.min, to: dial.max, hold: 0, cycleOffset: 0, delay: 0 }],
  }
}

interface ResolvedDial { dial: DialDef; candidate: Move; reason: string | null }
interface ResolvedDialGroup { label: string; dials: ResolvedDial[] }

const customGroups = computed<ResolvedDialGroup[]>(() =>
  props.adapter.animatable(props.cfg).map((g) => ({
    label: g.label,
    dials: g.dials.map((dial) => {
      const candidate = dialCandidate(dial)
      return { dial, candidate, reason: props.adapter.availability(props.cfg, candidate) }
    }),
  })),
)

function pickDial(resolved: ResolvedDial) {
  if (resolved.reason) return
  emit('add', { ...resolved.candidate, id: freshId() })
}

// ── Chrome ───────────────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- ONE root, pointer-events-none, with every interactive child opting
         back in — same reasoning as MotionPresetPicker.vue's header: this is
         teleported over the node canvas and must not eat wire drags. -->
    <div class="fixed inset-0 z-[110] pointer-events-none">
      <div class="absolute inset-0 pointer-events-auto" @pointerdown="emit('close')" />
      <div
        class="pointer-events-auto fixed left-1/2 top-1/2 z-[111] flex max-h-[560px] w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-white/10 bg-[#141416]/98 shadow-2xl"
        @pointerdown.stop
      >
        <div class="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span class="text-[11px] uppercase tracking-[0.12em] text-white/50">Add move</span>
          <button class="cursor-pointer p-1 text-white/45 hover:text-white/80" @click="emit('close')"><X class="size-3.5" /></button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
          <div v-if="!presetGroups.length && !customGroups.length" class="py-6 text-center text-[11px] text-white/35">
            Nothing to offer here yet.
          </div>

          <div v-for="group in presetGroups" :key="group.label">
            <div class="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-white/35">{{ group.label }}</div>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="resolved in group.offers" :key="resolved.offer.id" type="button"
                class="group flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors"
                :class="resolved.reason
                  ? 'cursor-not-allowed border-white/[0.05] bg-white/[0.015] opacity-50'
                  : 'cursor-pointer border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]'"
                :disabled="!!resolved.reason"
                :title="resolved.reason ?? resolved.offer.pitch"
                @click="pick(resolved)"
              >
                <div class="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded bg-white/[0.02] text-white/40">
                  <template v-if="$slots.thumb"><slot name="thumb" :offer="resolved.offer" /></template>
                  <component :is="resolved.offer.thumb" v-else-if="resolved.offer.thumb" />
                  <span v-else class="text-[9px] text-white/25">{{ resolved.offer.label.slice(0, 2).toUpperCase() }}</span>
                </div>
                <span class="truncate text-[10.5px]" :class="resolved.reason ? 'text-white/35' : 'text-white/85'">{{ resolved.offer.label }}</span>
                <span class="truncate text-[9px]" :class="resolved.reason ? 'text-white/30' : 'text-white/45'">
                  {{ resolved.reason ?? resolved.offer.pitch }}
                </span>
              </button>
            </div>
          </div>

          <!-- Custom: adapter.animatable(cfg) dials, always shown at the end -->
          <template v-if="customGroups.length">
            <div class="pt-1 text-[10px] uppercase tracking-[0.12em] text-white/35">Custom</div>
            <div v-for="group in customGroups" :key="`custom:${group.label}`">
              <div class="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-white/30">{{ group.label }}</div>
              <div class="flex flex-col gap-1">
                <button
                  v-for="resolved in group.dials" :key="resolved.dial.path" type="button"
                  class="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors"
                  :class="resolved.reason
                    ? 'cursor-not-allowed border-white/[0.05] bg-white/[0.015] opacity-50'
                    : 'cursor-pointer border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]'"
                  :disabled="!!resolved.reason"
                  :title="resolved.reason ?? undefined"
                  @click="pickDial(resolved)"
                >
                  <span class="truncate text-[11px]" :class="resolved.reason ? 'text-white/35' : 'text-white/85'">{{ resolved.dial.label }}</span>
                  <span v-if="resolved.reason" class="shrink-0 truncate text-[9px] text-white/35">{{ resolved.reason }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
