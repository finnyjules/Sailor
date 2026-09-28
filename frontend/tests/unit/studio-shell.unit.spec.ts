import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
/** The class attribute of the element that carries `node-shell`. */
const shellClass = (t: string) => (t.match(/class="([^"]*\bnode-shell\b[^"]*)"/) ?? [])[1] ?? ''
/** The opening tag of the element that carries `node-shell`. Scans quote-aware
 * so a `>` inside an attribute value (e.g. an arrow function) doesn't end the tag early. */
const shellTag = (t: string) => {
  const i = t.search(/class="[^"]*\bnode-shell\b/)
  const start = t.lastIndexOf('<', i)
  let inQuote = false
  for (let j = start; j < t.length; j++) {
    if (t[j] === '"') inQuote = !inQuote
    else if (t[j] === '>' && !inQuote) return t.slice(start, j + 1)
  }
  return t.slice(start)
}

const FAMILY_A = [
  'GradientStudioNode.vue', 'ShaderStudioNode.vue', 'TextureStudioNode.vue',
  'ShapeStudioNode.vue', 'VectorTypeNode.vue', 'SpaceTypeNode.vue',
  'Scene3DStudioNode.vue',
]

describe.each(FAMILY_A)('%s wears the studio shell', (file) => {
  const s = src(file)
  const t = tpl(s)
  it('the card is a 240px glass shell over its ports', () => {
    const c = shellClass(t)
    expect(c).toMatch(/\brelative\b/)
    expect(c).toMatch(/\bz-10\b/)
    expect(c).toMatch(/\bw-\[240px\]/)
    expect(c).not.toMatch(/rounded-xl|\bborder\b|bg-neutral-900|shadow-lg|overflow-hidden|text-white/)
  })
  it('carries glass and selection, and opens on double-click', () => {
    const tag = shellTag(t)
    expect(tag).toMatch(/:data-glass-blur="glass \|\| undefined"/)
    expect(tag).toMatch(/:data-selected="selected \|\| undefined"/)
    expect(tag).toMatch(/@dblclick\.stop="\(e\) => \{ if \(!isStudioControl\(e\)\) openEditor\(\) \}"/)
    expect(s).toMatch(/selected\?: boolean/)
    expect(s).toMatch(/const glass = useNodeGlass\(\(\) => props\.id\)/)
  })
  it('header is icon + title only', () => {
    expect(t).toMatch(/class="node-shell__head"/)
    expect(t).toMatch(/class="node-shell__title"/)
  })
  it('the preview sits in a well with an Open bar', () => {
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(s).toMatch(/import NodeOpenBar from '~\/components\/vue-canvas\/surfaces\/NodeOpenBar\.vue'/)
  })
  it('the footer is only the Render control', () => {
    expect(t).toMatch(/class="node-shell__foot justify-end"[\s\S]{0,200}<StudioRenderButton :node-id="id" :busy="!!data\?\.studioBusy" \/>/)
    expect(t).not.toMatch(/Pencil/)
    expect(t).not.toMatch(/>\s*Edit\s*</)
  })
})

describe('Kinetic keeps its hover-to-play and render-error badge', () => {
  const t = tpl(src('SpaceTypeNode.vue'))
  it('the wrapper still owns the hover handlers', () => {
    expect(t).toMatch(/class="studio-node relative w-fit" @pointerenter="onNodeHoverEnter" @pointerleave="onNodeHoverLeave"/)
  })
})

describe('3D Studio keeps its own states', () => {
  const t = tpl(src('Scene3DStudioNode.vue'))
  const tag = shellTag(t)
  it('mute and bypass still dim the card', () => {
    expect(tag).toMatch(/:class="\{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed \}"/)
  })
  it('the ports still set the card height', () => {
    expect(tag).toMatch(/minHeight: `\$\{portsMinHeight\}px`/)
  })
  it('an empty scene still offers a non-interactive placeholder inside the well', () => {
    expect(t).toMatch(/class="node-well node-openbar-host aspect-square"[\s\S]*No scene yet/)
  })
})

