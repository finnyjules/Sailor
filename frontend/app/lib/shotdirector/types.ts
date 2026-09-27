// frontend/app/lib/shotdirector/types.ts
// Data model for the Shot Director studio — a structured, editable "intent"
// for a single video shot that compiles to a terse best-practice prompt +
// reference wiring. Persisted at node.data.properties.sailor_shotDirector.
// Pure data + vocabulary; no Vue/DOM/network here.

export type ShotMode = 'reference' | 'firstLastFrame'

export type ShotType =
  | 'wide' | 'medium' | 'close-up' | 'extreme-close-up' | 'establishing'

// Curated camera moves (16). Exactly one primary move per shot/beat. The first 8
// are the original ids (back-compat, no migration); the rest add zoom-vs-dolly and
// a few named moves. Grouped by MOVE_CATEGORY, directioned by MOVE_DIRECTIONS.
export type CameraMove =
  | 'push-in' | 'pull-out' | 'pan' | 'track'
  | 'orbit' | 'aerial' | 'handheld' | 'locked-off'
  | 'tilt' | 'whip-pan' | 'zoom-in' | 'zoom-out'
  | 'truck' | 'pedestal' | 'arc' | 'crane'

// A move's direction, when it has one (see MOVE_DIRECTIONS).
export type CameraDirection = 'left' | 'right' | 'up' | 'down' | 'cw' | 'ccw'

export type MoveCategory = 'Static' | 'Pan/Tilt' | 'Zoom' | 'Dolly' | 'Physical' | 'Orbit' | 'Aerial' | 'Human'

export type Pacing = 'slow' | 'smooth' | 'gradual' | 'gentle'

export type RefKind = 'image' | 'video' | 'audio'

export type RefRole =
  // image roles
  | 'identity-lock' | 'lighting-copy' | 'composition-lock' | 'style-transfer'
  // scene-context image role — the environment plate (attach/generate). Not a
  // manual dropdown option (absent from ROLES_BY_KIND); the surface sets it
  // directly. Deliberately not composition-lock: use the place, not its framing.
  | 'location'
  // video roles
  | 'camera-copy' | 'motion-transfer' | 'sequence-extend'
  // audio roles
  | 'beat-sync' | 'lip-sync' | 'mood'

export interface Ref {
  kind: RefKind
  /** 1-based slot per kind — renders as [Image{slot}] / [Video{slot}] / [Audio{slot}]. */
  slot: number
  /** data: URL or hosted URL passed to Replicate. */
  src: string
  role: RefRole
  /** freeform refinement folded into the purpose phrase. */
  note?: string
  /** set when this ref was injected from a cast member — materializeCast owns these. */
  castSlug?: string
}

export interface Beat {
  id: string
  startS: number
  endS: number
  action: string
  shotType?: ShotType
  move?: CameraMove
  pacing?: Pacing
  /** slots (per-kind) whose references apply to this beat. */
  activeRefSlots?: number[]
  /** cached preview still (flux-schnell), filled by the UI in a later phase. */
  keyframeUrl?: string
}

export interface DialogueLine {
  speaker?: string
  line: string
}

export interface ShotCamera {
  shotType: ShotType
  move: CameraMove
  pacing: Pacing
  /** direction for moves that have one (pan, orbit, tilt…); ignored otherwise. */
  direction?: CameraDirection
}

export interface ShotAudio {
  generate: boolean
  dialogue?: DialogueLine[]
  sfxNote?: string
}

export interface ShotFormat {
  aspectRatio: string   // 'adaptive' excluded for v1 (unsupported by FilmShotNode/_SEEDANCE_AR); surface options in ShotDirectorSurface.vue
  durationS: number     // Seedance set; -1 allowed (intelligent)
  resolution: string
  seed?: number
}

export interface ShotSheet {
  intent: string
  mode: ShotMode
  /** the video model this shot is made with (a profile id, see profiles.ts). Absent on old sheets = Seedance 2.0. */
  model?: string

  subject: string
  action: string
  environment: string
  lighting: string
  style: string
  camera: ShotCamera
  constraints: string[]
  cast: CastMember[]

  references: Ref[]
  firstFrame?: string
  lastFrame?: string

  beats: Beat[]
  audio: ShotAudio
  format: ShotFormat
}

// ---- Fixed vocabulary (drives deterministic prose in compile.ts) -----------

export const SHOT_TYPE_PHRASE: Record<ShotType, string> = {
  'wide': 'Wide shot',
  'medium': 'Medium shot',
  'close-up': 'Close-up',
  'extreme-close-up': 'Extreme close-up',
  'establishing': 'Establishing shot',
}

// Short labels — for dropdowns (beats) and the picker. Compile uses the richer
// cameraMoveClause() instead.
export const CAMERA_MOVE_PHRASE: Record<CameraMove, string> = {
  'push-in': 'Push in',
  'pull-out': 'Pull out',
  'pan': 'Pan',
  'track': 'Track',
  'orbit': 'Orbit',
  'aerial': 'Aerial',
  'handheld': 'Handheld',
  'locked-off': 'Locked',
  'tilt': 'Tilt',
  'whip-pan': 'Whip pan',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'truck': 'Truck',
  'pedestal': 'Pedestal',
  'arc': 'Arc',
  'crane': 'Crane',
}

