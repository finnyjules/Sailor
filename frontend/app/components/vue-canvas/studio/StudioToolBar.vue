<script setup lang="ts">
// The small shared tool bar under a studio's prompt (spec §2.4): viewport
// controls only (zoom, repeat, play and scrub). Neutral — never pastel.
</script>

<template>
  <div data-testid="studio-tool-bar" class="flex max-w-full items-center gap-0.5 self-center overflow-x-auto rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-[5px] shadow-lg">
    <slot />
  </div>
</template>
