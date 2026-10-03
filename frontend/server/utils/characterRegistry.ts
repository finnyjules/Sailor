/**
 * Pure helpers for the character registry (library/characters/<slug>.json).
 * Reference images live in the ComfyUI INPUT dir and records store filenames —
 * a cast ref is exactly `/view?filename=<name>&type=input`, which the Shot
 * Director ref chain already resolves. Pure (fs-free) so it unit-tests like
 * loraPrompt.ts; the endpoints own the IO.
 *
 * On-disk records span three eras — parse-time migration only, the JSON files
 * themselves are never rewritten by this module:
 *   era 1: top-level `refImages`/`coverIndex` (oldest)
 *   era 2: `variants: [{id,label,descriptor,refImages,coverIndex}]` (current disk format)
 *   era 3: `states: CharacterState[]` (new; what writes produce from now on)
 */
import type {
  BodySliderId, Check, CharacterPanel, CharacterRecord, CharacterState, FaceBox, FaceRef, Garment, MadeFrom, Photo, StressResult, VoiceRef,
} from '#shared/characters/types'
import { BODY_SLIDERS, coverFirstRefs, emptyState } from '#shared/characters/types'

export type { CharacterRecord, CharacterState }
export { defaultState } from '#shared/characters/types'

const PANEL_SLOTS = new Set(['body-front', 'body-back', 'portrait', 'face-neutral', 'face-smile'])
const STATUSES = new Set(['draft', 'testing', 'locked'])

export function slugifyCharacterName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function validRefFilename(name: string): boolean {
  return typeof name === 'string' && name.length > 0
    && !name.includes('/') && !name.includes('\\') && !name.includes('..')
}

/**
 * Hygiene-parse a raw bodyShape value: non-object (incl. array/null/undefined)
 * → null; otherwise keep only known BODY_SLIDERS keys with finite numeric
 * values, clamped to [0,1]. Unknown keys are dropped by construction (only
 * known keys are ever read). Shared by parseCharacterRecord and the PATCH
 * endpoint so hygiene lives in one place.
 */
export function sanitizeBodyShape(v: unknown): Partial<Record<BodySliderId, number>> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const src = v as Record<string, unknown>
  const out: Partial<Record<BodySliderId, number>> = {}
  for (const key of BODY_SLIDERS) {
    const val = src[key]
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = Math.min(1, Math.max(0, val))
    }
  }
  return out
}

const VERDICTS = new Set(['match', 'unsure', 'different', 'no-face'])
const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

export function checkHygiene(v: unknown): Check | null {
  const o = obj(v)
  if (!o || !VERDICTS.has(o.verdict as string) || !validRefFilename(o.against as string)) return null
  const out: Check = { verdict: o.verdict as Check['verdict'], against: o.against as string, at: typeof o.at === 'string' ? o.at : '' }
  if (typeof o.score === 'number' && Number.isFinite(o.score)) out.score = Math.min(100, Math.max(0, o.score))
  if (o.lookFit === 'ok' || o.lookFit === 'off') out.lookFit = o.lookFit
  if (typeof o.note === 'string' && o.note) out.note = o.note
  return out
}

export function faceRefHygiene(v: unknown): FaceRef | null {
  const o = obj(v)
  if (!o || !validRefFilename(o.filename as string)) return null
  return { filename: o.filename as string, approvedAt: typeof o.approvedAt === 'string' ? o.approvedAt : '' }
}

function faceBoxHygiene(v: unknown): FaceBox | undefined {
  const o = obj(v)
  if (!o) return undefined
  return { x: clamp01(o.x), y: clamp01(o.y), w: clamp01(o.w), h: clamp01(o.h) }
}

export function photoHygiene(v: unknown): Photo | null {
  const o = obj(v)
  if (!o || !validRefFilename(o.filename as string)) return null
  const p: Photo = { filename: o.filename as string, check: checkHygiene(o.check) }
  const crop = faceBoxHygiene(o.crop)
  if (crop) p.crop = crop
  return p
}

