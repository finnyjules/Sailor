<script setup lang="ts">
// Color-theory palette picker, shared by the Duotone + Gradient Map surfaces.
// Three panes: a curated harmony gallery, a "from seed color" mode that
// regenerates harmonies live (both COOK their result through toStops/toDuotone,
// which overwrite each color's lightness onto a fixed ramp), and a seed-engine
// shelf of corpus-backed PaletteFamily results applied LITERALLY — see
// paletteEmit.ts — because those hexes were chosen for their own lightness.
import { ref, computed, watch } from 'vue'
import { Palette, Library, RefreshCw, Minus, Plus } from 'lucide-vue-next'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import {
  HARMONY_TYPES, HARMONY_LABELS, harmonize, toDuotone, toStops,
  type GradientStop,
} from '~/lib/color/harmony'
import { hexToOklch } from '~/lib/color/convert'
import { seedShelf } from '~/lib/color/seedEngine'
import type { PaletteFamily, Character } from '~/lib/color/seedFamily'
import { familyToStops } from './paletteEmit'

const props = withDefaults(defineProps<{
  mode: 'duotone' | 'stops'
  /** Stops requested in 'stops' mode. */
  stopCount?: number
  /** Initial seed for the "from color" pane. */
  seed?: string
  /** Hide the Stops count stepper: the host edits stops manually (add/remove), so
   *  the generators just match the current stop count instead of a separate dial. */
  manualStops?: boolean
}>(), { stopCount: 4, seed: '#4f8ad9', manualStops: false })

const emit = defineEmits<{
  (e: 'apply-duotone', v: { shadow: string; highlight: string }): void
  (e: 'apply-stops', v: GradientStop[]): void
  (e: 'apply-literal-stops', v: GradientStop[]): void
  (e: 'apply-family', v: PaletteFamily): void
}>()

const pane = ref<'harmony' | 'seed'>('harmony')
const seed = ref(props.seed)
const count = ref(Math.max(2, Math.min(8, props.stopCount)))
// When the host manages stops manually, follow its live stop count so a generated
// palette matches what's already there (there's no stepper to set it here).
watch(() => props.stopCount, (n) => { if (props.manualStops) count.value = Math.max(2, Math.min(8, n)) })

// --- Seed-engine pane: a shelf of PaletteFamily results from the corpus-backed
// seed engine, applied LITERALLY (see paletteEmit.ts) rather than through the
// lightness-overwriting toStops/toDuotone used by the gallery/harmony panes above.
const CHARACTERS: Character[] = ['any', 'muted', 'vivid', 'dark', 'light', 'warm', 'cool']
const seedA = ref(props.seed)
const seedB = ref<string | null>(null)
const seedBModel = computed<string>({
  get: () => seedB.value ?? seedA.value,
  set: v => { seedB.value = v },
})
const char = ref<Character>('any')
const page = ref(0)
const shelf = ref<PaletteFamily[]>([])
async function refreshShelf() {
  shelf.value = await seedShelf({ seedA: seedA.value, seedB: seedB.value, char: char.value, page: page.value }, 12)
}
watch([seedA, seedB, char, page], refreshShelf, { immediate: false })
let seedPaneVisited = false
watch(pane, p => {
  if (p === 'seed' && !seedPaneVisited) { seedPaneVisited = true; refreshShelf() }
})

/** The two colors a duotone consumer gets from a family — darkest + lightest, verbatim. */
function familyDuotone(hexes: string[]): { shadow: string; highlight: string } {
  const byL = [...hexes].sort((a, b) => hexToOklch(a)[0] - hexToOklch(b)[0])
  return { shadow: byL[0]!, highlight: byL[byL.length - 1]! }
}

/** Swatches for a shelf tile — the exact literal result that applying it yields. */
function familyPreview(fam: PaletteFamily): string[] {
  if (props.mode === 'duotone') { const d = familyDuotone(fam.hexes); return [d.shadow, d.highlight] }
  return familyToStops(fam.hexes).map(s => s.color)
}

function applyFamily(fam: PaletteFamily) {
  if (props.mode === 'duotone') emit('apply-duotone', familyDuotone(fam.hexes))
  else emit('apply-literal-stops', familyToStops(fam.hexes))
  emit('apply-family', fam)
}

