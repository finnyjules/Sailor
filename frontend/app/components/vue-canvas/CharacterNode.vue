<script setup lang="ts">
// Character — canvas card. A castable person from the registry (Task 5);
// wires its CHARACTER output into a Shot Director's cast_1/2/3 inputs.
import { computed, ref } from 'vue'
import { Drama, Replace } from 'lucide-vue-next'
import { useCharacters } from '~/composables/useCharacters'
import CharacterPickerModal from '~/components/vue-canvas/CharacterPickerModal.vue'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import { emitCharacterEvent } from '~/lib/characters/bus'
import { normalizeStateId, pickState, identityRefs, sortStatesLockedFirst, type CharacterState } from '#shared/characters/types'
import { readiness } from '~/lib/characters/readiness'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title?: string
    outputs?: { name: string; type: string; links: number[] | null }[]
    properties?: Record<string, any>
  }
}>()

const { characters, coverUrl, portraitUrl } = useCharacters()
const pickerOpen = ref(false)

/** Reads the single sailor_characterBinding property, falling back to the
 *  three legacy sailor_character{Slug,Name,VariantId} props for nodes saved
 *  before the binding existed. Writes only ever produce the binding. */
const binding = computed<{ slug: string; name: string; stateId: string | null } | null>(() => {
  const b = props.data?.properties?.sailor_characterBinding
  if (b && typeof b.slug === 'string') {
    return { slug: b.slug, name: typeof b.name === 'string' ? b.name : b.slug, stateId: normalizeStateId(b.stateId ?? null) }
  }
  const legacySlug = props.data?.properties?.sailor_characterSlug
  if (typeof legacySlug === 'string') {
    return {
      slug: legacySlug,
      name: props.data?.properties?.sailor_characterName || legacySlug,
      stateId: normalizeStateId(props.data?.properties?.sailor_characterVariantId ?? null),
    }
  }
  return null
})

const slug = computed<string | null>(() => binding.value?.slug ?? null)
const character = computed(() => characters.value.find(c => c.slug === slug.value) ?? null)
const stateId = computed<string | null>(() => binding.value?.stateId ?? null)
/** The state this card actually casts (binding's stateId, falling back to default) — same resolution the caster uses. */
const activeState = computed<CharacterState | undefined>(() => character.value ? pickState(character.value, stateId.value) : undefined)
/** Castable check must count identity assets (sheet + refs), not just refImages — a
 *  sheet-only look (refImages: []) casts fine but would otherwise read as "0 references". */
const identityCount = computed(() => identityRefs(activeState.value).length)

/** Look select order: readiest looks lead. */
const sortedLookStates = computed<CharacterState[]>(() => sortStatesLockedFirst(character.value?.states ?? []))

/** Native <select> can't carry an icon or tone color, so readiness is text on the option itself. */
function lookOptionLabel(v: CharacterState): string {
  const r = readiness(v)
  return r.key === 'ready' ? `${v.label} ✓ ${r.label}` : `${v.label} — ${r.label}`
}

function pick(s: string, name: string, pickedStateId: string | null) {
  if (!props.data.properties) props.data.properties = {}
  props.data.properties.sailor_characterBinding = { slug: s, name, stateId: normalizeStateId(pickedStateId) }
  pickerOpen.value = false
  // Nudge any wired Shot Directors to re-sync their cast.
  emitCharacterEvent('castEdgesChanged')
}

function onLookChange(e: Event) {
  if (!props.data.properties) props.data.properties = {}
  const b = binding.value
  if (!b) return
  const v = (e.target as HTMLSelectElement).value
  props.data.properties.sailor_characterBinding = { slug: b.slug, name: b.name, stateId: normalizeStateId(v) }
  emitCharacterEvent('castEdgesChanged')
}
</script>

<template>
  <div class="relative w-fit">
    <VueCanvasNodePort
      id="output-0"
      type="source"
      side="right"
      :data-type="data.outputs?.[0]?.type ?? 'CHARACTER'"
      label="Character"
      :index="0"
    />

    <ContentCard
      class="character-card relative z-10 w-[220px]"
      :name="character?.name || 'Character'"
      :selected="selected"
    >
      <template #meta>
        <span v-if="character" class="shrink-0 text-white/30">{{ identityCount }} source{{ identityCount === 1 ? '' : 's' }}</span>
      </template>

      <div class="aspect-[3/4] flex items-center justify-center">
        <img
          v-if="character && (portraitUrl(character, stateId ?? undefined) ?? coverUrl(character, stateId ?? undefined))"
          :src="portraitUrl(character, stateId ?? undefined) ?? coverUrl(character, stateId ?? undefined)!" :alt="character.name"
          class="w-full h-full object-cover"
        >
        <div v-else-if="character" class="flex h-10 w-10 items-center justify-center rounded bg-white/[0.06]">
          <Drama class="h-4 w-4 text-white/30" />
        </div>
        <p v-else-if="slug" class="px-3 text-center text-[11px] leading-tight text-red-400/80">
          Character "{{ binding?.name || slug }}" was deleted.
        </p>
        <button v-else type="button" class="node-btn nopan nodrag" @click.stop="pickerOpen = true">
          Pick character
        </button>
      </div>

      <template #actions>
        <button v-if="character" type="button" title="Change character" @click.stop="pickerOpen = true">
          <Replace class="size-3.5" />
        </button>
      </template>

      <template #below>
        <!-- Look select: only when the character has more than one look -->
        <select
          v-if="character && character.states.length > 1"
          :value="stateId ?? character.states.find(v => v.id === 'default')?.id ?? ''"
          class="nopan nodrag mt-1.5 w-full h-8 rounded-md bg-white/[0.03] px-2 text-[12px] text-white/80"
          @change="onLookChange"
        >
          <option v-for="v in sortedLookStates" :key="v.id" :value="v.id">{{ lookOptionLabel(v) }}</option>
        </select>
        <p v-if="character && !identityCount" class="mt-1.5 text-[10px] leading-tight text-amber-400/80">
          No reference photos — add some in the Characters panel.
        </p>
      </template>
    </ContentCard>

    <CharacterPickerModal v-if="pickerOpen" :exclude-slugs="[]" @pick="pick" @close="pickerOpen = false" />
  </div>
</template>
