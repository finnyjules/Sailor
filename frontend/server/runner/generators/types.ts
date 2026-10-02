export interface ImageBuildArgs {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
  /** fal URLs of moodboard reference pictures, or null. */
  refs: string[] | null
}

export interface ImageModelDesc {
  id: string
  label: string
  /** fal endpoint for text-to-image. */
  app: string
  /** fal endpoint that takes reference pictures (`image_urls`), or null. */
  refsApp: string | null
  build(a: ImageBuildArgs): Record<string, unknown>
}

/** A Generate-image model whose Python primary is Replicate. */
export interface ReplicateImageModelDesc {
  id: string
  label: string
  /** Replicate model slug (image_models.py replicate_slug). */
  slug: string
  /** Port of the model's Replicate build_input. None of these takes moodboard pictures: `refs` is ignored. */
  build(a: ImageBuildArgs): Record<string, unknown>
}

export interface VideoBuildArgs {
  prompt: string
  aspectRatio: string
  duration: number
  seed: number
  /** Link of the first frame (fal storage), or null. */
  image: string | null
  adv: Record<string, unknown>
  /** Link of the sound (Python's WAV, handed off), or null: only Fabric reads it (R11.2). */
  audio?: string | null
}

export interface VideoModelDesc {
  id: string
  label: string
  /** fal app (the part before the function). */
  app: string
  defaultDuration: number
  /** fal function per mode, as in video_models.py fal_fn_by_mode. '' submits to the app itself. */
  fnByMode: { t2v: string, firstLast: string, reference?: string }
  build(a: VideoBuildArgs): Record<string, unknown>
}

/** A Generate-video model whose Python provider is Replicate (video_models.py, provider="replicate"). */
export interface ReplicateVideoModelDesc {
  id: string
  label: string
  /** Replicate model slug (video_models.py replicate_slug). */
  slug: string
  defaultDuration: number
  /** 't2v' and/or 'i2v'. A model without 'i2v' ignores a linked first frame, as Python does. */
  modes: ReadonlyArray<'t2v' | 'i2v'>
  /** Port of the model's build_input. `image` goes in the model's own field. */
  build(a: VideoBuildArgs): Record<string, unknown>
}