export function garmentHygiene(v: unknown): Garment | null {
  const o = obj(v)
  if (!o || typeof o.id !== 'string' || !o.id || !validRefFilename(o.filename as string)) return null
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  return name ? { id: o.id, filename: o.filename as string, name } : null
}

export function voiceHygiene(v: unknown): VoiceRef | null {
  const o = obj(v)
  if (!o || (o.kind !== 'stock' && o.kind !== 'trained') || typeof o.id !== 'string' || !o.id) return null
  return { kind: o.kind, id: o.id, label: typeof o.label === 'string' ? o.label : o.id }
}

function madeFromHygiene(v: unknown): MadeFrom | null {
  const o = obj(v)
  if (!o || typeof o.face !== 'string' || typeof o.model !== 'string') return null
  return { face: o.face, clothesKey: typeof o.clothesKey === 'string' ? o.clothesKey : '', bodyKey: typeof o.bodyKey === 'string' ? o.bodyKey : '', model: o.model }
}

/** Hygiene-parse a single raw state/variant object into a well-formed CharacterState. */
export function stateHygiene(v: Record<string, unknown>): CharacterState | null {
  if (typeof v.id !== 'string' || !v.id || typeof v.label !== 'string' || !v.label) return null
  const refImages = (Array.isArray(v.refImages) ? v.refImages : [])
    .filter((f): f is string => validRefFilename(f as string))
  const cover = typeof v.coverIndex === 'number' ? v.coverIndex : 0
  const panels = (Array.isArray(v.panels) ? v.panels : [])
    .filter((p): p is CharacterPanel =>
      !!p && typeof p === 'object'
      && PANEL_SLOTS.has((p as CharacterPanel).slot)
      && validRefFilename((p as CharacterPanel).filename))
    .map((p) => {
      const out: CharacterPanel = { slot: p.slot, filename: p.filename }
      const check = checkHygiene(p.check)
      const madeFrom = madeFromHygiene(p.madeFrom)
      if (check) out.check = check
      if (madeFrom) out.madeFrom = madeFrom
      return out
    })
  const sheetImage = typeof v.sheetImage === 'string' && validRefFilename(v.sheetImage) ? v.sheetImage : null
  const sr = v.stressResult as StressResult | null | undefined
  return {
    id: v.id, label: v.label,
    descriptor: typeof v.descriptor === 'string' ? v.descriptor : '',
    refImages,
    coverIndex: Math.min(Math.max(0, cover), Math.max(0, refImages.length - 1)),
    panels,
    sheetImage,
    clothes: (Array.isArray(v.clothes) ? v.clothes : []).map(garmentHygiene).filter((g): g is Garment => !!g),
    face: faceRefHygiene(v.face),
    status: STATUSES.has(v.status as string) ? v.status as CharacterState['status'] : 'draft',
    stressResult: sr && typeof sr === 'object' && typeof sr.passes === 'number' && typeof sr.total === 'number'
      ? { passes: sr.passes, total: sr.total, at: typeof sr.at === 'string' ? sr.at : '' } : null,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
  }
}

