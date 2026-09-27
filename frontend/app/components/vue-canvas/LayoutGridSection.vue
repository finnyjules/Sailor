<!-- The Frame editor's "Layout grid" section. Labels and values only; explanations live in tooltips.
     Number fields commit on change (not input), so a half-typed value never resizes the grid and
     one edit is one undo step. -->
<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import { patchLayoutGrid, type ColumnFit, type LayoutGrid, type LayoutGridPatch, type ResolvedLayoutGrid, type RowMode } from '~/lib/frame/layoutGrid'

const props = withDefaults(defineProps<{
  grid: LayoutGrid; resolved: ResolvedLayoutGrid; formatLabel: string
  /** The platform's show/hide shortcut, named in the switch's tooltip (⇧G). */
  showShortcut?: string
}>(), { showShortcut: '⇧G' })
const emit = defineEmits<{ update: [g: LayoutGrid] }>()
const patch = (p: LayoutGridPatch) => emit('update', patchLayoutGrid(props.grid, p))
const colWidth = computed(() => Math.round(props.resolved.cols[0]?.w ?? 0))
const realMargin = computed(() => Math.round(props.resolved.margin))
function setFit(fit: string) {
  const f = fit as ColumnFit
  // leaving Stretch starts the fixed width from the width the columns have now
  emit('update', patchLayoutGrid(props.grid, props.grid.cols.fit === 'stretch' && f !== 'stretch' ? { fit: f, width: colWidth.value } : { fit: f }))
}
/** A committed number field value, or null when it isn't a number (the field then snaps back). */
function num(e: Event): number | null {
  const el = e.target as HTMLInputElement
  const v = Number(el.value)
  return el.value.trim() !== '' && Number.isFinite(v) ? v : null
}
/** Commit a number field; a cleared or junk value puts the shown value back and records nothing. */
function onNum(e: Event, key: keyof LayoutGridPatch, shown: number) {
  const v = num(e)
  if (v == null) { (e.target as HTMLInputElement).value = String(shown); return }
  patch({ [key]: v } as LayoutGridPatch)
}
const fieldCls = 'flex-1 min-w-0 flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5'
const inputCls = 'w-full min-w-0 bg-transparent text-xs text-white/90 outline-none tabular-nums disabled:text-white/35'
</script>

<template>
  <StudioSection title="Layout grid" hint="A guide for placing layers. Layers snap to it; it never appears in exports.">
    <template #badge>
      <span class="flex items-center gap-1" data-testid="layout-grid-actions">
        <button v-if="!grid.auto" type="button" class="text-white/40 hover:text-white/80 p-1" :title="`Use the suggested grid for ${formatLabel}`"
          data-testid="grid-suggested" @click.stop.prevent="emit('update', { ...grid, auto: true })"><RotateCcw class="size-3.5" /></button>
        <span :title="`Show grid (${showShortcut})`" data-testid="grid-show">
          <StudioSwitch :model-value="grid.show" @update:model-value="(v: boolean) => patch({ show: v })" />
        </span>
      </span>
    </template>

    <div data-testid="layout-grid-section">
      <div class="panel-label mb-1">Columns</div>
      <div class="flex items-center gap-1.5 mb-1.5">
        <label :class="fieldCls" title="How many columns">
          <span class="text-xs text-white/40">Count</span>
          <input type="number" min="1" max="24" step="1" :value="grid.cols.count" aria-label="Column count" data-testid="grid-columns"
            :class="inputCls" @change="onNum($event, 'columns', grid.cols.count)" />
        </label>
        <label :class="fieldCls" title="Space between columns, px">
          <span class="text-xs text-white/40">Gutter</span>
          <input type="number" min="0" step="1" :value="Math.round(grid.cols.gutter)" aria-label="Gutter" data-testid="grid-gutter"
            :class="inputCls" @change="onNum($event, 'gutter', Math.round(grid.cols.gutter))" />
        </label>
      </div>
      <StudioSegmented :options="['stretch', 'center', 'left']" :option-labels="['Stretch', 'Center', 'Left']" :model-value="grid.cols.fit"
        data-testid="grid-fit" @update:model-value="setFit" />
      <div class="flex items-center gap-1.5 mt-1.5">
        <label :class="fieldCls" :title="grid.cols.fit === 'left' ? 'Space before the first column, px' : grid.cols.fit === 'center' ? 'Centred columns set their own margin' : 'Space either side of the columns, px'">
          <span class="text-xs text-white/40">{{ grid.cols.fit === 'left' ? 'Offset' : 'Margin' }}</span>
          <input type="number" min="0" step="1" :disabled="grid.cols.fit === 'center'" aria-label="Margin" data-testid="grid-margin"
            :value="grid.cols.fit === 'left' ? Math.round(grid.cols.margin) : realMargin" :class="inputCls" @change="onNum($event, 'margin', grid.cols.fit === 'left' ? Math.round(grid.cols.margin) : realMargin)" />
        </label>
        <label :class="fieldCls" :title="grid.cols.fit === 'stretch' ? 'Stretched columns fill the width' : 'Width of each column, px'">
          <span class="text-xs text-white/40">Width</span>
          <input type="number" min="1" step="1" :disabled="grid.cols.fit === 'stretch'" aria-label="Column width" data-testid="grid-width"
            :value="grid.cols.fit === 'stretch' ? colWidth : Math.round(grid.cols.width)" :class="inputCls" @change="onNum($event, 'width', grid.cols.fit === 'stretch' ? colWidth : Math.round(grid.cols.width))" />
        </label>
      </div>

      <div class="panel-label mt-3 mb-1 cursor-help" title="Square makes rows as tall as the columns are wide, rounded to the baseline grid.">Rows</div>
      <StudioSegmented :options="['off', 'square', 'count']" :option-labels="['Off', 'Square', 'Count']" :model-value="grid.rows.mode"
        data-testid="grid-rows" @update:model-value="(v: string) => patch({ rows: v as RowMode })" />
      <label v-if="grid.rows.mode === 'count'" :class="[fieldCls, 'mt-1.5']" title="How many rows">
        <span class="text-xs text-white/40">Count</span>
        <input type="number" min="1" max="24" step="1" :value="grid.rows.count" aria-label="Row count" data-testid="grid-row-count"
          :class="inputCls" @change="onNum($event, 'rowCount', grid.rows.count)" />
      </label>

      <label :class="[fieldCls, 'mt-3']" title="The body text's line spacing, px. Rows and the baseline grid (every half line) come from it.">
        <span class="text-xs text-white/40">Line</span>
        <input type="number" min="16" step="4" :value="grid.line" aria-label="Line spacing" data-testid="grid-line"
          :class="inputCls" @change="onNum($event, 'line', grid.line)" />
      </label>
    </div>
  </StudioSection>
</template>
