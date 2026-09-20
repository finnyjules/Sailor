import { describe, it, expect } from 'vitest'
import {
  ACTION_CATALOG, DEPRECATED_NODES, HERO_BY_DOMAIN, INTENT_ORDER, groupByIntent, CHIPS_BY_DOMAIN,
  modalHero, ARTIFACT_NODE_FOR_SOURCE,
} from '~/data/action-catalog'

const VALID_INTENTS = ['create', 'edit', 'enhance', 'analyze']

function fake(nodeType: string, label = nodeType) {
  return { nodeType, label }
}

describe('ACTION_CATALOG integrity', () => {
  it('every entry has a valid intent', () => {
    for (const [nodeType, entry] of Object.entries(ACTION_CATALOG)) {
      expect(VALID_INTENTS, `${nodeType} intent "${entry.intent}"`).toContain(entry.intent)
      expect(entry.useCase.length, `${nodeType} useCase`).toBeGreaterThan(0)
    }
  })

  it('every hero nodeType exists in the catalog', () => {
    for (const [domain, nodeTypes] of Object.entries(HERO_BY_DOMAIN)) {
      for (const nt of nodeTypes) {
        expect(ACTION_CATALOG[nt], `${domain} hero ${nt}`).toBeDefined()
      }
    }
  })

  it('deprecated nodes are not in the catalog', () => {
    for (const nt of DEPRECATED_NODES) {
      expect(ACTION_CATALOG[nt], `${nt} is deprecated AND in catalog`).toBeUndefined()
    }
  })

  it('INTENT_ORDER is the four intents then More models', () => {
    expect(INTENT_ORDER.map(s => s.id)).toEqual(['create', 'edit', 'enhance', 'analyze', 'other'])
    expect(INTENT_ORDER[4]!.label).toBe('More models')
  })

  it('every chip nodeType exists in the catalog and is a takes-input intent', () => {
    for (const [domain, chips] of Object.entries(CHIPS_BY_DOMAIN)) {
      for (const chip of chips) {
        const entry = ACTION_CATALOG[chip.nodeType]
        expect(entry, `${domain} chip ${chip.nodeType}`).toBeDefined()
        expect(entry!.intent, `${domain} chip ${chip.nodeType} must not be create`).not.toBe('create')
        expect(chip.chipLabel.length).toBeGreaterThan(0)
        expect(chip.chipLabel.length, `${chip.nodeType} chipLabel is a short verb`).toBeLessThanOrEqual(14)
      }
    }
  })

  it('modalHero returns 8 catalog-backed entries with per-domain caps', () => {
    const hero = modalHero()
    expect(hero).toHaveLength(8)
    for (const h of hero) {
      expect(ACTION_CATALOG[h.nodeType], h.nodeType).toBeDefined()
      expect(h.entry).toBe(ACTION_CATALOG[h.nodeType])
    }
    const domains = { image: 3, video: 2, audio: 2, '3d': 1 } as const
    let i = 0
    for (const [domain, cap] of Object.entries(domains)) {
      const expected = HERO_BY_DOMAIN[domain as keyof typeof HERO_BY_DOMAIN].slice(0, cap)
      expect(hero.slice(i, i + cap).map(h => h.nodeType)).toEqual(expected)
      i += cap
    }
  })

  it('every non-create modalHero entry declares a source, and sources map to artifacts', () => {
    for (const h of modalHero()) {
      if (h.entry.intent !== 'create') {
        expect(h.entry.source, `${h.nodeType} needs source`).toBeDefined()
        expect(ARTIFACT_NODE_FOR_SOURCE[h.entry.source!], `${h.nodeType} source maps`).toBeDefined()
      }
    }
  })
})

describe('groupByIntent', () => {
  it('buckets items by intent in fixed section order and drops empty sections', () => {
    const items = [
      fake('UpscaleImageNode'),     // enhance
      fake('GenerateImageNode'),    // create
      fake('EditImageNode'),        // edit
      fake('DescribeImageNode'),    // analyze
    ]
    const { hero, sections } = groupByIntent(items, [])
    expect(hero).toEqual([])
    expect(sections.map(s => s.label)).toEqual(['Create', 'Edit', 'Enhance', 'Analyze'])
    expect(sections[0]!.items.map(i => i.nodeType)).toEqual(['GenerateImageNode'])
  })

  it('unmapped nodes land in a trailing "More models" section', () => {
    const items = [fake('SomeLegacyPartnerNode', 'Kling 3.0'), fake('GenerateImageNode')]
    const { sections } = groupByIntent(items, [])
    expect(sections.map(s => s.label)).toEqual(['Create', 'More models'])
    expect(sections[1]!.items[0]!.nodeType).toBe('SomeLegacyPartnerNode')
  })

  it('hero items follow heroNodeTypes order and are excluded from sections', () => {
    const items = [
      fake('EditImageNode'), fake('GenerateImageNode'), fake('UpscaleImageNode'),
    ]
    const { hero, sections } = groupByIntent(items, ['GenerateImageNode', 'EditImageNode'])
    expect(hero.map(i => i.nodeType)).toEqual(['GenerateImageNode', 'EditImageNode'])
    const sectioned = sections.flatMap(s => s.items.map(i => i.nodeType))
    expect(sectioned).toEqual(['UpscaleImageNode'])
  })

  it('hero nodeTypes absent from items are skipped without error', () => {
    const { hero } = groupByIntent([fake('GenerateImageNode')], ['MissingNode', 'GenerateImageNode'])
    expect(hero.map(i => i.nodeType)).toEqual(['GenerateImageNode'])
  })

  it('sorts section items by display title (useCase when mapped, label otherwise)', () => {
    const items = [
      fake('SketchToImageNode'),   // "Sketch to image"
      fake('GenerateImageNode'),   // "Generate an image"
    ]
    const { sections } = groupByIntent(items, [])
    expect(sections[0]!.items.map(i => i.nodeType))
      .toEqual(['GenerateImageNode', 'SketchToImageNode'])
  })
})
