import { test, expect } from '@playwright/test'
import { dismissStartModal, dropNode, openBlankWorkflow, timelineEditorOverlay, waitForBackend } from './_helpers'

// Stale-schema staleness simulation (PARENT layer): the browser's cached
// /object_info predates a ComfyUI restart that added Timeline's `edit_state`
// input. setNamedWidget then can't find the widget at submit; before the fix
// this was a silent no-op (the backend ran the legacy full-res path). Now
// injectTimelineEditState self-heals with a forced /object_info refetch and —
// when the schema is STILL stale (our doctored route keeps serving the old
// shape, so the refetch deterministically can't heal) — throws, surfacing the
// 'Timeline state failed' toast with the reload remedy.
//
// Scoping: the parent fetches `/object_info` relative to its own origin
// (127.0.0.1:3002, served by Sailor). Filtering the route by port doctors only
// that fetch.

test.describe('stale /object_info schema', () => {
  test('Timeline run with edit_state missing from the cached schema toasts the reload remedy', async ({ page }) => {
    // Serve a DOCTORED /object_info to the parent only: real response with
    // Timeline's edit_state input stripped (the pre-restart shape). The
    // self-heal refetch flows through this same route, so it stays stale.
    await page.route(
      (url) => url.pathname === '/object_info' && url.port === '3002',
      async (route) => {
        const real = await route.fetch()
        const body = JSON.parse(await real.text())
        const input = body?.Timeline?.input
        if (input?.optional?.edit_state) delete input.optional.edit_state
        if (input?.required?.edit_state) delete input.required.edit_state
        await route.fulfill({ response: real, body: JSON.stringify(body) })
      },
    )

    await openBlankWorkflow(page)
    await waitForBackend(page)
    await dismissStartModal(page)

    // Drop a Timeline node and grab its id.
    await dropNode(page, 'Timeline')
    const tlNode = page.locator('.vue-flow__node').first()
    await expect(tlNode).toBeVisible({ timeout: 10_000 })
    const nodeId = await tlNode.getAttribute('data-id')
    expect(nodeId).toBeTruthy()

    // Open the timeline editor bound to the REAL node: bind() persists the
    // (default) edit_state JSON into node.data.properties.edit_state — exactly
    // what injectTimelineEditState reads at submit. Then close it.
    await page.evaluate((id) =>
      window.dispatchEvent(new CustomEvent('sailor:openTimeline', { detail: { nodeId: id } })),
      nodeId,
    )
    const editor = timelineEditorOverlay(page)
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(500) // let bind() sync edit_state to the node
    await page.keyboard.press('Escape')
    await editor.waitFor({ state: 'hidden', timeout: 5_000 })

    // Run: injection finds edit_state missing from the cached schema, forces a
    // refetch (still doctored), and throws → 'Timeline state failed' toast
    // whose description tells the user to reload.
    await page.getByRole('button', { name: 'Run', exact: true }).click()

    const toast = page.locator('[data-sonner-toast]', { hasText: 'Timeline state failed' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toContainText('Timeline schema is out of date')
    await expect(toast).toContainText('reload the page')
  })
})
