import { describe, expect, it } from 'vitest'
import { awaitRunnerImage, buildFaceSwapPrompt } from '~/lib/runner/awaitRunnerResult'

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: unknown) => handlers.forEach(h => h({ data } as MessageEvent)),
    size: () => handlers.size,
  }
}

describe('Face Swap app on the runner', () => {
  it('builds LoadImage ×2 → FaceSwap with the picked gender and hair, no SaveImage', () => {
    const p = buildFaceSwapPrompt({ face: 'f.png', target: 't.png', gender: 'Female', keepHairFrom: 'The face photo' })
    expect(p).toEqual({
      1: { class_type: 'LoadImage', inputs: { image: 'f.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 't.png' } },
      3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: 'Female', keep_hair_from: 'The face photo' } },
    })
  })

  it('resolves with the FaceSwap picture of its own run only', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'executed', prompt_id: 'other', output: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } })
    w.post({ type: 'sailor-bridge', event: 'executed', prompt_id: 'run1.0', output: { images: [{ filename: 'face_swap_1.png', subfolder: '', type: 'output' }] } })
    await expect(done).resolves.toEqual({ filename: 'face_swap_1.png', subfolder: '', type: 'output' })
    expect(w.size()).toBe(0)
  })

  it('rejects with the runner’s own words on an error', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'execution_error', prompt_id: 'run1.0', exception_message: 'Pick the face’s gender on the node.' })
    await expect(done).rejects.toThrow('Pick the face’s gender on the node.')
  })

  it('rejects when the run completes with no picture', async () => {
    const w = fakeWindow()
    const done = awaitRunnerImage('run1.0', { target: w })
    w.post({ type: 'sailor-bridge', event: 'execution_complete', prompt_id: 'run1.0' })
    await expect(done).rejects.toThrow('The swap finished but made no picture.')
  })
})
