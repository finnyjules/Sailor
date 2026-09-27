<!-- The Layer section's place on the layout grid: the first column (and row, when the grid has rows)
     a layer covers, and how many. Labels and values only; explanations are tooltips. Fields commit
     on change, so one edit is one patch (and one undo step in the editor). Rows of text are counted
     from its capitals. -->
<script setup lang="ts">
import { computed } from 'vue'
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
  /** Why the whole control is off (a rotated layer, the pen): each label's tooltip while disabled. */
  disabledReason?: string
  /** Why this layer can't take a column span (tooltip on the disabled column Span). */
  colsReason?: string
  /** Why this layer can't take a row span (tooltip on the disabled row Span). */
  rowsReason?: string
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
/** A field's tooltip: its hint, or — while it's off — why. */
const OFF = 'Not available for this layer'
function tip(hint: string, off: boolean, reason?: string): string {
  if (props.disabled) return props.disabledReason || OFF
  return off ? (reason || OFF) : hint
}
const colMax = computed(() => Math.max(1, props.colCount - props.span.cols + 1))
const rowMax = computed(() => Math.max(1, props.rowCount - (props.span.rows ?? 1) + 1))
const fieldCls = 'flex-1 min-w-0 flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5'
const inputCls = 'w-full min-w-0 bg-transparent text-xs text-white/90 outline-none tabular-nums disabled:text-white/35'
</script>

<template>
  <div data-testid="layer-grid-fields" class="flex flex-col gap-1.5">
    <div class="flex items-center gap-1.5">
      <label :class="fieldCls" :title="tip('The first column the layer covers', false)">
        <span class="text-xs text-white/40">Column</span>
        <input type="number" min="1" :max="colMax" step="1" :value="span.col" :disabled="disabled" aria-label="Column"
          data-testid="layer-grid-col" :class="inputCls" @change="onNum($event, 'col', span.col, colMax)" />
      </label>
      <label :class="fieldCls" :title="tip('How many columns the layer covers', !canSpanCols, colsReason)">
        <span class="text-xs text-white/40">Span</span>
        <input type="number" min="1" :max="colCount - span.col + 1" step="1" :value="span.cols" :disabled="disabled || !canSpanCols" aria-label="Column span"
          data-testid="layer-grid-cols" :class="inputCls" @change="onNum($event, 'cols', span.cols, colCount - span.col + 1)" />
      </label>
    </div>
    <div v-if="span.row != null && span.rows != null" class="flex items-center gap-1.5">
      <label :class="fieldCls" :title="tip('The first row the layer covers; text counts from its capitals', false)">
        <span class="text-xs text-white/40">Row</span>
        <input type="number" min="1" :max="rowMax" step="1" :value="span.row" :disabled="disabled" aria-label="Row"
          data-testid="layer-grid-row" :class="inputCls" @change="onNum($event, 'row', span.row!, rowMax)" />
      </label>
      <label :class="fieldCls" :title="tip('How many rows the layer covers', !canSpanRows, rowsReason)">
        <span class="text-xs text-white/40">Span</span>
        <input type="number" min="1" :max="rowCount - span.row + 1" step="1" :value="span.rows" :disabled="disabled || !canSpanRows" aria-label="Row span"
          data-testid="layer-grid-rows" :class="inputCls" @change="onNum($event, 'rows', span.rows!, rowCount - span.row! + 1)" />
      </label>
    </div>
  </div>
</template>
