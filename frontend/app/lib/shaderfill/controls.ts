import type { ControlSpec } from '~/lib/spacetype/effect'
import type { EffectDef, GradientStop } from '~/lib/shaderfx/types'
import { cleanStops, serializeStops } from '~/lib/shaderfx/params'
import { DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import { unprefixedKey } from './descriptor'

/**
 * The control-schema pattern for shader fills — "declare the frame, derive the
 * contents" — and the shape every future absorbed library's parameter list should
 * follow when that list is not known ahead of time.
 *
 * `lib/gradientfx/controls.ts:5-24` requires control KEYS to stay frozen forever,
 * because Collection bindings persist `params.<key>` — a renamed key silently
 * orphans every saved binding. That works for a hand-authored, closed vocabulary
 * (Gradient's ~60 sliders), but a shader fill wraps ONE of 63 catalog effects, each
 * with its own param list the app doesn't (and can't) know ahead of time. You
 * cannot freeze what you do not know.
 *
 * The resolution — already discovered independently by Shader Studio
 * (`lib/shaderstudio/agentControls.ts:21` builds `ControlSpec[]` imperatively from
 * a live `EffectDef` rather than declaring them) — is to split the vocabulary into
 * two tiers:
 *
 *   fill.shader.effectId        <- DECLARED here, frozen forever (getShaderFillControls)
 *   fill.shader.anchor          <- DECLARED here, frozen forever (getShaderFillControls)
 *   fill.shader.speed           <- DECLARED here, frozen forever (getShaderFillControls)
 *   fill.shader.seed            <- DECLARED here, frozen forever (getShaderFillControls)
 *   fill.shader.params.<paramId> <- DERIVED per effect (derivedShaderFillControls)
 *
 * The four declared keys never change shape, so Collection bindings against them
 * are as safe as any hand-authored control. The derived `params.<paramId>` keys are
 * stable only PER EFFECT — switching `effectId` changes which `params.*` keys exist
 * and what they mean. That instability is inherent to what they represent (there is
 * no such thing as a frozen "segments" knob independent of which effect defines
 * "segments"), not a defect of this schema. A binding against
 * `fill.shader.params.segments` is only meaningful while `fill.shader.effectId`
 * names an effect that HAS a `segments` param; `resolveEffectParams` (./descriptor.ts)
 * already drops any param key an effect doesn't declare, so a stale binding degrades
 * to "ignored", not "wrong value applied".
 *
 * "Declared vs. derived" is a property of HOW this list is built, not something
 * that needs its own namespace segment in the key. `derivedShaderFillControls`
 * addresses each param at `<prefix>.params.<paramId>` — the REAL path into a
 * `ShaderSpec` (`params: Record<string, number>`, unprefixed — see `unprefixedKey`
 * below). An earlier version of this file used a reserved `<prefix>.p.<paramId>`
 * address instead, one segment off from where `ShaderSpec.params` actually lives.
 * That bought nothing (declared-vs-derived was already true without it) and cost
 * real correctness: `lib/agent/configParams.ts`'s `makeConfigParams` and
 * `lib/studio/path.ts`'s `getByPath`/`setByPath` both do NAIVE dotted-path
 * traversal — neither special-cases `.p.` → `.params.` — so a write through the old
 * key created a phantom `fill.shader.p` object next to the real `fill.shader.params`
 * and silently never reached the renderer. Addressing the real path means both
 * resolvers get this right for free, with no remapping layer to keep in sync.
 */

const GROUP = 'Shader'

/**
 * The four declared keys, addressed under `prefix`.
 *
 * A FACTORY rather than a bare constant because the host studio decides where a
 * `ShaderSpec` lives: Space Type, Shape Studio and the Compositor store it at
 * `fill.shader`, while Vector Type's appearance stack stores one PER LAYER and
 * addresses it relatively, at `layer.paint.shader`. `derivedShaderFillControls`
 * below already took a `prefix` for exactly this reason; the declared four had
 * hard-coded theirs, which meant a host with a different storage path could only
 * offer the derived half of the vocabulary.
 *
 * The prefix must be the REAL dotted path to the `ShaderSpec` — see the module
 * header for what a key one segment off it cost last time.
 */
export function shaderFillControls(prefix = 'fill.shader'): ControlSpec[] {
  return [
    {
      key: `${prefix}.effectId`,
      label: 'Effect',
      kind: 'select',
      // Deliberately empty: the 63-effect catalog is fetched at runtime
      // (`lib/shaderfx/catalog.ts`), not a static list this module can declare — the
      // same reason `Scene3DStudioSurface.vue`'s `shaderEffectIds` computed reads it
      // from the live catalog instead of a constant. A caller that offers this control
      // (agent prompt, UI select) must merge in the live catalog's effect ids.
      options: [],
      default: DEFAULT_SHADER_SPEC.effectId,
      group: GROUP,
      hint: 'Which catalog shader effect processes the fill underneath.',
    },
    {
      key: `${prefix}.anchor`,
      label: 'Anchor',
      kind: 'select',
      options: ['object', 'frame'],
      default: DEFAULT_SHADER_SPEC.anchor,
      group: GROUP,
      hint: "object = the field samples in the shape's own local space (tiles/moves with it); frame = it samples the whole frame's space (the shape is a window onto one continuous field).",
      // A MODE, not a value: animating it would flip between two different sampling
      // spaces mid-tween (a discrete jump), not interpolate a quantity — the same
      // reasoning `layer.shape.phase` vs a `select` control gets elsewhere in this
      // codebase. Opts out of motion; stays agent-settable (the default `agent: true`).
      animatable: false,
    },
    {
      key: `${prefix}.speed`,
      label: 'Speed',
      kind: 'slider',
      min: 0,
      max: 4,
      step: 0.05,
      default: DEFAULT_SHADER_SPEC.speed,
      group: GROUP,
      hint: 'Animation rate multiplier for the effect; 0 = frozen (still).',
    },
    {
      key: `${prefix}.seed`,
      label: 'Variation',
      kind: 'slider',
      min: 1,
      max: 9999,
      step: 1,
      default: DEFAULT_SHADER_SPEC.seed,
      group: GROUP,
      hint: 'Varies the generative field — a different number gives a different pattern.',
      animatable: false,
    },
  ]
}

/** The declared four at the default `fill.shader` prefix — the three studios
 *  that store a `ShaderSpec` there import this and are untouched by the factory
 *  above.
 *
 *  LAZY, not `= shaderFillControls()`. Evaluating it at module-init read
 *  `DEFAULT_SHADER_SPEC` while `~/lib/spacetype/fillTile` could still be
 *  mid-initialization — it sits in a documented cycle with
 *  `~/lib/compositor/paint` — so the defaults came back `undefined` and
 *  this module threw on import. It only ever surfaced when some unrelated import
 *  reordered the traversal (adding one to this file did exactly that, and the
 *  resulting failure was intermittent across vitest workers, which is what a
 *  latent init-order bug looks like). Computing on first read removes the
 *  ordering dependency entirely rather than betting on a lucky traversal. */
let _shaderFillControls: ControlSpec[] | null = null
export function getShaderFillControls(): ControlSpec[] {
  return (_shaderFillControls ??= shaderFillControls())
}

/**
 * Build one ControlSpec per param the given catalog effect declares, addressed
 * under `<prefix>.params.<paramId>` — the REAL `ShaderSpec.params` path (see the
 * module doc above), so a caller resolving these keys with a plain dotted-path
 * walker (`makeConfigParams`, `getByPath`/`setByPath`) lands on the actual stored
 * value with no translation layer. Float params become sliders; enum params
 * become selects.
 *
 * Enum params carry `{ label, value: number }` options (see EffectParamDef in
 * ~/lib/shaderfx/types), but `ShaderSpec.params` is `Record<string, number>` —
 * `resolveEffectParams` (./descriptor.ts) only ever accepts a NUMBER for an enum
 * key (`typeof raw === 'number' && values.includes(raw)`), falling back to
 * `p.default` otherwise. An earlier version of this function stored each option's
 * LABEL (a string) here, which fails that check on every write and silently pins
 * the param at its default forever — a bug caught in review before anything
 * shipped on top of it (would have been the write-domain twin of the `.p.` vs
 * `.params.` key bug above: two representations of one identity disagreeing,
 * this time about what the value MEANS rather than which path it's at).
 *
 * Fixed by storing each option's numeric VALUE (as the string ControlSpec's
 * `select` kind requires — see below) instead of its label, so `Number(...)` on
 * whatever gets written reproduces the exact number `resolveEffectParams` expects,
 * with no lookup table standing between the two.
 *
 * Known, stated gap (not solved here): this drops the per-option DISPLAY label.
 * `ControlSpec`'s `select` kind is `{ options: string[]; default: string }` with
 * no parallel value/label channel, and neither does anything downstream of it —
 * `lib/spacetype/controlDescriptor.ts`'s `DescribedControl`/`validatePatch` treat
 * `options` as opaque strings compared by string equality, and
 * `StudioSelect.vue` renders each option string as both `<option value>` AND its
 * own label text. Every other `select` in this codebase (`canvas.layout`,
 * `layer.blend`, `shape.primitive`, ...) is unaffected because its domain values
 * already ARE readable words — this is the first select whose domain is numeric
 * and whose labels are a separate concept. Widening `select` to carry per-option
 * labels (e.g. an optional parallel array, or `{value,label}` pairs) would fix
 * the UI but touches every existing consumer of `kind: 'select'`, not just this
 * one; left as a decision for whoever builds the inspector (Task 9) rather than
 * done unilaterally here. Until then, an enum-typed derived control renders as
 * raw numeric choices ("0", "1", ...), not the effect's friendly option names —
 * correct, not pretty.
 */
export function derivedShaderFillControls(effect: EffectDef, prefix: string): ControlSpec[] {
  const out: ControlSpec[] = []
  for (const p of effect.params) {
    // The fill's frozen `speed` control (fill.shader.speed, shaderFillControls above)
    // already scales u_time, which an animated frag multiplies by u_speed — so ALSO
    // surfacing the effect's own u_speed here paints a SECOND "Speed" slider that
    // compounds with the frozen one (all ~38 animated catalog effects declare u_speed).
    // Skip it; u_speed stays at its manifest default when hidden (toUniforms fills it),
    // so each effect keeps its tuned baseline rate at speed = 1 and the frozen Speed
    // scales from there. The exception is an effect whose u_speed DEFAULT is 0
    // (kaleidoscope, mirror, pinch_bulge): there u_speed is the ONLY motion switch —
    // the frag is frozen until it is raised, and the frozen speed cannot un-freeze it
    // (0 × anything = 0) — so it must stay editable.
    if (p.uniform === 'u_speed' && Number(p.default) !== 0) continue
    const key = `${prefix}.params.${unprefixedKey(p.uniform)}`
    if (p.type === 'color') {
      // `ControlSpec`'s own `color` kind — a scalar hex string, the same
      // representation `ShaderSpec.params` stores, so there is exactly one
      // identity for this value across the schema and the renderer.
      out.push({ key, label: p.label, kind: 'color', default: p.default as string, group: 'Effect' })
    } else if (p.type === 'gradient') {
      // JSON text, like every other structured kind, because `ParamValue` is
      // scalar. This is NOT a second representation of the ramp: `cleanStops`
      // (~/lib/shaderfx/params.ts) accepts the text and the array and emits one
      // normalized array for both the renderer and the descriptor key, so a ramp
      // written here and a ramp written by a studio's own picker resolve — and
      // therefore key — identically. Not animatable: a stop list has no float
      // sweep, hence the explicit flag rather than the slider default.
      out.push({
        key,
        label: p.label,
        kind: 'gradientStops',
        default: serializeStops(cleanStops(p.default, p.maxStops ?? 8, p.default as GradientStop[])),
        maxStops: p.maxStops ?? 8,
        group: 'Effect',
        animatable: false,
      })
    } else if (p.type === 'enum') {
      const options = p.options ?? []
      out.push({
        key,
        label: p.label,
        kind: 'select',
        options: options.map((o) => String(o.value)),
        default: String(p.default),
        group: 'Effect',
      })
    } else {
      out.push({
        key,
        label: p.label,
        kind: 'slider',
        min: p.min ?? 0,
        max: p.max ?? 1,
        step: p.step ?? 0.01,
        default: p.default as number,
        group: 'Effect',
        // No `animatable` field: sliders are animatable by default (ControlMeta's
        // doc in ~/lib/spacetype/effect.ts), which is the point — motion tracks
        // come free for every effect param without this function opting in per-key.
      })
    }
  }
  return out
}