// Every harmony type generated from the base colour — the "Harmony" grid folds
// the old curated gallery + "from color" pane into one live-from-your-colour set.
const harmonyGrid = computed(() => HARMONY_TYPES.map(t => ({
  type: t,
  label: HARMONY_LABELS[t],
  colors: harmonize(seed.value, t, t === 'monochromatic' ? Math.max(3, count.value) : undefined),
})))
const paneHint = computed(() => (pane.value === 'harmony'
  ? 'A gradient built from one colour, using colour theory.'
  : 'Ready-made palettes from a library, filtered by mood.'))

/** The swatches shown for a candidate palette — the exact result that applying it yields. */
function preview(colors: string[]): string[] {
  if (props.mode === 'duotone') { const d = toDuotone(colors); return [d.shadow, d.highlight] }
  return toStops(colors, count.value).map(s => s.color)
}

function apply(colors: string[]) {
  if (props.mode === 'duotone') emit('apply-duotone', toDuotone(colors))
  else emit('apply-stops', toStops(colors, count.value))
}

const swatchGrad = (colors: string[]) => `linear-gradient(to right, ${colors.join(', ')})`
</script>

<template>
  <div class="flex flex-col gap-2 text-white/80">
    <!-- Stops count (first) + the two generators. Wraps rather than clipping. -->
    <div class="flex flex-wrap items-center gap-1">
      <div v-if="mode === 'stops' && !manualStops" class="flex items-center gap-1 rounded bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-white/50">
        <span>Stops</span>
        <button class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="count <= 2" @click="count = Math.max(2, count - 1)"><Minus :size="11" /></button>
        <span class="w-4 text-center tabular-nums text-white/80">{{ count }}</span>
        <button class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="count >= 8" @click="count = Math.min(8, count + 1)"><Plus :size="11" /></button>
      </div>
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition"
        :class="pane === 'harmony' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
        @click="pane = 'harmony'"
      ><Palette :size="12" /> Harmony</button>
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition"
        :class="pane === 'seed' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
        @click="pane = 'seed'"
      ><Library :size="12" /> Library</button>
    </div>
    <p class="-mt-1 text-[10px] leading-snug text-white/35">{{ paneHint }}</p>

    <!-- Harmony: a base colour → a grid of colour-theory harmonies generated from it
         (folds the old curated gallery + "from color" panes into one). -->
    <div v-if="pane === 'harmony'" class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-white/60">Base</span>
        <StudioColor v-model="seed" />
      </div>
      <div class="grid grid-cols-2 gap-1">
        <button
          v-for="h in harmonyGrid" :key="h.type" :title="h.label"
          class="relative h-9 overflow-hidden rounded border border-white/10 transition hover:border-white/30"
          :style="{ background: swatchGrad(preview(h.colors)) }"
          @click="apply(h.colors)"
        >
          <span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-0.5 pt-2 text-left text-[9px] font-medium text-white/90">{{ h.label }}</span>
        </button>
      </div>
    </div>

    <!-- Library: shelf of corpus-backed families, applied LITERALLY (never toStops) -->
    <div v-else class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-white/60">Near</span>
        <StudioColor v-model="seedA" />
        <template v-if="seedB !== null">
          <span class="text-[11px] text-white/30">+</span>
          <StudioColor v-model="seedBModel" />
          <button class="rounded p-0.5 text-white/30 hover:text-white/70" title="Remove second seed" @click="seedB = null"><Minus :size="11" /></button>
        </template>
        <button
          v-else
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/40 transition hover:text-white/70"
          @click="seedB = seedA"
        ><Plus :size="10" /> 2nd seed</button>
        <button
          class="ml-auto rounded border border-white/10 p-1 text-white/50 transition hover:bg-white/10 hover:text-white/80"
          title="Reroll"
          @click="page++"
        ><RefreshCw :size="12" /></button>
      </div>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="c in CHARACTERS" :key="c"
          class="rounded px-2 py-1 text-[11px] capitalize transition"
          :class="char === c ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:bg-white/[0.06] hover:text-white/80'"
          @click="char = c"
        >{{ c }}</button>
      </div>
      <div class="grid max-h-56 grid-cols-3 gap-1 overflow-y-auto pr-1">
        <button
          v-for="(fam, i) in shelf" :key="i"
          class="h-7 overflow-hidden rounded border border-white/10 transition hover:border-white/30"
          :style="{ background: swatchGrad(familyPreview(fam)) }"
          @click="applyFamily(fam)"
        />
      </div>
      <div v-if="shelf.length === 0" class="py-2 text-center text-[11px] text-white/30">Loading…</div>
    </div>
  </div>
</template>
