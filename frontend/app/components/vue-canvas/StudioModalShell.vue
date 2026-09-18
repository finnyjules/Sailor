<script setup lang="ts">
// Shared modal chrome for the studio editors (Space Type, Gradient, Shader). Header
// (title · breadcrumb · esc/close, separated from the body by spacing — no divider rule)
// + big preview/actions on the left and a scrollable controls column on the right. No
// vertical rail seam. Change the chrome here and all three editors update.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AgentBar from '~/components/agent/AgentBar.vue'
import AgentProgress from '~/components/agent/AgentProgress.vue'
import AgentProposal from '~/components/agent/AgentProposal.vue'
import TakeStrip from '~/components/vue-canvas/studio/TakeStrip.vue'

// `agent` is the useStudioAgent() return (an object of refs + actions). When
// provided, the shell renders a bare prompt docked under the preview and lets the
// agent's progress / proposal take over the controls column — the same layout the
// Compositor uses, so every studio behaves consistently.
//
// Sizing is uniform across every studio. The frame started at 1400×820 (an opt-in
// for 3D Studio's object list that graduated to the default), then grew to 1600×900
// (caps 96vw × 94vh) — the extra preview room helps every editor, and one size keeps
// the studios from feeling like different apps when you move between them.
//
// `fullBleed` (opt-in, default OFF) swaps the boxed three-column body for one
// full-bleed viewport: #preview becomes the ground layer (absolute inset-0) and
// the aside / controls columns float over it as glass panels, Compositor-style.
// Every studio that does NOT pass it renders the exact same DOM as before —
// the off path below is untouched, branch by branch, on purpose.
// `fullBleedBottomOffset` lifts the takes+agent cluster clear of a surface's own
// bottom overlay (3D Studio's add-pill), in px.
const props = defineProps<{
  title?: string
  breadcrumb?: string
  agent?: any
  agentPlaceholder?: string
  fullBleed?: boolean
  fullBleedBottomOffset?: number
  /** Stack above another full-screen overlay (e.g. the Timeline editor at z-100)
   *  when this studio is opened OVER it — the clip-in-place editor. Default z-50. */
  elevated?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const bottomOffset = computed(() => props.fullBleedBottomOffset ?? 16)

// ── Hideable chrome (⌘\), fullBleed only ────────────────────────────────────
// Both floating panels slide out together, exactly like the Compositor's: the
// content is never unmounted (scroll position, open sections and in-flight
// edits survive a hide/show), and the viewport does NOT reflow because the
// panels never occupied layout space in the first place. Per-session, read in
// onMounted so SSR and the client agree.
const PANELS_KEY = 'sailor:studio:panels'
const panelsVisible = ref(true)
function setPanelsVisible(v: boolean) {
  panelsVisible.value = v
  try { sessionStorage.setItem(PANELS_KEY, v ? '1' : '0') } catch { /* private mode / SSR */ }
}

// Glass panel chrome shared by the two floating columns. Split from the
// per-side classes so left/right differ only in edge + slide direction.
const PANEL_BASE = 'absolute top-4 bottom-4 z-20 w-72 rounded-xl border border-white/10 bg-[#0e0e10]/80 backdrop-blur-md shadow-2xl transition-all duration-200 ease-out'
const HIDE_LEFT = '-translate-x-[130%] opacity-0 pointer-events-none'
const HIDE_RIGHT = 'translate-x-[130%] opacity-0 pointer-events-none'
const SHOWN = 'translate-x-0 opacity-100'

const agentActive = computed(() => {
  const a = props.agent
  return !!a && (a.busy.value || a.reviewing?.value || a.hasProposal.value)
})

// Four Takes: the filmstrip is mounted ONCE, here, so every studio that hands the
// shell a `useStudioAgent` gets it — there is no per-studio strip to drift. An
// agent without the take session (Space Type's bespoke vibe flow, which supplies
// its own #agentBar and no `agent` at all; Texture's structural command agent)
// simply reports false and the shell is unchanged for it.
const hasTakes = computed(() => !!props.agent?.hasTakes?.value)

/** Closing with a take strip open must put the original back FIRST — a studio
 *  saves on close, so leaving a previewed take applied would persist it as if
 *  the user had pressed Keep. Runs before the close emit, and therefore before
 *  the surface's own save. */
function requestClose() {
  props.agent?.abandonTakes?.()
  emit('close')
}

const rootEl = ref<HTMLElement | null>(null)
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  // ⌘\ toggles the floating panels — only meaningful in fullBleed, where there
  // ARE floating panels. Allowed while typing (backslash means nothing to a text
  // field, and someone who hid the chrome then clicked into a prompt must be able
  // to bring it back), same rule as the Compositor's.
  if (props.fullBleed && (e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault(); e.stopPropagation()
    setPanelsVisible(!panelsVisible.value)
    return
  }
  if (e.key === 'Escape') { e.stopPropagation(); requestClose() }
}
onMounted(() => {
  if (props.fullBleed) {
    try { panelsVisible.value = sessionStorage.getItem(PANELS_KEY) !== '0' } catch { /* private mode */ }
  }
  window.addEventListener('keydown', onKeydown)
  rootEl.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="fixed inset-0 flex items-center justify-center bg-black/70" :class="elevated ? 'z-[110]' : 'z-50'">
    <div ref="rootEl" tabindex="-1" role="dialog" aria-modal="true"
         class="flex h-[900px] max-h-[94vh] w-[1600px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e10] text-white outline-none">
      <div class="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
        <span class="text-[13px] font-medium tracking-[-0.01em] text-white/90">{{ title }}</span>
        <template v-if="breadcrumb">
          <span class="text-xs text-white/25">/</span>
          <span class="text-xs text-white/50">{{ breadcrumb }}</span>
        </template>
        <span class="flex-1"></span>
        <span class="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/30">esc</span>
        <button type="button" aria-label="Close" @click="requestClose()"
                class="text-white/45 transition-colors hover:text-white/80">✕</button>
      </div>
      <!-- Body. Boxed (default): three columns in a row. Full-bleed (opt-in): one
           positioned area, the preview underneath everything and the columns
           floating over it. Every class string on the OFF side is the original.
           --studio-panel-inset is the ONE source for "clear of a floating panel":
           left-4 (16) + w-72 (288) + 12 gap — surfaces position overlays with it
           (left-[var(--studio-panel-inset)]) so a panel resize can't desync them. -->
      <div :class="fullBleed ? 'relative min-h-0 flex-1 overflow-hidden' : 'flex min-h-0 flex-1 gap-4 p-4'"
           :style="fullBleed ? { '--studio-panel-inset': '316px' } : undefined">
        <!-- Optional dedicated panel column (e.g. 3D Studio's object list), on the
             left of the preview — mirrors the Smart Layout / Frame layers panel. -->
        <div v-if="$slots.aside"
             :data-testid="fullBleed ? 'studio-shell-aside-panel' : undefined"
             :data-hidden="fullBleed ? (panelsVisible ? '0' : '1') : undefined"
             :class="fullBleed
               ? [PANEL_BASE, 'left-4 flex overflow-hidden', panelsVisible ? SHOWN : HIDE_LEFT]
               : 'flex w-72 shrink-0 min-h-0'"><slot name="aside" /></div>
        <div :class="fullBleed ? 'absolute inset-0' : 'flex min-h-0 flex-1 flex-col'">
          <div :data-testid="fullBleed ? 'studio-shell-preview-ground' : undefined"
               :class="fullBleed ? 'absolute inset-0 flex items-center justify-center' : 'flex min-h-0 flex-1 items-center justify-center'">
            <slot name="preview" :panels-visible="panelsVisible" />
          </div>
          <!-- Full-bleed: the takes strip + agent bar float bottom-centre over the
               viewport as one cluster, lifted by `fullBleedBottomOffset` so a
               surface with its own bottom overlay can clear it. Same components,
               same capped width as the boxed path below — written out separately
               rather than class-switched because the boxed path stacks them as
               flow siblings and this one stacks them inside one absolute box. -->
          <template v-if="fullBleed">
            <div v-if="hasTakes || agent || $slots.agentBar"
                 data-testid="studio-shell-bottom-cluster"
                 class="pointer-events-none absolute left-1/2 z-20 w-full max-w-[640px] -translate-x-1/2 px-4"
                 :style="{ bottom: bottomOffset + 'px' }">
              <div v-if="hasTakes" class="pointer-events-auto mb-2">
                <TakeStrip
                  :takes="agent.takes.value" :thumbs="agent.takeThumbs.value"
                  :current="agent.takeCurrentThumb.value" :selected="agent.selectedTake.value"
                  :busy="agent.busy.value"
                  :reviewing="agent.reviewingTakes?.value"
                  @hover="agent.previewTake" @select="agent.selectTake"
                  @keep="agent.keepTake" @dismiss="agent.dismissTakes"
                  @more-directions="agent.moreDirections"
                />
              </div>
              <div v-if="agent || $slots.agentBar" class="pointer-events-auto">
                <slot name="agentBar">
                  <AgentBar
                    :busy="agent.busy.value" :error="agent.error.value" :notice="agent.notice.value"
                    :chips="[]" :placeholder="agentPlaceholder"
                    @submit="agent.ask" @chip="agent.ask"
                  />
                </slot>
              </div>
            </div>
          </template>
          <template v-else>
          <!-- Agent prompt: bare (no container), docked under the preview — mirrors
               the Compositor. Its output renders in the controls column at right.
               A studio with a bespoke agent (Space Type's vibe flow) provides its own
               bar via the #agentBar slot, so it lands in this SAME centred position
               instead of floating in the controls column. -->
          <!-- Capped width + centred, matching the canvas prompt bar's proportions rather
               than stretching the full preview column, and `mb-3` so it lifts off the very
               bottom edge. Applies to every studio's bar, the default AgentBar included. -->
          <!-- The take filmstrip sits directly under the preview, above the bar
               that produced it: four readings of the last request, with the
               current look pinned first. Same capped width as the bar. -->
          <div v-if="hasTakes" class="mt-3 w-full max-w-[640px] self-center shrink-0">
            <TakeStrip
              :takes="agent.takes.value" :thumbs="agent.takeThumbs.value"
              :current="agent.takeCurrentThumb.value" :selected="agent.selectedTake.value"
              :busy="agent.busy.value"
              :reviewing="agent.reviewingTakes?.value"
              @hover="agent.previewTake" @select="agent.selectTake"
              @keep="agent.keepTake" @dismiss="agent.dismissTakes"
              @more-directions="agent.moreDirections"
            />
          </div>
          <div v-if="agent || $slots.agentBar" class="mt-3 mb-3 w-full max-w-[640px] self-center shrink-0">
            <slot name="agentBar">
              <AgentBar
                :busy="agent.busy.value" :error="agent.error.value" :notice="agent.notice.value"
                :chips="[]" :placeholder="agentPlaceholder"
                @submit="agent.ask" @chip="agent.ask"
              />
            </slot>
          </div>
          </template>
        </div>
        <div :data-testid="fullBleed ? 'studio-shell-controls-panel' : undefined"
             :data-hidden="fullBleed ? (panelsVisible ? '0' : '1') : undefined"
             :class="fullBleed
               ? [PANEL_BASE, 'right-4 flex flex-col gap-2 overflow-y-auto p-3', panelsVisible ? SHOWN : HIDE_RIGHT]
               : 'flex w-72 shrink-0 flex-col gap-2 overflow-y-auto pr-1 min-h-0'">
          <!-- Assistant takeover: the agent's progress / proposal replace the controls
               while it's working, then hand back the controls when done. -->
          <template v-if="agentActive">
            <div class="flex items-center gap-2 pb-1">
              <span class="text-white/70">✦</span>
              <span class="text-sm font-medium">Assistant</span>
            </div>
            <AgentProgress v-if="agent.busy.value" :active="agent.busy.value" />
            <div v-else-if="agent.reviewing?.value && !agent.hasProposal.value" class="flex items-center gap-1.5 text-[11.5px] text-white/55">
              <span class="text-white/75">✦</span> Analyzing the result for imperfections<span class="animate-pulse">…</span>
            </div>
            <AgentProposal
              v-else-if="agent.hasProposal.value"
              :changes="agent.changes.value" :busy="agent.busy.value" :issues="agent.issues?.value"
              :review="agent.review.value" :reviewing="agent.reviewing?.value"
              @accept="agent.acceptChange" @reject="agent.rejectChange" @reroll="agent.reroll"
              @keep="agent.keep" @revert="agent.revert" @hover="(i: number | null) => agent.hovered.value = i"
            />
          </template>
          <slot v-else name="controls" />
        </div>
      </div>
      <!-- The modal's bottom is reserved for actions: a full-width footer, hairline-topped,
           with the buttons docked to the right. Every studio's Save / Render / Send-to-canvas
           lands here via #actions, in the same place, instead of under the preview or floating
           in the controls column. -->
      <div v-if="$slots.actions" class="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
