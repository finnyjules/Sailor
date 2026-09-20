import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * Mutate a node's `model` widget value reactively, then wait one tick for
 * Vue's render. We reach into the canvas store via the same `vueFlowNodes`
 * injection the canvas uses internally — exposed for tests through window
 * during dev would be cleaner, but for now we just locate the node by id
 * within the rendered DOM and find Vue Flow's react state via the canvas.
 *
 * The simplest path that actually works: use the canvas's existing
 * `sailor:addNode` event to drop a node, find its data-id, then set the
 * widget value by triggering input events on the rendered <select>.
 */
async function setComboValue(page: Page, nodeDataId: string, widgetLabel: RegExp, value: string) {
  const node = page.locator(`.vue-flow__node[data-id="${nodeDataId}"]`)
  // Widget labels include a trailing "?" info-icon span when there's a
  // tooltip, so the textContent reads "Model?" — keep your widgetLabel regex
  // lenient (use /^Model\??$/i or /Model/).
  const label = node.locator('label', { hasText: widgetLabel })
  const select = label.locator('xpath=following::select[1]')
  await select.selectOption({ label: value })
}

async function addUseCaseNode(page: Page, nodeType: string): Promise<string> {
  // Capture node id by counting before/after.
  const before = await page.locator('.vue-flow__node').count()
  await page.evaluate((t) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: t } }))
  }, nodeType)
  await expect.poll(async () => page.locator('.vue-flow__node').count()).toBeGreaterThan(before)
  // Last node is the new one.
  const last = page.locator('.vue-flow__node').last()
  return (await last.getAttribute('data-id')) ?? ''
}

