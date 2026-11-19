/**
 * Antigravity (ACP) — native DSH model adapter backed by the official agy CLI.
 * Explicit first-step user input is correlated with the original agent-loop
 * request. Explicit PDF attachments are converted locally to text and/or PNG.
 *
 * @module dsh-plugin-antigravity-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { AcpClient } from './acp-client.js'
import { AntigravityAdapter } from './adapter.js'
import type { AttachmentService, OfficeRenderer } from './prompt.js'
import { PROVIDER, RouteError, SubmissionRouter } from './router.js'

export const name = 'antigravity-acp'
export const inject = ['llm', 'attachments', 'officeKit']

export interface Config {
  /** Official Antigravity CLI executable; arguments are always `acp --stdio`. */
  executable: string
  /** Directory supplied to ACP session/new; empty uses the DSH host cwd. */
  workingDirectory: string
  maxPdfPages: number
  maxPdfBytes: number
  maxPageTextChars: number
  maxImages: number
  maxTotalImageBytes: number
  maxImageDimension: number
  maxImagePixels: number
  maxPromptTextChars: number
  /** Reject a prompt the CLI stops answering for this long. */
  idleTimeoutSeconds: number
}

export const Config: z<Config> = z.object({
  executable: z.string().default('agy'),
  workingDirectory: z.string().default(''),
  maxPdfPages: z.number().min(1).max(100).default(10),
  maxPdfBytes: z
    .number()
    .min(1024)
    .max(32 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  maxPageTextChars: z.number().min(100).max(100_000).default(16_000),
  maxImages: z.number().min(1).max(100).default(10),
  maxTotalImageBytes: z
    .number()
    .min(1024)
    .max(32 * 1024 * 1024)
    .default(12 * 1024 * 1024),
  maxImageDimension: z.number().min(256).max(4096).default(2048),
  maxImagePixels: z.number().min(65_536).max(32_000_000).default(16_000_000),
  maxPromptTextChars: z.number().min(1000).max(500_000).default(120_000),
  idleTimeoutSeconds: z.number().min(5).max(600).default(90),
})

interface LlmRegistry {
  registerAdapter(providers: string[], adapter: AntigravityAdapter): () => void
}

interface ModelSelection {
  provider: string
  model: string
}

interface PreStepPayload {
  agent: { id: string }
  messages: UserMessage[]
  turn: number
  step: number
  modelSelection: Readonly<ModelSelection>
}

type PreStepDecision =
  { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

export function apply(ctx: Context, config: Config): void {
  const llm = ctx.get('llm') as unknown as LlmRegistry
  const attachments = ctx.get('attachments') as unknown as AttachmentService
  const office = ctx.get('officeKit') as unknown as OfficeRenderer
  const router = new SubmissionRouter()
  const gateway = new AcpClient(config.executable, undefined, {
    idleTimeoutMs: config.idleTimeoutSeconds * 1000,
  })
  const adapter = new AntigravityAdapter(
    gateway,
    router,
    attachments,
    office,
    {
      maxPages: config.maxPdfPages,
      maxPdfBytes: config.maxPdfBytes,
      maxPageTextChars: config.maxPageTextChars,
      maxImages: config.maxImages,
      maxTotalImageBytes: config.maxTotalImageBytes,
      maxImageDimension: config.maxImageDimension,
      maxImagePixels: config.maxImagePixels,
      maxPromptTextChars: config.maxPromptTextChars,
    },
    config.workingDirectory || process.cwd(),
  )

  ctx.on(
    'agent/pre-step',
    async (
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      if (payload.modelSelection.provider !== PROVIDER) return next()
      if (payload.step !== 1) {
        ctx.logger.warn(
          `[${name}] blocked internal continuation step ${payload.step}; nothing was sent to ACP`,
        )
        return { kind: 'reject' }
      }
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      try {
        const claim = router.claim(
          payload.agent.id,
          payload.turn,
          payload.step,
          payload.modelSelection.model,
          payload.messages,
        )
        if (!payload.messages.every((message) => decision.messages.includes(message))) {
          router.release(claim)
          ctx.logger.warn(
            `[${name}] another pre-step listener removed an explicit input; blocked ACP routing`,
          )
          return { kind: 'reject' }
        }
        return decision
      } catch (error) {
        const code = error instanceof RouteError ? error.code : 'ACP_PRE_STEP_FAILED'
        ctx.logger.warn(
          `[${name}] blocked ACP pre-step (${code}): ${error instanceof Error ? error.message : String(error)}`,
        )
        return { kind: 'reject' }
      }
    },
  )

  ctx.on(
    'llm/stream',
    (
      options: GenerateOptions,
      next: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> => {
      if (options.provider !== PROVIDER) return next()
      router.authorize(options)
      return next()
    },
  )

  ctx.effect(() => {
    const registration = llm.registerAdapter([PROVIDER], adapter)
    return () => {
      registration()
      gateway.dispose()
    }
  })
}

export { AcpClient } from './acp-client.js'
export { AntigravityAdapter } from './adapter.js'
export { SubmissionRouter, PROVIDER } from './router.js'
export { extractPdfText } from './pdf-text.js'
export { projectPrompt } from './prompt.js'
