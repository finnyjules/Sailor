import { describe, expect, it } from 'vitest'
import {
  isLink, dependenciesOf, upstreamStage, downstreamNodes, legNodes, type ApiPrompt,
} from '#shared/runner/graph'

// image(1) -> gate(2) -> video(3) -> videoSink(4); image(1) -> imageSink(5)
const flow = (bypass = false): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a cat', aspect_ratio: '1:1', seed: 7, model_options: '{}' } },
  '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass } },
  '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'moves', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
  '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
  '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const none = new Set<string>()

describe('isLink', () => {
  it('matches ComfyUI is_link', () => {
    expect(isLink(['1', 0])).toBe(true)
    expect(isLink(['1', 0.0])).toBe(true)
    expect(isLink([1, 0])).toBe(false)
    expect(isLink(['1'])).toBe(false)
    expect(isLink('1')).toBe(false)
  })
})

describe('stages', () => {
  it('upstreamStage stops at other Gates (server.py _get_upstream_stage)', () => {
    const p = flow()
    expect([...upstreamStage(p, '2')].sort()).toEqual(['1'])
    p['6'] = { class_type: 'ComfyGateNode', inputs: { data_in: ['4', 0], bypass: false } }
    expect([...upstreamStage(p, '6')].sort()).toEqual(['3', '4'])
  })
  it('downstreamNodes walks forward from the Gate', () => {
    expect([...downstreamNodes(flow(), '2')].sort()).toEqual(['3', '4'])
  })
  it('dependenciesOf lists distinct upstream ids that exist', () => {
    expect(dependenciesOf(flow(), '3')).toEqual(['2'])
    expect(dependenciesOf(flow(), '1')).toEqual([])
  })
})

describe('legNodes', () => {
  it('first leg reaches the Gate and stops behind it', () => {
    expect([...legNodes(flow(), { done: none, open: none, dropped: none })].sort()).toEqual(['1', '2', '5'])
  })
  it('after Continue the next leg runs what was behind the Gate', () => {
    const s = { done: new Set(['1', '2', '5']), open: new Set(['2']), dropped: none }
    expect([...legNodes(flow(), s)].sort()).toEqual(['3', '4'])
  })
  it('a Gate with pass-through on does not stop anything', () => {
    expect([...legNodes(flow(true), { done: none, open: none, dropped: none })].sort()).toEqual(['1', '2', '3', '4', '5'])
  })
  it('a dropped Gate and everything behind it stay out', () => {
    const s = { done: new Set(['1', '5']), open: none, dropped: new Set(['2']) }
    expect([...legNodes(flow(), s)]).toEqual([])
  })
})
