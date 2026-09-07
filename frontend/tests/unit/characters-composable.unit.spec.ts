import { afterEach, describe, expect, it, vi } from 'vitest'

const REVA = {
  name: 'Reva',
  slug: 'reva',
  states: [
    { id: 'default', label: 'Default', descriptor: '', refImages: ['r1.png', 'r2.png'], coverIndex: 1, panels: [], sheetImage: null, status: 'draft', stressResult: null, updatedAt: '' },
    { id: 'punk', label: 'Punk', descriptor: 'shaved head, leather jacket', refImages: ['p1.png'], coverIndex: 0, panels: [], sheetImage: null, status: 'draft', stressResult: null, updatedAt: '' },
  ],
  loraName: null,
  trigger: null,
  bodyShape: null,
  notes: '',
  createdAt: '',
  updatedAt: '',
}

describe('useCharacters', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('fetches once, resolves refs to /view URLs, and computes coverUrl from the default state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, refresh, resolveRefs, coverUrl } = useCharacters()
    await refresh()
    expect(characters.value).toHaveLength(1)
    // Cover-first: coverIndex 1 (r2) leads the resolved list.
    expect(resolveRefs(['reva', 'ghost'])).toEqual({
      reva: ['/view?filename=r2.png&type=input', '/view?filename=r1.png&type=input'],
      ghost: [],
    })
    expect(coverUrl(characters.value[0]!)).toBe('/view?filename=r2.png&type=input')
  })

  it('survives a failed fetch (offline) with an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, refresh } = useCharacters()
    await refresh()
    expect(characters.value).toEqual([])
  })

  it('surfaces fetch failures via error, and clears it when a retry succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, error, refresh } = useCharacters()
    await refresh()
    expect(error.value).toBeTruthy()
    await refresh()
    expect(error.value).toBe('')
    expect(characters.value).toHaveLength(1)
  })

  it('surfaces a non-ok response status via error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { error, refresh } = useCharacters()
    await refresh()
    expect(error.value).toContain('500')
  })

  it('resolveStateRefs picks the named state and falls back to default for unknown ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { refresh, resolveStateRefs } = useCharacters()
    await refresh()

    expect(resolveStateRefs([{ slug: 'reva', stateId: 'punk' }])).toEqual({
      reva: ['/view?filename=p1.png&type=input'],
    })
    // Unknown state id falls back to the default state (cover-first: r2 leads).
    expect(resolveStateRefs([{ slug: 'reva', stateId: 'nonexistent' }])).toEqual({
      reva: ['/view?filename=r2.png&type=input', '/view?filename=r1.png&type=input'],
    })
    // null stateId → default state (cover-first).
    expect(resolveStateRefs([{ slug: 'reva', stateId: null }])).toEqual({
      reva: ['/view?filename=r2.png&type=input', '/view?filename=r1.png&type=input'],
    })
    // Unknown slug → empty array.
    expect(resolveStateRefs([{ slug: 'ghost', stateId: null }])).toEqual({ ghost: [] })
  })

  it('resolveStateRefs is identity-first: sheet leads when set, else cover-first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, resolveStateRefs } = useCharacters()
    // Seed characters ref directly — no need to round-trip through refresh().
    characters.value = [{
      ...REVA,
      states: [
        { ...REVA.states[0]!, sheetImage: 'sheet.png' },
        REVA.states[1]!,
      ],
    }]
    expect(resolveStateRefs([{ slug: 'reva', stateId: null }])).toEqual({
      reva: [
        '/view?filename=sheet.png&type=input',
        '/view?filename=r2.png&type=input',
        '/view?filename=r1.png&type=input',
      ],
    })
  })

  it('coverFirstRefs orders the cover first and tolerates edge coverIndexes', async () => {
    const { coverFirstRefs } = await import('~/composables/useCharacters')
    expect(coverFirstRefs({ refImages: ['a', 'b', 'c'], coverIndex: 2 })).toEqual(['c', 'a', 'b'])
    expect(coverFirstRefs({ refImages: ['a', 'b'], coverIndex: 0 })).toEqual(['a', 'b'])
    expect(coverFirstRefs({ refImages: ['solo'], coverIndex: 5 })).toEqual(['solo']) // clamped, single
    expect(coverFirstRefs({ refImages: [], coverIndex: 0 })).toEqual([])
    expect(coverFirstRefs(undefined)).toEqual([])
    expect(coverFirstRefs({ refImages: ['a', 'b', 'c'], coverIndex: 9 })).toEqual(['c', 'a', 'b']) // clamped high
  })

  it('coverUrl(c, stateId) returns the named state cover, falling back to default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, refresh, coverUrl } = useCharacters()
    await refresh()
    const c = characters.value[0]!
    expect(coverUrl(c, 'punk')).toBe('/view?filename=p1.png&type=input')
    expect(coverUrl(c, 'nonexistent')).toBe('/view?filename=r2.png&type=input')
    expect(coverUrl(c)).toBe('/view?filename=r2.png&type=input')
  })

  it('portraitUrl prefers the portrait panel, falling back to the state cover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, portraitUrl } = useCharacters()
    characters.value = [{
      ...REVA,
      states: [
        { ...REVA.states[0]!, panels: [{ slot: 'portrait', filename: 'portrait.png' }] },
        REVA.states[1]!,
      ],
    }]
    const c = characters.value[0]!
    expect(portraitUrl(c)).toBe('/view?filename=portrait.png&type=input')
    // No portrait panel on 'punk' → falls back to its cover.
    expect(portraitUrl(c, 'punk')).toBe('/view?filename=p1.png&type=input')
  })

  it('stateDescriptors maps slug → descriptor, dropping empty/whitespace ones', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, stateDescriptors } = useCharacters()
    characters.value = [
      REVA,
      { ...REVA, slug: 'blank', states: [{ ...REVA.states[0]!, descriptor: '   ' }] },
    ]
    expect(stateDescriptors([
      { slug: 'reva', stateId: 'punk' },
      { slug: 'blank', stateId: null },
      { slug: 'ghost', stateId: null },
    ])).toEqual({ reva: 'shaved head, leather jacket' })
  })

  it('stateDescriptors joins the state descriptor with the body phrase when bodyShape is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, stateDescriptors } = useCharacters()
    characters.value = [
      { ...REVA, slug: 'cal', bodyShape: { build: 0.8 } },
    ]
    // punk state descriptor is 'shaved head, leather jacket' — joined with the
    // build-0.8 phrase ('a noticeably heavyset build') via ', ' (the '; '
    // delimiter is reserved for the outer cast clause list — castClause joins
    // per-character entries with '; ', so the inner join here must not reuse it).
    expect(stateDescriptors([{ slug: 'cal', stateId: 'punk' }]))
      .toEqual({ cal: 'shaved head, leather jacket, a noticeably heavyset build' })
  })

  it('stateDescriptors: bodyShape-only (empty descriptor) yields the phrase alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, stateDescriptors } = useCharacters()
    characters.value = [
      { ...REVA, slug: 'cal', bodyShape: { build: 0.8 } },
    ]
    // default state has an empty descriptor — only the phrase should appear.
    expect(stateDescriptors([{ slug: 'cal', stateId: 'default' }]))
      .toEqual({ cal: 'a noticeably heavyset build' })
  })

  it('stateDescriptors: null bodyShape yields exactly the state descriptor (back-compat)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [] }) }))
    const { useCharacters } = await import('~/composables/useCharacters')
    const { characters, stateDescriptors } = useCharacters()
    characters.value = [REVA] // REVA.bodyShape is null
    expect(stateDescriptors([{ slug: 'reva', stateId: 'punk' }]))
      .toEqual({ reva: 'shaved head, leather jacket' })
  })

  it('patchState returns "stale" on a 409 response and still refreshes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 409, ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { patchState, characters } = useCharacters()
    const result = await patchState('reva', { stateId: 'default', patch: { descriptor: 'x' } })
    expect(result).toBe('stale')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(characters.value).toHaveLength(1)
  })

  it('replaceStates sends expectedUpdatedAt in the PATCH body when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { replaceStates } = useCharacters()
    await replaceStates('reva', REVA.states as any, '2026-08-01T00:00:00.000Z')
    const [, opts] = fetchMock.mock.calls[0]!
    expect(JSON.parse(opts.body)).toEqual({
      slug: 'reva', states: REVA.states, expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('replaceStates returns "stale" on a 409 response and still refreshes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 409, ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { replaceStates, characters } = useCharacters()
    const result = await replaceStates('reva', REVA.states as any, '2026-08-01T00:00:00.000Z')
    expect(result).toBe('stale')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(characters.value).toHaveLength(1)
  })

  it('patchCharacter sends bodyShape in the PATCH body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { patchCharacter } = useCharacters()
    await patchCharacter('reva', { bodyShape: { frame: 0.8, height: 0.2 } })
    const [, opts] = fetchMock.mock.calls[0]!
    expect(JSON.parse(opts.body)).toEqual({ slug: 'reva', bodyShape: { frame: 0.8, height: 0.2 } })
  })

  it('patchCharacter sends an explicit null bodyShape to clear it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ characters: [REVA] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useCharacters } = await import('~/composables/useCharacters')
    const { patchCharacter } = useCharacters()
    await patchCharacter('reva', { bodyShape: null })
    const [, opts] = fetchMock.mock.calls[0]!
    expect(JSON.parse(opts.body)).toEqual({ slug: 'reva', bodyShape: null })
  })

  it('characterStatus derives draft/training/ready from lora link + job queue', async () => {
    const { characterStatus } = await import('~/composables/useCharacters')
    const ready = { ...REVA, loraName: 'reva-lora' }
    expect(characterStatus(ready, [])).toBe('ready')

    const draft = { ...REVA, loraName: null }
    expect(characterStatus(draft, [])).toBe('draft')

    const trainingByDisplayName = { ...REVA, loraName: null }
    expect(characterStatus(trainingByDisplayName, [
      { status: 'processing', loraKind: 'character', displayName: 'Reva', outputName: 'unrelated' },
    ])).toBe('training')

    const trainingByOutputName = { ...REVA, loraName: null }
    expect(characterStatus(trainingByOutputName, [
      { status: 'queued', loraKind: 'character', displayName: 'Something Else', outputName: 'REVA' },
    ])).toBe('training')

    // Wrong loraKind doesn't count.
    const notCharacterKind = { ...REVA, loraName: null }
    expect(characterStatus(notCharacterKind, [
      { status: 'processing', loraKind: 'style', displayName: 'Reva', outputName: 'reva' },
    ])).toBe('draft')

    // Terminal status doesn't count as training.
    const terminal = { ...REVA, loraName: null }
    expect(characterStatus(terminal, [
      { status: 'succeeded', loraKind: 'character', displayName: 'Reva', outputName: 'reva' },
    ])).toBe('draft')

    // loraName set takes priority over any in-flight job.
    const readyDespiteJob = { ...REVA, loraName: 'reva-lora' }
    expect(characterStatus(readyDespiteJob, [
      { status: 'starting', loraKind: 'character', displayName: 'Reva', outputName: 'reva' },
    ])).toBe('ready')
  })
})

