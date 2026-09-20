<script setup lang="ts">
// A few-option enum as ONE Studio row: the label sits on the left exactly where a slider's
// does (same row height, fill, radius, type), the segments on the right. Use this wherever a
// segmented control needs a label — a heading stacked above a bare StudioSegmented reads as a
// different control family next to the rows around it. Bare StudioSegmented stays for the
// places that draw no row (section badges, toolbars).
const model = defineModel<string>({ required: true })
// `optionLabels` pairs with `options` by index (as on StudioSelect / StudioSegmented).
defineProps<{ label: string; options: string[]; optionLabels?: string[] }>()
</script>

<template>
  <div class="flex h-7 select-none items-center justify-between gap-2 overflow-hidden rounded-[6px] bg-white/[0.05] pl-2.5 pr-[3px]">
    <span class="min-w-0 truncate text-[11px] text-white/72">{{ label }}</span>
    <div role="radiogroup" :aria-label="label" class="flex shrink-0 items-center gap-0.5">
      <button v-for="(o, i) in options" :key="o" type="button" role="radio" :aria-checked="model === o"
              :data-value="o" @click="model = o"
              class="h-[22px] rounded-[4px] px-2.5 text-[11px] leading-none transition-colors"
              :class="[model === o ? 'bg-white text-neutral-900' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/80', { capitalize: !optionLabels }]">
        {{ optionLabels?.[i] ?? o }}
      </button>
    </div>
  </div>
</template>
