/**
 * The deployment switch (accounts spec §10 Phase 1): no Clerk keys in env ⇒
 * local mode — no login, no metering, exactly the pre-accounts behavior.
 * Hosted mode activates ONLY when a Clerk secret key is configured.
 *
 * Read from process.env (not runtimeConfig) so it works in unit tests and
 * outside request context. Evaluated per call — never cache at module level.
 */
export type DeployMode = 'local' | 'hosted'

export function deployMode(): DeployMode {
  const key = process.env.NUXT_CLERK_SECRET_KEY
  return typeof key === 'string' && key.trim().length > 0 ? 'hosted' : 'local'
}

export function isHosted(): boolean {
  return deployMode() === 'hosted'
}

/**
 * Step 3, R10.9: the hosted proxy no longer forwards settings or userdata to
 * the engine at all (they answer 404), so this switch no longer opens any
 * route; it is read only by the engine's own launch flags.
 *
 * Stage 6 Task 8 — the per-user engine settings/userdata switch. OFF unless
 * `SAILOR_ENGINE_MULTI_USER` is explicitly set truthy. It gates BOTH the
 * engine's `--multi-user` flag (start.sh) and the proxy's userScoped
 * route-opening (comfyui-proxy.ts) so the two can never disagree: with it
 * unset, `/settings` + `/userdata` stay 403 in hosted (byte-identical to
 * today, no shared-dir leak) and ComfyUI stays single-user.
 *
 * DANGER — do NOT set this until an engine-user REGISTRATION layer exists.
 * Under `--multi-user`, ComfyUI's get_request_user_id raises `KeyError`
 * (→ 401) for any `comfy-user` id not present in `user/users.json`, INCLUDING
 * `default`. Clerk ids are never registered there (and POST /users mints its
 * OWN id rather than accepting one), so enabling this without a
 * clerk-id → engine-user mapping 401s every settings/userdata request. See the
 * Task 8 report for the two open blockers (registration + the cross-origin
 * canvas iframe hitting /settings directly without the header).
 *
 * Evaluated per call (never cached), same as deployMode().
 */
export function engineMultiUser(): boolean {
  const v = process.env.SAILOR_ENGINE_MULTI_USER
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false'
}
