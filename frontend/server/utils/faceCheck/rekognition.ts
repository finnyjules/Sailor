/**
 * AWS Rekognition CompareFaces for the character face checker (spec: Checks).
 * Stateless — nothing is stored at AWS. $0.001 per call. The client is
 * injectable so tests never touch the network.
 */
import sharp from 'sharp'
import {
  CompareFacesCommand, DetectFacesCommand, RekognitionClient,
  type CompareFacesCommandOutput, type DetectFacesCommandOutput,
} from '@aws-sdk/client-rekognition'

/**
 * 'no-face-either': AWS refused the pair because the source OR the target has
 * no detectable face — it doesn't say which (Ruling K). The caller asks
 * `hasFace` about the source to tell the two apart. 'no-source-face' is kept
 * for callers that already know it's the source.
 */
export class FaceCheckError extends Error {
  constructor(public code: 'no-face-either' | 'no-source-face' | 'aws', message: string) { super(message) }
}

export interface CompareClient {
  send(cmd: CompareFacesCommand): Promise<CompareFacesCommandOutput>
  send(cmd: DetectFacesCommand): Promise<DetectFacesCommandOutput>
}

export function rekognitionClient(cfg: { region: string; accessKeyId?: string; secretAccessKey?: string }): CompareClient {
  const credentials = cfg.accessKeyId && cfg.secretAccessKey
    ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    : undefined
  return new RekognitionClient({ region: cfg.region, credentials })
}

const MAX_SIDE = 1600
const PAD_FRACTION = 0.4

/** Resize to fit MAX_SIDE and encode JPEG. `pad` (default) adds a grey border so AWS finds faces that touch the edge; the anime vision checker doesn't need it. */
export async function prepareForCompare(input: Buffer, { pad: withPad = true }: { pad?: boolean } = {}): Promise<Buffer> {
  const resized = sharp(input).rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
  if (!withPad) return resized.jpeg({ quality: 88 }).toBuffer()
  const { data, info } = await resized.toBuffer({ resolveWithObject: true })
  const pad = Math.round(Math.max(info.width, info.height) * PAD_FRACTION)
  return sharp(data)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 128, g: 128, b: 128 } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

/**
 * Best similarity (0–100) of any face in `target` to the face in `source`;
 * null when AWS reports the target faceless. Throws FaceCheckError('no-face-either')
 * when AWS refuses the pair (InvalidParameterException: source or target has no face).
 */
export async function compareFaces(client: CompareClient, source: Buffer, target: Buffer): Promise<number | null> {
  let out: CompareFacesCommandOutput
  try {
    out = await client.send(new CompareFacesCommand({
      SourceImage: { Bytes: source },
      TargetImage: { Bytes: target },
      SimilarityThreshold: 0,
    }))
  } catch (e: any) {
    if (e?.name === 'InvalidParameterException') throw new FaceCheckError('no-face-either', 'No face found in one of the two pictures.')
    throw new FaceCheckError('aws', `Face check failed: ${e?.message ?? 'unknown error'}`)
  }
  const matches = out.FaceMatches ?? []
  const unmatched = out.UnmatchedFaces ?? []
  if (!matches.length && !unmatched.length) return null
  return matches.reduce((best, m) => Math.max(best, m.Similarity ?? 0), 0)
}

/** Whether AWS finds any face in `image` (DetectFaces, $0.001). Used once per face per pass to disambiguate 'no-face-either'. */
export async function hasFace(client: CompareClient, image: Buffer): Promise<boolean> {
  const out = await client.send(new DetectFacesCommand({ Image: { Bytes: image } }))
  return (out.FaceDetails?.length ?? 0) > 0
}
