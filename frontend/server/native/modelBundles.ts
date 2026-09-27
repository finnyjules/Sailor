/**
 * GET /sailor/models/status, served by Sailor instead of ComfyUI — a port of
 * `bundle_status` (comfy_extras/_model_downloads.py) and of the bundle
 * registry the ML node modules fill at import time. It only looks at the
 * disk: which of a bundle's files are present at their expected size, or,
 * for a library-managed bundle, whether that library's cache holds the
 * model — the same checks as each module's `ready_check_fn`.
 *
 * The registry below is the Python's, transcribed: same keys, labels, file
 * names, sizes and folders (`folder_paths.models_dir` = `<engine root>/models`;
 * `get_folder_paths(x)[0]` for the LoRA bases — checkpoints, unet, vae,
 * text_encoders). `/sailor/models/download` is not ported: it needs the
 * engine's downloader and stays with ComfyUI.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDir, isFile, listdir } from './paths'

export interface ModelFile { name: string, path: string, size: number }
export interface ModelBundle {
  key: string
  label: string
  files: ModelFile[]
  /** A library-managed bundle: this decides readiness on its own. */
  readyCheck?: () => boolean
}

/** Where the registry looks: the engine's models/ folder, the user's home and environment. */
export interface BundleEnv {
  modelsDir: string
  home: string
  env: Record<string, string | undefined>
}

export function defaultBundleEnv(modelsDir: string): BundleEnv {
  return { modelsDir, home: process.env.HOME || os.homedir(), env: process.env }
}

/** The bundles every ML module registers, in registration order. */
export function modelBundles(e: BundleEnv): ModelBundle[] {
  const m = (...p: string[]) => path.join(e.modelsDir, ...p)
  const one = (key: string, label: string, name: string, file: string, size: number): ModelBundle =>
    ({ key, label, files: [{ name, path: file, size }] })

  // nodes_audio_ml.py
  const whisperReady = () => {
    const cacheRoot = m('whisper', 'models--Systran--faster-whisper-base')
    if (!isDir(cacheRoot)) return false
    const snapshots = path.join(cacheRoot, 'snapshots')
    if (!isDir(snapshots)) return false
    return listdir(snapshots).some(rev => isFile(path.join(snapshots, rev, 'model.bin')))
  }
  const demucsReady = () => {
    for (const d of [m('demucs', 'hub', 'checkpoints'), path.join(e.home, '.cache', 'torch', 'hub', 'checkpoints')]) {
      if (isDir(d) && listdir(d).some(f => f.endsWith('.th'))) return true
    }
    return false
  }
  // _depth.py — the HuggingFace hub cache, honouring HUGGINGFACE_HUB_CACHE / HF_HOME.
  const depthReady = () => {
    const hub = e.env.HUGGINGFACE_HUB_CACHE
      || (e.env.HF_HOME ? path.join(e.env.HF_HOME, 'hub') : path.join(e.home, '.cache', 'huggingface', 'hub'))
    const root = path.join(hub, 'models--depth-anything--Depth-Anything-V2-Small-hf', 'snapshots')
    if (!isDir(root)) return false
    return listdir(root).some(rev => listdir(path.join(root, rev)).some(f => f.endsWith('.safetensors') || f.endsWith('.bin')))
  }

  return [
    one('objectremove', 'Object Removal', 'lama_fp32.onnx', m('lama', 'lama_fp32.onnx'), 205_653_341),
    {
      key: 'subjecttrack',
      label: 'Subject Mask',
      files: [
        { name: 'mobile_sam.encoder.onnx', path: m('sam', 'mobile_sam.encoder.onnx'), size: 0 },
        { name: 'mobile_sam.decoder.onnx', path: m('sam', 'mobile_sam.decoder.onnx'), size: 0 },
      ],
    },
    one('upscale', 'Upscale', 'RealESRGAN_x2plus.pth', m('upscale_models', 'RealESRGAN_x2plus.pth'), 67_061_725),
    one('frameinterp', 'AI Slow Motion', 'rife_v4.6.onnx', m('rife', 'rife_v4.6.onnx'), 0),
    { key: 'whisper', label: 'Speech Transcribe', files: [], readyCheck: whisperReady },
    { key: 'demucs', label: 'Vocal Separator', files: [], readyCheck: demucsReady },
    // nodes_bg_remove.py — rembg's own default home, so a manual rembg install finds it too.
    one('bgremove', 'Background Remove', 'isnet-general-use.onnx', path.join(e.home, '.u2net', 'isnet-general-use.onnx'), 178_648_008),
    { key: 'depth', label: 'Depth (Lens)', files: [], readyCheck: depthReady },
    // _lora_training.py
    one('lora-base-sdxl', 'SDXL Base 1.0', 'sd_xl_base_1.0.safetensors', m('checkpoints', 'sd_xl_base_1.0.safetensors'), 6_938_078_334),
    one('lora-base-sd15', 'Stable Diffusion 1.5', 'v1-5-pruned-emaonly.safetensors', m('checkpoints', 'v1-5-pruned-emaonly.safetensors'), 4_265_146_304),
    {
      key: 'lora-base-flux-schnell',
      label: 'Flux.1 Schnell',
      files: [
        { name: 'flux1-schnell.safetensors', path: m('unet', 'flux1-schnell.safetensors'), size: 23_782_506_688 },
        { name: 'ae.safetensors', path: m('vae', 'ae.safetensors'), size: 335_304_388 },
        { name: 'clip_l.safetensors', path: m('text_encoders', 'clip_l.safetensors'), size: 246_144_152 },
        { name: 't5xxl_fp8_e4m3fn.safetensors', path: m('text_encoders', 't5xxl_fp8_e4m3fn.safetensors'), size: 4_893_934_904 },
      ],
    },
  ]
}

/** `_present(f)`: on disk, at the declared size — or just non-empty when the size is unknown (0). */
function present(f: ModelFile): boolean {
  let st: fs.Stats
  try { st = fs.statSync(f.path) }
  catch { return false }
  if (!st.isFile()) return false
  return f.size > 0 ? st.size === f.size : st.size > 0
}

/** `bundle_status(key)` */
export function bundleStatus(e: BundleEnv, key: string): Record<string, unknown> {
  const bundle = modelBundles(e).find(b => b.key === key)
  if (!bundle) return { ready: false, missing: [], total_size: 0, error: `unknown bundle '${key}'` }
  const total = bundle.files.reduce((sum, f) => sum + Math.max(f.size, 0), 0)
  if (bundle.readyCheck) {
    let ready = false
    try { ready = Boolean(bundle.readyCheck()) }
    catch { ready = false }
    return {
      ready,
      missing: ready ? [] : [{ name: bundle.label, size: total }],
      total_size: total,
      label: bundle.label,
    }
  }
  const missing = bundle.files.filter(f => !present(f)).map(f => ({ name: f.name, size: f.size }))
  return { ready: missing.length === 0, missing, total_size: total, label: bundle.label }
}
