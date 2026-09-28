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
    expect(kids.findIndex(c => String(c).includes('content-card__media'))).toBeLessThan(kids.findIndex(c => String(c).includes('b')))
  })
  it('floating actions sit outside the clipping media box', () => {
    const w = mount(ContentCard, { props: { name: 'x' }, slots: { default: () => h('img'), actions: () => h('button') } })
    expect(w.find('.content-card__media .node-float-actions').exists()).toBe(false)
    expect(w.find('.content-card > .node-float-actions').exists()).toBe(true)
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
    expect(rule('.node-float-actions')).toMatch(/top: 30px/)
  })
  it('running and failed are rings on the media box', () => {
    expect(CSS).toMatch(/\.content-card\[data-running\] \.content-card__media \{ box-shadow: 0 0 0 2px var\(--port-color, #fff\), var\(--node-shadow\); \}/)
    expect(CSS).toMatch(/\.content-card\[data-error\] \.content-card__media \{ box-shadow: 0 0 0 2px #ef4444, var\(--node-shadow\); \}/)
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

describe('Image card is a content card', () => {
  const s = src('ArtifactImageNode.vue')
  const t = tpl(s)
  it('wraps its media in ContentCard inside a port wrapper', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">/)
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
})

describe.each([
  ['ArtifactVideoNode.vue', 'artifact-video', 'w-\\[280px\\]', 'downloadVideo'],
  ['ArtifactAudioNode.vue', 'artifact-audio', 'w-\\[280px\\]', 'downloadAudio'],
])('%s is a content card', (file, cls, width, dl) => {
  const t = tpl(src(file))
  it('ContentCard in a port wrapper, shared ports, no frame', () => {
    expect(t).toMatch(/^<template>\s*<div class="relative w-fit">/)
    expect(t).toMatch(new RegExp(`<ContentCard[\\s\\S]{0,200}class="${cls} relative z-10 ${width} select-none"`))
    expect(t).not.toMatch(/<Handle\b/)
    expect(t).not.toMatch(/artifact-frame/)
  })
  it('Download + More on hover', () => {
    expect(t).toMatch(new RegExp(`#actions[\\s\\S]*${dl}[\\s\\S]*<NodeMoreMenu`))
  })
})
it('Audio keeps its seconds line', () => {
  expect(src('ArtifactAudioNode.vue')).toContain('(props.data as any).audioSeconds = { file: widgetFilename.value, seconds }')
})
