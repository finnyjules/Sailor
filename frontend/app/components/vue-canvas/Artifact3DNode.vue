<script setup lang="ts">
import { Box, Loader2, Download, RotateCcw, AlertTriangle } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import { registerWebGLContext, type WebGLContextHandle } from '~/lib/webgl/contextRegistry'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'

// 3D Model viewer artifact (Model3D node). Loads a GLB from a URL and renders it
// in an interactive Three.js viewer (orbit/zoom). The URL is resolved from this
// node's execution output (data.text) or from the upstream wired node — so it
// works both after a graph Run and when you simply wire an existing URL in.
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
    properties?: Record<string, any>
    mode: number
    running?: boolean
    error?: boolean
    text?: string
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const stringColor = computed(() => getTypeColor('STRING'))
const injectedEdges = inject<any>('vueFlowEdges', null)
const injectedNodes = inject<any>('vueFlowNodes', null)

function inputIdx(name: string): number { return props.data.inputs?.findIndex(i => i.name === name) ?? -1 }
function outputIdx(name: string): number { const i = props.data.outputs?.findIndex(o => o.name === name) ?? -1; return i >= 0 ? i : 0 }
const glbInIdx = computed(() => { const i = inputIdx('glb_url'); return i >= 0 ? i : 0 })
const glbOutIdx = computed(() => outputIdx('glb_url'))

// Read a URL string off an arbitrary upstream node (Text node, mv node, etc.).
function urlFromNode(n: any): string {
  if (!n) return ''
  const d = n.data || {}
  if (typeof d.text === 'string' && /^https?:|\.glb/i.test(d.text)) return d.text
  const entries = d.properties?.textEntries
  if (Array.isArray(entries)) {
    const v = entries[d.properties?.activeEntryIndex ?? 0] ?? entries[0]
    if (typeof v === 'string' && /^https?:|\.glb/i.test(v)) return v
  }
  return ''
}

const glbUrl = computed<string>(() => {
  // 1. This node's own execution output.
  if (typeof props.data.text === 'string' && /^https?:|\.glb/i.test(props.data.text)) return props.data.text
  // 2. The upstream wired node's value.
  const idx = glbInIdx.value
  const edge = (injectedEdges?.value ?? []).find((e: any) => e.target === props.id && e.targetHandle === `input-${idx}`)
  if (edge) {
    const src = (injectedNodes?.value ?? []).find((n: any) => n.id === edge.source)
    const u = urlFromNode(src)
    if (u) return u
  }
  return ''
})

// ── Three.js viewer (non-reactive closures) ─────────────────────────────────
const W = 300, H = 300
const stageRef = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const loadError = ref('')
let THREE: any = null
let renderer: any = null
let scene: any = null
let camera: any = null
let orbit: any = null
let modelRoot: any = null
let rafId = 0
let inited = false
let ctxHandle: WebGLContextHandle | null = null
let visObserver: IntersectionObserver | null = null
// Hover-to-play gate: the orbit/damping render loop runs only while the card is on-screen
// (g3d.visible) AND the pointer is over it (g3d.hovered) — or an orbit drag is in progress
// (dragging3d), so a drag that slips off the small card via pointer-capture isn't cut short.
// apply3DGate / renderOnce are assigned in initViewer (they capture the local `tick`).
const g3d = { visible: true, hovered: false }
let dragging3d = false
let apply3DGate: () => void = () => {}
let renderOnce: () => void = () => {}
function on3DHoverEnter() { g3d.hovered = true; apply3DGate() }
function on3DHoverLeave() { g3d.hovered = false; apply3DGate() }

async function initViewer() {
  const el = stageRef.value
  if (!el || inited) return
  inited = true
  THREE = await import('three')
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  ctxHandle = registerWebGLContext('Artifact3D')
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(W, H)
  el.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(35, W / H, 0.01, 1000)
  camera.position.set(0, 1, 3)
  scene.add(new THREE.AmbientLight(0xffffff, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 2); scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-2, 1, -2); scene.add(fill)

  orbit = new OrbitControls(camera, renderer.domElement)
  orbit.enableDamping = true
  // Keep the loop alive across an orbit drag even if the pointer leaves the card
  // (OrbitControls captures the pointer); on 'end' the gate re-applies and pauses if the
  // pointer has since left. On leave we freeze the last view (WebGL buffer persists) rather
  // than snap the camera back mid-inspection.
  orbit.addEventListener('start', () => { dragging3d = true; apply3DGate() })
  orbit.addEventListener('end', () => { dragging3d = false; apply3DGate() })

  const tick = () => { rafId = requestAnimationFrame(tick); orbit.update(); renderer.render(scene, camera) }
  renderOnce = () => { if (renderer && scene && camera) renderer.render(scene, camera) }
  apply3DGate = () => {
    const run = g3d.visible && (g3d.hovered || dragging3d)
    if (run && !rafId) tick()
    else if (!run && rafId) { cancelAnimationFrame(rafId); rafId = 0; renderOnce() }
  }
  renderOnce()  // one static frame so a never-hovered card isn't blank
  // Pause the loop while the node is scrolled off the canvas viewport too (existing
  // behavior): an off-screen preview has nothing to show, so a 60fps render loop per hidden
  // GLB node is pure wasted GPU work (and memory pressure toward the WebGL-context cap). The
  // context is kept so scrolling back / hovering is instant — no reload thrash.
  visObserver = new IntersectionObserver((entries) => {
    g3d.visible = entries[0]?.isIntersecting ?? true
    apply3DGate()
  })
  visObserver.observe(el)
  if (glbUrl.value) loadModel(glbUrl.value)
}

