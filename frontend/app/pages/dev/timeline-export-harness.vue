<template>
  <div style="padding: 8px; font: 12px monospace">timeline export harness ready</div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import type { EditState, Clip } from '~~/shared/timeline/types'
import { recordTimeline } from '~/lib/timeline/recordTimeline'
import { encodeWav16 } from '~/lib/engine/audio/mixdown'

async function upload(blob: Blob, name: string): Promise<string> {
  const fd = new FormData()
  fd.append('image', new File([blob], name, { type: blob.type }))
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`upload ${res.status}`)
  const d = await res.json()
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name
}

/** A WAV: `silenceSec` of silence, then a `hz` tone for `toneSec`. */
async function makeTone(o: { silenceSec: number; toneSec: number; hz: number }): Promise<string> {
  const sr = 48000
  const n = Math.round((o.silenceSec + o.toneSec) * sr)
  const ch = new Float32Array(n)
  for (let i = Math.round(o.silenceSec * sr); i < n; i++) ch[i] = 0.5 * Math.sin(2 * Math.PI * o.hz * i / sr)
  return upload(new Blob([encodeWav16([ch, ch], sr)], { type: 'audio/wav' }), `tlx_tone_${Date.now()}.wav`)
}

async function makeImage(o: { w: number; h: number; color: string }): Promise<string> {
  const c = document.createElement('canvas'); c.width = o.w; c.height = o.h
  const ctx = c.getContext('2d')!; ctx.fillStyle = o.color; ctx.fillRect(0, 0, o.w, o.h)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
  return upload(blob, `tlx_img_${Date.now()}.png`)
}

const viewUrl = (f: string) => `/view?${new URLSearchParams({ filename: f, type: 'input' })}`

async function run(state: EditState) {
  const t0 = performance.now()
  const { result, skippedAudio, skippedClips } = await recordTimeline(state, {
    resolve: (c: Clip) => ((c.kind === 'image' || c.kind === 'video') && c.path ? { url: viewUrl(c.path), kind: c.kind } : null),
    resolveAudioUrl: (c: Clip) => (c.kind === 'audio' && c.path ? viewUrl(c.path) : null),
  })
  const ms = performance.now() - t0
  const { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS })
  const v = await input.getPrimaryVideoTrack()
  const a = await input.getPrimaryAudioTrack()
  let frames = 0
  const centre: number[][] = []
  for await (const wc of new CanvasSink(v!).canvases()) {
    const c = wc.canvas as HTMLCanvasElement
    const p = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
    centre.push([p[0]!, p[1]!, p[2]!])
    frames++
  }
  let onset: number | null = null
  let audioCodec: string | null = null
  if (a) {
    audioCodec = await a.getCodec()
    for await (const { buffer, timestamp } of new AudioBufferSink(a).buffers()) {
      const d = buffer.getChannelData(0)
      const i = d.findIndex(x => Math.abs(x) > 0.1)
      if (i >= 0) { onset = timestamp + i / buffer.sampleRate; break }
    }
  }
  return {
    frames, ms, bytes: result.blob.size, ext: result.ext, skippedAudio, skippedClips,
    duration: await input.computeDuration(), colorSpace: await v!.getColorSpace(),
    audioCodec, onset, centre,
  }
}

onMounted(() => { (window as any).__timelineExport = { makeTone, makeImage, run, ready: true } })
</script>
