/**
 * Structural views of the two Host services this plugin uses.
 *
 * DSH serves these services from its own implementation packages, which a
 * profile bundle does not depend on. The declarations below mirror the contract
 * of the DSH release pinned in the repository README (`dsh-system-prompt` and
 * `dsh-settings`); re-check them when that version is upgraded.
 *
 * @module @nick.du/dsh-plugin-model-instructions/services
 */

import type { Context } from '@deepseek-ai/cordis'

/** The provider and model one proposed model step will use. */
export interface AssembleContext {
  /** Selection captured for the step being prepared. */
  modelSelection?: { provider?: string; model?: string }
  /** The agent the step belongs to, whose live options are the fallback. */
  agent?: { options?: { provider?: string; model?: string } }
}

/** One contributed section of the system prompt. */
export interface PromptSection {
  /** Unique section name; an agent-scoped section of the same name shadows it. */
  name: string
  /** Sections are concatenated in ascending order. */
  order: number
  /** Static text or a provider evaluated once per assembly. */
  text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate `{{variable}}` references; defaults to true. */
  interpolate?: boolean
  /** Treat this contribution as the complete system prompt. */
  complete?: boolean
}

/** The prompt registry this row contributes to. */
export interface SystemPromptService {
  /**
   * Register an ordered prompt section in the calling context's scope.
   * @param section - the section to register.
   * @returns the Cordis effect disposer.
   */
  section(section: PromptSection): () => void
}

/** Presentation policy for the generic schema-driven settings page. */
export interface SettingsPresentation {
  /** Generate a page for this row's schema. `false` defers to the bundle's own page. */
  auto?: boolean
}

/** The profile settings service (configuration document + presentation policy). */
export interface SettingsService {
  /**
   * Set how a plugin entry is presented in Settings.
   * @param presentation - the presentation policy for this owner.
   * @param owner - the plugin fiber the policy is keyed by; defaults to the calling context.
   * @returns the Cordis effect disposer removing the policy.
   */
  configure(presentation: SettingsPresentation, owner: unknown): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by `@deepseek-ai/dsh-system-prompt`; this plugin declares it in `inject`. */
    systemPrompt: SystemPromptService
    /** Provided by `@deepseek-ai/dsh-settings`; this plugin waits for it before configuring its page. */
    settings: SettingsService
  }
}
