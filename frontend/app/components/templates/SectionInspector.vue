<script setup lang="ts">
/**
 * Inspector for a selected Section — a frame-inside-a-frame. Shows the frame's
 * appearance (fill / stroke / corner radius) and an auto-layout toggle that
 * reveals the layout controls (direction / gap / padding / alignment) and
 * per-child sizing. Injected from GridEditorShell via 'gridEditor'; renders
 * whenever a section is selected (any section, not just auto-layout ones).
 */
import { Frame } from 'lucide-vue-next'

import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import type { GridEditorContext } from '~/composables/useGridEditor'

const ctx = inject<GridEditorContext>('gridEditor')!
const {
  selectedSection, setSectionStyle, setSectionClip, toggleSectionLayout, updateStackLayout, updateChildSizing,
  toggleSectionExpressive, setSectionExpressive,
} = ctx

const section = selectedSection

const labelCls = 'panel-label'
const btnRowCls = 'flex-1 h-7 rounded text-[11px] transition-colors cursor-pointer'
function activeBtnCls(active: boolean) {
  return active ? 'bg-white/15 text-white' : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08]'
}

const hasLayout = computed(() => section.value?.layout != null)
const expr = computed(() => section.value?.expressive)
const hasExpressive = computed(() => expr.value != null)
function setExpr(p: Record<string, unknown>) { if (section.value) setSectionExpressive(section.value.id, p as any) }
function rerollExpr() { if (section.value?.expressive) setExpr({ seed: (section.value.expressive.seed | 0) + 1 }) }
const st = computed(() => section.value?.style ?? {})
const fillHex = computed(() => (/^#[0-9a-f]{6}$/i.test(st.value.fill ?? '') ? st.value.fill! : '#000000'))
const strokeHex = computed(() => (/^#[0-9a-f]{6}$/i.test(st.value.stroke ?? '') ? st.value.stroke! : '#ffffff'))

function patch(p: Partial<NonNullable<typeof st.value>>) { if (section.value) setSectionStyle(section.value.id, p) }

const paddingVal = computed(() => section.value?.layout?.padding?.top ?? 0)
function clamp12(raw: number) { return Math.max(0, Math.min(12, Number(raw))) }
function onGap(v: number) { if (section.value) updateStackLayout(section.value.id, { gap: clamp12(v) }) }
function onPadding(v: number) {
  if (!section.value) return
  const p = clamp12(v)
  updateStackLayout(section.value.id, { padding: { top: p, right: p, bottom: p, left: p } })
}
</script>

<template>
  <div v-if="section" class="h-full overflow-y-auto p-3 flex flex-col gap-2.5">
    <!-- Header -->
    <div class="flex items-center gap-2">
      <Frame class="size-3.5 text-white/45 shrink-0" />
      <span class="text-[12px] text-white font-medium truncate">{{ section.name }}</span>
      <span class="text-[10px] text-white/30 shrink-0">Section</span>
    </div>

    <TemplatesAlignControls />

    <!-- Frame appearance -->
    <StudioSection title="Frame">
      <!-- Fill -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <p :class="labelCls">Fill</p>
          <button v-if="st.fill" class="text-[10px] text-white/45 hover:text-white cursor-pointer" @click="patch({ fill: undefined })">Clear</button>
        </div>
        <div class="flex items-center gap-2">
          <input
            type="color" :value="fillHex" title="Fill colour"
            class="h-7 w-8 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
            @input="(e: any) => patch({ fill: e.target.value })"
          >
          <input
            :value="st.fill" placeholder="none  ·  #111 or gradient"
            class="h-7 w-full rounded border border-white/[0.06] bg-white/[0.04] px-2 text-[11px] text-white focus:border-white/30 focus:outline-none"
            @change="(e: any) => patch({ fill: e.target.value || undefined })"
          >
        </div>
      </div>

      <!-- Stroke -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <p :class="labelCls">Stroke</p>
          <button v-if="st.stroke" class="text-[10px] text-white/45 hover:text-white cursor-pointer" @click="patch({ stroke: undefined })">Clear</button>
        </div>
        <div class="flex items-center gap-2">
          <input
            type="color" :value="strokeHex" title="Stroke colour"
            class="h-7 w-8 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
            @input="(e: any) => patch({ stroke: e.target.value })"
          >
          <input
            :value="st.stroke" placeholder="none  ·  #fff"
            class="h-7 flex-1 min-w-0 rounded border border-white/[0.06] bg-white/[0.04] px-2 text-[11px] text-white focus:border-white/30 focus:outline-none"
            @change="(e: any) => patch({ stroke: e.target.value || undefined })"
          >
          <input
            type="number" min="0" :value="st.strokeWidth ?? 1" title="Stroke width (px)"
            class="h-7 w-12 shrink-0 rounded border border-white/[0.06] bg-white/[0.04] px-1.5 text-[11px] text-center text-white tabular-nums focus:border-white/30 focus:outline-none"
            @change="(e: any) => patch({ strokeWidth: Math.max(0, Number(e.target.value)) })"
          >
        </div>
      </div>

      <!-- Corner radius -->
      <StudioSlider
        label="Corner radius" :min="0" :max="80" :step="1" :bindable="false"
        :model-value="st.radius ?? 0" @update:model-value="(v) => patch({ radius: Math.max(0, v) })"
      />

      <!-- Clip content -->
      <button
        class="flex items-center gap-2 w-full text-left cursor-pointer"
        title="Clip children to the frame bounds, like a Figma frame"
        @click="setSectionClip(section.id, !section.clip)"
      >
        <span
          class="size-4 shrink-0 rounded-[4px] border flex items-center justify-center transition-colors"
          :class="section.clip ? 'bg-[#34D399] border-[#34D399] text-[#06281d]' : 'border-white/25 text-transparent'"
        >
          <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span class="text-[12px] text-white/80">Clip content</span>
      </button>
    </StudioSection>

    <!-- Auto-layout toggle -->
    <StudioSection title="Auto-layout">
      <div class="flex gap-1">
        <button
          :class="[btnRowCls, activeBtnCls(!hasLayout)]"
          @click="toggleSectionLayout(section.id, false)"
        >Off</button>
        <button
          :class="[btnRowCls, activeBtnCls(hasLayout)]"
          @click="toggleSectionLayout(section.id, true)"
        >On</button>
      </div>

      <template v-if="hasLayout">
        <div>
          <p :class="labelCls" class="mb-1.5 mt-1">Direction</p>
          <div class="flex gap-1">
            <button
              :class="[btnRowCls, activeBtnCls(section.layout?.direction === 'vertical')]"
              @click="updateStackLayout(section.id, { direction: 'vertical' })"
            >Vertical</button>
            <button
              :class="[btnRowCls, activeBtnCls(section.layout?.direction === 'horizontal')]"
              @click="updateStackLayout(section.id, { direction: 'horizontal' })"
            >Horizontal</button>
          </div>
        </div>

        <StudioSlider
          label="Gap" :min="0" :max="12" :step="1" :bindable="false"
          :model-value="section.layout?.gap ?? 0" @update:model-value="onGap"
        />

        <StudioSlider
          label="Padding" :min="0" :max="12" :step="1" :bindable="false"
          :model-value="paddingVal" @update:model-value="onPadding"
        />

        <div>
          <p :class="labelCls" class="mb-1.5">Main align</p>
          <div class="flex gap-1">
            <button
              v-for="a in (['start', 'center', 'end', 'space-between'] as const)" :key="a"
              :class="[btnRowCls, activeBtnCls(section.layout?.mainAlign === a)]"
              @click="updateStackLayout(section.id, { mainAlign: a })"
            >{{ a === 'space-between' ? '⇔' : a }}</button>
          </div>
        </div>

        <div>
          <p :class="labelCls" class="mb-1.5">Cross align</p>
          <div class="flex gap-1">
            <button
              v-for="a in (['start', 'center', 'end', 'stretch'] as const)" :key="a"
              :class="[btnRowCls, activeBtnCls(section.layout?.crossAlign === a)]"
              @click="updateStackLayout(section.id, { crossAlign: a })"
            >{{ a }}</button>
          </div>
        </div>
      </template>
    </StudioSection>

    <!-- Expressive placement (scatter children) -->
    <StudioSection title="Expressive placement">
      <div class="flex gap-1">
        <button :class="[btnRowCls, activeBtnCls(!hasExpressive)]" @click="toggleSectionExpressive(section.id, false)">Off</button>
        <button :class="[btnRowCls, activeBtnCls(hasExpressive)]" @click="toggleSectionExpressive(section.id, true)">On</button>
      </div>
      <template v-if="expr">
        <div class="mt-1">
          <p :class="labelCls" class="mb-1.5">Placement</p>
          <div class="grid grid-cols-2 gap-1">
            <button
              v-for="p in (['scatter', 'grid', 'pile', 'corners'] as const)" :key="p"
              :class="[btnRowCls, activeBtnCls(expr.placement === p)]"
              @click="setExpr({ placement: p })"
            >{{ p }}</button>
          </div>
        </div>
        <div v-if="expr.placement === 'grid'">
          <p :class="labelCls" class="mb-1">Columns · {{ expr.columns || 'auto' }}</p>
          <div class="flex items-center gap-2">
            <input type="range" min="0" max="8" step="1" :value="expr.columns ?? 0" class="flex-1"
              @input="(e: any) => setExpr({ columns: Number(e.target.value) || undefined })">
            <span class="text-[11px] text-white/50 tabular-nums w-8">{{ expr.columns || 'auto' }}</span>
          </div>
        </div>
        <StudioSlider label="Jitter" :min="0" :max="1" :step="0.05" :bindable="false"
          :model-value="expr.jitter" @update:model-value="(v) => setExpr({ jitter: v })" />
        <StudioSlider label="Rotation" :min="0" :max="1" :step="0.05" :bindable="false"
          :model-value="expr.rotation" @update:model-value="(v) => setExpr({ rotation: v })" />
        <div>
          <p :class="labelCls" class="mb-1">Justify (spread to edges)</p>
          <div class="flex gap-1">
            <button :class="[btnRowCls, activeBtnCls(!!expr.justifyX)]" @click="setExpr({ justifyX: !expr.justifyX })">Horizontal</button>
            <button :class="[btnRowCls, activeBtnCls(!!expr.justifyY)]" @click="setExpr({ justifyY: !expr.justifyY })">Vertical</button>
          </div>
        </div>
        <button :class="[btnRowCls, 'w-full mt-1 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]']" @click="rerollExpr()">⟳ Reroll</button>
      </template>
    </StudioSection>

    <!-- Per-child sizing (auto-layout only) -->
    <StudioSection v-if="hasLayout" title="Children">
      <div v-for="child in section.children" :key="child.id" class="flex items-center gap-2">
        <span class="text-[11px] text-white/50 truncate flex-1 min-w-0">{{ child.id }}</span>
        <div class="flex gap-0.5 shrink-0">
          <button
            v-for="mode in (['hug', 'fill', 'fixed'] as const)" :key="mode"
            class="px-1.5 h-6 rounded text-[10px] transition-colors cursor-pointer"
            :class="(child.layoutSizing?.main ?? 'hug') === mode
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-white/[0.04] text-white/40 hover:bg-white/[0.08]'"
            :title="`Main size: ${mode}`"
            @click="updateChildSizing(section.id, child.id, { main: mode, cross: child.layoutSizing?.cross ?? 'fill' })"
          >{{ mode }}</button>
        </div>
      </div>
      <p v-if="!section.children.length" class="text-[11px] text-white/30">No children yet.</p>
    </StudioSection>
  </div>
</template>
