<!-- frontend/app/components/vue-canvas/compositor/ColourSlots.vue -->
<script setup lang="ts">
// The frame's colours as rows — swatch, hex, opacity — heaviest first (the Figma
// "selection colours" presentation). Editing a row rewrites that colour everywhere
// it is used: the swatch opens the house picker, the hex is typed, the opacity
// field sets one alpha on every use (read-only while the uses disagree).
import { ref, watch } from 'vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import { isHex, parseHexA, withAlpha } from '~/lib/color/convert'

const props = defineProps<{ slots: { hex: string; weight: number; alpha: string | 'mixed' }[] }>()
const emit = defineEmits<{ (e: 'recolour', slotHex: string, toHex: string, alpha?: string): void }>()

const alphaPct = (a: string | 'mixed') => a === 'mixed' ? null : Math.round(parseInt(a, 16) / 255 * 100)
const swatchValue = (s: { hex: string; alpha: string | 'mixed' }) => s.alpha === 'mixed' || s.alpha === 'ff' ? s.hex : withAlpha(s.hex, parseInt(s.alpha, 16) / 255)

// Local drafts so typing does not fight the reactive slot list mid-edit.
const hexDraft = ref<Record<string, string>>({})
const pctDraft = ref<Record<string, string>>({})
watch(() => props.slots, (list) => {
  const h: Record<string, string> = {}, p: Record<string, string> = {}
  for (const s of list) { h[s.hex] = s.hex.slice(1).toUpperCase(); const pc = alphaPct(s.alpha); p[s.hex] = pc == null ? 'Mixed' : String(pc) }
  hexDraft.value = h; pctDraft.value = p
}, { immediate: true })   // the parent hands over a fresh array per change; no deep walk of the sites' closures

function onSwatch(slotHex: string, slotAlpha: string | 'mixed', v: string) {
  const { hex, alpha } = parseHexA(v)                       // 6-digit → alpha 1
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  // Re-picking the colour the slot already has (same hex, same alpha) is not an edit —
  // otherwise closing the picker would push an empty undo step and dirty the document.
  if (hex.toLowerCase() === slotHex && a === (slotAlpha === 'mixed' ? 'ff' : slotAlpha)) return
  emit('recolour', slotHex, hex.toLowerCase(), a === 'ff' ? undefined : a)
}
function commitHex(slotHex: string) {
  const raw = (hexDraft.value[slotHex] ?? '').trim().replace(/^#/, '')
  const candidate = '#' + raw.toLowerCase()
  if (!isHex(candidate) || candidate.length !== 7) { hexDraft.value[slotHex] = slotHex.slice(1).toUpperCase(); return }
  if (candidate === slotHex) return
  emit('recolour', slotHex, candidate)
}
function commitAlpha(slotHex: string, current: string | 'mixed') {
  if (current === 'mixed') return
  const n = Math.round(Number((pctDraft.value[slotHex] ?? '').replace('%', '')))
  if (!Number.isFinite(n) || n < 0 || n > 100) { pctDraft.value[slotHex] = String(alphaPct(current)); return }
  // Compare in PERCENT, the unit the field shows: 155 of the 256 alpha bytes do not survive
  // hex → % → hex, so a tab through an untouched field would otherwise re-emit and dirty the document.
  if (n === alphaPct(current)) return
  const a = Math.round(n / 100 * 255).toString(16).padStart(2, '0')
  if (a === current) return
  emit('recolour', slotHex, slotHex, a)
}
</script>

<template>
  <div class="flex flex-col gap-1" aria-label="Frame colours">
    <div
      v-for="s in slots" :key="s.hex" data-testid="colour-slot" :data-hex="s.hex"
      class="flex h-8 items-center gap-1.5 rounded-md bg-white/[0.04] pl-1.5 pr-1"
    >
      <StudioColor :model-value="swatchValue(s)" @update:model-value="(v: string) => onSwatch(s.hex, s.alpha, v)" />
      <input
        data-testid="colour-slot-hex" type="text" spellcheck="false" :aria-label="`Colour ${s.hex}`"
        class="h-6 min-w-0 flex-1 rounded bg-transparent px-1 font-mono text-[11.5px] uppercase text-white/85 outline-none focus:bg-white/[0.06]"
        v-model="hexDraft[s.hex]" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" @blur="commitHex(s.hex)"
      />
      <div class="flex h-6 w-16 items-center rounded bg-white/[0.04] px-1.5 text-[11.5px] text-white/70">
        <input
          data-testid="colour-slot-alpha" type="text" inputmode="numeric" :aria-label="`Opacity of ${s.hex}`"
          class="w-full min-w-0 bg-transparent text-right outline-none read-only:text-white/40"
          :readonly="s.alpha === 'mixed'" v-model="pctDraft[s.hex]"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" @blur="commitAlpha(s.hex, s.alpha)"
        />
        <span v-if="s.alpha !== 'mixed'" class="ml-0.5 text-white/40">%</span>
      </div>
    </div>
  </div>
</template>
