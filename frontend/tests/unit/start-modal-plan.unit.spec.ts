import { describe, it, expect } from 'vitest'
import { planStart } from '../../app/lib/startModal/plan'

const types = (p: ReturnType<typeof planStart>) => p.nodes.map(n => n.nodeType)
const wires = (p: ReturnType<typeof planStart>) => p.edges.map(e => `${e.from}:${e.out}->${e.to}.${e.input}`)

describe('planStart', () => {
  it('skip is a lone Frame', () => {
    const p = planStart(null)
    expect(types(p)).toEqual(['Compositor'])
    expect(p.edges).toEqual([])
  })

  it.each([
    ['gen', 'GenerateImageNode'], ['style', 'FluxLoRARemoteNode'], ['upscale', 'UpscaleImageNode'],
    ['gradient', 'GradientStudio'], ['pattern', 'TextureStudio'], ['shape', 'ShapeStudio'],
    ['vectortype', 'VectorType'], ['expressive', 'SpaceType'], ['scene3d', 'Scene3DStudio'],
  ] as const)('%s → %s wired into the Frame', (pick, nodeType) => {
    const p = planStart(pick)
    expect(types(p)).toEqual([nodeType, 'Compositor'])
    expect(wires(p)).toEqual(['a:0->frame.layer1'])
    expect(p.nodes.map(n => n.col)).toEqual([0, 1])
  })

  it('edit is Image → Edit → Frame', () => {
    const p = planStart('edit')
    expect(types(p)).toEqual(['Image', 'EditImageNode', 'Compositor'])
    expect(wires(p)).toEqual(['src:0->a.@IMAGE', 'a:0->frame.layer1'])
  })

  it('shader starts from a bundled picture', () => {
    const p = planStart('shader')
    expect(types(p)).toEqual(['Image', 'ShaderStudio', 'Compositor'])
    expect(p.nodes[0]!.starter).toBe('shaderPicture')
    expect(wires(p)).toEqual(['src:0->a.image', 'a:0->frame.layer1'])
  })

  it('moodboard feeds an image generator as its style', () => {
    const p = planStart('moodboard')
    expect(types(p)).toEqual(['Moodboard', 'GenerateImageNode', 'Compositor'])
    expect(wires(p)).toEqual(['src:0->a.style_in', 'a:0->frame.layer1'])
  })

  it('video sits beside the Frame, unwired', () => {
    const p = planStart('video')
    expect(types(p)).toEqual(['GenerateVideoNode', 'Compositor'])
    expect(p.edges).toEqual([])
  })

  it('3D starts with an object so it is never an empty scene', () => {
    expect(planStart('scene3d').nodes[0]!.starter).toBe('scene3dObject')
  })
})
