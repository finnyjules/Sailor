/**
 * Lens · 3D Reframe and Pose Mannequin as runner plans (step 3, R3.15,
 * family `nano-extras`), ported line for line from:
 *   comfy_extras/_lenses.py               (LENSES, _intensity, reframe_instruction)
 *   comfy_extras/nodes_lens_reframe.py    (LensReframeNode.execute, :59-83)
 *   comfy_extras/_pose_prompts.py         (the three prompts, pose_instruction)
 *   comfy_extras/nodes_pose_mannequin.py  (_load_input_image, :35-45; execute, :92-140)
 *
 * A call is Replicate's `google/nano-banana-2` `{prompt, image_input,
 * resolution: "1K", output_format: "png"}` as Python sends it, fal's Nano
 * Banana 2 edit the backup (twins.ts nanoBananaOnFal, the nano actions'
 * route); its first answer URL is the picture (`_first_output_url`), saved
 * as downloaded, shown as Python's `save_generation_output(result,
 * "reframe" | "pose")` shows it.
 *
 * Pose Mannequin's baked files (`result_image`, `pose_cond_image`,
 * `mannequin_image`, names in the input folder the pose editor uploaded) are
 * loaded as `_load_input_image` loads them: EXIF turned, RGB
 * (pictures/pythonView.ts rgbTurnedPng); a blank name or a file that isn't
 * there is Python's None. Its branches (execute :115-140):
 *   image     both pictures wired → a call with [character, pose picture];
 *   prompt    a pose prompt that isn't blank → a call with [character];
 *   mannequin the saved result loads → it is the result (no call);
 *             else the conditioning render loads → a call with [character, it]
 *             (RUNNER DEVIATION, R3.15 fix round 1, controller ruling:
 *             Python's `_load_input_image(pose_cond_image) or …` asks the
 *             loaded tensor for its truth value and raises, so this render
 *             never reached a call there; the runner does what the code
 *             means, priced as a call. The ComfyUI path still fails, free);
 *             else the mannequin render loads → a call with [character, it];
 *   otherwise the character passes through (no call).
 * A no-call branch is free on both paths (ruling (p)): #shared/runner/nanoExtras
 * poseNoCall prices it from the inputs as sent; a saved pose counts as no
 * call only once read and found loading (the start of the run). In hosted a
 * saved pose named but not loading is refused before the hold (Python would
 * fall through to a call).
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { pyFloatOf, pyStrip } from '#shared/runner/pyText'
import {
  LENS_REFRAME_CLASS, NANO_EXTRAS_SLUG, POSE_MANNEQUIN_CLASS, POSE_RESULT_MISSING,
  bakedNamePresent, poseSourceOf, type PoseBakedInput,
} from '#shared/runner/nanoExtras'
import type { NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { imageUrlOf } from '../imageUrl'
import { pythonInputRef } from '../inputs'
import {
  PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH, PICTURE_UNREADABLE, decodesStrictly, pictureRefusal, rgbTurnedPng,
} from '../pictures/pythonView'
import { loaderHandoffBytes, loaderSourceOf } from '../pictureHandoff'
import { NANO_BANANA_2_REPLICATE, nanoBananaOnFal } from './twins'

// ── _lenses.py ───────────────────────────────────────────────────────────────

export interface Lens { name: string; focal_mm: number; look: string }

/** `LENSES`, verbatim. */
export const LENSES: readonly Lens[] = [
  {
    name: 'Ultra-Wide 16mm', focal_mm: 16,
    look: 'an ultra-wide 16mm lens — a very wide field of view with strong '
      + 'wide-angle perspective where the nearest parts of the subject loom '
      + 'larger and the background feels expansive and pushed far back, with '
      + 'gentle barrel distortion toward the frame edges',
  },
  {
    name: 'Wide 24mm Art', focal_mm: 24,
    look: 'a wide 24mm lens — an environmental wide field of view with natural '
      + 'wide-angle perspective, mild foreground emphasis and a touch of '
      + 'barrel distortion',
  },
  {
    name: 'Classic 35mm Summilux', focal_mm: 35,
    look: 'a classic 35mm lens — a natural, slightly wide documentary field of '
      + 'view with relaxed, true-to-life perspective',
  },
  {
    name: 'Normal 50mm Planar', focal_mm: 50,
    look: 'a normal 50mm lens — a neutral, eye-like field of view and natural '
      + 'perspective with no compression or distortion',
  },
  {
    name: 'Portrait 85mm GM', focal_mm: 85,
    look: 'an 85mm portrait lens — flattering telephoto compression that gently '
      + 'flattens facial features, a tighter field of view and smooth, '
      + 'separated background',
  },
  {
    name: 'Tele 135mm f/2', focal_mm: 135,
    look: 'a 135mm telephoto lens — strong perspective compression that flattens '
      + 'depth, a narrow field of view and a softly compressed background',
  },
  {
    name: 'Long 200mm', focal_mm: 200,
    look: 'a 200mm super-telephoto lens — very strong compression that flattens '
      + 'the scene, a very narrow field of view and a tightly stacked, '
      + 'compressed background',
  },
]

