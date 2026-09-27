<!-- The Layer section's place on the layout grid: the first column (and row, when the grid has rows)
     a layer covers, and how many. Labels and values only; explanations are tooltips. Fields commit
     on change, so one edit is one patch (and one undo step in the editor). Rows of text are counted
     from its capitals. -->
<script setup lang="ts">
import type { LayoutSpan } from '~/lib/frame/layoutGrid'

const props = withDefaults(defineProps<{
  span: LayoutSpan
  colCount: number
  rowCount: number
  /** The layer's width can be set to a span of columns (see canSpanColumns). */
  canSpanCols: boolean
  /** The layer's height can be set to a span of rows (see canSpanRows). */
  canSpanRows: boolean
  disabled?: boolean
}>(), { disabled: false })
const emit = defineEmits<{ update: [p: Partial<LayoutSpan>] }>()

/** Commit one field: whole numbers inside the grid; a cleared, junk or unchanged value shows the value again. */
function onNum(e: Event, key: keyof LayoutSpan, shown: number, max: number) {
  const el = e.target as HTMLInputElement
  const v = Number(el.value)
  if (el.value.trim() === '' || !Number.isFinite(v)) { el.value = String(shown); return }
  const n = Math.min(Math.max(1, max), Math.max(1, Math.round(v)))
  if (n === shown) { el.value = String(shown); return }
  emit('update', { [key]: n } as Partial<LayoutSpan>)
}
const fieldCls = 'flex-1 min-w-0 flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5'
const inputCls = 'w-full min-w-0 bg-transparent text-xs text-white/90 outline-none tabular-nums disabled:text-white/35'
</script>

<template>
  <div data-testid="layer-grid-fields" class="flex flex-col gap-1.5">
    <div class="flex items-center gap-1.5">
      <label :class="fieldCls" title="The first column the layer covers">
        <span class="text-xs text-white/40">Column</span>
        <input type="number" min="1" :max="colCount" step="1" :value="span.col" :disabled="disabled" aria-label="Column"
          data-testid="layer-grid-col" :class="inputCls" @change="onNum($event, 'col', span.col, colCount)" />
      </label>
      <label :class="fieldCls" title="How many columns the layer covers">
        <span class="text-xs text-white/40">Span</span>
        <input type="number" min="1" :max="colCount - span.col + 1" step="1" :value="span.cols" :disabled="disabled || !canSpanCols" aria-label="Column span"
          data-testid="layer-grid-cols" :class="inputCls" @change="onNum($event, 'cols', span.cols, colCount - span.col + 1)" />
      </label>
    </div>
    <div v-if="span.row != null && span.rows != null" class="flex items-center gap-1.5">
      <label :class="fieldCls" title="The first row the layer covers; text counts from its capitals">
        <span class="text-xs text-white/40">Row</span>
        <input type="number" min="1" :max="rowCount" step="1" :value="span.row" :disabled="disabled" aria-label="Row"
          data-testid="layer-grid-row" :class="inputCls" @change="onNum($event, 'row', span.row!, rowCount)" />
      </label>
      <label :class="fieldCls" :title="canSpanRows ? 'How many rows the layer covers' : 'How many rows the layer covers; its height follows its content'">
        <span class="text-xs text-white/40">Span</span>
        <input type="number" min="1" :max="rowCount - span.row + 1" step="1" :value="span.rows" :disabled="disabled || !canSpanRows" aria-label="Row span"
          data-testid="layer-grid-rows" :class="inputCls" @change="onNum($event, 'rows', span.rows!, rowCount - span.row! + 1)" />
      </label>
    </div>
  </div>
</template>
