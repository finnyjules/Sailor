/**
 * Film a shot's preset path (step 3, R3.11): the 28 shot presets, the
 * override option lists and the phrase compiler of
 * comfy_api_nodes/shot_presets.py, ported so the runner writes the same
 * prompt FilmShotNode.execute writes (and the canvas can preview it later).
 * Pure: no imports but the Python strip.
 *
 * Checked against the real Python by tests/unit/runner-paid-film-shot.unit.spec.ts
 * (fixtures/runner-paid-film-shot.json, scripts/runner_paid_fixtures.py --group film-shot).
 */
import { pyStrip } from './pyText'

/** shot_presets.py AUTO: an override that keeps the preset's own value. */
export const SHOT_AUTO = 'auto (preset)'

/** shot_presets.py DEFAULT_PRESET_ID: the recipe an unknown preset falls back to. */
export const SHOT_DEFAULT_PRESET_ID = 'push-in'

export interface ShotRecipe {
  id: string
  label: string
  category: 'movement' | 'angle' | 'lens' | 'composition'
  size: string
  angle: string
  movement: string
  lens: string
  composition: string
  note: string
}

const p = (
  id: string, label: string, category: ShotRecipe['category'],
  size: string, angle: string, movement: string, lens: string, composition: string, note: string,
): ShotRecipe => ({ id, label, category, size, angle, movement, lens, composition, note })