export function parseCharacterRecord(raw: string, slug: string): CharacterRecord | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const r = obj as Record<string, unknown>

  let states = (Array.isArray(r.states) ? r.states : [])
    .map(v => stateHygiene(v as Record<string, unknown>))
    .filter((v): v is CharacterState => !!v)

  if (!states.length && Array.isArray(r.variants)) {
    // era 2: variants lack panels/status/etc — stateHygiene fills the defaults.
    states = (r.variants as unknown[])
      .map(v => stateHygiene(v as Record<string, unknown>))
      .filter((v): v is CharacterState => !!v)
  }

  if (!states.length && Array.isArray(r.refImages)) {
    // era 1: legacy single-sheet record → Default state (migration is
    // parse-time; the next write persists the new shape).
    const legacy = stateHygiene({ id: 'default', label: 'Default', descriptor: '', refImages: r.refImages, coverIndex: r.coverIndex ?? 0 })
    if (legacy) states = [legacy]
  }

  if (!states.some(v => v.id === 'default')) {
    states.unshift(emptyState('default', 'Default'))
  } else {
    states = [...states.filter(v => v.id === 'default'), ...states.filter(v => v.id !== 'default')]
  }

  // Merge, not "stored else derived": the old workbench still writes
  // per-look refImages until stage 5, so a look can grow new refs after
  // `photos` was already stored (at creation, by the heal-write, or by a
  // states-replace PATCH) — those new refs must still surface as photos.
  const storedPhotos = Array.isArray(r.photos)
    ? (r.photos as unknown[]).map(photoHygiene).filter((p): p is Photo => !!p)
    : []
  const photos: Photo[] = (() => {
    const seen = new Set<string>()
    const out: Photo[] = []
    for (const p of storedPhotos) {
      if (!seen.has(p.filename)) { seen.add(p.filename); out.push(p) }
    }
    for (const s of states) for (const f of s.refImages) {
      if (!seen.has(f)) { seen.add(f); out.push({ filename: f, check: null }) }
    }
    return out
  })()
  const defaultCover = coverFirstRefs(states[0])[0]
  const face = faceRefHygiene(r.face) ?? (defaultCover ? { filename: defaultCover, approvedAt: '' } : null)
  const ORIGINS = new Set(['described', 'photos', 'canvas'])

  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : slug,
    slug,
    face,
    photos,
    voice: voiceHygiene(r.voice),
    origin: ORIGINS.has(r.origin as string) ? r.origin as CharacterRecord['origin'] : 'photos',
    likenessConfirmed: r.likenessConfirmed === true,
    style: r.style === 'anime' ? 'anime' : 'photo',
    linkedFrom: typeof r.linkedFrom === 'string' && r.linkedFrom && slugifyCharacterName(r.linkedFrom) === r.linkedFrom ? r.linkedFrom : null,
    states,
    loraName: typeof r.loraName === 'string' && r.loraName ? r.loraName : null,
    trigger: typeof r.trigger === 'string' && r.trigger ? r.trigger : null,
    bodyShape: sanitizeBodyShape(r.bodyShape),
    notes: typeof r.notes === 'string' ? r.notes : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  }
}

/**
 * Self-healing pass over a record's states: drop refs and panels whose
 * input-dir file vanished, and null out a vanished sheetImage. A locked (or
 * testing) state whose sheet vanished had its identity promise broken — it
 * demotes back to draft and its stress result is cleared.
 */
export function healRefImages(
  record: CharacterRecord,
  exists: (filename: string) => boolean,
): { record: CharacterRecord, dropped: number } {
  let totalDropped = 0
  const healed = record.states.map((v) => {
    const keptRefs = v.refImages.filter(exists)
    totalDropped += v.refImages.length - keptRefs.length

    const keptPanels = v.panels.filter(p => exists(p.filename))
    totalDropped += v.panels.length - keptPanels.length

    const sheetVanished = v.sheetImage !== null && !exists(v.sheetImage)
    if (sheetVanished) totalDropped += 1
    const sheetImage = sheetVanished ? null : v.sheetImage

    const demoted = sheetVanished && v.status !== 'draft'

    const keptClothes = v.clothes.filter(g => exists(g.filename))
    totalDropped += v.clothes.length - keptClothes.length
    const lookFaceVanished = v.face !== null && !exists(v.face.filename)
    if (lookFaceVanished) totalDropped += 1

    return {
      ...v,
      refImages: keptRefs,
      coverIndex: Math.min(v.coverIndex, Math.max(0, keptRefs.length - 1)),
      panels: keptPanels,
      sheetImage,
      status: demoted ? 'draft' as const : v.status,
      stressResult: demoted ? null : v.stressResult,
      clothes: keptClothes,
      face: lookFaceVanished ? null : v.face,
    }
  })
  const keptPhotos = record.photos.filter(p => exists(p.filename))
  totalDropped += record.photos.length - keptPhotos.length
  const faceVanished = record.face !== null && !exists(record.face.filename)
  if (faceVanished) totalDropped += 1

  if (!totalDropped) return { record, dropped: 0 }
  return {
    record: { ...record, states: healed, photos: keptPhotos, face: faceVanished ? null : record.face },
    dropped: totalDropped,
  }
}
