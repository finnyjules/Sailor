<script setup lang="ts">
import { SkipBack, RotateCcw, Play, Pause } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import { initialTicks, continueLabel, viewUrl, isVideoFile } from '~/lib/runner/gateChoices'
import { isRunnerPromptId } from '#shared/runner/messages'
import { useNodeGlass } from '~/composables/useCanvasGlass'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties: Record<string, any>
    mode: number
    paused?: boolean
    promptId?: string
    running?: boolean
    error?: boolean
    choices?: { take: number; files: { filename: string; subfolder: string; type: string }[] }[] | null
    picked?: number[]
    runnerRunId?: string | null
  }
}>()

// bypass is the first widget value (index 0, matching the "bypass" Boolean input)
const isBypassed = computed(() => !!props.data.widgetsValues?.[0])

const accentColor = computed(() => {
  const firstOutput = props.data.outputs?.[0]
  if (firstOutput) return getTypeColor(firstOutput.type)
  const firstInput = props.data.inputs?.[0]
  if (firstInput) return getTypeColor(firstInput.type)
  return '#6b7280'
})

const borderColorLeft = computed(() => {
  const firstInput = props.data.inputs?.[0]
  return firstInput ? getTypeColor(firstInput.type) : '#ffffff'
})
const borderColorRight = computed(() => {
  const firstOutput = props.data.outputs?.[0]
  return firstOutput ? getTypeColor(firstOutput.type) : '#ffffff'
})

function toggleBypass() {
  const vals = props.data.widgetsValues
  if (vals) vals[0] = !vals[0]
}

// Real blur behind the glass shell when the canvas asks for it (data-glass-blur).
const glass = useNodeGlass(() => props.id)

const isRunner = computed(() => isRunnerPromptId(props.data.promptId))
const choices = computed(() => props.data.choices ?? [])
const ticked = ref<number[]>(initialTicks(props.data.choices, props.data.picked))
watch(() => props.data.choices, () => { ticked.value = initialTicks(props.data.choices, props.data.picked) })
function toggleTick(take: number) {
  ticked.value = ticked.value.includes(take) ? ticked.value.filter(t => t !== take) : [...ticked.value, take].sort((a, b) => a - b)
}
// A finished runner run keeps its pictures, so Continue can make another
// video from the same picture ("Continue after the run has finished").
const showActions = computed(() => !isBypassed.value && (!!props.data.paused
  || (isRunner.value && !props.data.running && choices.value.length > 0)))
const canContinue = computed(() => !props.data.paused || choices.value.length <= 1 || ticked.value.length > 0)

// The layout refuses a runner Gate action by sending this back; put the pause
// back so the pictures and buttons return.
let wasPaused = false
function onActionFailed(e: Event) {
  if ((e as CustomEvent).detail?.nodeId === props.id && wasPaused) props.data.paused = true
}
onMounted(() => window.addEventListener('sailor:runnerGateActionFailed', onActionFailed))
onBeforeUnmount(() => window.removeEventListener('sailor:runnerGateActionFailed', onActionFailed))

async function resumeGate(action: 'continue' | 'redo' | 'restart') {
  const fromPause = !!props.data.paused
  // A Gate pauses only inside a runner run (step 4, C5: no local engine runs one).
  if (!isRunner.value) return
  wasPaused = fromPause
  props.data.paused = false
  window.dispatchEvent(new CustomEvent('sailor:runnerGateAction', {
    detail: {
      nodeId: props.id,
      promptId: props.data.promptId,
      action,
      takes: fromPause && action === 'continue' && choices.value.length > 1 ? [...ticked.value] : undefined,
    },
  }))
}
</script>