/** `get(name)`: a lens by name; None (null) for Custom or an unknown name. */
function lensNamed(name: unknown): Lens | null {
  return typeof name === 'string' ? LENSES.find(l => l.name === name) ?? null : null
}

/** `focal_for(name, custom_focal)`. */
export function focalFor(name: unknown, customFocal: number): number {
  const lens = lensNamed(name)
  return lens ? lens.focal_mm : customFocal
}

/** `_intensity(strength)`. */
export function lensIntensity(strength: number): string {
  if (strength < 0.4) return 'a subtle'
  if (strength < 0.8) return 'a moderate'
  if (strength < 1.15) return 'a clear'
  return 'a strong, dramatic'
}

/** `reframe_instruction(source_name, target_name, strength, custom_focal)`: `int()` of a focal truncates. */
export function reframeInstruction(sourceName: unknown, targetName: unknown, strength = 1, customFocal = 50): string {
  const src = lensNamed(sourceName)
  const tgt = lensNamed(targetName)
  const srcFocal = src ? src.focal_mm : Math.trunc(customFocal)
  const tgtFocal = tgt ? tgt.focal_mm : Math.trunc(customFocal)
  const tgtLook = tgt ? tgt.look : `a ${tgtFocal}mm lens`
  const direction = tgtFocal < srcFocal ? 'wider, more wide-angle' : tgtFocal > srcFocal ? 'longer, more telephoto' : 'equivalent'
  return (
    `Re-photograph this exact scene as if it were shot on ${tgtLook}, instead `
    + `of the ${srcFocal}mm lens it was actually taken with. Apply ${lensIntensity(strength)} `
    + `change toward the ${direction} look: adjust the field of view, perspective, `
    + 'depth compression and optical rendering accordingly, moving the camera '
    + 'distance the way a real photographer would so the subject stays naturally '
    + 'framed. Keep the subject\'s identity, face, hair, body, pose and outfit, and '
    + 'the background and lighting, exactly the same — change only the lens and '
    + 'viewpoint. Photorealistic, sharp, high detail, full-frame photograph.'
  )
}

// ── _pose_prompts.py ─────────────────────────────────────────────────────────

export const MANNEQUIN_PROMPT = (
  'The first image is a character. The second image is a SURFACE-NORMAL render of '
  + 'a posed 3D mannequin: its colours encode the target body pose AND the exact 3D '
  + 'orientation — which way the body and each limb face. Redraw the EXACT SAME '
  + 'character from the first image — keep their face, hair, skin tone, body type, '
  + 'clothing and art style identical — but pose them to match the second image: '
  + 'limb positions, stance, head angle, AND the whole-body orientation/facing '
  + 'direction (front, three-quarter, side, or back). If the body is turned or facing '
  + 'away, turn the character the same way; do NOT default to a front-facing view. '
  + 'Full body, head to toe, plain neutral studio background, natural and photographic. '
  + 'Output only the character in that pose, never the normal-map render itself.'
)

export const IMAGE_PROMPT = (
  'The first image is a character. The second image shows a person or figure in a '
  + 'TARGET body pose. Redraw the EXACT SAME character from the first image — keep '
  + 'their face, hair, skin tone, body type, clothing and art style identical — but '
  + 're-pose them to match the SECOND image\'s body pose: stance, limb positions, head '
  + 'angle, and whole-body orientation/facing direction. Copy ONLY the pose from the '
  + 'second image — never its identity, clothing, or background. Full body, head to '
  + 'toe, plain neutral studio background, natural and photographic. Output only the '
  + 're-posed character.'
)

export const TEXT_PROMPT = (
  'The image is a character. Redraw the EXACT SAME character — keep their face, '
  + 'hair, skin tone, body type, clothing and art style identical — but re-pose their '
  + 'body as follows: {pose}. Full body, head to toe, plain neutral studio '
  + 'background, natural and photographic. Output only the re-posed character.'
)

export const DEFAULT_POSE = 'a natural, relaxed standing pose'

