import { describe, it, expect } from 'vitest'
import { SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '../../app/lib/spacetype/sections'

// The Type Studio panel (SpaceTypeSurface) renders control sections by filtering each effect's
// controls against SPACE_TYPE_SECTIONS. A control whose `group` isn't listed is SILENTLY hidden.
// This guards that every registered effect only uses renderable groups, so the bug that hid the
// Contour/Tunnel 'Layers' section can't recur.
describe('every effect control group is renderable by SpaceTypeSurface', () => {
  const allowed = new Set<string>(SPACE_TYPE_SECTIONS)

  it('SPACE_TYPE_SECTIONS has no duplicates', () => {
    expect(allowed.size).toBe(SPACE_TYPE_SECTIONS.length)
  })

  it('includes the Slice section (used by the shutter effect)', () => {
    expect(allowed.has('Slice')).toBe(true)
  })

  for (const effect of SPACE_TYPE_EFFECTS) {
    it(`${effect.id}: all control groups are in SPACE_TYPE_SECTIONS`, () => {
      for (const c of effect.controls) {
        // The surface maps a missing group to 'Other' (`c.group ?? 'Other'`), which is NOT a
        // section — so an ungrouped control is hidden too, and must fail this guard.
        const group = c.group ?? 'Other'
        expect(
          allowed.has(group),
          `effect "${effect.id}" control "${c.key}" uses group "${group}", which is not in SPACE_TYPE_SECTIONS — its whole section would be hidden in the panel`,
        ).toBe(true)
      }
    })
  }
})

it('every control on every effect declares a non-empty group', () => {
  for (const e of SPACE_TYPE_EFFECTS) {
    for (const c of e.controls) {
      expect(c.group, `${e.id}.${c.key}`).toBeTruthy()
    }
  }
})

// The backend validates effect ids with `[a-z0-9]+` (comfy_extras/nodes_timeline.py:_valid_effect_id)
// before using them to name scene_defaults/<id>.json and thumbnail <id>.png. A mixed-case id (e.g.
// 'cornerPin') 400s the "Make as default" + "Capture thumbnail" saves. Keep ids lowercase/digits.
it('every effect id is backend-valid (lowercase letters + digits only)', () => {
  for (const e of SPACE_TYPE_EFFECTS) {
    expect(
      /^[a-z0-9]+$/.test(e.id),
      `effect id "${e.id}" must match /^[a-z0-9]+$/ — the backend rejects other ids, breaking thumbnail/default saves`,
    ).toBe(true)
  }
})

it('effect ids are unique', () => {
  const ids = SPACE_TYPE_EFFECTS.map(e => e.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// SpaceTypeSurface's multi-text editor is a SINGLETON bound to params.text (textLines ↔
// params.text, SpaceTypeSurface.vue:215-228,1909): a `textList` control is NOT rendered per its
// own key. So an effect may declare AT MOST ONE textList control, and it MUST be keyed 'text' —
// otherwise its edits land in params.text and never reach the effect (which reads its own key),
// and a second textList silently shares the same editor. The `text` kind (single-line) binds
// per-key (params[c.key]) and has no such limit — use it for any additional text input.
it('each effect has ≤1 textList control, keyed "text" (surface binds textLines↔params.text)', () => {
  for (const e of SPACE_TYPE_EFFECTS) {
    const textLists = e.controls.filter(c => c.kind === 'textList')
    expect(
      textLists.length,
      `effect "${e.id}" declares ${textLists.length} textList controls (${textLists.map(c => c.key).join(', ')}); the surface's textList editor is a singleton — use kind 'text' for extra inputs`,
    ).toBeLessThanOrEqual(1)
    for (const c of textLists) {
      expect(
        c.key,
        `effect "${e.id}" textList control is keyed "${c.key}", but the surface binds the editor to params.text — a non-'text' key means typed edits never reach the effect`,
      ).toBe('text')
    }
  }
})

// The array IS the panel's display order (framing → content → shape → finish → motion → export).
// 'Camera' is surface-injected (no effect declares it); 'Motion' renders on the Motion tab.
it('panel order: framing → content → shape → finish → motion → output', () => {
  expect([...SPACE_TYPE_SECTIONS]).toEqual([
    'Camera', 'Transform',
    'Content', 'Cards', 'Type', 'Color', 'Stroke',   // Content + Cards: Showcase's card list and card look
    'Path', 'Layout', 'Stack', 'Stretch', 'Skew', 'Warp', 'Ribbon', 'Spiral', 'Slice', 'Wave', 'Glitch', 'Doodles',
    'Layers', 'Occlusion', 'Look', 'Style', 'Blend', 'Shadow',
    'Motion',
    'Output',
  ])
})