describe('useTrainingJobs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('refreshJobs populates jobs from /api/training-queue', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          { id: '1', kind: 'lora', status: 'processing', loraKind: 'character', displayName: 'Vera', outputName: 'vera', progressPct: 40 },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { useTrainingJobs } = await import('~/composables/useCharacters')
    const { jobs, refreshJobs } = useTrainingJobs()
    await refreshJobs()
    expect(jobs.value).toHaveLength(1)
    expect(jobs.value[0]?.displayName).toBe('Vera')
  })

  it('eager fetch fires once across repeated calls — per-render callers must not loop', async () => {
    // sheetCostLabel() calls useTrainingJobs() from templates: every render
    // invokes it again. An unguarded eager fetch mutates jobs.value → re-render
    // → fetch again, flooding /api/training-queue.
    vi.stubGlobal('window', {})
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { useTrainingJobs } = await import('~/composables/useCharacters')
    useTrainingJobs()
    useTrainingJobs()
    useTrainingJobs()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshJobs is offline-safe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { useTrainingJobs } = await import('~/composables/useCharacters')
    const { jobs, refreshJobs } = useTrainingJobs()
    await expect(refreshJobs()).resolves.toBeUndefined()
    expect(jobs.value).toEqual([])
  })
})

describe('missingStateIssues', () => {
  const catalog = [
    { slug: 'vera', states: [{ id: 'default' }, { id: 'v-abc' }] },
  ]

  it('warns when a picked state no longer exists on a known character', async () => {
    const { missingStateIssues } = await import('~/composables/useCharacters')
    const issues = missingStateIssues([{ slug: 'vera', name: 'Vera', stateId: 'v-deleted' }], catalog)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'warning', code: 'cast-state-missing' })
    expect(issues[0]!.message).toContain('Vera')
  })

  it('stays silent for existing states, default picks, and unknown characters', async () => {
    const { missingStateIssues } = await import('~/composables/useCharacters')
    expect(missingStateIssues([{ slug: 'vera', name: 'Vera', stateId: 'v-abc' }], catalog)).toEqual([])
    expect(missingStateIssues([{ slug: 'vera', name: 'Vera', stateId: null }], catalog)).toEqual([])
    // unknown slug: zero-refs error covers it downstream — no duplicate warning
    expect(missingStateIssues([{ slug: 'ghost', name: 'Ghost', stateId: 'v-x' }], catalog)).toEqual([])
  })
})
