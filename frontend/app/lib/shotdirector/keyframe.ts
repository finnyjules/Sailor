// frontend/app/lib/shotdirector/keyframe.ts
// Builds the prompt for a still "keyframe" preview — a photoreal frame that
// approximates what Seedance will produce, generated from the SAME references
// (cast cover + location plate) and the same shot intent. Deliberately a STILL
// instruction: camera move and pacing are dropped (a frame can't show motion,
// and motion words confuse the image model). Pure and deterministic.
import { SHOT_TYPE_PHRASE, type ShotSheet } from './types'
import type { IdentityRefSet } from '#shared/characters/types'

/** Estimated cost of one keyframe preview (nano-banana-pro). Confirm vs billing. */
export const KEYFRAME_COST_USD = 0.05

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

export interface KeyframeRefs {
  /** a person/cast reference image is provided (first in the image list). */
  hasPerson: boolean
  /** a location plate is provided (after the person, if any). */
  hasLocation: boolean
  /** Names each cast member's image numbers (from `startFrameImages`). When
   *  given it replaces the first/second-image sentence, whose numbering no
   *  longer holds once the cast's pictures lead the list. */
  castLine?: string
}

/** Most cast members, and clothes photos per member, a made first frame uses. */
const START_FRAME_CAST_MAX = 3
const START_FRAME_CLOTHES_MAX = 2

export interface StartFrameCastMember {
  name: string
  set: IdentityRefSet
  /** The picked look's clothes photos, as URLs. */
  clothes: string[]
}

function imageSpan(from: number, to: number): string {
  return from === to ? `image ${from}` : `images ${from}–${to}`
}

/**
 * The images a first frame is made from, in order: per cast member (at most
 * 3) the front, the full-body front if any, then up to 2 clothes photos; the
 * location last. `castLine` says which numbers are whom, e.g.
 * "Reva is the person in images 1–2, wearing the clothes in image 3." Never
 * the combined sheet grid. A member with no pictures is left out.
 */
export function startFrameImages(
  cast: StartFrameCastMember[],
  location: string | null,
): { urls: string[]; castLine: string } {
  const urls: string[] = []
  const sentences: string[] = []
  for (const m of cast.slice(0, START_FRAME_CAST_MAX)) {
    const person = [m.set.front, m.set.bodyFront].filter((u): u is string => !!u)
    if (!person.length) continue
    const clothes = m.clothes.filter(Boolean).slice(0, START_FRAME_CLOTHES_MAX)
    const personFrom = urls.length + 1
    urls.push(...person)
    let sentence = `${m.name} is the person in ${imageSpan(personFrom, urls.length)}`
    if (clothes.length) {
      const clothesFrom = urls.length + 1
      urls.push(...clothes)
      sentence += `, wearing the clothes in ${imageSpan(clothesFrom, urls.length)}`
    }
    sentences.push(`${sentence}.`)
  }
  if (location) {
    urls.push(location)
    sentences.push(`The location is in image ${urls.length}.`)
  }
  return { urls, castLine: sentences.join(' ') }
}

export function buildKeyframePrompt(sheet: ShotSheet, refs: KeyframeRefs): string {
  const parts: string[] = ['Photorealistic cinematic film still.']

  // Composition sentence matches the image order the caller sends.
  if (refs.castLine) {
    parts.push(refs.castLine)
  } else if (refs.hasPerson && refs.hasLocation) {
    parts.push('Place the person from the first image into the location in the second image.')
  } else if (refs.hasPerson) {
    parts.push('Feature the person from the first image.')
  } else if (refs.hasLocation) {
    parts.push('Set in the location from the first image.')
  }

  const who = [sheet.subject.trim(), sheet.action.trim().replace(/\.$/, '')].filter(Boolean).join(' ')
  if (who) parts.push(`${capitalize(who)}.`)

  const env = sheet.environment.trim()
  if (env) parts.push(`In ${env}.`)

  // Framing only — NO camera move / pacing.
  parts.push(`${SHOT_TYPE_PHRASE[sheet.camera.shotType]}.`)

  const look = [sheet.lighting.trim(), sheet.style.trim()].filter(Boolean)
  if (look.length) parts.push(`${look.join('; ')}.`)

  return parts.join(' ')
}