export const MOVE_CATEGORY: Record<CameraMove, MoveCategory> = {
  'locked-off': 'Static',
  'pan': 'Pan/Tilt', 'tilt': 'Pan/Tilt', 'whip-pan': 'Pan/Tilt',
  'zoom-in': 'Zoom', 'zoom-out': 'Zoom',
  'push-in': 'Dolly', 'pull-out': 'Dolly', 'track': 'Dolly',
  'truck': 'Physical', 'pedestal': 'Physical', 'arc': 'Physical',
  'orbit': 'Orbit',
  'aerial': 'Aerial', 'crane': 'Aerial',
  'handheld': 'Human',
}

// Allowed directions per move (empty = none). Category axes: L/R, U/D, CW/CCW.
export const MOVE_DIRECTIONS: Record<CameraMove, CameraDirection[]> = {
  'pan': ['left', 'right'], 'whip-pan': ['left', 'right'], 'truck': ['left', 'right'], 'arc': ['left', 'right'],
  'tilt': ['up', 'down'], 'pedestal': ['up', 'down'], 'crane': ['up', 'down'],
  'orbit': ['cw', 'ccw'],
  'push-in': [], 'pull-out': [], 'track': [], 'zoom-in': [], 'zoom-out': [],
  'aerial': [], 'handheld': [], 'locked-off': [],
}

export const MOVE_DEFAULT_DIR: Partial<Record<CameraMove, CameraDirection>> = {
  'pan': 'right', 'whip-pan': 'right', 'truck': 'right', 'arc': 'right',
  'tilt': 'up', 'pedestal': 'up', 'crane': 'up',
  'orbit': 'cw',
}

const DIR_WORD: Record<CameraDirection, string> = {
  left: 'left', right: 'right', up: 'up', down: 'down', cw: 'clockwise', ccw: 'counterclockwise',
}

// The descriptive, model-legible movement clause used in the compiled prompt — it
// names the physical action (dolly vs zoom, direction) so the model follows it far
// more reliably than a bare label. Concise for the word budget. {dir} = the chosen
// or default direction where the move has one.
export function cameraMoveClause(move: CameraMove, direction?: CameraDirection): string {
  const dir = DIR_WORD[direction ?? MOVE_DEFAULT_DIR[move] ?? 'right']
  switch (move) {
    case 'locked-off': return 'locked-off, a static camera'
    case 'push-in': return 'dolly in, the camera moving physically forward'
    case 'pull-out': return 'dolly out, the camera moving physically backward'
    case 'zoom-in': return 'zoom in, lens only with the camera fixed'
    case 'zoom-out': return 'zoom out, lens only with the camera fixed'
    case 'track': return 'a tracking shot following the subject'
    case 'aerial': return 'a high aerial drone shot'
    case 'handheld': return 'handheld movement with a subtle human-operator shake'
    case 'pan': return `pan ${dir}, rotating horizontally in place`
    case 'whip-pan': return `whip pan ${dir}, a fast rotation`
    case 'tilt': return `tilt ${dir}, rotating vertically in place`
    case 'truck': return `truck ${dir}, sliding the camera laterally`
    case 'pedestal': return `pedestal ${dir}, moving the whole camera vertically`
    case 'arc': return `arc ${dir}, curving around the subject`
    case 'orbit': return `orbit ${dir} around the subject`
    case 'crane': return `crane ${dir}, booming smoothly through space`
  }
}

export const ROLE_PURPOSE: Record<RefRole, string> = {
  'identity-lock': "the character's identity and wardrobe",
  'location': 'the location and setting',
  'lighting-copy': 'the lighting style',
  'composition-lock': 'the scene composition',
  'style-transfer': 'the visual style',
  'camera-copy': 'the camera movement',
  'motion-transfer': 'the subject motion',
  'sequence-extend': 'continuation from where it ended',
  'beat-sync': 'beat synchronization',
  'lip-sync': 'lip-sync timing',
  'mood': 'the mood and pacing',
}

export const ROLES_BY_KIND: Record<RefKind, RefRole[]> = {
  image: ['identity-lock', 'lighting-copy', 'composition-lock', 'style-transfer'],
  video: ['camera-copy', 'motion-transfer', 'sequence-extend'],
  audio: ['beat-sync', 'lip-sync', 'mood'],
}

export interface CastMember {
  slug: string
  name: string
  via: 'wire' | 'picker'
  /** which of the character's states to use; null = the default state. */
  stateId: string | null
}

export function createDefaultShotSheet(): ShotSheet {
  return {
    intent: '',
    mode: 'reference',
    model: 'seedance-2.0',
    subject: '',
    action: '',
    environment: '',
    lighting: '',
    style: '',
    camera: { shotType: 'medium', move: 'locked-off', pacing: 'smooth' },
    constraints: [],
    cast: [],
    references: [],
    beats: [],
    audio: { generate: true },
    format: { aspectRatio: '16:9', durationS: 5, resolution: '1080p' },
  }
}
