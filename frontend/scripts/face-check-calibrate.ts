/**
 * One-off calibration for the character face checker (plan Task 10). Compares
 * known same-person and different-person pairs from the real input dir and
 * prints AWS similarity scores. Costs one CompareFaces call per pair
 * ($0.001 each). Reads NUXT_AWS_* from the environment. Never writes records.
 * Pass a start index to rerun only later pairs.
 * Run: cd frontend && node --env-file=.env --experimental-transform-types scripts/face-check-calibrate.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compareFaces, FaceCheckError, prepareForCompare, rekognitionClient } from '../server/utils/faceCheck/rekognition.ts'

const INPUT = path.resolve(process.cwd(), '..', 'input')
const JENE_FACE = 'sd-ref_1783013794598_sheet_1783013794582_0.png'
const REVA = ['sd-ref_1783013897018_sheet_1783013897004_0.png', 'sd-ref_1783013897049_sheet_1783013897042_1.png', 'sd-ref_1783013897084_sheet_1783013897076_2.png']
const MILLIE = 'sd-ref_1783013856985_sheet_1783013856971_0.png'
const VERA = 'sd-ref_1782976065077_source.png'
// 'look' = Jene's own face with other hair and makeup. First labelled 'different'
// from an ArcFace read; AWS scored them 94–100 and by eye they are her face.
const PAIRS: [label: string, expect: 'same' | 'look' | 'different', a: string, b: string][] = [
  ['Reva photo 1 vs 2', 'same', REVA[0]!, REVA[1]!],
  ['Reva photo 1 vs 3', 'same', REVA[0]!, REVA[2]!],
  ['Jene cover vs her portrait panel', 'same', JENE_FACE, 'sd-ref_1786681429486_sheet_portrait.png'],
  ['Jene cover vs blonde face panel', 'look', JENE_FACE, 'sd-ref_1786656610085_sheet_face-neutral.png'],
  ['Jene cover vs blonde smile panel', 'look', JENE_FACE, 'sd-ref_1786656610109_sheet_face-smile.png'],
  ['Jene cover vs blonde photo 2', 'look', JENE_FACE, 'sd-ref_1783013795096_sheet_1783013795083_1.png'],
  ['Jene cover vs dark profile photo 3', 'look', JENE_FACE, 'sd-ref_1783013796416_sheet_1783013796406_2.png'],
  ['Jene cover vs Reva', 'different', JENE_FACE, REVA[0]!],
  ['Jene cover vs Millie', 'different', JENE_FACE, MILLIE],
  ['Jene cover vs Vera', 'different', JENE_FACE, VERA],
  ['Jene blonde face panel vs Millie', 'different', 'sd-ref_1786656610085_sheet_face-neutral.png', MILLIE],
  ['Reva vs Millie', 'different', REVA[0]!, MILLIE],
  ['Reva vs Vera', 'different', REVA[0]!, VERA],
  ['Millie vs Vera', 'different', MILLIE, VERA],
]
const ONLY = process.argv[2] ? Number(process.argv[2]) : 0

const client = rekognitionClient({
  region: process.env.NUXT_AWS_REGION || 'us-east-1',
  accessKeyId: process.env.NUXT_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.NUXT_AWS_SECRET_ACCESS_KEY,
})
const load = async (f: string) => prepareForCompare(await fs.readFile(path.join(INPUT, f)))
for (const [label, expect, a, b] of PAIRS.slice(ONLY)) {
  let shown: string
  try {
    const score = await compareFaces(client, await load(a), await load(b))
    shown = score === null ? 'no face' : score.toFixed(1)
  } catch (err) {
    if (!(err instanceof FaceCheckError) || err.code === 'aws') throw err
    shown = err.code
  }
  console.log(`${expect.padEnd(9)} ${shown.padStart(7)}  ${label}`)
}
