<script setup lang="ts">
// Floating contextual toolbar for the Frame's inline editing — the common,
// high-frequency controls for the selected local layer. The parent positions it
// (screen-space, above the selection). Full/precise controls live in the modal.
import { AlignLeft, AlignCenter, AlignRight, ArrowUp, ArrowDown, Trash2, Ban, Shield } from 'lucide-vue-next'
import { TEMPLATE_FONTS } from '~~/shared/template-fonts'
import { layerStoresStrokeStack } from '~/lib/compositor/strokeStack'

const props = defineProps<{
  layer: any       // the selected LocalLayer
  pxBase: number   // canvas width in logical px — for norm↔px size conversions
}>()
const emit = defineEmits<{ set: [patch: Record<string, any>]; movez: [dir: number]; remove: [] }>()

const FONT_NAMES = TEMPLATE_FONTS.map(f => f.name)
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'difference', 'lighten', 'darken', 'add']

function px(norm: number) { return Math.round((norm || 0) * props.pxBase) }
function setPx(key: string, v: string) { emit('set', { [key]: Math.max(0, parseFloat(v) || 0) / props.pxBase }) }
// A rect's radius can be per-corner ([tl, tr, br, bl]). This compact field is the
// LINKED one: it shows the largest corner and writes a single number back (which
// re-links all four). Per-corner editing lives in the modal inspector.
function radiusPx(r: unknown) { return px(Array.isArray(r) ? Math.max(...r.map(v => Number(v) || 0)) : (r as number)) }
const hasFill = computed(() => props.layer.fill && props.layer.fill !== 'none')
// THE STACK GATE. These two fields write the LEGACY `stroke`/`strokeWidth` pair straight
// onto the layer, and `strokeStackOf` treats a live legacy field as authoritative — it then
// IGNORES the stored array entirely. So on a layer that stores a stroke stack, one nudge of
// either field would collapse every outline but the folded legacy one, and the next "Add
// outline" would write over the survivors. Same predicate, same reason, as the modal
// inspector's `showsLegacyStrokeSection`; this is the surface that fix did not reach.
// A LINE is deliberately unaffected: it is not stackable (see `strokeSupportsStack`), its
// single stroke IS the legacy pair, and its Thickness field is the only place to edit it.
const showsLegacyStroke = computed(() => !layerStoresStrokeStack(props.layer))
// A path's fill may be a gradient object; show a neutral swatch for the color
// input (which, if used, replaces the gradient with a solid color).
const pathFillColor = computed(() =>
  typeof props.layer.fill === 'string' && props.layer.fill !== 'none' ? props.layer.fill : '#3b82f6')
</script>

