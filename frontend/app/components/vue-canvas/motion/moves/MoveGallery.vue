<script setup lang="ts">
/**
 * Add-move gallery: In · Loop · Out · Custom tabs. The panel is driven
 * ENTIRELY through the `adapter` prop (`MovesAdapter<Cfg>`,
 * `~/lib/studio/moves/adapter.ts`) — the In/Loop/Out tabs render
 * `adapter.gallery(cfg, phase)`'s groups, Custom renders
 * `adapter.animatable(cfg)`'s dial groups, and every tile's grey/enabled
 * state comes from `adapter.availability(cfg, candidate)`. A studio's own
 * visuals reach a tile only two ways: the `#thumb` scoped slot (preferred —
 * lets a studio-specific renderer draw the tile without this component
 * knowing what it is) or, if the caller doesn't fill that slot, the
 * `MoveOffer.thumb` component the adapter itself supplied.
 *
 * Anchored/Teleported like `MotionPresetPicker.vue` (see its header) —
 * `close()` on backdrop click or Escape.
 *
 * NOTHING here may import from `lib/vectortype`; studio specifics arrive
 * ONLY through `adapter`/`cfg` and the `#thumb` slot.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import type { MovesAdapter, MoveOffer, MovePhase, DialDef } from '~/lib/studio/moves/adapter'
import type { Move } from '~/lib/studio/moves/types'
import { DEFAULT_EASE } from '~/lib/studio/moves/ease'

const props = defineProps<{ adapter: MovesAdapter<any>; cfg: any }>()
const emit = defineEmits<{ (e: 'add', move: Move): void; (e: 'close'): void }>()

const PHASES: MovePhase[] = ['in', 'loop', 'out']
const PHASE_TAB_LABEL: Record<MovePhase, string> = { in: 'In', loop: 'Loop', out: 'Out' }

function freshId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return `move_${c?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

// ── In / Loop / Out tabs ────────────────────────────────────────────────

const galleryByPhase = computed(() => {
  const m = new Map<MovePhase, ReturnType<MovesAdapter<any>['gallery']>>()
  for (const p of PHASES) m.set(p, props.adapter.gallery(props.cfg, p))
  return m
})

// Empty groups hide that phase's tab (adapter.ts §gallery doc), leaving
// whatever else has offers, plus Custom which is always available.
const visiblePhaseTabs = computed(() => PHASES.filter((p) => (galleryByPhase.value.get(p) ?? []).length > 0))

type Tab = MovePhase | 'custom'
const activeTab = ref<Tab>(visiblePhaseTabs.value[0] ?? 'custom')

/** `offer.build()` already returns a complete-enough `Partial<Move>` (every
 *  adapter in this codebase fills phase/kind/duration/ease/play) — these
 *  fallbacks are a defensive floor for an adapter that leaves one out, not
 *  the expected path. `id` is a placeholder used only to test availability;
 *  `add(...)` mints the real one. */
function candidateFromOffer(offer: MoveOffer, phase: MovePhase): Move {
  const built = offer.build()
  return {
    id: '__candidate__',
    phase: built.phase ?? phase,
    kind: built.kind ?? offer.kind,
    presetId: built.presetId ?? offer.presetId,
    duration: typeof built.duration === 'number' ? built.duration : 1,
    ease: built.ease ?? DEFAULT_EASE,
    play: built.play ?? { mode: phase === 'loop' ? 'repeat' : 'once', times: 1 },
    params: built.params,
    tracks: built.tracks,
  }
}

interface ResolvedOffer { offer: MoveOffer; candidate: Move; reason: string | null }
interface ResolvedGroup { label: string; offers: ResolvedOffer[] }

const activeGroups = computed<ResolvedGroup[]>(() => {
  if (activeTab.value === 'custom') return []
  const phase = activeTab.value
  return (galleryByPhase.value.get(phase) ?? []).map((g) => ({
    label: g.label,
    offers: g.offers.map((offer) => {
      const candidate = candidateFromOffer(offer, phase)
      return { offer, candidate, reason: props.adapter.availability(props.cfg, candidate) }
    }),
  }))
})

function pick(resolved: ResolvedOffer) {
  if (resolved.reason) return
  emit('add', { ...resolved.candidate, id: freshId() })
}

// ── Custom tab ───────────────────────────────────────────────────────────

const customPhase = ref<MovePhase>('loop')

// `cfg.motion.duration` is the shared clip-length convention (`MotionClip`,
// `~/lib/studio/moves/types`) every studio's config carries its moves under
// — duck-typed defensively here since `cfg` is intentionally untyped at this
// boundary, with the same `4` fallback the Vector Type adapter uses for a
// config that doesn't have one yet.
const clipDuration = computed(() => {
  const d = (props.cfg as any)?.motion?.duration
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 4
})

function dialCandidate(dial: DialDef, phase: MovePhase): Move {
  return {
    id: '__candidate__',
    phase,
    kind: 'tracks',
    presetId: 'custom',
    duration: clipDuration.value,
    ease: DEFAULT_EASE,
    play: { mode: 'once', times: 1 },
    tracks: [{ path: dial.path, from: dial.min, to: dial.max, hold: 0, cycleOffset: 0, delay: 0 }],
  }
}

interface ResolvedDial { dial: DialDef; candidate: Move; reason: string | null }
interface ResolvedDialGroup { label: string; dials: ResolvedDial[] }

const animatableGroups = computed<ResolvedDialGroup[]>(() => {
  const phase = customPhase.value
  return props.adapter.animatable(props.cfg).map((g) => ({
    label: g.label,
    dials: g.dials.map((dial) => {
      const candidate = dialCandidate(dial, phase)
      return { dial, candidate, reason: props.adapter.availability(props.cfg, candidate) }
    }),
  }))
})

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

        <div class="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
          <button
            v-for="p in visiblePhaseTabs" :key="p" type="button"
            class="cursor-pointer rounded px-2 py-1 text-[11px] transition-colors"
            :class="activeTab === p ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
            @click="activeTab = p"
          >{{ PHASE_TAB_LABEL[p] }}</button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 text-[11px] transition-colors"
            :class="activeTab === 'custom' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
            @click="activeTab = 'custom'"
          >Custom</button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <!-- In / Loop / Out: adapter.gallery(cfg, phase) groups -->
          <div v-if="activeTab !== 'custom'" class="space-y-3">
            <div v-if="!activeGroups.length" class="py-6 text-center text-[11px] text-white/35">Nothing to offer here yet.</div>
            <div v-for="group in activeGroups" :key="group.label">
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
          </div>

          <!-- Custom: In/Loop/Out sub-toggle + adapter.animatable(cfg) dials -->
          <div v-else class="space-y-3">
            <div class="flex items-center gap-1">
              <button
                v-for="p in PHASES" :key="p" type="button"
                class="cursor-pointer rounded border px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] transition-colors"
                :class="customPhase === p ? 'border-white/50 bg-white/[0.08] text-white' : 'border-white/10 text-white/45 hover:text-white/70'"
                @click="customPhase = p"
              >{{ PHASE_TAB_LABEL[p] }}</button>
            </div>

            <div v-if="!animatableGroups.length" class="py-6 text-center text-[11px] text-white/35">No animatable properties.</div>
            <div v-for="group in animatableGroups" :key="group.label">
              <div class="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-white/35">{{ group.label }}</div>
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
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
