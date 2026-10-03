/**
 * Stage 6 Task 7b — engine file-surface coverage guards.
 *
 * These used to read the Python engine tree at TEST time and FAIL ON DRIFT, so
 * a newly-added file-reading or file-writing node failed the suite instead of
 * silently bypassing the per-user ownership checks. Python left the repo in
 * step 4, C7: the per-file tables below are the frozen record of the engine's
 * read and write sites as they stood then, and the guards check Sailor's own
 * maps against them:
 *
 *  (A) every directory-read PRIMITIVE site — get_annotated_filepath (per-file)
 *      AND get_(input|output|temp)_directory (the per-FOLDER readers) — is
 *      accounted for: its file's node(s) are a per-file reader in
 *      GRAPH_FILE_READERS, a per-folder reader in GRAPH_FOLDER_READERS, or the
 *      remaining hits are documented in a per-file `note`.
 *  (B) every `folder_paths.get_output_directory(` write site's node is in
 *      OUTPUT_CLASS_TYPES (so its output is subfoldered under u_<hash>/) or on
 *      the explicit write-exempt list. Deliverable savers that delegate to a UI
 *      helper (no get_output_directory in-file) are enumerated separately and
 *      asserted present in OUTPUT_CLASS_TYPES.
 */
import { describe, expect, it } from 'vitest'
import { GRAPH_FILE_READERS, GRAPH_FOLDER_READERS, GRAPH_OUTPUT_WRITERS, VIDEO_REF_LIST_KEYS, VIDEO_REF_STR_KEYS } from '../../server/utils/engineFileSurface'
import { OUTPUT_CLASS_TYPES } from '../../server/utils/priceBook'

// ---------------------------------------------------------------------------
// (A) READ surface — the FULL directory-read primitive set, not just
// get_annotated_filepath: the per-FOLDER readers (LoadImageDataSetFromFolder
// etc., which reached the shared tree via get_input_directory /
// get_output_directory) are modeled too. The counts were every real call site
// of get_annotated_filepath and get_(input|output|temp)_directory across
// comfy_extras/, custom_nodes/ and nodes.py, frozen at C7.
// ---------------------------------------------------------------------------

/**
 * Per file: `count` = the widened directory-primitive hit total (drift guard),
 * `annotated` = the get_annotated_filepath-only subset (kept precise so the
 * original per-file read map still self-checks), `readers` = per-FILE graph
 * readers (must be in GRAPH_FILE_READERS), `folderReaders` = per-FOLDER graph
 * readers (must be in GRAPH_FOLDER_READERS), and `note` documents every hit that
 * is NOT a graph file/folder read — REQUIRED whenever `count !== annotated`, i.e.
 * whenever a file carries directory hits beyond its annotated per-file readers
 * (schema-build listings, temp/mkdir staging, output writes already covered by
 * guard B, or HTTP-route helpers).
 */