<template>
  <div
    class="ll-toolbar flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[#1c1c1c] border border-white/12 shadow-xl text-white/80"
    @pointerdown.stop
    @click.stop
  >
    <!-- TEXT -->
    <template v-if="layer.kind === 'text'">
      <input type="color" :value="layer.color" title="Color"
        class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
        @input="emit('set', { color: ($event.target as HTMLInputElement).value })" />
      <select :value="layer.fontFamily" title="Font"
        class="h-6 max-w-[96px] bg-white/[0.06] rounded text-[11px] text-white/85 px-1 outline-none cursor-pointer"
        @change="emit('set', { fontFamily: ($event.target as HTMLSelectElement).value })">
        <option v-for="f in FONT_NAMES" :key="f" :value="f">{{ f }}</option>
      </select>
      <input type="number" min="1" :value="px(layer.fontSize)" title="Size"
        class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
        @input="setPx('fontSize', ($event.target as HTMLInputElement).value)" />
      <select :value="layer.fontWeight || 400" title="Weight"
        class="h-6 w-12 bg-white/[0.06] rounded text-[11px] text-white/85 px-0.5 outline-none cursor-pointer"
        @change="emit('set', { fontWeight: parseInt(($event.target as HTMLSelectElement).value) || 400 })">
        <option v-for="w in [100, 200, 300, 400, 500, 600, 700, 800, 900]" :key="w" :value="w">{{ w }}</option>
      </select>
      <button v-for="a in (['left','center','right'] as const)" :key="a" class="ll-btn" :class="layer.align === a ? 'is-on' : ''" :title="`Align ${a}`"
        @click="emit('set', { align: a })">
        <component :is="a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight" class="size-3.5" />
      </button>
    </template>

    <!-- RECT / ELLIPSE -->
    <template v-else-if="layer.kind === 'rect' || layer.kind === 'ellipse'">
      <input type="color" :value="hasFill ? layer.fill : '#3b82f6'" title="Fill"
        class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
        @input="emit('set', { fill: ($event.target as HTMLInputElement).value })" />
      <button class="ll-btn" :class="!hasFill ? 'is-on' : ''" title="No fill"
        @click="emit('set', { fill: hasFill ? 'none' : '#3b82f6' })"><Ban class="size-3.5" /></button>
      <template v-if="showsLegacyStroke">
        <span class="ll-sep" />
        <input type="color" :value="layer.stroke || '#ffffff'" title="Stroke"
          class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
          @input="emit('set', { stroke: ($event.target as HTMLInputElement).value })" />
        <input type="number" min="0" :value="px(layer.strokeWidth)" title="Stroke width" data-testid="toolbar-stroke-width"
          class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
          @input="setPx('strokeWidth', ($event.target as HTMLInputElement).value)" />
      </template>
      <input v-if="layer.kind === 'rect'" type="number" min="0" :value="radiusPx(layer.radius)" title="Corner radius (sets all four)"
        class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
        @input="setPx('radius', ($event.target as HTMLInputElement).value)" />
    </template>

    <!-- PATH (vector) -->
    <template v-else-if="layer.kind === 'path'">
      <input type="color" :value="pathFillColor" title="Fill"
        class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
        @input="emit('set', { fill: ($event.target as HTMLInputElement).value })" />
      <button class="ll-btn" :class="!hasFill ? 'is-on' : ''" title="No fill"
        @click="emit('set', { fill: hasFill ? 'none' : '#3b82f6' })"><Ban class="size-3.5" /></button>
      <template v-if="showsLegacyStroke">
        <span class="ll-sep" />
        <input type="color" :value="layer.stroke || '#ffffff'" title="Stroke"
          class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
          @input="emit('set', { stroke: ($event.target as HTMLInputElement).value })" />
        <input type="number" min="0" :value="px(layer.strokeWidth)" title="Stroke width" data-testid="toolbar-stroke-width"
          class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
          @input="setPx('strokeWidth', ($event.target as HTMLInputElement).value)" />
      </template>
    </template>

    <!-- LINE -->
    <template v-else-if="layer.kind === 'line'">
      <input type="color" :value="layer.stroke" title="Color"
        class="size-6 shrink-0 rounded cursor-pointer bg-transparent border border-white/10 p-0"
        @input="emit('set', { stroke: ($event.target as HTMLInputElement).value })" />
      <input type="number" min="1" :value="px(layer.strokeWidth)" title="Thickness"
        class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
        @input="setPx('strokeWidth', ($event.target as HTMLInputElement).value)" />
    </template>

    <!-- IMAGE (dropped/local) -->
    <template v-else-if="layer.kind === 'image'">
      <span class="text-[10px] uppercase tracking-wide text-white/40 pl-1">Opacity</span>
      <input type="number" min="0" max="100" :value="Math.round((layer.opacity ?? 1) * 100)" title="Opacity"
        class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
        @input="emit('set', { opacity: Math.max(0, Math.min(1, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
    </template>

    <!-- WIRED / generated layer — opacity + blend (transform is via the handles) -->
    <template v-else-if="layer.kind === 'wired'">
      <span class="text-[10px] uppercase tracking-wide text-white/40 pl-1">Opacity</span>
      <input type="number" min="0" max="100" :value="Math.round((layer.opacity ?? 1) * 100)" title="Opacity"
        class="w-11 h-6 bg-white/[0.06] rounded text-[11px] text-center text-white/85 outline-none"
        @input="emit('set', { opacity: Math.max(0, Math.min(1, (parseFloat(($event.target as HTMLInputElement).value) || 0) / 100)) })" />
      <select :value="layer.blend || 'normal'" title="Blend mode"
        class="h-6 bg-white/[0.06] rounded text-[11px] text-white/85 px-1 outline-none cursor-pointer"
        @change="emit('set', { blend: ($event.target as HTMLSelectElement).value })">
        <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
      </select>
      <button class="ll-btn" :class="layer.protect ? 'is-on' : ''"
        title="Protect in blend — keep this layer pixel-exact when a Blend Scene harmonizes the frame"
        @click="emit('set', { protect: !layer.protect })"><Shield class="size-3.5" /></button>
    </template>

    <!-- blend — local layers blend against whatever is below in the stack -->
    <template v-if="layer.kind !== 'wired'">
      <span class="ll-sep" />
      <select :value="layer.blend || 'normal'" title="Blend mode"
        class="h-6 max-w-[72px] bg-white/[0.06] rounded text-[11px] text-white/85 px-1 outline-none cursor-pointer"
        @change="emit('set', { blend: ($event.target as HTMLSelectElement).value })">
        <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ m.replace('_', ' ') }}</option>
      </select>
    </template>

    <!-- z-order — every layer (wired or local) shares one depth stack -->
    <span class="ll-sep" />
    <button class="ll-btn" title="Bring forward" @click="emit('movez', 1)"><ArrowUp class="size-3.5" /></button>
    <button class="ll-btn" title="Send backward" @click="emit('movez', -1)"><ArrowDown class="size-3.5" /></button>
    <!-- delete: local layers only (wired layers are removed by disconnecting) -->
    <button v-if="layer.kind !== 'wired'" class="ll-btn ll-btn--danger" title="Delete" @click="emit('remove')"><Trash2 class="size-3.5" /></button>
  </div>
</template>

<style scoped>
.ll-toolbar { backdrop-filter: blur(6px); }
.ll-btn {
  display: flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.5rem; border-radius: 0.375rem;
  color: rgba(255, 255, 255, 0.6); cursor: pointer;
  transition: color 0.12s ease, background-color 0.12s ease, transform 0.12s ease;
}
.ll-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
.ll-btn:active { transform: scale(0.96); }

/* Strip native spinners + keep changing numbers from jittering the field width. */
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
input[type="number"] { appearance: textfield; -moz-appearance: textfield; font-variant-numeric: tabular-nums; }
.ll-btn.is-on { color: #22d3ee; background: rgba(34, 211, 238, 0.12); }
.ll-btn--danger:hover { color: #fb7185; background: rgba(244, 63, 94, 0.12); }
.ll-sep { width: 1px; height: 1rem; background: rgba(255, 255, 255, 0.12); margin: 0 0.125rem; }
</style>