/** shot_presets.py PRESETS, in its order. */
export const SHOT_PRESETS: readonly ShotRecipe[] = [
  // ----- Movement-led -----
  p('push-in', 'Slow push-in', 'movement',
    'medium close-up', 'eye level',
    'the camera slowly dollies in toward the subject',
    '50mm lens with shallow depth of field',
    'subject centered in frame', 'builds quiet tension'),
  p('pull-back', 'Pull-back reveal', 'movement',
    'close-up widening to a wide shot', 'eye level',
    'the camera steadily dollies out, revealing the surroundings',
    '35mm lens with deepening focus',
    'subject anchored in place as the world grows around them',
    'the context lands at the end'),
  p('crane-reveal', 'Crane reveal', 'movement',
    'wide shot', 'a low position rising high',
    'the camera cranes up smoothly',
    '24mm lens with deep focus',
    'landscape framing with a strong horizon', 'establishing grandeur'),
  p('orbit', 'Hero orbit', 'movement',
    'medium shot', 'eye level',
    'the camera arcs in a slow 180-degree orbit around the subject',
    '35mm lens with shallow depth of field',
    'subject locked at frame center', 'the hero moment'),
  p('tracking', 'Lateral tracking', 'movement',
    'medium shot in profile', 'eye level',
    'the camera tracks laterally alongside the moving subject, matched to their pace',
    '40mm lens with deep focus',
    'leading room ahead of the subject', 'walk-and-talk energy'),
  p('handheld', 'Handheld urgency', 'movement',
    'medium close-up', 'eye level',
    'shaky handheld camera following the subject',
    '28mm lens',
    'loose, imperfect framing', 'documentary urgency'),
  p('dolly-zoom', 'Dolly zoom (Vertigo)', 'movement',
    'medium close-up', 'eye level',
    'the camera dollies in while the lens zooms out',
    '50mm lens, the background perspective visibly warping',
    'subject locked dead center', 'reality bends around them'),
  p('tilt-reveal', 'Tilt-up reveal', 'movement',
    'full shot', 'a low angle',
    'the camera tilts up slowly from the ground to the face',
    '35mm lens',
    'vertical reveal framing', 'sizing them up'),
  p('whip-pan', 'Whip pan', 'movement',
    'medium shot', 'eye level',
    'the camera whips violently sideways in a fast pan, streaking with motion blur',
    '35mm lens',
    'framing snaps from one point to the next', 'an energy spike'),
  p('crash-zoom', 'Crash zoom', 'movement',
    'wide shot punching in to a close-up', 'eye level',
    'an abrupt crash zoom punches toward the subject',
    'zoom lens',
    'subject suddenly fills the frame', 'a grindhouse exclamation mark'),
  p('snorricam', 'Snorricam', 'movement',
    'close-up', 'a body-rigged mount, facing the actor',
    'a snorricam locked to the actor\'s body, the world lurching and swimming behind them',
    '28mm lens',
    'face pinned center while the background reels', 'panic and unraveling'),
  p('steadicam-oner', 'Steadicam oner', 'movement',
    'medium shot following the subject', 'eye level',
    'a flowing steadicam glide that follows unbroken through doorways and spaces',
    '32mm lens with deep focus',
    'continuously reframing around the moving subject', 'the long-take feel'),
  p('fpv-dive', 'FPV drone dive', 'movement',
    'wide shot tightening rapidly', 'a plunging aerial angle',
    'an FPV drone dives aggressively and weaves toward the subject',
    'ultra-wide lens',
    'horizon rolling with the dive', 'pure adrenaline'),
  p('aerial-orbit', 'Aerial establish orbit', 'movement',
    'extreme wide shot', 'a high aerial angle',
    'a drone circles the location in a slow orbit',
    '24mm lens with deep focus',
    'the landscape framed like a map coming alive', 'the opening-credits shot'),
  p('ground-rush', 'Ground-rush tracking', 'movement',
    'low medium shot', 'inches off the ground',
    'the camera skims fast and low across the surface toward the subject',
    '24mm lens',
    'ground rushing through the lower frame', 'road-blur menace'),
  // ----- Angle-led -----
  p('god-shot', 'Overhead god shot', 'angle',
    'wide shot', 'directly overhead, bird\'s-eye',
    'the camera descends slowly straight down',
    '24mm lens with deep focus',
    'geometric framing of the ground below', 'fate watching from above'),
  p('low-hero', 'Low-angle power', 'angle',
    'medium shot', 'a strong low angle looking up',
    'the camera pushes in slightly',
    '24mm wide-angle lens with mild distortion',
    'the subject towering over the frame', 'an imposing entrance'),
  p('dutch', 'Dutch drift', 'angle',
    'medium close-up', 'a dutch tilt of about 15 degrees',
    'the camera drifts slowly sideways',
    '40mm lens with shallow depth of field',
    'off-balance rule-of-thirds framing', 'something is quietly wrong'),
  p('worms-eye', 'Worm\'s-eye sky', 'angle',
    'extreme wide shot', 'ground level, looking straight up',
    'the camera holds static, rolling slowly',
    '18mm ultra-wide lens',
    'towers and sky swallowing the frame', 'vertigo in reverse'),
  // ----- Lens-led -----
  p('anamorphic', 'Anamorphic dream', 'lens',
    'medium shot', 'eye level',
    'the camera drifts slowly',
    'anamorphic lens with horizontal blue flares and oval bokeh',
    '2.39:1 widescreen letterbox framing', 'prestige-film sheen'),
  p('macro', 'Macro detail', 'lens',
    'extreme close-up', 'eye level',
    'a focus pull racks across the detail',
    'macro lens with razor-thin depth of field',
    'the single detail isolated against soft blur', 'the object tells the story'),
  p('rack-focus', 'Rack focus reveal', 'lens',
    'medium close-up across two depth planes', 'eye level',
    'the frame holds still while focus pulls from foreground to background',
    '85mm lens with razor-thin depth of field',
    'two subjects stacked in depth', 'attention is the edit'),
  p('telephoto', 'Telephoto compression', 'lens',
    'medium close-up', 'eye level',
    'the camera holds nearly still with a slight pan',
    '300mm telephoto lens compressing the planes',
    'blurred foreground passers-by stacking the depth', 'surveillance distance'),
  // ----- Composition-led -----
  p('locked-off', 'Symmetrical one-point', 'composition',
    'wide shot', 'eye level',
    'a locked-off static camera, perfectly still',
    '32mm lens with deep focus',
    'dead-center one-point-perspective symmetry', 'an unblinking formal stare'),
  p('ots', 'Over-the-shoulder', 'composition',
    'medium close-up', 'eye level',
    'the camera holds nearly still with a micro drift',
    '65mm lens with shallow depth of field',
    'framed over a foreground shoulder', 'conversation intimacy'),
  p('pov', 'POV walk', 'composition',
    'first-person point of view', 'eye level',
    'handheld camera walking forward as the character\'s own eyes',
    '28mm lens',
    'hands and body edges intruding at the frame borders', 'you are there'),
  p('voyeur-frame', 'Voyeur doorframe', 'composition',
    'medium shot', 'eye level',
    'a static camera watching through a doorway',
    '50mm lens',
    'framed through a door or window slit, dark edges crowding the subject',
    'being watched'),
  p('mirror', 'Mirror double', 'composition',
    'medium close-up', 'eye level',
    'the camera slowly pushes in, the frame perfectly steady',
    '50mm lens',
    'the subject and their mirror reflection sharing the frame',
    'two truths at once'),
]