describe.each(['ShotDirectorNode.vue', 'LipSyncStudioNode.vue'])('%s wears the studio shell', (file) => {
  const s = src(file)
  const t = tpl(s)
  it('keeps the studio-node wrapper first, and a 240px shell card inside it', () => {
    expect(t).toMatch(/^<template>\s*<div[^>]*class="studio-node relative w-fit"/)
    expect(shellClass(t)).toMatch(/\bw-\[240px\]/)
    expect(shellClass(t)).not.toMatch(/rounded-xl|\bborder\b|bg-neutral-900|shadow-lg|overflow-hidden/)
  })
  it('uses the shared ports, not raw handles', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]*?id="output-0"/)
    expect(s).not.toMatch(/import \{ Handle/)
  })
  it('opens on double-click, has glass and selection', () => {
    const tag = shellTag(t)
    expect(tag).toMatch(/@dblclick\.stop="\(e\) => \{ if \(!isStudioControl\(e\)\) openEditor\(\) \}"/)
    expect(tag).toMatch(/:data-glass-blur="glass \|\| undefined"/)
    expect(tag).toMatch(/:data-selected="selected \|\| undefined"/)
  })
  it('the summary sits in a well with an Open bar; Generate is the white footer button', () => {
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(t).toMatch(/class="node-shell__foot"[\s\S]*node-btn node-btn--primary[\s\S]*Generate/)
    expect(t).not.toMatch(/Pencil/)
  })
})
it('Shot Director keeps three cast ports', () => {
  expect(tpl(src('ShotDirectorNode.vue'))).toMatch(/v-for="i in 3"[\s\S]{0,200}:id="`input-\$\{i - 1\}`"/)
})
it('Lip-sync keeps Generate disabled while it has issues', () => {
  expect(tpl(src('LipSyncStudioNode.vue'))).toMatch(/node-btn--primary[^>]*:disabled="hasError"|:disabled="hasError"[^>]*node-btn--primary/)
})

describe('Smart Layout body', () => {
  const s = src('SmartLayoutNodeBody.vue')
  const t = tpl(s)
  it('sits on the generator card inset (10px), not its own', () => {
    expect(t).toMatch(/^<template>\s*<div class="px-2\.5 pb-2\.5 pt-1 nopan nodrag flex flex-col gap-\[5px\]">/)
  })
  it('a designed layout shows a well with an Open bar that edits', () => {
    expect(t).toMatch(/v-if="elementCount"[\s\S]*class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar :meta="summary">[\s\S]*@click\.stop="emit\('edit'\)"[\s\S]*>Open<\/button>/)
  })
  it('Batch export is the white node button; an empty layout keeps Design layout', () => {
    expect(t).toMatch(/node-btn node-btn--primary[^"]*"[\s\S]{0,200}Batch export/)
    expect(t).toMatch(/node-btn node-btn--primary[^"]*"[\s\S]{0,200}Design layout/)
    expect(t).not.toMatch(/Edit layout/)
  })
})

describe('Pose Mannequin wears the studio shell', () => {
  const s = src('PoseMannequinNode.vue')
  const t = tpl(s)
  const tag = shellTag(t)
  it('a 260px shell card inside the studio-node wrapper, no gradient fill', () => {
    expect(t).toMatch(/^<template>\s*<div[^>]*class="studio-node relative w-fit"/)
    expect(shellClass(t)).toMatch(/\bpose-node\b[\s\S]*\bw-\[260px\]|\bw-\[260px\][\s\S]*\bpose-node\b/)
    expect(tag).not.toMatch(/linear-gradient/)
    expect(tag).not.toMatch(/ring-2|border-red-500/)
  })
  it('running and failed stay as they were, in scoped CSS', () => {
    expect(tag).toMatch(/:data-running="data\.running \|\| undefined"/)
    expect(tag).toMatch(/:data-error="data\.error \|\| undefined"/)
    expect(s).toMatch(/\.pose-node\[data-running\] \{ box-shadow: 0 0 0 2px var\(--port-color, #fff\), 0 4px 16px rgba\(0, 0, 0, 0\.4\); \}/)
    expect(s).toMatch(/\.pose-node\[data-error\] \{ border-color: #ef4444; box-shadow: 0 0 0 2px #ef4444, var\(--node-shadow\); \}/)
    expect(s).toMatch(/\.pose-node\[data-error\]::after \{ display: none; \}/)
  })
  it('shared ports with unchanged ids', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/:id="`input-\$\{characterInIdx\}`"/)
    expect(t).toMatch(/:id="`input-\$\{poseImageInIdx\}`"/)
    expect(t).toMatch(/:id="`output-\$\{imageOutIdx\}`"/)
  })
  it('double-click anywhere opens, except inside a form control', () => {
    expect(tag).toMatch(/@dblclick\.stop="onCardDblclick"/)
    expect(s).toMatch(/function onCardDblclick\(e: MouseEvent\)/)
    expect(s).toMatch(/isStudioControl\(e\)/)
  })
  it('mode switch is the shared segmented control; the mannequin preview has an Open bar; Generate is the footer', () => {
    expect(t).toMatch(/<StudioSegmented/)
    expect(t).toMatch(/class="node-well node-openbar-host[^"]*"[\s\S]*<NodeOpenBar[\s\S]*>Open<\/button>/)
    expect(t).toMatch(/class="node-shell__foot justify-end"[\s\S]*RefreshCw[\s\S]*node-btn--primary[\s\S]*Generate/)
    expect(t).not.toMatch(/Pose & Generate|Edit pose/)
  })
})
