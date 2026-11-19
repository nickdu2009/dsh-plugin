/**
 * Model instructions — system-prompt sections selected by the model that is
 * about to answer.
 *
 * The prompt registry assembles the system prompt once per proposed model step
 * and hands every section provider the step's captured model selection. This
 * row registers one global section whose text selects, at assembly time, the
 * instructions configured for the provider/model that is about to answer.
 *
 * The section stays empty when no rule matches, so an unused row costs no
 * tokens and never alters an unrelated model. Because the text is resolved per
 * step, switching models mid-session changes the injected instructions on the
 * next request without a restart.
 *
 * `rules` is a volatile field: it is edited from Settings through the profile's
 * settings document, applies live, and is read here through `rules.get()` at
 * each assembly. The remaining fields are ordinary configuration.
 *
 * The browser half (`src/client.ts`) registers the Settings page that edits
 * `rules`; this file only contributes the prompt section and keeps the generic
 * schema-driven page from rendering the same fields twice.
 *
 * @module @nick.du/dsh-plugin-model-instructions
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ORDER, DEFAULT_SECTION, instructionsFor, type RuleConfig } from './instructions.js'

/** Stable Loader identity; matches the package name suffix and the patch row id. */
export const name = 'model-instructions'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Values users can change from `cordis.patch.yml` or the profile patch layer. */
export interface Config {
  /** Order of the contributed section in the assembled system prompt. */
  order: number
  /** Section name; an agent-scoped section of the same name shadows it. */
  name: string
  /** Resolve `{{variable}}` references inside instruction text. */
  interpolate: boolean
  /**
   * Ordered rules. Every matching rule appends its instruction, so a general
   * rule and a model-specific addendum compose. A blank instruction is inert.
   * This is the only field the Settings page edits.
   */
  rules: Volatile<RuleConfig[]>
}

/**
 * Validation and defaults for {@link Config}.
 *
 * The annotation and assertion are needed because `rules` is volatile: the
 * schema's own inferred type mentions the volatile reference type from
 * schemastery's vendored cosmokit, which would leak a non-portable type into
 * the emitted `lib/index.d.ts` (TS2742). The config the plugin actually
 * receives carries the live reference typed by {@link Config.rules}.
 */
export const Config: z<Config> = z.object({
  order: z.number().default(DEFAULT_ORDER),
  name: z.string().default(DEFAULT_SECTION),
  interpolate: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        name: z.string().default(''),
        providers: z.array(z.string()).default([]),
        models: z.array(z.string()).default([]),
        instruction: z.string().default(''),
      }),
    )
    .default([])
    // The settings document writes this field directly into the running row
    // configuration; the plugin must not remount to pick the edit up.
    .volatile(),
}) as unknown as z<Config>

/**
 * Register the model-selected instruction section for the whole profile.
 * @param ctx - the Host context owning the prompt registry.
 * @param config - the row config: placement plus the live `rules` field.
 */
export function apply(ctx: Context, config: Config): void {
  const order = Number.isFinite(config.order) ? config.order : DEFAULT_ORDER
  const sectionName =
    typeof config.name === 'string' && config.name.trim().length > 0
      ? config.name.trim()
      : DEFAULT_SECTION
  // Instruction text is literal by default: authored prose may contain braces
  // that strict interpolation would reject. Opt in with `interpolate: true` to
  // resolve `{{model}}`, `{{provider}}`, or other registered variables.
  const interpolate = config.interpolate === true

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: sectionName,
        order,
        text: (context) => instructionsFor(config, context),
        interpolate,
      }),
    'model-instructions.section()',
  )

  // This plugin ships its own Settings page, so a generic schema-driven page
  // must not also render these fields. The policy is keyed by this plugin's
  // fiber; without one, a re-apply or a missing service must not fail the row.
  const fiber = ctx.fiber
  ctx.inject(['settings'], (settingsCtx) => {
    if (fiber === undefined) return
    settingsCtx.effect(() => {
      try {
        return settingsCtx.settings.configure({ auto: false }, fiber)
      } catch (error) {
        settingsCtx.logger.warn(error)
        return () => {}
      }
    }, 'model-instructions.settings-presentation')
  })
}
