<script setup lang="ts">
/**
 * Studio-agnostic ease picker: a 2-column grid of the ten named eases (a
 * small glyph sampled from the SAME function the motion uses, via
 * `easeGlyphPath` — a tile can never disagree with the movement) plus a
 * "Custom curve" toggle that reveals the existing `CurveEditor.vue` for a
 * hand-drawn bezier. Shared across every studio's moves panel — see
 * `~/lib/studio/moves/ease.ts` for the vocabulary this reads.
 *
 * NOTHING here may import from `lib/vectortype`.
 */
import { computed, ref, watch } from 'vue'
import { EASE_LABELS, EASE_NAMES, easeGlyphPath } from '~/lib/studio/moves/ease'
import type { MoveEase, MoveEaseName } from '~/lib/studio/moves/types'
import CurveEditor from '~/components/vue-canvas/CurveEditor.vue'
import { easeFromCurveString, easeToCurveString } from './easePickerLogic'

const props = defineProps<{ modelValue: MoveEase }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: MoveEase): void }>()

// "Custom curve" is open whenever the current ease IS a bezier, but the user
// can also open it pre-emptively (before dragging a handle) — a separate
// ref, seeded from and kept in sync with the incoming value, rather than
// deriving it purely from `modelValue.kind` so toggling the button doesn't
// require an ease change first.
const customOpen = ref(props.modelValue.kind === 'bezier')
watch(() => props.modelValue, (v) => { if (v.kind === 'bezier') customOpen.value = true }, { deep: true })

const glyphW = 40
const glyphH = 20

function isActiveNamed(name: MoveEaseName) {
  return !customOpen.value && props.modelValue.kind === 'named' && props.modelValue.name === name
}

function glyphFor(name: MoveEaseName) {
  return easeGlyphPath({ kind: 'named', name }, glyphW, glyphH)
}

function pickNamed(name: MoveEaseName) {
  customOpen.value = false
  emit('update:modelValue', { kind: 'named', name })
}

function toggleCustom() {
  const opening = !customOpen.value
  customOpen.value = opening
  // Opening from a named ease: seed a real bezier so CurveEditor has
  // something to draw and drag immediately, rather than showing the default
  // curve until the user first touches a handle.
  if (opening && props.modelValue.kind !== 'bezier') {
    emit('update:modelValue', easeFromCurveString(easeToCurveString(props.modelValue)))
  }
}

const curveValue = computed(() => easeToCurveString(props.modelValue))
function onCurveUpdate(s: string) { emit('update:modelValue', easeFromCurveString(s)) }
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="grid grid-cols-2 gap-1.5">
      <button
        v-for="name in EASE_NAMES" :key="name" type="button"
        class="group flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left cursor-pointer transition-colors"
        :class="isActiveNamed(name) ? 'border-white/60 bg-white/[0.08]' : 'border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]'"
        @click="pickNamed(name)"
      >
        <svg :viewBox="`0 0 ${glyphW} ${glyphH}`" class="h-4 w-8 shrink-0">
          <path :d="glyphFor(name)" fill="none" stroke-width="1.5"
                :class="isActiveNamed(name) ? 'stroke-white' : 'stroke-white/45'" />
        </svg>
        <span class="truncate text-[11px]" :class="isActiveNamed(name) ? 'text-white' : 'text-white/65'">{{ EASE_LABELS[name] }}</span>
      </button>
    </div>

    <button
      type="button"
      class="self-start rounded border px-2 py-1 text-[10px] uppercase tracking-[0.08em] cursor-pointer transition-colors"
      :class="customOpen ? 'border-white/60 bg-white/[0.08] text-white' : 'border-white/10 text-white/50 hover:text-white/80'"
      @click="toggleCustom"
    >
      Custom curve
    </button>

    <CurveEditor v-if="customOpen" :model-value="curveValue" @update:model-value="onCurveUpdate" />
  </div>
</template>
