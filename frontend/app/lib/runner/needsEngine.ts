/**
 * Which nodes of a run need the local engine, and the refusals built on it.
 * The rule lives in shared/runner/needsEngine.ts, shared with the server
 * (server/utils/blockedModels.ts); this module is the app's entry point to it.
 */
export * from '#shared/runner/needsEngine'
