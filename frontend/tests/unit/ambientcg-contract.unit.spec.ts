import { describe, it, expect } from 'vitest'
import { TEXTURE_MAP_FILES as SERVER_MAP_FILES } from '../../server/utils/ambientcgExtract'
import { TEXTURE_ID_PREFIX as SERVER_ID_PREFIX } from '../../server/utils/ambientcgResolve'
import { TEXTURES_SUBDIR as SERVER_SUBDIR } from '../../server/utils/ambientcgDiskCache'
import {
  TEXTURE_MAP_FILES as CLIENT_MAP_FILES,
  TEXTURE_ID_PREFIX as CLIENT_ID_PREFIX,
  TEXTURES_SUBDIR as CLIENT_SUBDIR,
} from '~/lib/scene3d/textures'

/**
 * Three constants are duplicated between the Nitro server and the browser
 * bundle ON PURPOSE — the client must not import server code (that would drag
 * jszip and node:fs into the browser build) — and until now the only thing
 * holding them together was a "must match" comment. They are a wire contract:
 * the server writes the map files and the set directory, the client builds the
 * `/view` URLs that read them back, so a one-sided edit produces 404s on every
 * map rather than a build error.
 *
 * This spec is the guard. It is the whole reason the duplication is allowed to
 * stand: if you change one side, this fails.
 */
describe('ambientCG client/server constant contract', () => {
  it('agrees on the map filenames written to disk', () => {
    expect(CLIENT_MAP_FILES).toEqual(SERVER_MAP_FILES)
  })

  it('agrees on the resolved-texture id prefix', () => {
    expect(CLIENT_ID_PREFIX).toBe(SERVER_ID_PREFIX)
  })

  it('agrees on the input subfolder the sets live in', () => {
    expect(CLIENT_SUBDIR).toBe(SERVER_SUBDIR)
  })
})