/** `pose_instruction(pose_source, extra, pose_prompt)`: `str.format` fills the one `{pose}`. */
export function poseInstruction(poseSource: string, extra = '', posePrompt = ''): string {
  let base: string
  if (poseSource === 'image') base = IMAGE_PROMPT
  else if (poseSource === 'prompt') base = TEXT_PROMPT.split('{pose}').join(pyStrip(posePrompt ?? '') || DEFAULT_POSE)
  else base = MANNEQUIN_PROMPT
  const more = pyStrip(extra ?? '')
  return more ? `${base} Additional direction: ${more}.` : base
}

// ── The widgets, as Python reads them ────────────────────────────────────────

/** A STRING widget's text: missing or None is `default`; text is itself (a wired one arrives as typed, R0). */
function text(inputs: Record<string, unknown>, name: string, def = ''): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v !== 'string') throw new Error('This setting must be text')
  return v
}

/** `float(v)` of a FLOAT widget; missing is its default. */
function float(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (v === undefined) return def
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyFloatOf(v) : null
  if (n === null || !Number.isFinite(n)) throw new Error('This number setting must be a number')
  return n
}

/** Lens reframe's instruction from its widgets (`execute`, :71-73). */
export function lensPrompt(inputs: Record<string, unknown>): string {
  return reframeInstruction(
    inputs.source_lens === undefined ? 'Normal 50mm Planar' : inputs.source_lens,
    inputs.target_lens === undefined ? 'Portrait 85mm GM' : inputs.target_lens,
    float(inputs, 'reframe_strength', 1), float(inputs, 'custom_focal', 50),
  )
}

/** The request both classes send (`_run_prediction("google/nano-banana-2", …)`). */
export function nanoExtrasInput(prompt: string, imageInput: string[]): Record<string, unknown> {
  return { prompt, image_input: imageInput, resolution: '1K', output_format: 'png' }
}

// ── Pose Mannequin's branch ──────────────────────────────────────────────────

/**
 * Which way Pose Mannequin's execute goes (:115-140), given which of its
 * baked files `_load_input_image` would load (`loads`) — asked lazily, in
 * Python's order, so a file Python never opens is never read.
 */
export type PoseBranch =
  | { kind: 'call'; instruction: string; pictures: ('character' | 'pose_image' | 'pose_cond_image' | 'mannequin_image')[] }
  | { kind: 'baked' }
  | { kind: 'pass' }

export async function posePlanBranch(inputs: Record<string, unknown>, loads: (name: PoseBakedInput) => Promise<boolean>): Promise<PoseBranch> {
  const hasCharacter = isLink(inputs.character)
  const extra = text(inputs, 'prompt')
  const source = poseSourceOf(inputs)
  if (source === 'image') {
    if (hasCharacter && isLink(inputs.pose_image)) return { kind: 'call', instruction: poseInstruction('image', extra, ''), pictures: ['character', 'pose_image'] }
  }
  else if (source === 'prompt') {
    const pose = text(inputs, 'pose_prompt')
    if (hasCharacter && pyStrip(pose)) return { kind: 'call', instruction: poseInstruction('prompt', extra, pose), pictures: ['character'] }
  }
  else {
    if (await loads('result_image')) return { kind: 'baked' }
    // RUNNER DEVIATION (fix round 1): Python's `_load_input_image(pose_cond_image) or _load_input_image(mannequin_image)`
    // raises on a loaded tensor's truth value; the conditioning render when it loads, else the mannequin render.
    const cond: 'pose_cond_image' | 'mannequin_image' | null = await loads('pose_cond_image') ? 'pose_cond_image' : await loads('mannequin_image') ? 'mannequin_image' : null
    if (hasCharacter && cond) return { kind: 'call', instruction: poseInstruction('mannequin', extra, ''), pictures: ['character', cond] }
  }
  return { kind: 'pass' }
}

// ── The baked files ──────────────────────────────────────────────────────────

const WHY: Readonly<Record<string, string>> = {
  [PICTURE_16_BIT]: 'is 16-bit, which Sailor can’t read',
  [PICTURE_32_BIT]: 'is 32-bit, which Sailor can’t read',
  [PICTURE_CMYK]: 'is CMYK, which Sailor can’t read',
  [PICTURE_GIF_SEE_THROUGH]: 'is a GIF with see-through parts, which Sailor can’t read',
  [PICTURE_UNREADABLE]: 'is a kind of file Sailor can’t read',
}

/** A baked file Python would load its own way (16-bit, CMYK…), refused in plain words (`why`: one of the PICTURE_* words). */
export function poseBakedRefusal(why: string): string {
  return `A picture Pose Mannequin saved ${WHY[why] ?? WHY[PICTURE_UNREADABLE]}. Open the pose editor and pose it again.`
}

