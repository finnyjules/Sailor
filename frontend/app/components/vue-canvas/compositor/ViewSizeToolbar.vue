<!-- app/components/vue-canvas/compositor/ViewSizeToolbar.vue -->
<script setup lang="ts">
// Bottom toolbar for a responsive Frame seen at another size. It takes the Frame's
// tool row's place while the view is off the design size, like the pen's and the
// brush's bars; "Back to design size" is its Done. Same dark chrome as BrushToolbar.
defineProps<{
  w: number
  h: number
  shapes: { id: string; label: string }[]
  /** Hidden (space kept) during a view drag, so the bar does not jump under the pointer. */
  dragging?: boolean
}>()
const emit = defineEmits<{ 'set-dim': [which: 'w' | 'h', raw: string]; 'pick-shape': [id: string]; done: [] }>()

function onShape(e: Event) {
  const el = e.target as HTMLSelectElement
  emit('pick-shape', el.value)
  el.selectedIndex = 0
}
</script>

<template>
  <div class="view-toolbar" data-testid="view-size-toolbar">
    <div class="tb" role="toolbar" aria-label="Viewing size" :class="{ invisible: dragging }" @click.stop>
      <span class="lbl">Viewing size</span>
      <input type="number" min="1" data-testid="frame-view-w" class="dim dim-w"
        :value="Math.round(w)" @change="emit('set-dim', 'w', ($event.target as HTMLInputElement).value)" />
      <span class="x">×</span>
      <input type="number" min="1" data-testid="frame-view-h" class="dim"
        :value="Math.round(h)" @change="emit('set-dim', 'h', ($event.target as HTMLInputElement).value)" />
      <select class="shapes" data-testid="frame-view-shapes" @change="onShape">
        <option value="">Shapes</option>
        <option v-for="s in shapes" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <div class="sep" />
      <button class="tbtn primary" data-testid="frame-view-done" @click="emit('done')">Back to design size</button>
    </div>
  </div>
</template>

<style scoped>
.view-toolbar {
  display: flex;
  justify-content: center;
  width: 100%;
  min-width: 0;
}
.tb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 6px 12px;
  background: color-mix(in srgb, #1a1a1a 95%, transparent);
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  width: max-content;
  max-width: 100%;
  color: #3b82f6;
  font-size: 12px;
}
.invisible { visibility: hidden; }
.lbl { white-space: nowrap; }
.dim {
  width: 52px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  outline: none;
  border: 0;
}
.dim-w { text-align: right; }
.x { color: rgba(255, 255, 255, 0.3); }
.shapes {
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  font: inherit;
  outline: none;
  border: 0;
  cursor: pointer;
}
.sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 4px;
  flex: none;
}
.tbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.tbtn.primary { background: #2f6bff; color: #fff; }
.tbtn.primary:hover { background: #3f78ff; }
</style>
