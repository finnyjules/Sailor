import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  outputKey, createGraphRun, resolveGraphRun, ownsPrompt,
  ownedPromptIds, ownedOutputKeys, pendingRuns, appendGraphRunOutput, setGraphRunState, __setGraphRunsDbForTests,
} from '../../server/utils/graphRuns'

const query = vi.fn()
beforeEach(() => { query.mockReset(); __setGraphRunsDbForTests({ query }) })

describe('outputKey', () => {
  it('defaults type=output, subfolder empty', () => {
    expect(outputKey({ filename: 'a.png' })).toBe('output::a.png')
    expect(outputKey({ filename: 'a.png', subfolder: 's', type: 'temp' })).toBe('temp:s:a.png')
  })
})

describe('graphRuns', () => {
  it('createGraphRun inserts a pending row', async () => {
    query.mockResolvedValue({ rows: [] })
    await createGraphRun({ promptId: 'p1', userId: 'u1', credits: 7, holdId: 42 })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/INSERT INTO graph_runs/i)
    expect(params).toEqual(['p1', 'u1', 7, 42, null])
  })

  it('resolveGraphRun records state and outputs', async () => {
    query.mockResolvedValue({ rows: [] })
    await resolveGraphRun('p1', 'settled', ['output::a.png'])
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/UPDATE graph_runs/i)
    expect(params[0]).toBe('settled')
    expect(JSON.parse(params[1])).toEqual(['output::a.png'])
    expect(params[2]).toBe('p1')
  })

  it('ownsPrompt is true only when a row matches both ids', async () => {
    query.mockResolvedValueOnce({ rows: [{ ok: 1 }] })
    expect(await ownsPrompt('u1', 'p1')).toBe(true)
    query.mockResolvedValueOnce({ rows: [] })
    expect(await ownsPrompt('u1', 'p2')).toBe(false)
  })

  it('ownedOutputKeys unions outputs across rows', async () => {
    query.mockResolvedValue({ rows: [{ outputs: ['output::a.png'] }, { outputs: ['output::b.png', 'temp::c.png'] }] })
    const keys = await ownedOutputKeys('u1')
    expect(keys).toEqual(new Set(['output::a.png', 'output::b.png', 'temp::c.png']))
  })

  it('pendingRuns returns only pending rows for the user', async () => {
    query.mockResolvedValue({ rows: [{ prompt_id: 'p1', hold_id: 42, credits: 7, target: null }] })
    const runs = await pendingRuns('u1')
    expect(runs).toEqual([{ promptId: 'p1', holdId: 42, credits: 7, target: null }])
    expect(query.mock.calls[0][0]).toMatch(/state = 'pending'/)
  })

  // Review I4: the harvest path polls the engine recorded for the run (the
  // column stays; stored targets are read back as written).
  it('createGraphRun records which engine ran the prompt', async () => {
    query.mockResolvedValue({ rows: [] })
    await createGraphRun({ promptId: 'p1', userId: 'u1', credits: 7, holdId: 42, target: 'http://127.0.0.1:8191' })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/target/)
    expect(params).toEqual(['p1', 'u1', 7, 42, 'http://127.0.0.1:8191'])
  })

  it('createGraphRun tolerates a missing target (null)', async () => {
    query.mockResolvedValue({ rows: [] })
    await createGraphRun({ promptId: 'p1', userId: 'u1', credits: 7, holdId: null })
    expect(query.mock.calls[0][1]).toEqual(['p1', 'u1', 7, null, null])
  })

  it('pendingRuns returns the target so the harvest polls the right engine', async () => {
    query.mockResolvedValue({ rows: [{ prompt_id: 'p1', hold_id: null, credits: 0, target: 'http://127.0.0.1:8191' }] })
    expect(await pendingRuns('u1')).toEqual([{ promptId: 'p1', holdId: null, credits: 0, target: 'http://127.0.0.1:8191' }])
  })

  // Review I3: the harvest caps at 20 rows. Unordered, that cap picks an
  // ARBITRARY 20 — a user with a backlog of stale pendings could have their
  // just-finished run permanently excluded from the window that settles it.
  it('pendingRuns orders newest-first and caps in SQL', async () => {
    query.mockResolvedValue({ rows: [] })
    await pendingRuns('u1', 20)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/ORDER BY\s+created_at\s+DESC/i)
    expect(sql).toMatch(/LIMIT/i)
    expect(params).toEqual(['u1', 20])
  })

  it('appendGraphRunOutput adds one output key to the row', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await appendGraphRunOutput('run_x.0.t0', 'output::generate_image_00001_.png')
    expect(query.mock.calls[0][0]).toMatch(/outputs = outputs \|\| \$1::jsonb/)
    expect(query.mock.calls[0][1]).toEqual([JSON.stringify(['output::generate_image_00001_.png']), 'run_x.0.t0'])
  })

  it('pendingRuns leaves runner rows out of the ComfyUI harvest', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await pendingRuns('u1')
    expect(query.mock.calls[0][0]).toMatch(/target IS NULL OR target <> 'runner'/)
  })

  it('setGraphRunState leaves outputs alone', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await setGraphRunState('run_x.0.t0', 'settled')
    expect(query.mock.calls[0][0]).toMatch(/^UPDATE graph_runs SET state = \$1 WHERE prompt_id = \$2$/)
    expect(query.mock.calls[0][1]).toEqual(['settled', 'run_x.0.t0'])
  })
})
