<script setup lang="ts">
/**
 * WidgetModelPicker — node-body launcher button that opens a model gallery.
 * Replaces the standard Combo dropdown for inputs the backend marks with
 * `extra_dict={"sailor_widget": "model_picker"}` (default kind 'image')
 * or `"video_model_picker"` for video models.
 *
 * Reads the matching catalog so the button can show the model's brand
 * swatch and pretty label instead of the raw id. Falls back to the id when
 * the model isn't in the catalog (lets old workflows with unknown ids still
 * render without crashing).
 */
import { ChevronRight } from 'lucide-vue-next'
import { IMAGE_MODELS_BY_ID } from '~/data/image-models'
import { VIDEO_MODELS_BY_ID } from '~/data/video-models'
import { TEXT_EFFECTS_BY_ID } from '~/data/text-effects'
import { SHOT_PRESETS_BY_ID } from '~/data/shot-presets'
import { getBrandIcon } from '~/data/brand-icons'

const props = defineProps<{
  modelValue: string                    // selected model/effect id
  nodeId?: string                       // forwarded to the open event
  // Catalog kind. Defaults to 'image' for backwards compatibility with the
  // existing GenerateImageNode wiring. Video node passes 'video', the text
  // effect node passes 'text_effect'.
  kind?: 'image' | 'video' | 'text_effect' | 'shot_preset'
}>()

// The widget framework still expects update:modelValue even though we don't
// emit it directly (the modal writes to widgetsValues via the node ref).
defineEmits<{ 'update:modelValue': [value: string] }>()

const kind = computed(() => props.kind ?? 'image')

// Catalog lookup is a dispatch on `kind`. Text effects have a different shape
// (no brand/cover) so we normalize to a tiny common view-model: label + an
// optional accent color for the swatch.
interface PickerItem { label: string; brand?: string; accent?: string }
const item = computed<PickerItem | null>(() => {
  const id = props.modelValue
  if (!id) return null
  if (kind.value === 'video') {
    const m = VIDEO_MODELS_BY_ID[id]
    return m ? { label: m.label, brand: m.brand } : null
  }
  if (kind.value === 'text_effect') {
    const e = TEXT_EFFECTS_BY_ID[id]
    return e ? { label: e.label, accent: e.accent } : null
  }
  if (kind.value === 'shot_preset') {
    const p = SHOT_PRESETS_BY_ID[id]
    return p ? { label: p.label, accent: '#5b8dd9' } : null
  }
  const m = IMAGE_MODELS_BY_ID[id]
  return m ? { label: m.label, brand: m.brand } : null
})
// Back-compat alias so the rest of the template reads naturally.
const model = item
const brandIcon = computed(() => model.value?.brand ? getBrandIcon(model.value.brand) : null)

// Cover cache keys differ per catalog so video and image entries don't
// collide on identical replicate slug strings (unlikely but cheap to avoid).
const COVER_CACHE_KEY = computed(() =>
  kind.value === 'video' ? 'video-models.coverCache.v1' : 'image-models.coverCache.v1',
)
const cachedCoverUrl = computed<string | null>(() => {
  if (!model.value || kind.value === 'text_effect' || kind.value === 'shot_preset') return null  // effects have no cover
  try {
    const raw = localStorage.getItem(COVER_CACHE_KEY.value)
    if (!raw) return null
    const cache = JSON.parse(raw) as Record<string, { url: string | null }>
    return cache[(model.value as any).replicateSlug]?.url ?? null
  } catch { return null }
})

function openGallery() {
  // Single event name, kind in the payload — VueNodeCanvas decides which
  // modal to mount based on `detail.kind`.
  window.dispatchEvent(new CustomEvent('sailor:openModelGallery', {
    detail: { nodeId: props.nodeId, kind: kind.value },
  }))
}
</script>

<template>
  <button
    class="nopan nodrag w-full h-8 flex items-center justify-between gap-2 px-[11px] rounded-[6px] bg-white/[0.03] hover:bg-white/[0.065] transition-colors cursor-pointer text-left group"
    :title="model
      ? `${model.label} — click to change ${kind === 'shot_preset' ? 'shot' : 'model'}`
      : `Pick a ${kind === 'shot_preset' ? 'shot' : 'model'} (current: ${modelValue || '—'})`"
    @click="openGallery"
  >
    <span data-picker-label class="text-[11px] text-white/55 shrink-0">
      {{ kind === 'text_effect' ? 'Effect' : kind === 'shot_preset' ? 'Shot' : 'Model' }}
    </span>
    <span class="flex items-center gap-2 min-w-0 flex-1 justify-end">
      <!-- Neutral frame. Priority order, top to bottom:
             1. Comfy partner brand icon (BFL / Google / Ideogram / …)
             2. Cached cover image as a fallback when no brand icon ships
             3. Brand initial as a last-resort glyph
           Picking the brand icon over the cover keeps the launcher readable at
           a glance — a logo is the strongest brand cue at 16px square. -->
      <span
        class="size-4 rounded-md shrink-0 flex items-center justify-center text-[8px] font-semibold leading-none text-white/70 bg-white/[0.06] overflow-hidden relative"
      >
        <span
          v-if="brandIcon"
          :class="[
            brandIcon.cssClass,
            brandIcon.style === 'mono' ? 'bg-white/85' : '',
          ]"
          class="size-3"
        />
        <img
          v-else-if="cachedCoverUrl"
          :src="cachedCoverUrl"
          class="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <!-- Text-effect swatch: a little accent gradient chip in lieu of a logo. -->
        <span
          v-else-if="model?.accent"
          class="absolute inset-0"
          :style="{ background: `linear-gradient(135deg, ${model.accent}, #ffffff)` }"
        />
        <span v-else>{{ model?.brand?.[0] ?? '?' }}</span>
      </span>
      <span class="text-[11px] text-white/90 truncate leading-tight">
        {{ model?.label ?? modelValue ?? (kind === 'text_effect' ? 'Pick an effect' : kind === 'shot_preset' ? 'Pick a shot' : 'Pick a model') }}
      </span>
    </span>
    <ChevronRight class="size-3.5 text-white/30 group-hover:text-white/55 shrink-0 transition-colors" />
  </button>
</template>
