<script setup lang="ts">
/** Dev harness for the Frame — BOTH surfaces of it.
 *
 *  - the CARD (`ArtifactFrameNode`, mounted inside a one-node `<VueFlow>` so its
 *    `<Handle>`s find a real Vue Flow store), and
 *  - the MODAL (`CompositorModal`), opened over it.
 *
 *  The fixture node is deliberately PRE-MIGRATION: no `sailor_frameSchema`, two
 *  connected input slots whose transforms live only in `layer{N}_*` widget
 *  values, and a full spread of legacy per-slot registries
 *  (`sailor_hiddenWired`, `sailor_wiredNames`, `sailor_wiredTreatments`,
 *  `sailor_stackOrder` in `w:` keys). Opening the page therefore runs
 *  `migrateFrameToUnifiedLayers` for real, and what you see is the migrated
 *  result — not a hand-written schema-2 blob that could agree with a broken
 *  migration. Reachable only at /dev/frame-lab.
 *
 *  Hard-reload after editing (HMR keeps the ALREADY-MIGRATED node object alive,
 *  so a soft reload silently skips the very thing this page exists to exercise). */
import { VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import CompositorModal from '~/components/vue-canvas/CompositorModal.vue'
import ArtifactFrameNode from '~/components/vue-canvas/ArtifactFrameNode.vue'
import { createTextLayer, createRectLayer, createImageLayer, createLineLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'

definePageMeta({ layout: false })

// Text layers exercising every new control.
const plain = createTextLayer({ text: 'Plain text', x: 0.5, y: 0.12, fontSize: 0.06, color: '#ffffff' })
const tracked = createTextLayer({ text: 'Wide tracking', x: 0.5, y: 0.24, fontSize: 0.06, letterSpacing: 0.3, color: '#54f4cf' })
const underlined = createTextLayer({ text: 'Underlined', x: 0.5, y: 0.36, fontSize: 0.06, underline: true, color: '#ffb984' })
const struck = createTextLayer({ text: 'Strikethrough', x: 0.5, y: 0.48, fontSize: 0.06, strikethrough: true, color: '#ff99f7' })
const upper = createTextLayer({ text: 'uppercased', x: 0.5, y: 0.60, fontSize: 0.06, textTransform: 'uppercase', color: '#0e6bff' })
const combo = createTextLayer({ text: 'all at once', x: 0.5, y: 0.72, fontSize: 0.06, textTransform: 'capitalize', underline: true, letterSpacing: 0.12, color: '#f2ff5a' })

// Type on a path — one layer per follow mode, so the harness shows at a glance
// whether the guide engine and the inspector agree. See lib/compositor/textPath.ts.
const onRing = createTextLayer({ text: 'BADGE OF HONOUR', x: 0.25, y: 0.3, fontSize: 0.035, color: '#ffffff' })
;(onRing as any).align = 'center'
;(onRing as any).path = { follow: 'circle', radius: 0.12, start: 0.5 }

const underRing = createTextLayer({ text: 'EST MMXXVI', x: 0.25, y: 0.3, fontSize: 0.035, color: '#54f4cf' })
;(underRing as any).align = 'center'
;(underRing as any).path = { follow: 'circle', radius: 0.12, start: 0, side: 'inside' }

const arched = createTextLayer({ text: 'GENTLE ARCH', x: 0.7, y: 0.22, fontSize: 0.04, color: '#ffb984' })
;(arched as any).align = 'center'
;(arched as any).path = { follow: 'curve', bend: 0.45 }

const waved = createTextLayer({ text: 'WAVY LETTERS', x: 0.7, y: 0.45, fontSize: 0.04, color: '#ff99f7' })
;(waved as any).align = 'center'
;(waved as any).path = { follow: 'wave', amplitude: 0.025, frequency: 1.5 }

const roundShape = createTextLayer({ text: 'AROUND A CLOVER', x: 0.72, y: 0.72, fontSize: 0.028, color: '#f2ff5a' })
;(roundShape as any).align = 'center'
;(roundShape as any).path = { follow: 'shape', shapeId: 'clover-x', size: 0.24, start: 0.5 }

const drawnGuide = createTextLayer({ text: 'A DRAWN PATH', x: 0.25, y: 0.7, fontSize: 0.032, color: '#0e6bff' })
;(drawnGuide as any).align = 'center'
;(drawnGuide as any).path = { follow: 'custom', d: 'M-0.15 0 C -0.15 -0.18, 0.15 0.18, 0.15 0', size: 0.3 }

// ── Cloner fixture (cloner motion, Task 8) ──────────────────────────────────
// A text layer stamped SIX times round a ring — the layer the Motion tab's Copies card and
// the Copies gallery tiles need: the cloner is `enabled`, so `layerCaps` reports
// `cloner: 'radial'` and the whole Copies group is offered (the radial-only tiles included).
// Six copies at radius 0.12 of the frame WIDTH, on a 1280×720 artboard, put the ring's
// copies roughly 150px out — far enough apart to tell one copy's progress from the next's
// when a stagger is scrubbed, small enough to stay inside the frame.
//
// To exercise the LINEAR tiles instead (Spread out / Gather in become a two-axis recipe, and
// Build drives `countX` rather than `count`), swap the three lines marked below for:
//   mode: 'linear', countX: 3, countY: 2, spacingX: 0.22, spacingY: 0.22,
const clonedText = createTextLayer({
  id: 'clonertext', text: 'COPY', x: 0.5, y: 0.5, fontSize: 0.045, color: '#ff2d2d',
} as any)
;(clonedText as any).cloner = {
  ...DEFAULT_CLONER,
  enabled: true,
  mode: 'radial',   // ← linear grid: 'linear'
  count: 6,         // ← linear grid: countX: 3, countY: 2
  radius: 0.12,     // ← linear grid: spacingX: 0.22, spacingY: 0.22
}

// A local image layer — exercises the layer-list thumbnail (its own pixels) and
// double-click rename. `filename` points at a real ComfyUI input image so the
// /view thumbnail actually loads.
const pic = createImageLayer('frame_img_1786433110820_0000.png', 1.5, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 / 1.5 } as any)

// Nested groups: A = [a1,a2], B = [b1] ; A and B nested under C ("Header").
const a1 = createTextLayer({ id: 'a1', text: 'Title', x: 0.3, y: 0.85, fontSize: 0.05 } as any)
const a2 = createRectLayer({ id: 'a2', x: 0.3, y: 0.9, w: 0.2, h: 0.03, fill: '#54f4cf' } as any)
const b1 = createTextLayer({ id: 'b1', text: 'Subtitle', x: 0.7, y: 0.85, fontSize: 0.04 } as any)
;(a1 as any).groupId = 'A'; (a2 as any).groupId = 'A'; (b1 as any).groupId = 'B'

// ── Stroke style fixtures (alignment + dashes) ──────────────────────────────
// A column down the left edge: one backdrop plate, then the SAME square drawn
// three times with the same fat outline and a different `strokeAlign`, plus a
// dashed line and a dashed square. The plate sits UNDER the outside-aligned
// square on purpose: that alignment knocks the shape's interior out of its own
// outline, and if the knockout ever reached the shared canvas the plate (and the
// square's fill) would show a hole here.
const strokePlate = createRectLayer({
  id: 'strokeplate', x: 0.13, y: 0.45, w: 0.22, h: 0.78, radius: 0.01, fill: '#3a2a55', stroke: '', strokeWidth: 0,
} as any)
const strokeCenter = createRectLayer({
  id: 'strokecenter', x: 0.13, y: 0.16, w: 0.13, h: 0.13, radius: 0,
  fill: '#ffffff', stroke: '#54f4cf', strokeWidth: 0.02,
} as any)
const strokeInside = createRectLayer({
  id: 'strokeinside', x: 0.13, y: 0.34, w: 0.13, h: 0.13, radius: 0,
  fill: '#ffffff', stroke: '#54f4cf', strokeWidth: 0.02, strokeAlign: 'inside',
} as any)
const strokeOutside = createRectLayer({
  id: 'strokeoutside', x: 0.13, y: 0.52, w: 0.13, h: 0.13, radius: 0,
  fill: '#ffffff', stroke: '#54f4cf', strokeWidth: 0.02, strokeAlign: 'outside',
} as any)
const strokeDashedRect = createRectLayer({
  id: 'strokedashedrect', x: 0.13, y: 0.70, w: 0.13, h: 0.13, radius: 0.02,
  fill: '', stroke: '#f2ff5a', strokeWidth: 0.008, strokeDash: { dash: 0.02, gap: 0.014 },
} as any)
const strokeDashedLine = createLineLayer({
  id: 'strokedashedline', x: 0.13, y: 0.80, w: 0.18,
  stroke: '#f2ff5a', strokeWidth: 0.006, strokeDash: { dash: 0.02, gap: 0.014 },
} as any)

// ── Unified wired-layer fixture ─────────────────────────────────────────────
// The rect the migrated wired layer for slot 1 is masked BY. Fixed id so the
// legacy `sailor_wiredTreatments` registry below can name it before the wired
// layer that references it exists (migration mints that layer's id at runtime).
const MASK_RECT_ID = 'maskrect1'
const maskRect = createRectLayer({
  id: MASK_RECT_ID, x: 0.42, y: 0.5, w: 0.5, h: 0.42, radius: 0.06, fill: '#ffffff',
} as any)
// A plain text layer for the multi-select / align / group checks against a
// wired layer (shift-click this + a wired row).
const caption = createTextLayer({
  id: 'caption1', text: 'Wired + native', x: 0.5, y: 0.93, fontSize: 0.05, color: '#ffffff',
} as any)

// Motion fixtures: exercise in/loop/out, the window, and a utility preset.
;(plain as any).animation = {
  offset: 0.3, duration: 3,
  in: { presetId: 'slide-up', duration: 0.6, stagger: 0.03 },
  loop: { presetId: 'float', duration: 1.6, stagger: 0.04 },
  out: { presetId: 'fade-out', duration: 0.5, stagger: 0.02 },
}
;(tracked as any).animation = {
  offset: 0,
  loop: { presetId: 'wiggle', duration: 2, stagger: 0, params: { amplitude: 0.2, cycles: 2 } },
}

// ── Widgets (the PRE-migration home of every wired transform) ────────────────
// defs[i] ↔ values[i], the same pairing the real graph loader builds. Only the
// two wired slots get a full set; higher slots are absent on purpose (a missing
// widget must read as its default, not throw).
const widgetDefs: { name: string }[] = []
const widgetsValues: any[] = []
function w(name: string, value: any) { widgetDefs.push({ name }); widgetsValues.push(value) }
w('width', 1280)   // explicit artboard ⇒ the contain-fit has a canvas from tick 0
w('height', 720)
// Slot 1 (input-0): nudged left/down, rotated, scaled down a touch.
w('layer1_x', -0.12); w('layer1_y', 0.08); w('layer1_rotation', -6)
w('layer1_scale', 0.85); w('layer1_opacity', 1); w('layer1_blend', 'normal')
// Slot 2 (input-1): the one the stale `sailor_hiddenWired` entry hides, and the
// one carrying a non-default blend + opacity so migration has something to move.
w('layer2_x', 0.18); w('layer2_y', -0.1); w('layer2_rotation', 10)
w('layer2_scale', 0.6); w('layer2_opacity', 0.85); w('layer2_blend', 'screen')

const node = reactive({
  id: 'n1',
  data: {
    nodeType: 'CompositorNode',
    title: 'Frame',
    inputs: [], outputs: [{ name: 'image', type: 'IMAGE', links: null }],
    widgetsValues, widgetDefs,
    images: [] as string[],
    properties: {
      // NOTE: no `sailor_frameSchema` — this frame has never been migrated.
      sailor_localLayers: [pic, clonedText, plain, tracked, underlined, struck, upper, combo, a1, a2, b1, maskRect, caption,
        strokePlate, strokeCenter, strokeInside, strokeOutside, strokeDashedRect, strokeDashedLine,
        onRing, underRing, arched, waved, roundShape, drawnGuide],
      sailor_localGroups: [
        { id: 'A', parentId: 'C', name: 'Row' },
        { id: 'B', parentId: 'C', name: 'Side' },
        { id: 'C', name: 'Header' },
      ],
      sailor_localBg: '#12131a',
      // Big enough on the canvas to read the composite (and to drag a wired
      // layer's corner handle) without zooming in first.
      sailor_frame: { displayEdge: 620 },
      // Legacy per-slot registries, 1-BASED (registry index = slot + 1):
      //  - 2 is CONNECTED ⇒ its wired layer must migrate to `visible: false`
      //    (click the eye in the layer panel to bring it back).
      //  - 5 has no wire ⇒ genuinely stale; migration ignores it and the modal's
      //    prune drops it while the frame is still legacy.
      sailor_hiddenWired: [2, 5],
      sailor_wiredNames: { 1: 'Product shot', 2: 'Shader plate' },
      // `w:`-era registry shape. Migration reads `w:1`, moves `maskedByKey` onto
      // the wired LAYER for slot 0, and repoints any `w:N` reference at the
      // `l:<id>` that replaced it. The target here is already a local layer, so
      // it stays `l:maskrect1` — what must change is WHERE it lives.
      sailor_wiredTreatments: { 'w:1': { maskedByKey: `l:${MASK_RECT_ID}` } },
      // Deliberately reversed vs. the natural bottom→top order, so the `w:N` →
      // `l:<id>` remap in the stack is visible rather than coincidental.
      sailor_stackOrder: ['w:2', 'w:1'],
    },
    mode: 0,
  },
})
// Two wired image sources with DIFFERENT aspects (1.51:1 and 1:1), served
// straight from `public/` so the lab needs no ComfyUI backend running.
const imgSrc = reactive({
  id: 'img1',
  data: {
    nodeType: 'Image',
    images: ['/app_covers/productshot.png'],   // 768 × 509
    widgetsValues: [], widgetDefs: [],
  },
})
const imgSrc2 = reactive({
  id: 'img2',
  data: {
    nodeType: 'Image',
    images: ['/finn_shader.png'],              // 1024 × 1024
    widgetsValues: [], widgetDefs: [],
  },
})
// Both hosts derive their connected slots from EDGES, never from `data.inputs`.
const edges = ref([
  { id: 'e1', source: 'img1', target: 'n1', sourceHandle: 'output-0', targetHandle: 'input-0' },
  { id: 'e2', source: 'img2', target: 'n1', sourceHandle: 'output-0', targetHandle: 'input-1' },
])
const nodes = ref<any[]>([node, imgSrc, imgSrc2])
// The card reads the graph through these injections (VueNodeCanvas provides the
// same two keys, as refs) — that is how it resolves each wired slot's content.
provide('vueFlowNodes', nodes)
provide('vueFlowEdges', edges)

// Only the Frame is rendered by Vue Flow; the image sources exist for slot
// resolution only, so giving them a node component would be dead weight.
// `data` is the SAME reactive object the modal edits, so card and modal stay in
// step exactly as they do on the real canvas.
const flowNodes = [
  { id: 'n1', type: 'artifact-frame', position: { x: 48, y: 96 }, data: node.data },
]
const nodeTypes = { 'artifact-frame': markRaw(ArtifactFrameNode) } as any

// ── Save / reload round-trip ────────────────────────────────────────────────
// The fixture above is rebuilt from source on every page load, so without this a
// reload could only ever re-run migration from scratch — the one thing the
// round-trip check needs to NOT happen. Persisting `properties` + `widgetsValues`
// to localStorage stands in for the project store: reload and the frame comes
// back already schema 2, which is when "no re-migration, no duplicate layers"
// becomes a real assertion. Bump the version suffix whenever the fixture above
// changes, so an old blob can never masquerade as a saved edit.
const SAVE_KEY = 'frameLab:save:v2'
const persisted = ref(false)
if (import.meta.client) {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      // Restored during setup — BEFORE the card/modal mount (they are gated on
      // `ready`), so both hosts see the saved schema-2 frame on their first tick.
      if (saved?.properties) node.data.properties = saved.properties
      if (Array.isArray(saved?.widgetsValues)) node.data.widgetsValues = saved.widgetsValues
      persisted.value = true
    }
  } catch { /* a corrupt blob just falls back to the pristine fixture */ }
}
function saveFixture() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      properties: node.data.properties, widgetsValues: node.data.widgetsValues,
    }))
    persisted.value = true
  } catch { /* quota / private mode — the lab still works, just doesn't persist */ }
}
function resetFixture() {
  try { localStorage.removeItem(SAVE_KEY) } catch { /* nothing to clear */ }
  location.reload()
}