type ReadFileEntry = { count: number, annotated: number, readers: string[], folderReaders?: string[], note?: string }
const READ_SURFACE_FILES: Record<string, ReadFileEntry> = {
  'nodes.py': {
    count: 12, annotated: 6, readers: ['LoadLatent', 'LoadImage', 'LoadImageMask'],
    note: 'the 6 non-annotated hits are SaveLatent/SaveImage get_output_directory writes (guard B), a temp preview dir, and get_input_directory schema listings for the Load* combos — none a graph file read.',
  },
  'comfy_extras/nodes_compositor.py': {
    count: 2, annotated: 1, readers: ['Compositor'],
    // Task 7c cosmetic fix: the non-annotated hit is _cleanup_motion_frames
    // (nodes_compositor.py:581), an aiohttp route handler registered at
    // POST /sailor/motion/cleanup_frames — NOT a schema listing. It deletes
    // bare, pattern-matching slate frames from the input/ ROOT only (no
    // subfolders, no traversal), gated like the rest of /sailor in engineGate.ts.
    note: 'plus one get_input_directory hit in _cleanup_motion_frames, the POST /sailor/motion/cleanup_frames route handler (not a graph node).',
  },
  'comfy_extras/nodes_kinetic_type.py': { count: 1, annotated: 1, readers: ['KineticType'] },
  'comfy_extras/nodes_pose_mannequin.py': { count: 1, annotated: 1, readers: ['PoseMannequin'] },
  'comfy_extras/nodes_scene3d.py': { count: 1, annotated: 1, readers: ['Scene3DStudio'] },
  'comfy_extras/nodes_text_mask.py': { count: 1, annotated: 1, readers: ['TextMask'] },
  'comfy_extras/nodes_text_on_path.py': { count: 1, annotated: 1, readers: ['TextOnPath'] },
  'comfy_extras/nodes_type.py': { count: 1, annotated: 1, readers: ['RenderType'] },
  'comfy_extras/nodes_webcam.py': { count: 1, annotated: 1, readers: ['WebcamCapture'] },
  'comfy_extras/nodes_image.py': {
    count: 5, annotated: 2, readers: ['Image'],
    note: 'plus a temp output_dir, an export get_output_directory, and a get_input_directory schema listing for the Image node — setup/listing, not graph reads.',
  },
  'comfy_extras/nodes_painter.py': { count: 2, annotated: 2, readers: ['Painter'] },
  'comfy_extras/nodes_video_pro.py': {
    count: 4, annotated: 2, readers: ['LUT', 'AudioWaveform'],
    note: 'plus two get_input_directory schema listings (LUT / AudioWaveform combos).',
  },
  'comfy_extras/nodes_video_effects.py': {
    count: 6, annotated: 3, readers: ['LoadVideoFrames', 'SaveVideoFrames'],
    note: 'plus two get_input_directory schema listings and one get_output_directory write (SaveVideoFrames, guard B).',
  },
  'comfy_extras/nodes_video.py': {
    count: 11, annotated: 4, readers: ['LoadVideo', 'Video'],
    note: 'plus get_output_directory writes (SaveWEBM/SaveVideo/Video, guard B), temp-dir staging, and get_input_directory schema listings.',
  },
  'comfy_extras/nodes_audio.py': {
    count: 7, annotated: 5, readers: ['Audio', 'LoadAudio', 'RecordAudio'],
    note: 'plus two get_input_directory schema listings (audio combos).',
  },
  'comfy_extras/nodes_load_3d.py': {
    count: 8, annotated: 5, readers: ['Load3D'],
    note: 'plus two get_input_directory schema listings (3d subdir) and one get_output_directory write (Preview3D, guard B / write-exempt).',
  },
  'comfy_extras/nodes_timeline.py': {
    count: 18, annotated: 1, readers: [],
    note: 'encode_spacetype_video is an HTTP-route helper (POST /sailor/spacetype_encode), not a graph node. The Timeline GRAPH node reads image clips via os.path.join(get_input_directory(), path) — modeled in GRAPH_FILE_READERS as a timeline-clips JSON reader (NON_ANNOTATED_READERS). ebffd64ae added a second such join in _prepare_render_clips (bare video/image clip filenames now resolve under input/ the same way the spacetype/motion bake paths already did) — same modeled read, one more call site. The remaining get_input_directory / get_output_directory hits are all aiohttp route handlers (/sailor/render_timeline*, /sailor/output_file, …) gated in engineGate.ts.',
  },
  // Task 7b Critical — the three per-FOLDER readers. NOT annotated per-file
  // refs, so they never appear in the annotated subset; each reads a whole
  // attacker-named folder from the shared tree and is now vetted via
  // GRAPH_FOLDER_READERS.
  'comfy_extras/nodes_dataset.py': {
    count: 6, annotated: 0, readers: [],
    folderReaders: ['LoadImageDataSetFromFolder', 'LoadImageTextDataSetFromFolder', 'LoadTrainingDataset'],
    note: 'the three folder-reader inputs are the get_input_directory (x2, LoadImage*DataSetFromFolder) + get_output_directory (x1, LoadTrainingDataset) reads modeled in GRAPH_FOLDER_READERS; the other three get_output_directory hits are dataset WRITES (SaveImageDataSetToFolder / SaveImageTextDataSetToFolder / SaveTrainingDataset, guard B write-exempt).',
  },
  // Pure non-graph-read files (annotated 0) — writes covered by guard B, or
  // helper / mkdir staging.
  'comfy_extras/_live_preview.py': {
    count: 4, annotated: 0, readers: [],
    note: 'shared preview helper — temp/output/input dir setup + mkdir, no graph node.',
  },
  'comfy_extras/_lora_training.py': {
    count: 1, annotated: 0, readers: [],
    note: 'training helper reads get_input_directory for dataset staging — invoked by SaveTrainingDataset, not a registered graph node.',
  },
  'comfy_extras/nodes_hunyuan3d.py': {
    count: 1, annotated: 0, readers: [],
    note: 'get_output_directory write via get_save_image_path (SaveGLB, guard B).',
  },
  'comfy_extras/nodes_images.py': {
    count: 1, annotated: 0, readers: [],
    note: 'get_output_directory write via get_save_image_path (SaveSVGNode, guard B).',
  },
  'comfy_extras/nodes_lora_extract.py': {
    count: 1, annotated: 0, readers: [],
    note: 'get_output_directory write via get_save_image_path (LoraSave, guard B / write-exempt).',
  },
  'comfy_extras/nodes_model_merging.py': {
    count: 4, annotated: 0, readers: [],
    note: 'four get_output_directory writes (CheckpointSave / CLIPSave / VAESave / ModelSave, guard B).',
  },
  'comfy_extras/nodes_smart_layout.py': {
    count: 1, annotated: 0, readers: [],
    note: 'get_temp_directory staging for a preview — not a shared-tree read.',
  },
  'comfy_extras/nodes_train.py': {
    count: 1, annotated: 0, readers: [],
    note: 'get_output_directory write (SaveLoRA, guard B / write-exempt).',
  },
}