test.describe('Generators panel + use-case nodes', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
  })

  test('panel shows hero tier + intent sections on the image tab', async ({ page }) => {
    await page.getByRole('button', { name: /^Actions$/ }).click()
    const panel = page.locator('div.bg-\\[\\#1a1a1a\\]\\/95').first()
    await expect(panel).toBeVisible({ timeout: 5_000 })

    // Hero tier (image tab is default): the pinned high-frequency actions.
    const hero = panel.locator('.line-clamp-2')
    await expect(hero.filter({ hasText: /^Generate an image$/ })).toBeVisible()
    await expect(hero.filter({ hasText: /^Edit an image$/ })).toBeVisible()
    await expect(hero.filter({ hasText: /^Upscale an image$/ })).toBeVisible()

    // Intent section headers replace provider names.
    for (const label of ['Create', 'Edit', 'Enhance', 'Analyze']) {
      await expect(panel.getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) })).toBeVisible()
    }

    // Non-hero use-case cards render inside their sections.
    await expect(panel.getByText('Remove background', { exact: true })).toBeVisible()
    await expect(panel.getByText('Restore an old photo', { exact: true })).toBeVisible()
    await expect(panel.getByText('Describe an image', { exact: true })).toBeVisible()
  })

  test('deprecated per-model cards are hidden from the panel', async ({ page }) => {
    await page.getByRole('button', { name: /^Actions$/ }).click()
    const panel = page.locator('div.bg-\\[\\#1a1a1a\\]\\/95').first()
    await expect(panel).toBeVisible({ timeout: 5_000 })

    // Scan ALL domain tabs (image, audio, video, 3d, text) so we catch
    // deprecated nodes lurking under any of them.
    const tabs = ['Image', 'Audio', 'Video', '3D', 'Text']
    const seenTitles = new Set<string>()
    for (const tabLabel of tabs) {
      await panel.getByRole('button', { name: new RegExp(`^${tabLabel}( \\d+)?$`) }).click().catch(() => {})
      await page.waitForTimeout(150)
      const titles = await panel.locator('.line-clamp-2, .flex-col > span:first-child').allInnerTexts()
      titles.forEach((t) => seenTitles.add(t.trim()))
    }

    // None of the deprecated standalone model names should appear as a card
    // title. (Their model names CAN appear in subheaders — those are .line-clamp-1.)
    const deprecatedLabels = [
      'Flux 1.1 Pro', 'Ideogram V3 Turbo', 'Flux Kontext Pro',
      'Clarity Upscale', 'Seedance 2.0', 'Veo 3', 'Kling 2.1',
      'Lipsync', 'Whisper', 'MusicGen', 'MiniMax Speech-02 HD',
      'Hunyuan3D 2',
    ]
    for (const dep of deprecatedLabels) {
      expect([...seenTitles], `card title "${dep}" should not appear in any domain tab`).not.toContain(dep)
    }
  })

  test('Generate an image: switching the Model combo toggles which advanced fields show', async ({ page }) => {
    const nodeId = await addUseCaseNode(page, 'GenerateImageNode')
    const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
    await expect(node).toBeVisible()

    // Default model is "Flux 1.1 Pro". Flux's tunables should be visible,
    // Ideogram's should NOT be.
    await expect(node.getByText(/Safety tolerance/i)).toBeVisible()
    await expect(node.getByText(/Prompt upsampling/i)).toBeVisible()
    await expect(node.getByText(/Style type/i)).toHaveCount(0)
    await expect(node.getByText(/Magic prompt/i)).toHaveCount(0)

    // Switch to Ideogram.
    await setComboValue(page, nodeId, /^Model\??$/i, 'Ideogram V3 Turbo')

    await expect(node.getByText(/Style type/i)).toBeVisible()
    await expect(node.getByText(/Magic prompt/i)).toBeVisible()
    await expect(node.getByText(/Safety tolerance/i)).toHaveCount(0)
    await expect(node.getByText(/Prompt upsampling/i)).toHaveCount(0)

    // Switch back to confirm bidirectional reactivity.
    await setComboValue(page, nodeId, /^Model\??$/i, 'Flux 1.1 Pro')
    await expect(node.getByText(/Safety tolerance/i)).toBeVisible()
    await expect(node.getByText(/Style type/i)).toHaveCount(0)
  })

  test('Generate a video: each of Seedance / Veo 3 / Kling shows only its own tunables', async ({ page }) => {
    const nodeId = await addUseCaseNode(page, 'GenerateVideoNode')
    const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
    await expect(node).toBeVisible()

    // Default = Seedance 2.0.
    await expect(node.getByText(/Resolution/i)).toBeVisible()
    await expect(node.getByText(/Camera fixed/i)).toBeVisible()
    await expect(node.getByText(/Cfg scale/i)).toHaveCount(0)
    // Negative prompt is shared by Veo+Kling, NOT Seedance.
    await expect(node.getByText(/Negative prompt/i)).toHaveCount(0)

    // → Veo 3: negative_prompt appears, resolution/cfg disappear.
    await setComboValue(page, nodeId, /^Model\??$/i, 'Veo 3')
    await expect(node.getByText(/Negative prompt/i)).toBeVisible()
    await expect(node.getByText(/Resolution/i)).toHaveCount(0)
    await expect(node.getByText(/Cfg scale/i)).toHaveCount(0)
    await expect(node.getByText(/Camera fixed/i)).toHaveCount(0)

    // → Kling 2.1: cfg_scale + negative_prompt visible.
    await setComboValue(page, nodeId, /^Model\??$/i, 'Kling 2.1')
    await expect(node.getByText(/Cfg scale/i)).toBeVisible()
    await expect(node.getByText(/Negative prompt/i)).toBeVisible()
    await expect(node.getByText(/Resolution/i)).toHaveCount(0)
  })

  // --- Real execute-path tests (billable) ----------------------------------
  // Gated by RUN_BILLABLE_TESTS=1. These actually call Replicate and cost
  // a few cents each, so they're off by default in CI but should be run
  // locally whenever Replicate node code changes.
  test.describe('execute path (billable)', () => {
    test.skip(!process.env.RUN_BILLABLE_TESTS, 'set RUN_BILLABLE_TESTS=1 to run')

    // 8-minute floor for every test in this block. Replicate rate-limits
    // accounts with <$5 credit (6 req/min) so even fast models can spend
    // tens of seconds queued behind 429 retries. Individual tests can call
    // test.setTimeout(...) to extend further (e.g. Topaz at 15 min).
    test.beforeEach(({}, testInfo) => {
      testInfo.setTimeout(8 * 60 * 1000)
    })

    // -- Shared helpers --------------------------------------------------

    /** Queue a prompt and poll /history until terminal. Returns the entry.
     * Default 5min — low-credit Replicate accounts get 429-rate-limited and
     * predictions can spend a long time queued before they start. */
    async function runPrompt(
      request: any, page: any, prompt: Record<string, any>,
      timeoutMs = 300_000,
    ): Promise<any> {
      const res = await request.post('/prompt', {
        data: { prompt, client_id: `pw-${Date.now()}-${Math.random().toString(36).slice(2,8)}` },
        headers: { 'content-type': 'application/json' },
      })
      if (res.status() !== 200) {
        throw new Error(`/prompt HTTP ${res.status()}: ${(await res.text()).slice(0,300)}`)
      }
      const { prompt_id } = await res.json()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        // The Nuxt /history/{id} route returns a 404 HTML page while the
        // prompt is still queued/running. Only attempt JSON parse on 200s;
        // anything else means "not ready yet, wait and retry".
        const r = await request.get(`/history/${prompt_id}`)
        if (r.status() === 200) {
          try {
            const h = await r.json()
            if (h[prompt_id]) return h[prompt_id]
          } catch { /* HTML body even on 200 — treat as not ready */ }
        }
        await page.waitForTimeout(2000)
      }
      throw new Error(`timed out waiting for ${prompt_id}`)
    }

    async function findInputImage(request: any): Promise<string | null> {
      const list = await request.get('/sailor/input_listing').then((r: any) => r.json())
      const img = (list.items as Array<{ filename: string }> | undefined)
        ?.find(i => /\.(jpe?g|png|webp)$/i.test(i.filename))
      return img?.filename ?? null
    }

    async function findInputAudio(request: any): Promise<string | null> {
      const list = await request.get('/sailor/input_listing').then((r: any) => r.json())
      const a = (list.items as Array<{ filename: string }> | undefined)
        ?.find(i => /\.(mp3|wav|m4a|ogg|flac)$/i.test(i.filename))
      return a?.filename ?? null
    }

    // Public sample video for tests that need a Replicate-reachable URL.
    // samplelib hosts these stably and they're tiny (5s, ~3 MB).
    const PUBLIC_VIDEO_URL = 'https://download.samplelib.com/mp4/sample-5s.mp4'

    function expectSuccess(entry: any, label: string) {
      expect(entry?.status?.status_str, `${label}: ${JSON.stringify(entry?.status?.messages ?? entry?.status)}`).toBe('success')
    }

    // -- Original RemoveBackground test ---------------------------------

    test('RemoveBackground returns an image', async ({ page, request }) => {
      const img = await findInputImage(request)
      test.skip(!img, 'no image in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadImage',            inputs: { image: img! } },
        '2': { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['1', 0] } },
        '3': { class_type: 'PreviewImage',         inputs: { images: ['2', 0] } },
      })
      expectSuccess(entry, 'RemoveBackground')
      expect(entry.outputs?.['3']?.images?.length).toBeGreaterThan(0)
    })

    // -- 11 new use-case nodes ------------------------------------------

    test('SketchToImage returns an image', async ({ page, request }) => {
      const img = await findInputImage(request)
      test.skip(!img, 'no image in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadImage',         inputs: { image: img! } },
        '2': { class_type: 'SketchToImageNode', inputs: {
                  model: 'Nano Banana', image: ['1', 0],
                  prompt: 'photo-realistic finished illustration of the sketch',
              } },
        '3': { class_type: 'PreviewImage',      inputs: { images: ['2', 0] } },
      })
      expectSuccess(entry, 'SketchToImage')
      expect(entry.outputs?.['3']?.images?.length).toBeGreaterThan(0)
    })

    test('ExtractText executes without error', async ({ page, request }) => {
      const img = await findInputImage(request)
      test.skip(!img, 'no image in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadImage',       inputs: { image: img! } },
        '2': { class_type: 'ExtractTextNode', inputs: { model: 'ByteDance Dolphin', image: ['1', 0] } },
      })
      expectSuccess(entry, 'ExtractText')
    })

    // Replicate FaceSwap test removed — node was retired in favor of the
    // local FaceSwap node (InsightFace + inswapper_128, faster, free,
    // supports video). The local node has its own test surface elsewhere.

    test('FindObjects executes without error', async ({ page, request }) => {
      const img = await findInputImage(request)
      test.skip(!img, 'no image in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadImage',       inputs: { image: img! } },
        '2': { class_type: 'FindObjectsNode', inputs: {
                  model: 'YOLO-World', image: ['1', 0], query: 'person, face, hand', confidence: 0.25,
              } },
      })
      expectSuccess(entry, 'FindObjects')
    })

    test('ConsistentFace returns an image', async ({ page, request }) => {
      const img = await findInputImage(request)
      test.skip(!img, 'no image in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadImage',          inputs: { image: img! } },
        '2': { class_type: 'ConsistentFaceNode', inputs: {
                  model: 'Ideogram Character',
                  reference_image: ['1', 0],
                  prompt: 'the same person sitting in a sunny park',
                  aspect_ratio: '1:1', seed: 0,
              } },
        '3': { class_type: 'PreviewImage',       inputs: { images: ['2', 0] } },
      })
      expectSuccess(entry, 'ConsistentFace')
      expect(entry.outputs?.['3']?.images?.length).toBeGreaterThan(0)
    })

    test('EnhanceVideo (Topaz) returns a video', async ({ page, request }) => {
      test.setTimeout(15 * 60 * 1000)
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'EnhanceVideoNode', inputs: {
                  model: 'Topaz Video Upscale',
                  video_url: PUBLIC_VIDEO_URL,
                  target_resolution: '1080p',
                  fps: 'original',
              } },
        '2': { class_type: 'PreviewVideo',     inputs: { video: ['1', 0] } },
      }, 8 * 60 * 1000)  // Topaz can take several minutes
      expectSuccess(entry, 'EnhanceVideo')
    })

    test('DescribeVideo returns text', async ({ page, request }) => {
      test.setTimeout(5 * 60 * 1000)
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'DescribeVideoNode', inputs: {
                  model: 'Gemini 2.5 Flash',
                  video_url: PUBLIC_VIDEO_URL,
                  prompt: 'In one sentence, describe what is happening.',
              } },
      })
      expectSuccess(entry, 'DescribeVideo')
    })

    test('CloneSingingVoice (RVC) returns audio', async ({ page, request }) => {
      test.setTimeout(10 * 60 * 1000)
      const audio = await findInputAudio(request)
      test.skip(!audio, 'no audio in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadAudio',              inputs: { audio: audio! } },
        '2': { class_type: 'CloneSingingVoiceNode',  inputs: {
                  model: 'Realistic Voice Cloning (RVC)',
                  audio: ['1', 0],
                  rvc_model: 'Squidward',
                  custom_rvc_model_url: '',
                  pitch_change: 'no-change',
                  pitch_shift_semitones: 0,
                  pitch_detection_algorithm: 'rmvpe',
                  output_format: 'wav',
              } },
        '3': { class_type: 'PreviewAudio',           inputs: { audio: ['2', 0] } },
      }, 5 * 60 * 1000)
      expectSuccess(entry, 'CloneSingingVoice')
    })

    test('IdentifySpeakers returns text', async ({ page, request }) => {
      test.setTimeout(10 * 60 * 1000)
      const audio = await findInputAudio(request)
      test.skip(!audio, 'no audio in input/')
      const entry = await runPrompt(request, page, {
        '1': { class_type: 'LoadAudio',            inputs: { audio: audio! } },
        '2': { class_type: 'IdentifySpeakersNode', inputs: {
                  model: 'Whisper Diarization', audio: ['1', 0],
                  num_speakers: 0, language: 'auto',
              } },
      }, 5 * 60 * 1000)
      expectSuccess(entry, 'IdentifySpeakers')
    })
  })

  test('single-model use-case nodes have a Model combo with one option', async ({ page }) => {
    // Sanity check: even nodes with a single model still expose the combo
    // for future expansion. We pick TranscribeAudio.
    const nodeId = await addUseCaseNode(page, 'TranscribeAudioNode')
    const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
    await expect(node).toBeVisible()
    await expect(node.getByText(/^Model\??$/i)).toBeVisible()
    const select = node.locator('label', { hasText: /^Model\??$/i }).locator('xpath=following::select[1]')
    const options = await select.locator('option').allInnerTexts()
    expect(options).toContain('Whisper')
  })
})