const PRESETS_BY_ID: ReadonlyMap<string, ShotRecipe> = new Map(SHOT_PRESETS.map(r => [r.id, r]))

/** shot_presets.py PRESET_IDS: the `preset` widget's options. */
export const SHOT_PRESET_IDS: readonly string[] = SHOT_PRESETS.map(r => r.id)

// The ADVANCED override lists: each option IS the phrase that replaces the preset's value.
export const SHOT_SIZE_OPTIONS: readonly string[] = [SHOT_AUTO, 'extreme close-up', 'close-up', 'medium close-up',
  'medium shot', 'full shot', 'wide shot', 'extreme wide shot']

export const SHOT_ANGLE_OPTIONS: readonly string[] = [SHOT_AUTO, 'eye level', 'a low angle', 'a high angle',
  'directly overhead, bird\'s-eye', 'a dutch tilt', 'ground level']

export const SHOT_MOVEMENT_OPTIONS: readonly string[] = [SHOT_AUTO,
  'a locked-off static camera',
  'the camera slowly dollies in toward the subject',
  'the camera steadily dollies out',
  'the camera pans slowly left to right',
  'the camera tilts up slowly',
  'the camera cranes up smoothly',
  'the camera arcs in a slow orbit around the subject',
  'the camera tracks laterally alongside the subject',
  'shaky handheld camera following the subject',
  'a flowing steadicam glide',
  'an FPV drone dives toward the subject',
  'an abrupt crash zoom punches toward the subject']

export const SHOT_LENS_OPTIONS: readonly string[] = [SHOT_AUTO, '18mm ultra-wide lens', '24mm wide-angle lens', '35mm lens',
  '50mm lens with shallow depth of field',
  '85mm lens with razor-thin depth of field',
  '300mm telephoto lens compressing the planes',
  'anamorphic lens with horizontal blue flares and oval bokeh',
  'macro lens with razor-thin depth of field']

export const SHOT_COMPOSITION_OPTIONS: readonly string[] = [SHOT_AUTO, 'subject centered in frame', 'rule-of-thirds framing',
  'dead-center one-point-perspective symmetry',
  'framed over a foreground shoulder',
  'first-person POV framing',
  'framed through a doorway',
  'leading room ahead of the subject']

/** FilmShotNode's override widgets, each with its option list and the recipe field it replaces. */
export const SHOT_OVERRIDE_WIDGETS: readonly { widget: string; field: 'size' | 'angle' | 'movement' | 'lens' | 'composition'; options: readonly string[] }[] = [
  { widget: 'shot_size', field: 'size', options: SHOT_SIZE_OPTIONS },
  { widget: 'camera_angle', field: 'angle', options: SHOT_ANGLE_OPTIONS },
  { widget: 'camera_movement', field: 'movement', options: SHOT_MOVEMENT_OPTIONS },
  { widget: 'lens_look', field: 'lens', options: SHOT_LENS_OPTIONS },
  { widget: 'composition', field: 'composition', options: SHOT_COMPOSITION_OPTIONS },
]

/**
 * shot_presets.py resolve_recipe: the preset (an unknown id falls back to
 * the default) with every override that is set and isn't AUTO in place of
 * its field. Python's `if value and value != AUTO`: an empty value keeps the
 * preset's.
 */
export function resolveShotRecipe(presetId: unknown, size: unknown, angle: unknown, movement: unknown, lens: unknown, composition: unknown): ShotRecipe {
  const base = (typeof presetId === 'string' ? PRESETS_BY_ID.get(presetId) : undefined) ?? PRESETS_BY_ID.get(SHOT_DEFAULT_PRESET_ID)!
  const overrides: Partial<ShotRecipe> = {}
  for (const [field, value] of [['size', size], ['angle', angle], ['movement', movement], ['lens', lens], ['composition', composition]] as const) {
    if (typeof value === 'string' && value && value !== SHOT_AUTO) overrides[field] = value
  }
  return Object.keys(overrides).length ? { ...base, ...overrides } : base
}

