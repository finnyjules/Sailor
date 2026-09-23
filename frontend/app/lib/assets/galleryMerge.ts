/**
 * How the Assets gallery folds a durable generation record into the items it
 * has already built from /history and the disk listing.
 *
 * The disk listing gives every file no ComfyUI prompt claims a made-up id,
 * `file:<type>:<subfolder>:<filename>`, with no project. A runner result is
 * such a file — the runner never touches /history — so its durable record is
 * the only place that knows how it was made. When a record names a file the
 * disk listing made up, the record's promptId, project and date win; a file
 * owned by a real ComfyUI prompt is left as it is.
 */

export interface GalleryImage { filename: string; subfolder: string; type: string }

export interface GalleryItem {
  promptId: string
  status: 'completed' | 'failed'
  images: GalleryImage[]
  executionTime: number | null
  timestamp: number
  projectUuid?: string
  projectName?: string
}

export interface GalleryGeneration {
  promptId: string
  filename: string
  subfolder?: string
  type: string
  timestamp: number
}

export function galleryFileKey(f: { type: string; subfolder?: string; filename: string }): string {
  return `${f.type}:${f.subfolder || ''}:${f.filename}`
}

export function diskFileItemId(fileKey: string): string {
  return `file:${fileKey}`
}

/** A stable, unique v-for key: one stage's several files share a promptId. */
export function galleryItemKey(item: GalleryItem): string {
  const first = item.images[0]
  return first ? `${item.promptId}|${galleryFileKey(first)}` : item.promptId
}

/**
 * Folds one durable record into `byPrompt`. `seen` holds the file keys already
 * in the gallery and is updated. Returns what happened, for tests.
 */
export function mergeGenerationIntoGallery(
  byPrompt: Map<string, GalleryItem>,
  seen: Set<string>,
  g: GalleryGeneration,
  project: { uuid: string; name?: string },
): 'replaced' | 'added' | 'skipped' {
  const key = galleryFileKey(g)
  const diskId = diskFileItemId(key)
  const disk = byPrompt.get(diskId)
  // Still the disk listing's made-up item (not already claimed by an earlier record).
  if (disk && disk.promptId === diskId) {
    byPrompt.set(diskId, {
      ...disk,
      promptId: g.promptId,
      timestamp: g.timestamp,
      projectUuid: project.uuid,
      projectName: project.name,
    })
    seen.add(key)
    return 'replaced'
  }
  if (seen.has(key)) return 'skipped'
  seen.add(key)
  byPrompt.set(`gen:${key}`, {
    promptId: g.promptId,
    status: 'completed',
    images: [{ filename: g.filename, subfolder: g.subfolder || '', type: g.type }],
    executionTime: null,
    timestamp: g.timestamp,
    projectUuid: project.uuid,
    projectName: project.name,
  })
  return 'added'
}
