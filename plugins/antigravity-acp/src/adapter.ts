import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AcpGateway, AcpPromptContent } from './acp-client.js'
import { configByCategory, configValues, hasConfigValue } from './acp-config.js'
import {
  projectPrompt,
  type AttachmentService,
  type OfficeRenderer,
  type PromptLimits,
} from './prompt.js'
import { PROVIDER, RouteError, SubmissionRouter } from './router.js'

const FIRST_USE_NOTE =
  '[Antigravity (ACP) source and limits: models and thinking levels are reported live by the official agy CLI. Antigravity officially limits third-party models to JetBrains IDEs, Android Studio, Android Performance Analyzer, Zed, and Xcode. DSH does not bypass that restriction; configuration failures and refusals are reported without changing models.]'

export class AntigravityAdapter extends LlmAdapter {
  private readonly explainedSessions = new Set<string>()

  constructor(
    private readonly gateway: AcpGateway,
    private readonly router: SubmissionRouter,
    private readonly attachments: AttachmentService,
    private readonly office: OfficeRenderer,
    private readonly limits: PromptLimits,
    private readonly cwd: string,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity (ACP)' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: 0,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
      retryableCodes: [],
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const options = await this.gateway.catalogOptions()
    const models = configByCategory(options, 'model')
    if (models === undefined) throw new Error('agy ACP did not advertise a model config option.')
    return configValues(models).map((model) => ({
      provider,
      id: model.value,
      name: model.name,
      inputModalities: ['text', 'image'],
      ...(model.description ? { description: model.description } : {}),
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const options = await this.gateway.resolveOptions(model, signal)
    const models = configByCategory(options, 'model')
    if (models === undefined || !hasConfigValue(models, model))
      throw new Error(`agy ACP does not advertise model "${model}".`)
    const selected = configValues(models).find((entry) => entry.value === model)
    const thought = configByCategory(options, 'thought_level')
    const efforts = thought === undefined ? [] : configValues(thought)
    return {
      provider,
      id: model,
      name: selected?.name ?? model,
      inputModalities: ['text', 'image'],
      ...(selected?.description ? { description: selected.description } : {}),
      ...(efforts.length > 0
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({
                id: effort.value as ReasoningEffortId,
                name: effort.name,
                ...(effort.description ? { description: effort.description } : {}),
              })),
              ...(thought?.currentValue
                ? { defaultEffort: thought.currentValue as ReasoningEffortId }
                : {}),
            },
          }
        : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      const claim = this.router.consume(options)
      options.signal?.throwIfAborted()
      const content: AcpPromptContent[] = await projectPrompt(
        claim.messages,
        this.attachments,
        this.office,
        this.limits,
        options.signal,
      )
      if (content.length === 0)
        throw new RouteError(
          'The explicit submission has no sendable text, image, or converted PDF content.',
          'ACP_EMPTY_PROMPT',
        )
      const events: { type: 'text' | 'reasoning'; text: string }[] = []
      const stopReason = await this.gateway.run({
        sessionKey: claim.sessionId,
        cwd: this.cwd,
        model: claim.model,
        ...(options.reasoningEffort !== undefined ? { thoughtLevel: options.reasoningEffort } : {}),
        content,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onText: (text) => {
          if (text) events.push({ type: 'text', text })
        },
        onThought: (text) => {
          if (text) events.push({ type: 'reasoning', text })
        },
      })
      if (!this.explainedSessions.has(claim.sessionId)) {
        this.explainedSessions.add(claim.sessionId)
        events.unshift({ type: 'text', text: FIRST_USE_NOTE })
      }
      if (stopReason === 'refusal')
        events.push({
          type: 'text',
          text: '[Antigravity ACP refused this request; no alternate model was tried.]',
        })
      let index = 0
      for (const event of events) {
        yield { type: 'block-start', index, blockType: event.type }
        if (event.type === 'text') yield { type: 'text-delta', index, text: event.text }
        else yield { type: 'reasoning-delta', index, text: event.text }
        yield {
          type: 'block-end',
          index,
          block:
            event.type === 'text'
              ? { type: 'text', text: event.text }
              : { type: 'reasoning', text: event.text },
        }
        index++
      }
      if (stopReason === 'cancelled' || options.signal?.aborted) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              code: 'ACP_CANCELLED',
              message: 'The ACP request was cancelled; it will not be resent.',
            },
          },
        }
      } else {
        yield {
          type: 'finish',
          reason: { kind: stopReason === 'max_tokens' ? 'max-tokens' : 'stop' },
        }
      }
    } catch (error) {
      const aborted =
        options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { code: 'ACP_CANCELLED', message: errorMessage(error) } }
          : { kind: 'error', failure: { code: errorCode(error), message: errorMessage(error) } },
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'ACP_REQUEST_FAILED'
}
