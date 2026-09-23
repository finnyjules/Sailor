/**
 * Should a project tab open with the "What do you want to make?" start picker?
 *
 * Only a genuinely fresh, blank project gets it. A tab that is opened to show
 * existing content never does — its graph may still be loading when the tab
 * becomes active (loadWorkflowForTab fetches it asynchronously), so "no saved
 * content yet" alone is not proof the tab is blank:
 *   - workflowId → a recent/durable project;
 *   - promptId   → a past run's graph (ComfyUI /history, or the runner record
 *                  "Open Workflow" opens as it ran).
 */
export function shouldOfferStartPicker(
  tab: { type?: string; workflowId?: string; promptId?: string } | null | undefined,
  opts: { seen: boolean; hasSavedContent: boolean },
): boolean {
  return tab?.type === 'project'
    && !tab.workflowId
    && !tab.promptId
    && !opts.seen
    && !opts.hasSavedContent
}
