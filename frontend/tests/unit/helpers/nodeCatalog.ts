/**
 * Sailor's own node catalogue (server/assets/nodeCatalog.json.gz, step 4 C6):
 * each class's inputs as the Python nodes declared them. Specs that used to
 * read a widget's options or range from the Python source read them here
 * since Python left the repo (C7).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

let catalog: Record<string, any> | null = null

/** The `[type, options]` pair a class declares for one input (required or optional). */
export function catalogInput(ct: string, name: string): [string, Record<string, any>] {
  catalog ??= JSON.parse(gunzipSync(readFileSync(path.resolve(__dirname, '..', '..', '..', 'server', 'assets', 'nodeCatalog.json.gz'))).toString('utf8'))
  const input = catalog![ct]?.input?.required?.[name] ?? catalog![ct]?.input?.optional?.[name]
  if (!input) throw new Error(`${ct}.${name} is not in the node catalogue`)
  return input
}

/** A combo input's options. */
export function catalogOptions(ct: string, name: string): string[] {
  const [type, opts] = catalogInput(ct, name)
  return type === 'COMBO' ? opts.options : type as unknown as string[]
}
