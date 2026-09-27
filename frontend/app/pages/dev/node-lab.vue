<script setup lang="ts">
/**
 * Dev harness for stage 1 of the node-design rebuild: every shared node surface
 * (instrument, studio, content card, print) on one canvas, so a look can be
 * checked without wiring up a real graph. Reachable only at /dev/node-lab.
 *
 * Ports need Vue Flow's handle context (NodePort renders a <Handle>), so the
 * four surfaces are mounted as custom Vue Flow node types inside a <VueFlow>,
 * the same wrapper pattern frame-lab.vue uses for the Frame card.
 */
import { ref, h, defineComponent, markRaw } from 'vue'
import { VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { Sparkles, Palette, Download, MoreHorizontal } from 'lucide-vue-next'
import NodeShell from '~/components/vue-canvas/surfaces/NodeShell.vue'
import NodeWell from '~/components/vue-canvas/surfaces/NodeWell.vue'
import NodeOpenBar from '~/components/vue-canvas/surfaces/NodeOpenBar.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import PrintSurface from '~/components/vue-canvas/surfaces/PrintSurface.vue'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'
import NodePort from '~/components/vue-canvas/NodePort.vue'
import { provideCanvasGlass } from '~/composables/useCanvasGlass'
import type { ControlSpec } from '~/lib/spacetype/effect'

definePageMeta({ layout: false })

const HERO = '/hero/hero_rotateimage.png'

// Static stand-in for the canvas's real glass switch: mark "generate" as the
// node with something behind it (the Gradient studio, positioned underneath),
// so its shell shows real blur and the rest of the lab stays tint-only.
provideCanvasGlass({ blurIds: ref(new Set(['generate'])) })

// ---- Generate an image (instrument) ----
const model = ref('Nano Banana 2')
const size = ref('Square 1:1')
const reference = ref('reference')
const strength = ref(70)

const modelSpec: ControlSpec = { key: 'model', label: 'Model', kind: 'select', options: ['Nano Banana 2'], default: 'Nano Banana 2', group: 'generate' }
const sizeSpec: ControlSpec = { key: 'size', label: 'Size', kind: 'select', options: ['Square 1:1'], default: 'Square 1:1', group: 'generate' }
const referenceSpec: ControlSpec = { key: 'reference', label: 'References', kind: 'select', options: ['reference'], default: 'reference', group: 'generate' }
const strengthSpec: ControlSpec = { key: 'strength', label: 'Reference strength', kind: 'slider', min: 0, max: 100, step: 1, default: 70, group: 'generate' }

const GenerateNode = defineComponent({
  name: 'LabGenerateNode',
  setup() {
    return () => h('div', { class: 'relative w-fit' }, [
      h(NodePort, { id: 'prompt', type: 'target', side: 'left', dataType: 'STRING', label: 'Prompt', index: 0 }),
      h(NodePort, { id: 'image', type: 'source', side: 'right', dataType: 'IMAGE', label: 'Image', index: 0 }),
      h('div', { style: { width: '280px' } }, [
        h(NodeShell, { title: 'Generate an image', nodeId: 'generate' }, {
          icon: () => h(Sparkles, { size: 15 }),
          default: () => [
            h(NodeWell, null, {
              default: () => h(
                'div',
                { class: 'min-h-[88px] p-3 text-[13px] leading-snug text-white/80' },
                'The dog from the reference, grinning on a beach at noon, shot on 35mm, warm light',
              ),
            }),
            h(StudioRow, {
              spec: modelSpec, modelValue: model.value, size: 'comfortable',
              'onUpdate:modelValue': (v: string | number | boolean) => { model.value = String(v) },
            }),
            h(StudioRow, {
              spec: sizeSpec, modelValue: size.value, size: 'comfortable',
              'onUpdate:modelValue': (v: string | number | boolean) => { size.value = String(v) },
            }),
            h(StudioRow, {
              spec: referenceSpec, modelValue: reference.value, size: 'comfortable',
              'onUpdate:modelValue': (v: string | number | boolean) => { reference.value = String(v) },
            }, {
              value: () => h('img', { src: HERO, class: 'h-5 w-5 rounded-[4px] object-cover', alt: '' }),
            }),
            h(StudioRow, {
              spec: strengthSpec, modelValue: strength.value, size: 'comfortable',
              'onUpdate:modelValue': (v: string | number | boolean) => { strength.value = Number(v) },
            }),
          ],
          foot: () => [
            h('span', { class: 'text-[12px] text-white/50' }, 'Not run yet'),
            h('button', { type: 'button', class: 'node-btn node-btn--primary ml-auto' }, [
              h('span', 'Run'),
              h('span', { class: 'node-btn__price' }, '$0.03'),
            ]),
          ],
        }),
      ]),
    ])
  },
})

// ---- Gradient (studio) ----
const GradientNode = defineComponent({
  name: 'LabGradientNode',
  setup() {
    return () => h('div', { class: 'relative w-fit' }, [
      h(NodePort, { id: 'output', type: 'source', side: 'right', dataType: 'IMAGE', label: 'Output', index: 0 }),
      h('div', { style: { width: '260px' } }, [
        h(NodeShell, { title: 'Gradient', nodeId: 'gradient' }, {
          icon: () => h(Palette, { size: 15 }),
          default: () => h(NodeWell, null, {
            default: () => h('div', {
              class: 'h-[140px]',
              style: { background: 'linear-gradient(135deg, #ff7a59, #7c5cff 55%, #35d0ba)' },
            }),
            openbar: () => h(NodeOpenBar, { meta: '3 colours · mesh' }, {
              default: () => h('button', { type: 'button', class: 'node-btn' }, 'Open'),
            }),
          }),
        }),
      ]),
    ])
  },
})

// ---- beach-dog.jpg (content card) ----
const CardNode = defineComponent({
  name: 'LabCardNode',
  setup() {
    return () => h('div', { class: 'relative w-fit' }, [
      h(NodePort, { id: 'image', type: 'source', side: 'right', dataType: 'IMAGE', label: 'Image', index: 0 }),
      h('div', { style: { width: '220px' } }, [
        h(ContentCard, { name: 'beach-dog.jpg' }, {
          default: () => h('img', { src: HERO, class: 'block w-full', alt: '' }),
          actions: () => [
            h('button', { type: 'button', title: 'Download' }, [h(Download, { size: 14 })]),
            h('button', { type: 'button', title: 'More' }, [h(MoreHorizontal, { size: 14 })]),
          ],
        }),
      ]),
    ])
  },
})

// ---- Frame (print) ----
const PrintNode = defineComponent({
  name: 'LabPrintNode',
  setup() {
    return () => h('div', { class: 'relative w-fit' }, [
      h(NodePort, { id: 'image', type: 'target', side: 'left', dataType: 'IMAGE', label: 'Image', index: 0 }),
      h('div', { style: { width: '320px' } }, [
        h(PrintSurface, { name: 'Frame', size: '4:5 · 1080 × 1350', artwork: HERO }, {
          openbar: () => h(NodeOpenBar, null, {
            default: () => [
              h('button', { type: 'button', class: 'node-btn' }, 'Render'),
              h('button', { type: 'button', class: 'node-btn' }, 'Open'),
            ],
          }),
        }),
      ]),
    ])
  },
})

const nodeTypes = {
  generate: markRaw(GenerateNode),
  gradient: markRaw(GradientNode),
  card: markRaw(CardNode),
  print: markRaw(PrintNode),
} as any

// Gradient sits first (so it paints underneath), Generate second and
// overlapping it — the pair the shell blur is meant to show off.
const flowNodes = [
  { id: 'gradient', type: 'gradient', position: { x: 300, y: 220 }, data: {} },
  { id: 'generate', type: 'generate', position: { x: 60, y: 60 }, data: {} },
  { id: 'card', type: 'card', position: { x: 740, y: 80 }, data: {} },
  { id: 'print', type: 'print', position: { x: 740, y: 400 }, data: {} },
]
</script>

<template>
  <div class="canvas-glass canvas-glass--blur relative h-screen w-full overflow-hidden bg-[#0a0a0a]" data-slot="comfy-canvas">
    <VueFlow
      class="absolute inset-0"
      :nodes="flowNodes"
      :edges="[]"
      :node-types="nodeTypes"
      :min-zoom="0.2"
      :max-zoom="2"
      :nodes-draggable="true"
      :pan-on-scroll="true"
    />
  </div>
</template>