export type ShotDialect = 'veo' | 'hailuo' | 'standard'

/** shot_presets.py dialect_for_model: `veo…` → veo, `hailuo…` → hailuo, anything else standard. */
export function shotDialectForModel(modelId: unknown): ShotDialect {
  const mid = (typeof modelId === 'string' ? modelId : '').toLowerCase()
  if (mid.startsWith('veo')) return 'veo'
  if (mid.startsWith('hailuo')) return 'hailuo'
  return 'standard'
}

/** shot_presets.py _HAILUO_COMMANDS: Hailuo's Director-mode commands, by keyword in the movement clause. */
const HAILUO_COMMANDS: readonly (readonly [string, string])[] = [
  ['dollies in', 'Push in'],
  ['pushes in', 'Push in'],
  ['punches toward', 'Zoom in'],
  ['dollies out', 'Pull out'],
  ['zooms out', 'Zoom out'],
  ['cranes up', 'Pedestal up'],
  ['descends', 'Pedestal down'],
  ['tilts up', 'Tilt up'],
  ['pans', 'Pan right'],
  ['whips violently sideways', 'Pan right'],
  ['orbit', 'Tracking shot'],
  ['tracks laterally', 'Tracking shot'],
  ['glide', 'Tracking shot'],
  ['dives', 'Tracking shot'],
  ['skims', 'Tracking shot'],
  ['handheld', 'Shake'],
  ['lurching', 'Shake'],
  ['static', 'Static shot'],
  ['holds still', 'Static shot'],
  ['holds nearly still', 'Static shot'],
]

/** shot_presets.py _hailuo_brackets: every matched command once, in table order, in brackets; none, "". */
function hailuoBrackets(movement: string): string {
  const m = movement.toLowerCase()
  const cmds: string[] = []
  for (const [keyword, cmd] of HAILUO_COMMANDS) {
    if (m.includes(keyword) && !cmds.includes(cmd)) cmds.push(cmd)
  }
  return cmds.length ? `[${cmds.join(', ')}]` : ''
}

/** shot_presets.py _cap: the first character upper-cased. */
function cap(s: string): string {
  if (!s) return s
  const first = String.fromCodePoint(s.codePointAt(0)!)
  return first.toUpperCase() + s.slice(first.length)
}

/** shot_presets.py build_shot_phrase: the recipe as prompt language in the model's dialect. */
export function buildShotPhrase(recipe: ShotRecipe, dialect: ShotDialect = 'standard'): string {
  if (dialect === 'veo') {
    return `${cap(recipe.lens)}, ${recipe.size} from ${recipe.angle}. `
      + `${cap(recipe.movement)}; ${recipe.composition}. `
      + `${cap(recipe.note)}. Cinematic.`
  }
  if (dialect === 'hailuo') {
    return pyStrip(`${hailuoBrackets(recipe.movement)} ${buildShotPhrase(recipe, 'standard')}`)
  }
  return `Cinematic ${recipe.size} from ${recipe.angle}. `
    + `${cap(recipe.movement)}. ${cap(recipe.lens)}; `
    + `${recipe.composition} — ${recipe.note}.`
}

/**
 * FilmShotNode.execute's full_prompt on the preset path (not shot-directed):
 * the phrase for the node's preset, overrides and model, then the prompt,
 * stripped, `f"{shot_phrase} {prompt.strip()}".strip()`.
 */
export function filmShotPrompt(inputs: Record<string, unknown>): string {
  const recipe = resolveShotRecipe(inputs.preset,
    inputs.shot_size ?? SHOT_AUTO, inputs.camera_angle ?? SHOT_AUTO, inputs.camera_movement ?? SHOT_AUTO,
    inputs.lens_look ?? SHOT_AUTO, inputs.composition ?? SHOT_AUTO)
  const phrase = buildShotPhrase(recipe, shotDialectForModel(inputs.model))
  const prompt = typeof inputs.prompt === 'string' ? inputs.prompt : ''
  return pyStrip(`${phrase} ${pyStrip(prompt)}`)
}
