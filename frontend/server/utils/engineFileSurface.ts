/**
 * Stage 6 Task 7b — the engine's file-READ surface, as a checked-in map.
 *
 * Task 7 shipped a validator that only inspected object_info UPLOAD-FLAGGED
 * inputs plus a hardcoded `LoadImageOutput.image`. The engine has many more
 * nodes whose execute reads a file from a shared `input/`/`output/`/`temp/`
 * directory via `folder_paths.get_annotated_filepath` (a bare join with NO
 * containment) — through UNFLAGGED plain-string inputs, dict-valued inputs
 * (Load3D's `image`), and JSON-blob inputs (Compositor's `motion_params`, the
 * type nodes' `params`, Timeline's `edit_state`). A hand-crafted graph can
 * carry another tenant's filename through any of these and launder a
 * cross-tenant read: several decode the file into an IMAGE/VIDEO the attacker
 * then saves to their own `u_<hash>/` folder and views.
 *
 * GRAPH_FILE_READERS is the authoritative map the graph validator walks to
 * decide which inputs carry a filename it must vet for ownership before a
 * graph runs. It is keyed by class_type (the engine `node_id`). Its companion
 * GRAPH_FOLDER_READERS (below) models the per-FOLDER readers — nodes that read a
 * whole attacker-named folder out of the shared tree (the Task 7b review
 * Critical). The coverage guard in engine-file-surface.unit.spec.ts greps the
 * engine tree for the FULL directory-read primitive set and fails on drift, so a
 * newly-added file- or folder-reading node fails the suite instead of silently
 * bypassing the check.
 *
 * LOCAL BYTE-IDENTICAL: nothing here runs in local mode — it is consulted only
 * from the hosted meterGraphSubmit / handleMeteredPrompt path.
 *
 * Task 7c adds the WRITE-side companion, GRAPH_OUTPUT_WRITERS (below): which
 * input field carries a class's output path, for the per-user subfolder
 * injection (injectOutputSubfolder in meterGraphRun.ts).
 */
import { OUTPUT_CLASS_TYPES } from './priceBook'
import { moodboardFiles } from '../runner/inputs'
import { parseViewRef } from '../../shared/pricing/clipSettings'

/** How a file input carries its filename(s). */
export type FileRefSemantics = 'input' | 'output' | 'either'

/**
 * `either` = the value is routed by a trailing ` [output]`/` [input]`/` [temp]`
 * annotation (folder_paths.get_annotated_filepath). `input`/`output` = the
 * engine always reads from that tree regardless of any annotation on the value.
 */
export type FileReaderSpec =
  | { input: string, shape: 'string', semantics: FileRefSemantics }
  | { input: string, shape: 'dict', keys: string[], semantics: FileRefSemantics }
  | { input: string, shape: 'json', jsonPath: 'rendered' | 'timeline-clips' | 'moodboard' | 'view-refs' | 'video-refs', semantics: FileRefSemantics }

/**
 * class_type → the file-carrying inputs the engine reads on execute. Evidence
 * lives in the Task 7b report (per-node file:line). Semantics are `either`
 * wherever the read routes through get_annotated_filepath (annotation-honouring);
 * `input`/`output` where the engine hard-codes the tree.
 */