const modalOpen = ref(true)
// SSR renders the markup before hydration wires the handlers, so the first click
// after a goto lands on dead HTML. Gate everything on onMounted and let tests
// wait for [data-ready] — see the dev-harness hydration-race note.
const ready = ref(false)
onMounted(() => {
  ready.value = true
  // Read-only handle on the live fixture so a browser pass can assert the
  // MIGRATED state (schema flag, layer array, stack order) instead of inferring
  // it from pixels. Dev page only — nothing in the app reads this.
  ;(window as any).__frameLab = { node, nodes, edges, save: saveFixture, reset: resetFixture }
})
</script>

<template>
  <div class="fixed inset-0 bg-[#0b0d12]" :data-ready="ready ? '' : undefined">
    <div class="absolute inset-0 grid place-items-center text-white/[0.06] text-[80px] font-bold select-none">
      frame lab
    </div>

    <!-- The CARD, in a minimal Vue Flow so its handles have a real store. -->
    <VueFlow
      v-if="ready"
      class="absolute inset-0"
      :nodes="flowNodes"
      :edges="[]"
      :node-types="nodeTypes"
      :min-zoom="0.2"
      :max-zoom="2"
      :nodes-draggable="true"
      :pan-on-scroll="true"
    />

    <!-- Above the modal's own z-[100] backdrop, so the card can be revealed
         without hunting for the modal's close button. -->
    <div v-if="ready" class="absolute top-3 right-3 z-[200] flex items-center gap-2">
      <span v-if="persisted" class="rounded-md bg-emerald-400/15 px-2 py-1 text-[11px] text-emerald-300">saved fixture</span>
      <button
        data-testid="frame-lab-toggle-modal"
        class="rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/20"
        @click="modalOpen = !modalOpen"
      >
        {{ modalOpen ? 'Close modal' : 'Open modal' }}
      </button>
      <button
        data-testid="frame-lab-save"
        class="rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/20"
        title="Persist the frame's properties + widgets, then reload to prove it comes back schema 2"
        @click="saveFixture()"
      >
        Save
      </button>
      <button
        data-testid="frame-lab-reset"
        class="rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/80 hover:bg-white/20"
        title="Drop the saved state and reload the pristine pre-migration fixture"
        @click="resetFixture()"
      >
        Reset
      </button>
    </div>

    <CompositorModal
      v-if="ready && modalOpen"
      :node-id="'n1'" :nodes="nodes" :edges="edges" @close="modalOpen = false"
    />
  </div>
</template>
