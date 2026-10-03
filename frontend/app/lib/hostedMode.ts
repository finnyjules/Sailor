/** Hosted-mode gate for client code. Strict boolean — a string 'true' from
 * env mangling must not accidentally enable auth UI. */
export function hostedModeEnabled(cfg: { hostedMode?: unknown }): boolean {
  return cfg.hostedMode === true
}
