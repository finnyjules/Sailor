// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { h } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'

enableAutoUnmount(afterEach)
const src = (f: string) => readFileSync(resolve(__dirname, '../../app/components/vue-canvas', f), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'))
const CSS = readFileSync(resolve(__dirname, '../../app/assets/css/node-surfaces.css'), 'utf8')

describe('ContentCard', () => {
  it('name above, media box, meta at the name row end, below after the box', () => {
    const w = mount(ContentCard, {
      props: { name: 'beach-dog.jpg' },
      slots: { default: () => h('img'), meta: () => h('span', { class: 'm' }, '1024 × 768'), below: () => h('div', { class: 'b' }) },
    })
    expect(w.find('.content-card__name').text()).toContain('beach-dog.jpg')
    expect(w.find('.content-card__name .m').exists()).toBe(true)
    expect(w.find('.content-card__media img').exists()).toBe(true)
    const kids = [...w.element.children].map(c => c.className)
    expect(kids.findIndex(c => String(c).includes('content-card__stage'))).toBeLessThan(kids.findIndex(c => String(c) === 'b'))
  })
  it('floating actions sit on the stage, outside the clipping media box', () => {
    const w = mount(ContentCard, { props: { name: 'x' }, slots: { default: () => h('img'), actions: () => h('button') } })
    expect(w.find('.content-card__media .node-float-actions').exists()).toBe(false)
    expect(w.find('.content-card__stage > .node-float-actions').exists()).toBe(true)
  })
  it('the stage holds ports before the media box and the overlay after it, all unclipped', () => {
    const w = mount(ContentCard, {
      props: { name: 'x' },
      slots: { default: () => h('img'), ports: () => h('i', { class: 'p' }), overlay: () => h('b', { class: 'o' }) },
    })
    const stage = w.find('.content-card > .content-card__stage')
    expect(stage.exists()).toBe(true)
    expect(stage.classes()).toContain('relative')
    const kids = [...stage.element.children].map(c => String(c.className))
    expect(kids).toEqual(['p', 'content-card__media', 'o'])
    expect(w.find('.content-card__media .p').exists()).toBe(false)
    expect(w.find('.content-card__media .o').exists()).toBe(false)
  })
  it('no actions slot, no actions box', () => {
    const w = mount(ContentCard, { props: { name: 'x' }, slots: { default: () => h('img') } })
    expect(w.find('.node-float-actions').exists()).toBe(false)
  })
  it('state attributes land on the root', () => {
    const w = mount(ContentCard, { props: { name: 'x', selected: true }, attrs: { 'data-running': 'true', 'data-error': 'true', class: 'artifact-image' } })
    expect(w.attributes('data-running')).toBe('true')
    expect(w.attributes('data-error')).toBe('true')
    expect(w.attributes('data-selected')).toBe('true')
    expect(w.classes()).toContain('artifact-image')
  })
})

describe('content card CSS', () => {
  const rule = (sel: string) => { const i = CSS.indexOf(`${sel} {`); return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i)) }
  it('hidden actions take no clicks and sit above the media overlays', () => {
    expect(rule('.node-float-actions')).toMatch(/pointer-events: none/)
    expect(rule('.node-float-actions')).toMatch(/z-index: 45/)
    expect(rule('.node-float-actions')).toMatch(/top: 8px/)
  })
  it('running and failed are rings on the media box', () => {
    expect(CSS).toMatch(/\.content-card\[data-running\] \.content-card__media \{ box-shadow: 0 0 0 2px var\(--port-color, #fff\), var\(--node-shadow\); \}/)
    expect(CSS).toMatch(/\.content-card\[data-error\] \.content-card__media \{ box-shadow: 0 0 0 2px #ef4444, var\(--node-shadow\); \}/)
  })
  it('actions stay shown while their More menu is open', () => {
    expect(CSS).toMatch(/\.node-float-actions:has\(\[aria-expanded="true"\]\) \{ opacity: 1; pointer-events: auto; \}/)
  })
  it('floating buttons have no backdrop blur', () => {
    const i = CSS.indexOf('/* ---------- content card')
    const block = CSS.slice(i, CSS.indexOf('/* ---------- print surface'))
    expect(block).not.toMatch(/backdrop-filter/)
  })
})

describe('the canvas selection outline sits on the media box', () => {
  const canvas = src('VueNodeCanvas.vue')
  it('has a rule for .content-card__media', () => {
    expect(canvas).toMatch(/\.vue-node-canvas \.vue-flow__node\.selected \.content-card__media \{\s*outline: 2px solid var\(--action\);\s*outline-offset: 3px;\s*\}/)
  })
})

/** Every port sits in the card's #ports slot (so it centres on the media), none outside it. */
function portsInSlot(t: string) {
  const i = t.indexOf('<template #ports>')
  expect(i).toBeGreaterThan(-1)
  const j = t.indexOf('</template>', i)
  const before = t.slice(0, t.indexOf('<ContentCard'))
  expect(before).not.toMatch(/<VueCanvasNodePort/)
  expect(t.slice(i, j)).toMatch(/<VueCanvasNodePort/)
  expect((t.match(/<VueCanvasNodePort/g) ?? []).length).toBe((t.slice(i, j).match(/<VueCanvasNodePort/g) ?? []).length)
}

describe('Image card is a content card', () => {
  const s = src('ArtifactImageNode.vue')
  const t = tpl(s)
  it('wraps its media in ContentCard (wrapper kept for its teleports and modals), ports in #ports', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">\s*<ContentCard/)
    portsInSlot(t)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="artifact-image relative z-10 w-\[240px\] select-none"/)
    expect(t).toMatch(/:name="filenameLabel \|\| 'Image'"/)
    expect(t).toMatch(/:data-error="data\.error \|\| undefined"/)
  })
  it('uses the shared ports with unchanged ids, including the mask', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/:id="`output-\$\{imageOutIdx\}`"/)
    expect(t).toMatch(/:id="`output-\$\{maskOutIdx\}`"/)
  })
  it('the hover strip became Download + More; no frame border', () => {
    expect(t).toMatch(/#actions[\s\S]*title="Download"[\s\S]*<NodeMoreMenu :items="moreItems" \/>/)
    expect(s).toMatch(/label: 'Save as character', onSelect: saveAsCharacter/)
    expect(t).not.toMatch(/artifact-frame/)
    expect(t).not.toMatch(/ring-2 ring-red-500/)
  })
  it('takes strip still below the card', () => {
    expect(t).toMatch(/#below[\s\S]*<TakesStrip/)
  })
  it('the ready mark rides in #overlay, not in the clipping media', () => {
    expect(t).toMatch(/<template #overlay>\s*<VueCanvasNodeReadyBadge :node-id="id" \/>\s*<\/template>/)
    expect((t.match(/<VueCanvasNodeReadyBadge/g) ?? []).length).toBe(1)
  })
  it('bypassed and locked edges are a ::before, not outline/box-shadow on the media', () => {
    expect(s).toMatch(/\.artifact-image--bypassed :deep\(\.content-card__media\)::before \{\s*border: 1px dashed rgba\(251, 191, 36, 0\.35\);/)
    expect(s).toMatch(/\.artifact-image--locked :deep\(\.content-card__media\)::before \{[\s\S]{0,200}box-shadow: inset 0 0 0 1px rgba\(251, 191, 36, 0\.45\);/)
    expect(s).not.toMatch(/:deep\(\.content-card__media\) \{\s*outline/)
  })
  it('dropped the dead hovered flag', () => {
    expect(s).not.toMatch(/\bhovered\b/)
  })
})

describe.each([
  ['ArtifactVideoNode.vue', 'artifact-video', 'w-\\[280px\\]', 'downloadVideo'],
  ['ArtifactAudioNode.vue', 'artifact-audio', 'w-\\[280px\\]', 'downloadAudio'],
])('%s is a content card', (file, cls, width, dl) => {
  const s = src(file)
  const t = tpl(s)
  it('ContentCard is the root, shared ports in #ports, no frame', () => {
    expect(t).toMatch(/^<template>\s*<ContentCard/)
    portsInSlot(t)
    expect(t).toMatch(new RegExp(`<ContentCard[\\s\\S]{0,200}class="${cls} relative z-10 ${width} select-none"`))
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).not.toMatch(/artifact-frame/)
  })
  it('Download + More on hover', () => {
    expect(t).toMatch(new RegExp(`#actions[\\s\\S]*${dl}[\\s\\S]*<NodeMoreMenu`))
  })
  it('ready mark in #overlay; bypass edge is a ::before', () => {
    expect(t).toMatch(/<template #overlay>\s*<VueCanvasNodeReadyBadge :node-id="id" \/>\s*<\/template>/)
    expect(s).toMatch(new RegExp(`\\.${cls}--bypassed :deep\\(\\.content-card__media\\)::before \\{[\\s\\S]{0,200}border: 1px dashed rgba\\(251, 191, 36, 0\\.35\\);`))
    expect(s).not.toMatch(/outline: 1px dashed/)
  })
})
it('Audio: the player row ends before the floating actions', () => {
  expect(tpl(src('ArtifactAudioNode.vue'))).toMatch(/<div class="pl-3 pr-\[72px\] pt-3 pb-2 flex items-center gap-2">\s*<AudioWaveform[\s\S]{0,120}<audio/)
})
it('Audio keeps its seconds line', () => {
  expect(src('ArtifactAudioNode.vue')).toContain('(props.data as any).audioSeconds = { file: widgetFilename.value, seconds }')
})

it('Image keeps its main output port guard', () => {
  expect(tpl(src('ArtifactImageNode.vue'))).toMatch(/<VueCanvasNodePort\s+v-if="imageOutIdx >= 0"/)
})

describe('Text card is a content card', () => {
  const s = src('ArtifactTextNode.vue'); const t = tpl(s)
  it('named by its own words, content card, shared ports', () => {
    expect(s).toMatch(/const cardName = computed\(/)
    expect(t).toMatch(/:name="cardName"/)
    expect(t).toMatch(/^<template>\s*<ContentCard/)
    portsInSlot(t)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="artifact-text relative z-10 w-\[300px\] select-none"/)
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).not.toMatch(/artifact-frame/)
    expect(t).toMatch(/:data-error="data\.error \|\| undefined"/)
  })
  it('keeps run controls and the user text weight', () => {
    expect(t).toMatch(/runAllEntries/)
    expect(t).toMatch(/runThisNode/)
    expect(t).toMatch(/textarea[\s\S]{0,300}font-normal/)
  })
  it('"Add entry" is sentence case at 12px, not uppercase', () => {
    expect(t).toMatch(/text-\[12px\] text-white\/40[\s\S]{0,200}title="Add another entry"/)
    expect(t).not.toMatch(/uppercase tracking-wide/)
  })
})

describe('3D model card is a content card, still orbitable', () => {
  const s = src('Artifact3DNode.vue')
  const t = tpl(s)
  it('ContentCard is the root, ports in #ports, ready mark in #overlay', () => {
    expect(t).toMatch(/^<template>\s*<ContentCard/)
    portsInSlot(t)
    expect(t).toMatch(/<template #overlay>\s*<VueCanvasNodeReadyBadge :node-id="id" \/>\s*<\/template>/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="artifact-3d relative z-10 w-\[300px\] select-none"/)
    expect(t).toMatch(/:name="glbName \|\| data\.title \|\| '3D model'"/)
    expect(t).toMatch(/:selected="selected"/)
    expect(t).toMatch(/:data-running="data\.running \|\| undefined"/)
    expect(t).toMatch(/:data-error="data\.error \|\| undefined"/)
  })
  it('no raw Handles; the shared ports use the always-rendered fallback index', () => {
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/:id="`input-\$\{glbInIdx\}`"/)
    expect(t).toMatch(/:id="`output-\$\{glbOutIdx\}`"/)
  })
  it('actions hold Reset view and Download .glb', () => {
    expect(t).toMatch(/#actions[\s\S]*resetView[\s\S]*downloadGlb/)
  })
  it('the viewer stage keeps nopan nodrag', () => {
    expect(t).toMatch(/ref="stageRef" class="nopan nodrag/)
  })
  it('dropped the bordered card div, its error ring, and the header row', () => {
    expect(t).not.toMatch(/border-red-500 ring-2 ring-red-500/)
    expect(t).not.toMatch(/3D Model<\/span>/)
    expect(t).not.toMatch(/bg-\[#141414\]/)
  })
  it('named by the .glb file, sentence-case empty copy', () => {
    expect(s).toMatch(/const glbName = computed<string \| null>\(/)
    expect(s).toMatch(/\[\?&\]filename=/)
    expect(t).toMatch(/Connect a 3D model link, then run/)
    expect(t).not.toMatch(/glb_url · then Run/)
  })
  it('dropped the scoped [data-running] > div rule (shared CSS draws the ring)', () => {
    expect(s).not.toMatch(/\[data-running\]\s*>\s*div/)
  })
})

describe('Character card is its portrait', () => {
  const s = src('CharacterNode.vue')
  const t = tpl(s)
  it('wraps the portrait in ContentCard (wrapper kept for the picker modal), port in #ports', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">\s*<ContentCard/)
    portsInSlot(t)
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]{0,150}id="output-0"/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="character-card relative z-10 w-\[220px\]"/)
    expect(t).toMatch(/:name="character\?\.name \|\| 'Character'"/)
    expect(t).toMatch(/:selected="selected"/)
  })
  it('media is a 3:4 portrait box showing the portrait, falling back to the cover', () => {
    expect(t).toMatch(/aspect-\[3\/4\][\s\S]{0,400}portraitUrl\(character, stateId \?\? undefined\) \?\? coverUrl\(character, stateId \?\? undefined\)/)
  })
  it('no character picks in the media box, deleted reads as today\'s message', () => {
    expect(t).toMatch(/node-btn[\s\S]{0,80}@click\.stop="pickerOpen = true"[\s\S]{0,40}Pick character/)
    expect(t).toMatch(/was deleted\./)
  })
  it('meta is the shortened source count', () => {
    expect(t).toMatch(/#meta[\s\S]*\{\{ identityCount \}\} source/)
  })
  it('actions hold a Change character button, wired to the same picker flag', () => {
    expect(t).toMatch(/#actions[\s\S]*title="Change character"[\s\S]*pickerOpen = true/)
  })
  it('keeps the look select and the missing-refs warning below the box', () => {
    expect(t).toMatch(/#below[\s\S]*@change="onLookChange"/)
    expect(t).toMatch(/No reference photos — add some in the Characters panel\./)
  })
  it('the picker modal stays wired to the same handlers', () => {
    expect(t).toMatch(/<CharacterPickerModal[\s\S]*@pick="pick"[\s\S]*@close="pickerOpen = false"/)
  })
  it('dropped the AtSign-less header row and the bordered frame div', () => {
    expect(t).not.toMatch(/border-white\/10 bg-neutral-900 text-white shadow-lg/)
    expect(t).not.toMatch(/Character<\/span>/)
  })
})

describe('Reference card is its picture', () => {
  const s = src('ReferenceNode.vue')
  const t = tpl(s)
  it('ContentCard is the root, port in #ports', () => {
    expect(t).toMatch(/^<template>\s*<ContentCard/)
    portsInSlot(t)
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]{0,150}id="output-0"/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="reference-card relative z-10 w-\[200px\]"/)
    expect(t).toMatch(/:name="refName \? '@' \+ refName : 'Reference'"/)
    expect(t).toMatch(/:selected="selected"/)
  })
  it('keeps the pinned picker button text and the thumbnail src expression', () => {
    expect(t).toMatch(/Pick a reference…/)
    expect(t).toMatch(/:src="thumbUrl"/)
    expect(t).toMatch(/aspect-square object-cover/)
  })
  it('empty: a square well with the picker centred; a lost @name reads "Reference deleted" above it', () => {
    expect(t).toMatch(/<div v-else class="aspect-square flex flex-col items-center justify-center gap-2 p-3">\s*<p v-if="refName" class="text-\[12px\] text-white\/40">Reference deleted<\/p>\s*<button[^>]*>\s*Pick a reference…/)
  })
  it('keeps the pinned @<name> list and the empty-state text', () => {
    expect(t).toMatch(/@\{\{ n \}\}/)
    expect(t).toMatch(/No references yet/)
  })
  it('actions hold a Change reference button toggling the same picking flag', () => {
    expect(t).toMatch(/#actions[\s\S]*title="Change reference"[\s\S]*picking = !picking/)
  })
  it('dropped the AtSign import and the bordered frame div', () => {
    expect(s).not.toMatch(/AtSign/)
    expect(t).not.toMatch(/border-white\/10 bg-neutral-900 text-white shadow-lg/)
  })
})

describe('Collection card is a grid of its rows', () => {
  const s = src('CollectionNode.vue')
  const t = tpl(s)
  it('ContentCard is the root, both ports visible in #ports', () => {
    expect(t).toMatch(/^<template>\s*<ContentCard/)
    portsInSlot(t)
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]{0,150}id="input-0"[\s\S]{0,150}type="target"/)
    expect(t).toMatch(/<VueCanvasNodePort[\s\S]{0,150}id="output-0"[\s\S]{0,150}type="source"/)
    expect(t).toMatch(/:data-type="data\.inputs\?\.\[0\]\?\.type \?\? 'VARS'"/)
    expect(t).toMatch(/:data-type="data\.outputs\?\.\[0\]\?\.type \?\? 'VARS'"/)
    expect(t).toMatch(/<ContentCard[\s\S]{0,200}class="collection-card relative z-10 w-\[240px\]"/)
    expect(t).toMatch(/:name="collection\.name"/)
    expect(t).toMatch(/:selected="selected"/)
  })
  it('meta shows the row count, pluralised', () => {
    expect(t).toMatch(/#meta[\s\S]*\{\{ rows \}\} \{\{ rows === 1 \? 'row' : 'rows' \}\}/)
  })
  it('uses the shared isImageUrl, no private copy', () => {
    expect(s).toMatch(/import \{ isImageUrl \} from '~\/lib\/collection\/isImageUrl'/)
    expect(s).not.toMatch(/function isImageUrl/)
    expect(src('CollectionDrawer.vue')).toMatch(/import \{ isImageUrl \} from '~\/lib\/collection\/isImageUrl'/)
    expect(src('CollectionDrawer.vue')).not.toMatch(/function isImageUrl/)
  })
  it('has a tiles computed reading the first six rows, image over colour over label', () => {
    expect(s).toMatch(/const tiles = computed\(\(\) => \{/)
    expect(s).toMatch(/c\.rows\.slice\(start, start \+ 6\)/)
    expect(s).toMatch(/const start = Math\.max\(0, Math\.min\(c\.previewRow - 5, c\.rows\.length - 6\)\)/)
    expect(s).toMatch(/index: start \+ i/)
    expect(s).toMatch(/col\.type === 'image'/)
    expect(s).toMatch(/col\.type === 'color'/)
    expect(s).toMatch(/img && isImageUrl\(row\.values\[img\.key\]\)/)
  })
  it('the media grid is a 3-column grid with the previewed row outlined', () => {
    expect(t).toMatch(/grid grid-cols-3 gap-px bg-white\/\[0\.04\]/)
    expect(t).toMatch(/aspect-square/)
    expect(t).toMatch(/outline outline-2 outline-white\/60 -outline-offset-2/)
    expect(t).toMatch(/tile\.index === collection\.previewRow/)
  })
  it('empty collection reads as "No rows" in the media', () => {
    expect(t).toMatch(/No rows/)
  })
  it('double-clicking the grid opens the table', () => {
    expect(t).toMatch(/<div[^>]*@dblclick\.stop="openTable"/)
  })
  it('keeps the scrub row calling the same step function, restyled below the box', () => {
    expect(t).toMatch(/#below[\s\S]*step\(-1\)[\s\S]*previewLabel[\s\S]*step\(1\)/)
    expect(t).toMatch(/nopan nodrag mt-1\.5 flex items-center gap-1 text-\[12px\] text-white\/55/)
  })
  it('actions hold an Open table button wired to the same handler', () => {
    expect(t).toMatch(/#actions[\s\S]*title="Open table"[\s\S]*openTable/)
  })
  it('dropped the raw Handle imports and the bordered frame div', () => {
    expect(s).not.toMatch(/import \{ Handle, Position \}/)
    expect(t).not.toMatch(/border bg-\[#141414\]/)
  })
})

describe('Batch pile carries its name above the stack', () => {
  const s = src('BatchGridNode.vue')
  const t = tpl(s)
  it('root is a content-card with the name row before PileStack, root width unchanged', () => {
    expect(t).toMatch(/^<template>\s*<div class="content-card w-\[220px\] select-none" :data-selected="selected \|\| undefined">/)
    expect(t).toMatch(/content-card__name[\s\S]{0,80}Batch[\s\S]{0,300}<PileStack/)
  })
  it('the name row carries no count (the pile\'s badge shows it)', () => {
    const row = t.slice(t.indexOf('content-card__name'), t.indexOf('<PileStack'))
    expect(row).not.toMatch(/items\.length/)
  })
  it('PileStack keeps its images/seed-key/selected props and the rail buttons', () => {
    expect(t).toMatch(/<PileStack :images="items\.map\(i => i\.url\)" :seed-key="String\(props\.id\)" :selected="selected">/)
    expect(t).toMatch(/#rail[\s\S]*openGallery[\s\S]*downloadZip/)
  })
})

describe('Sketch pile carries its name above the stack', () => {
  const s = src('SketchPileNode.vue')
  const t = tpl(s)
  it('root is a content-card with the name row before PileStack, pointerdown/click kept', () => {
    expect(t).toMatch(/^<template>\s*<div class="content-card w-\[220px\] select-none" :data-selected="selected \|\| undefined" @pointerdown="onPointerDown" @click="onClick">/)
    expect(t).toMatch(/content-card__name[\s\S]{0,40}Sketches[\s\S]{0,300}<PileStack/)
  })
  it('PileStack keeps its images/seed-key/selected/dashed/loading props', () => {
    expect(t).toMatch(/<PileStack[\s\S]{0,40}:images="images"[\s\S]{0,60}:seed-key="String\(props\.id\)"[\s\S]{0,40}:selected="selected"[\s\S]{0,20}dashed[\s\S]{0,40}:loading="loading"/)
  })
})

describe('Moodboard pile carries its name above the stack', () => {
  const s = src('MoodboardNode.vue')
  const t = tpl(s)
  it('wrapper and NodePort stay exactly as they are', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">/)
    expect(t).toMatch(/<VueCanvasNodePort\s*\n\s*id="output-0" type="source" side="right" :index="0"/)
  })
  it('the inner box is a content-card, name row carries the entry name above the pile', () => {
    expect(t).toMatch(/class="content-card relative z-10 w-\[220px\] select-none cursor-pointer"[\s\S]{0,60}:data-selected="selected \|\| undefined"/)
    expect(t).toMatch(/content-card__name[\s\S]{0,60}\{\{ entry\?\.name \|\| 'Moodboard' \}\}[\s\S]{0,300}<PileStack/)
  })
  it('the reading summary is now a title tooltip on the pile, not a line below it', () => {
    expect(t).toMatch(/<PileStack[\s\S]{0,200}:title="entry\?\.reading\?\.summary \|\| undefined"/)
    expect(t).not.toMatch(/text-\[11px\] text-white\/45 truncate">\{\{ entry\.reading\.summary \}\}/)
  })
  it('keeps the empty "drop inspiration" state and the overflow rail badge', () => {
    expect(t).toMatch(/drop inspiration/)
    expect(t).toMatch(/#rail[\s\S]*overflow[\s\S]*\+\{\{ overflow \}\}/)
  })
})

describe('isImageUrl (shared by the Collection table and card)', () => {
  it('accepts image files, /view links and http(s) URLs; rejects the rest', async () => {
    const { isImageUrl } = await import('~/lib/collection/isImageUrl')
    expect(isImageUrl('cat.png')).toBe(true)
    expect(isImageUrl('a/b/photo.JPEG?x=1')).toBe(true)
    expect(isImageUrl('x.webp#frag')).toBe(true)
    expect(isImageUrl('/view?filename=a.png&type=input')).toBe(true)
    expect(isImageUrl('https://example.com/anything')).toBe(true)
    expect(isImageUrl('hello world')).toBe(false)
    expect(isImageUrl('notes.txt')).toBe(false)
    expect(isImageUrl(null)).toBe(false)
    expect(isImageUrl(undefined)).toBe(false)
    expect(isImageUrl(42)).toBe(false)
  })
})