/**
 * Graph readers whose read site is NOT a get_annotated_filepath call in their
 * own file, so they never appear as an annotated reader: LoadImageOutput
 * inherits LoadImage.load_image, and Timeline reads image clips via
 * os.path.join(get_input_directory(), path) (nodes_timeline.py).
 * GenerateImageNode / RestyleFromImageNode read their moodboard `style_refs`
 * files via os.path.join(get_input_directory(), folder, name) in
 * comfy_api_nodes/nodes_replicate.py (_moodboard_ref_data_urls) — outside the
 * walked roots, so that read site is pinned by its own test below.
 */
const NON_ANNOTATED_READERS = ['LoadImageOutput', 'Timeline', 'GenerateImageNode', 'RestyleFromImageNode', 'LipSyncNode', 'FilmShotNode', 'GenerateVideoNode']

describe('coverage guard (A) — every engine file-READ site is accounted for', () => {
  it('every per-FILE reader named in a read-file entry is in GRAPH_FILE_READERS', () => {
    for (const [file, { readers }] of Object.entries(READ_SURFACE_FILES)) {
      for (const n of readers) {
        expect(GRAPH_FILE_READERS[n], `${n} (from ${file}) must be in GRAPH_FILE_READERS`).toBeDefined()
      }
    }
  })

  it('every per-FOLDER reader named in a read-file entry is in GRAPH_FOLDER_READERS', () => {
    for (const [file, { folderReaders }] of Object.entries(READ_SURFACE_FILES)) {
      for (const n of folderReaders ?? []) {
        expect(GRAPH_FOLDER_READERS[n], `${n} (from ${file}) must be in GRAPH_FOLDER_READERS`).toBeDefined()
      }
    }
  })

  it('every GRAPH_FILE_READERS class is backed by a real read site (no orphan map entry)', () => {
    const backed = new Set<string>(NON_ANNOTATED_READERS)
    for (const { readers } of Object.values(READ_SURFACE_FILES)) for (const n of readers) backed.add(n)
    for (const ct of Object.keys(GRAPH_FILE_READERS)) {
      expect(backed.has(ct), `${ct} is in GRAPH_FILE_READERS but has no documented read site`).toBe(true)
    }
  })

  // FilmShotNode's model_options `/view?filename=X&type=input` links were read from the
  // input folder by _resolve_local_refs over two key lists (nodes_replicate.py, frozen
  // at C7); the gate walks the same lists.
  it('the view-ref keys the FilmShotNode / GenerateVideoNode entries model are the Python\'s', () => {
    expect([...VIDEO_REF_LIST_KEYS]).toEqual(['reference_images', 'reference_videos', 'reference_audios', 'image_urls', 'video_urls', 'audio_urls'])
    expect([...VIDEO_REF_STR_KEYS]).toEqual(['image', 'last_frame_image', 'image_url', 'end_image_url'])
  })

  it('every GRAPH_FOLDER_READERS class is backed by a documented folder-read site (no orphan map entry)', () => {
    const backed = new Set<string>()
    for (const { folderReaders } of Object.values(READ_SURFACE_FILES)) for (const n of folderReaders ?? []) backed.add(n)
    for (const ct of Object.keys(GRAPH_FOLDER_READERS)) {
      expect(backed.has(ct), `${ct} is in GRAPH_FOLDER_READERS but has no documented folder-read site`).toBe(true)
    }
  })

  it('any file with directory hits beyond its annotated per-file readers carries a note explaining them', () => {
    for (const [file, v] of Object.entries(READ_SURFACE_FILES)) {
      if (v.count !== v.annotated) {
        expect(v.note, `${file} has ${v.count - v.annotated} non-annotated directory hit(s) and must document them`).toBeTruthy()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// (B) WRITE surface — folder_paths.get_output_directory(
// ---------------------------------------------------------------------------

/**
 * Every file with a get_output_directory site, its count, and the class_type(s)
 * that write there. Each writer node must be in OUTPUT_CLASS_TYPES (so its
 * output is subfoldered) or in WRITE_EXEMPT. Files whose hits are HTTP routes /
 * shared helpers list no writer nodes and carry a note.
 */
const OUTPUT_DIR_FILES: Record<string, { count: number, writers: string[], note?: string }> = {
  'nodes.py': { count: 2, writers: ['SaveLatent', 'SaveImage'] },
  'comfy_extras/nodes_video.py': { count: 3, writers: ['SaveWEBM', 'SaveVideo', 'Video'] },
  'comfy_extras/nodes_video_effects.py': { count: 1, writers: ['SaveVideoFrames'] },
  'comfy_extras/nodes_image.py': { count: 1, writers: ['Image'] },
  'comfy_extras/nodes_load_3d.py': { count: 1, writers: ['Preview3D'] },
  'comfy_extras/nodes_hunyuan3d.py': { count: 1, writers: ['SaveGLB'] },
  'comfy_extras/nodes_lora_extract.py': { count: 1, writers: ['LoraSave'] },
  'comfy_extras/nodes_train.py': { count: 1, writers: ['SaveLoRA'] },
  'comfy_extras/nodes_images.py': { count: 1, writers: ['SaveSVGNode'] },
  'comfy_extras/nodes_model_merging.py': { count: 4, writers: ['CheckpointSave', 'CLIPSave', 'VAESave', 'ModelSave'] },
  'comfy_extras/nodes_dataset.py': {
    count: 4,
    writers: ['SaveImageDataSetToFolder', 'SaveImageTextDataSetToFolder', 'SaveTrainingDataset', 'LoadTrainingDataset'],
  },
  'comfy_extras/nodes_timeline.py': {
    count: 4, writers: [],
    note: 'all four are aiohttp route handlers (POST /sailor/render_timeline*, DELETE /sailor/output_file) — '
      + 'not graph nodes; per-tenant gating for those routes lives in engineGate.ts.',
  },
  'comfy_extras/_live_preview.py': {
    count: 1, writers: [],
    note: 'save_generation_output is a shared preview helper writing a fixed "generation" prefix (no graph filename_prefix input) — '
      + 'per-user subfoldering of helper output is a follow-up.',
  },
}

/**
 * Writer nodes whose output is NOT subfoldered by the filename_prefix injection
 * (so they are deliberately kept OUT of OUTPUT_CLASS_TYPES) — plus one reader
 * that lives in an output-dir file. Each carries the reason it is exempt.
 */
const WRITE_EXEMPT: Record<string, string> = {
  Preview3D: 'writes a random-uuid filename directly to the output root (no client-controllable path field); cannot clobber another tenant. GRAPH_OUTPUT_WRITERS.Preview3D is null — nothing to rewrite.',
  // Task 7c: these three write via a field OTHER than filename_prefix, so they
  // stay OUT of OUTPUT_CLASS_TYPES (pricing's "what writes a deliverable" set
  // is unchanged) but are now subfoldered via GRAPH_OUTPUT_WRITERS's own
  // field entry — SaveLoRA.prefix / *DataSetToFolder+SaveTrainingDataset.folder_name.
  SaveLoRA: 'writes via a `prefix` input, not `filename_prefix` — now subfoldered through GRAPH_OUTPUT_WRITERS.SaveLoRA = "prefix" (Task 7c), kept out of OUTPUT_CLASS_TYPES since that set is filename_prefix-specific.',
  SaveImageDataSetToFolder: 'writes into output/<folder_name>/ via a `folder_name` input with NO commonpath containment (nodes_dataset.py:237) — now subfoldered + traversal-neutralized through GRAPH_OUTPUT_WRITERS.SaveImageDataSetToFolder = "folder_name" (Task 7c).',
  SaveImageTextDataSetToFolder: 'writes into output/<folder_name>/ via a `folder_name` input with NO commonpath containment — now subfoldered + traversal-neutralized through GRAPH_OUTPUT_WRITERS.SaveImageTextDataSetToFolder = "folder_name" (Task 7c).',
  SaveTrainingDataset: 'writes shards into output/<folder_name>/ via a `folder_name` input with NO commonpath containment — now subfoldered + traversal-neutralized through GRAPH_OUTPUT_WRITERS.SaveTrainingDataset = "folder_name" (Task 7c).',
  LoadTrainingDataset: 'READER, not a writer: reads shards from output/<folder_name>/ (a folder, not a per-file annotated ref) — modeled in GRAPH_FOLDER_READERS, not GRAPH_OUTPUT_WRITERS. Folder-level ownership on read is unaffected by this task.',
}

/**
 * Deliverable savers that DELEGATE their write to a UI helper (UI.ImageSaveHelper
 * / UI.AudioSaveHelper) and so carry no get_output_directory in their own file —
 * invisible to the grep above. Enumerated by hand and asserted present in
 * OUTPUT_CLASS_TYPES so they are still subfoldered.
 */
const HELPER_WRITER_NODES = ['SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'Audio']

describe('coverage guard (B) — every engine file-WRITE site is subfoldered or exempt', () => {
  it('every writer node is in OUTPUT_CLASS_TYPES or on the write-exempt list', () => {
    for (const [file, { writers }] of Object.entries(OUTPUT_DIR_FILES)) {
      for (const w of writers) {
        const known = OUTPUT_CLASS_TYPES.has(w) || w in WRITE_EXEMPT
        expect(known, `${w} (from ${file}) must be in OUTPUT_CLASS_TYPES or WRITE_EXEMPT`).toBe(true)
      }
    }
  })

  it('a write-file entry with no writer nodes carries a note explaining why', () => {
    for (const [file, v] of Object.entries(OUTPUT_DIR_FILES)) {
      if (v.writers.length === 0) expect(v.note, `${file} has no writer nodes and must document why`).toBeTruthy()
    }
  })

  it('helper-delegated deliverable savers are all in OUTPUT_CLASS_TYPES', () => {
    for (const n of HELPER_WRITER_NODES) {
      expect(OUTPUT_CLASS_TYPES.has(n), `${n} delegates its write to a UI helper and must be subfoldered`).toBe(true)
    }
  })

  it('every write-exempt entry documents a reason', () => {
    for (const [n, reason] of Object.entries(WRITE_EXEMPT)) {
      expect(reason.length, `${n} exemption needs a reason`).toBeGreaterThan(10)
    }
  })
})

// ---------------------------------------------------------------------------
// (C) Task 7c — every writer node has a declared OUTPUT-PATH FIELD, not just
// OUTPUT_CLASS_TYPES membership. GRAPH_OUTPUT_WRITERS is the field-level map
// injectOutputSubfolder walks; a save node absent from it entirely (not even
// a documented `null`) would silently skip per-user subfoldering the same way
// the pre-Task-7c single-field assumption did for SaveLoRA/the dataset savers.
// ---------------------------------------------------------------------------

describe('coverage guard (C) — every writer node has a GRAPH_OUTPUT_WRITERS field entry', () => {
  it('every class in OUTPUT_CLASS_TYPES has a GRAPH_OUTPUT_WRITERS entry', () => {
    for (const ct of OUTPUT_CLASS_TYPES) {
      expect(ct in GRAPH_OUTPUT_WRITERS, `${ct} (in OUTPUT_CLASS_TYPES) must have a GRAPH_OUTPUT_WRITERS entry`).toBe(true)
    }
  })

  it('every writer from OUTPUT_DIR_FILES is declared in GRAPH_OUTPUT_WRITERS (field or documented null)', () => {
    for (const [file, { writers }] of Object.entries(OUTPUT_DIR_FILES)) {
      for (const w of writers) {
        // LoadTrainingDataset is a READER caught by the get_output_directory
        // grep (it reads shards FROM output/<folder_name>/, not a write site)
        // — modeled in GRAPH_FOLDER_READERS, out of scope for this map.
        if (w === 'LoadTrainingDataset') continue
        expect(w in GRAPH_OUTPUT_WRITERS, `${w} (from ${file}) must be in GRAPH_OUTPUT_WRITERS`).toBe(true)
      }
    }
  })

  it('a GRAPH_OUTPUT_WRITERS entry is either a non-empty field name or a documented-null exemption', () => {
    for (const [ct, field] of Object.entries(GRAPH_OUTPUT_WRITERS)) {
      if (field === null) {
        expect(ct in WRITE_EXEMPT, `${ct} has a null GRAPH_OUTPUT_WRITERS entry and must document why in WRITE_EXEMPT`).toBe(true)
      }
      else {
        expect(typeof field === 'string' && field.length > 0, `${ct}'s GRAPH_OUTPUT_WRITERS field must be a non-empty string or null`).toBe(true)
      }
    }
  })

  it('SaveLoRA / the dataset savers carry their VERIFIED path field (not filename_prefix)', () => {
    expect(GRAPH_OUTPUT_WRITERS.SaveLoRA).toBe('prefix')
    expect(GRAPH_OUTPUT_WRITERS.SaveImageDataSetToFolder).toBe('folder_name')
    expect(GRAPH_OUTPUT_WRITERS.SaveImageTextDataSetToFolder).toBe('folder_name')
    expect(GRAPH_OUTPUT_WRITERS.SaveTrainingDataset).toBe('folder_name')
    expect(GRAPH_OUTPUT_WRITERS.Preview3D).toBeNull()
  })
})
