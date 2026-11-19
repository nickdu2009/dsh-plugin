/**
 * Rule matching for model-selected system-prompt instructions.
 *
 * The Host prompt registry assembles the system prompt once per proposed model
 * step. This module decides which configured rules apply to the provider/model
 * that step is about to use, so it stays independent of Cordis and is unit
 * tested directly.
 *
 * @module @nick.du/dsh-plugin-model-instructions/instructions
 */

/** Default section order: after deliverable references, before structured output. */
export const DEFAULT_ORDER = 9500

/** Section name used when the configuration does not name another one. */
export const DEFAULT_SECTION = 'deployment:model-instructions'

/** One configured rule: which provider/model ids it admits, and what it adds. */
export interface RuleConfig {
  /** Optional display name for the settings list; never used for matching. */
  name?: string
  /** Provider globs this rule admits; empty admits every provider. */
  providers?: string[]
  /** Model globs this rule admits; empty admits every model. */
  models?: string[]
  /** Instruction text appended when the rule matches; blank rules stay inert. */
  instruction?: string
}

/** The provider and model one prompt assembly will use. */
export interface ModelSelection {
  provider?: string
  model?: string
}

/** A rule with its globs compiled, ready for assembly-time matching. */
export interface CompiledRule {
  /** Matchers for the provider ids the rule admits. */
  providers: RegExp[]
  /** Matchers for the model ids the rule admits. */
  models: RegExp[]
  /** Trimmed instruction text; empty for an inactive rule. */
  instruction: string
}

/** Structural view of the assembly context fields this plugin reads. */
interface AssemblyContextLike {
  /** Selection captured for the step being prepared. */
  modelSelection?: { provider?: unknown; model?: unknown }
  /** Agent whose live options are the fallback selection. */
  agent?: { options?: { provider?: unknown; model?: unknown } }
}

/** Safely read a property without trusting the value's shape. */
function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * Escape one literal character for use inside a regular expression.
 * @param character - one input character.
 * @returns the character, escaped when it is a regular-expression metacharacter.
 */
function escapeCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character
}

/**
 * Compile one provider or model glob (`*` any run, `?` one character).
 * Matching is case-insensitive and must cover the whole id.
 * @param pattern - the glob from the row config.
 * @returns a matcher over one provider or model id.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += escapeCharacter(character)
  }
  return new RegExp(`${source}$`, 'i')
}

/**
 * Read the live rule list out of a volatile field or a plain value.
 *
 * `rules` is declared volatile: the settings page writes it through the
 * profile's configuration document, and the Host hands the plugin a field whose
 * `get()` returns the current list without remounting the plugin.
 * @param config - the row config.
 * @returns the configured rules, or an empty list.
 */
export function currentRules(config: unknown): unknown[] {
  const value = property(config, 'rules')
  const store = value as { get?: unknown } | undefined
  const resolved = typeof store?.get === 'function' ? (store.get as () => unknown)() : value
  return Array.isArray(resolved) ? resolved : []
}

/**
 * Prepare one rule list for assembly-time matching. A blank `instruction` keeps
 * its rule inert, and a malformed entry throws so callers can fail closed.
 * @param raw - the rule list as configured.
 * @returns the compiled rules in declaration order.
 * @throws {TypeError} when a rule is not a mapping.
 */
export function compileRules(raw: readonly unknown[]): CompiledRule[] {
  return raw.map((rule, index) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new TypeError(`[model-instructions] rules[${index}] must be a mapping`)
    }
    const patterns = (value: unknown): RegExp[] =>
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(compileGlob)
    const instruction = property(rule, 'instruction')
    return {
      providers: patterns(property(rule, 'providers')),
      models: patterns(property(rule, 'models')),
      instruction: typeof instruction === 'string' ? instruction.trim() : '',
    }
  })
}

/**
 * The provider and model a step will use, preferring the captured selection and
 * falling back to the agent's live options, like the built-in `{{provider}}` and
 * `{{model}}` prompt variables.
 * @param context - the assembly context, which carries the step selection.
 * @returns the ids matching sees, each absent when nothing names it.
 */
export function selectionOf(context: unknown): ModelSelection {
  const assembly = (context ?? {}) as AssemblyContextLike
  const selection = assembly.modelSelection
  const options = assembly.agent?.options
  const provider = selection?.provider ?? options?.provider
  const model = selection?.model ?? options?.model
  return {
    provider: typeof provider === 'string' ? provider : undefined,
    model: typeof model === 'string' ? model : undefined,
  }
}

/**
 * Whether one rule's patterns admit a value. An empty pattern list is unfiltered;
 * a filter with no known value does not match.
 * @param patterns - compiled globs.
 * @param value - the provider or model id, possibly unknown.
 * @returns true when at least one pattern matches, or the rule is unfiltered.
 */
export function admits(patterns: readonly RegExp[], value: string | undefined): boolean {
  if (patterns.length === 0) return true
  if (value === undefined) return false
  return patterns.some((pattern) => pattern.test(value))
}

/**
 * Resolve the injected text for one assembly by joining every matching rule in
 * declaration order, so a later rule adds to an earlier one.
 * @param config - the row config, read fresh so live edits apply.
 * @param context - the assembly context for the step being prepared.
 * @returns the section text, empty when no rule applies or resolution fails.
 */
export function instructionsFor(config: unknown, context: unknown): string {
  try {
    const { provider, model } = selectionOf(context)
    const applied: string[] = []
    for (const rule of compileRules(currentRules(config))) {
      if (rule.instruction.length === 0) continue
      if (!admits(rule.providers, provider)) continue
      if (!admits(rule.models, model)) continue
      applied.push(rule.instruction)
    }
    return applied.join('\n\n')
  } catch {
    // A prompt provider must never fail the model request; an empty section
    // leaves the rest of the system prompt intact.
    return ''
  }
}
