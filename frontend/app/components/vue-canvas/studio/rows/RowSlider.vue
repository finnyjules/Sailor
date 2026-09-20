<script setup lang="ts">
// The value side of a numeric row: a mono readout that becomes an input when the row
// says it is being edited. The row shell owns dragging, the fill, and committing —
// this only renders, so the two never fight over the pointer.
import { ref, watch, nextTick } from 'vue'
import { formatValue } from '~/lib/studio/row'
import RollingNumber from '~/components/RollingNumber.vue'

import type { ControlSpec } from '~/lib/spacetype/effect'

const props = defineProps<{
  value: number
  spec: ControlSpec
  step: number
  editing: boolean
}>()
const emit = defineEmits<{ (e: 'commit', raw: string): void; (e: 'cancel'): void }>()

const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

// Chrome fires `blur` on a focused element the moment it is removed from the DOM,
// and BOTH endings unmount this input: Escape's cancel and Enter's commit each set
// `editing = false` upstream. So the latch is "this gesture is already finished",
// not "this gesture was cancelled" — a cancel-only flag left Escape correct while
// Enter still double-committed (commit → unmount → blur → commit again, two
// identical `update:modelValue` writes for one keypress). Whichever ending runs
// first wins and the unmount-blur behind it is a no-op; a plain blur with neither
// key pressed still finds the latch clear and commits, which is click-away-to-commit.
let done = false

function cancel() {
  if (done) return
  done = true
  emit('cancel')
}
function commit() {
  if (done) return
  done = true
  emit('commit', draft.value)
}

watch(() => props.editing, async (on) => {
  if (!on) return
  done = false
  draft.value = formatValue(props.value, props.step)
  await nextTick()
  input.value?.select()
})
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    spellcheck="false"
    class="w-16 rounded-[4px] bg-white/10 px-1 text-right font-mono text-[11px] text-white outline-none"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
    @blur="commit"
    @pointerdown.stop
  />
  <RollingNumber
    v-else
    :text="formatValue(value, step)"
    class="font-mono text-[11px] text-white/90"
  />
  <!-- Same odometer as the credits pill. It rolls off the stream of drag values
       (no tween — the drag IS the stream) and does one clean click-over on an
       arrow/type/reset. `:text` feeds it the row's own formatted string so
       decimals and signs survive. -->

</template>