async function loadModel(url: string) {
  if (!renderer) return
  loadError.value = ''
  loading.value = true
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
    const loader = new GLTFLoader()
    const gltf: any = await loader.loadAsync(url)
    if (modelRoot) { scene.remove(modelRoot); modelRoot = null }
    modelRoot = gltf.scene
    // Center + frame the model.
    const box = new THREE.Box3().setFromObject(modelRoot)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    modelRoot.position.sub(center)
    scene.add(modelRoot)
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.4
    camera.position.set(0, size.y * 0.1, dist)
    camera.near = dist / 100; camera.far = dist * 100; camera.updateProjectionMatrix()
    orbit.target.set(0, 0, 0); orbit.update()
    renderOnce()   // show the framed model even before first hover (loop is hover-gated)
  } catch (err: any) {
    loadError.value = err?.message?.includes('CORS') ? 'Could not load (CORS). Use Download.' : 'Could not load the 3D model.'
    console.error('[Artifact3D] load failed:', err)
  } finally {
    loading.value = false
  }
}

function resetView() {
  if (glbUrl.value) loadModel(glbUrl.value)
}

async function downloadGlb() {
  const url = glbUrl.value
  if (!url) return
  try {
    const a = document.createElement('a'); a.href = url; a.download = `model-${props.id}.glb`
    document.body.appendChild(a); a.click(); a.remove()
  } catch (err) { console.error('[Artifact3D] download failed:', err) }
}

watch(glbUrl, (u) => { if (u && renderer) loadModel(u) })

onMounted(() => { initViewer() })
onBeforeUnmount(() => {
  visObserver?.disconnect(); visObserver = null
  cancelAnimationFrame(rafId); rafId = 0
  try { orbit?.dispose?.(); renderer?.forceContextLoss?.(); renderer?.dispose?.() } catch { /* ignore */ }
  if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  renderer = null; scene = null; camera = null; orbit = null; modelRoot = null
  ctxHandle?.release(); ctxHandle = null
})
</script>

<template>
  <div class="relative w-fit">
    <VueCanvasNodePort
      :id="`input-${glbInIdx}`"
      type="target"
      side="left"
      :data-type="data.inputs?.[glbInIdx]?.type ?? 'STRING'"
      label="Model"
      :index="0"
    />
    <VueCanvasNodePort
      :id="`output-${glbOutIdx}`"
      type="source"
      side="right"
      :data-type="data.outputs?.[glbOutIdx]?.type ?? 'STRING'"
      label="Model"
      :index="0"
    />

    <ContentCard
      class="artifact-3d relative z-10 w-[300px] select-none"
      :class="{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed }"
      :name="data.title || '3D model'"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :style="{ '--port-color': stringColor } as any"
      @pointerenter="on3DHoverEnter" @pointerleave="on3DHoverLeave"
    >
      <VueCanvasNodeReadyBadge :node-id="id" />

      <!-- Viewer -->
      <div class="relative" :style="{ width: W + 'px', height: H + 'px' }">
        <div ref="stageRef" class="nopan nodrag absolute inset-0 cursor-grab active:cursor-grabbing" />
        <div v-if="!glbUrl" class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-white/30 pointer-events-none">
          <Box class="size-8" :stroke-width="1.5" /><span class="text-[10px]">Wire a glb_url · then Run</span>
        </div>
        <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
          <Loader2 class="size-6 animate-spin text-white/70" />
        </div>
        <div v-if="loadError" class="absolute inset-x-2 bottom-2 flex items-center gap-1 text-[10px] text-rose-300 bg-black/60 rounded px-1.5 py-1 pointer-events-none">
          <AlertTriangle class="size-3 shrink-0" /> {{ loadError }}
        </div>
      </div>

      <template #actions>
        <button type="button" title="Reset view" :disabled="!glbUrl" @click.stop="resetView"><RotateCcw class="size-3.5" /></button>
        <button type="button" title="Download .glb" :disabled="!glbUrl" @click.stop="downloadGlb"><Download class="size-3.5" /></button>
      </template>
    </ContentCard>
  </div>
</template>
