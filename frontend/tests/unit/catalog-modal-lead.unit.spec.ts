// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CatalogModal from '~/components/CatalogModal.vue'

// CatalogModal's root is a <Teleport to="body">, so everything is queried on document.body.
const items = [{ id: 'a', s: 'x' }, { id: 'b', s: 'y' }]
const body = () => document.body
let w: VueWrapper<any> | null = null
afterEach(() => { w?.unmount(); w = null })

describe('CatalogModal lead card and overlays', () => {
  it('the lead card is first in its section, and the section shows even with no items', () => {
    w = mount(CatalogModal as any, {
      props: { open: true, title: 't', items, selectedId: null, sections: [{ id: 'mine', label: 'My effects' }, { id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], sectionOf: (i: any) => i.s, leadIn: 'mine' },
      slots: { lead: '<button data-testid="lead">Make one</button>', card: '<span>card</span>', 'card-overlay': '<button data-testid="ov">Remix</button>' },
      attachTo: document.body,
    })
    const sections = body().querySelectorAll('section')
    expect(sections).toHaveLength(3)
    expect(sections[0]!.textContent).toContain('My effects')
    const grid = sections[0]!.querySelector('.grid')!
    expect(grid.firstElementChild!.getAttribute('data-testid')).toBe('lead')
    expect(body().querySelectorAll('[data-testid="ov"]')).toHaveLength(2)
    // overlays are not nested inside the card buttons
    for (const ov of body().querySelectorAll('[data-testid="ov"]')) expect(ov.parentElement!.closest('button')).toBeNull()
  })
  it('the lead goes before the items of its own section when that section has items', () => {
    w = mount(CatalogModal as any, {
      props: { open: true, title: 't', items, selectedId: null, sections: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], sectionOf: (i: any) => i.s, leadIn: 'y' },
      slots: { lead: '<button data-testid="lead">Make one</button>', card: '<span>card</span>' },
      attachTo: document.body,
    })
    const sections = body().querySelectorAll('section')
    expect(sections).toHaveLength(2)
    expect(sections[0]!.querySelector('[data-testid="lead"]')).toBeNull()
    expect(sections[1]!.querySelector('.grid')!.firstElementChild!.getAttribute('data-testid')).toBe('lead')
  })
  it('with no sections the lead is first in the flat grid', () => {
    w = mount(CatalogModal as any, {
      props: { open: true, title: 't', items, selectedId: null, leadIn: 'mine' },
      slots: { lead: '<button data-testid="lead">Make one</button>', card: '<span>card</span>' },
      attachTo: document.body,
    })
    expect(body().querySelector('.grid')!.firstElementChild!.getAttribute('data-testid')).toBe('lead')
  })
  it('no items but a lead: no empty message', () => {
    w = mount(CatalogModal as any, { props: { open: true, title: 't', items: [], selectedId: null, leadIn: 'mine', emptyMessage: 'Nothing' }, slots: { lead: '<button data-testid="lead">Make one</button>' }, attachTo: document.body })
    expect(body().textContent).not.toContain('Nothing')
    expect(body().querySelector('[data-testid="lead"]')).not.toBeNull()
  })
  it('no items and no lead: the empty message', () => {
    w = mount(CatalogModal as any, { props: { open: true, title: 't', items: [], selectedId: null, emptyMessage: 'Nothing' }, attachTo: document.body })
    expect(body().textContent).toContain('Nothing')
  })
  it('testid lands on the panel (the root is a Teleport, so attributes cannot fall through)', () => {
    w = mount(CatalogModal as any, { props: { open: true, title: 't', items, selectedId: null, testid: 'my-gallery' }, attachTo: document.body })
    const panel = body().querySelector('[data-testid="my-gallery"]')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('t')
  })
})