/**
 * The baked file a widget names, read as Python opens it (../inputs.ts
 * pythonInputRef, fix round 2: `./x.png`, `sub//x.png`, `sub/../x.png` are
 * the files they name), or null: blank, a folder, or outside the folders
 * (hosted refuses that at the start; locally it can't be read here).
 */
function bakedFile(inputs: Record<string, unknown>, name: PoseBakedInput): OutputFile | null {
  const ref = bakedNamePresent(inputs[name]) ? pythonInputRef(inputs[name]) : null
  return ref && 'file' in ref ? ref.file : null
}

/** The ownership refusal (inputs.ts assertFilesOwned's words): a saved picture named outside the user's folders. */
export const POSE_FILE_NOT_YOURS = 'This workflow uses a file that isn’t one of yours'

/**
 * The start of a run (engine.ts, before anything is held), for each Pose
 * Mannequin in mannequin mode: its baked files read in Python's order (only
 * the ones it would open), a file Python reads its own way refused in plain
 * words (the cards' rule, R1.3); in hosted, a saved pose named but not
 * loading refused (Python would fall through to a call). `savedPoses` gets
 * each node whose saved pose loads: it makes no call, and is held at nothing
 * (TakeRecord.measured `savedPose`, fix round 1).
 */
export async function poseStartProblem(
  prompt: ApiPrompt, read: (f: OutputFile) => Promise<Uint8Array>, hosted: boolean, savedPoses?: Set<string>,
): Promise<{ nodeId: string; classType: string; message: string; status?: number } | null> {
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== POSE_MANNEQUIN_CLASS) continue
    const inputs = n.inputs ?? {}
    // Hosted ownership (fix round 2): a saved picture named outside the user's folders (an absolute
    // path, `../x`) can't be theirs, whatever the mode (collectInputFiles lists every name it can).
    if (hosted) {
      for (const name of ['result_image', 'pose_cond_image', 'mannequin_image'] as const) {
        const ref = bakedNamePresent(inputs[name]) ? pythonInputRef(inputs[name]) : null
        if (ref && 'outside' in ref) return { nodeId, classType: n.class_type, message: POSE_FILE_NOT_YOURS, status: 403 }
      }
    }
    if (poseSourceOf(inputs) !== 'mannequin' || isLink(inputs.pose_source)) continue
    let refusal: string | null = null
    const loads = async (name: PoseBakedInput): Promise<boolean> => {
      const f = bakedFile(inputs, name)
      if (!f || refusal) return false
      let bytes: Uint8Array
      try { bytes = await read(f) }
      catch { return false }
      const why = await pictureRefusal(bytes)
      if (why) refusal = poseBakedRefusal(why)
      // Loads only if it decodes fully (fix round 2): a corrupt or cut-short file is Python's None.
      return !why && await decodesStrictly(bytes)
    }
    const branch = await posePlanBranch(inputs, loads)
    const problem = refusal ?? (hosted && branch.kind === 'call' && bakedNamePresent(inputs.result_image) ? POSE_RESULT_MISSING : null)
    if (problem) return { nodeId, classType: n.class_type, message: problem }
    if (branch.kind === 'baked') savedPoses?.add(nodeId)
  }
  return null
}

// ── The plans ────────────────────────────────────────────────────────────────

/** A call: google/nano-banana-2 on Replicate, fal's Nano Banana 2 edit the backup; the first URL is the picture. */
function nanoCall(prompt: string, imageInput: string[], prefix: 'reframe' | 'pose'): NodePlan {
  const payload = nanoExtrasInput(prompt, imageInput)
  return {
    kind: 'provider', provider: 'replicate', endpoint: NANO_EXTRAS_SLUG, payload,
    media: 'image', take: 'first', prefix,
    // save_generation_output(result, prefix).
    uiFor: files => ({ images: files, animated: [false] }),
    backup: nanoBananaOnFal(NANO_BANANA_2_REPLICATE, payload),
  }
}

async function planLens(ctx: PlanContext, inputs: Record<string, unknown>): Promise<NodePlan> {
  const link = inputs.image
  const file = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!file) throw new Error('There is no picture to reframe')
  const prompt = lensPrompt(inputs)
  return nanoCall(prompt, [await imageUrlOf(ctx, file, link)], 'reframe')
}

