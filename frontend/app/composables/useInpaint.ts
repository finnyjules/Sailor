/**
 * Client helpers for the Compositor inpainting feature: talk to the
 * /api/inpaint/* routes, plus the image plumbing (load → cap → data URL, and
 * re-upload a result into ComfyUI's input dir so it can become an image layer).
 *
 * Geometry (where the mask sits on the artboard) lives in the Compositor, which
 * owns the layer transforms; this composable stays transform-agnostic.
 */

export interface FluxFillOpts {
  tier?: 'dev' | 'pro'
  /** Masked-inpaint model: 'flux' (FLUX.1 Fill), 'flux-general' (FLUX general
   *  inpainting), 'qwen' (Qwen Image Edit inpaint). Omit for the tier default. */
  model?: string
  count?: number
  guidance?: number
  steps?: number
  seed?: number
}

/** Load an image URL (same-origin /view URLs or data URLs) to an HTMLImageElement. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error(`Could not load image: ${url}`))
    im.src = url
  })
}

/** Cap (w,h) so the longest side ≤ max, preserving aspect. Controls model cost. */
export function capDims(w: number, h: number, max = 1536): { w: number; h: number } {
  const longest = Math.max(w, h)
  if (longest <= max) return { w: Math.round(w), h: Math.round(h) }
  const k = max / longest
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/** Draw an image into a w×h canvas and return a PNG data URL. */
export function imageToDataUrl(img: HTMLImageElement, w: number, h: number): string {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h))
  const ctx = cv.getContext('2d')!
  ctx.drawImage(img, 0, 0, cv.width, cv.height)
  return cv.toDataURL('image/png')
}

/**
 * Clean a cutout's alpha IN PLACE (pure pixel op, no DOM — unit-testable).
 *
 * Cloud background removers (851-labs) often leave a faint translucent HAZE of
 * leftover background — low-alpha pixels far from the subject (e.g. a corner
 * blob) that read as an ugly rectangular fragment when placed. We keep the
 * solid subject (the large connected components of alpha ≥ `core`), grow that
 * region by `grow` px to retain the subject's own soft edges, and zero alpha
 * everywhere else. Returns the tight bbox of what survives (or null if empty).
 *
 * `data` is RGBA (length w*h*4); only the alpha bytes are modified.
 */
export function cleanAlphaPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: { core?: number; minFrac?: number; minPx?: number; grow?: number } = {},
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const core = opts.core ?? 110        // alpha at/above this = "solid subject"
  const minFrac = opts.minFrac ?? 0.02 // keep components ≥ this fraction of the largest
  const minPx = opts.minPx ?? 8        // …and ≥ this absolute size (drops opaque specks)
  const grow = opts.grow ?? 3          // px to grow the kept region (recover soft edges)
  const N = w * h

  // Solid mask + 8-connected components (iterative stack).
  const label = new Int32Array(N)
  const sizes: number[] = [0]
  const stack = new Int32Array(N)
  let cur = 0
  for (let s = 0; s < N; s++) {
    if (data[s * 4 + 3] < core || label[s]) continue
    cur++; let sp = 0; stack[sp++] = s; label[s] = cur; let cnt = 0
    while (sp) {
      const p = stack[--sp]; cnt++
      const x = p % w, y = (p / w) | 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (data[q * 4 + 3] >= core && !label[q]) { label[q] = cur; stack[sp++] = q }
      }
    }
    sizes[cur] = cnt
  }
  if (cur === 0) return null

  let maxSize = 0
  for (let c = 1; c <= cur; c++) if (sizes[c] > maxSize) maxSize = sizes[c]
  const minKeep = Math.max(minPx, minFrac * maxSize)
  const keep = new Uint8Array(cur + 1)
  for (let c = 1; c <= cur; c++) if (sizes[c] >= minKeep) keep[c] = 1

  let mask = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (label[i] && keep[label[i]]) mask[i] = 1
  for (let g = 0; g < grow; g++) {
    const next = mask.slice()
    for (let i = 0; i < N; i++) {
      if (mask[i]) continue
      const x = i % w, y = (i / w) | 0
      if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) ||
          (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) next[i] = 1
    }
    mask = next
  }

  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let i = 0; i < N; i++) {
    if (!mask[i]) { data[i * 4 + 3] = 0; continue }
    if (data[i * 4 + 3] > 0) {
      const x = i % w, y = (i / w) | 0
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY }
}

/** Clean a cutout data URL (remove background-removal haze) and crop it tight to
 *  the surviving subject. Returns the new data URL + its aspect (w/h). Falls
 *  back to the original on any failure. */
export async function cleanCutoutAlpha(dataUrl: string): Promise<{ url: string; aspect: number }> {
  try {
    const img = await loadImage(dataUrl)
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const id = ctx.getImageData(0, 0, w, h)
    const bbox = cleanAlphaPixels(id.data, w, h)
    if (!bbox) return { url: dataUrl, aspect: w / h }
    ctx.putImageData(id, 0, 0)
    const cw = bbox.maxX - bbox.minX + 1, ch = bbox.maxY - bbox.minY + 1
    const out = document.createElement('canvas'); out.width = cw; out.height = ch
    out.getContext('2d')!.drawImage(cv, bbox.minX, bbox.minY, cw, ch, 0, 0, cw, ch)
    return { url: out.toDataURL('image/png'), aspect: cw / ch }
  } catch {
    return { url: dataUrl, aspect: 1 }
  }
}

