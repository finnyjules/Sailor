<!-- app/components/pen/PenRepeatPanel.vue -->
<script setup lang="ts">
// The Repeat… panel (pen stage 8, Rulings 12–16). PenProperties shows it in
// its place while Repeat is open, so each host shows it in its own side
// panel with no change of its own. Buttons never take focus from a mouse
// press (mousedown.prevent): Space keeps panning after a click, and a
// focused button got there by keyboard (isCleanupBarFocused covers this
// panel). A field's Enter commits what it holds, blurs it (for the same
// reason) and applies — the same as clicking Apply, which commits a field
// still being typed first (the field keeps focus through the click). Leaving
// a field any other way puts the shown value back, so what the fields show
// is always what the preview shows. Hints live in the cards, not here.
import { ref } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import type { RepeatMode, RepeatPatch } from '~/composables/pen/penRepeat'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'

const props = defineProps<{ pen: Pen }>()
const { repeat, repeatNames, setRepeat, applyRepeatPanel, cancelRepeat } = props.pen
const MODES: { id: RepeatMode; label: string }[] = [
  { id: 'radial', label: 'Radial' }, { id: 'linear', label: 'Linear' }, { id: 'along', label: 'Along a path' },
]
// one ref per field (several same-named refs outside a v-for keep only the last)
type Field = InstanceType<typeof PenNumberInput> | null
const countField = ref<Field>(null), sweepField = ref<Field>(null), angleField = ref<Field>(null), distanceField = ref<Field>(null)
function blurField(): void {
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  if (a?.closest?.('[data-repeat-panel]')) a.blur()
}
// while Apply commits the fields, their submits only set (Apply applies once)
let committing = false
function submit(patch: RepeatPatch): void {
  setRepeat(patch)
  if (committing) return
  blurField()
  applyRepeatPanel()
}
function apply(): void {
  committing = true
  try { for (const f of [countField.value, sweepField.value, angleField.value, distanceField.value]) f?.commit() }
  finally { committing = false }
  blurField()
  applyRepeatPanel()
}
</script>

<template>
  <div v-if="repeat" class="repeat" data-repeat-panel role="group" aria-label="Repeat">
    <div class="head">Repeat</div>
    <div class="seg" role="radiogroup" aria-label="Kind">
      <PenTipCard v-for="m in MODES" :id="`repeat-${m.id}`" :key="m.id" side="left">
        <button type="button" class="seg-btn" role="radio" :data-repeat-mode="m.id" :aria-checked="repeat.mode === m.id"
                @mousedown.prevent @click="setRepeat({ mode: m.id })">{{ m.label }}</button>
      </PenTipCard>
    </div>

    <div class="row" data-repeat-field="count">
      <span class="name">Copies</span>
      <PenNumberInput ref="countField" :value="repeat.count" :min="2" aria-label="Copies" @submit="n => submit({ count: n })" />
      <span class="unit" aria-hidden="true" />
    </div>

    <template v-if="repeat.mode === 'radial'">
      <div class="row" data-repeat-field="centre"><span class="name">Centre</span><span class="value">{{ repeatNames.centre }}</span></div>
      <div class="row" data-repeat-field="sweep">
        <span class="name">Sweep</span>
        <PenNumberInput ref="sweepField" :value="repeat.sweep" aria-label="Sweep" @submit="n => submit({ sweep: n })" />
        <span class="unit" aria-hidden="true">°</span>
      </div>
    </template>

    <template v-else-if="repeat.mode === 'linear'">
      <div class="row" data-repeat-field="angle">
        <span class="name">Angle</span>
        <PenNumberInput ref="angleField" :value="repeat.angle" aria-label="Angle" @submit="n => submit({ angle: n })" />
        <span class="unit" aria-hidden="true">°</span>
      </div>
      <PenTipCard id="repeat-spacing" side="left">
        <div class="seg" role="radiogroup" aria-label="Spacing">
          <button v-for="sp in (['step', 'span'] as const)" :key="sp" type="button" class="seg-btn" role="radio" :data-repeat-spacing="sp"
                  :aria-checked="repeat.spacing === sp" @mousedown.prevent @click="setRepeat({ spacing: sp })">{{ sp === 'step' ? 'Step' : 'Span' }}</button>
        </div>
      </PenTipCard>
      <div class="row" data-repeat-field="distance">
        <span class="name">Distance</span>
        <PenNumberInput ref="distanceField" :value="repeat.distance" aria-label="Distance" @submit="n => submit({ distance: n })" />
        <span class="unit" aria-hidden="true" />
      </div>
    </template>

    <template v-else>
      <div class="row" data-repeat-field="path"><span class="name">Path</span><span class="value">{{ repeatNames.path }}</span></div>
    </template>

    <div class="actions">
      <PenTipCard id="repeat-cancel" side="left">
        <button type="button" class="btn" data-act="repeat-cancel" @mousedown.prevent @click="cancelRepeat()">Cancel</button>
      </PenTipCard>
      <PenTipCard id="repeat-apply" side="left">
        <button type="button" class="btn primary" data-act="repeat-apply" :disabled="!repeat.preview.ok" @mousedown.prevent @click="apply()">Apply</button>
      </PenTipCard>
    </div>
  </div>
</template>

<style scoped>
.repeat { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.head { font-weight: 600; font-size: 12.5px; color: #fff; }
.seg { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
.seg-btn {
  flex: 1 1 auto; height: 24px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent;
  color: rgba(255, 255, 255, 0.7); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; white-space: nowrap;
}
.seg-btn[aria-checked='true'] { background: #fff; color: #111; }
.seg-btn:hover:not([aria-checked='true']) { background: rgba(255, 255, 255, 0.08); }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { flex: 1; min-width: 0; color: rgba(255, 255, 255, 0.55); }
.value { color: rgba(255, 255, 255, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.unit { width: 8px; flex: none; color: rgba(255, 255, 255, 0.45); }
.actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.btn {
  height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2); background: transparent;
  color: rgba(255, 255, 255, 0.85); font: 500 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
}
.btn.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
.btn:disabled { opacity: 0.4; cursor: default; }
</style>