export const GRAPH_FILE_READERS: Record<string, FileReaderSpec[]> = {
  // nodes.py
  LoadImage: [{ input: 'image', shape: 'string', semantics: 'either' }],
  LoadImageMask: [{ input: 'image', shape: 'string', semantics: 'either' }],
  // LoadImageOutput reads from the OUTPUT tree by definition (its remote combo
  // lists output/, and load_image reads whatever filename it is handed). This
  // spec subsumes the old hardcoded pair.
  LoadImageOutput: [{ input: 'image', shape: 'string', semantics: 'output' }],
  LoadLatent: [{ input: 'latent', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_load_3d.py — Load3D.image is a dict of annotated names.
  Load3D: [
    { input: 'image', shape: 'dict', keys: ['image', 'mask', 'normal', 'recording'], semantics: 'either' },
    { input: 'model_file', shape: 'string', semantics: 'either' },
  ],
  // comfy_extras/nodes_scene3d.py
  Scene3DStudio: [
    { input: 'beauty_image', shape: 'string', semantics: 'either' },
    { input: 'depth_image', shape: 'string', semantics: 'either' },
    { input: 'normal_image', shape: 'string', semantics: 'either' },
  ],
  // comfy_extras/nodes_pose_mannequin.py
  PoseMannequin: [
    { input: 'result_image', shape: 'string', semantics: 'either' },
    { input: 'pose_cond_image', shape: 'string', semantics: 'either' },
    { input: 'mannequin_image', shape: 'string', semantics: 'either' },
  ],
  // comfy_extras/nodes_compositor.py — motion_params JSON carries the baked
  // frame filenames under `rendered` (a list).
  Compositor: [{ input: 'motion_params', shape: 'json', jsonPath: 'rendered', semantics: 'either' }],
  // comfy_extras type nodes — params JSON carries the uploaded render filename(s)
  // under `rendered` (a string for RenderType/TextMask/TextOnPath, a list for
  // KineticType — extractFileRefs handles both).
  RenderType: [{ input: 'params', shape: 'json', jsonPath: 'rendered', semantics: 'either' }],
  KineticType: [{ input: 'params', shape: 'json', jsonPath: 'rendered', semantics: 'either' }],
  TextMask: [{ input: 'params', shape: 'json', jsonPath: 'rendered', semantics: 'either' }],
  TextOnPath: [{ input: 'params', shape: 'json', jsonPath: 'rendered', semantics: 'either' }],
  // comfy_extras/nodes_image.py — the `Image` node (SaveImage subclass) loads a
  // file from its `image` combo when no upstream image is wired.
  Image: [{ input: 'image', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_video.py
  LoadVideo: [{ input: 'file', shape: 'string', semantics: 'either' }],
  Video: [{ input: 'file', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_video_pro.py
  LUT: [{ input: 'lut_file', shape: 'string', semantics: 'either' }],
  AudioWaveform: [{ input: 'audio_file', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_video_effects.py
  LoadVideoFrames: [{ input: 'file', shape: 'string', semantics: 'either' }],
  SaveVideoFrames: [{ input: 'audio_file', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_audio.py
  Audio: [{ input: 'audio', shape: 'string', semantics: 'either' }],
  LoadAudio: [{ input: 'audio', shape: 'string', semantics: 'either' }],
  RecordAudio: [{ input: 'audio', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_painter.py
  Painter: [{ input: 'mask', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_webcam.py
  WebcamCapture: [{ input: 'image', shape: 'string', semantics: 'either' }],
  // comfy_extras/nodes_timeline.py — the graph node reads image-clip files out
  // of the edit_state JSON via os.path.join(input_dir, path) with NO annotation
  // routing, so semantics is `input` and the literal value is vetted (an
  // absolute path or a foreign subfolder is refused).
  Timeline: [{ input: 'edit_state', shape: 'json', jsonPath: 'timeline-clips', semantics: 'input' }],
  // comfy_api_nodes/nodes_replicate.py — the hidden `style_refs` widget is a
  // moodboard JSON {"folder": "moodboard_<ms>", "files": [...]}; the node reads
  // ≤3 of those files from input/<folder>/ (_moodboard_ref_data_urls). The
  // folder name is a timestamp, so it is guessable — every named file must be
  // the caller's own upload, the same rule the runner applies (runner/inputs.ts).
  GenerateImageNode: [{ input: 'style_refs', shape: 'json', jsonPath: 'moodboard', semantics: 'input' }],
  RestyleFromImageNode: [{ input: 'style_refs', shape: 'json', jsonPath: 'moodboard', semantics: 'input' }],
  // comfy_api_nodes/nodes_replicate.py LipSyncNode — `model_options` is the
  // Lip-Sync Studio's JSON; its face_image / face_video / audio values that are
  // `/view?filename=X&type=input` links are read from the input folder
  // (parse_view_ref, then _local_ref_to_data_url or _lipsync_hosted_media_url).
  // Every named file must be the caller's own. P5 fix round 1: the gate also
  // measures the sound and video lengths from these files to price the run.
  LipSyncNode: [{ input: 'model_options', shape: 'json', jsonPath: 'view-refs', semantics: 'input' }],
  // comfy_api_nodes/nodes_replicate.py FilmShotNode — `model_options` is the
  // Shot Director's JSON; _resolve_local_refs reads every `/view?filename=X&
  // type=input` link under its reference-list and first/last-frame keys
  // (VIDEO_REF_LIST_KEYS / VIDEO_REF_STR_KEYS) from the input folder into a
  // data URL. GenerateVideoNode takes the same `model_options` bag and the
  // same builders; it does not resolve the links today, but it is vetted the
  // same way so a graph cannot name another tenant's file through it either.
  // External https links name no file and pass.
  FilmShotNode: [{ input: 'model_options', shape: 'json', jsonPath: 'video-refs', semantics: 'input' }],
  GenerateVideoNode: [{ input: 'model_options', shape: 'json', jsonPath: 'video-refs', semantics: 'input' }],
}

// ---------------------------------------------------------------------------
// Per-FOLDER readers (Task 7b review Critical).
//
// GRAPH_FILE_READERS models nodes that read a named FILE. A separate class of
// nodes reads a named FOLDER from the shared tree and emits its whole contents
// as node outputs: LoadImageDataSetFromFolder / LoadImageTextDataSetFromFolder
// load EVERY image in input/<folder>/, and LoadTrainingDataset torch.loads
// every shard in output/<folder>/. The `folder`/`folder_name` value is
// attacker-controlled (a hand-built graph is not constrained to the combo the
// schema advertises), so `{folder:"u_<victimhash>"}` → SaveImage would launder
// a cross-tenant read. get_annotated_filepath never appears on these paths, so
// the per-file map and the object_info upload-flag walk both miss them.
//
// These carry FOLDER-level ownership, not per-file: the value must resolve to
// the caller's OWN u_<hash> subtree or the run is refused (see graphFolderOwnedBy).
// ---------------------------------------------------------------------------

/** Which shared tree a folder input is read from. */
export type FolderRefSemantics = 'input' | 'output'

export interface FolderReaderSpec { input: string, semantics: FolderRefSemantics }

/** class_type → folder-valued inputs the engine joins onto a shared tree and reads wholesale. */
export const GRAPH_FOLDER_READERS: Record<string, FolderReaderSpec[]> = {
  // comfy_extras/nodes_dataset.py — os.path.join(get_input_directory(), folder), lists every image.
  LoadImageDataSetFromFolder: [{ input: 'folder', semantics: 'input' }],
  LoadImageTextDataSetFromFolder: [{ input: 'folder', semantics: 'input' }],
  // os.path.join(get_output_directory(), folder_name), torch.loads every shard_*.pkl.
  LoadTrainingDataset: [{ input: 'folder_name', semantics: 'output' }],
}

/**
 * Normalize a graph-supplied folder value to a contained relative path, or
 * `null` when it is unusable/traversing: non-string (wired link, number,
 * object), empty, absolute, drive-letter, or containing a `.`/`..`/empty
 * segment. Backslashes fold to `/` first so `u_x\..\y` cannot slip past the
 * segment check, and a trailing slash is tolerated. `null` MUST fail closed at
 * the caller.
 */
export function normalizeGraphFolder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  if (s === '') return null
  if (s.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(s)) return null
  const segs = s.split('/')
  if (segs.some(seg => seg === '' || seg === '.' || seg === '..')) return null
  return segs.join('/')
}

/**
 * A graph folder reference is owned ONLY when it resolves to the caller's own
 * per-user subtree: exactly `u_<callerHash>` or nested under `u_<callerHash>/`.
 * Any other value — a bare name, another tenant's hash, `..`, absolute, or a
 * wired/absent input — is refused (fail closed).
 *
 * Stage 6 writes per-user OUTPUT under output/u_<hash>/, so for output-semantics
 * folders this equality IS the ownership proof (only the caller's own runs land
 * in their u_<hash> tree). INPUT has no per-user subtree yet (uploads are flat +
 * registry-tracked), so for input-semantics folders this refuses EVERY folder
 * read that isn't the caller's own u_<hash> namespace — effectively refuse-all
 * today, which is the correct fail-closed answer until per-user input
 * subfolders exist.
 */
export function graphFolderOwnedBy(raw: unknown, callerHash: string): boolean {
  if (!callerHash) return false
  const norm = normalizeGraphFolder(raw)
  if (norm === null) return false
  const own = `u_${callerHash}`
  return norm === own || norm.startsWith(`${own}/`)
}

/**
 * Extract the filename(s) a graph node would read from one file input's value.
 *
 * Returns `[]` when the input is absent/empty (no file referenced — leaves
 * zero-file and partial graphs alone), a list of filename strings when it can
 * read them, or `null` when the value is PRESENT but not in the shape we can
 * vet (a wired link, a number, a non-object dict, unparseable JSON, an
 * unexpected `rendered` shape). A `null` means the caller must FAIL CLOSED and
 * refuse — we cannot vet what we cannot read.
 */
export function extractFileRefs(spec: FileReaderSpec, value: unknown): string[] | null {
  if (value === undefined || value === null) return []

  if (spec.shape === 'string') {
    if (typeof value !== 'string') return null
    return value === '' ? [] : [value]
  }

  if (spec.shape === 'dict') {
    if (typeof value !== 'object' || Array.isArray(value)) return null
    const out: string[] = []
    for (const k of spec.keys) {
      const v = (value as Record<string, unknown>)[k]
      if (v === undefined || v === null || v === '') continue
      if (typeof v !== 'string') return null
      out.push(v)
    }
    return out
  }

  // json
  if (typeof value !== 'string') return null
  if (value === '') return []
  // A moodboard payload goes through the runner's port of the engine's own
  // parser (_parse_style_refs), so we vet exactly the files the node would
  // read: a payload the engine would ignore (bad folder, no image files) reads
  // nothing and names nothing. Each file is `<folder>/<name>`, which the
  // caller's input-ownership check splits back into canonicalUploadKey's
  // (subfolder, filename) — the key the moodboard upload route records.
  if (spec.jsonPath === 'moodboard') {
    return moodboardFiles(value).map(f => `${f.subfolder}/${f.filename}`)
  }
  if (spec.jsonPath === 'view-refs') return lipSyncViewRefs(value)
  if (spec.jsonPath === 'video-refs') return videoModelViewRefs(value)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return spec.jsonPath === 'rendered' ? collectRendered(parsed) : collectTimelineClips(parsed)
}

/** The `rendered` field of a params/motion blob: a string or a list of strings. */
function collectRendered(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const r = (parsed as Record<string, unknown>).rendered
  if (r === undefined || r === null || r === '') return []
  if (typeof r === 'string') return [r]
  if (Array.isArray(r)) {
    const out: string[] = []
    for (const el of r) {
      if (el === undefined || el === null || el === '') continue
      // The engine does str(el) and reads it — a non-string element is an
      // anomaly we cannot vet, so refuse rather than guess.
      if (typeof el !== 'string') return null
      out.push(el)
    }
    return out
  }
  return null
}

// ---------------------------------------------------------------------------
// GRAPH_OUTPUT_WRITERS (Task 7c) — which INPUT FIELD carries a writer node's
// output path, for the per-user subfolder injection in meterGraphRun.ts.
//
// Task 7/7b's injectOutputSubfolder only ever rewrote `filename_prefix`,
// which is right for every member of OUTPUT_CLASS_TYPES (verified against
// each handler — nodes.py SaveImage/SaveLatent/PreviewImage, nodes_image.py
// Image, nodes_video.py SaveWEBM/SaveVideo/Video, nodes_video_effects.py
// SaveVideoFrames, nodes_audio.py SaveAudio/SaveAudioMP3/SaveAudioOpus/Audio,
// nodes_hunyuan3d.py SaveGLB, nodes_lora_extract.py LoraSave,
// nodes_model_merging.py CheckpointSave/CLIPSave/VAESave/ModelSave,
// nodes_images.py SaveSVGNode/SaveAnimatedWEBP/SaveAnimatedPNG — every one of
// these calls folder_paths.get_save_image_path(filename_prefix, ...), so the
// OUTPUT_CLASS_TYPES-derived portion below is built FROM that set, not
// hand-duplicated: a class added to OUTPUT_CLASS_TYPES is automatically a
// filename_prefix writer here too.
//
// But three write sites place their output through a DIFFERENT field, so the
// old single-field assumption silently skipped them:
//   - SaveLoRA (comfy_extras/nodes_train.py) takes `prefix`, not
//     filename_prefix — routed through the SAME folder_paths.get_save_image_path
//     containment check as the family above, just a different input name.
//   - SaveImageDataSetToFolder / SaveImageTextDataSetToFolder / SaveTrainingDataset
//     (comfy_extras/nodes_dataset.py) take `folder_name`, joined onto
//     get_output_directory() with `os.path.join` and NO commonpath check
//     (folder_paths.get_save_image_path is never called) — `folder_name` set
//     to `../..` writes OUTSIDE the output root entirely (the MOST SERIOUS
//     Task 7c finding, verified at nodes_dataset.py:237).
// Preview3D (comfy_extras/nodes_load_3d.py:110-111) writes a random
// `preview3d_<uuid>.<ext>` filename straight to the output root — there is no
// client-controllable path field to rewrite, so its entry is `null` (see the
// matching WRITE_EXEMPT reason in engine-file-surface.unit.spec.ts).
export const GRAPH_OUTPUT_WRITERS: Record<string, string | null> = {
  ...Object.fromEntries([...OUTPUT_CLASS_TYPES].map(ct => [ct, 'filename_prefix'])),
  SaveLoRA: 'prefix',
  SaveImageDataSetToFolder: 'folder_name',
  SaveImageTextDataSetToFolder: 'folder_name',
  SaveTrainingDataset: 'folder_name',
  Preview3D: null,
}

/** Timeline edit_state: image-clip file paths under tracks[].clips[].path / .asset_path. */
function collectTimelineClips(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const tracks = (parsed as Record<string, unknown>).tracks
  if (tracks === undefined || tracks === null) return []
  if (!Array.isArray(tracks)) return null
  const out: string[] = []
  for (const t of tracks) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue
    const clips = (t as Record<string, unknown>).clips
    if (clips === undefined || clips === null) continue
    if (!Array.isArray(clips)) return null
    for (const c of clips) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue
      for (const key of ['path', 'asset_path']) {
        const v = (c as Record<string, unknown>)[key]
        if (v === undefined || v === null || v === '') continue
        if (typeof v !== 'string') return null
        out.push(v)
      }
    }
  }
  return out
}

/**
 * The input files a LipSyncNode `model_options` JSON makes the engine read:
 * each of face_image / face_video / audio that is a `/view?…&type=input` link
 * (parse_view_ref). Not a JSON object: nothing (the node reads `{}`).
 * Unparseable: null, refused — we cannot vet what we cannot read.
 */
function lipSyncViewRefs(value: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const out: string[] = []
  for (const k of ['face_image', 'face_video', 'audio']) {
    const name = parseViewRef((parsed as Record<string, unknown>)[k])
    if (name) out.push(name)
  }
  return out
}

/** nodes_replicate._LOCAL_REF_LIST_KEYS / _LOCAL_REF_STR_KEYS (Replicate, then fal). */
export const VIDEO_REF_LIST_KEYS = ['reference_images', 'reference_videos', 'reference_audios', 'image_urls', 'video_urls', 'audio_urls'] as const
export const VIDEO_REF_STR_KEYS = ['image', 'last_frame_image', 'image_url', 'end_image_url'] as const

/**
 * The input files a video model's `model_options` JSON makes the engine read,
 * as _resolve_local_refs walks it: each list key's elements and each string
 * key's value that is a `/view?…&type=input` link (parse_view_ref). A list key
 * that is not a list, or an element that is not a link, is passed through
 * untouched by the engine and names no file. Not a JSON object: nothing.
 * Unparseable: null, refused — we cannot vet what we cannot read.
 */
function videoModelViewRefs(value: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const opts = parsed as Record<string, unknown>
  const out: string[] = []
  for (const k of VIDEO_REF_LIST_KEYS) {
    const vals = opts[k]
    if (!Array.isArray(vals)) continue
    for (const v of vals) {
      const name = parseViewRef(v)
      if (name) out.push(name)
    }
  }
  for (const k of VIDEO_REF_STR_KEYS) {
    const name = parseViewRef(opts[k])
    if (name) out.push(name)
  }
  return out
}
