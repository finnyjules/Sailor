<script setup lang="ts">
// Color-theory palette picker, shared by the Duotone + Gradient Map surfaces.
// Three panes: a curated harmony gallery, a "from seed color" mode that
// regenerates harmonies live (both COOK their result through toStops/toDuotone,
// which overwrite each color's lightness onto a fixed ramp), and a seed-engine
// shelf of corpus-backed PaletteFamily results applied LITERALLY — see
// paletteEmit.ts — because those hexes were chosen for their own lightness.
import { ref, computed, watch } from 'vue'
import { Palette, Sparkles, Dices, RefreshCw, Minus, Plus } from 'lucide-vue-next'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import {
  HARMONY_TYPES, HARMONY_LABELS, harmonize, toDuotone, toStops,
  type HarmonyType, type GradientStop,
} from '~/lib/color/harmony'
import { CURATED_PALETTES, palettesByType } from '~/lib/color/palettes'
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
}>(), { stopCount: 4, seed: '#4f8ad9' })

const emit = defineEmits<{
  (e: 'apply-duotone', v: { shadow: string; highlight: string }): void
  (e: 'apply-stops', v: GradientStop[]): void
  (e: 'apply-literal-stops', v: GradientStop[]): void
  (e: 'apply-family', v: PaletteFamily): void
}>()

const pane = ref<'gallery' | 'harmony' | 'seed'>('gallery')
const seed = ref(props.seed)
const activeType = ref<HarmonyType>('complementary')
const count = ref(Math.max(2, Math.min(8, props.stopCount)))

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

// The colors generated from the seed for the currently-selected harmony.
const seedColors = computed(() => harmonize(seed.value, activeType.value, activeType.value === 'monochromatic' ? Math.max(3, count.value) : undefined))

/** The swatches shown for a candidate palette — the exact result that applying it yields. */
function preview(colors: string[]): string[] {
  if (props.mode === 'duotone') { const d = toDuotone(colors); return [d.shadow, d.highlight] }
  return toStops(colors, count.value).map(s => s.color)
}

function apply(colors: string[]) {
  if (props.mode === 'duotone') emit('apply-duotone', toDuotone(colors))
  else emit('apply-stops', toStops(colors, count.value))
}

const galleryRows = computed(() =>
  HARMONY_TYPES.map(type => ({ type, label: HARMONY_LABELS[type], palettes: palettesByType(type) }))
    .filter(r => r.palettes.length > 0),
)

const swatchGrad = (colors: string[]) => `linear-gradient(to right, ${colors.join(', ')})`
</script>

<template>
  <div class="flex flex-col gap-2 text-white/80">
    <!-- pane toggle + (stops-only) count stepper -->
    <div class="flex items-center gap-1">
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition"
        :class="pane === 'gallery' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
        @click="pane = 'gallery'"
      ><Palette :size="12" /> Palettes</button>
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition"
        :class="pane === 'harmony' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
        @click="pane = 'harmony'"
      ><Sparkles :size="12" /> From color</button>
      <button
        class="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition"
        :class="pane === 'seed' ? 'bg-white/[0.1] text-white' : 'text-white/50 hover:text-white/80'"
        @click="pane = 'seed'"
      ><Dices :size="12" /> Seed engine</button>
      <div v-if="mode === 'stops'" class="ml-auto flex items-center gap-1 text-[11px] text-white/50">
        <span>Stops</span>
        <button class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="count <= 2" @click="count = Math.max(2, count - 1)"><Minus :size="11" /></button>
        <span class="w-4 text-center tabular-nums text-white/80">{{ count }}</span>
        <button class="rounded border border-white/10 p-0.5 hover:bg-white/10 disabled:opacity-30" :disabled="count >= 8" @click="count = Math.min(8, count + 1)"><Plus :size="11" /></button>
      </div>
    </div>

    <!-- Gallery: curated palettes grouped by harmony -->
    <div v-if="pane === 'gallery'" class="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
      <div v-for="row in galleryRows" :key="row.type">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-white/30">{{ row.label }}</div>
        <div class="grid grid-cols-3 gap-1">
          <button
            v-for="p in row.palettes" :key="p.name" :title="p.name"
            class="h-7 overflow-hidden rounded border border-white/10 transition hover:border-white/30"
            :style="{ background: swatchGrad(preview(p.colors)) }"
            @click="apply(p.colors)"
          />
        </div>
      </div>
    </div>

    <!-- Harmony mode: pick a base color, choose a harmony, apply (cooked toStops/toDuotone) -->
    <div v-else-if="pane === 'harmony'" class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-white/60">Base</span>
        <StudioColor v-model="seed" />
        <div class="ml-auto h-7 flex-1 overflow-hidden rounded border border-white/10" :style="{ background: swatchGrad(preview(seedColors)) }" />
      </div>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="t in HARMONY_TYPES" :key="t"
          class="rounded px-2 py-1 text-[11px] transition"
          :class="activeType === t ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:bg-white/[0.06] hover:text-white/80'"
          @click="activeType = t"
        >{{ HARMONY_LABELS[t] }}</button>
      </div>
      <button
        class="rounded-md border border-white/10 bg-white/[0.04] py-1.5 text-[11px] text-white/80 transition hover:bg-white/[0.08]"
        @click="apply(seedColors)"
      >Apply {{ HARMONY_LABELS[activeType].toLowerCase() }} harmony</button>
    </div>

    <!-- Seed-engine mode: shelf of corpus-backed families, applied LITERALLY (never toStops) -->
    <div v-else class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-white/60">Seed</span>
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
