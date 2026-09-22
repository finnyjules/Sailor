<script setup lang="ts">
/** The Copies card — Motion tab, cloner motion plan (Task 5). A cloned layer's copies can
 *  stagger their motion: this edits `Cloner.motionStagger` / `motionOrder` / `motionSeed`,
 *  the three fields `lib/motionx/copies.ts` reads to offset each copy's clock. It sits in
 *  the Motion tab (never Design) beside `MotionInspector`, reading like the same Studio-row
 *  panel family it stands next to.
 *
 *  One drag = one undo step, the same `undoCoalesce` idiom `MotionInspector.vue` uses for its
 *  own sliders: `gesture('copies-stagger')` opens/closes the run from native pointer/key
 *  events, and `recordFor` tells `setStagger` whether THIS value is the first of the run (the
 *  only one that emits `before-change`). Order and Shuffle are discrete edits — always their
 *  own step, like `MotionInspector`'s `setBehParams`. */
import { computed } from 'vue'
import { Shuffle } from 'lucide-vue-next'
import type { Cloner } from '~/composables/useCloner'
import { COPY_ORDERS, COPY_ORDER_LABELS, type CopyOrder } from '~/lib/motionx/copies'
import { NO_RUN, openRun, closeRun, takeRecord, type UndoRun } from '~/lib/motionx/undoCoalesce'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSegmentedRow from '~/components/vue-canvas/studio/StudioSegmentedRow.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'

const props = defineProps<{ cloner: Cloner }>()
const emit = defineEmits<{ update: [cloner: Cloner]; 'before-change': [] }>()

// `COPY_ORDERS`/`COPY_ORDER_LABELS` are the library's own readonly enum — copied into plain
// mutable arrays paired by index, the same idiom `DITHER_STYLES`/`DITHER_STYLE_LABELS` use in
// MotionInspector.vue for a Studio control's `options`/`option-labels`.
const ORDER_OPTIONS: string[] = [...COPY_ORDERS]
const ORDER_LABELS: string[] = COPY_ORDERS.map((o) => COPY_ORDER_LABELS[o])

const stagger = computed(() => (typeof props.cloner.motionStagger === 'number' ? props.cloner.motionStagger : 0))
const order = computed<CopyOrder>(() => props.cloner.motionOrder ?? 'first')

function up(patch: Partial<Cloner>) {
  emit('update', { ...props.cloner, ...patch })
}

// ── One drag = one undo step (Stagger) ───────────────────────────────────────
let undoRun: UndoRun = NO_RUN
function recordFor(key: string): boolean {
  const r = takeRecord(undoRun, key)
  undoRun = r.run
  return r.record
}
function gesture(key: string) {
  return {
    'data-owns-keys': '',
    onPointerdownCapture: () => { undoRun = openRun(undoRun, key) },
    onKeydownCapture: () => { undoRun = openRun(undoRun, key) },
    onPointerup: () => { undoRun = closeRun() },
    onPointercancel: () => { undoRun = closeRun() },
    onLostpointercapture: () => { undoRun = closeRun() },
    onKeyup: () => { undoRun = closeRun() },
  }
}
function setStagger(v: number) {
  if (recordFor('copies-stagger')) emit('before-change')
  up({ motionStagger: v })
}

// ── Discrete edits (Order, Shuffle) ──────────────────────────────────────────
function setOrder(v: string) {
  undoRun = closeRun()
  emit('before-change')
  up({ motionOrder: v as CopyOrder })
}
function shuffle() {
  // Authoring click only — never reachable from rendering. Same re-roll shape
  // MotionInspector's own `shuffleSeed` uses for the letter behaviours.
  undoRun = closeRun()
  emit('before-change')
  up({ motionSeed: Math.floor(Math.random() * 9999) + 1 })
}
</script>

<template>
  <div>
    <div class="mi-heading">Copies</div>
    <StudioSlider data-testid="copies-stagger" v-bind="gesture('copies-stagger')"
      label="Stagger" hint="Seconds between one copy's clock and the next. 0 plays every copy in unison."
      :model-value="stagger" :min="0" :max="2" :step="0.01" :default="0"
      @update:model-value="setStagger" />
    <StudioSegmentedRow data-testid="copies-order" label="Order" class="mt-1.5"
      :model-value="order" :options="ORDER_OPTIONS" :option-labels="ORDER_LABELS"
      @update:model-value="setOrder" />
    <div v-if="order === 'random'" class="mt-1.5 flex justify-end">
      <StudioButton data-testid="copies-shuffle" variant="subtle" title="New order" @click="shuffle">
        <Shuffle class="h-3.5 w-3.5" />
      </StudioButton>
    </div>
  </div>
</template>

<style scoped>
/* Same section-title rule MotionInspector.vue uses (~845-852): a title needs clearly more
   space above it than the 8px the rows around it already sit apart, and the first title in a
   card needs none — this card's own header (the modal's) already sits above it. */
.mi-heading.mi-heading {
  margin: 20px 0 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: rgb(255 255 255 / 0.35);
}
.mi-heading.mi-heading:first-child { margin-top: 0; }
</style>
