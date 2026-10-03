// LC8 (B5): a refused Run must not change or save the project. Before this, Run added its auto-sink
// Image cards (materializeAutoImageSinks) and the 3 s autosave saved them even when the run was then
// refused (project 34249b7f gained 6 Image cards). Now the sinks are the run's only once it is accepted
// (registered), the autosave waits while a run that added sinks is judged, and a refused run takes them
// back and drops the save they caused. The layout's run path is a large SFC: this pins its wiring.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = join(__dirname, '../../app')
const layout = readFileSync(join(APP, 'layouts/default.vue'), 'utf8')
const canvas = readFileSync(join(APP, 'components/vue-canvas/VueNodeCanvas.vue'), 'utf8')
const body = (name: string, src = layout) => {
  const at = src.indexOf(name)
  expect(at, name).toBeGreaterThan(0)
  return src.slice(at, src.indexOf('\n}\n', at))
}

describe('a refused Run leaves the project as it was', () => {
  it('runVueWorkflow settles its auto-sinks whatever happens (try/finally)', () => {
    const fn = body('async function runVueWorkflow(')
    expect(fn).toMatch(/const sinks = beginRunSinks\(opts\.autoSinks\)/)
    expect(fn).toMatch(/try \{\s*return await runVueWorkflowBody\(targetIds, opts, sinks\)\s*\} finally \{\s*await settleRunSinks\(sinks\)/)
  })

  it('a run is accepted only when it is registered (a runner run started, or the engine queued it)', () => {
    const fn = body('async function runVueWorkflowBody(')
    expect(fn).toMatch(/registerRun\(\{[^\n]*\}\)\n\s*\/\/ LC8 \(B5\)[^\n]*\n\s*sinks\.accepted = true/)
    expect((fn.match(/sinks\.accepted = true/g) ?? []).length).toBe(1)
  })

  it('every Run path adds its sinks through materializeRunSinks and hands them to the run', () => {
    expect(layout).not.toMatch(/\.materializeAutoImageSinks\?\.\([^)]*\)(?! \?\? ids)/)
    expect(body('async function runVueWorkflowBody(')).toContain('sinks.ids.push(...materializeRunSinks(activeIds).added)')
    expect(body('async function handleRunFiltered(')).toMatch(/runVueWorkflow\(expanded, \{[^}]*autoSinks: added \}\)/)
  })

  it('a refused run takes its sinks back and, when they were the only change, drops the save', () => {
    const fn = body('async function settleRunSinks(')
    expect(fn).toContain('if (r.ids.length && !r.accepted)')
    expect(fn).toContain('vueCanvasRef.value?.removeAutoSinks?.(r.ids)')
    expect(fn).toMatch(/if \(!r\.dirtyBefore && activeTab\.value\?\.id === r\.tabId\) \{\s*if \(autosaveDebounceTimer\) \{ clearTimeout\(autosaveDebounceTimer\)/)
  })

  it('the autosave waits while a run that added sinks is judged, and saves once it is settled', () => {
    const arm = body('function armAutosave(')
    expect(arm).toMatch(/if \(autosaveHeldForRun\(\)\) \{ autosaveDeferredForRun = true; return \}\s*autosaveCurrentWorkflow\(\)/)
    expect(body('function onCanvasDirty(')).toContain('armAutosave()')
    expect(body('async function settleRunSinks(')).toMatch(/if \(autosaveDeferredForRun && !autosaveHeldForRun\(\)\) \{\s*autosaveDeferredForRun = false\s*armAutosave\(\)/)
  })

  it('the canvas can take back the sinks it added (and their wires)', () => {
    expect(canvas).toMatch(/removeAutoSinks: \(ids: string\[\]\) => \{[\s\S]{0,300}removeNodes\(present\)/)
  })
})
