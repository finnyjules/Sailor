<script setup lang="ts">
// Shared modal chrome for the studio editors (Space Type, Gradient, Shader). Header
// (title · breadcrumb · esc/close, separated from the body by spacing — no divider rule)
// + big preview/actions on the left and a scrollable controls column on the right. No
// vertical rail seam. Change the chrome here and all three editors update.
import { Comment, Fragment, ref, computed, onMounted, onBeforeUnmount, provide, useSlots, type VNode } from 'vue'
import StudioPromptHost from '~/components/prompt/StudioPromptHost.vue'
import StudioToolBar from '~/components/vue-canvas/studio/StudioToolBar.vue'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { STUDIO_PROMPT_KEY, useStudioPrompt, type StudioEffectTargetRequest, type StudioPromptWorker } from '~/composables/useStudioPrompt'
import type { EffectTarget } from '~/composables/useEffectTakes'

// The dock (spec §2.4): under the preview sit the one prompt (StudioPromptHost,
// driven by useStudioPrompt over the studio's own `agent`) and, below it, the
// small shared tool bar (#tools: viewport controls only). Results — three takes,
// a proposed change, an answer — show ABOVE the prompt, never over the controls
// column, which always renders. The prompt api is provided under
// STUDIO_PROMPT_KEY so inspector action rows can reach it. A studio with no
// agent (3D) still gets the prompt by naming its `promptPlace`.
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
// `fullBleedBottomOffset` lifts the dock cluster clear of a surface's own
// bottom overlay (3D Studio's add-pill), in px.
const props = defineProps<{
  title?: string
  breadcrumb?: string
  agent?: StudioPromptWorker | null
  /** The chip: the thing's own name or text (spec §1.2). */
  promptLabel?: string | null
  promptSuggestions?: string[]
  /** Router selection kind, e.g. 'shader-studio'. With no agent (3D), still mounts the prompt. */
  promptPlace?: string
  promptHost?: 'studio' | 'scene3d'
  fullBleed?: boolean
  fullBleedBottomOffset?: number
  /** Stack above another full-screen overlay (e.g. the Timeline editor at z-100)
   *  when this studio is opened OVER it — the clip-in-place editor. Default z-50. */
  elevated?: boolean
  /** Where new effects show in this studio (stage 5: the Shader studio's layer); a string refuses, plainly. */
  effectTarget?: (m: StudioEffectTargetRequest) => EffectTarget | string | null
  /** Called after a worker take is kept, with its request (the Shader studio records a My-effect version). */
  afterTakeKeep?: (request: string) => void
  /** Hide the prompt for now (Shape studio's pen owns the dock while it is open). The prompt
   *  stays mounted (v-show), so a draft survives; the #tools bar still shows. */
  promptHidden?: boolean
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

const hasPrompt = computed(() => !!props.agent || !!props.promptPlace)
// #tools can be filled with v-if'd buttons (Vector type's Play shows only when the
// type moves). A slot that renders only comments draws no empty bar. Called from
// the render, so it re-checks whenever the slot's own conditions change.
const slots = useSlots()
function rendersSomething(nodes: VNode[] | undefined): boolean {
  return !!nodes?.some(n => n.type !== Comment && (n.type !== Fragment || rendersSomething(n.children as VNode[])))
}
const hasTools = () => rendersSomething(slots.tools?.())
const prompt = useStudioPrompt({
  worker: () => props.agent ?? null,
  place: props.promptHost === 'scene3d' ? 'scene3d' : 'studio',
  selectionKind: props.promptPlace ?? 'studio',
  label: () => props.promptLabel ?? null,
  suggestions: () => props.promptSuggestions ?? [],
  effectTarget: m => props.effectTarget?.(m) ?? null,
  // Only a studio that makes new effects (the Shader studio) takes a pasted reference picture.
  takesReference: () => !!props.effectTarget,
  afterKeep: r => props.afterTakeKeep?.(r),
})
provide(STUDIO_PROMPT_KEY, prompt)
// The surface reaches the prompt too: its gallery (outside the shell) starts Make one / Remix.
defineExpose({ prompt })

/** Closing with a take strip open must put the original back FIRST — a studio
 *  saves on close, so leaving a previewed take applied would persist it as if
 *  the user had pressed Keep. Runs before the close emit, and therefore before
 *  the surface's own save. An open effect set (stage 5) is ended the same way,
 *  so a previewed draft effect is never saved (preflight C9). */
function requestClose() {
  props.agent?.abandonTakes?.()
  prompt.endEffects()
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
  // Esc inside the prompt is prevented there (SailorPrompt), so it leaves the
  // prompt without closing the studio — the early return above.
  if (e.key === 'Escape') { e.stopPropagation(); requestClose() }
}
/** ⌘Z right after a take was kept (a click on its tile) puts back what it replaced, as one step.
 *  These studios keep no undo history of their own, so this is the only ⌘Z they answer; it runs
 *  in the capture phase so the canvas behind never also undoes. Anything else passes through. */
function onUndoKey(e: KeyboardEvent) {
  if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
  const el = e.target as Element | null
  if (el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
  if (!prompt.undoKeep()) return
  e.preventDefault()
  e.stopImmediatePropagation()
}
onMounted(() => {
  if (props.fullBleed) {
    try { panelsVisible.value = sessionStorage.getItem(PANELS_KEY) !== '0' } catch { /* private mode */ }
  }
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keydown', onUndoKey, true)
  rootEl.value?.focus()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keydown', onUndoKey, true)
})
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
           floating over it. Every class string on the OFF side is the original, plus
           `relative` on the preview so the working sweep stays inside it.
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
        <div :class="fullBleed ? 'absolute inset-0' : 'flex min-h-0 min-w-0 flex-1 flex-col'">
          <div :data-testid="fullBleed ? 'studio-shell-preview-ground' : undefined"
               :class="fullBleed ? 'absolute inset-0 flex items-center justify-center' : 'relative flex min-h-0 flex-1 items-center justify-center'">
            <slot name="preview" :panels-visible="panelsVisible" />
            <!-- The sweep over the preview while the prompt works (Ruling 10).
                 Always mounted: AgentSweep only starts if it exists before `active`. -->
            <div v-if="hasPrompt" class="pointer-events-none absolute inset-0 z-10"><AgentSweep :active="prompt.working.value" :period="3" palette="lagoon" /></div>
          </div>
          <!-- The dock: the one prompt, and the shared tool bar under it. Full-bleed
               floats it bottom-centre over the viewport, lifted by
               `fullBleedBottomOffset` so a surface's own bottom overlay stays clear;
               boxed stacks it as a flow sibling under the preview. Same capped width. -->
          <template v-if="fullBleed">
            <div v-if="hasPrompt || hasTools()" data-testid="studio-shell-bottom-cluster"
                 class="pointer-events-none absolute left-1/2 z-20 w-full max-w-[640px] -translate-x-1/2 px-4"
                 :style="{ bottom: bottomOffset + 'px' }">
              <div data-testid="studio-shell-dock" class="pointer-events-auto flex flex-col gap-2">
                <StudioPromptHost v-if="hasPrompt" v-show="!promptHidden" :prompt="prompt" />
                <StudioToolBar v-if="hasTools()"><slot name="tools" /></StudioToolBar>
              </div>
            </div>
          </template>
          <div v-else-if="hasPrompt || hasTools()" data-testid="studio-shell-dock" class="mt-3 mb-3 flex w-full max-w-[640px] shrink-0 flex-col gap-2 self-center">
            <StudioPromptHost v-if="hasPrompt" v-show="!promptHidden" :prompt="prompt" />
            <StudioToolBar v-if="hasTools()"><slot name="tools" /></StudioToolBar>
          </div>
        </div>
        <div :data-testid="fullBleed ? 'studio-shell-controls-panel' : undefined"
             :data-hidden="fullBleed ? (panelsVisible ? '0' : '1') : undefined"
             :class="fullBleed
               ? [PANEL_BASE, 'right-4 flex flex-col gap-2 overflow-y-auto p-3', panelsVisible ? SHOWN : HIDE_RIGHT]
               : 'flex w-72 shrink-0 flex-col gap-2 overflow-y-auto pr-1 min-h-0'">
          <slot name="controls" />
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
