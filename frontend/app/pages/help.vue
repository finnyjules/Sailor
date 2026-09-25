<!-- frontend/app/pages/help.vue -->
<script setup lang="ts">
// Minimal help surface: the three things a new user actually needs — how to
// get a first result, what things cost, and the keyboard the canvas answers to.
import { ArrowLeft } from 'lucide-vue-next'

const shortcuts: { keys: string; does: string }[] = [
  { keys: '⌘Z / ⌘⇧Z', does: 'Undo / redo canvas changes' },
  { keys: '⌘C / ⌘V', does: 'Copy / paste selected nodes' },
  { keys: 'Delete', does: 'Delete the selection' },
  { keys: 'Esc', does: 'Close menus and previews' },
  { keys: 'S · C · A', does: 'Drop a sticky note · checklist · arrow' },
  { keys: 'Right-click canvas', does: 'Run All, Fit View, Select All, annotations' },
  { keys: 'Double-click a tab', does: 'Rename the project' },
]
</script>

<template>
  <div class="min-h-screen bg-background text-white">
    <div class="mx-auto max-w-2xl px-6 py-10">
      <NuxtLink to="/" class="mb-8 inline-flex items-center gap-1.5 text-[12px] text-white/40 transition hover:text-white/80">
        <ArrowLeft class="size-3.5" /> Back to home
      </NuxtLink>

      <h1 class="text-[20px] font-semibold tracking-tight">Help</h1>

      <section class="mt-8">
        <h2 class="text-[11px] font-medium uppercase tracking-wide text-white/50">Getting started</h2>
        <ol class="mt-3 space-y-2 text-[13px] leading-relaxed text-white/75">
          <li>1. Pick a starting point on Home — "Create an image" drops a ready-to-run generator on the canvas.</li>
          <li>2. Type what you want into the node's prompt, then press its Play button (or Run, top right).</li>
          <li>3. Your result lands on the canvas and is saved to Assets. Select it to see one-click follow-ups.</li>
        </ol>
        <p class="mt-3 text-[12px] leading-relaxed text-white/40">
          Stuck on a graph? Select some nodes and ask <span class="text-white/60">"What does this do?"</span> in the prompt at the bottom — Sailor describes it in plain language.
        </p>
      </section>

      <section class="mt-8">
        <h2 class="text-[11px] font-medium uppercase tracking-wide text-white/50">Costs</h2>
        <p class="mt-3 text-[13px] leading-relaxed text-white/75">
          Anything that calls a paid model shows its price before you run it — on the node's badge, on action buttons, and on the Run button as a live estimate. Local nodes are free. Runs above your confirm threshold (Settings → "Confirm runs above") ask first, with a per-node breakdown.
        </p>
      </section>

      <section class="mt-8">
        <h2 class="text-[11px] font-medium uppercase tracking-wide text-white/50">Keyboard</h2>
        <table class="mt-3 w-full text-[12.5px]">
          <tbody>
            <tr v-for="s in shortcuts" :key="s.keys" class="border-t border-white/5">
              <td class="w-44 py-2 pr-4 font-medium text-white/80">{{ s.keys }}</td>
              <td class="py-2 text-white/55">{{ s.does }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