<template>
  <!-- Ports sit outside the card so its background occludes their inner half. -->
  <div class="relative w-fit">
    <VueCanvasNodePort
      v-for="(port, i) in data.inputs"
      :id="`input-${i}`"
      :key="`in-${i}`"
      type="target"
      side="left"
      :index="i"
      :data-type="port.type"
      :label="port.name"
    />
    <VueCanvasNodePort
      v-for="(port, i) in data.outputs"
      :id="`output-${i}`"
      :key="`out-${i}`"
      type="source"
      side="right"
      :index="i"
      :data-type="port.type"
      :label="port.name"
    />

  <div
    class="gate-node node-shell relative z-10 w-[260px] select-none"
    :class="{
      'ring-2 ring-red-500': data.error,
      'opacity-60': isBypassed,
    }"
    :data-running="data.running || data.paused || undefined"
    :data-selected="selected || undefined"
    :data-glass-blur="glass || undefined"
    :style="{
      '--border-color-left': borderColorLeft,
      '--border-color-right': borderColorRight,
    } as any"
  >
    <!-- Title bar (matches ComfyNode) -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-white/5">
      <div class="size-2 rounded-full shrink-0" :style="{ backgroundColor: accentColor }" />
      <span class="text-[13px] font-semibold text-white/90 truncate flex-1">{{ data.title || 'Gate' }}</span>
    </div>


    <!-- Pass-through strip: the line the gate interrupts, plus its state. -->
    <div class="relative h-12">
      <!-- Horizontal line from input to output -->
      <div class="absolute inset-x-0 top-1/2 h-px bg-white/10" />
      <!-- Live status indicator overlaid on the line -->
      <div
        class="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 flex items-center justify-center size-7 rounded-full bg-[#1a1a1a] border border-white/10 transition-colors"
        :class="{
          'text-white/30': isBypassed,
          'text-red-500': !isBypassed && data.paused,
          'text-white/50': !isBypassed && !data.paused,
          'animate-pulse': data.paused,
        }"
      >
        <Play v-if="isBypassed" class="size-3.5" :fill="'currentColor'" />
        <Pause v-else class="size-3.5" :fill="'currentColor'" />
      </div>
    </div>

    <!-- Runner: the pictures that reached the Gate. With several, tick the ones worth continuing. -->
    <div v-if="choices.length && (data.paused || isRunner)" class="grid gap-1.5 px-2 pt-2 nopan nodrag" :class="choices.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
      <button
        v-for="c in choices"
        :key="c.take"
        type="button"
        class="relative rounded-md overflow-hidden border cursor-pointer bg-black/30 aspect-square"
        :class="ticked.includes(c.take) ? 'border-white/70' : 'border-white/10'"
        :aria-pressed="ticked.includes(c.take)"
        :disabled="!data.paused || choices.length <= 1"
        @click="toggleTick(c.take)"
      >
        <video v-if="c.files[0] && isVideoFile(c.files[0].filename)" :src="viewUrl(c.files[0])" class="size-full object-cover" muted loop autoplay playsinline />
        <img v-else-if="c.files[0]" :src="viewUrl(c.files[0])" alt="" class="size-full object-cover" draggable="false">
        <span
          v-if="data.paused && choices.length > 1"
          class="absolute top-1 right-1 size-4 rounded-sm border flex items-center justify-center text-[10px]"
          :class="ticked.includes(c.take) ? 'bg-white text-black border-white' : 'bg-black/50 border-white/50'"
        >{{ ticked.includes(c.take) ? '✓' : '' }}</span>
      </button>
    </div>

    <!-- Bypass toggle + action buttons -->
    <div class="flex flex-col gap-2.5 px-2 py-2.5 border-t border-[#2a2a2a]">
      <!-- Toggle row: single Bypass label -->
      <div class="flex items-center justify-between px-1 nopan nodrag">
        <span class="text-xs text-white/60 tracking-[0.12px]">Bypass</span>
        <button
          class="relative w-9 h-5 rounded-full cursor-pointer transition-colors shrink-0"
          :class="isBypassed ? 'bg-white/15' : 'bg-zinc-700'"
          @click="toggleBypass"
        >
          <div
            class="absolute top-1/2 -translate-y-1/2 size-3.5 rounded-full bg-white shadow-md transition-transform"
            :class="isBypassed ? 'left-[17px]' : 'left-[3px]'"
          />
        </button>
      </div>

      <!-- Action buttons (while paused; runner Gates also after the run, to continue again) -->
      <div v-if="showActions" class="flex items-center gap-1.5 nopan nodrag">
        <button
          class="gate-btn node-btn flex-1 justify-center"
          data-tooltip="Re-run from the start"
          @click="resumeGate('restart')"
        >
          <SkipBack class="size-3.5" />
          <span>Restart</span>
        </button>
        <button
          v-if="data.paused"
          class="gate-btn node-btn flex-1 justify-center"
          data-tooltip="Redo last step"
          @click="resumeGate('redo')"
        >
          <RotateCcw class="size-3.5" />
          <span>Redo</span>
        </button>
        <button
          class="gate-btn node-btn node-btn--primary flex-1 justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          :data-tooltip="data.paused ? 'Continue downstream' : 'Run the steps after this Gate again'"
          :disabled="!canContinue"
          @click="resumeGate('continue')"
        >
          <Play class="size-3.5" :fill="'currentColor'" />
          <span>{{ data.paused ? continueLabel(choices.length, ticked.length) : 'Again' }}</span>
        </button>
      </div>
    </div>
  </div>
  </div>
</template>

<style scoped>
/* Sweeping glow border when running/paused */
.gate-node[data-running] {
  --border-left: var(--border-color-left, #fff);
  --border-right: var(--border-color-right, #fff);
  border-color: transparent;
}

/* Running draws its own edge; the resting gradient ring (.node-shell::after) steps aside. */
.gate-node[data-running]::after { display: none; }

.gate-node[data-running]::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  background: linear-gradient(to right, var(--border-left), var(--border-right));
  -webkit-mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  -webkit-mask-composite: source-in, xor;
  mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  mask-composite: intersect, exclude;
  animation: border-sweep 2s linear infinite;
  pointer-events: none;
  z-index: -1;
}

/* CSS-only tooltips — avoids Reka UI pointer-event interference with VueFlow */
.gate-btn {
  position: relative;
}
.gate-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%) scale(0.95);
  white-space: nowrap;
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
  background: #18181b;
  color: #fafafa;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s, transform 0.15s;
  z-index: 50;
}
.gate-btn:hover::after {
  opacity: 1;
  transform: translateX(-50%) scale(1);
}
</style>
