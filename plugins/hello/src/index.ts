/**
 * Hello — adds a `hello_greet` Agent tool that greets someone by name.
 *
 * The greeting prefix is ordinary plugin configuration, so users can change it
 * in `cordis.patch.yml` or in the profile's patch layer without editing code.
 *
 * @module dsh-plugin-hello
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { greet } from './greeting.js'

/** Stable Loader identity; matches the package name suffix and the patch id. */
export const name = 'hello'

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
    name: 'hello_greet',
    description: 'Greet a person by name and return the greeting text.',
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
