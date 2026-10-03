/**
 * Shared guards for the moodboard image routes (upload/list/serve). Moodboard
 * folders live beside the training datasets under `<repo-root>/input/`, but the
 * folder guard is its own `moodboard_<ms>` regex — these routes must never open
 * `lora_dataset_*` folders.
 */
import { dataPath } from './dataRoot'

export function moodboardInputDir(): string { return dataPath('input') }

export function safeImageFile(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return /\.(png|jpe?g|webp)$/i.test(name)
}
