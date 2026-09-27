/**
 * AWS Rekognition CompareFaces for the character face checker (spec: Checks).
 * Stateless — nothing is stored at AWS. $0.001 per call. The client is
 * injectable so tests never touch the network.
 */
import sharp from 'sharp'
import { CompareFacesCommand, RekognitionClient, type CompareFacesCommandOutput } from '@aws-sdk/client-rekognition'

export class FaceCheckError extends Error {
  constructor(public code: 'no-source-face' | 'aws', message: string) { super(message) }
}

export interface CompareClient { send(cmd: CompareFacesCommand): Promise<CompareFacesCommandOutput> }

export function rekognitionClient(cfg: { region: string; accessKeyId?: string; secretAccessKey?: string }): CompareClient {
  const credentials = cfg.accessKeyId && cfg.secretAccessKey
    ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    : undefined
  return new RekognitionClient({ region: cfg.region, credentials })
}

const MAX_SIDE = 1600
const PAD_FRACTION = 0.4

export async function prepareForCompare(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true })
  const pad = Math.round(Math.max(info.width, info.height) * PAD_FRACTION)
  return sharp(data)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 128, g: 128, b: 128 } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

/** Best similarity (0–100) of any face in `target` to the face in `source`; null when the target has no face. Throws FaceCheckError('no-source-face') when the source has none. */
export async function compareFaces(client: CompareClient, source: Buffer, target: Buffer): Promise<number | null> {
  let out: CompareFacesCommandOutput
  try {
    out = await client.send(new CompareFacesCommand({
      SourceImage: { Bytes: source },
      TargetImage: { Bytes: target },
      SimilarityThreshold: 0,
    }))
  } catch (e: any) {
    if (e?.name === 'InvalidParameterException') throw new FaceCheckError('no-source-face', 'No face found in the approved face picture.')
    throw new FaceCheckError('aws', `Face check failed: ${e?.message ?? 'unknown error'}`)
  }
  const matches = out.FaceMatches ?? []
  const unmatched = out.UnmatchedFaces ?? []
  if (!matches.length && !unmatched.length) return null
  return matches.reduce((best, m) => Math.max(best, m.Similarity ?? 0), 0)
}
