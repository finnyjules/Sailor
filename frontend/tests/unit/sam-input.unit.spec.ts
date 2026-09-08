import { describe, it, expect } from 'vitest'
import { buildSamInput } from '~~/server/utils/samInput'

/**
 * SAM 3 (fal-ai/sam-3/image) is genuinely promptable: point_prompts steer the
 * model, so the mask that comes back already reflects the clicked object — no
 * client-side segment-picking. buildSamInput maps our request body to that
 * schema. Verified live: prompt:'' (empty) is required so the model uses the
 * points instead of its default text prompt ("wheel"); apply_mask:false returns
 * the raw white-on-black binary mask; sync_mode:true returns data URIs.
 */
describe('buildSamInput (SAM 3)', () => {
  const FIXED = {
    prompt: '',
    apply_mask: false,
    sync_mode: true,
    output_format: 'png',
    return_multiple_masks: false,
    max_masks: 1,
  }

  it('legacy single point body → one foreground point prompt (back-compat)', () => {
    expect(buildSamInput({ image: 'data:x', xPx: 10.6, yPx: 20.2 })).toEqual({
      image_url: 'data:x',
      point_prompts: [{ x: 11, y: 20, label: 1 }],
      ...FIXED,
    })
  })

  it('points array wins over xPx/yPx and preserves labels', () => {
    expect(buildSamInput({
      image: 'data:x', xPx: 1, yPx: 2,
      points: [{ x: 5.4, y: 6.6, label: 1 }, { x: 9, y: 10, label: 0 }],
    })).toEqual({
      image_url: 'data:x',
      point_prompts: [{ x: 5, y: 7, label: 1 }, { x: 9, y: 10, label: 0 }],
      ...FIXED,
    })
  })

  it('empty points array falls back to the legacy point', () => {
    expect(buildSamInput({ image: 'data:x', xPx: 3, yPx: 4, points: [] })).toEqual({
      image_url: 'data:x',
      point_prompts: [{ x: 3, y: 4, label: 1 }],
      ...FIXED,
    })
  })

  it('a box body emits a box_prompt (integer corners)', () => {
    const out = buildSamInput({ image: 'data:x', box: { xMin: 4.6, yMin: 8.2, xMax: 40.4, yMax: 80.9 } })
    expect(out.box_prompts).toEqual([{ x_min: 5, y_min: 8, x_max: 40, y_max: 81 }])
  })

  it('no box → box_prompts is omitted (never emits undefined)', () => {
    const out = buildSamInput({ image: 'data:x', xPx: 1, yPx: 1 })
    expect('box_prompts' in out).toBe(false)
    for (const v of Object.values(out)) expect(v).not.toBeUndefined()
  })
})
