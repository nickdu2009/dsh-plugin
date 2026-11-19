/**
 * __TITLE__ — __DESCRIPTION__
 *
 * Registers one Agent tool. Replace the tool name, parameters, output, and the
 * `greet` helper with the capability this plugin actually provides.
 *
 * @module dsh-plugin-__NAME__
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { greet } from './greeting.js'

/** Stable Loader identity; matches the package name suffix and the patch id. */
export const name = '__NAME__'

/** Services this plugin needs before it activates. */
export const inject = ['tools']

/** Values users can change from `cordis.patch.yml` or the profile patch layer. */
export interface Config {
  /** Text placed before the name in the greeting. */
  greeting: string
}

/** Validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  greeting: z.string().default('Hello'),
})

/**
 * Register the plugin with the running Harness.
 * @param ctx - owning Cordis context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tool = defineTool({
    name: '__TOOL__',
    description: 'Return a greeting for the given name.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Name of the person to greet.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return greet(config.greeting, args.name)
    },
  })

  ctx.effect(() => ctx.tools.register(tool))
}