/** Convert a data URL to a File for FormData upload. */
function dataUrlToFile(dataUrl: string, filename: string): File {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const b64 = dataUrl.slice(comma + 1)
  const mime = /data:(.*?);/.exec(head)?.[1] || 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], filename, { type: mime })
}

export function useInpaint() {
  const busy = ref(false)
  const error = ref('')
  const results = ref<string[]>([]) // data URLs returned by the last generation

  /** Run FLUX Fill. Returns the generated images as data URLs. */
  async function fluxFill(image: string, mask: string, prompt: string, opts: FluxFillOpts = {}): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/flux-fill', {
        method: 'POST',
        body: {
          image, mask, prompt,
          tier: opts.tier ?? 'dev',
          model: opts.model,
          count: opts.count ?? 1,
          guidance: opts.guidance,
          steps: opts.steps,
          seed: opts.seed,
        },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Inpaint failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Mask-free instruction edit via FLUX Kontext (v3 "describe the change" mode). */
  async function kontext(image: string, prompt: string, opts: { count?: number } = {}): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/kontext', {
        method: 'POST',
        body: { image, prompt, count: opts.count ?? 1 },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Edit failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Text-to-image via FLUX.1 [schnell] (cheap/fast tier) — used when nothing
   *  is selected, to conjure a fresh subject and drop it in as a layer. */
  async function text2img(prompt: string, aspectRatio = '1:1', opts: { count?: number; seed?: number } = {}): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/text2img', {
        method: 'POST',
        body: { prompt, aspect_ratio: aspectRatio, count: opts.count ?? 1, seed: opts.seed },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Generation failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Generate from a trained LoRA's private Replicate model (Style mode with a
   *  style selected). `name` is the LoRA's .safetensors filename. */
  async function loraGen(name: string, prompt: string, aspectRatio = '1:1'): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/lora-gen', {
        method: 'POST',
        body: { name, prompt, aspectRatio },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Generation failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** High-quality object generation via Nano Banana 2 (Gemini image). Pass an
   *  optional `image` (a cropped scene region) to paint the object into a scene;
   *  omit it for a clean text→image object. Returns data URLs. */
  async function nanoGen(prompt: string, image?: string, images?: string[], variant?: string): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/nano-gen', {
        method: 'POST',
        body: { prompt, image, images, variant },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Generation failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Put a character into a mannequin's pose via Nano Banana 2. `character` and
   *  `pose` are data URLs (the character image and the gray mannequin render).
   *  Returns the posed character(s) as data URLs. */
  async function pose(character: string, poseImg: string, prompt = '', opts: { count?: number } = {}): Promise<string[]> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ images: string[] }>('/api/inpaint/pose', {
        method: 'POST',
        body: { character, pose: poseImg, prompt, count: opts.count ?? 1 },
      })
      results.value = res.images
      return res.images
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Pose generation failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Cloud background removal (851-labs/background-remover) — returns a
   *  transparent-PNG data URL cutout of the subject. */
  async function removeBackground(image: string): Promise<string> {
    busy.value = true; error.value = ''
    try {
      const res = await $fetch<{ image: string }>('/api/inpaint/remove-bg', {
        method: 'POST',
        body: { image },
      })
      return res.image
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Background removal failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Click-to-select a region. Returns SAM 3's white-on-black mask data URL for
   *  the clicked object (sized to the image sent), or null on failure (caller
   *  should fall back to manual brushing). `imgW`/`imgH` are unused now that SAM
   *  is promptable — the model returns THE object's mask directly, no client-side
   *  picking — but kept in the signature for call-site compatibility. `pointPx`
   *  is in the source image's pixel space. */
  async function segment(
    image: string, pointPx: { x: number; y: number }, _imgW?: number, _imgH?: number,
  ): Promise<string | null> {
    try {
      return await segmentPoints(image, [{ x: pointPx.x, y: pointPx.y, label: 1 }])
    } catch {
      return null
    }
  }

  /** Point-prompt SAM 3 (smart select): points are in the source image's pixel
   *  space; label 1 = foreground, 0 = background/subtract. Returns the single
   *  white-on-black mask the model produced for those points (white = selected).
   *  Unlike the old segment-everything path, the mask already reflects the
   *  points — the caller uses it as-is. */
  async function segmentPoints(image: string, points: { x: number; y: number; label: 0 | 1 }[]): Promise<string> {
    const res = await $fetch<{ mask: string }>('/api/inpaint/segment', {
      method: 'POST',
      body: { image, points },
    })
    return res.mask
  }

  /** Box-prompt SAM 3: `box` is in the source image's pixel space. SAM segments
   *  the object(s) inside the box and returns one white-on-black mask. Used by
   *  the Select tool's drag-box gesture (tight framing in cluttered scenes). */
  async function segmentBox(image: string, box: { xMin: number; yMin: number; xMax: number; yMax: number }): Promise<string> {
    const res = await $fetch<{ mask: string }>('/api/inpaint/segment', {
      method: 'POST',
      body: { image, box },
    })
    return res.mask
  }

  /** Upload a data-URL image into ComfyUI's input dir; returns its filename.
   *  Mirrors useLocalLayerEditor.addImageFromFile's upload path. */
  async function uploadDataUrl(dataUrl: string, nameHint = 'inpaint'): Promise<string> {
    const safe = `${nameHint}_${Date.now()}.png`
    const fd = new FormData()
    fd.append('image', dataUrlToFile(dataUrl, safe))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    return (await res.json())?.name || safe
  }

  return { busy, error, results, fluxFill, kontext, segment, segmentPoints, segmentBox, text2img, loraGen, nanoGen, pose, removeBackground, uploadDataUrl }
}