/** A baked file as `_load_input_image`'s tensor: the RGB PNG (or the file itself when it already is that), refused in plain words. */
async function loadBaked(ctx: PlanContext, f: OutputFile): Promise<{ bytes: Uint8Array; png: Uint8Array | null } | null> {
  if (!ctx.readFile) throw new Error('The runner cannot read Pose Mannequin’s saved pictures here')
  let bytes: Uint8Array
  try { bytes = await ctx.readFile(f) }
  catch { return null }
  // A file that doesn't decode fully is Python's None (fix round 2): never handed on garbled.
  if (!(await decodesStrictly(bytes))) return null
  try { return { bytes, png: (await rgbTurnedPng(bytes)).png } }
  catch (e) {
    throw new Error(poseBakedRefusal(e instanceof Error ? e.message : PICTURE_UNREADABLE))
  }
}

async function planPose(ctx: PlanContext, inputs: Record<string, unknown>): Promise<NodePlan> {
  const character = inputs.character
  const characterFile = isLink(character) ? ctx.filesFrom(character)[0] : undefined
  if (!characterFile) throw new Error('There is no character to pose')
  const loaded = new Map<PoseBakedInput, { file: OutputFile; bytes: Uint8Array; png: Uint8Array | null }>()
  const branch = await posePlanBranch(inputs, async (name) => {
    const f = bakedFile(inputs, name)
    const got = f ? await loadBaked(ctx, f) : null
    if (got && f) loaded.set(name, { file: f, ...got })
    return !!got
  })
  if (branch.kind === 'call') {
    // A saved pose named but not loading (gone since the start of the run): in hosted never
    // sent (its hold may be nothing; the start of the run refused it; this is the backstop).
    // Only where it decides the branch: a typed mannequin-mode source (fix round 2); image and
    // prompt modes ignore a leftover saved pose, as Python does.
    const priced = ctx.priceInputs ?? inputs
    if (ctx.hosted && !isLink(priced.pose_source) && poseSourceOf(priced) === 'mannequin' && bakedNamePresent(priced.result_image)) throw new Error(POSE_RESULT_MISSING)
    const urls: string[] = []
    for (const p of branch.pictures) {
      if (p === 'mannequin_image' || p === 'pose_cond_image') {
        const m = loaded.get(p)!
        if (!m.png) urls.push(await ctx.toUrl(m.file))
        else if (ctx.bytesToUrl) urls.push(await ctx.bytesToUrl(pngNameOf(m.file), m.png))
        else throw new Error('The runner cannot hand off Pose Mannequin’s pose render here')
        continue
      }
      const link = inputs[p]
      const f = isLink(link) ? ctx.filesFrom(link)[0] : undefined
      if (!f) throw new Error(p === 'character' ? 'There is no character to pose' : 'There is no pose picture')
      urls.push(await imageUrlOf(ctx, f, link))
    }
    return nanoCall(branch.instruction, urls, 'pose')
  }

  if (branch.kind === 'baked') {
    // save_live_preview(baked, uid, unique=True): the saved pose, as `_load_input_image`'s tensor.
    const r = loaded.get('result_image')!
    return {
      kind: 'derive',
      async derive(io) {
        const file = r.png ? await io.keep(r.png, 'png') : r.file
        const shown = await io.savePreview(r.png ?? r.bytes, { nodeId: io.nodeId })
        return { values: { 0: { kind: 'files', files: [file] } }, ui: { images: [shown] } }
      },
    }
  }

  // Nothing to pose with: the character passes through, as the tensor it arrived as.
  const source = ctx.families ? loaderSourceOf(ctx.prompt, character, ctx.families) : null
  if (!source) {
    const files = ctx.filesFrom(character as ApiLink)
    return { kind: 'pass', files, ui: { images: [files[0]!] } }
  }
  return {
    kind: 'derive',
    async derive(io) {
      const sent = await loaderHandoffBytes(await io.read(source.file), source.kind, io.signal)
      const file = sent.made ? await io.keep(sent.bytes, 'png') : source.file
      const shown = await io.savePreview(sent.bytes, { nodeId: io.nodeId })
      return { values: { 0: { kind: 'files', files: [file] } }, ui: { images: [shown] } }
    },
  }
}

/** A made PNG's upload name: the baked file's own name, as a .png. */
function pngNameOf(f: OutputFile): OutputFile {
  const dot = f.filename.lastIndexOf('.')
  return { ...f, filename: `${dot > 0 ? f.filename.slice(0, dot) : f.filename}.png` }
}

/** The node's plan: Lens reframe's call, or Pose Mannequin's branch. */
export async function planNanoExtras(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const inputs = node.inputs ?? {}
  if (node.class_type === LENS_REFRAME_CLASS) return planLens(ctx, inputs)
  if (node.class_type === POSE_MANNEQUIN_CLASS) return planPose(ctx, inputs)
  throw new Error(`The runner cannot run ${node.class_type}`)
}
