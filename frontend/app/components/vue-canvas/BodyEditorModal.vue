<script setup lang="ts">
/**
 * Body editor — Task 5 of the body-reference-builder plan. Sliders write
 * words (bodyPhrase, ~/lib/characters/bodyPhrase.ts — already rides prompts,
 * B3), the grey figure on the stage previews exactly what they mean. Chrome
 * (Teleport/overlay/one close handler for X+Escape+backdrop) copied from
 * CharacterStudioModal.vue's workbench idiom.
 *
 * The GLB stage is fail-soft (Task 4's own framing: display-only asset): if
 * `/models/body-reference.glb` can't be loaded (missing, WebGL unavailable,
 * fetch failure), the sliders and the phrase line still work — the figure
 * just doesn't render. Nothing here ever spends money; Save is a single free
 * PATCH.
 *
 * Status wording rules carried over from CharacterStudioModal: no
 * "locked"/"draft"/"stress"/"variant" anywhere in user-facing text.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, Ruler, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { BodySliderId } from '#shared/characters/types'
import { BODY_SLIDERS } from '#shared/characters/types'
import { useCharacters } from '~/composables/useCharacters'
import { BODY_PRESETS, defaultBodyShape, influencesFor, type BodyShape } from '~/lib/characters/bodyShape'
import { bodyPhrase } from '~/lib/characters/bodyPhrase'
import { loadGlb } from '~/lib/scene3d/glb'
import { registerWebGLContext, type WebGLContextHandle } from '~/lib/webgl/contextRegistry'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ close: [] }>()

const { characters, patchCharacter } = useCharacters()
const character = computed(() => characters.value.find(c => c.slug === props.slug) ?? null)

const SLIDER_LABEL: Record<BodySliderId, string> = {
  frame: 'Frame', height: 'Height', build: 'Build', muscle: 'Muscle',
  shoulders: 'Shoulders', chest: 'Chest', waist: 'Waist', hips: 'Hips',
}

// ── Local editing state — seeded once from the record, then owned here until Save. ──
const local = ref<Record<BodySliderId, number>>(defaultBodyShape())
let seeded = false
watch(character, (c) => {
  if (!c || seeded) return
  seeded = true
  local.value = { ...defaultBodyShape(), ...(c.bodyShape ?? {}) }
}, { immediate: true })

const phraseLine = computed(() => bodyPhrase(local.value) || 'Nothing — reads as an average build.')

function applyPreset(shape: BodyShape) {
  local.value = { ...defaultBodyShape(), ...shape }
}

// ── Close (Escape / backdrop / X / Cancel) — one handler, always discards. ──
function requestClose() { emit('close') }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') requestClose()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// ── Save ──────────────────────────────────────────────────────────────────
const saving = ref(false)
async function onSave() {
  saving.value = true
  try {
    const ok = await patchCharacter(props.slug, { bodyShape: local.value })
    if (!ok) { toast.error('Couldn\'t save the body — try again'); return }
    emit('close')
  } finally {
    saving.value = false
  }
}

// ── 3D stage (fail-soft) — three.js dynamic import, GLB module-cached via loadGlb. ──
const GLB_URL = '/models/body-reference.glb'
const stageRef = ref<HTMLDivElement | null>(null)
const stageReady = ref(false)
const stageFailed = ref(false)

let THREE: any = null
let renderer: any = null
let ctxHandle: WebGLContextHandle | null = null
let scene: any = null
let camera: any = null
let orbit: any = null
let morphMeshes: any[] = []
let rafId = 0
let resizeObs: ResizeObserver | null = null

function applyMorphs() {
  if (!morphMeshes.length) return
  const influences = influencesFor(local.value)
  for (const mesh of morphMeshes) mesh.morphTargetInfluences = influences.slice()
}
watch(local, applyMorphs, { deep: true })

async function initStage() {
  const el = stageRef.value
  if (!el) return
  THREE = await import('three')
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')

  const group = await loadGlb(GLB_URL)
  // The baked source mesh (scripts/bake-body-model/bake.py, a hand-rolled GLB
  // binary writer) carries its vertex data in the MakeHuman/Blender Z-up
  // convention but never rotates it before writing — so a spec-compliant
  // Y-up glTF consumer (this one included) renders the figure lying on its
  // side. Correct it once, here, at the only real consumer of the asset.
  group.rotation.x = -Math.PI / 2

  const w = el.clientWidth || 480, h = el.clientHeight || 560
  renderer = new THREE.WebGLRenderer({ antialias: true })
  ctxHandle = registerWebGLContext('BodyEditor')
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(w, h)
  renderer.setClearColor(0x0d0d0f, 1)
  el.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100)

  scene.add(new THREE.AmbientLight(0xffffff, 0.8))
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(2, 3.5, 3); scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.45); fill.position.set(-2.5, 1.5, -2); scene.add(fill)

  // Grey material override — the stage previews SHAPE, not surface/skin.
  const grey = () => new THREE.MeshStandardMaterial({ color: 0x8a8f9c, roughness: 0.75, metalness: 0.02 })
  group.traverse((obj: any) => {
    if (obj.isMesh) {
      obj.material = grey()
      if (obj.morphTargetInfluences?.length === BODY_SLIDERS.length) morphMeshes.push(obj)
    }
  })
  scene.add(group)
  applyMorphs()

  // Frame the camera from the mesh's ACTUAL bounds (post-rotation) rather
  // than a guessed height/distance — the source scale isn't documented and
  // guessing badly means orbiting inside the mesh (reproduced live: a
  // hardcoded ~1m-human guess put the camera inside the figure's leg).
  const box = new THREE.Box3().setFromObject(group)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const dist = Math.max(size.y, size.x, size.z) * 1.6

  orbit = new OrbitControls(camera, renderer.domElement)
  orbit.enableDamping = true
  orbit.target.copy(center)
  orbit.minDistance = dist * 0.3
  orbit.maxDistance = dist * 4
  camera.position.set(center.x, center.y + size.y * 0.1, center.z + dist)
  orbit.update()

  resizeObs = new ResizeObserver(onResize)
  resizeObs.observe(el)

  const tick = () => {
    rafId = requestAnimationFrame(tick)
    orbit.update()
    renderer.render(scene, camera)
  }
  tick()
  stageReady.value = true
}

function onResize() {
  const el = stageRef.value
  if (!el || !renderer || !camera) return
  const w = el.clientWidth || 480, h = el.clientHeight || 560
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

onMounted(() => {
  initStage().catch(() => { stageFailed.value = true })
})
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  rafId = 0
  resizeObs?.disconnect()
  try {
    orbit?.dispose?.()
    renderer?.forceContextLoss?.()
    renderer?.dispose?.()
  } catch { /* ignore */ }
  if (renderer?.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  renderer = null; scene = null; camera = null; orbit = null; morphMeshes = []
  ctxHandle?.release(); ctxHandle = null
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" @mousedown.self="requestClose">
      <div
        role="dialog"
        aria-modal="true"
        class="flex h-[620px] max-h-[94vh] w-[900px] max-w-[97vw] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e10] text-white shadow-2xl outline-none"
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 pt-3 pb-2.5">
          <Ruler class="size-3.5 text-white/50" />
          <span class="text-[13px] font-medium tracking-[-0.01em] text-white/90">Body{{ character ? ` — ${character.name}` : '' }}</span>
          <span class="flex-1" />
          <span class="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/30">esc</span>
          <button type="button" aria-label="Close" class="ml-1 text-white/40 transition hover:text-white/80 cursor-pointer" @click="requestClose">
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- Body -->
        <div class="flex min-h-0 flex-1">
          <!-- 3D stage -->
          <div class="relative min-w-0 flex-1 bg-[#0d0d0f]">
            <div ref="stageRef" class="absolute inset-0" />
            <div v-if="!stageReady && !stageFailed" class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader2 class="size-6 animate-spin text-white/40" />
            </div>
            <div v-if="stageFailed" class="absolute inset-0 flex items-center justify-center px-8 text-center">
              <p class="text-[11.5px] leading-relaxed text-white/35">
                A preview isn't available right now — the sliders and the description on the right still work and still save.
              </p>
            </div>
            <div v-if="stageReady" class="absolute bottom-3 left-3 text-[10px] text-white/30 pointer-events-none">
              Drag to orbit · scroll to zoom
            </div>
          </div>

          <!-- Right panel: presets + sliders + phrase -->
          <div class="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/[0.06] p-3">
            <div>
              <div class="mb-1.5 text-[10px] uppercase tracking-wide text-white/40">Presets</div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="p in BODY_PRESETS" :key="p.id"
                  type="button"
                  class="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/75 hover:bg-white/[0.1] cursor-pointer"
                  @click="applyPreset(p.shape)"
                >{{ p.label }}</button>
              </div>
            </div>

            <div class="flex flex-col gap-2.5">
              <div v-for="id in BODY_SLIDERS" :key="id">
                <StudioSlider
                  :model-value="local[id]"
                  @update:model-value="(v) => (local[id] = v)"
                  :label="SLIDER_LABEL[id]"
                  :min="0"
                  :max="1"
                  :step="0.01"
                  :bindable="false"
                />
              </div>
            </div>

            <div class="mt-auto rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
              <div class="mb-0.5 text-[9.5px] uppercase tracking-wide text-white/30">Reads as</div>
              <p class="text-[11.5px] leading-relaxed text-white/70">{{ phraseLine }}</p>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex shrink-0 items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
          <span class="text-[10.5px] text-white/30">Free & instant — nothing is generated while you slide.</span>
          <span class="flex-1" />
          <StudioButton variant="secondary" :disabled="saving" @click="requestClose">Cancel</StudioButton>
          <StudioButton variant="primary" :disabled="saving" @click="onSave">
            <Loader2 v-if="saving" class="size-3 animate-spin" />
            Save body
          </StudioButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>
