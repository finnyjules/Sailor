/**
 * Fix faces (FixFacesNode) on Topaz image upscale with face enhancement, fal
 * (family `fix-faces`), no backup. Replaces CodeFormer (S-Lab licence,
 * non-commercial; spec 2026-09-26-non-commercial-face-models-replacement).
 *
 * Written from the saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__topaz__upscale__image.json):
 *   image_url                    the node's picture (the hand-off link)
 *   model                        "Standard V2": face enhancement applies to
 *                                Standard V2 and Recovery V2 only; sent so a
 *                                new default can't change the result
 *   upscale_factor               the node's Upscale, 1–4
 *   face_enhancement             true
 *   face_enhancement_strength    the node's Strength, 0–1
 *   face_enhancement_creativity  the node's Creativity, 0–1 (0 keeps the face the person's)
 *   output_format                "png" (the schema's default is jpeg)
 * Not sent: every Redefine / Recovery knob, subject_detection, crop_to_fill.
 */
import { TOPAZ_IMAGE_APP, fixFacesSettings } from '#shared/pricing/editSettings'
import type { ServiceCall } from './twins'

export { TOPAZ_IMAGE_APP }

export function topazFixFaces(o: { image: string, inputs: Record<string, unknown> }): ServiceCall {
  const s = fixFacesSettings(o.inputs)
  return {
    provider: 'fal',
    endpoint: TOPAZ_IMAGE_APP,
    payload: {
      image_url: o.image,
      model: 'Standard V2',
      upscale_factor: s.upscale,
      face_enhancement: true,
      face_enhancement_strength: s.strength,
      face_enhancement_creativity: s.creativity,
      output_format: 'png',
    },
  }
}
